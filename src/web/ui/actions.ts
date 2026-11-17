// What the buttons do. Reads and writes the store, talks to the API, then renders.
import {
  ApiError, addExpense, api, cookMeal, createToken, exportExpensesUrl,
  linkBarcode, lockExpenses, lookupBarcode, onUnauthorized, revokeToken,
  saveSettings, startJob, subscribePush, testPush, unsubscribePush,
} from '../api.ts';
import { clear, flush, save } from '../outbox.ts';
import { closeSheet, enqueueEvent, enqueueUndo, openSheet, qOf, receive, setQ, stepQ, store as s, view } from '../store.ts';
import type { Sheet, Tab } from '../store.ts';
import { ISO_DATE_RE, addDays, isoDate, parseIsoDate } from '../../shared/dates.ts';
import { isLow, levelParts, shown } from '../../shared/stock.ts';
import { fmtNum, nameKey, parseCostCents, parseNum } from '../../shared/text.ts';
import { CATEGORIES, UNITS } from '../../shared/types.ts';
import type { Category, Item, Kind, LineIn, PendingOp, State, Unit } from '../../shared/types.ts';
import { barcodeToFields, bcModeOf, bcTotal, decodeBarcodePhoto, isBarcodeDetectorSupported, startBarcodeScanner, stopScanner } from './components/barcode.ts';
import { amount, hourToTime, levelReadLabel, timeToHour, unitOf } from './components/bits.ts';
import { cookBatchMacros } from './components/cook.ts';
import { itemToFields, macroBasis } from './components/sheets.ts';
import { render } from './render.ts';
import { shoppingText } from './screens/pantry.ts';
import { shortcutText } from './screens/shortcuts.ts';

export const hooks: { state?: () => void } = {};

export const commit = (): void => render(s);
export const sync = (): void => { save(s); commit(); };

let toastId = 0, toastTimer = 0;
export function toast(msg: string, cids?: string[]): void {
  const id = ++toastId;
  s.ui.toast = { id, msg, cids };
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { if (s.ui.toast?.id === id) { s.ui.toast = null; commit(); } }, 5000);
}
const fail = (e: unknown): void => toast(e instanceof ApiError ? e.message : 'Something went wrong');

const sendOp = (op: PendingOp) => (op.type === 'event' ? api('POST', '/api/events', op.body) : api('DELETE', `/api/events/${op.cid}`));

export async function pump(): Promise<void> {
  const err = await flush(s, sendOp);
  if (err) toast(err);
  afterState();
}

/** A job that finished on its own: show what it said (with Undo for what it did), then dismiss it. */
function sweepJobs(): void {
  for (const j of s.server?.jobs ?? []) {
    if (j.status !== 'done' || s.ui.seenDone.has(j.id)) continue;
    s.ui.seenDone.add(j.id);
    toast(j.result?.reply || 'Done.', j.event_cids.length ? j.event_cids : undefined);
    api('DELETE', `/api/jobs/${j.id}`).then(st => { receive(s, st); afterState(); }).catch(() => {});
  }
}
export function afterState(): void { sweepJobs(); hooks.state?.(); sync(); }

export async function refresh(): Promise<void> {
  if (s.flushing) return;
  try { receive(s, await api('GET', '/api/state')); afterState(); } catch { /* offline: keep what we have */ }
}

