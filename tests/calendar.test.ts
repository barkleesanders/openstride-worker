import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlatformProxy, type PlatformProxy } from 'wrangler';
import type { CalendarSettings, CalendarSnapshot } from '../src/calendar';
import {
  calendarBridgeState,
  calendarContext,
  calendarState,
  freeSlots,
  importCalendar,
  planCalendarStatus,
  zonedInstant,
} from '../src/calendar';
import type { Bindings, Plan } from '../src/types';

const { getPlan } = vi.hoisted(() => ({ getPlan: vi.fn() }));
vi.mock('../src/store', () => ({ getPlan, ConflictError: class extends Error {} }));
const settings: CalendarSettings = {
  readCalendarIds: ['primary'],
  writeCalendarId: 'primary',
  timeZone: 'America/Los_Angeles',
  windowStart: '06:00',
  windowEnd: '08:00',
};
function snapshot(): CalendarSnapshot {
  return {
    calendars: [
      {
        id: 'primary',
        summary: 'Calendar',
        timeZone: settings.timeZone,
        accessRole: 'owner',
        primary: true,
      },
    ],
    rangeStart: '2026-09-01T00:00:00Z',
    rangeEnd: '2027-01-01T00:00:00Z',
    readCalendarIds: ['primary'],
    syncedAt: new Date().toISOString(),
    busy: [],
    receipts: [],
  };
}
let platform: PlatformProxy<Bindings>;
beforeAll(async () => {
  platform = await getPlatformProxy<Bindings>({
    persist: false,
    remoteBindings: false,
    envFiles: [],
  });
  const sql = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
  await platform.env.DB.batch(
    sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => platform.env.DB.prepare(s)),
  );
}, 30_000);
beforeEach(async () => {
  await platform.env.DB.prepare('DELETE FROM connection').run();
});
afterAll(async () => {
  await platform?.dispose();
});
async function database(values: Record<string, unknown>) {
  const db = platform.env.DB;
  for (const [id, value] of Object.entries(values)) {
    await db
      .prepare('INSERT INTO connection(id,value,updated_at) VALUES(?,?,?)')
      .bind(id, JSON.stringify(value), new Date().toISOString())
      .run();
  }
  return db;
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe('calendar scheduling and sync receipts', () => {
  it('resolves summer/winter offsets and rejects nonexistent spring wall time', () => {
    expect(zonedInstant('2026-09-11', '06:00', settings.timeZone)).toBe(
      Date.parse('2026-09-11T13:00:00Z'),
    );
    expect(zonedInstant('2026-12-11', '06:00', settings.timeZone)).toBe(
      Date.parse('2026-12-11T14:00:00Z'),
    );
    expect(zonedInstant('2026-03-08', '02:30', settings.timeZone)).toBeNull();
    const fall = zonedInstant('2026-11-01', '01:30', settings.timeZone);
    expect([Date.parse('2026-11-01T08:30:00Z'), Date.parse('2026-11-01T09:30:00Z')]).toContain(
      fall,
    );
  });
  it('merges overlapping busy intervals and blocks all-day events', () => {
    const value = snapshot();
    value.busy = [
      { calendarId: 'primary', start: '2026-09-14T13:20:00Z', end: '2026-09-14T14:00:00Z' },
      { calendarId: 'primary', start: '2026-09-14T13:40:00Z', end: '2026-09-14T14:20:00Z' },
    ];
    expect(freeSlots('2026-09-14', settings, value).map((s) => (s.end - s.start) / 60000)).toEqual([
      20, 40,
    ]);
    value.busy = [
      { calendarId: 'primary', start: '2026-09-14T07:00:00Z', end: '2026-09-15T07:00:00Z' },
    ];
    expect(freeSlots('2026-09-14', settings, value)).toEqual([]);
  });
  it('never labels missing, stale or uncovered calendar data as connected', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));
    const value = snapshot();
    expect(calendarContext(settings, value, '2026-09-14', 4).connected).toBe(true);
    for (const changed of [
      { ...value, calendars: [] },
      { ...value, syncedAt: '2026-09-09T12:00:00Z' },
      { ...value, rangeEnd: '2026-09-15T00:00:00Z' },
    ]) {
      expect(calendarContext(settings, changed, '2026-09-14', 4)).toMatchObject({
        connected: false,
        days: [],
      });
    }
  });
  it('invalidates availability when selected read calendars change before the next snapshot', () => {
    const value = snapshot();
    value.calendars.push({ ...value.calendars[0], id: 'secondary', primary: false });
    expect(
      calendarContext(
        { ...settings, readCalendarIds: ['primary', 'secondary'] },
        value,
        '2026-09-14',
        4,
      ),
    ).toMatchObject({ connected: false, days: [] });
    expect(
      calendarContext({ ...settings, readCalendarIds: ['secondary'] }, value, '2026-09-14', 4),
    ).toMatchObject({ connected: false, days: [] });
  });
  it('rejects a stale snapshot without overwriting the stored busy intervals', async () => {
    const old = snapshot();
    old.syncedAt = '2026-09-11T11:00:00Z';
    const db = await database({ calendar_snapshot: old });
    await expect(importCalendar(db, { ...old, syncedAt: '2026-09-11T10:00:00Z' })).rejects.toThrow(
      'newer calendar snapshot',
    );
    expect((await calendarState(db)).snapshot).toEqual(old);
  });
  it('rejects a concurrent write and preserves both receipts after the loser retries', async () => {
    const old = snapshot();
    const db = await database({ calendar_snapshot: old });
    let reads = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Hold only the initial reads so both operations compare against the same actual D1 row.
    const concurrentDb = new Proxy(db, {
      get(target, key) {
        if (key !== 'prepare') return Reflect.get(target, key);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (sql !== "SELECT value FROM connection WHERE id='calendar_snapshot'") return statement;
          return new Proxy(statement, {
            get(statementTarget, statementKey) {
              if (statementKey !== 'first') return Reflect.get(statementTarget, statementKey);
              return async () => {
                const row = await statementTarget.first();
                reads += 1;
                if (reads === 2) release();
                await barrier;
                return row;
              };
            },
          });
        };
      },
    });
    const inputs = ['one', 'two'].map((workoutId) => ({
      ...old,
      receipts: [
        {
          calendarId: 'primary',
          workoutId,
          eventId: workoutId,
          updatedAt: old.syncedAt,
          status: 'synced' as const,
        },
      ],
    }));
    const results = await Promise.allSettled(
      inputs.map((input) => importCalendar(concurrentDb, input)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.findIndex((r) => r.status === 'rejected');
    expect(results[failed]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringContaining('concurrently') }),
    });
    expect((await calendarState(db)).snapshot?.receipts).toHaveLength(1);
    await importCalendar(db, inputs[failed]);
    expect((await calendarState(db)).snapshot?.receipts.map((r) => r.workoutId).sort()).toEqual([
      'one',
      'two',
    ]);
  });
  it('retains earlier receipts and merges by calendar/workout using latest receipt timestamp', async () => {
    const old = snapshot();
    old.receipts = [
      {
        calendarId: 'primary',
        workoutId: 'one',
        eventId: 'one',
        updatedAt: '2026-09-10T10:00:00Z',
        status: 'synced',
      },
    ];
    const db = await database({ calendar_snapshot: old });
    const next = snapshot();
    next.receipts = [
      {
        calendarId: 'secondary',
        workoutId: 'one',
        eventId: 'two',
        updatedAt: '2026-09-10T11:00:00Z',
        status: 'synced',
      },
    ];
    await importCalendar(db, next);
    expect((await calendarState(db)).snapshot?.receipts).toHaveLength(2);
    await importCalendar(db, { ...next, receipts: [] });
    expect((await calendarState(db)).snapshot?.receipts).toHaveLength(2);
  });
  it('preserves completed and past events when a subscription is disabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));
    const workouts = [
      { id: 'past', date: '2026-09-10', status: 'planned' },
      { id: 'completed', date: '2026-09-12', status: 'completed' },
      { id: 'future', date: '2026-09-12', status: 'planned' },
    ];
    getPlan.mockResolvedValue({ id: 'plan', workouts });
    const db = await database({
      calendar_snapshot: snapshot(),
      calendar_settings: settings,
      'calendar_plan:plan': { planId: 'plan', calendarId: 'primary', enabled: false },
    });
    const bridge = await calendarBridgeState(db);
    expect(bridge.desired.map((e) => e.workoutId)).toEqual(['future']);
    expect(bridge.desired[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it('requires matching content fingerprints before reporting sync current', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));
    const plan = {
      id: 'plan',
      config: { name: 'Plan' },
      workouts: [
        {
          id: 'future',
          date: '2026-09-12',
          status: 'planned',
          distanceKm: 4,
          title: 'Easy',
          description: 'Easy effort.',
        },
      ],
    } as Plan;
    getPlan.mockResolvedValue(plan);
    const value = snapshot();
    const db = await database({
      calendar_snapshot: value,
      calendar_settings: settings,
      'calendar_plan:plan': { planId: 'plan', calendarId: 'primary', enabled: true },
    });
    const event = (await calendarBridgeState(db)).desired[0];
    value.receipts = [
      {
        workoutId: event.workoutId,
        calendarId: event.calendarId,
        eventId: event.eventId,
        updatedAt: new Date().toISOString(),
        status: 'synced',
      },
    ];
    await importCalendar(db, value);
    expect((await planCalendarStatus(db, plan)).pending).toBe(1);
    value.receipts[0].fingerprint = event.fingerprint;
    await importCalendar(db, value);
    expect((await planCalendarStatus(db, plan)).pending).toBe(0);
    plan.workouts[0].distanceKm = 5;
    expect((await planCalendarStatus(db, plan)).pending).toBe(1);
  });
});
