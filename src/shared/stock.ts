// The one place stock is computed. Server and web both use it, so they cannot disagree.
import { daysUntil, isoDate } from './dates.ts';
import { eventNutrition, eventValue } from './nutrition.ts';
import type { DailyNutrition, EventBody, EventLine, FoodEvent, Item, Kind, PendingOp, State, Unit } from './types.ts';

const round = (n: number): number => Math.round(n * 1000) / 1000;
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Stock as shown to people: never below zero. */
export const shown = (stock: number): number => Math.max(0, round(stock));

/** Split total level stock into the open container and sealed spares. */
export function levelParts(stock: number): { open: number; sealed: number } {
  if (stock <= 0) return { open: 0, sealed: 0 };
  const sealed = Math.max(0, Math.ceil(round(stock)) - 1);
  return { open: round(stock - sealed), sealed };
}

/** Name of an open container's level. */
export const levelName = (n: number): string => (n >= 1 ? 'full' : n >= 0.75 ? 'three quarters' : n >= 0.5 ? 'half' : n > 0 ? 'low' : 'out');

/** "half +1": the open level plus how many sealed spares. */
export const levelLabel = (stock: number): string => {
  const { open, sealed } = levelParts(stock);
  return `${levelName(open)}${sealed > 0 ? ` +${sealed}` : ''}`;
};

/** Replay one event line. A set line in an eat event changes only the open level container. */
export function nextStock(prev: number, line: EventLine, kind?: Kind): number {
  return round(line.is_set && kind === 'eat' ? levelParts(prev).sealed + line.qty
    : line.is_set ? line.qty : prev + line.qty);
}

/**
 * Stock per item from event lines given oldest first (order by at, then seq), undone events left out.
 * Set lines replace the running amount except an eat set line, which replaces only the open level amount.
 * The result is not floored: eating before the receipt is logged must still add up afterwards.
 */
export function computeStock(lines: Iterable<EventLine & { kind?: Kind }>): Map<number, number> {
  const stock = new Map<number, number>();
  for (const l of lines) stock.set(l.item_id, nextStock(stock.get(l.item_id) ?? 0, l, l.kind));
  return stock;
}

/** Turns a request body into stored lines. unitOf returns undefined for an unknown item, and that line is dropped. */
export function toLines(body: Pick<EventBody, 'kind' | 'lines'>, unitOf: (itemId: number) => Unit | undefined): EventLine[] {
  const out: EventLine[] = [];
  for (const l of body.lines) {
    const unit = unitOf(l.item_id);
    if (!unit) continue;
    const line: EventLine = body.kind === 'adjust' || (unit === 'level' && body.kind === 'eat')
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
  const bumpDaily = (day: string, user_id: number, dk: number, dp: number, df: number, dc: number | null, dv = 0, du = 0, dn = 0) => {
    if (!dk && !dp && !df && !dc && !dv && !du && !dn) return;
    const k = `${day}:${user_id}`;
    const cur = dailyMap.get(k);
    if (cur) { cur.kcal = Math.max(0, Math.round(cur.kcal + dk)); cur.protein_g = Math.max(0, round1(cur.protein_g + dp)); cur.fat_g = Math.max(0, round1((cur.fat_g ?? 0) + df)); if (dc != null) cur.carbs_g = Math.max(0, round1((cur.carbs_g ?? 0) + dc)); cur.value_cents = Math.max(0, cur.value_cents + dv); cur.unpriced = Math.max(0, cur.unpriced + du); cur.no_kcal = Math.max(0, cur.no_kcal + dn); }
    else if (dk > 0 || dp > 0 || df > 0 || (dc ?? 0) > 0 || dv > 0 || du > 0 || dn > 0) dailyMap.set(k, { day, user_id, kcal: Math.round(dk), protein_g: round1(dp), fat_g: round1(df), carbs_g: dc == null ? null : round1(dc), value_cents: dv, unpriced: du, no_kcal: dn });
  };

  for (const op of ops) {
    if (op.type === 'undo') {
      const ev = events.find(e => e.cid === op.cid);
      if (!ev) continue;
      // shortcut: a set line cannot be reversed locally (the earlier amount is unknown), the server's answer fixes it.
      for (const l of ev.lines) { const it = byId.get(l.item_id); if (it && !l.is_set) it.stock = round(it.stock - l.qty); }
      const n = eventNutrition(ev, items), v = eventValue(ev, items);
      bumpDaily(isoDate(ev.at), ev.user_id, -n.kcal, -n.protein_g, -n.fat_g, n.carbs_g == null ? null : -n.carbs_g, -v.value_cents, -v.unpriced, -v.no_kcal);
      events = events.filter(e => e.cid !== op.cid);
      expenses = expenses.filter(e => e.cid !== op.cid);
      continue;
    }
    const b = op.body;
    if (events.some(e => e.cid === b.cid)) continue;
    const lines = toLines(b, id => byId.get(id)?.unit);
    for (const l of lines) {
      const it = byId.get(l.item_id)!;
      it.stock = nextStock(it.stock, l, b.kind);
      if (b.kind === 'eat' && !l.is_set) {
        usual[l.item_id] = -l.qty;
        if (it.kcal_per_unit != null) l.kcal = Math.round(Math.abs(l.qty) * it.kcal_per_unit);
        if (it.protein_per_unit != null) l.protein_g = round1(Math.abs(l.qty) * it.protein_per_unit);
        if (it.fat_per_unit != null) l.fat_g = round1(Math.abs(l.qty) * it.fat_per_unit);
        if (it.carbs_per_unit != null) l.carbs_g = round1(Math.abs(l.qty) * it.carbs_per_unit);
      }
    }
    const ev: FoodEvent = {
      cid: b.cid, user_id: server.me.id, at: b.at, kind: b.kind,
      source: b.preset_id ? 'preset' : 'manual', note: b.note ?? null,
      preset_id: b.preset_id ?? null, cost_cents: b.cost_cents ?? null,
      counts_nutrition: true, lines,
    };
    const n = eventNutrition(ev, items), v = eventValue(ev, items);
    bumpDaily(isoDate(ev.at), ev.user_id, n.kcal, n.protein_g, n.fat_g, n.carbs_g, v.value_cents, v.unpriced, v.no_kcal);
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
