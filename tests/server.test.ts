import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPlatformProxy, type PlatformProxy } from 'wrangler';
import app from '../src/index';
import type { Bindings, Plan, PlanConfig } from '../src/types';
const TOKEN = 'test-only-openstride-secret-not-for-deployment-12345';
const ORIGIN = 'https://openstride.test';
const basic = `Basic ${btoa(`runner:${TOKEN}`)}`;
const bearer = `Bearer ${TOKEN}`;
const config: PlanConfig = {
  name: '<script>alert(1)</script>',
  goal: '10k',
  startDate: '2090-01-02',
  weeks: 8,
  currentWeeklyKm: 24,
  currentLongestKm: 10,
  days: [1, 3, 6],
  longRunDay: 6,
  intensity: 'balanced',
};
let platform: PlatformProxy<Bindings>;
let env: Bindings;
function request(path: string, options: RequestInit = {}, bindings = env) {
  return app.request(`${ORIGIN}${path}`, options, bindings);
}
function json(
  path: string,
  body: unknown,
  method = 'POST',
  authorization = bearer,
  origin?: string,
) {
  return request(path, {
    method,
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify(body),
  });
}
async function createPlan(): Promise<Plan> {
  const response = await json('/api/plans', config);
  expect(response.status).toBe(201);
  return response.json();
}
beforeAll(async () => {
  platform = await getPlatformProxy<Bindings>({
    persist: false,
    remoteBindings: false,
    envFiles: [],
  });
  env = {
    ...platform.env,
    APP_TOKEN: TOKEN,
    STRAVA_CLIENT_ID: undefined,
    STRAVA_CLIENT_SECRET: undefined,
    STRAVA_REDIRECT_URI: undefined,
  };
  const sql = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
  await env.DB.batch(
    sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => env.DB.prepare(s)),
  );
}, 30_000);
afterAll(async () => {
  await platform?.dispose();
});
beforeEach(async () => {
  await env.DB.batch(
    ['DELETE FROM plans', 'DELETE FROM activities', 'DELETE FROM connection'].map((s) =>
      env.DB.prepare(s),
    ),
  );
});

