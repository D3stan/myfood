// The one place stock is computed. Server and web both use it, so they cannot disagree.
import { daysUntil, isoDate } from './dates.ts';
import type { DailyNutrition, EventBody, EventLine, FoodEvent, Item, PendingOp, State, Unit } from './types.ts';

const round = (n: number): number => Math.round(n * 1000) / 1000;
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Stock as shown to people: never below zero. */
export const shown = (stock: number): number => Math.max(0, round(stock));

/**
 * Stock per item from event lines given oldest first (order by at, then seq), undone events left out.
 * A set line replaces the running amount; any other line adds its signed qty.
 * The result is not floored: eating before the receipt is logged must still add up afterwards.
 */
export function computeStock(lines: Iterable<EventLine>): Map<number, number> {
  const stock = new Map<number, number>();
  for (const l of lines) stock.set(l.item_id, round(l.is_set ? l.qty : (stock.get(l.item_id) ?? 0) + l.qty));
  return stock;
}

/** Turns a request body into stored lines. unitOf returns undefined for an unknown item, and that line is dropped. */
export function toLines(body: Pick<EventBody, 'kind' | 'lines'>, unitOf: (itemId: number) => Unit | undefined): EventLine[] {
  const out: EventLine[] = [];
  for (const l of body.lines) {
    const unit = unitOf(l.item_id);
    if (!unit) continue;
    const line: EventLine = unit === 'level' || body.kind === 'adjust'
      ? { item_id: l.item_id, qty: l.qty, is_set: true }
      : { item_id: l.item_id, qty: body.kind === 'buy' ? l.qty : -l.qty, is_set: false };
    if (l.cost_cents != null) line.cost_cents = l.cost_cents;
    if (l.expires_at != null) line.expires_at = l.expires_at;
    out.push(line);
  }
  return out;
}

/** Number of portions for a cooked meal or portion-unit item; null when not portion-tracked. */
export function portionCount(item: Pick<Item, 'unit' | 'portion_g'>, stock: number): number | null {
  if (item.unit === 'portion') return round(stock);
  if (item.unit === 'g' && item.portion_g && item.portion_g > 0) return round(stock / item.portion_g);
  return null;
}

/** Calories and protein for one event line (explicit snapshot first, else item rate). */
export function eventLineNutrition(
  line: EventLine,
  item?: Pick<Item, 'kcal_per_unit' | 'protein_per_unit'>,
): { kcal: number; protein_g: number } {
  const q = Math.abs(line.qty);
  const kcal = line.kcal != null ? line.kcal : (item?.kcal_per_unit != null ? q * item.kcal_per_unit : 0);
  const protein_g = line.protein_g != null ? line.protein_g : (item?.protein_per_unit != null ? q * item.protein_per_unit : 0);
  return { kcal: Math.round(kcal), protein_g: round1(protein_g) };
}

/** Calories and protein contributed by an event (only non-cook eat events count). */
export function eventNutrition(
  ev: Pick<FoodEvent, 'kind' | 'counts_nutrition' | 'lines'>,
  items: Pick<Item, 'id' | 'kcal_per_unit' | 'protein_per_unit'>[],
): { kcal: number; protein_g: number } {
  if (ev.kind !== 'eat' || !ev.counts_nutrition) return { kcal: 0, protein_g: 0 };
  const byId = new Map(items.map(i => [i.id, i]));
  let kcal = 0, protein_g = 0;
  for (const l of ev.lines) {
    const n = eventLineNutrition(l, byId.get(l.item_id));
    kcal += n.kcal;
    protein_g += n.protein_g;
  }
  return { kcal: Math.round(kcal), protein_g: round1(protein_g) };
}

/** Merges server daily nutrition totals with pending unconfirmed eat/undo ops, or aggregates events directly. */
export function computeDailyNutrition(
  events: FoodEvent[],
  items: Pick<Item, 'id' | 'kcal_per_unit' | 'protein_per_unit'>[],
  serverDaily: DailyNutrition[] = [],
): DailyNutrition[] {
  const map = new Map<string, DailyNutrition>();
  const add = (day: string, user_id: number, kcal: number, protein_g: number) => {
    const k = `${day}:${user_id}`;
    const cur = map.get(k);
    if (cur) { cur.kcal = Math.max(0, Math.round(cur.kcal + kcal)); cur.protein_g = Math.max(0, round1(cur.protein_g + protein_g)); }
    else map.set(k, { day, user_id, kcal: Math.max(0, Math.round(kcal)), protein_g: Math.max(0, round1(protein_g)) });
  };
  if (serverDaily.length) {
    for (const d of serverDaily) add(d.day, d.user_id, d.kcal, d.protein_g);
  } else {
    for (const ev of events) {
      const n = eventNutrition(ev, items);
      if (n.kcal > 0 || n.protein_g > 0) add(isoDate(ev.at), ev.user_id, n.kcal, n.protein_g);
    }
  }
  return [...map.values()].sort((a, b) => (a.day === b.day ? a.user_id - b.user_id : b.day.localeCompare(a.day)));
}

