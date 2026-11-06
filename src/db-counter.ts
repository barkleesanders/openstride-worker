// ────────────── D1 query counting (Lockyer performance Wave 5, Part B) ──────────────
//
// A transparent Proxy around a D1Database that counts statement executions
// into a per-request counter, so the wide-event middleware can emit
// `db_queries` / `db_batches` on every http_request event.
//
// Counting definition (design-fixed, do not drift):
//   - prepare(sql) alone counts 0 — nothing has executed yet.
//   - Each CALL to a statement execution method (all / first / run / raw)
//     increments `queries` by 1, whether it later resolves or rejects.
//   - bind(...) counts 0 and returns a wrapped statement, so chaining
//     prepare(...).bind(...).all() counts exactly 1, at the .all() call.
//   - batch(statements) increments `batches` by 1 AND `queries` by
//     statements.length — D1 executes each statement in the batch.
//   - exec(sql) increments `queries` by 1.
//   - Every other property passes through untouched, bound to the real
//     database; results and errors propagate identically (no behaviour
//     change beyond the count).
//
// Request scoping: the counter is created per request by the wide-event
// middleware and the wrapped binding lives only on that request's env
// object. There is deliberately NO module-global counter — concurrent
// requests would interleave into it and corrupt each other's counts.

export interface DbCounter {
  queries: number;
  batches: number;
}

export function createDbCounter(): DbCounter {
  return { queries: 0, batches: 0 };
}

// Wrapped statement -> the real statement underneath, so batch() can hand
// D1 the native statements it expects instead of proxies. WeakMaps keep
// this bookkeeping invisible and garbage-collectable with the request.
const statementOriginals = new WeakMap<object, D1PreparedStatement>();
const dbOriginals = new WeakMap<object, D1Database>();

const EXECUTION_METHODS = new Set(['all', 'first', 'run', 'raw']);

function wrapStatement(stmt: D1PreparedStatement, counter: DbCounter): D1PreparedStatement {
  const wrapped = new Proxy(stmt, {
    get(target, prop) {
      if (prop === 'bind') {
        return (...args: unknown[]) =>
          wrapStatement(
            (target.bind as (...a: unknown[]) => D1PreparedStatement)(...args),
            counter,
          );
      }
      if (typeof prop === 'string' && EXECUTION_METHODS.has(prop)) {
        return (...args: unknown[]) => {
          counter.queries += 1;
          const fn = Reflect.get(target, prop) as (...a: unknown[]) => unknown;
          return fn.apply(target, args);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  statementOriginals.set(wrapped, stmt);
  return wrapped;
}

/** Wrap `db` so every execution through it increments `counter`. */
export function countDb(db: D1Database, counter: DbCounter): D1Database {
  // Re-wrapping an already-wrapped binding (possible when a test harness
  // reuses one env object across requests) must wrap the ORIGINAL database
  // with the fresh counter — stacking proxies would double-count.
  const original = dbOriginals.get(db) ?? db;
  const wrapped = new Proxy(original, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => wrapStatement(target.prepare(sql), counter);
      }
      if (prop === 'batch') {
        return (statements: D1PreparedStatement[]) => {
          counter.batches += 1;
          counter.queries += statements.length;
          const native = statements.map((s) => statementOriginals.get(s) ?? s);
          return target.batch(native as D1PreparedStatement[]);
        };
      }
      if (prop === 'exec') {
        return (sql: string) => {
          counter.queries += 1;
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  dbOriginals.set(wrapped, original);
  return wrapped;
}
