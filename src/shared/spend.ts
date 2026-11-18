import { isoDate, isoWeek, weekRange } from './dates.ts';
import { bucketKey } from './period.ts';
import type { Frame } from './period.ts';
import type { ExpenseLock, FoodEvent } from './types.ts';

export const sumCents = (events: FoodEvent[]): number => events.reduce((a, e) => a + (e.cost_cents ?? 0), 0);

/** What a user paid on a local day; State events and GET /api/stats/spend both reduce to this. */
export interface PaidRow { day: string; user_id: number; cents: number }
export const paidRows = (events: FoodEvent[]): PaidRow[] => events.map(e => ({ day: isoDate(e.at), user_id: e.user_id, cents: e.cost_cents ?? 0 }));
export const sumRows = (rows: PaidRow[]): number => rows.reduce((a, r) => a + r.cents, 0);

/** One value per user: what they paid in the bar `key` (a day, or a month in a Year frame). */
export const bucketByUser = (rows: PaidRow[], users: { id: number }[], frame: Frame, key: string): number[] =>
  users.map(u => sumRows(rows.filter(r => r.user_id === u.id && bucketKey(frame, r.day) === key)));

export interface WeekGroup {
  period: string;
  label: string;
  totalCents: number;
  byUser: Map<number, number>;
  events: FoodEvent[];
  lock?: ExpenseLock;
}

export function groupExpensesByWeek(expenses: FoodEvent[], locks: ExpenseLock[], now: number | Date): WeekGroup[] {
  const lockMap = new Map(locks.map(l => [l.period, l]));
  const map = new Map<string, WeekGroup>();
  const ensure = (period: string): WeekGroup => {
    let g = map.get(period);
    if (!g) {
      g = {
        period,
        label: weekRange(period)?.label ?? period,
        totalCents: 0,
        byUser: new Map(),
        events: [],
        lock: lockMap.get(period),
      };
      map.set(period, g);
    }
    return g;
  };
  for (const e of [...expenses].sort((a, b) => b.at - a.at)) {
    const cents = e.cost_cents ?? 0;
    if (cents <= 0) continue;
    const g = ensure(isoWeek(e.at));
    g.totalCents += cents;
    g.byUser.set(e.user_id, (g.byUser.get(e.user_id) ?? 0) + cents);
    g.events.push(e);
  }
  for (const l of locks) {
    const g = ensure(l.period);
    if (!g.events.length && l.total_cents > 0) g.totalCents = l.total_cents;
  }
  if (!map.size) ensure(isoWeek(now));
  return [...map.values()].sort((a, b) => b.period.localeCompare(a.period));
}
