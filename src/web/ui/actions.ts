// What the buttons do. Reads and writes the store, talks to the API, then renders.
import { ApiError, api, onUnauthorized } from '../api.ts';
import { clear, flush, save } from '../outbox.ts';
import { closeSheet, enqueueEvent, enqueueUndo, openSheet, qOf, receive, setQ, stepQ, store as s, view } from '../store.ts';
import type { Tab } from '../store.ts';
import { fmtNum, parseNum } from '../../shared/text.ts';
import { isLow } from '../../shared/stock.ts';
import type { Kind, LineIn, PendingOp } from '../../shared/types.ts';
import { hourToTime, levelName, timeToHour, unitOf } from './components/bits.ts';
import { itemToFields } from './components/sheets.ts';
import { render } from './render.ts';
import { shoppingText } from './screens/pantry.ts';

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
  s.server = null; s.pending = []; s.ui.loggedOut = true; s.ui.sheet = null; s.ui.tab = 'pantry';
  clear(); commit();
};
onUnauthorized(signedOut);

/** Logs an event: shown at once, sent in the background, Undo in the toast. */
function logged(kind: Kind, lines: LineIn[], msg: string, extra: { preset_id?: number; note?: string } = {}): void {
  const cid = enqueueEvent(s, { kind, lines, ...extra });
  toast(msg, [cid]);
  sync();
  void pump();
}

const st = () => view(s)!;
const item = (id: unknown) => st().items.find(i => i.id === Number(id));
const sheet = () => s.ui.sheet!;
const ate = (it: { name: string; unit: string }, q: number) => `Ate ${fmtNum(q)} ${it.unit === 'level' ? '' : `${it.unit} of `}${it.name}`;

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

