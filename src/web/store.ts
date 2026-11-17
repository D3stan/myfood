// One store, plain data. What is shown is always applyOps(server, pending).
// Functions take the store as their first argument so they can be tested without a DOM.
import { applyOps } from '../shared/stock.ts';
import type { Frame } from '../shared/period.ts';
import type { AiCook, AiEvent, BarcodeLookup, EventBody, JobMode, PendingOp, State } from '../shared/types.ts';

export type Tab = 'pantry' | 'spend' | 'history' | 'me';

export interface Sheet {
  t: 'item' | 'preset' | 'presetEdit' | 'itemForm' | 'compose' | 'review' | 'event' | 'cook' | 'barcode' | 'expense';
  id?: number | string;
  /** Quantities being edited, keyed by item id ("main" in the item sheet). Review lines live in `events`. */
  q: Record<string, number>;
  /** presetEdit: the item ids on the preset, in order. */
  lines?: number[];
  /** review: the proposal being edited, and the untouched copy (to switch a line back to "new"). */
  events?: AiEvent[];
  orig?: AiEvent[];
  cook?: AiCook[];
  origCook?: AiCook[];
  /** compose: job mode ('auto' | 'receipt' | 'audit'). */
  mode?: JobMode;
  /** item: true = step in portions when item has portion_g, false = step in grams. */
  portionMode?: boolean;
  /** cook: ingredient lines being prepared. */
  ingredients?: { item_id: number; qty: number }[];
  more?: boolean;
  /** item: the typed "set exact amount" field is open. */
  exact?: boolean;
  busy?: boolean;
}

export interface Ui {
  tab: Tab;
  /** Pushed pages (settings and its subpages); empty = show the tab. */
  page: string[];
  sheet: Sheet | null;
  /** Text fields by name. Survives re-renders and polls. */
  f: Record<string, string>;
  /** Key of the stepper number that is currently a text field. */
  editing: string | null;
  toast: { id: number; msg: string; cids?: string[] } | null;
  online: boolean;
  loggedOut: boolean;
  standalone: boolean;
  files: { file: File; url: string }[];
  seenDone: Set<number>;
  ownerFilter: 'all' | 'mine' | 'shared';
  historyScope: 'me' | 'all';
  /** Time-frame selector state per screen key ("me", "spend"); missing = week, current. */
  frames: Record<string, { frame: Frame; offset: number }>;
  jobMode: JobMode;
  barcodeLookup: BarcodeLookup | null;
  barcodeBusy: boolean;
  scannerActive: boolean;
  scannerSupported: boolean;
  newToken: string | null;
  pushSupported: boolean;
  pushPermission: NotificationPermission | 'unsupported';
}

export interface Store {
  server: State | null;
  pending: PendingOp[];
  /** cids of event ops being sent right now; an undo cannot simply cancel those. */
  inflight: Set<string>;
  flushing: boolean;
  ui: Ui;
}

export const newStore = (server: State | null = null, pending: PendingOp[] = []): Store => ({
  server, pending, inflight: new Set(), flushing: false,
  ui: {
    tab: 'pantry', page: [], sheet: null, f: {}, editing: null, toast: null,
    online: true, loggedOut: false, standalone: true, files: [], seenDone: new Set(),
    ownerFilter: 'all', historyScope: 'me', frames: {}, jobMode: 'auto',
    barcodeLookup: null, barcodeBusy: false, scannerActive: false, scannerSupported: false,
    newToken: null, pushSupported: false, pushPermission: 'default',
  },
});

export const store: Store = newStore();

export const view = (s: Store): State | null => (s.server ? applyOps(s.server, s.pending) : null);

/** Takes a server answer. Returns false when it is older than what we hold. */
export function receive(s: Store, st: State): boolean {
  if (s.server && st.rev < s.server.rev) return false;
  s.server = st;
  s.ui.loggedOut = false;
  const onServer = new Set(st.events.map(e => e.cid));
  const queued = new Set(s.pending.flatMap(o => (o.type === 'event' ? [o.body.cid] : [])));
  // An event op is confirmed once the server lists it; an undo op once the event is gone (unless the event itself is still queued).
  s.pending = s.pending.filter(o => (o.type === 'event' ? !onServer.has(o.body.cid) : onServer.has(o.cid) || queued.has(o.cid)));
  pruneSheet(s);
  return true;
}

export const dropOp = (s: Store, op: PendingOp): void => { s.pending = s.pending.filter(o => o !== op); };

export function enqueueEvent(s: Store, e: Omit<EventBody, 'cid' | 'at'>, at = Date.now()): string {
  const cid = crypto.randomUUID();
  s.pending.push({ type: 'event', body: { ...e, cid, at } });
  pruneSheet(s);
  return cid;
}

/** Undoing an event that has not left the phone yet just cancels it. */
export function enqueueUndo(s: Store, cid: string): void {
  const own = s.pending.find(o => o.type === 'event' && o.body.cid === cid);
  if (own && !s.inflight.has(cid)) dropOp(s, own);
  else if (!s.pending.some(o => o.type === 'undo' && o.cid === cid)) s.pending.push({ type: 'undo', cid });
  pruneSheet(s);
}

export function openSheet(s: Store, sheet: Sheet, fields: Record<string, string> = {}): void {
  s.ui.sheet = sheet;
  s.ui.editing = null;
  s.ui.f = { ...s.ui.f, ...fields };
}

export function closeSheet(s: Store): void {
  s.ui.sheet = null;
  s.ui.editing = null;
  s.ui.barcodeLookup = null;
  s.ui.barcodeBusy = false;
  s.ui.scannerActive = false;
}

/** Closes a sheet whose subject no longer exists (archived item, undone event, applied job). */
export function pruneSheet(s: Store): void {
  const sh = s.ui.sheet, v = view(s);
  if (!sh || !v) return;
  const gone = sh.t === 'item' ? !v.items.some(i => i.id === sh.id)
    : sh.t === 'event' ? !v.events.some(e => e.cid === sh.id)
    : sh.t === 'preset' ? !v.presets.some(p => p.id === sh.id)
    : sh.t === 'review' ? v.jobs.find(j => j.id === sh.id)?.status !== 'review'
    : false;
  if (gone) closeSheet(s);
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
const at = (k: string): [number, number] => { const [e, l] = k.split('.').map(Number); return [e!, l!]; };

export function qOf(sh: Sheet, k: string): number {
  if (sh.t !== 'review') return sh.q[k] ?? 0;
  const [e, l] = at(k);
  return sh.events?.[e]?.lines[l]?.qty ?? 0;
}
/** Never below zero. */
export function setQ(sh: Sheet, k: string, v: number): void {
  v = Math.max(0, round(v));
  if (sh.t !== 'review') { sh.q[k] = v; return; }
  const [e, l] = at(k);
  const line = sh.events?.[e]?.lines[l];
  if (line) line.qty = v;
}
export const stepQ = (sh: Sheet, k: string, dir: number, step: number): void => setQ(sh, k, qOf(sh, k) + dir * step);