async function mutate(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<boolean> {
  if (!navigator.onLine) { toast("You're offline"); return false; }
  try { receive(s, await api(method, path, body)); afterState(); return true; } catch (e) { fail(e); return false; }
}

const signedOut = (): void => {
  stopScanner(s);
  s.server = null; s.pending = []; s.ui.loggedOut = true; s.ui.sheet = null; s.ui.tab = 'pantry';
  s.ui.newToken = null; s.ui.barcodeLookup = null;
  clear(); commit();
};
onUnauthorized(signedOut);

/** Logs an event: shown at once, sent in the background, Undo in the toast. */
function logged(kind: Kind, lines: LineIn[], msg: string, extra: { preset_id?: number; note?: string; cost_cents?: number } = {}): void {
  const cid = enqueueEvent(s, { kind, lines, ...extra });
  toast(msg, [cid]);
  sync();
  void pump();
}

const st = () => view(s)!;
const item = (id: unknown) => st().items.find(i => i.id === Number(id));
const sheet = () => s.ui.sheet!;
const amountText = (unit: Unit, q: number): string =>
  unit === 'level' ? `${fmtNum(q)} ${q === 1 ? 'container' : 'containers'}` : `${fmtNum(q)} ${unit}`;
const ate = (it: { name: string; emoji: string; unit: string }, q: number) => it.unit === 'level'
  ? levelReadLabel(it, q)
  : `Ate ${fmtNum(q)} ${it.unit} of ${it.name}`;

function shrink(file: File): Promise<Blob> {
  return createImageBitmap(file).then(bmp => {
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return new Promise<Blob>((ok, no) => c.toBlob(b => (b ? ok(b) : no(new Error('encode'))), 'image/jpeg', 0.8));
  }).catch(() => file);
}

const presetLines = (ids: number[], q: Record<string, number>): LineIn[] =>
  ids.map(id => ({ item_id: id, qty: q[id] ?? 0 })).filter(l => l.qty > 0);

const parseOptNum = (raw: string | undefined): number | null | 'invalid' => {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const n = parseNum(t);
  return Number.isNaN(n) ? 'invalid' : n;
};

const parseOptCostCents = (raw: string | undefined): number | null | 'invalid' => {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const c = parseCostCents(t);
  return Number.isNaN(c) ? 'invalid' : c;
};

const resolveItemQty = (sh: Sheet, it: Item, q: number): number =>
  sh.portionMode && it.is_cooked && it.portion_g != null
    ? Math.round(q * it.portion_g * 1000) / 1000
    : q;

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function cookStateFor(it: Item | undefined, nowMs: number): {
  lines: number[];
  q: Record<string, number>;
  fields: Record<string, string>;
} {
  const exp = addDays(isoDate(nowMs), it?.shelf_life_days ?? 4);
  if (!it) {
    return {
      lines: [], q: {},
      fields: { cookName: '', cookEmoji: '🍲', cookOwner: 'shared', cookExpiry: exp, cookPortions: '', cookGrams: '', cookKcal: '', cookProtein: '' },
    };
  }
  const recipe = it.recipe ?? [];
  return {
    lines: recipe.map(r => r.item_id),
    q: Object.fromEntries(recipe.map(r => [String(r.item_id), r.qty])),
    fields: {
      cookName: it.name, cookEmoji: it.emoji,
      cookOwner: it.owner_id == null ? 'shared' : 'mine',
      cookExpiry: exp, cookPortions: '', cookGrams: '', cookKcal: '', cookProtein: '',
    },
  };
}

async function runBarcodeLookup(rawCode: string): Promise<void> {
  const code = rawCode.trim();
  if (!/^\d{6,14}$/.test(code)) return void toast('Enter 6 to 14 barcode digits');
  if (!navigator.onLine) return void toast("You're offline");
  s.ui.barcodeBusy = true;
  commit();
  try {
    const lk = await lookupBarcode(code);
    s.ui.barcodeLookup = lk;
    if (s.ui.sheet?.t === 'barcode') s.ui.sheet.q.bc = 1;
    s.ui.f.bcMode = 'pack';
    if (lk.item_id == null) Object.assign(s.ui.f, barcodeToFields(lk));
    else s.ui.f.buyCost = '';
  } catch (e) { fail(e); } finally {
    s.ui.barcodeBusy = false;
    commit();
  }
}

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

function confirmOverdraw(v: State, lines: { item_id: number; qty: number }[]): boolean {
  const msg = overdrawWarning(v, lines);
  return msg == null || (globalThis.confirm?.(msg) ?? true);
}

export const actions: Record<string, (el: HTMLElement) => void | Promise<unknown>> = {
  rerender: () => {},
  tab: el => { stopScanner(s); s.ui.tab = el.dataset.tab as Tab; window.scrollTo(0, 0); },
  close: () => { stopScanner(s); closeSheet(s); },
  share: async () => {
    const text = shoppingText(visibleLowItems(st()));
    try { await navigator.share({ text }); }
    catch (e) {
      if ((e as Error).name === 'AbortError') return;
      try { await navigator.clipboard.writeText(text); toast('Copied the list'); } catch { toast("Couldn't share the list"); }
    }
  },
  toastUndo: () => {
    for (const cid of s.ui.toast?.cids ?? []) enqueueUndo(s, cid);
    toast('Undone');
    sync();
    void pump();
  },

  open: el => {
    stopScanner(s);
    const d = el.dataset, id = Number(d.id), v = st();
    const p = v.presets.find(x => x.id === id), it = v.items.find(x => x.id === id), e = v.events.find(x => x.cid === d.id);
    const lines = (ls: { item_id: number; qty: number }[]) => Object.fromEntries(ls.map(l => [l.item_id, l.qty]));
    if (d.s === 'item' && it) {
      const portionMode = !!(it.is_cooked && it.portion_g != null);
      const rawUsual = v.usual[id] ?? it.step;
      const mainQ = portionMode ? Math.round((rawUsual / it.portion_g!) * 100) / 100 || 1 : rawUsual;
      openSheet(s, { t: 'item', id, q: { main: mainQ }, portionMode }, itemToFields(it));
    } else if (d.s === 'preset' && p) {
      openSheet(s, { t: 'preset', id, q: lines(p.lines) });
    } else if (d.s === 'presetEdit') {
      openSheet(s, { t: 'presetEdit', id: p?.id, q: lines(p?.lines ?? []), lines: p?.lines.map(l => l.item_id) ?? [] }, { name: p?.name ?? '', emoji: p?.emoji ?? '🍽️', time: hourToTime(p?.hour ?? 8) });
    } else if (d.s === 'event' && e) {
      openSheet(s, { t: 'event', id: e.cid, q: lines(e.lines.map(l => ({ item_id: l.item_id, qty: l.is_set ? l.qty : Math.abs(l.qty) }))) });
    } else if (d.s === 'compose') {
      openSheet(s, { t: 'compose', q: {}, mode: s.ui.jobMode });
    } else if (d.s === 'review') {
      const job = v.jobs.find(j => j.id === id);
      const events = structuredClone(job?.result?.events ?? []);
      const cook = structuredClone(job?.result?.cook ?? []);
      const existingTotal = events.find(ev => ev.total_cost != null)?.total_cost;
      const lineSum = events.flatMap(ev => ev.kind === 'buy' ? ev.lines : []).reduce((acc, l) => acc + (l.price ?? 0), 0);
      const hasPrices = events.some(ev => ev.kind === 'buy' && ev.lines.some(l => l.price != null));
      const reviewTotalCost = job?.mode === 'audit' ? ''
        : existingTotal != null ? fmtNum(existingTotal)
        : hasPrices ? fmtNum(lineSum)
        : '';
      openSheet(s, { t: 'review', id, q: {}, events, orig: structuredClone(events), cook, origCook: structuredClone(cook) }, { reviewTotalCost });
    } else if (d.s === 'cook') {
      const ck = cookStateFor(it?.is_cooked ? it : undefined, v.now);
      openSheet(s, { t: 'cook', id: it?.is_cooked ? it.id : undefined, q: ck.q, lines: ck.lines }, ck.fields);
    } else if (d.s === 'barcode') {
      s.ui.barcodeLookup = null;
      s.ui.barcodeBusy = false;
      s.ui.scannerSupported = isBarcodeDetectorSupported();
      openSheet(s, { t: 'barcode', q: { bc: 1 } }, { barcodeCode: '', buyCost: '', bcLinkItem: '', bcMode: 'pack' });
      if (s.ui.scannerSupported) void startBarcodeScanner(code => runBarcodeLookup(code), () => commit(), s);
    } else if (d.s === 'expense') {
      openSheet(s, { t: 'expense', q: {} }, { expCost: '', expNote: '', expDate: isoDate(v.now) });
    }
  },
  newItem: () => {
    stopScanner(s);
    openSheet(s, { t: 'itemForm', q: {} }, {
      name: '', emoji: '🥫', category: 'pantry', unit: 'pc', step: '1', pack: '1',
      low: '', start: '', itemOwner: 'shared', itemExpiry: '', itemKcal: '', itemProtein: '', itemFat: '',
    });
  },
  openAudit: () => {
    stopScanner(s);
    s.ui.jobMode = 'audit';
    openSheet(s, { t: 'compose', q: {}, mode: 'audit' });
  },
  ownerFilter: el => {
    const v = el.dataset.v;
    s.ui.ownerFilter = v === 'mine' || v === 'shared' ? v : 'all';
  },
  historyScope: el => {
    s.ui.historyScope = el.dataset.v === 'all' ? 'all' : 'me';
  },

  // steppers
  step: el => stepQ(sheet(), el.dataset.k!, Number(el.dataset.d), Number(el.dataset.s)),
  numedit: el => { s.ui.editing = el.dataset.k!; },
  num: el => {
    const v = parseNum((el as HTMLInputElement).value);
    if (Number.isNaN(v)) toast("That's not a number");
    else setQ(sheet(), el.dataset.k!, v);
    s.ui.editing = null;
  },
  numend: () => { s.ui.editing = null; },

  // pantry
  take: el => {
    const it = item(el.dataset.id)!, q = st().usual[it.id] ?? it.step;
    const lines = [{ item_id: it.id, qty: q }];
    if (!confirmOverdraw(st(), lines)) return;
    logged('eat', lines, ate(it, q));
  },
  heroLog: el => {
    const p = st().presets.find(x => x.id === Number(el.dataset.id))!;
    const lines = p.lines.map(l => ({ item_id: l.item_id, qty: l.qty }));
    if (!confirmOverdraw(st(), lines)) return;
    logged('eat', lines, `Logged ${p.name}`, { preset_id: p.id, note: p.name });
  },
  dismissJob: el => mutate('DELETE', `/api/jobs/${el.dataset.id}`),

  // item sheet
  portionMode: el => {
    const sh = sheet(), it = item(sh.id);
    if (!it?.is_cooked || !it.portion_g) return;
    const next = el.dataset.v != null ? el.dataset.v === '1' : !sh.portionMode;
    if (!!sh.portionMode === next) return;
    const cur = qOf(sh, 'main');
    const converted = next ? cur / it.portion_g : cur * it.portion_g;
    sh.portionMode = next;
    setQ(sh, 'main', Math.round(converted * 100) / 100);
  },
  eat: () => {
    const sh = sheet(), it = item(sh.id)!, q = resolveItemQty(sh, it, qOf(sh, 'main'));
    if (!(q > 0)) return void toast('Pick an amount first');
    const lines = [{ item_id: it.id, qty: q }];
    if (!confirmOverdraw(st(), lines)) return;
    logged('eat', lines, ate(it, q)); closeSheet(s);
  },
  add: () => {
    const sh = sheet(), it = item(sh.id)!, q = resolveItemQty(sh, it, qOf(sh, 'main'));
    if (!(q > 0)) return void toast('Pick an amount first');
    const cost_cents = parseOptCostCents(s.ui.f.buyCost);
    if (cost_cents === 'invalid') return void toast('Check the cost');
    const line: LineIn = { item_id: it.id, qty: q, ...(cost_cents != null ? { cost_cents } : {}) };
    logged('buy', [line], `Added ${fmtNum(q)} ${unitOf(it)} ${it.name}`, cost_cents != null ? { cost_cents } : {});
    s.ui.f.buyCost = '';
    closeSheet(s);
  },
  pack: () => {
    const it = item(sheet().id)!;
    const cost_cents = parseOptCostCents(s.ui.f.buyCost);
    if (cost_cents === 'invalid') return void toast('Check the cost');
    const line: LineIn = { item_id: it.id, qty: it.unit === 'level' ? 1 : it.pack_size, ...(cost_cents != null ? { cost_cents } : {}) };
    logged('buy', [line], it.unit === 'level' ? `Added a container of ${it.name}` : `Added a pack of ${it.name}`, cost_cents != null ? { cost_cents } : {});
    s.ui.f.buyCost = '';
    closeSheet(s);
  },
  exactOpen: () => {
    const sh = sheet(), it = item(sh.id)!;
    sh.exact = true;
    s.ui.f.exact = fmtNum(shown(it.stock));
  },
  setExact: () => {
    const sh = sheet(), it = item(sh.id)!, raw = parseNum(s.ui.f.exact ?? '');
    if (Number.isNaN(raw) || raw < 0) return void toast("That's not an amount");
    const q = Math.round(raw * 1000) / 1000;
    const label = it.unit === 'level' ? amount(it, q) : `${fmtNum(q)} ${unitOf(it)}`;
    logged('adjust', [{ item_id: it.id, qty: q }], `${it.name} set to ${label}`); closeSheet(s);
  },
  level: el => {
    const it = item(sheet().id)!, q = Number(el.dataset.v);
    logged('eat', [{ item_id: it.id, qty: q }], levelReadLabel(it, levelParts(it.stock).sealed + q)); closeSheet(s);
  },
  more: () => { sheet().more = !sheet().more; },
  saveItem: async () => {
    const sh = sheet(), f = s.ui.f, isNew = sh.t === 'itemForm';
    const step = parseNum(f.step ?? ''), pack = parseNum(f.pack ?? '');
    const low = parseOptNum(f.low), start = (f.start ?? '').trim() ? parseNum(f.start!) : 0;
    const kcalIn = parseOptNum(f.itemKcal), proteinIn = parseOptNum(f.itemProtein), fatIn = parseOptNum(f.itemFat);
    const exp = (f.itemExpiry ?? '').trim();
    if (!f.name?.trim() || !(step > 0) || !(pack > 0) || low === 'invalid' || Number.isNaN(start)
      || kcalIn === 'invalid' || proteinIn === 'invalid' || fatIn === 'invalid' || (exp && !ISO_DATE_RE.test(exp))) {
      return void toast('Check the name and the numbers');
    }
    const name = f.name.trim();
    const unit = (UNITS.includes(f.unit as Unit) ? f.unit : 'pc') as Unit;
    const { mult } = macroBasis(unit);
    const body = {
      name, emoji: (f.emoji ?? '').trim() || '🥫',
      category: (CATEGORIES.includes(f.category as Category) ? f.category : 'pantry') as Category,
      unit, step, pack_size: pack, low_at: low,
      owner_id: f.itemOwner === 'mine' ? st().me.id : null,
      expires_at: exp || null,
      kcal_per_unit: kcalIn == null ? null : Math.round((kcalIn / mult) * 1000) / 1000,
      protein_per_unit: proteinIn == null ? null : Math.round((proteinIn / mult) * 1000) / 1000,
      fat_per_unit: fatIn == null ? null : Math.round((fatIn / mult) * 1000) / 1000,
    };
    if (!(await mutate(isNew ? 'POST' : 'PATCH', isNew ? '/api/items' : `/api/items/${sh.id}`, body))) return;
    const made = isNew && start > 0 ? findCreatedItem(st().items, name, body.owner_id) : undefined;
    if (made) logged('adjust', [{ item_id: made.id, qty: start }], `Added ${name}`);
    else toast(`Saved ${name}`);
    closeSheet(s);
  },
  archive: async () => {
    const it = item(sheet().id)!;
    if (confirm(`Archive ${it.name}?`) && await mutate('DELETE', `/api/items/${it.id}`)) toast(`Archived ${it.name}`);
  },

  // presets
  logPreset: () => {
    const sh = sheet(), p = st().presets.find(x => x.id === sh.id)!;
    const lines = presetLines(p.lines.map(l => l.item_id), sh.q);
    if (!lines.length) return void toast('Pick an amount first');
    if (!confirmOverdraw(st(), lines)) return;
    logged('eat', lines, `Logged ${p.name}`, { preset_id: p.id, note: p.name }); closeSheet(s);
  },
  presetAdd: el => {
    const sh = sheet(), it = item((el as HTMLSelectElement).value);
    if (it) { sh.lines?.push(it.id); sh.q[it.id] = it.step; }
  },
  savePreset: async () => {
    const sh = sheet(), f = s.ui.f, name = (f.name ?? '').trim();
    const lines = presetLines(sh.lines ?? [], sh.q);
    if (!name || !lines.length) return void toast('Give it a name and at least one item');
    const body = { name, emoji: (f.emoji ?? '').trim() || '🍽️', hour: timeToHour(f.time || '08:00'), lines };
    if (await mutate(sh.id == null ? 'POST' : 'PATCH', sh.id == null ? '/api/presets' : `/api/presets/${sh.id}`, body)) { closeSheet(s); toast(`Saved ${name}`); }
  },
  delPreset: async el => {
    const p = st().presets.find(x => x.id === Number(el.dataset.id));
    if (p && confirm(`Delete ${p.name}?`) && await mutate('DELETE', `/api/presets/${p.id}`)) toast(`Deleted ${p.name}`);
  },
  rmLine: el => {
    const sh = sheet(), k = el.dataset.k!;
    if (sh.t === 'presetEdit' || sh.t === 'cook') { sh.lines = sh.lines?.filter(id => String(id) !== k); return; }
    const [e, l] = k.split('.').map(Number);
    sh.events?.[e!]?.lines.splice(l!, 1);
    sh.orig?.[e!]?.lines.splice(l!, 1);
    const keep = (sh.events ?? []).map(ev => ev.lines.length > 0);
    sh.events = sh.events?.filter((_, i) => keep[i]);
    sh.orig = sh.orig?.filter((_, i) => keep[i]);
  },

  // cook meal
  cookMealPick: el => {
    const sh = sheet(), picked = item((el as HTMLSelectElement).value);
    const ck = cookStateFor(picked, st().now);
    sh.id = picked?.id;
    sh.lines = ck.lines;
    sh.q = ck.q;
    Object.assign(s.ui.f, ck.fields);
  },
  cookAddIng: el => {
    const sh = sheet(), it = item((el as HTMLSelectElement).value);
    if (!it) return;
    sh.lines ??= [];
    if (!sh.lines.includes(it.id)) sh.lines.push(it.id);
    sh.q[String(it.id)] ??= it.unit === 'g' || it.unit === 'ml' ? Math.min(it.pack_size, 500) : it.step;
  },
  saveCook: async () => {
    const sh = sheet(), f = s.ui.f;
    if (sh.busy) return;
    if (!navigator.onLine) return void toast("You're offline");
    const mealId = typeof sh.id === 'number' ? sh.id : null;
    const name = (f.cookName ?? '').trim();
    if (!mealId && !name) return void toast('Give the cooked meal a name');
    const portions = parseOptNum(f.cookPortions), total_g = parseOptNum(f.cookGrams);
    if (portions === 'invalid' || total_g === 'invalid' || (portions != null && !(portions > 0)) || (total_g != null && !(total_g > 0))) {
      return void toast('Check portions and grams');
    }
    if (portions == null && total_g == null) return void toast('Enter portions, total grams, or both');
    const exp = (f.cookExpiry ?? '').trim();
    if (exp && !ISO_DATE_RE.test(exp)) return void toast('Check expiry date');
    const kcalIn = parseOptNum(f.cookKcal), proteinIn = parseOptNum(f.cookProtein), fatIn = parseOptNum(f.cookFat);
    if (kcalIn === 'invalid' || proteinIn === 'invalid' || fatIn === 'invalid') return void toast('Check calories, protein and fat');
    const ids = sh.lines ?? [];
    const auto = cookBatchMacros(st().items, ids, sh.q);
    const ingredients = ids.map(id => ({ item_id: id, qty: qOf(sh, String(id)) })).filter(l => l.qty > 0);
    if (!confirmOverdraw(st(), ingredients)) return;
    sh.busy = true; commit();
    try {
      const next = await cookMeal({
        cid: crypto.randomUUID(),
        at: Date.now(),
        meal_item_id: mealId,
        name: name || null,
        emoji: (f.cookEmoji ?? '').trim() || '🍲',
        owner_id: f.cookOwner === 'mine' ? st().me.id : null,
        portions,
        total_g,
        expires_at: exp || null,
        kcal_total: kcalIn != null ? kcalIn : (auto.hasKcal ? auto.kcal : null),
        protein_total: proteinIn != null ? proteinIn : (auto.hasProtein ? auto.protein : null),
        fat_total: fatIn != null ? fatIn : (auto.hasFat ? auto.fat : null),
        ingredients,
      });
      receive(s, next);
      closeSheet(s);
      toast(`Cooked ${name || 'meal'}`);
      afterState();
    } catch (e) { fail(e); } finally { sh.busy = false; }
  },

  // barcode
  startScan: () => {
    void startBarcodeScanner(code => runBarcodeLookup(code), () => commit(), s);
  },
  stopScan: () => stopScanner(s),
  barcodeLookup: () => runBarcodeLookup(s.ui.f.barcodeCode ?? ''),
  barcodePhoto: async el => {
    const input = el as HTMLInputElement, file = input.files?.[0];
    input.value = '';
    if (!file) return;
    stopScanner(s);
    s.ui.barcodeBusy = true; commit();
    let code: string | undefined;
    try { code = await decodeBarcodePhoto(file); } finally { s.ui.barcodeBusy = false; }
    if (!code) return void toast('No barcode found in that photo — try closer, in focus');
    s.ui.f.barcodeCode = code;
    await runBarcodeLookup(code);
  },
  barcodeFallbackPhoto: () => {
    stopScanner(s);
    s.ui.jobMode = 'auto';
    openSheet(s, { t: 'compose', q: {}, mode: 'auto' });
  },
  bcMode: el => {
    const sh = sheet(), next = el.dataset.v === 'unit' ? 'unit' : 'pack', pack = Number(el.dataset.p) || 1;
    if ((s.ui.f.bcMode === 'unit' ? 'unit' : 'pack') === next) return;
    const n = qOf(sh, 'bc');
    setQ(sh, 'bc', next === 'unit' ? n * pack : n / pack); // keep the same amount when switching
    s.ui.f.bcMode = next;
  },
  barcodeAddPack: el => {
    const it = item(el.dataset.id);
    if (!it) return;
    const cost_cents = parseOptCostCents(s.ui.f.buyCost);
    if (cost_cents === 'invalid') return void toast('Check the cost');
    const qty = bcTotal(qOf(sheet(), 'bc'), bcModeOf(s.ui.f, it.unit, it.pack_size), it.unit, it.pack_size);
    if (!(qty > 0)) return void toast('Pick an amount first');
    const line: LineIn = { item_id: it.id, qty, ...(cost_cents != null ? { cost_cents } : {}) };
    logged('buy', [line], `Added ${amountText(it.unit, qty)} of ${it.name}`, cost_cents != null ? { cost_cents } : {});
    s.ui.f.buyCost = '';
    stopScanner(s);
    closeSheet(s);
  },
  barcodeCreateAdd: async () => {
    const f = s.ui.f, lk = s.ui.barcodeLookup;
    if (!navigator.onLine) return void toast("You're offline");
    const name = (f.bcName ?? '').trim();
    const pack = parseNum(f.bcPack ?? '');
    const kcalIn = parseOptNum(f.bcKcal), proteinIn = parseOptNum(f.bcProtein), fatIn = parseOptNum(f.bcFat);
    const cost_cents = parseOptCostCents(f.buyCost);
    if (!name || !(pack > 0) || kcalIn === 'invalid' || proteinIn === 'invalid' || fatIn === 'invalid' || cost_cents === 'invalid') {
      return void toast('Check the name, pack size, and numbers');
    }
    const unit = (UNITS.includes(f.bcUnit as Unit) ? f.bcUnit : 'g') as Unit;
    const category = (CATEGORIES.includes(f.bcCategory as Category) ? f.bcCategory : 'pantry') as Category;
    const { mult } = macroBasis(unit);
    const body = {
      name, emoji: (f.bcEmoji ?? '').trim() || '📦', category, unit,
      step: unit === 'g' || unit === 'ml' ? 50 : 1,
      pack_size: pack, low_at: null,
      kcal_per_unit: kcalIn == null ? null : Math.round((kcalIn / mult) * 1000) / 1000,
      protein_per_unit: proteinIn == null ? null : Math.round((proteinIn / mult) * 1000) / 1000,
      fat_per_unit: fatIn == null ? null : Math.round((fatIn / mult) * 1000) / 1000,
      ...(lk?.code ? { barcode: lk.code } : {}),
    };
    const qty = bcTotal(qOf(sheet(), 'bc'), bcModeOf(f, unit, pack), unit, pack);
    if (!(qty > 0)) return void toast('Pick an amount first');
    if (!(await mutate('POST', '/api/items', body))) return;
    const created = findCreatedItem(st().items, name, null);
    if (created) {
      const line: LineIn = { item_id: created.id, qty, ...(cost_cents != null ? { cost_cents } : {}) };
      logged('buy', [line], `Added ${amountText(unit, qty)} of ${name}`, cost_cents != null ? { cost_cents } : {});
    } else toast(`Added ${name}`);
    s.ui.f.buyCost = '';
    stopScanner(s);
    closeSheet(s);
  },
  barcodeLink: async () => {
    const f = s.ui.f, it = item(f.bcLinkItem), code = (s.ui.barcodeLookup?.code ?? f.barcodeCode ?? '').trim();
    if (!it || !/^\d{6,14}$/.test(code)) return void toast('Pick an item first');
    const cost_cents = parseOptCostCents(f.buyCost);
    if (cost_cents === 'invalid') return void toast('Check the cost');
    if (!navigator.onLine) return void toast("You're offline");
    // The picker shows the create form's unit/pack; for linking, read its count against the chosen item.
    const qty = bcTotal(qOf(sheet(), 'bc'), bcModeOf(f, it.unit, it.pack_size), it.unit, it.pack_size);
    if (!(qty > 0)) return void toast('Pick an amount first');
    try {
      receive(s, await linkBarcode({ code, item_id: it.id }));
      afterState();
      const line: LineIn = { item_id: it.id, qty, ...(cost_cents != null ? { cost_cents } : {}) };
      logged('buy', [line], `Linked & added ${it.name}`, cost_cents != null ? { cost_cents } : {});
      f.buyCost = '';
      stopScanner(s);
      closeSheet(s);
    } catch (e) { fail(e); }
  },

  // history
  saveEvent: async () => {
    const sh = sheet(), e = st().events.find(x => x.cid === sh.id)!;
    if (s.pending.some(o => o.type === 'event' && o.body.cid === e.cid)) return void toast('Still sending, try again in a moment');
    if (await mutate('PATCH', `/api/events/${e.cid}`, { lines: e.lines.map(l => ({ item_id: l.item_id, qty: sh.q[l.item_id] ?? 0 })) })) { closeSheet(s); toast('Saved'); }
  },
  undoEvent: () => {
    enqueueUndo(s, String(sheet().id));
    closeSheet(s); toast('Undone'); sync(); void pump();
  },
  saveAsPreset: () => {
    const e = st().events.find(x => x.cid === sheet().id)!, d = new Date(e.at);
    openSheet(s, { t: 'presetEdit', q: Object.fromEntries(e.lines.map(l => [l.item_id, Math.abs(l.qty)])), lines: e.lines.map(l => l.item_id) },
      { name: e.note ?? '', emoji: '🍽️', time: hourToTime(d.getHours() + d.getMinutes() / 60) });
  },

  // spend & expenses
  saveExpense: async () => {
    const sh = sheet(), f = s.ui.f;
    if (sh.busy) return;
    if (!navigator.onLine) return void toast("You're offline");
    const cost_cents = parseOptCostCents(f.expCost);
    if (cost_cents === 'invalid' || !(cost_cents && cost_cents > 0)) return void toast('Enter an amount');
    const dateStr = (f.expDate ?? '').trim();
    const parsedDate = dateStr ? parseIsoDate(dateStr) : null;
    if (dateStr && !parsedDate) return void toast('Check the date');
    const at = parsedDate
      ? (dateStr === isoDate(st().now) ? Date.now() : parsedDate.getTime() + 12 * 3_600_000)
      : Date.now();
    const note = (f.expNote ?? '').trim() || null;
    sh.busy = true; commit();
    try {
      receive(s, await addExpense({ cid: crypto.randomUUID(), at, cost_cents, note }));
      closeSheet(s);
      toast('Expense logged');
      afterState();
    } catch (e) { fail(e); } finally { sh.busy = false; }
  },
  lockWeek: async el => {
    const period = el.dataset.p;
    if (!period || !navigator.onLine) return void (period ? toast("You're offline") : null);
    if (!confirm(`Lock expenses for ${period}? Locked weeks cannot be edited.`)) return;
    try { receive(s, await lockExpenses({ period })); toast(`Locked ${period}`); afterState(); } catch (e) { fail(e); }
  },
  exportExpenses: el => {
    const period = el.dataset.p ?? '';
    const format = el.dataset.fmt === 'json' ? 'json' : 'csv';
    const url = exportExpensesUrl(period, format);
    const a = document.createElement('a');
    a.href = url;
    a.download = `expenses-${period || 'all'}.${format}`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  },

  // composer and review
  jobMode: el => {
    const mode = el.dataset.v === 'audit' ? 'audit' : 'auto';
    s.ui.jobMode = mode;
    if (s.ui.sheet?.t === 'compose') s.ui.sheet.mode = mode;
  },
  photos: el => {
    const input = el as HTMLInputElement;
    for (const file of [...(input.files ?? [])]) {
      if (s.ui.files.length >= 4) { toast('Four photos at most'); break; }
      s.ui.files.push({ file, url: URL.createObjectURL(file) });
    }
    input.value = '';
  },
  rmPhoto: el => { const [f] = s.ui.files.splice(Number(el.dataset.k), 1); if (f) URL.revokeObjectURL(f.url); },
  send: async () => {
    const sh = sheet(), text = (s.ui.f.text ?? '').trim();
    if (sh.busy) return;
    if (!text && !s.ui.files.length) return void toast('Write something or add a photo');
    if (!navigator.onLine) return void toast("You're offline");
    sh.busy = true; commit();
    try {
      const blobs: Blob[] = [];
      for (const { file } of s.ui.files) blobs.push(await shrink(file));
      receive(s, await startJob(text, blobs, sh.mode ?? s.ui.jobMode));
      s.ui.files.forEach(f => URL.revokeObjectURL(f.url));
      s.ui.files = []; s.ui.f.text = '';
      closeSheet(s); toast("Sent. I'll tell you when it's done.");
      afterState();
    } catch (e) { fail(e); } finally { sh.busy = false; }
  },
  rematch: el => {
    const sh = sheet(), [e, l] = el.dataset.k!.split('.').map(Number), v = (el as HTMLSelectElement).value;
    const line = sh.events?.[e!]?.lines[l!], orig = sh.orig?.[e!]?.lines[l!];
    if (!line) return;
    if (v === 'new' && orig?.new_item) { line.item_id = null; line.new_item = { ...orig.new_item }; }
    else { line.item_id = Number(v); line.new_item = null; }
  },
  rmCook: el => {
    const sh = sheet();
    sh.cook?.splice(Number(el.dataset.k), 1);
  },
  apply: async () => {
    const sh = sheet();
    if (sh.busy) return;
    const events = structuredClone((sh.events ?? []).filter(e => e.lines.length));
    const cook = sh.cook ?? [];
    if (!events.length && !cook.length) return void toast('Nothing left to add');
    if (events.length && s.ui.f.reviewTotalCost !== undefined) {
      const tc = parseOptNum(s.ui.f.reviewTotalCost);
      if (tc === 'invalid' || (tc != null && tc < 0)) return void toast('Check the total cost');
      const target = events.find(e => e.kind === 'buy') ?? events[0];
      if (target) target.total_cost = tc;
    }
    sh.busy = true; commit();
    try {
      receive(s, await api('POST', `/api/jobs/${sh.id}/apply`, { events, ...(cook.length ? { cook } : {}) }));
      s.ui.f.reviewTotalCost = '';
      toast('Applied to pantry');
      afterState();
    } catch (e) { fail(e); } finally { sh.busy = false; }
  },
  discard: () => mutate('DELETE', `/api/jobs/${sheet().id}`),

  // me, settings, push, tokens, login
  saveMe: async () => {
    const f = s.ui.f, me = st().me;
    const body = {
      name: (f.meName ?? me.name).trim() || me.name,
      emoji: (f.meEmoji ?? me.emoji).trim() || me.emoji,
      notify_low: f.notifyLow !== undefined ? f.notifyLow === '1' : me.notify_low,
      notify_expiry: f.notifyExpiry !== undefined ? f.notifyExpiry === '1' : me.notify_expiry,
    };
    if (await mutate('PATCH', '/api/me', body)) {
      delete f.meName; delete f.meEmoji; toast('Saved');
    }
  },
  saveNotify: async () => {
    const f = s.ui.f, me = st().me;
    await mutate('PATCH', '/api/me', {
      notify_low: f.notifyLow !== undefined ? f.notifyLow === '1' : me.notify_low,
      notify_expiry: f.notifyExpiry !== undefined ? f.notifyExpiry === '1' : me.notify_expiry,
    });
  },
  saveSettings: async () => {
    const currency = (s.ui.f.currency ?? st().currency).trim();
    if (!currency) return void toast('Enter a currency');
    if (!navigator.onLine) return void toast("You're offline");
    try {
      receive(s, await saveSettings({ currency }));
      delete s.ui.f.currency;
      toast('Saved currency');
      afterState();
    } catch (e) { fail(e); }
  },
  enablePush: async () => {
    if (typeof Notification === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      return void toast('Push notifications are not supported here');
    }
    // Call Notification.requestPermission() synchronously inside the tap gesture (required for iOS Safari 16.4+)
    const permPromise = Notification.requestPermission();
    const perm = await permPromise;
    s.ui.pushPermission = perm;
    if (perm !== 'granted') return void toast('Notification permission was not granted');
    const vapid = st().vapid_public_key;
    if (!vapid) return void toast('Push is not configured on the server');
    if (!navigator.onLine) return void toast("You're offline");
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid),
      });
      const json = sub.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        return void toast('Could not read push subscription');
      }
      receive(s, await subscribePush({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      }));
      toast('Push notifications enabled');
      afterState();
    } catch (e) { fail(e); }
  },
  disablePush: async () => {
    if (!navigator.onLine) return void toast("You're offline");
    try {
      const reg = await navigator.serviceWorker?.ready;
      const sub = await reg?.pushManager?.getSubscription();
      if (sub) {
        receive(s, await unsubscribePush({ endpoint: sub.endpoint }));
        await sub.unsubscribe().catch(() => {});
      }
      toast('Push notifications disabled');
      afterState();
    } catch (e) { fail(e); }
  },
  testPush: async () => {
    if (!navigator.onLine) return void toast("You're offline");
    try {
      const res = await testPush();
      toast(res.sent > 0 ? 'Test notification sent' : 'No active push subscription');
    } catch (e) { fail(e); }
  },
  createToken: async () => {
    const name = (s.ui.f.tokenName ?? '').trim();
    if (!name) return void toast('Give the token a name');
    if (!navigator.onLine) return void toast("You're offline");
    try {
      const res = await createToken({ name });
      s.ui.newToken = res.token;
      s.ui.f.tokenName = '';
      receive(s, res.state);
      toast('Token created — copy it now');
      afterState();
    } catch (e) { fail(e); }
  },
  copyToken: async () => {
    if (!s.ui.newToken) return;
    try { await navigator.clipboard.writeText(s.ui.newToken); toast('Token copied'); }
    catch { toast('Copy failed — select and copy manually'); }
  },
  revokeToken: async el => {
    const id = Number(el.dataset.id);
    if (!id || !confirm('Revoke this Siri Shortcut token?')) return;
    if (!navigator.onLine) return void toast("You're offline");
    try {
      receive(s, await revokeToken(id));
      toast('Token revoked');
      afterState();
    } catch (e) { fail(e); }
  },
  copyShortcut: async el => {
    const kind = el.dataset.k === 'log' ? 'log' : 'ai';
    try {
      await navigator.clipboard.writeText(shortcutText(kind, location.origin, s.ui.newToken));
      toast(s.ui.newToken ? 'Setup text copied (with your token)' : 'Setup text copied — add your token where it says');
    } catch { toast('Copy failed — open "Show the steps" and copy manually'); }
  },
  newGuestCode: async () => {
    if (confirm('Make a new guest passcode? Current guests will be locked out.')) await mutate('POST', '/api/guest/code');
  },
  copyGuest: async () => {
    const code = st().guest_code;
    try { await navigator.clipboard.writeText(`${location.origin}/guest  passcode: ${code}`); toast('Guest link and passcode copied'); }
    catch { toast('Copy failed — select and copy manually'); }
  },
  logout: async () => { await api('POST', '/api/logout').catch(() => {}); signedOut(); },
  login: async () => {
    const code = (s.ui.f.code ?? '').trim().toLowerCase();
    if (!code) return;
    try { receive(s, await api('POST', '/api/login', { code })); s.ui.f.code = ''; afterState(); } catch (e) { fail(e); }
  },
};
