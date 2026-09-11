import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPlatformProxy, type PlatformProxy } from 'wrangler';
import { generatePlan } from '../src/engine';
import {
  ConflictError,
  easePlan,
  getPlan,
  listActivities,
  listPlans,
  MissingError,
  saveActivities,
  savePlan,
  updateWorkout,
} from '../src/store';
import type { Bindings, PlanConfig } from '../src/types';

const config: PlanConfig = {
  name: 'Database test',
  goal: '10k',
  startDate: '2090-01-02',
  weeks: 8,
  currentWeeklyKm: 24,
  currentLongestKm: 10,
  days: [1, 3, 6],
  longRunDay: 6,
  intensity: 'balanced',
  recent5kMinutes: 28,
};
let platform: PlatformProxy<Bindings>;
let db: D1Database;
beforeAll(async () => {
  platform = await getPlatformProxy<Bindings>({
    persist: false,
    remoteBindings: false,
    envFiles: [],
  });
  db = platform.env.DB;
  const sql = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
  await db.batch(
    sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s)),
  );
}, 30_000);
afterAll(async () => {
  await platform?.dispose();
});
beforeEach(async () => {
  await db.batch(
    ['DELETE FROM plans', 'DELETE FROM activities', 'DELETE FROM connection'].map((s) =>
      db.prepare(s),
    ),
  );
});

describe('D1 persistence', () => {
  it('round-trips generated plans and isolates workout edits to their owning plan', async () => {
    const first = generatePlan(config, 'first');
    const second = generatePlan(config, 'second');
    await savePlan(db, first);
    await savePlan(db, second);
    expect(await getPlan(db, first.id)).toEqual(first);
    expect(await listPlans(db)).toHaveLength(2);
    await expect(
      updateWorkout(db, first.id, second.workouts[0].id, { status: 'completed' }),
    ).rejects.toBeInstanceOf(MissingError);
    expect(await getPlan(db, first.id)).toEqual(first);
    const result = await updateWorkout(db, first.id, first.workouts[0].id, {
      status: 'completed',
      actualKm: 5.1,
      actualMinutes: 32,
      effort: 6,
      notes: 'Comfortable',
    });
    expect(result.workouts.find((w) => w.id === first.workouts[0].id)).toMatchObject({
      status: 'completed',
      actualKm: 5.1,
      notes: 'Comfortable',
    });
    expect(await getPlan(db, second.id)).toEqual(second);
    expect(await getPlan(db, first.id)).toEqual(result);
  });

  it('rejects missing plans and conflicting reschedules without changing stored data', async () => {
    await expect(getPlan(db, 'missing')).rejects.toBeInstanceOf(MissingError);
    const plan = generatePlan(config, 'dates');
    await savePlan(db, plan);
    await expect(
      updateWorkout(db, plan.id, plan.workouts[0].id, { date: plan.workouts[1].date }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await getPlan(db, plan.id)).toEqual(plan);
    await updateWorkout(db, plan.id, plan.workouts[1].id, { status: 'skipped' });
    const moved = await updateWorkout(db, plan.id, plan.workouts[0].id, {
      date: plan.workouts[1].date,
    });
    expect(moved.workouts.find((w) => w.id === plan.workouts[0].id)?.date).toBe(
      plan.workouts[1].date,
    );
    await expect(
      updateWorkout(db, plan.id, plan.workouts[1].id, { status: 'planned' }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      updateWorkout(db, plan.id, plan.workouts[1].id, { status: 'completed' }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await getPlan(db, plan.id)).toEqual(moved);
  });

  it('eases only future planned training, preserves completed work, and handles a repeated request idempotently', async () => {
    const plan = generatePlan(config, 'ease');
    await savePlan(db, plan);
    await updateWorkout(db, plan.id, plan.workouts[2].id, { status: 'completed', actualKm: 8 });
    const before = await getPlan(db, plan.id);
    const start = plan.workouts[1].date;
    const eased = await easePlan(db, plan.id, start);
    for (const original of before.workouts) {
      const changed = eased.workouts.find((w) => w.id === original.id);
      if (!changed) throw new Error('Easing removed a workout');
      if (original.date < start || original.status !== 'planned' || original.type === 'race')
        expect(changed).toEqual(original);
      else {
        expect(changed.distanceKm).toBe(Math.round(original.distanceKm * 8) / 10);
        expect(changed.type).toBe('easy');
        expect(changed.paceMinSeconds).toBeUndefined();
      }
    }
    expect(await easePlan(db, plan.id, start)).toEqual(eased);
    expect(await getPlan(db, plan.id)).toEqual(eased);
    await expect(easePlan(db, plan.id, '2000-01-01')).rejects.toBeInstanceOf(ConflictError);
    await expect(easePlan(db, plan.id, '2099-01-01')).rejects.toBeInstanceOf(ConflictError);
  });

  it('upserts duplicate imported activity IDs across statement batches', async () => {
    const activities = Array.from({ length: 23 }, (_, i) => ({
      id: `strava:${i}`,
      source: 'strava' as const,
      date: '2090-01-02',
      name: `Run ${i}`,
      distanceKm: 5,
      durationMinutes: 30,
    }));
    await saveActivities(db, activities);
    await saveActivities(db, [
      { ...activities[0], distanceKm: 6, name: 'Corrected distance' },
      ...activities.slice(1),
    ]);
    const stored = await listActivities(db);
    expect(stored).toHaveLength(23);
    expect(stored.find((a) => a.id === 'strava:0')).toMatchObject({
      distanceKm: 6,
      name: 'Corrected distance',
    });
  });

  it('never silently loses an acknowledged concurrent workout edit', async () => {
    const plan = generatePlan(config, 'concurrent');
    await savePlan(db, plan);
    const changes = plan.workouts.slice(0, 12);
    const outcomes = await Promise.allSettled(
      changes.map((w, i) => updateWorkout(db, plan.id, w.id, { notes: `Edit ${i}` })),
    );
    const stored = await getPlan(db, plan.id);
    expect(outcomes.some((o) => o.status === 'fulfilled')).toBe(true);
    outcomes.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled')
        expect(stored.workouts.find((w) => w.id === changes[i].id)?.notes).toBe(`Edit ${i}`);
      else expect(outcome.reason).toBeInstanceOf(ConflictError);
    });
  });
});
