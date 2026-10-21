import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

// Execute the built entry and assets in workerd, with ephemeral local D1 only.
// No AI binding, remote credentials, provider calls, browser, or production storage.
const token = 'fixture-only-openstride-runtime-token-12345678';
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    cf: false,
    modules: true,
    scriptPath: 'dist/index.js',
    compatibilityDate: '2026-09-10',
    bindings: { APP_TOKEN: token },
    d1Databases: ['DB'],
    outboundService() {
      throw new Error('External requests are forbidden in the runtime check.');
    },
    assets: {
      directory: 'public',
      binding: 'ASSETS',
      run_worker_first: true,
      routerConfig: { has_user_worker: true },
    },
  }),
);
try {
  const db = await runtime.getD1Database('DB');
  const migration = await readFile('migrations/0001_initial.sql', 'utf8');
  await db.batch(
    migration
      .split(';')
      .map((sql) => sql.trim())
      .filter(Boolean)
      .map((sql) => db.prepare(sql)),
  );
  const request = (path, options) => runtime.dispatchFetch(`http://localhost${path}`, options);
  const home = await request('/');
  assert.equal(home.status, 200, await home.clone().text());
  assert.match(await home.text(), /OpenStride/);
  assert.match(home.headers.get('Content-Security-Policy'), /default-src 'self'/);
  const stylesheet = await request('/styles.css');
  assert.equal(stylesheet.status, 200);
  assert.equal(await stylesheet.text(), await readFile('public/styles.css', 'utf8'));
  assert.equal((await request('/api/plans')).status, 401);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const created = await request('/api/plans', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Runtime fixture',
      goal: '10k',
      startDate: '2090-01-02',
      weeks: 8,
      currentWeeklyKm: 24,
      currentLongestKm: 10,
      days: [1, 3, 6],
      longRunDay: 6,
      intensity: 'balanced',
    }),
  });
  assert.equal(created.status, 201);
  const plan = await created.json();
  assert.ok(plan.id && plan.workouts.length > 0);
  const persisted = await request(`/api/plans/${plan.id}`, { headers });
  assert.deepEqual(await persisted.json(), plan);
  const calendar = await request(`/api/plans/${plan.id}/calendar.ics`, { headers });
  assert.equal(calendar.status, 200);
  assert.match(await calendar.text(), /BEGIN:VCALENDAR/);
  const invalid = await request('/api/plans', { method: 'POST', headers, body: '{}' });
  assert.equal(invalid.status, 400);
  const oversized = await request('/api/plans', {
    method: 'POST',
    headers,
    body: ' '.repeat(32769),
  });
  assert.equal(oversized.status, 413);
  console.log(
    'Built workerd entry, exact CSS, CSP, auth, D1 persistence, export and input guards passed.',
  );
} finally {
  await runtime.dispose();
}
