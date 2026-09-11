import { Hono, type MiddlewareHandler } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { bearerAuth } from 'hono/bearer-auth';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import { isAccessConfigured, verifyAccess } from './access';
import { generatePlan, planConfigSchema, toCalendar, toCsv } from './engine';
import { handleMcp, type ToolName, toolSchemas } from './mcp';
import {
  activityInputSchema,
  ConflictError,
  dateSchema,
  easePlan,
  getPlan,
  importActivities,
  importActivitiesSchema,
  listActivities,
  listPlans,
  MissingError,
  saveActivities,
  savePlan,
  updateWorkout,
  workoutPatchSchema,
} from './store';
import * as strava from './strava';
import type { Bindings } from './types';
import { Dashboard, ErrorPage, Home, Layout, NewPlan, PlanPage } from './views';

const app = new Hono<{ Bindings: Bindings }>();
app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'none'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
    referrerPolicy: 'same-origin',
  }),
);
app.use(
  '*',
  bodyLimit({
    maxSize: 32768,
    onError: (c) => c.json({ error: 'Request body exceeds 32 KB.' }, 413),
  }),
);
app.use('*', async (c, next) => {
  const path = c.req.path;
  if (
    !(
      path === '/app' ||
      path.startsWith('/app/') ||
      path === '/api' ||
      path.startsWith('/api/') ||
      path === '/mcp'
    )
  )
    return next();
  c.header('Cache-Control', 'no-store');
  if (!c.env.APP_TOKEN || c.env.APP_TOKEN.length < 32)
    return c.json({ error: 'Set APP_TOKEN to a random secret of at least 32 characters.' }, 503);
  const bearer = c.req.header('Authorization')?.toLowerCase().startsWith('bearer ') ?? false;
  const accessMode = Boolean(
    c.env.CF_ACCESS_TEAM_DOMAIN || c.env.CF_ACCESS_AUD || c.env.OWNER_EMAIL,
  );
  if (accessMode && !isAccessConfigured(c.env))
    return c.json({ error: 'Cloudflare Access configuration is incomplete.' }, 503);
  const middleware: MiddlewareHandler<{ Bindings: Bindings }> =
    bearer || path === '/mcp' || (accessMode && (path === '/api' || path.startsWith('/api/')))
      ? bearerAuth<{ Bindings: Bindings }>({ token: c.env.APP_TOKEN })
      : accessMode
        ? async (context, proceed) => {
            if (!(await verifyAccess(context.req.raw, context.env)))
              throw new HTTPException(401, { message: 'Sign in through Cloudflare Access.' });
            return proceed();
          }
        : (basicAuth({
            username: 'runner',
            password: c.env.APP_TOKEN,
            realm: 'OpenStride',
          }) as MiddlewareHandler<{ Bindings: Bindings }>);
  return middleware(c, async () => {
    const origin = c.req.header('Origin');
    if (origin && origin !== new URL(c.req.url).origin) {
      console.warn(JSON.stringify({ event: 'origin_mismatch' }));
      throw new HTTPException(403, { message: 'Cross-origin requests are not allowed.' });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !bearer && !origin)
      throw new HTTPException(403, { message: 'Browser changes require a same-origin request.' });
    await next();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method))
      console.info(
        JSON.stringify({
          event: 'mutation',
          route: c.req.routePath,
          method: c.req.method,
          status: c.res.status,
        }),
      );
  });
});
const connection = (env: Bindings) =>
  env.DB.prepare("SELECT value FROM connection WHERE id='strava'").first<{ value: string }>();
