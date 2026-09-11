import { decode, verifyWithJwks } from 'hono/jwt';

export type AccessConfig = {
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  OWNER_EMAIL?: string;
};
type SigningKey = JsonWebKey & { kid: string };
type KeyCache = { issuer: string; keys: SigningKey[]; fetchedAt: number };
let cached: KeyCache | undefined;
let loading: { issuer: string; promise: Promise<KeyCache> } | undefined;

function issuerFor(config: AccessConfig): string | undefined {
  const domain = config.CF_ACCESS_TEAM_DOMAIN;
  if (!domain) return undefined;
  // Configuration may use a hostname or HTTPS origin; never follow a token-supplied URL.
  const hostname = domain.startsWith('https://') ? domain.slice(8) : domain;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(hostname)) {
    return undefined;
  }
  return `https://${hostname}`;
}

export function isAccessConfigured(config: AccessConfig): boolean {
  return Boolean(
    issuerFor(config) &&
      config.CF_ACCESS_AUD?.trim() &&
      config.OWNER_EMAIL &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.OWNER_EMAIL),
  );
}

async function signingKeys(issuer: string, kid: string): Promise<SigningKey[]> {
  const age = cached?.issuer === issuer ? Date.now() - cached.fetchedAt : Infinity;
  if (cached?.issuer === issuer && age < 3_600_000) {
    // Unknown keys can trigger rotation refresh, but not an unbounded fetch per forged token.
    if (cached.keys.some((key) => key.kid === kid) || age < 60_000) return cached.keys;
  }
  if (loading?.issuer === issuer) return (await loading.promise).keys;
  const promise = (async (): Promise<KeyCache> => {
    const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Access signing keys unavailable');
    const body = (await response.json()) as { keys?: SigningKey[] };
    if (!Array.isArray(body.keys) || body.keys.length === 0 || body.keys.length > 20) {
      throw new Error('Invalid Access signing keys');
    }
    const keys = body.keys.filter(
      (key) =>
        key &&
        typeof key.kid === 'string' &&
        key.kty === 'RSA' &&
        (!key.alg || key.alg === 'RS256') &&
        (!key.use || key.use === 'sig') &&
        typeof key.n === 'string' &&
        typeof key.e === 'string',
    );
    if (!keys.length) throw new Error('Missing RSA signing keys');
    cached = { issuer, keys, fetchedAt: Date.now() };
    return cached;
  })();
  loading = { issuer, promise };
  try {
    return (await promise).keys;
  } finally {
    if (loading?.promise === promise) loading = undefined;
  }
}

/** Verify Cloudflare's signed application assertion, never its unsigned email header. */
export async function verifyAccess(request: Request, config: AccessConfig): Promise<boolean> {
  if (!isAccessConfigured(config)) return false;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || token.length > 16384) return false;
  try {
    const { header, payload: unverified } = decode(token);
    if (header.alg !== 'RS256' || !header.kid || typeof header.kid !== 'string') return false;
    // Hono validates expiration when present; Access assertions must always have it.
    if (!unverified || typeof unverified.exp !== 'number' || !Number.isFinite(unverified.exp)) {
      return false;
    }
    const issuer = issuerFor(config);
    if (!issuer || !config.CF_ACCESS_AUD) return false;
    const payload = await verifyWithJwks(token, {
      keys: await signingKeys(issuer, header.kid),
      allowedAlgorithms: ['RS256'],
      verification: { iss: issuer, aud: config.CF_ACCESS_AUD, exp: true, nbf: true, iat: true },
    });
    return typeof payload.email === 'string' && payload.email === config.OWNER_EMAIL;
  } catch {
    // Do not log assertions or health-account identity on authentication failures.
    return false;
  }
}
