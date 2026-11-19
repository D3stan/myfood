// Deal maths: pure functions, no DB, no clock. Callers pass `now` / `today`. Money is in minor units.
import { addDays, daysUntil, parseIsoDate } from './dates.ts';
import { nextStock } from './stock.ts';
import { DEFAULT_CURRENCY } from './currency.ts';
import { fmtCost } from './text.ts';
import type { Category, Kind } from './types.ts';

const DAY = 86_400_000;
const WINDOW_DAYS = 30;

export interface BurnLine { at: number; qty: number; is_set: boolean; kind?: Kind }

/**
 * Units eaten per day for one item, from its ledger lines (oldest first, undone events left out).
 * Sums every drop in stock (eat lines, downward adjust/set lines) in the last 30 days; buys never count.
 * Null when under 14 days of history or under 3 drops. Callers must leave out level items and cooked meals.
 */
export function burnRate(lines: BurnLine[], now: number): number | null {
  if (!lines.length) return null;
  const since = now - WINDOW_DAYS * DAY;
  const days = Math.min(WINDOW_DAYS, (now - lines[0]!.at) / DAY);
  let stock = 0, used = 0, drops = 0;
  for (const l of lines) {
    const next = nextStock(stock, { item_id: 0, qty: l.qty, is_set: l.is_set }, l.kind);
    if (next < stock && l.at >= since) { used += stock - next; drops++; }
    stock = next;
  }
  return days < 14 || drops < 3 ? null : used / days;
}

export interface Offer { store_id: string; valid_from: string; valid_to: string; unit_cents: number }
export interface Campaign { store_id: string; from: string; to: string; unit_cents: number }

/** Per store, merge offers whose date ranges overlap or touch (gap of at most 1 day); the campaign keeps the lowest price. */
export function campaigns(offers: Offer[]): Campaign[] {
  const sorted = [...offers].sort((a, b) => a.store_id.localeCompare(b.store_id) || a.valid_from.localeCompare(b.valid_from));
  const out: Campaign[] = [];
  for (const o of sorted) {
    const last = out[out.length - 1];
    if (last && last.store_id === o.store_id && o.valid_from <= addDays(last.to, 1)) {
      if (o.valid_to > last.to) last.to = o.valid_to;
      last.unit_cents = Math.min(last.unit_cents, o.unit_cents);
    } else out.push({ store_id: o.store_id, from: o.valid_from, to: o.valid_to, unit_cents: o.unit_cents });
  }
  return out;
}

/** Expected days between campaigns: a prior worth 2 observations, pulled toward the observed gaps. Starts are across all stores. */
export function promoCadence(campaignStarts: string[], category: Category): number {
  const mu = category === 'dairy' || category === 'bakery' || category === 'produce' ? 14 : category === 'meat' ? 18 : 28;
  const starts = [...new Set(campaignStarts)].sort();
  let sum = 0;
  for (let i = 1; i < starts.length; i++) sum += daysUntil(starts[i]!, parseIsoDate(starts[i - 1]!)!);
  return (2 * mu + sum) / (2 + Math.max(0, starts.length - 1));
}

export interface StockUpIn {
  stock: number;
  lowAt: number | null;
  /** Units per day, null when unknown. */
  rate: number | null;
  /** Usual price per unit; null = unknown, treated as no discount. */
  normalCents: number | null;
  offerUnitCents: number;
  qtyPerPack: number;
  maxPerCustomer: number | null;
  cadenceDays: number;
  shelfLifeDays: number | null;
  /** Days until a cheaper offer is expected, if one is known. */
  nextCheaperInDays: number | null;
  /** For the reason text; default DKK. */
  currency?: string;
}
export interface StockUpOut { packs: number; units: number; horizonDays: number; pctOff: number; reason: string }

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** How many packs to buy on this offer. Zero when stock already covers the horizon. */
export function stockUp(i: StockUpIn): StockUpOut {
  const qty = i.qtyPerPack > 0 ? i.qtyPerPack : 1;
  const money = (cents: number) => fmtCost(Math.round(cents), i.currency ?? DEFAULT_CURRENCY);
  const delta = i.normalCents && i.normalCents > 0 ? Math.max(0, (i.normalCents - i.offerUnitCents) / i.normalCents) : 0;
  const pctOff = Math.round(delta * 100);
  const none = (horizonDays: number, reason: string): StockUpOut => ({ packs: 0, units: 0, horizonDays, pctOff, reason });
  const done = (packs: number, horizonDays: number, covers: string): StockUpOut => {
    const capped = i.maxPerCustomer != null ? Math.min(packs, i.maxPerCustomer) : packs;
    const parts = [`${capped} pack${capped === 1 ? '' : 's'}`, `${money(i.offerUnitCents * qty)} per pack`];
    if (pctOff > 0) parts.push(`${pctOff}% under usual`);
    parts.push(covers);
    return { packs: capped, units: capped * qty, horizonDays, pctOff, reason: parts.join(' · ') };
  };

  if (i.rate == null) {
    return i.stock <= (i.lowAt ?? 0)
      ? done(1, 0, 'low and on offer')
      : none(0, 'enough in stock');
  }
  let h = delta < 0.1 ? 7 : i.cadenceDays * clamp(0.8 + 1.5 * delta, 0.75, 1.35);
  h = Math.min(h, i.shelfLifeDays ?? 60, 60);
  if (i.nextCheaperInDays != null) h = Math.min(h, i.nextCheaperInDays);
  const need = i.rate * h - i.stock;
  if (need <= 0) return none(h, `stock already covers ~${Math.round(h)} days`);
  const packs = Math.ceil(need / qty);
  const buying = i.maxPerCustomer != null ? Math.min(packs, i.maxPerCustomer) : packs;
  return done(packs, h, `covers ~${Math.round((i.stock + buying * qty) / i.rate)} days`);
}