async function stravaStatus(env: Bindings) {
  const bridge = await env.DB.prepare(
    "SELECT updated_at FROM connection WHERE id='activity_bridge'",
  ).first<{ updated_at: string }>();
  return {
    configured: strava.configured(env),
    connected: !!(await connection(env)),
    bridgeSyncedAt: bridge?.updated_at,
  };
}
async function persistTokens(env: Bindings, tokens: strava.StravaTokens) {
  await env.DB.prepare(
    "INSERT INTO connection(id,value,updated_at) VALUES('strava',?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
  )
    .bind(await strava.encryptTokens(env, tokens), new Date().toISOString())
    .run();
}
async function syncStrava(env: Bindings) {
  const row = await connection(env);
  if (!row) throw new MissingError('Connect Strava first.');
  let tokens = await strava.decryptTokens(env, row.value);
  if (tokens.expiresAt < Date.now() / 1000 + 300) {
    tokens = await strava.refreshTokens(env, tokens);
    const updated = await env.DB.prepare(
      "UPDATE connection SET value=?,updated_at=? WHERE id='strava' AND value=? RETURNING id",
    )
      .bind(await strava.encryptTokens(env, tokens), new Date().toISOString(), row.value)
      .first();
    if (!updated)
      throw new ConflictError('Strava connection changed during refresh. Try syncing again.');
  }
  const activities = await strava.fetchActivities(
    tokens,
    Math.floor(Date.now() / 1000) - 90 * 86400,
  );
  await saveActivities(env.DB, activities);
  return { imported: activities.length, windowDays: 90, sourceActivityLimit: 100 };
}
async function disconnect(env: Bindings) {
  await env.DB.prepare("DELETE FROM connection WHERE id='strava'").run();
  return { disconnected: true };
}
async function create(env: Bindings, input: unknown) {
  const plan = generatePlan(planConfigSchema.parse(input), crypto.randomUUID());
  await savePlan(env.DB, plan);
  return plan;
}
async function logActivity(env: Bindings, input: unknown) {
  const activity = {
    ...activityInputSchema.parse(input),
    id: `manual:${crypto.randomUUID()}`,
    source: 'manual' as const,
  };
  await saveActivities(env.DB, [activity]);
  return activity;
}
async function jsonBody(request: Request) {
  try {
    return await request.json();
  } catch {
    throw new HTTPException(400, { message: 'Provide valid JSON.' });
  }
}
const easeSchema = z.object({ startDate: dateSchema }).strict();
app.get('/', (c) =>
  c.html(
    <Layout title="Your running, your way">
      <Home accessLogin={isAccessConfigured(c.env)} />
    </Layout>,
  ),
);
app.get('/healthz', (c) => c.json({ status: 'ok' }));
app.get('/styles.css', (c) => c.env.ASSETS.fetch(c.req.raw));
app.get('/app', async (c) => {
  const [plans, activities, status] = await Promise.all([
    listPlans(c.env.DB),
    listActivities(c.env.DB),
    stravaStatus(c.env),
  ]);
  return c.html(
    <Layout title="My running">
      <Dashboard
        plans={plans}
        activities={activities}
        stravaConfigured={status.configured}
        stravaConnected={status.connected}
        bridgeSyncedAt={status.bridgeSyncedAt}
      />
    </Layout>,
  );
});
app.get('/app/new', (c) =>
  c.html(
    <Layout title="New plan">
      <NewPlan />
    </Layout>,
  ),
);
app.get('/app/plans/:id', async (c) =>
  c.html(
    <Layout title="Training plan">
      <PlanPage plan={await getPlan(c.env.DB, c.req.param('id'))} />
    </Layout>,
  ),
);
app.post('/app/plans', async (c) => {
  const form = await c.req.raw.formData();
  const input = Object.fromEntries(form);
  const config = {
    ...input,
    days: form.getAll('days').map(Number),
    weeks: Number(input.weeks),
    currentWeeklyKm: Number(input.currentWeeklyKm),
    currentLongestKm: Number(input.currentLongestKm),
    longRunDay: Number(input.longRunDay),
    recent5kMinutes: input.recent5kMinutes ? Number(input.recent5kMinutes) : undefined,
  };
  const parsed = planConfigSchema.safeParse(config);
  if (!parsed.success)
    return c.html(
      <Layout title="Review your plan">
        <NewPlan error={parsed.error.issues.map((i) => i.message).join(' ')} />
      </Layout>,
      400,
    );
  const plan = await create(c.env, parsed.data);
  return c.redirect(`/app/plans/${plan.id}`, 303);
});
app.post('/app/workouts/:id', async (c) => {
  const form = Object.fromEntries(await c.req.raw.formData());
  const { planId, ...patch } = form;
  const input: Record<string, unknown> = { ...patch };
  for (const key of ['actualKm', 'actualMinutes', 'effort']) {
    if (input[key] === '') input[key] = null;
    else if (input[key] !== undefined) input[key] = Number(input[key]);
  }
  const id = z.string().min(1).max(100).parse(planId);
  await updateWorkout(c.env.DB, id, c.req.param('id'), workoutPatchSchema.parse(input));
  return c.redirect(`/app/plans/${encodeURIComponent(id)}`, 303);
});
app.post('/app/plans/:id/ease', async (c) => {
  const input = easeSchema.parse(Object.fromEntries(await c.req.raw.formData()));
  await easePlan(c.env.DB, c.req.param('id'), input.startDate);
  return c.redirect(`/app/plans/${encodeURIComponent(c.req.param('id'))}`, 303);
});
app.post('/app/activities', async (c) => {
  const form = Object.fromEntries(await c.req.raw.formData());
  await logActivity(c.env, {
    ...form,
    distanceKm: Number(form.distanceKm),
    durationMinutes: Number(form.durationMinutes),
  });
  return c.redirect('/app', 303);
});
app.get('/api/plans', async (c) => c.json(await listPlans(c.env.DB)));
app.post('/api/plans', async (c) => c.json(await create(c.env, await jsonBody(c.req.raw)), 201));
app.get('/api/plans/:id', async (c) => c.json(await getPlan(c.env.DB, c.req.param('id'))));
app.patch('/api/plans/:planId/workouts/:id', async (c) =>
  c.json(
    await updateWorkout(
      c.env.DB,
      c.req.param('planId'),
      c.req.param('id'),
      workoutPatchSchema.parse(await jsonBody(c.req.raw)),
    ),
  ),
);
app.post('/api/plans/:id/ease', async (c) =>
  c.json(
    await easePlan(
      c.env.DB,
      c.req.param('id'),
      easeSchema.parse(await jsonBody(c.req.raw)).startDate,
    ),
  ),
);
app.on('GET', ['/api/plans/:id/calendar.ics', '/app/plans/:id/calendar.ics'], async (c) => {
  c.header('Content-Type', 'text/calendar; charset=utf-8');
  c.header('Content-Disposition', 'attachment; filename="openstride.ics"');
  return c.body(toCalendar(await getPlan(c.env.DB, c.req.param('id'))));
});
app.on('GET', ['/api/plans/:id/export.csv', '/app/plans/:id/export.csv'], async (c) => {
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', 'attachment; filename="openstride.csv"');
  return c.body(toCsv(await getPlan(c.env.DB, c.req.param('id'))));
});
app.get('/api/activities', async (c) => c.json(await listActivities(c.env.DB)));
app.post('/api/activities/import', async (c) =>
  c.json(await importActivities(c.env.DB, importActivitiesSchema.parse(await jsonBody(c.req.raw)))),
);
app.get('/app/plans/:id/data', async (c) => c.json(await getPlan(c.env.DB, c.req.param('id'))));
app.post('/api/activities', async (c) =>
  c.json(await logActivity(c.env, await jsonBody(c.req.raw)), 201),
);
app.get('/api/integrations', async (c) => c.json({ strava: await stravaStatus(c.env) }));
app.post('/api/strava/sync', async (c) => c.json(await syncStrava(c.env)));
app.delete('/api/strava', async (c) => c.json(await disconnect(c.env)));
app.post('/app/strava/sync', async (c) => {
  await syncStrava(c.env);
  return c.redirect('/app#connections', 303);
});
app.post('/app/strava/disconnect', async (c) => {
  await disconnect(c.env);
  return c.redirect('/app#connections', 303);
});
app.get('/app/strava/connect', async (c) => {
  if (!strava.configured(c.env))
    throw new HTTPException(503, { message: 'Strava is not configured.' });
  if (c.env.STRAVA_REDIRECT_URI !== `${new URL(c.req.url).origin}/app/strava/callback`)
    throw new HTTPException(503, {
      message: 'Strava redirect URI must match this installation’s /app/strava/callback URL.',
    });
  const state = `${Date.now()}-${crypto.randomUUID()}`;
  await c.env.DB.prepare(
    "INSERT INTO connection(id,value,updated_at) VALUES('oauth',?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
  )
    .bind(state, new Date().toISOString())
    .run();
  await setSignedCookie(c, 'openstride_oauth', state, c.env.APP_TOKEN, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/app/strava/callback',
    maxAge: 600,
  });
  return c.redirect(strava.connectUrl(c.env, state));
});
app.get('/app/strava/callback', async (c) => {
  const cookie = await getSignedCookie(c, c.env.APP_TOKEN, 'openstride_oauth');
  deleteCookie(c, 'openstride_oauth', { path: '/app/strava/callback' });
  if (
    !cookie ||
    cookie !== c.req.query('state') ||
    !/^\d{13}-[a-f0-9-]{36}$/.test(cookie) ||
    Date.now() - Number(cookie.slice(0, 13)) > 600000 ||
    Number(cookie.slice(0, 13)) > Date.now()
  )
    throw new HTTPException(400, {
      message: 'Authorization expired or state did not match. Start connecting again.',
    });
  const consumed = await c.env.DB.prepare(
    "DELETE FROM connection WHERE id='oauth' AND value=? RETURNING id",
  )
    .bind(cookie)
    .first();
  if (!consumed)
    throw new HTTPException(400, {
      message: 'Authorization was already used or replaced. Start connecting again.',
    });
  if (c.req.query('error'))
    throw new HTTPException(400, { message: 'Strava authorization was declined.' });
  const scopes = (c.req.query('scope') ?? '').split(',');
  if (!scopes.includes('activity:read') && !scopes.includes('activity:read_all'))
    throw new HTTPException(400, { message: 'Strava activity read permission is required.' });
  const code = z.string().min(1).max(4096).parse(c.req.query('code'));
  await persistTokens(c.env, await strava.exchangeCode(c.env, code));
  return c.redirect('/app#connections', 303);
});
async function callTool(env: Bindings, name: ToolName, raw: unknown): Promise<unknown> {
  switch (name) {
    case 'list_plans':
      return listPlans(env.DB);
    case 'get_plan':
      return getPlan(env.DB, toolSchemas.get_plan.parse(raw).planId);
    case 'create_plan':
      return create(env, raw);
    case 'update_workout': {
      const a = toolSchemas.update_workout.parse(raw);
      return updateWorkout(env.DB, a.planId, a.workoutId, a.patch);
    }
    case 'ease_plan': {
      const a = toolSchemas.ease_plan.parse(raw);
      return easePlan(env.DB, a.planId, a.startDate);
    }
    case 'list_activities':
      return listActivities(env.DB);
    case 'log_activity':
      return logActivity(env, raw);
    case 'import_activities':
      return importActivities(env.DB, importActivitiesSchema.parse(raw));
    case 'export_calendar':
      return toCalendar(await getPlan(env.DB, toolSchemas.export_calendar.parse(raw).planId));
    case 'export_csv':
      return toCsv(await getPlan(env.DB, toolSchemas.export_csv.parse(raw).planId));
    case 'strava_status':
      return stravaStatus(env);
    case 'sync_strava':
      return syncStrava(env);
    case 'disconnect_strava':
      return disconnect(env);
  }
}
app.post('/mcp', async (c) => {
  const result = await handleMcp(await jsonBody(c.req.raw), (name, args) =>
    callTool(c.env, name, args),
  );
  return result === null ? c.body(null, 202) : c.json(result);
});
app.all('/mcp', (c) => {
  c.header('Allow', 'POST');
  return c.json({ error: 'This stateless MCP endpoint accepts POST requests.' }, 405);
});
app.notFound((c) => c.json({ error: 'Not found.' }, 404));
app.onError((error, c) => {
  console.warn(
    JSON.stringify({
      event: 'request_error',
      route: c.req.routePath,
      method: c.req.method,
      kind:
        error instanceof z.ZodError
          ? 'validation'
          : error instanceof HTTPException
            ? `http_${error.status}`
            : error instanceof MissingError
              ? 'missing'
              : error instanceof ConflictError
                ? 'conflict'
                : 'internal',
    }),
  );
  if (error instanceof HTTPException && error.getResponse().headers.has('WWW-Authenticate'))
    return error.getResponse();
  const status =
    error instanceof HTTPException
      ? error.status
      : error instanceof z.ZodError
        ? 400
        : error instanceof MissingError
          ? 404
          : error instanceof ConflictError
            ? 409
            : 500;
  const message =
    error instanceof HTTPException ||
    error instanceof MissingError ||
    error instanceof ConflictError
      ? error.message
      : error instanceof z.ZodError
        ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        : 'The operation could not be completed. Check your configuration or connection and try again.';
  if (c.req.path.startsWith('/app'))
    return c.html(
      <Layout title="Unable to continue">
        <ErrorPage message={message} />
      </Layout>,
      status,
    );
  return c.json({ error: message }, status);
});
export default app;
