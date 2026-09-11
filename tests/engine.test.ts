import { describe, expect, it } from 'vitest';
import { generatePlan, planConfigSchema, toCalendar, toCsv } from '../src/engine';
import type { PlanConfig } from '../src/types';

const config: PlanConfig = {
  name: 'Test',
  goal: '10k',
  startDate: '2028-02-28',
  weeks: 12,
  currentWeeklyKm: 20,
  currentLongestKm: 8,
  days: [1, 3, 6],
  longRunDay: 6,
  intensity: 'balanced',
};
const total = (p: ReturnType<typeof generatePlan>, week: number) =>
  Math.round(p.workouts.filter((w) => w.week === week).reduce((n, w) => n + w.distanceKm, 0) * 10);
describe('original plan engine', () => {
  it('rejects impossible dates, duplicate days, invalid volume and unknown properties', () => {
    for (const change of [
      { startDate: '2027-02-29' },
      { startDate: '2028-04-31' },
      { days: [1, 1] },
      { longRunDay: 2 },
      { currentLongestKm: 21 },
      { weeks: 25 },
      { surprise: true },
    ])
      expect(planConfigSchema.safeParse({ ...config, ...change }).success).toBe(false);
    expect(planConfigSchema.safeParse({ ...config, startDate: '2028-02-29' }).success).toBe(true);
  });
  it('uses UTC dates, stable IDs and configured weekdays including leap day', () => {
    const c = { ...config, days: [2, 4], longRunDay: 4 };
    const p = generatePlan(c, 'plan', '2028-01-01T00:00:00Z');
    expect(p.workouts[0].date).toBe('2028-02-29');
    expect(p.workouts[1].date).toBe('2028-03-02');
    expect(generatePlan(c, 'plan', p.createdAt)).toEqual(p);
    expect(new Set(p.workouts.map((w) => w.id)).size).toBe(p.workouts.length);
  });
  it('keeps bounded distances across goals, baselines and schedules', () => {
    for (const goal of ['base', '5k', '10k', 'half', 'marathon'] as const)
      for (const weekly of [0, 0.1, 4, 20, 100])
        for (const days of [
          [1, 6],
          [1, 3, 6],
          [1, 2, 3, 4, 5, 6],
        ]) {
          const p = generatePlan(
            {
              ...config,
              goal,
              weeks: 24,
              days,
              currentWeeklyKm: weekly,
              currentLongestKm: weekly * 0.4 === 0.04 ? 0 : Math.round(weekly * 4) / 10,
            },
            'x',
          );
          expect(p.workouts.length).toBeLessThanOrEqual(144);
          for (const w of p.workouts) {
            expect(w.distanceKm).toBeGreaterThan(0);
            expect(Number.isInteger(Math.round(w.distanceKm * 10))).toBe(true);
            expect(days).toContain(new Date(`${w.date}T00:00:00Z`).getUTCDay() || 7);
            expect(w.type).not.toBe('race');
            if (w.type === 'long')
              expect(w.distanceKm).toBeLessThanOrEqual(
                { base: 16, '5k': 10, '10k': 14, half: 20, marathon: 30 }[goal],
              );
          }
          for (let week = 1; week <= 24; week++) expect(total(p, week)).toBeLessThanOrEqual(1000);
        }
  });
  it('adds recovery, taper and modest peak progression', () => {
    const p = generatePlan(config, 'x');
    expect(total(p, 4)).toBeLessThan(total(p, 3));
    expect(total(p, 8)).toBeLessThan(total(p, 7));
    expect(total(p, 12)).toBeLessThan(total(p, 11));
    expect(total(p, 2)).toBeLessThanOrEqual(Math.floor(total(p, 1) * 1.06));
    expect(p.workouts.some((w) => w.type === 'tempo')).toBe(true);
  });
  it('provides beginner run-walk, warnings and benchmark-only paces', () => {
    const p = generatePlan(
      { ...config, goal: 'marathon', currentWeeklyKm: 0, currentLongestKm: 0 },
      'x',
    );
    expect(p.workouts.every((w) => w.type === 'run-walk' && !w.paceMinSeconds)).toBe(true);
    expect(p.warnings.some((w) => w.includes('readiness'))).toBe(true);
    expect(generatePlan(config, 'x').workouts.every((w) => !w.paceMinSeconds)).toBe(true);
    expect(
      generatePlan({ ...config, recent5kMinutes: 25 }, 'x').workouts.every(
        (w) => w.paceMinSeconds && w.paceMaxSeconds && w.paceMaxSeconds > w.paceMinSeconds,
      ),
    ).toBe(true);
  });
  it('reduces volume when longest-run baseline cannot support the weekly split', () => {
    const p = generatePlan(
      { ...config, currentWeeklyKm: 100, currentLongestKm: 2, days: [1, 6] },
      'x',
    );
    expect(total(p, 1)).toBe(40);
    expect(p.workouts.filter((w) => w.week === 1).every((w) => w.distanceKm <= 2)).toBe(true);
  });
  it('escapes CSV formulas and calendar injection with UTF8 line folding', () => {
    const p = generatePlan(config, 'plan\nINJECT', '2028-01-01T00:00:00Z');
    p.workouts[0].notes = '=HYPERLINK("bad")';
    p.workouts[0].title = `${'🏃'.repeat(50)}\r\nBEGIN:VEVENT;bad,yes`;
    const csv = toCsv(p);
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"');
    const ics = toCalendar(p);
    expect(ics.match(/BEGIN:VEVENT\r\n/g)?.length).toBe(p.workouts.length);
    expect(ics).toContain('DTSTART;VALUE=DATE:20280228');
    expect(ics).toContain('DTEND;VALUE=DATE:20280229');
    expect(ics).toContain('%0AINJECT');
    for (const line of ics.split('\r\n'))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(ics.replace(/\r\n /g, '')).toContain('\\nBEGIN:VEVENT\\;bad\\,yes');
  });
});
