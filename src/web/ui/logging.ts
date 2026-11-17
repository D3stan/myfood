// Shared by the feature action modules: the item lookup, the sync pump, event logging and overdraw checks.
import { api } from '../api.ts';
import { flush } from '../outbox.ts';
import { enqueueEvent, receive, store as s } from '../store.ts';
import type { Sheet } from '../store.ts';
import { isLow, shown } from '../../shared/stock.ts';
import { fmtNum, nameKey, parseNum } from '../../shared/text.ts';
import type { Item, Kind, LineIn, PendingOp, State } from '../../shared/types.ts';
import { afterState, st, sync, toast } from './helpers.ts';

export const item = (id: unknown) => st().items.find(i => i.id === Number(id));
const sendOp = (op: PendingOp) => (op.type === 'event' ? api('POST', '/api/events', op.body) : api('DELETE', `/api/events/${op.cid}`));

export async function pump(): Promise<void> {
  const err = await flush(s, sendOp);
  if (err) toast(err);
  afterState();
}


export async function refresh(): Promise<void> {
  if (s.flushing) return;
  try { receive(s, await api('GET', '/api/state')); afterState(); } catch { /* offline: keep what we have */ }
}



/** Logs an event: shown at once, sent in the background, Undo in the toast. */
export function logged(kind: Kind, lines: LineIn[], msg: string, extra: { preset_id?: number; note?: string; cost_cents?: number } = {}): void {
  const cid = enqueueEvent(s, { kind, lines, ...extra });
  toast(msg, [cid]);
  sync();
  void pump();
}

export const presetLines = (ids: number[], q: Record<string, number>): LineIn[] =>
  ids.map(id => ({ item_id: id, qty: q[id] ?? 0 })).filter(l => l.qty > 0);

export const parseOptNum = (raw: string | undefined): number | null | 'invalid' => {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const n = parseNum(t);
  return Number.isNaN(n) ? 'invalid' : n;
};

export const resolveItemQty = (sh: Sheet, it: Item, q: number): number =>
  sh.portionMode && it.is_cooked && it.portion_g != null
    ? Math.round(q * it.portion_g * 1000) / 1000
    : q;

export const visibleLowItems = (v: State): Item[] =>
  v.items.filter(i => isLow(i) && (i.owner_id == null || i.owner_id === v.me.id));

export const findCreatedItem = (items: Item[], name: string, ownerId: number | null): Item | undefined =>
  items.find(i => nameKey(i.name) === nameKey(name) && i.owner_id === ownerId);

/** Builds a confirmation prompt when eating/consuming lines would take any item below zero, or null if all stay >= 0. */
export function overdrawWarning(v: State, lines: { item_id: number; qty: number }[]): string | null {
  const needed = new Map<number, number>();
  for (const l of lines) {
    if (!(l.qty > 0)) continue;
    needed.set(l.item_id, (needed.get(l.item_id) ?? 0) + l.qty);
  }
  const warnings: string[] = [];
  for (const [itemId, qty] of needed) {
    const it = v.items.find(i => i.id === itemId);
    if (!it || it.unit === 'level') continue;
    const after = Math.round((it.stock - qty) * 1000) / 1000;
    if (after >= 0) continue;
    const owed = shown(-after);
    if (it.stock > 0) {
      warnings.push(`${it.name} only has ${fmtNum(shown(it.stock))} ${it.unit} left (taking ${fmtNum(qty)} ${it.unit} will leave ${fmtNum(owed)} ${it.unit} owed)`);
    } else if (it.stock < 0) {
      warnings.push(`${it.name} is already out (${fmtNum(shown(-it.stock))} ${it.unit} owed; taking ${fmtNum(qty)} ${it.unit} will leave ${fmtNum(owed)} ${it.unit} owed)`);
    } else {
      warnings.push(`${it.name} is out of stock (taking ${fmtNum(qty)} ${it.unit} will leave ${fmtNum(owed)} ${it.unit} owed)`);
    }
  }
  if (!warnings.length) return null;
  if (warnings.length === 1) return `${warnings[0]}. Proceed anyway?`;
  return `This will overdraw:\n• ${warnings.join('\n• ')}\nProceed anyway?`;
}

export function confirmOverdraw(v: State, lines: { item_id: number; qty: number }[]): boolean {
  const msg = overdrawWarning(v, lines);
  return msg == null || (globalThis.confirm?.(msg) ?? true);
}

