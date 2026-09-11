import { sign } from 'hono/jwt';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isAccessConfigured, verifyAccess } from '../src/access';

let privateKey: JsonWebKey & { kid: string };
let publicKey: JsonWebKey & { kid: string };
let counter = 0;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  privateKey = {
    ...(await crypto.subtle.exportKey('jwk', pair.privateKey)),
    kid: 'test-key',
    alg: 'RS256',
  };
  publicKey = {
    ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
    kid: 'test-key',
    alg: 'RS256',
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setup() {
  const config = {
    CF_ACCESS_TEAM_DOMAIN: `test${++counter}.cloudflareaccess.com`,
    CF_ACCESS_AUD: 'app-audience',
    OWNER_EMAIL: 'runner@example.com',
  };
  const fetchMock = vi.fn().mockImplementation(async () => Response.json({ keys: [publicKey] }));
  vi.stubGlobal('fetch', fetchMock);
  return { config, fetchMock };
}
async function assertion(domain: string, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      iss: `https://${domain}`,
      aud: ['app-audience'],
      email: 'runner@example.com',
      exp: now + 3600,
      nbf: now - 1,
      iat: now - 1,
      ...overrides,
    },
    privateKey,
    'RS256',
  );
}
function request(token: string) {
  return new Request('https://running.example/app', {
    headers: { 'Cf-Access-Jwt-Assertion': token },
  });
}

describe('Cloudflare Access origin verification', () => {
  it('accepts real RSA signatures for the owner and caches fixed-origin keys', async () => {
    const { config, fetchMock } = setup();
    const req = request(await assertion(config.CF_ACCESS_TEAM_DOMAIN));
    expect(await verifyAccess(req, config)).toBe(true);
    expect(await verifyAccess(req, config)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://${config.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`,
    );
    expect(fetchMock.mock.calls[0][1].redirect).toBe('error');
  });
  it.each([
    { aud: ['another-app'] },
    { iss: 'https://other.cloudflareaccess.com' },
    { email: 'another@example.com' },
    { email: undefined },
    { exp: 1 },
    { exp: undefined },
    { exp: '9999999999' },
    { nbf: 9999999999 },
  ])('rejects invalid application claims %j', async (claims) => {
    const { config } = setup();
    expect(
      await verifyAccess(request(await assertion(config.CF_ACCESS_TEAM_DOMAIN, claims)), config),
    ).toBe(false);
  });
  it('rejects tampered payloads even when they name the owner', async () => {
    const { config } = setup();
    const token = await assertion(config.CF_ACCESS_TEAM_DOMAIN, { email: 'attacker@example.com' });
    const parts = token.split('.');
    parts[1] = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(parts[1], 'base64url').toString()),
        email: config.OWNER_EMAIL,
      }),
    ).toString('base64url');
    expect(await verifyAccess(request(parts.join('.')), config)).toBe(false);
  });
  it('rejects unsigned identity headers, malformed tokens, missing config and unsafe team origins without fetching', async () => {
    const { config, fetchMock } = setup();
    expect(
      await verifyAccess(
        new Request('https://running.example', {
          headers: { 'Cf-Access-Authenticated-User-Email': config.OWNER_EMAIL },
        }),
        config,
      ),
    ).toBe(false);
    expect(await verifyAccess(request('garbage'), config)).toBe(false);
    for (const domain of [
      'http://test.cloudflareaccess.com',
      'test.cloudflareaccess.com.evil.test',
      'test.cloudflareaccess.com/path',
      'localhost',
      'test.cloudflareaccess.com:443',
    ]) {
      expect(isAccessConfigured({ ...config, CF_ACCESS_TEAM_DOMAIN: domain })).toBe(false);
    }
    expect(
      await verifyAccess(request(await assertion(config.CF_ACCESS_TEAM_DOMAIN)), {
        ...config,
        CF_ACCESS_AUD: undefined,
      }),
    ).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('fails closed on signing-key errors', async () => {
    const { config, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response('unavailable', { status: 503 }));
    expect(await verifyAccess(request(await assertion(config.CF_ACCESS_TEAM_DOMAIN)), config)).toBe(
      false,
    );
  });
  it('refreshes expired cached keys and never accepts an unknown signing key', async () => {
    const { config, fetchMock } = setup();
    const req = request(
      await assertion(config.CF_ACCESS_TEAM_DOMAIN, { exp: Math.floor(Date.now() / 1000) + 7200 }),
    );
    expect(await verifyAccess(req, config)).toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3_600_001);
    fetchMock.mockImplementation(async () =>
      Response.json({ keys: [{ ...publicKey, kid: 'rotated' }] }),
    );
    expect(await verifyAccess(req, config)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
