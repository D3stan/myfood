// The one place stock is computed. Server and web both use it, so they cannot disagree.
import type { EventBody, EventLine, FoodEvent, PendingOp, State, Unit } from './types.ts';

const round = (n: number): number => Math.round(n * 1000) / 1000;

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
    if (unit === 'level' || body.kind === 'adjust') out.push({ item_id: l.item_id, qty: l.qty, is_set: true });
    else out.push({ item_id: l.item_id, qty: body.kind === 'buy' ? l.qty : -l.qty, is_set: false });
  }
  return out;
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
  const usual = { ...server.usual };
  for (const op of ops) {
    if (op.type === 'undo') {
      const ev = events.find(e => e.cid === op.cid);
      if (!ev) continue;
      // shortcut: a set line cannot be reversed locally (the earlier amount is unknown), the server's answer fixes it.
      for (const l of ev.lines) { const it = byId.get(l.item_id); if (it && !l.is_set) it.stock = round(it.stock - l.qty); }
      events = events.filter(e => e.cid !== op.cid);
      continue;
    }
    const b = op.body;
    if (events.some(e => e.cid === b.cid)) continue;
    const lines = toLines(b, id => byId.get(id)?.unit);
    for (const l of lines) {
      const it = byId.get(l.item_id)!;
      it.stock = round(l.is_set ? l.qty : it.stock + l.qty);
      if (b.kind === 'eat' && !l.is_set) usual[l.item_id] = -l.qty;
    }
    const ev: FoodEvent = { cid: b.cid, user_id: server.me.id, at: b.at, kind: b.kind, source: b.preset_id ? 'preset' : 'manual', note: b.note ?? null, preset_id: b.preset_id ?? null, lines };
    events = [ev, ...events];
  }
  return { ...server, items, events, usual };
}

/** Running low: at or below low_at. An item with no threshold is low only when it is out. */
export const isLow = (i: { stock: number; low_at: number | null }): boolean => shown(i.stock) <= (i.low_at ?? 0);
