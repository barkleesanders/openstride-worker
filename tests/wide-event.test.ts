import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../src/types';
import { wideEvent } from '../src/wide-event';

// Minimal fake D1: every statement execution resolves successfully.
function fakeDb(): D1Database {
  const stmt = {
    bind: () => stmt,
    all: async () => ({ results: [], success: true }),
    first: async () => null,
    run: async () => ({ success: true }),
    raw: async () => [],
  };
  return {
    prepare: () => stmt,
    batch: async (stmts: unknown[]) => stmts.map(() => ({ success: true })),
    exec: async () => ({ count: 1, duration: 0 }),
  } as unknown as D1Database;
}

// Only DB matters to these tests; the rest of Bindings is irrelevant here.
function fakeEnv(): Bindings {
  return { DB: fakeDb() } as unknown as Bindings;
}

function buildApp() {
  const app = new Hono<{ Bindings: Bindings }>();
  app.use('*', wideEvent);
  app.get('/hello', (c) => c.text('hi'));
  app.get('/three-queries', async (c) => {
    await c.env.DB.prepare('SELECT 1').all();
    await c.env.DB.prepare('SELECT 2').bind(2).first();
    await c.env.DB.prepare('UPDATE t SET x = 1').run();
    return c.text('done');
  });
  app.get('/one-query', async (c) => {
    await c.env.DB.prepare('SELECT 1').all();
    return c.text('done');
  });
  app.get('/boom', () => {
    throw new Error('kaboom');
  });
  return app;
}

function lastEvent(spy: ReturnType<typeof vi.spyOn>) {
  const call = spy.mock.calls.at(-1);
  return JSON.parse(call?.[0] as string);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('wideEvent', () => {
  it('emits one structured http_request event per request, db fields at 0', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await buildApp().request(
      '/hello?token=<redacted>',
      { headers: { 'cf-ray': 'ray-123', 'user-agent': 'vitest' } },
      fakeEnv(),
    );
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const event = lastEvent(spy);
    expect(event.event).toBe('http_request');
    expect(event.method).toBe('GET');
    // Pathname only: the query string (and its token) never reaches the log.
    expect(event.path).toBe('/hello');
    expect(event.status).toBe(200);
    expect(event.outcome).toBe('ok');
    expect(event.request_id).toBe('ray-123');
    expect(typeof event.duration_ms).toBe('number');
    // Always emitted, even when the handler touched no D1: 0 is meaningful.
    expect(event.db_queries).toBe(0);
    expect(event.db_batches).toBe(0);
  });

  it('a handler making exactly 3 queries emits db_queries=3', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await buildApp().request('/three-queries', {}, fakeEnv());
    expect(res.status).toBe(200);
    const event = lastEvent(spy);
    expect(event.path).toBe('/three-queries');
    expect(event.db_queries).toBe(3);
    expect(event.db_batches).toBe(0);
  });

  it('counts stay per-request when one env object is reused across requests', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const app = buildApp();
    const env = fakeEnv();
    await app.request('/three-queries', {}, env);
    expect(lastEvent(spy).db_queries).toBe(3);
    // Same env object again (test harnesses do this; Workers gives a fresh
    // env per request, but the counter must never leak or double-count).
    await app.request('/one-query', {}, env);
    expect(lastEvent(spy).db_queries).toBe(1);
  });

  it('marks a thrown handler as outcome=error and still emits', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await buildApp().request('/boom', {}, fakeEnv());
    expect(res.status).toBe(500);
    expect(spy).toHaveBeenCalledTimes(1);
    const event = lastEvent(spy);
    // Hono converts a thrown handler error into a 500 response inside the
    // pipeline, so the middleware observes it as a 500, not a throw.
    expect(event.status).toBe(500);
    expect(event.outcome).toBe('error');
    expect(event.db_queries).toBe(0);
  });
});