export interface Need { item_id: number; deadlineDay: number | null; units: number; normalCents: number | null }
export interface TripOffer extends Offer { item_id: number }
export interface Trip {
  day: number;
  date: string;
  store_id: string;
  items: { item_id: number; unit_cents: number; saving_cents: number }[];
  saving_cents: number;
}

/**
 * Best one or two shopping trips. Saving of an item on a trip = units x (normal - best live price at that store that day).
 * An item whose deadline is before the trip day saves nothing on it. If any need is due today, the first trip is today
 * (when no trip today saves anything, that rule is dropped). A second trip is kept only if it adds at least tripCostCents.
 * Each item goes to the trip where it saves most.
 */
export function planTrips(
  { needs, offers, today, tripCostCents = 2500 }: { needs: Need[]; offers: TripOffer[]; today: string; tripCostCents?: number },
): { trips: Trip[]; total_saving_cents: number } {
  const last = offers.reduce((m, o) => (o.valid_to > m ? o.valid_to : m), today);
  const horizon = Math.max(0, daysUntil(last, parseIsoDate(today)!));
  const stores = [...new Set(offers.map(o => o.store_id))].sort();
  const cands: Trip[] = [];
  for (let day = 0; day <= horizon; day++) {
    const date = addDays(today, day);
    for (const store_id of stores) {
      const items: Trip['items'] = [];
      for (const n of needs) {
        if (n.deadlineDay != null && n.deadlineDay < day) continue;
        const live = offers.filter(o => o.item_id === n.item_id && o.store_id === store_id && o.valid_from <= date && date <= o.valid_to);
        if (!live.length) continue;
        const unit_cents = Math.min(...live.map(o => o.unit_cents));
        const saving_cents = n.normalCents == null ? 0 : n.units * Math.max(0, n.normalCents - unit_cents);
        // an item due today rides along even with no known saving: it must be bought anyway
        if (saving_cents > 0 || n.deadlineDay === 0) items.push({ item_id: n.item_id, unit_cents, saving_cents });
      }
      if (items.length) cands.push({ day, date, store_id, items, saving_cents: items.reduce((s, x) => s + x.saving_cents, 0) });
    }
  }
  const best = (list: Trip[]): Trip | undefined => list.reduce<Trip | undefined>((b, t) => (!b || t.saving_cents > b.saving_cents || (t.saving_cents === b.saving_cents && t.items.length > b.items.length) ? t : b), undefined);
  const dueToday = needs.some(n => n.deadlineDay === 0);
  const first = (dueToday ? best(cands.filter(t => t.day === 0)) : undefined) ?? best(cands);
  if (!first) return { trips: [], total_saving_cents: 0 };

  // Add the second trip with the largest gain; each item moves to whichever trip saves it more.
  let pair: { a: Trip; b: Trip; gain: number } | undefined;
  for (const c of cands) {
    if (c === first) continue;
    const mine = new Map(c.items.map(x => [x.item_id, x]));
    const theirs = new Map(first.items.map(x => [x.item_id, x]));
    const a: Trip['items'] = [], b: Trip['items'] = [];
    for (const id of new Set([...mine.keys(), ...theirs.keys()])) {
      const x = mine.get(id), y = theirs.get(id);
      if (x && (!y || x.saving_cents > y.saving_cents)) b.push(x); else a.push(y!);
    }
    const sum = (l: Trip['items']) => l.reduce((s, x) => s + x.saving_cents, 0);
    const gain = sum(a) + sum(b) - first.saving_cents;
    if (a.length && b.length && gain >= tripCostCents && (!pair || gain > pair.gain)) {
      pair = { a: { ...first, items: a, saving_cents: sum(a) }, b: { ...c, items: b, saving_cents: sum(b) }, gain };
    }
  }
  const trips = (pair ? [pair.a, pair.b] : [first]).sort((x, y) => x.day - y.day);
  return { trips, total_saving_cents: trips.reduce((s, t) => s + t.saving_cents, 0) };
}

/** "Today", "Tomorrow", else the weekday ("Sat") of a YYYY-MM-DD date. */
export function tripDay(date: string, today: string): string {
  const n = daysUntil(date, parseIsoDate(today)!);
  return n <= 0 ? 'Today' : n === 1 ? 'Tomorrow' : parseIsoDate(date)!.toLocaleDateString('en-GB', { weekday: 'short' });
}
