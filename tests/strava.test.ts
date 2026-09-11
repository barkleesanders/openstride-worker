import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configured,
  connectUrl,
  decryptTokens,
  encryptTokens,
  exchangeCode,
  fetchActivities,
  refreshTokens,
} from '../src/strava';
import type { Bindings } from '../src/types';

const env = {
  APP_TOKEN: 'test-personal-secret-at-least-32-characters',
  STRAVA_CLIENT_ID: '123',
  STRAVA_CLIENT_SECRET: 'client-secret',
  STRAVA_REDIRECT_URI: 'https://running.example/strava/callback',
} as Bindings;
const tokens = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAt: 2000000000,
  athleteId: 123,
};
afterEach(() => vi.unstubAllGlobals());
function respond(body: unknown, status = 200) {
  const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('Strava adapter', () => {
  it('requires explicit safe credentials and requests only read scopes', () => {
    expect(configured(env)).toBe(true);
    expect(configured({ ...env, STRAVA_REDIRECT_URI: undefined })).toBe(false);
    expect(configured({ ...env, STRAVA_REDIRECT_URI: 'http://example.org/callback' })).toBe(false);
    expect(configured({ ...env, STRAVA_REDIRECT_URI: 'http://localhost:8787/callback' })).toBe(
      true,
    );
    expect(configured({ ...env, APP_TOKEN: 'short' })).toBe(false);
    const url = new URL(connectUrl(env, 'random-state'));
    expect(url.origin + url.pathname).toBe('https://www.strava.com/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('read,activity:read');
    expect(url.searchParams.get('state')).toBe('random-state');
    expect(url.searchParams.get('redirect_uri')).toBe(env.STRAVA_REDIRECT_URI);
  });

  it('exchanges a code for validated tokens', async () => {
    const mock = respond({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_at: 2000000000,
      athlete: { id: 123 },
    });
    expect(await exchangeCode(env, 'one-time-code')).toEqual(tokens);
    expect(mock.mock.calls[0][0]).toBe('https://www.strava.com/oauth/token');
    const body = new URLSearchParams(mock.mock.calls[0][1].body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('one-time-code');
  });

  it('preserves athlete identity and rotates refresh token', async () => {
    respond({ access_token: 'next-access', refresh_token: 'next-refresh', expires_at: 2000000100 });
    expect(await refreshTokens(env, tokens)).toEqual({
      athleteId: 123,
      accessToken: 'next-access',
      refreshToken: 'next-refresh',
      expiresAt: 2000000100,
    });
  });

  it('imports only runs from one bounded page and omits sensitive fields', async () => {
    const activity = {
      id: 42,
      name: 'Morning run',
      sport_type: 'Run',
      start_date_local: '2026-09-10T07:00:00Z',
      distance: 5200,
      moving_time: 1800,
      map: { summary_polyline: 'private-route' },
      average_heartrate: 140,
    };
    const mock = respond([
      activity,
      { ...activity, id: 43, sport_type: 'Ride' },
      { ...activity, id: 44, sport_type: 'TrailRun' },
    ]);
    expect(await fetchActivities(tokens, 1000)).toEqual([
      {
        id: 'strava:42',
        source: 'strava',
        date: '2026-09-10',
        name: 'Morning run',
        distanceKm: 5.2,
        durationMinutes: 30,
      },
      {
        id: 'strava:44',
        source: 'strava',
        date: '2026-09-10',
        name: 'Morning run',
        distanceKm: 5.2,
        durationMinutes: 30,
      },
    ]);
    expect(mock).toHaveBeenCalledTimes(1);
    const url = new URL(mock.mock.calls[0][0]);
    expect(url.searchParams.get('per_page')).toBe('100');
    expect(url.searchParams.get('after')).toBe('1000');
  });

  it.each([401, 403, 429, 500])('sanitizes HTTP %i errors', async (status) => {
    respond({ message: 'secret-value' }, status);
    await expect(fetchActivities(tokens)).rejects.toThrow(
      status === 429 ? /rate limit/ : status === 500 ? /HTTP 500/ : /authorization failed/,
    );
  });

  it('rejects malformed activities and token responses without leaking their body', async () => {
    respond([{ id: 'secret-value' }]);
    await expect(fetchActivities(tokens)).rejects.toThrow('Strava returned invalid activity data.');
    respond({ access_token: 'secret-value' });
    await expect(exchangeCode(env, 'code')).rejects.toThrow(
      'Strava returned an invalid token response.',
    );
  });

  it('encrypts with fresh nonces and rejects changed secrets and tampered ciphertext', async () => {
    const one = await encryptTokens(env, tokens);
    const two = await encryptTokens(env, tokens);
    expect(one).not.toBe(two);
    expect(one).not.toContain('refresh');
    expect(await decryptTokens(env, one)).toEqual(tokens);
    await expect(
      decryptTokens({ ...env, APP_TOKEN: 'different-secret-at-least-32-characters' }, one),
    ).rejects.toThrow(/could not be decrypted/);
    await expect(decryptTokens(env, `${one.slice(0, -8)}abcdefgh`)).rejects.toThrow(
      /could not be decrypted/,
    );
    await expect(encryptTokens({ ...env, APP_TOKEN: 'short' }, tokens)).rejects.toThrow(
      /32 characters/,
    );
  });
});
