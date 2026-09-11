import { z } from 'zod';

export const KM_PER_MILE = 1.609344;
export const miles = (km: number) => Math.round((km / KM_PER_MILE) * 10000) / 10000;
export const distance = (km: number) =>
  `${Number((km / KM_PER_MILE).toFixed(2))} mi (${Number(km.toFixed(2))} km)`;
export function inputKm(value: unknown, unit: unknown, decimals = 2) {
  const selected = z.enum(['mi', 'km']).parse(unit ?? 'km');
  const numeric = z.coerce.number().finite().min(0).parse(value);
  const km = numeric * (selected === 'mi' ? KM_PER_MILE : 1);
  return Math.round(km * 10 ** decimals) / 10 ** decimals;
}
export function paceRange(min: number, max: number) {
  const clock = (seconds: number) => {
    const rounded = Math.round(seconds);
    return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
  };
  return `${clock(min * KM_PER_MILE)}–${clock(max * KM_PER_MILE)} /mi (${clock(min)}–${clock(max)} /km)`;
}
// Saved plans can contain older kilometer-only instructions.
export function distanceText(text: string) {
  return text.replace(/(\d+(?:\.\d+)?) km\b/g, (_, amount: string) => distance(Number(amount)));
}
