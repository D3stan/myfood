// Time frames for the Me trend and Spend. Pure; day strings come from isoDate (rule 3).
import { MONTHS, addDays, isoDate, isoWeek, weekRange } from './dates.ts';

export type Frame = 'week' | 'month';
export interface Period { from: string; to: string; label: string; days: string[] }

/** State holds this many days of nutrition and expenses; older periods are partial or absent. */
export const WINDOW_DAYS = 90;

/** The frame's period: offset 0 = current, -1 = previous. `from`/`to` are inclusive ISO dates. */
export function periodRange(frame: Frame, offset: number, now: number | Date): Period {
  const t = now instanceof Date ? now : new Date(now);
  const y = t.getFullYear(), m = t.getMonth(), d = t.getDate();
  if (frame === 'week') {
    const mon = new Date(y, m, d - ((t.getDay() + 6) % 7) + 7 * offset);
    const days = Array.from({ length: 7 }, (_, i) => isoDate(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i)));
    return { from: days[0]!, to: days[6]!, label: weekRange(isoWeek(mon))!.label, days };
  }
  const first = new Date(y, m + offset, 1);
  const len = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const days = Array.from({ length: len }, (_, i) => isoDate(new Date(first.getFullYear(), first.getMonth(), i + 1)));
  return { from: days[0]!, to: days[len - 1]!, label: `${MONTHS[first.getMonth()]} ${first.getFullYear()}`, days };
}

/** First day the 90-day window covers. */
export const windowStart = (now: number | Date): string => addDays(now, -WINDOW_DAYS);

/** Can we step back, and is the shown period only partly inside the window? */
export function frameNav(frame: Frame, offset: number, now: number | Date): { canPrev: boolean; partial: boolean } {
  const start = windowStart(now);
  return { canPrev: periodRange(frame, offset - 1, now).to >= start, partial: periodRange(frame, offset, now).from < start };
}
