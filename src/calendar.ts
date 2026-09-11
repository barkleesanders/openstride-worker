import { z } from 'zod';
import { ConflictError, getPlan } from './store';
import type { Plan, Workout } from './types';

const instant = z.string().datetime({ offset: true });
const zone = z
  .string()
  .max(80)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, 'Choose a valid IANA time zone.');
const calendarSchema = z
  .object({
    id: z.string().min(1).max(300),
    summary: z.string().max(200),
    timeZone: zone,
    accessRole: z.enum(['owner', 'writer', 'reader', 'freeBusyReader']),
    primary: z.boolean().optional(),
  })
  .strict();
const busySchema = z
  .object({ calendarId: z.string().max(300), start: instant, end: instant })
  .strict()
  .refine(
    (v) => Date.parse(v.end) > Date.parse(v.start),
    'Busy interval must end after it starts.',
  );
const receiptSchema = z
  .object({
    workoutId: z.string().max(150),
    eventId: z.string().max(150),
    calendarId: z.string().max(300),
    updatedAt: instant,
    status: z.enum(['synced', 'deleted', 'error']),
    scheduledStart: instant.optional(),
    scheduledEnd: instant.optional(),
    error: z.string().max(300).optional(),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const calendarImportSchema = z
  .object({
    calendars: z.array(calendarSchema).max(100),
    readCalendarIds: z.array(z.string().max(300)).max(100).default([]),
    rangeStart: instant,
    rangeEnd: instant,
    busy: z.array(busySchema).max(4000),
    syncedAt: instant,
    receipts: z.array(receiptSchema).max(2000),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      Date.parse(v.rangeEnd) <= Date.parse(v.rangeStart) ||
      Date.parse(v.rangeEnd) - Date.parse(v.rangeStart) > 190 * 86400000
    )
      c.addIssue({
        code: 'custom',
        message: 'Calendar range must be between one instant and 190 days.',
      });
    if (Date.parse(v.syncedAt) > Date.now() + 300000)
      c.addIssue({ code: 'custom', message: 'Calendar sync timestamp is in the future.' });
    const ids = new Set(v.calendars.map((x) => x.id));
    if (
      ids.size !== v.calendars.length ||
      v.busy.some(
        (x) =>
          !ids.has(x.calendarId) ||
          Date.parse(x.start) < Date.parse(v.rangeStart) ||
          Date.parse(x.end) > Date.parse(v.rangeEnd),
      )
    )
      c.addIssue({
        code: 'custom',
        message: 'Busy intervals must belong to the imported calendars and range.',
      });
  });
export const calendarSettingsSchema = z
  .object({
    readCalendarIds: z.array(z.string().min(1).max(300)).max(100),
    writeCalendarId: z.string().min(1).max(300).nullable(),
    timeZone: zone,
    windowStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    windowEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  })
  .strict()
  .refine(
    (v) => v.windowStart < v.windowEnd,
    'The running window must end after it starts, on the same day.',
  );
export type CalendarSettings = z.infer<typeof calendarSettingsSchema>;
export type CalendarSnapshot = z.infer<typeof calendarImportSchema>;
export type CalendarReceipt = z.infer<typeof receiptSchema>;
const subscriptionSchema = z.object({
  planId: z.string(),
  enabled: z.boolean(),
  calendarId: z.string(),
});
export type DesiredEvent = {
  workoutId: string;
  planId: string;
  calendarId: string;
  eventId: string;
  start: string;
  end: string;
  timeZone: string;
  summary: string;
  description: string;
  status: 'upsert' | 'delete';
  fingerprint: string;
};
async function read<T>(db: D1Database, id: string, schema: z.ZodType<T>): Promise<T | null> {
  const row = await db
    .prepare('SELECT value FROM connection WHERE id=?')
    .bind(id)
    .first<{ value: string }>();
  return row ? schema.parse(JSON.parse(row.value)) : null;
}
async function write(db: D1Database, id: string, value: unknown) {
  await db
    .prepare(
      'INSERT INTO connection(id,value,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
    )
    .bind(id, JSON.stringify(value), new Date().toISOString())
    .run();
}
export async function calendarState(db: D1Database) {
  const snapshot = await read(db, 'calendar_snapshot', calendarImportSchema);
  const primary = snapshot?.calendars.find((c) => c.primary);
  const settings = (await read(db, 'calendar_settings', calendarSettingsSchema)) ?? {
    readCalendarIds: primary ? [primary.id] : [],
    writeCalendarId: null,
    timeZone: primary?.timeZone ?? 'America/Los_Angeles',
    windowStart: '06:00',
    windowEnd: '21:00',
  };
  return { settings, snapshot };
}
export async function importCalendar(db: D1Database, input: unknown) {
  const snapshot = calendarImportSchema.parse(input);
  const previousRow = await db
    .prepare("SELECT value FROM connection WHERE id='calendar_snapshot'")
    .first<{ value: string }>();
  const old = previousRow ? calendarImportSchema.parse(JSON.parse(previousRow.value)) : null;
  if (old && Date.parse(snapshot.syncedAt) < Date.parse(old.syncedAt))
    throw new ConflictError('A newer calendar snapshot already exists.');
  const receipts = new Map<string, CalendarReceipt>();
  for (const receipt of [...(old?.receipts ?? []), ...snapshot.receipts]) {
    const key = JSON.stringify([receipt.calendarId, receipt.workoutId]);
    const previous = receipts.get(key);
    if (!previous || Date.parse(receipt.updatedAt) >= Date.parse(previous.updatedAt))
      receipts.set(key, receipt);
  }
  snapshot.receipts = [...receipts.values()]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 2000);
  const updated = previousRow
    ? await db
        .prepare(
          "UPDATE connection SET value=?,updated_at=? WHERE id='calendar_snapshot' AND value=? RETURNING id",
        )
        .bind(JSON.stringify(snapshot), snapshot.syncedAt, previousRow.value)
        .first()
    : await db
        .prepare(
          "INSERT INTO connection(id,value,updated_at) VALUES('calendar_snapshot',?,?) ON CONFLICT(id) DO NOTHING RETURNING id",
        )
        .bind(JSON.stringify(snapshot), snapshot.syncedAt)
        .first();
  if (!updated) throw new ConflictError('Another calendar sync completed concurrently. Retry.');
  return {
    syncedAt: snapshot.syncedAt,
    busyIntervals: snapshot.busy.length,
    calendars: snapshot.calendars.length,
  };
}
export async function saveCalendarSettings(db: D1Database, input: unknown) {
  const settings = calendarSettingsSchema.parse(input);
  const { snapshot, settings: old } = await calendarState(db);
  if (!snapshot)
    throw new ConflictError('Run the calendar bridge once before selecting calendars.');
  if (settings.readCalendarIds.some((id) => !snapshot.calendars.some((c) => c.id === id)))
    throw new ConflictError(
      'A selected calendar is no longer connected. Refresh the calendar list.',
    );
  if (
    settings.writeCalendarId &&
    !snapshot.calendars.some(
      (c) => c.id === settings.writeCalendarId && ['owner', 'writer'].includes(c.accessRole),
    )
  )
    throw new ConflictError('Choose a calendar you can write to.');
  if (settings.writeCalendarId !== old.writeCalendarId) {
    const subscriptions = await listSubscriptions(db);
    if (subscriptions.some((s) => s.enabled))
      throw new ConflictError(
        'Turn off calendar sync on existing plans before changing the destination.',
      );
  }
  await write(db, 'calendar_settings', settings);
  return settings;
}
async function listSubscriptions(db: D1Database) {
  const rows = await db
    .prepare("SELECT value FROM connection WHERE id LIKE 'calendar_plan:%' LIMIT 100")
    .all<{ value: string }>();
  return rows.results.map((r) => subscriptionSchema.parse(JSON.parse(r.value)));
}
export async function setPlanCalendar(db: D1Database, planId: string, enabled: boolean) {
  await getPlan(db, planId);
  const { settings, snapshot } = await calendarState(db);
  const old = await read(db, `calendar_plan:${planId}`, subscriptionSchema);
  if (
    enabled &&
    (!settings.writeCalendarId ||
      !snapshot ||
      Date.now() - Date.parse(snapshot.syncedAt) > 86400000)
  )
    throw new ConflictError(
      'Choose a writable calendar and refresh calendar sync before enabling this plan.',
    );
  const value = {
    planId,
    enabled,
    calendarId: enabled ? settings.writeCalendarId : old?.calendarId,
  };
  if (!value.calendarId) return { enabled: false };
  await write(db, `calendar_plan:${planId}`, value);
  return value;
}
function usableSnapshot(
  settings: CalendarSettings,
  snapshot: CalendarSnapshot | null,
): snapshot is CalendarSnapshot {
  return (
    !!snapshot &&
    Date.now() - Date.parse(snapshot.syncedAt) < 86400000 &&
    settings.readCalendarIds.length > 0 &&
    settings.readCalendarIds.length === snapshot.readCalendarIds.length &&
    settings.readCalendarIds.every((id) => snapshot.readCalendarIds.includes(id)) &&
    settings.readCalendarIds.every((id) => snapshot.calendars.some((c) => c.id === id))
  );
}
/** Convert a local wall-clock time with IANA timezone, rejecting DST gaps. */
export function zonedInstant(date: string, time: string, timeZone: string): number | null {
  const target = Date.parse(`${date}T${time}:00Z`);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(formatter.formatToParts(guess).map((x) => [x.type, x.value]));
    const actual = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    const delta = target - actual;
    if (delta === 0) return guess;
    guess += delta;
  }
  return null;
}
export function freeSlots(
  date: string,
  settings: CalendarSettings,
  snapshot: CalendarSnapshot,
  extra: Array<{ start: number; end: number }> = [],
) {
  const start = zonedInstant(date, settings.windowStart, settings.timeZone),
    end = zonedInstant(date, settings.windowEnd, settings.timeZone);
  if (
    start === null ||
    end === null ||
    start < Date.parse(snapshot.rangeStart) ||
    end > Date.parse(snapshot.rangeEnd)
  )
    return [];
  const busy = [
    ...snapshot.busy
      .filter((x) => settings.readCalendarIds.includes(x.calendarId))
      .map((x) => ({ start: Date.parse(x.start), end: Date.parse(x.end) })),
    ...extra,
  ]
    .filter((x) => x.start < end && x.end > start)
    .sort((a, b) => a.start - b.start);
  let cursor = start;
  const slots: Array<{ start: number; end: number }> = [];
  for (const b of busy) {
    if (b.start > cursor) slots.push({ start: cursor, end: Math.min(b.start, end) });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < end) slots.push({ start: cursor, end });
  return slots;
}
export function calendarContext(
  settings: CalendarSettings,
  snapshot: CalendarSnapshot | null,
  startDate: string,
  weeks: number,
) {
  const fresh = usableSnapshot(settings, snapshot);
  const days = Array.from({ length: weeks * 7 }, (_, i) =>
    new Date(Date.parse(`${startDate}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10),
  ).map((date) => {
    const slots = fresh && snapshot ? freeSlots(date, settings, snapshot) : [];
    const start = zonedInstant(date, settings.windowStart, settings.timeZone),
      end = zonedInstant(date, settings.windowEnd, settings.timeZone);
    const availableMinutes = slots.reduce((s, x) => s + (x.end - x.start) / 60000, 0);
    return {
      date,
      availableMinutes,
      busyMinutes: Math.max(0, ((end ?? 0) - (start ?? 0)) / 60000 - availableMinutes),
    };
  });
  const covered =
    fresh &&
    snapshot &&
    days.every((day) => {
      const start = zonedInstant(day.date, settings.windowStart, settings.timeZone),
        end = zonedInstant(day.date, settings.windowEnd, settings.timeZone);
      return (
        start !== null &&
        end !== null &&
        start >= Date.parse(snapshot.rangeStart) &&
        end <= Date.parse(snapshot.rangeEnd)
      );
    });
  return {
    connected: !!covered,
    timeZone: settings.timeZone,
    windowStart: startDate,
    windowEnd: days.at(-1)?.date ?? startDate,
    days: covered ? days : [],
  };
}
async function eventId(id: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
  return `os${Array.from(new Uint8Array(hash), (x) => x.toString(16).padStart(2, '0')).join('')}`;
}
export function workoutMinutes(workout: Workout): number {
  return Math.max(
    20,
    Math.ceil(workout.distanceKm * (workout.paceMaxSeconds ? workout.paceMaxSeconds / 60 : 9) + 10),
  );
}
export async function calendarBridgeState(db: D1Database) {
  const { settings, snapshot } = await calendarState(db);
  const subscriptions = await listSubscriptions(db);
  const desired: DesiredEvent[] = [];
  const conflicts: Array<{ planId: string; workoutId: string; date: string }> = [];
  const occupied: Array<{ start: number; end: number }> = [];
  const fresh =
    usableSnapshot(settings, snapshot) &&
    snapshot.calendars.some(
      (c) => c.id === settings.writeCalendarId && ['owner', 'writer'].includes(c.accessRole),
    );
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: settings.timeZone }).format(
    new Date(),
  );
  const roundedNow = Math.ceil(Date.now() / 300000) * 300000;
  for (const subscription of subscriptions) {
    const plan = await getPlan(db, subscription.planId);
    for (const workout of plan.workouts) {
      const id = await eventId(workout.id);
      const previous = snapshot?.receipts.find(
        (r) => r.workoutId === workout.id && r.calendarId === subscription.calendarId,
      );
      if (workout.status === 'completed' || workout.date < today) continue;
      if (
        subscription.enabled &&
        workout.status === 'planned' &&
        previous?.status === 'synced' &&
        previous.scheduledStart &&
        Date.parse(previous.scheduledStart) <= Date.now()
      )
        continue;
      if (!subscription.enabled || workout.status === 'skipped') {
        desired.push({
          workoutId: workout.id,
          planId: plan.id,
          calendarId: subscription.calendarId,
          eventId: previous?.eventId ?? id,
          fingerprint: '',
          start: `${workout.date}T00:00:00Z`,
          end: `${workout.date}T01:00:00Z`,
          timeZone: settings.timeZone,
          summary: '',
          description: '',
          status: 'delete',
        });
        continue;
      }
      if (workout.status !== 'planned' || workout.date < today) continue;
      const duration = workoutMinutes(workout) * 60000;
      const slot =
        fresh && snapshot
          ? freeSlots(workout.date, settings, snapshot, occupied).find(
              (s) => s.end - Math.max(s.start, roundedNow) >= duration,
            )
          : undefined;
      if (!slot) {
        conflicts.push({ planId: plan.id, workoutId: workout.id, date: workout.date });
        continue;
      }
      const start = Math.max(slot.start, roundedNow);
      if (start + duration > slot.end) {
        conflicts.push({ planId: plan.id, workoutId: workout.id, date: workout.date });
        continue;
      }
      occupied.push({ start, end: start + duration });
      desired.push({
        workoutId: workout.id,
        planId: plan.id,
        calendarId: subscription.calendarId,
        eventId: previous?.eventId ?? id,
        fingerprint: '',
        start: new Date(start).toISOString(),
        end: new Date(start + duration).toISOString(),
        timeZone: settings.timeZone,
        summary: `${workout.title} · ${workout.distanceKm} km`,
        description: `OpenStride: ${plan.config.name}\n${workout.description}`,
        status: 'upsert',
      });
    }
  }
  for (const event of desired) {
    const { fingerprint: _fingerprint, ...content } = event;
    event.fingerprint = (await eventId(JSON.stringify(content))).slice(2);
  }
  return { settings, desired, conflicts, receipts: snapshot?.receipts ?? [] };
}
export async function planCalendarStatus(db: D1Database, plan: Plan) {
  const sub = await read(db, `calendar_plan:${plan.id}`, subscriptionSchema);
  if (!sub) return { enabled: false };
  const { snapshot } = await calendarState(db);
  const bridge = await calendarBridgeState(db);
  const receipts =
    snapshot?.receipts.filter(
      (r) => r.calendarId === sub.calendarId && plan.workouts.some((w) => w.id === r.workoutId),
    ) ?? [];
  return {
    enabled: sub.enabled,
    syncedAt: receipts
      .filter((r) => r.status === 'synced')
      .map((r) => r.updatedAt)
      .sort()
      .at(-1),
    pending: bridge.desired.filter(
      (d) =>
        d.planId === plan.id &&
        !receipts.some(
          (r) =>
            r.workoutId === d.workoutId &&
            r.fingerprint === d.fingerprint &&
            r.status === (d.status === 'delete' ? 'deleted' : 'synced'),
        ),
    ).length,
    conflicts: bridge.conflicts.filter((x) => x.planId === plan.id).length,
  };
}