export const actions: Record<string, (el: HTMLElement) => void | Promise<unknown>> = {
  tab: el => { s.ui.tab = el.dataset.tab as Tab; window.scrollTo(0, 0); },
  close: () => closeSheet(s),
  share: async () => {
    const text = shoppingText(st().items.filter(isLow));
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
    const d = el.dataset, id = Number(d.id), v = st();
    const p = v.presets.find(x => x.id === id), it = v.items.find(x => x.id === id), e = v.events.find(x => x.cid === d.id);
    const lines = (ls: { item_id: number; qty: number }[]) => Object.fromEntries(ls.map(l => [l.item_id, l.qty]));
    if (d.s === 'item' && it) openSheet(s, { t: 'item', id, q: { main: v.usual[id] ?? it.step } }, itemToFields(it));
    else if (d.s === 'preset' && p) openSheet(s, { t: 'preset', id, q: lines(p.lines) });
    else if (d.s === 'presetEdit') openSheet(s, { t: 'presetEdit', id: p?.id, q: lines(p?.lines ?? []), lines: p?.lines.map(l => l.item_id) ?? [] }, { name: p?.name ?? '', emoji: p?.emoji ?? '🍽️', time: hourToTime(p?.hour ?? 8) });
    else if (d.s === 'event' && e) openSheet(s, { t: 'event', id: e.cid, q: lines(e.lines.map(l => ({ item_id: l.item_id, qty: l.is_set ? l.qty : Math.abs(l.qty) }))) });
    else if (d.s === 'compose') openSheet(s, { t: 'compose', q: {} });
    else if (d.s === 'review') {
      const events = structuredClone(v.jobs.find(j => j.id === id)?.result?.events ?? []);
      openSheet(s, { t: 'review', id, q: {}, events, orig: structuredClone(events) });
    }
  },
  newItem: () => openSheet(s, { t: 'itemForm', q: {} }, { name: '', emoji: '🥫', category: 'pantry', unit: 'pc', step: '1', pack: '1', low: '', start: '' }),

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
    logged('eat', [{ item_id: it.id, qty: q }], ate(it, q));
  },
  heroLog: el => {
    const p = st().presets.find(x => x.id === Number(el.dataset.id))!;
    logged('eat', p.lines.map(l => ({ item_id: l.item_id, qty: l.qty })), `Logged ${p.name}`, { preset_id: p.id, note: p.name });
  },
  dismissJob: el => mutate('DELETE', `/api/jobs/${el.dataset.id}`),

  // item sheet
  eat: () => {
    const sh = sheet(), it = item(sh.id)!, q = qOf(sh, 'main');
    if (!q) return void toast('Pick an amount first');
    logged('eat', [{ item_id: it.id, qty: q }], ate(it, q)); closeSheet(s);
  },
  add: () => {
    const sh = sheet(), it = item(sh.id)!, q = qOf(sh, 'main');
    if (!q) return void toast('Pick an amount first');
    logged('buy', [{ item_id: it.id, qty: q }], `Added ${fmtNum(q)} ${unitOf(it)} ${it.name}`); closeSheet(s);
  },
  pack: () => {
    const it = item(sheet().id)!;
    logged('buy', [{ item_id: it.id, qty: it.pack_size }], `Added a pack of ${it.name}`); closeSheet(s);
  },
  setExact: () => {
    const sh = sheet(), it = item(sh.id)!, q = qOf(sh, 'main');
    logged('adjust', [{ item_id: it.id, qty: q }], `${it.name} set to ${fmtNum(q)} ${unitOf(it)}`); closeSheet(s);
  },
  level: el => {
    const it = item(sheet().id)!, q = Number(el.dataset.v);
    logged('adjust', [{ item_id: it.id, qty: q }], `${it.name}: ${levelName(q)}`); closeSheet(s);
  },
  more: () => { sheet().more = !sheet().more; },
  saveItem: async () => {
    const sh = sheet(), f = s.ui.f, isNew = sh.t === 'itemForm';
    const step = parseNum(f.step ?? ''), pack = parseNum(f.pack ?? ''), low = (f.low ?? '').trim() ? parseNum(f.low!) : null;
    const start = (f.start ?? '').trim() ? parseNum(f.start!) : 0;
    if (!f.name?.trim() || !(step > 0) || !(pack > 0) || Number.isNaN(low) || Number.isNaN(start)) return void toast('Check the name and the numbers');
    const name = f.name.trim();
    const body = { name, emoji: (f.emoji ?? '').trim() || '🥫', category: f.category, unit: f.unit, step, pack_size: pack, low_at: low };
    if (!(await mutate(isNew ? 'POST' : 'PATCH', isNew ? '/api/items' : `/api/items/${sh.id}`, body))) return;
    const made = isNew && start > 0 ? st().items.find(i => i.name.toLowerCase() === name.toLowerCase()) : undefined;
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
    if (sh.t === 'presetEdit') { sh.lines = sh.lines?.filter(id => String(id) !== k); return; }
    const [e, l] = k.split('.').map(Number);
    sh.events?.[e!]?.lines.splice(l!, 1);
    sh.orig?.[e!]?.lines.splice(l!, 1);
    const keep = (sh.events ?? []).map(ev => ev.lines.length > 0);
    sh.events = sh.events?.filter((_, i) => keep[i]);
    sh.orig = sh.orig?.filter((_, i) => keep[i]);
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

  // composer and review
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
      const fd = new FormData();
      fd.append('text', text);
      for (const { file } of s.ui.files) { const b = await shrink(file); fd.append('images', b, b === file ? file.name : 'photo.jpg'); }
      receive(s, await api('POST', '/api/jobs', fd));
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
  apply: async () => {
    const sh = sheet();
    if (sh.busy) return;
    const events = (sh.events ?? []).filter(e => e.lines.length);
    if (!events.length) return void toast('Nothing left to add');
    sh.busy = true; commit();
    try {
      receive(s, await api('POST', `/api/jobs/${sh.id}/apply`, { events }));
      toast('Added to the pantry');
      afterState();
    } catch (e) { fail(e); } finally { sh.busy = false; }
  },
  discard: () => mutate('DELETE', `/api/jobs/${sheet().id}`),

  // me and login
  saveMe: async () => {
    const f = s.ui.f, me = st().me;
    if (await mutate('PATCH', '/api/me', { name: (f.meName ?? me.name).trim() || me.name, emoji: (f.meEmoji ?? me.emoji).trim() || me.emoji })) {
      delete f.meName; delete f.meEmoji; toast('Saved');
    }
  },
  logout: async () => { await api('POST', '/api/logout').catch(() => {}); signedOut(); },
  login: async () => {
    const code = (s.ui.f.code ?? '').trim().toLowerCase();
    if (!code) return;
    try { receive(s, await api('POST', '/api/login', { code })); s.ui.f.code = ''; afterState(); } catch (e) { fail(e); }
  },
};
