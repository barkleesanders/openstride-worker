import { z } from 'zod';
import type { Plan, PlanConfig, Workout } from './types';
import { distance, distanceText, miles } from './units';

const DAY = 86_400_000;
const validDate = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(`${s}T00:00:00Z`)) &&
  new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s &&
  s >= '2000-01-01' &&
  s <= '2100-12-31';
export const planConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    goal: z.enum(['base', '5k', '10k', 'half', 'marathon']),
    startDate: z.string().refine(validDate, 'Use a real date between 2000 and 2100 (YYYY-MM-DD).'),
    weeks: z.number().int().min(4).max(24),
    currentWeeklyKm: z.number().finite().min(0).max(100).multipleOf(0.1),
    currentLongestKm: z.number().finite().min(0).max(100).multipleOf(0.1),
    days: z
      .array(z.number().int().min(1).max(7))
      .min(2)
      .max(6)
      .refine((d) => new Set(d).size === d.length, 'Choose distinct weekdays.'),
    longRunDay: z.number().int().min(1).max(7),
    intensity: z.enum(['gentle', 'balanced', 'challenging']),
    recent5kMinutes: z.number().finite().min(12).max(90).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (!v.days.includes(v.longRunDay))
      c.addIssue({
        code: 'custom',
        path: ['longRunDay'],
        message: 'Long run day must be a selected day.',
      });
    if (v.currentLongestKm > v.currentWeeklyKm)
      c.addIssue({
        code: 'custom',
        path: ['currentLongestKm'],
        message: 'Longest run cannot exceed weekly distance.',
      });
  });

/** Original, deliberately simple heuristics, not a clinically validated coaching model.
 * A race goal describes preparation, not a race entry or proof of readiness. The last
 * long session stays capped; we never insert a full race distance automatically.
 * Weeks are seven-day windows beginning on startDate, not calendar Mondays.
 * Distances are allocated in integer tenths to preserve the weekly budget exactly.
 */
export function generatePlan(input: PlanConfig, id: string, now = new Date().toISOString()): Plan {
  const config = planConfigSchema.parse(input);
  const { weeks, goal, currentWeeklyKm, currentLongestKm, intensity } = config;
  const warnings = [
    'Original rule-based guidance, not a validated coaching or medical program. Adjust or stop if a session is unsuitable.',
    'Race goals schedule preparation only. No race-distance workout or race entry is automatically added.',
  ];
  const beginner = currentWeeklyKm < 10;
  if (beginner)
    warnings.push(
      'Low or zero baseline: use comfortable run-walk intervals; distances are optional ceilings, not requirements.',
    );
  if (config.days.length >= 5)
    warnings.push(
      'Five or six selected days can create consecutive sessions. Replace sessions with rest when needed.',
    );
  const goalCap = { base: 16, '5k': 10, '10k': 14, half: 20, marathon: 30 }[goal];
  const readiness = { base: 0, '5k': 8, '10k': 15, half: 25, marathon: 40 }[goal];
  if (currentWeeklyKm < readiness)
    warnings.push(
      `Your baseline is below this engine's ${readiness} km/week preparation threshold for ${goal}. This plan does not establish race readiness; retain the conservative final session and consider more preparation time.`,
    );
  if (currentWeeklyKm > 0 && currentWeeklyKm < config.days.length * 0.1)
    warnings.push('Very small weekly distance: some selected days have no scheduled distance.');
  const rate = { gentle: 0.04, balanced: 0.06, challenging: 0.08 }[intensity];
  const start = Date.parse(`${config.startDate}T00:00:00Z`);
  const scheduled = Array.from({ length: 7 }, (_, offset) => ({
    offset,
    day: new Date(start + offset * DAY).getUTCDay() || 7,
  })).filter((x) => config.days.includes(x.day));
  const taperWeeks =
    goal === 'base' ? 0 : goal === 'marathon' || goal === 'half' ? Math.min(2, weeks - 2) : 1;
  let peakUnits = Math.round((currentWeeklyKm || 4) * 10);
  let longPeak = Math.round(
    (currentLongestKm || (currentWeeklyKm ? Math.min(currentWeeklyKm * 0.35, 2) : 1.6)) * 10,
  );
  if (currentWeeklyKm > 0 && longPeak / (config.days.length === 2 ? 0.5 : 0.4) < peakUnits)
    warnings.push(
      'Weekly volume is reduced because the longest-run baseline cannot support the selected schedule under this engine distance caps.',
    );
  const workouts: Workout[] = [];
  for (let week = 1; week <= weeks; week++) {
    const taper = week > weeks - taperWeeks;
    const recovery = !taper && week % 4 === 0;
    if (week > 1 && !recovery && !taper) {
      peakUnits = Math.min(1000, Math.floor(peakUnits * (1 + rate)));
      longPeak = Math.min(goalCap * 10, longPeak + Math.max(1, Math.floor(longPeak * rate)));
    }
    const taperFactor = taper ? (week === weeks ? 0.6 : 0.8) : 1;
    const longFraction = config.days.length === 2 ? 0.5 : 0.4;
    // Reduce total volume when a low longest-run baseline cannot support the split.
    const feasiblePeak = Math.min(
      peakUnits,
      Math.floor(Math.min(longPeak, goalCap * 10) / longFraction),
    );
    const units = Math.max(1, Math.floor(feasiblePeak * (recovery ? 0.8 : taperFactor)));
    const longIndex = scheduled.findIndex((x) => x.day === config.longRunDay);
    const longUnits = Math.min(
      Math.floor(units * (config.days.length === 2 ? 0.5 : 0.4)),
      goalCap * 10,
      Math.floor(longPeak * (recovery ? 0.8 : taperFactor)),
    );
    const allocation = scheduled.map(() => 0);
    allocation[longIndex] = longUnits;
    const others = scheduled.map((_, i) => i).filter((i) => i !== longIndex);
    const remaining = units - longUnits;
    others.forEach((index, i) => {
      allocation[index] =
        Math.floor(remaining / others.length) + (i < remaining % others.length ? 1 : 0);
    });
    const qualityIndex = others.find((i) => {
      const gap = Math.abs(scheduled[i].offset - scheduled[longIndex].offset);
      return gap >= 2 && gap <= 5;
    });
    scheduled.forEach(({ offset }, index) => {
      const distanceKm = allocation[index] / 10;
      if (!distanceKm) return;
      const date = new Date(start + ((week - 1) * 7 + offset) * DAY).toISOString().slice(0, 10);
      let type: Workout['type'] = beginner ? 'run-walk' : index === longIndex ? 'long' : 'easy';
      if (
        !beginner &&
        week > 2 &&
        !recovery &&
        !taper &&
        intensity !== 'gentle' &&
        config.days.length >= 3 &&
        index === qualityIndex &&
        distanceKm >= 4
      )
        type = week % 2 ? 'tempo' : 'intervals';
      const description =
        type === 'run-walk'
          ? 'Alternate short comfortable jogs with walking. Keep conversation easy; walk more or end early as needed.'
          : type === 'tempo'
            ? 'Total distance includes easy warm-up and cool-down (at least 1 km each). In the middle, up to one third of the total at controlled, comfortably hard effort. Never an all-out test.'
            : type === 'intervals'
              ? 'Total distance includes at least 1 km easy warm-up and 1 km cool-down. In the middle, alternate 1 minute brisk and 2 minutes easy, keeping brisk work below one quarter of the total. Finish easy.'
              : 'Keep an easy conversational effort throughout. Slower running and walking are welcome.';
      const workout: Workout = {
        id: `${id}-w${week}-d${offset}`,
        planId: id,
        date,
        week,
        type,
        title: `${index === longIndex && beginner ? 'Long run-walk' : { easy: 'Easy run', long: 'Long easy run', tempo: 'Controlled tempo', intervals: 'Short intervals', race: 'Race', 'run-walk': 'Run-walk' }[type]}${recovery ? ' · recovery week' : taper ? ' · taper' : ''}`,
        distanceKm,
        description,
        status: 'planned',
      };
      if (config.recent5kMinutes && !beginner) {
        const benchmark = (config.recent5kMinutes * 60) / 5;
        const extra = type === 'tempo' ? [20, 45] : type === 'intervals' ? [0, 20] : [60, 120];
        workout.paceMinSeconds = Math.round(benchmark + extra[0]);
        workout.paceMaxSeconds = Math.round(benchmark + extra[1]);
        workout.description +=
          ' Pace range is a rough starting guide for the main effort only; terrain, heat, and fatigue take priority.';
      }
      workouts.push(workout);
    });
  }
  return {
    id,
    createdAt: now,
    config,
    engineVersion: 'original-heuristic-1.0.0',
    warnings,
    workouts,
  };
}

