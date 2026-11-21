// Time frames for the Me trend and Spend. Pure; day strings come from isoDate (rule 3).
import { MONTHS, addDays, isoDate, isoWeek, weekRange } from './dates.ts';

export type Frame = 'day' | 'week' | 'month' | 'year';
export interface Period { from: string; to: string; label: string; days: string[] }

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** State holds this many days of nutrition and expenses; older periods are partial or absent. */
export const WINDOW_DAYS = 90;

/** The frame's period: offset 0 = current, -1 = previous. `from`/`to` are inclusive ISO dates. */
export function periodRange(frame: Frame, offset: number, now: number | Date): Period {
  const t = now instanceof Date ? now : new Date(now);
  const y = t.getFullYear(), m = t.getMonth(), d = t.getDate();
  if (frame === 'day') {
    const day = new Date(y, m, d + offset);
    return { from: isoDate(day), to: isoDate(day), label: `${DOW[day.getDay()]} ${day.getDate()} ${MONTHS[day.getMonth()]}`, days: [isoDate(day)] };
  }
  if (frame === 'week') {
    const mon = new Date(y, m, d - ((t.getDay() + 6) % 7) + 7 * offset);
    const days = Array.from({ length: 7 }, (_, i) => isoDate(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i)));
    return { from: days[0]!, to: days[6]!, label: weekRange(isoWeek(mon))!.label, days };
  }
  if (frame === 'year') {
    const jan = new Date(y + offset, 0, 1), end = new Date(y + offset + 1, 0, 1);
    const days = Array.from({ length: Math.round((end.getTime() - jan.getTime()) / 86_400_000) }, (_, i) => isoDate(new Date(jan.getFullYear(), 0, i + 1)));
    return { from: days[0]!, to: days[days.length - 1]!, label: String(jan.getFullYear()), days };
  }
  const first = new Date(y, m + offset, 1);
  const len = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const days = Array.from({ length: len }, (_, i) => isoDate(new Date(first.getFullYear(), first.getMonth(), i + 1)));
  return { from: days[0]!, to: days[len - 1]!, label: `${MONTHS[first.getMonth()]} ${first.getFullYear()}`, days };
}

/** One chart bar per entry: a day, or a month in a Year frame. */
export const bucketKey = (frame: Frame, day: string): string => (frame === 'year' ? day.slice(0, 7) : day);
export function periodBuckets(frame: Frame, p: Period): { key: string; label: string }[] {
  if (frame === 'year') return Array.from({ length: 12 }, (_, i) => ({ key: `${p.from.slice(0, 4)}-${String(i + 1).padStart(2, '0')}`, label: 'JFMAMJJASOND'[i]! }));
  return p.days.map((d, i) => ({ key: d, label: frame === 'week' ? 'MTWTFSS'[i]! : String(i + 1) }));
}

/** First day the 90-day window covers. */
export const windowStart = (now: number | Date): string => addDays(now, -WINDOW_DAYS);

/** Does this period need the stats endpoint? Year always, others once they start before the window. */
export const needsStats = (frame: Frame, p: Period, now: number | Date): boolean => frame === 'year' || p.from < windowStart(now);

/** Can we step back (always, with `canFetch`), and is the shown period only partly inside the window? */
export function frameNav(frame: Frame, offset: number, now: number | Date, canFetch = false): { canPrev: boolean; partial: boolean } {
  const start = windowStart(now);
  return { canPrev: canFetch || periodRange(frame, offset - 1, now).to >= start, partial: needsStats(frame, periodRange(frame, offset, now), now) };
}
