// Unit tests for the D1 counting proxy (Wave 5 Part B) against a fake D1.
// The fake is a plain in-memory object with the D1Database surface the
// proxy touches, plus one custom property/method to prove pass-through.
import { describe, expect, it } from 'vitest';
import { countDb, createDbCounter } from '../src/db-counter';

interface FakeStatement {
  sql: string;
  bound: unknown[];
  bind: (...args: unknown[]) => FakeStatement;
  all: () => Promise<{ results: unknown[]; success: boolean }>;
  first: () => Promise<unknown>;
  run: () => Promise<{ success: boolean }>;
  raw: () => Promise<unknown[]>;
}

function makeStatement(sql: string, bound: unknown[] = []): FakeStatement {
  const fail = sql.includes('BOOM');
  const boom = () => {
    throw new Error('d1 exploded');
  };
  return {
    sql,
    bound,
    bind: (...args: unknown[]) => makeStatement(sql, args),
    all: async () => (fail ? boom() : { results: [{ sql }], success: true }),
    first: async () => (fail ? boom() : { sql }),
    run: async () => (fail ? boom() : { success: true }),
    raw: async () => (fail ? boom() : [[sql]]),
  };
}

function makeFakeDb() {
  const batched: unknown[][] = [];
  const db = {
    label: 'fake-db',
    batched,
    prepare: (sql: string) => makeStatement(sql),
    batch: async (statements: unknown[]) => {
      batched.push(statements);
      return statements.map(() => ({ success: true }));
    },
    exec: async (_sql: string) => ({ count: 1, duration: 0 }),
    customMethod() {
      return `custom:${this.label}`;
    },
  };
  return db as unknown as D1Database & { label: string; batched: unknown[][] };
}

describe('countDb', () => {
  it('prepare alone counts 0; prepare + all counts 1', async () => {
    const counter = createDbCounter();
    const db = countDb(makeFakeDb(), counter);
    db.prepare('SELECT 1');
    expect(counter).toEqual({ queries: 0, batches: 0 });
    const res = await db.prepare('SELECT 1').all();
    expect(res.success).toBe(true);
    expect(counter).toEqual({ queries: 1, batches: 0 });
  });

  it('bind returns a wrapped statement and chaining counts once, at execution', async () => {
    const counter = createDbCounter();
    const db = countDb(makeFakeDb(), counter);
    const stmt = db.prepare('SELECT * FROM t WHERE id = ?').bind(42);
    expect(counter.queries).toBe(0);
    const row = await stmt.first<{ sql: string }>();
    expect(row?.sql).toBe('SELECT * FROM t WHERE id = ?');
    expect(counter.queries).toBe(1);
    await db.prepare('UPDATE t SET x = 1').run();
    await db.prepare('SELECT 2').raw();
    expect(counter.queries).toBe(3);
  });

  it('batch of 3 counts queries += 3 and batches += 1, with native statements', async () => {
    const counter = createDbCounter();
    const fake = makeFakeDb();
    const db = countDb(fake, counter);
    const stmts = [
      db.prepare('INSERT INTO t VALUES (1)'),
      db.prepare('INSERT INTO t VALUES (2)').bind(),
      db.prepare('INSERT INTO t VALUES (3)'),
    ];
    const results = await db.batch(stmts as D1PreparedStatement[]);
    expect(results).toHaveLength(3);
    expect(counter).toEqual({ queries: 3, batches: 1 });
    // batch() must hand D1 the underlying native statements, not proxies.
    const passed = fake.batched[0] as FakeStatement[];
    expect(passed.map((s) => s.sql)).toEqual([
      'INSERT INTO t VALUES (1)',
      'INSERT INTO t VALUES (2)',
      'INSERT INTO t VALUES (3)',
    ]);
    expect(passed[0]).not.toBe(stmts[0]);
  });

  it('exec counts 1', async () => {
    const counter = createDbCounter();
    const db = countDb(makeFakeDb(), counter);
    await db.exec('CREATE TABLE t (id INTEGER)');
    expect(counter).toEqual({ queries: 1, batches: 0 });
  });

  it('errors propagate identically and the attempted call still counts', async () => {
    const counter = createDbCounter();
    const db = countDb(makeFakeDb(), counter);
    await expect(db.prepare('BOOM').all()).rejects.toThrow('d1 exploded');
    expect(counter.queries).toBe(1);
  });

  it('other properties and methods pass through untouched', () => {
    const counter = createDbCounter();
    const wrapped = countDb(makeFakeDb(), counter) as unknown as {
      label: string;
      customMethod: () => string;
    };
    expect(wrapped.label).toBe('fake-db');
    expect(wrapped.customMethod()).toBe('custom:fake-db');
    expect(counter).toEqual({ queries: 0, batches: 0 });
  });

  it('re-wrapping a wrapped db wraps the original (no double counting)', async () => {
    const first = createDbCounter();
    const second = createDbCounter();
    const onceWrapped = countDb(makeFakeDb(), first);
    const rewrapped = countDb(onceWrapped, second);
    await rewrapped.prepare('SELECT 1').all();
    expect(second.queries).toBe(1);
    expect(first.queries).toBe(0);
  });
});