describe('HTTP security and workflow with actual D1', () => {
  it('serves public landing while protected routes fail closed without a configured secret', async () => {
    expect((await request('/', {}, { ...env, APP_TOKEN: '' })).status).toBe(200);
    for (const path of ['/app', '/api/plans', '/mcp'])
      expect((await request(path, {}, { ...env, APP_TOKEN: '' })).status).toBe(503);
    for (const path of ['/app', '/api/plans', '/mcp'])
      expect((await request(path)).status).toBe(401);
    expect(
      (await request('/api/plans', { headers: { Authorization: 'Bearer wrong' } })).status,
    ).toBe(401);
    expect((await request('/app', { headers: { Authorization: basic } })).status).toBe(200);
    const read = await request('/api/plans', { headers: { Authorization: bearer } });
    expect(read.status).toBe(200);
    expect(read.headers.get('Cache-Control')).toBe('no-store');
    expect(read.headers.get('Content-Security-Policy')).toContain("script-src 'none'");
  });
  it('requires same-origin browser mutations and rejects cross-origin bearer requests', async () => {
    const formPage = await request('/app/new', { headers: { Authorization: basic } });
    expect(formPage.status).toBe(200);
    expect(formPage.headers.get('Referrer-Policy')).toBe('same-origin');
    expect((await json('/api/plans', config, 'POST', basic)).status).toBe(403);
    expect((await json('/api/plans', config, 'POST', basic, 'null')).status).toBe(403);
    expect((await json('/api/plans', config, 'POST', basic, 'https://evil.test')).status).toBe(403);
    expect((await json('/api/plans', config, 'POST', bearer, 'https://evil.test')).status).toBe(
      403,
    );
    expect((await json('/api/plans', config, 'POST', basic, ORIGIN)).status).toBe(201);
  });
  it('validates plan input, renders escaped user content, isolates edits, and exports the saved plan', async () => {
    expect((await json('/api/plans', { ...config, startDate: '2090-02-30' })).status).toBe(400);
    expect((await json('/api/plans', { ...config, weeks: 999 })).status).toBe(400);
    expect(
      (
        await request('/api/plans', {
          method: 'POST',
          headers: { Authorization: bearer, 'Content-Type': 'application/json' },
          body: '{broken',
        })
      ).status,
    ).toBe(400);
    const plan = await createPlan();
    const foreign = await createPlan();
    const html = await (
      await request(`/app/plans/${plan.id}`, { headers: { Authorization: basic } })
    ).text();
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(
      (
        await json(
          `/api/plans/${plan.id}/workouts/${foreign.workouts[0].id}`,
          { status: 'completed' },
          'PATCH',
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await json(
          `/api/plans/${plan.id}/workouts/${plan.workouts[0].id}`,
          { status: 'completed', actualKm: 5 },
          'PATCH',
        )
      ).status,
    ).toBe(200);
    const persisted: Plan = await (
      await request(`/api/plans/${plan.id}`, { headers: { Authorization: bearer } })
    ).json();
    expect(persisted.workouts[0]).toMatchObject({ status: 'completed', actualKm: 5 });
    const ics = await request(`/api/plans/${plan.id}/calendar.ics`, {
      headers: { Authorization: basic },
    });
    expect(ics.status).toBe(200);
    expect(ics.headers.get('Content-Type')).toContain('text/calendar');
    expect(await ics.text()).toContain('BEGIN:VCALENDAR');
    const csv = await request(`/api/plans/${plan.id}/export.csv`, {
      headers: { Authorization: bearer },
    });
    expect(csv.headers.get('Content-Type')).toContain('text/csv');
    expect(await csv.text()).toContain('completed');
  });
  it('supports the actual browser form contract including selected weekdays and workout logging', async () => {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(config)) {
      if (Array.isArray(value)) value.forEach((v) => form.append(key, String(v)));
      else form.set(key, String(value));
    }
    form.set('recent5kMinutes', '');
    const created = await request('/app/plans', {
      method: 'POST',
      headers: { Authorization: basic, Origin: ORIGIN },
      body: form,
    });
    expect(created.status).toBe(303);
    const path = created.headers.get('Location')!;
    const plan: Plan = await (
      await request(path.replace('/app/', '/api/'), { headers: { Authorization: bearer } })
    ).json();
    expect(plan.config.days).toEqual(config.days);
    const workout = new URLSearchParams({
      planId: plan.id,
      status: 'completed',
      date: plan.workouts[0].date,
      actualKm: '4.5',
      actualMinutes: '28',
      effort: '',
      notes: 'Easy',
    });
    expect(
      (
        await request(`/app/workouts/${plan.workouts[0].id}`, {
          method: 'POST',
          headers: { Authorization: basic, Origin: ORIGIN },
          body: workout,
        })
      ).status,
    ).toBe(303);
    const saved: Plan = await (
      await request(`/api/plans/${plan.id}`, { headers: { Authorization: bearer } })
    ).json();
    expect(saved.workouts[0]).toMatchObject({
      actualKm: 4.5,
      actualMinutes: 28,
      notes: 'Easy',
      status: 'completed',
    });
  });
  it('rejects oversized writes and unsigned OAuth callbacks without making a connection', async () => {
    expect((await json('/api/plans', { ...config, name: 'a'.repeat(40000) })).status).toBe(413);
    expect(
      (
        await request('/app/strava/callback?code=unused&state=forged&scope=activity:read', {
          headers: { Authorization: basic },
        })
      ).status,
    ).toBe(400);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM connection').first('count')).toBe(0);
    expect((await json('/api/strava/sync', {})).status).toBe(404);
  });
  it('clears logged numeric fields through API nulls and browser blank fields', async () => {
    const plan = await createPlan();
    const endpoint = `/api/plans/${plan.id}/workouts/${plan.workouts[0].id}`;
    const logged = { status: 'completed', actualKm: 4.5, actualMinutes: 28, effort: 6, notes: 'Keep this note' };
    expect((await json(endpoint, logged, 'PATCH')).status).toBe(200);
    // Omitted values preserve existing readings; explicit null clears them.
    expect((await json(endpoint, { notes: 'Keep this note' }, 'PATCH')).status).toBe(200);
    let saved: Plan = await (await request(`/api/plans/${plan.id}`, { headers: { Authorization: bearer } })).json();
    expect(saved.workouts[0]).toMatchObject(logged);
    expect((await json(endpoint, { actualKm: null, actualMinutes: null, effort: null }, 'PATCH')).status).toBe(200);
    saved = await (await request(`/api/plans/${plan.id}`, { headers: { Authorization: bearer } })).json();
    for (const key of ['actualKm', 'actualMinutes', 'effort']) expect(saved.workouts[0]).not.toHaveProperty(key);
    expect(saved.workouts[0]).toMatchObject({ status: 'completed', notes: 'Keep this note' });
    expect((await json(endpoint, logged, 'PATCH')).status).toBe(200);
    const blankForm = new URLSearchParams({ planId: plan.id, status: 'completed', date: plan.workouts[0].date, actualKm: '', actualMinutes: '', effort: '', notes: 'Keep this note' });
    expect((await request(`/app/workouts/${plan.workouts[0].id}`, { method: 'POST', headers: { Authorization: basic, Origin: ORIGIN }, body: blankForm })).status).toBe(303);
    saved = await (await request(`/api/plans/${plan.id}`, { headers: { Authorization: bearer } })).json();
    for (const key of ['actualKm', 'actualMinutes', 'effort']) expect(saved.workouts[0]).not.toHaveProperty(key);
    expect(saved.workouts[0]).toMatchObject({ status: 'completed', notes: 'Keep this note' });
  });
});