const escapeIcs = (s: string) =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
// Fold by UTF-8 bytes (RFC5545), including the continuation space.
function fold(line: string): string {
  const lines: string[] = [];
  let part = '';
  let bytes = 0;
  for (const char of line) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    const size = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes + size > 75) {
      lines.push(part);
      part = ' ';
      bytes = 1;
    }
    part += char;
    bytes += size;
  }
  lines.push(part);
  return lines.join('\r\n');
}
export function toCalendar(plan: Plan): string {
  const stamp = new Date(plan.createdAt)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OpenStride//Training Plan//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  for (const w of plan.workouts) {
    const end = new Date(Date.parse(`${w.date}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${encodeURIComponent(w.id)}@openstride.local`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${w.date.replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${end.replace(/-/g, '')}`,
      `SUMMARY:${escapeIcs(`${w.title} · ${distance(w.distanceKm)}`)}`,
      `DESCRIPTION:${escapeIcs(`${distanceText(w.description)}\nStatus: ${w.status}${w.notes ? `\nNotes: ${w.notes}` : ''}`)}`,
      `STATUS:${w.status === 'skipped' ? 'CANCELLED' : 'CONFIRMED'}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
function csvCell(value: unknown): string {
  let s = String(value ?? '');
  // Neutralize spreadsheet formulas even after leading whitespace/control chars.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Control-prefix detection prevents spreadsheet formula injection.
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
export function toCsv(plan: Plan): string {
  const rows: unknown[][] = [
    [
      'date',
      'week',
      'type',
      'title',
      'distance_miles',
      'distance_km',
      'description',
      'status',
      'actual_miles',
      'actual_km',
      'actual_minutes',
      'effort',
      'notes',
    ],
  ];
  for (const w of plan.workouts)
    rows.push([
      w.date,
      w.week,
      w.type,
      w.title,
      miles(w.distanceKm),
      w.distanceKm,
      distanceText(w.description),
      w.status,
      w.actualKm === undefined ? undefined : miles(w.actualKm),
      w.actualKm,
      w.actualMinutes,
      w.effort,
      w.notes,
    ]);
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
