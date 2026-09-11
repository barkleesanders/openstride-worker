import { z } from 'zod';
import type { Activity, Bindings } from './types';

const tokenSchema = z.object({
  accessToken: z.string().min(1).max(4096),
  refreshToken: z.string().min(1).max(4096),
  expiresAt: z.number().int().positive(),
  athleteId: z.number().int().positive().safe(),
});
export type StravaTokens = z.infer<typeof tokenSchema>;
const responseSchema = z.object({
  access_token: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(4096),
  expires_at: z.number().int().positive(),
  athlete: z.object({ id: z.number().int().positive().safe() }).optional(),
});
const activitySchema = z.object({
  id: z.number().int().positive().safe(),
  name: z.string().max(4096),
  sport_type: z.string().optional(),
  type: z.string().optional(),
  start_date_local: z.string().datetime({ offset: true }),
  distance: z.number().finite().nonnegative(),
  moving_time: z.number().int().nonnegative(),
});

function credentials(env: Bindings) {
  const { STRAVA_CLIENT_ID: id, STRAVA_CLIENT_SECRET: secret, STRAVA_REDIRECT_URI: redirect } = env;
  if (!id || !/^\d+$/.test(id) || !secret || !redirect) {
    throw new Error('Strava is not configured. Set client ID, secret, and redirect URI.');
  }
  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    throw new Error('Strava redirect URI is invalid.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      'Strava redirect URI must use HTTPS (HTTP localhost is allowed for development).',
    );
  }
  return { id, secret, redirect };
}

export function configured(env: Bindings): boolean {
  try {
    credentials(env);
    return (env.APP_TOKEN?.length ?? 0) >= 32;
  } catch {
    return false;
  }
}

export function connectUrl(env: Bindings, state: string): string {
  const { id, redirect } = credentials(env);
  const url = new URL('https://www.strava.com/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: id,
    redirect_uri: redirect,
    response_type: 'code',
    approval_prompt: 'force',
    scope: 'read,activity:read',
    state,
  }).toString();
  return url.toString();
}

async function request(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
  } catch {
    throw new Error('Strava could not be reached. Try again later.');
  }
  if (response.status === 429)
    throw new Error('Strava rate limit reached. Wait before syncing again.');
  if (response.status === 401 || response.status === 403)
    throw new Error(
      'Strava authorization failed. Reconnect your account and grant activity access.',
    );
  if (!response.ok)
    throw new Error(`Strava request failed (HTTP ${response.status}). Try again later.`);
  try {
    return await response.json();
  } catch {
    throw new Error('Strava returned an invalid response.');
  }
}

async function tokenRequest(
  env: Bindings,
  fields: Record<string, string>,
  athleteId?: number,
): Promise<StravaTokens> {
  const { id, secret } = credentials(env);
  const raw = await request('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, ...fields }).toString(),
  });
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Strava returned an invalid token response.');
  const data = parsed.data;
  const tokens = tokenSchema.safeParse({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at,
    athleteId: athleteId ?? data.athlete?.id,
  });
  if (!tokens.success) throw new Error('Strava token response is missing the athlete identity.');
  return tokens.data;
}

export function exchangeCode(env: Bindings, code: string): Promise<StravaTokens> {
  return tokenRequest(env, { grant_type: 'authorization_code', code });
}

export function refreshTokens(env: Bindings, tokens: StravaTokens): Promise<StravaTokens> {
  return tokenRequest(
    env,
    { grant_type: 'refresh_token', refresh_token: tokens.refreshToken },
    tokens.athleteId,
  );
}

export async function fetchActivities(tokens: StravaTokens, after?: number): Promise<Activity[]> {
  const url = new URL('https://www.strava.com/api/v3/athlete/activities');
  url.searchParams.set('page', '1');
  url.searchParams.set('per_page', '100');
  if (after !== undefined) {
    if (!Number.isSafeInteger(after) || after < 0)
      throw new Error('Activity cutoff must be a nonnegative Unix timestamp.');
    url.searchParams.set('after', String(after));
  }
  const raw = await request(url.toString(), {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  const parsed = z.array(activitySchema).max(100).safeParse(raw);
  if (!parsed.success) throw new Error('Strava returned invalid activity data.');
  return parsed.data
    .filter((activity) =>
      ['Run', 'TrailRun', 'VirtualRun'].includes(activity.sport_type ?? activity.type ?? ''),
    )
    .map((activity) => ({
      id: `strava:${activity.id}`,
      source: 'strava',
      date: activity.start_date_local.slice(0, 10),
      name: activity.name.slice(0, 120),
      distanceKm: activity.distance / 1000,
      durationMinutes: activity.moving_time / 60,
    }));
}

async function encryptionKey(env: Bindings): Promise<CryptoKey> {
  if (!env.APP_TOKEN || env.APP_TOKEN.length < 32)
    throw new Error('APP_TOKEN must have at least 32 characters to protect Strava tokens.');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.APP_TOKEN));
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptTokens(env: Bindings, tokens: StravaTokens): Promise<string> {
  if (!tokenSchema.safeParse(tokens).success)
    throw new Error('Cannot store invalid Strava tokens.');
  const key = await encryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(JSON.stringify(tokens)),
    ),
  );
  const payload = new Uint8Array(iv.length + encrypted.length);
  payload.set(iv);
  payload.set(encrypted, iv.length);
  return `v1.${btoa(String.fromCharCode(...payload))}`;
}

export async function decryptTokens(env: Bindings, ciphertext: string): Promise<StravaTokens> {
  const key = await encryptionKey(env);
  try {
    if (!ciphertext.startsWith('v1.') || ciphertext.length > 24000)
      throw new Error('Invalid encoding');
    const bytes = Uint8Array.from(atob(ciphertext.slice(3)), (char) => char.charCodeAt(0));
    if (bytes.length < 29) throw new Error('Invalid length');
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) },
      key,
      bytes.slice(12),
    );
    return tokenSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    throw new Error('Stored Strava connection could not be decrypted. Reconnect your account.');
  }
}