describe('MCP over HTTP', () => {
  it('enforces bearer authentication, initializes, discovers tools, and changes D1 through tools', async () => {
    const rpc = (method: string, params?: unknown, id = 1) =>
      json('/mcp', { jsonrpc: '2.0', id, method, params });
    expect(
      (await json('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, 'POST', basic, ORIGIN)).status,
    ).toBe(400);
    const init = (await (
      await rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'integration-test', version: '1' },
      })
    ).json()) as { result: { serverInfo: { name: string } } };
    expect(init.result.serverInfo.name).toBe('openstride');
    const list = (await (await rpc('tools/list')).json()) as {
      result: { tools: { name: string }[] };
    };
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain('create_plan');
    type ToolResult = { result: { isError?: boolean; content: { text: string }[] } };
    const created = (await (
      await rpc('tools/call', { name: 'create_plan', arguments: config })
    ).json()) as ToolResult;
    expect(created.result.isError).not.toBe(true);
    const plan: Plan = JSON.parse(created.result.content[0].text);
    const changed = (await (
      await rpc('tools/call', {
        name: 'update_workout',
        arguments: {
          planId: plan.id,
          workoutId: plan.workouts[0].id,
          patch: { status: 'skipped' },
        },
      })
    ).json()) as ToolResult;
    expect(changed.result.isError).not.toBe(true);
    const read: Plan = await (
      await request(`/api/plans/${plan.id}`, { headers: { Authorization: bearer } })
    ).json();
    expect(read.workouts[0].status).toBe('skipped');
    const bad = (await (
      await rpc('tools/call', {
        name: 'update_workout',
        arguments: {
          planId: plan.id,
          workoutId: plan.workouts[0].id,
          patch: { status: 'invented' },
        },
      })
    ).json()) as { error: { code: number } };
    expect(bad.error.code).toBe(-32602);
    expect(
      (await json('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' })).status,
    ).toBe(202);
    expect((await request('/mcp', { headers: { Authorization: bearer } })).status).toBe(405);
  });
});
