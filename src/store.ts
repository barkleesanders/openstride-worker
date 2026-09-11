import { z } from 'zod';
import { planConfigSchema } from './engine';
import type { Activity, Plan, Workout } from './types';

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const parsed = new Date(`${s}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === s;
  }, 'Use a real calendar date in YYYY-MM-DD format.');
export const workoutPatchSchema = z
  .object({
    status: z.enum(['planned', 'completed', 'skipped']).optional(),
    date: dateSchema.optional(),
    actualKm: z.number().finite().min(0).max(300).nullable().optional(),
    actualMinutes: z.number().finite().min(0).max(3000).nullable().optional(),
    effort: z.number().int().min(1).max(10).nullable().optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one change.');
const workoutSchema = z.object({
  id: z.string(),
  planId: z.string(),
  date: dateSchema,
  week: z.number(),
  type: z.enum(['easy', 'long', 'tempo', 'intervals', 'race', 'run-walk']),
  title: z.string(),
  distanceKm: z.number().finite(),
  description: z.string(),
  paceMinSeconds: z.number().optional(),
  paceMaxSeconds: z.number().optional(),
  status: z.enum(['planned', 'completed', 'skipped']),
  actualKm: z.number().optional(),
  actualMinutes: z.number().optional(),
  effort: z.number().optional(),
  notes: z.string().optional(),
});
const storedPlanSchema = z.object({
  ai: z.object({ model: z.string(), rationale: z.string(), generatedAt: z.string() }).optional(),
  id: z.string(),
  createdAt: z.string(),
  config: planConfigSchema,
  engineVersion: z.string(),
  warnings: z.array(z.string()),
  workouts: z.array(workoutSchema),
});
export const activityInputSchema = z
  .object({
    date: dateSchema,
    name: z.string().trim().min(1).max(120),
    distanceKm: z.number().finite().min(0).max(300),
    durationMinutes: z.number().finite().positive().max(3000),
  })
  .strict();
const activitySchema = activityInputSchema.extend({
  id: z.string(),
  source: z.enum(['manual', 'strava']),
  name: z.string().max(120),
  distanceKm: z.number().finite().nonnegative(),
  durationMinutes: z.number().finite().nonnegative(),
});
export const importActivitiesSchema = z
  .object({
    activities: z
      .array(
        activityInputSchema.extend({
          id: z.string().regex(/^strava:[0-9]{1,20}$/),
          source: z.literal('strava'),
        }),
      )
      .max(100),
  })
  .strict();
export async function importActivities(
  db: D1Database,
  input: z.infer<typeof importActivitiesSchema>,
) {
  await saveActivities(db, input.activities);
  const syncedAt = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO connection(id,value,updated_at) VALUES('activity_bridge',?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    )
    .bind(JSON.stringify({ syncedAt, imported: input.activities.length }), syncedAt)
    .run();
  return { imported: input.activities.length, syncedAt };
}
type PlanRow = { data: string; revision: number };
export class ConflictError extends Error {}
export class MissingError extends Error {}

export async function savePlan(db: D1Database, plan: Plan): Promise<void> {
  await db
    .prepare('INSERT INTO plans(id,created_at,data) VALUES(?,?,?)')
    .bind(plan.id, plan.createdAt, JSON.stringify(plan))
    .run();
}
export async function getPlan(db: D1Database, id: string): Promise<Plan> {
  const row = await db
    .prepare('SELECT data FROM plans WHERE id=?')
    .bind(id)
    .first<{ data: string }>();
  if (!row) throw new MissingError('Plan not found.');
  return storedPlanSchema.parse(JSON.parse(row.data));
}
export async function listPlans(db: D1Database): Promise<Plan[]> {
  const rows = await db
    .prepare('SELECT data FROM plans ORDER BY created_at DESC,id LIMIT 10')
    .all<{ data: string }>();
  return rows.results.map((r) => storedPlanSchema.parse(JSON.parse(r.data)));
}
async function modifyPlan(db: D1Database, id: string, modify: (plan: Plan) => Plan): Promise<Plan> {
  const row = await db
    .prepare('SELECT data,revision FROM plans WHERE id=?')
    .bind(id)
    .first<PlanRow>();
  if (!row) throw new MissingError('Plan not found.');
  const next = modify(storedPlanSchema.parse(JSON.parse(row.data)));
  const updated = await db
    .prepare(
      'UPDATE plans SET data=?,revision=revision+1 WHERE id=? AND revision=? RETURNING revision',
    )
    .bind(JSON.stringify(next), id, row.revision)
    .first<{ revision: number }>();
  if (!updated)
    throw new ConflictError('This plan changed in another request. Reload and try again.');
  return next;
}
export async function updateWorkout(
  db: D1Database,
  planId: string,
  workoutId: string,
  patch: z.infer<typeof workoutPatchSchema>,
): Promise<Plan> {
  return modifyPlan(db, planId, (plan) => {
    const existing = plan.workouts.find((w) => w.id === workoutId);
    if (!existing) throw new MissingError('Workout not found in this plan.');
    const { actualKm, actualMinutes, effort, ...rest } = patch;
    const next: Workout = { ...existing, ...rest };
    if (actualKm !== undefined) {
      if (actualKm === null) delete next.actualKm;
      else next.actualKm = actualKm;
    }
    if (actualMinutes !== undefined) {
      if (actualMinutes === null) delete next.actualMinutes;
      else next.actualMinutes = actualMinutes;
    }
    if (effort !== undefined) {
      if (effort === null) delete next.effort;
      else next.effort = effort;
    }
    if (
      next.status !== 'skipped' &&
      plan.workouts.some(
        (w) => w.id !== workoutId && w.date === next.date && w.status !== 'skipped',
      )
    ) {
      throw new ConflictError('Another workout is already scheduled for that day.');
    }
    return {
      ...plan,
      workouts: plan.workouts
        .map((w) => (w.id === workoutId ? next : w))
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  });
}
export async function easePlan(db: D1Database, id: string, startDate: string): Promise<Plan> {
  dateSchema.parse(startDate);
  if (startDate < new Date().toISOString().slice(0, 10))
    throw new ConflictError('Choose today or a future date.');
  return modifyPlan(db, id, (plan) => {
    const notice = `Future planned training from ${startDate} reduced by 20% at your request.`;
    if (plan.warnings.includes(notice)) return plan;
    if (
      !plan.workouts.some((w) => w.status === 'planned' && w.date >= startDate && w.type !== 'race')
    )
      throw new ConflictError('No future planned workouts to reduce.');
    return {
      ...plan,
      workouts: plan.workouts.map(
        (w): Workout =>
          w.status === 'planned' && w.date >= startDate && w.type !== 'race'
            ? {
                ...w,
                distanceKm: Math.round(w.distanceKm * 8) / 10,
                type: w.type === 'run-walk' ? 'run-walk' : 'easy',
                title: 'Recovery-focused easy run',
                description:
                  'Reduced by 20% at your request. Keep the effort conversational; walk or rest if needed.',
                paceMinSeconds: undefined,
                paceMaxSeconds: undefined,
              }
            : w,
      ),
      warnings: [...plan.warnings, notice],
    };
  });
}
export async function listActivities(db: D1Database): Promise<Activity[]> {
  const rows = await db
    .prepare('SELECT data FROM activities ORDER BY date DESC,id LIMIT 100')
    .all<{ data: string }>();
  return rows.results.map((r) => activitySchema.parse(JSON.parse(r.data)));
}
export async function saveActivities(db: D1Database, activities: Activity[]): Promise<void> {
  // Ten inserts per statement keeps each query below D1's 100-parameter limit.
  for (let i = 0; i < activities.length; i += 10) {
    const batch = activities.slice(i, i + 10).map((a) => activitySchema.parse(a));
    const sql = `INSERT INTO activities(id,date,data) VALUES ${batch.map(() => '(?,?,?)').join(',')} ON CONFLICT(id) DO UPDATE SET date=excluded.date,data=excluded.data`;
    await db
      .prepare(sql)
      .bind(...batch.flatMap((a) => [a.id, a.date, JSON.stringify(a)]))
      .run();
  }
}
