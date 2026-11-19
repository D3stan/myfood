// Stats for periods outside the 90-day window: fetched when a frame action lands on one, cached in ui.stats (never in State).
import { getItemDeals, getItemPrices, getStats } from '../api.ts';
import { needsStats, periodRange } from '../../shared/period.ts';
import type { Frame, Period } from '../../shared/period.ts';
import type { StatsMap } from '../../shared/types.ts';
import { store as s } from '../store.ts';
import type { Ui } from '../store.ts';
import { frameOf } from './components/frame.ts';

const KIND: Record<string, keyof StatsMap> = { spend: 'spend', me: 'nutrition' };
const keyOf = (p: Period): string => `${p.from}|${p.to}`;

/** What a screen draws from: `data` once fetched, `loading` while it is on its way, neither = use State (partial note). */
export function statsFor<K extends keyof StatsMap>(ui: Ui, kind: K, frame: Frame, p: Period, now: number | Date): { data: StatsMap[K] | null; loading: boolean } {
  if (!needsStats(frame, p, now)) return { data: null, loading: false };
  const hit = ui.stats[kind][keyOf(p)];
  return { data: hit ?? null, loading: hit === undefined && ui.online };
}

/** Called by the frame actions for screen key `k`; `redraw` re-renders when the answer is in. A past period is fetched once; the current one every time (it may have changed). */
export function loadStats(k: string, redraw: () => void): void {
  const kind = KIND[k];
  const fr = frameOf(s.ui, k), now = s.server?.now ?? Date.now(), p = periodRange(fr.frame, fr.offset, now);
  if (!kind || !s.ui.online || !needsStats(fr.frame, p, now)) return;
  const key = keyOf(p);
  if (fr.offset < 0 && key in s.ui.stats[kind]) return;
  getStats(kind, p.from, p.to)
    .then(d => { (s.ui.stats[kind] as Record<string, unknown>)[key] = d; })
    .catch(() => { if (!s.ui.stats[kind][key]) (s.ui.stats[kind] as Record<string, unknown>)[key] = null; })
    .finally(redraw);
}

/** Item sheet price history: shows the cached list at once, refreshes it on every open. */
export function loadPrices(id: number, redraw: () => void): void {
  if (!s.ui.online) return;
  getItemPrices(id).then(l => { s.ui.prices[id] = l; redraw(); }).catch(() => {});
  getItemDeals(id).then(d => { s.ui.deals[id] = d; redraw(); }).catch(() => {});
}
