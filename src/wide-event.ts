import type { MiddlewareHandler } from 'hono';
import { countDb, createDbCounter } from './db-counter';

// ────────────── Wide-event logging (native observability rollout, 2026-11-04) ──────────────
//
// One canonical JSON event per request, emitted to Workers Logs via
// console.log — the loggingsucks.com "wide event" pattern, implemented with
// Cloudflare-native tooling only (no external observability product):
// every field a future query needs (route, status, outcome, duration,
// colo, request id) rides on a single structured line instead of being
// scattered across free-text logs. Per-function detail comes from the
// platform: Workers Traces (observability.traces in wrangler.jsonc)
// records spans for the runtime, fetch, and bindings automatically.
//
// Privacy posture: pathname only — no query string (tokens can ride in
// it), no cookies, no body. The request id is the Cloudflare ray id,
// which joins this event to the platform trace and to Cloudflare Issues.
//
// Wave 5 Part B (Lockyer performance rollout): the event also carries
// `db_queries` / `db_batches`. This middleware is the request-scoped
// owner of the counter: it creates a fresh counter per request, replaces
// the request env's DB binding with the counting proxy from
// ./db-counter (handlers read c.env.DB, so they transparently execute
// through the proxy), and reads the totals back in `finally`. The fields
// are ALWAYS emitted — 0 is meaningful (the handler made no D1 calls).

export const wideEvent: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  const counter = createDbCounter();
  c.set('dbCounter', counter);
  const env = c.env as { DB?: D1Database } | undefined;
  if (env?.DB) env.DB = countDb(env.DB, counter);
  let errorName: string | undefined;
  try {
    await next();
  } catch (err) {
    errorName = err instanceof Error ? err.name : 'UnknownError';
    throw err;
  } finally {
    let status = 500;
    if (!errorName) {
      try {
        status = c.res.status;
      } catch {
        status = 500;
      }
    }
    const cf = c.req.raw.cf;
    console.log(
      JSON.stringify({
        event: 'http_request',
        ts: new Date().toISOString(),
        request_id: c.req.header('cf-ray'),
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status,
        outcome: errorName || status >= 500 ? 'error' : status >= 400 ? 'client_error' : 'ok',
        duration_ms: Date.now() - start,
        db_queries: counter.queries,
        db_batches: counter.batches,
        colo: cf?.colo,
        country: cf?.country,
        user_agent: c.req.header('user-agent')?.slice(0, 120),
        ...(errorName ? { error: errorName } : {}),
      }),
    );
  }
};