/**
 * The state to show: what the server last said, plus the operations it has not confirmed yet.
 * Pure; returns a new state. An op whose cid the server already lists is skipped.
 */
export function applyOps(server: State, ops: PendingOp[]): State {
  if (!ops.length) return server;
  const items = server.items.map(i => ({ ...i }));
  const byId = new Map(items.map(i => [i.id, i]));
  let events = server.events.slice();
  let expenses = server.expenses.slice();
  const usual = { ...server.usual };
  const dailyMap = new Map<string, DailyNutrition>(
    server.daily_nutrition.map(d => [`${d.day}:${d.user_id}`, { ...d }]),
  );
  const bumpDaily = (day: string, user_id: number, dk: number, dp: number) => {
    if (!dk && !dp) return;
    const k = `${day}:${user_id}`;
    const cur = dailyMap.get(k);
    if (cur) { cur.kcal = Math.max(0, Math.round(cur.kcal + dk)); cur.protein_g = Math.max(0, round1(cur.protein_g + dp)); }
    else if (dk > 0 || dp > 0) dailyMap.set(k, { day, user_id, kcal: Math.round(dk), protein_g: round1(dp) });
  };

  for (const op of ops) {
    if (op.type === 'undo') {
      const ev = events.find(e => e.cid === op.cid);
      if (!ev) continue;
      // shortcut: a set line cannot be reversed locally (the earlier amount is unknown), the server's answer fixes it.
      for (const l of ev.lines) { const it = byId.get(l.item_id); if (it && !l.is_set) it.stock = round(it.stock - l.qty); }
      const n = eventNutrition(ev, items);
      bumpDaily(isoDate(ev.at), ev.user_id, -n.kcal, -n.protein_g);
      events = events.filter(e => e.cid !== op.cid);
      expenses = expenses.filter(e => e.cid !== op.cid);
      continue;
    }
    const b = op.body;
    if (events.some(e => e.cid === b.cid)) continue;
    const lines = toLines(b, id => byId.get(id)?.unit);
    for (const l of lines) {
      const it = byId.get(l.item_id)!;
      it.stock = round(l.is_set ? l.qty : it.stock + l.qty);
      if (b.kind === 'eat' && !l.is_set) {
        usual[l.item_id] = -l.qty;
        if (it.kcal_per_unit != null) l.kcal = Math.round(Math.abs(l.qty) * it.kcal_per_unit);
        if (it.protein_per_unit != null) l.protein_g = round1(Math.abs(l.qty) * it.protein_per_unit);
      }
    }
    const ev: FoodEvent = {
      cid: b.cid, user_id: server.me.id, at: b.at, kind: b.kind,
      source: b.preset_id ? 'preset' : 'manual', note: b.note ?? null,
      preset_id: b.preset_id ?? null, cost_cents: b.cost_cents ?? null,
      counts_nutrition: true, lines,
    };
    const n = eventNutrition(ev, items);
    bumpDaily(isoDate(ev.at), ev.user_id, n.kcal, n.protein_g);
    events = [ev, ...events];
    if (ev.cost_cents != null) expenses = [ev, ...expenses];
  }
  const daily_nutrition = [...dailyMap.values()].sort((a, b) => (a.day === b.day ? a.user_id - b.user_id : b.day.localeCompare(a.day)));
  return { ...server, items, events, expenses, usual, daily_nutrition };
}

/** Running low: at or below low_at. An item with no threshold is low only when it is out. */
export const isLow = (i: { stock: number; low_at: number | null }): boolean => shown(i.stock) <= (i.low_at ?? 0);

/** Expiring soon: in stock and expires within `days` calendar days (default 3). */
export const isExpiringSoon = (i: { stock: number; expires_at: string | null }, now = Date.now(), days = 3): boolean =>
  shown(i.stock) > 0 && i.expires_at != null && daysUntil(i.expires_at, now) <= days;
