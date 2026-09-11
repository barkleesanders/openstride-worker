import { describe, expect, it } from 'vitest';
import { distance, distanceText, inputKm, miles, paceRange } from '../src/units';

describe('miles first, canonical kilometers', () => {
  it('converts distances both ways without changing saved tenth-km plan baselines', () => {
    expect(inputKm(1, 'mi')).toBe(1.61);
    expect(inputKm(5, 'km')).toBe(5);
    for (let tenth = 0; tenth <= 1000; tenth++) {
      expect(inputKm(miles(tenth / 10), 'mi', 1)).toBe(tenth / 10);
    }
    expect(() => inputKm(10, 'invalid')).toThrow();
    expect(() => inputKm(-1, 'mi')).toThrow();
  });
  it('shows imperial distance and pace first, with metric equivalents and correct minute rollover', () => {
    expect(distance(5)).toBe('3.11 mi (5 km)');
    expect(distanceText('At least 1 km easy.')).toBe('At least 0.62 mi (1 km) easy.');
    expect(paceRange(300, 360)).toBe('8:03–9:39 /mi (5:00–6:00 /km)');
    expect(paceRange(359.9, 420)).toContain('(6:00–7:00 /km)');
  });
});
