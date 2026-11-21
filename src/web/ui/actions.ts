// What the buttons do. Reads and writes the store, talks to the API, then renders.
// Feature action maps live beside their screens and are merged at the bottom.
import { closeSheet, enqueueUndo, openSheet, receive, setQ, stepQ, store as s } from '../store.ts';
import type { Tab } from '../store.ts';
import { isoDate } from '../../shared/dates.ts';
import { fmtNum, parseNum } from '../../shared/text.ts';
import { api } from '../api.ts';
import { hourToTime } from './components/bits.ts';
import { itemToFields } from './components/sheets.ts';
import { TOUR_STEPS } from './components/tour.ts';
import { afterState, commit, enterDemo, exitDemo, fail, hooks, sheet, st, sync, toast } from './helpers.ts';
import { barcodeActions, takeBarcodePhoto } from './barcode/actions.ts';
import { cookStateFor, cookingActions } from './cooking/actions.ts';
import { dealsActions, loadDeals, loadStores } from './deals/actions.ts';
import { eventActions } from './events/actions.ts';
import { frameActions } from './frame-actions.ts';
import { loadPrices } from './stats.ts';
import { itemActions } from './items/actions.ts';
import { jobActions } from './jobs/actions.ts';
import { pump, refresh, visibleLowItems } from './logging.ts';
import { nutritionActions } from './nutrition/actions.ts';
import { presetActions } from './presets/actions.ts';
import { shoppingText } from './screens/pantry.ts';
import { loadData, settingsActions } from './settings/actions.ts';
import { spendActions } from './spend/actions.ts';

export { afterState, commit, hooks, sync, toast };

function goTourStep(idx: number): void {
  const clamped = Math.max(0, Math.min(TOUR_STEPS.length - 1, idx));
  const step = TOUR_STEPS[clamped]!;
  closeSheet(s);
  const tabChanged = s.ui.tab !== step.tab || s.ui.page.length > 0;
  s.ui.page = [];
  s.ui.tab = step.tab;
  s.ui.tour = { step: clamped };
  if (tabChanged && typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
    window.scrollTo(0, 0);
  }
}
const core: Record<string, (el: HTMLElement) => void | Promise<unknown>> = {
  rerender: () => {},
  go: el => { s.ui.newToken = null; s.ui.newCode = null; s.ui.page.push(el.dataset.p!); if (el.dataset.p === 'data') void loadData();
    if (el.dataset.p === 'deals') void loadDeals();
    if (el.dataset.p === 'stores') void loadStores(); history.pushState(null, ''); window.scrollTo(0, 0); },
  back: () => history.back(),
  tab: el => { if (s.ui.page.length) history.go(-s.ui.page.length); s.ui.tab = el.dataset.tab as Tab; s.ui.page = []; window.scrollTo(0, 0); },
  close: () => closeSheet(s),
  share: async () => {
    const text = shoppingText(visibleLowItems(st()), s.ui.dealsPlan ?? null, isoDate(st().now));
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
    if (d.s === 'item' && it) {
      const portionMode = !!(it.is_cooked && it.portion_g != null);
      const rawUsual = v.usual[id] ?? it.step;
      const mainQ = portionMode ? Math.round((rawUsual / it.portion_g!) * 100) / 100 || 1 : rawUsual;
      openSheet(s, { t: 'item', id, q: { main: mainQ }, portionMode }, itemToFields(it));
      loadPrices(id, commit);
    } else if (d.s === 'preset' && p) {
      openSheet(s, { t: 'preset', id, q: lines(p.lines) });
    } else if (d.s === 'presetEdit') {
      openSheet(s, { t: 'presetEdit', id: p?.id, q: lines(p?.lines ?? []), lines: p?.lines.map(l => l.item_id) ?? [] }, { name: p?.name ?? '', emoji: p?.emoji ?? '🍽️', time: hourToTime(p?.hour ?? 8) });
    } else if (d.s === 'event' && e?.lines.some(l => l.item_id === v.jolly_id)) {
      const l = e.lines[0]!, n = (x: number | null | undefined) => (x == null ? '' : String(x));
      openSheet(s, { t: 'eatOut', id: e.cid, q: {} }, { eoNote: e.note ?? '', eoKcal: n(l.kcal), eoP: n(l.protein_g), eoF: n(l.fat_g), eoC: n(l.carbs_g) });
    } else if (d.s === 'eatOut') {
      openSheet(s, { t: 'eatOut', q: {} }, { eoNote: '', eoKcal: '', eoP: '', eoF: '', eoC: '' });
    } else if (d.s === 'event' && e) {
      openSheet(s, { t: 'event', id: e.cid, q: lines(e.lines.map(l => ({ item_id: l.item_id, qty: l.is_set ? l.qty : Math.abs(l.qty) }))) });
    } else if (d.s === 'compose') {
      openSheet(s, { t: 'compose', q: {}, mode: s.ui.jobMode });
    } else if (d.s === 'review') {
      const job = v.jobs.find(j => j.id === id);
      const events = structuredClone(job?.result?.events ?? []);
      const cook = structuredClone(job?.result?.cook ?? []);
      const eatOut = structuredClone(job?.result?.eat_out ?? []);
      const existingTotal = events.find(ev => ev.total_cost != null)?.total_cost;
      const lineSum = events.flatMap(ev => ev.kind === 'buy' ? ev.lines : []).reduce((acc, l) => acc + (l.price ?? 0), 0);
      const hasPrices = events.some(ev => ev.kind === 'buy' && ev.lines.some(l => l.price != null));
      const reviewTotalCost = job?.mode === 'audit' ? ''
        : existingTotal != null ? fmtNum(existingTotal)
        : hasPrices ? fmtNum(lineSum)
        : '';
      openSheet(s, { t: 'review', id, q: {}, events, orig: structuredClone(events), cook, origCook: structuredClone(cook), eatOut }, { reviewTotalCost });
    } else if (d.s === 'cook') {
      const ck = cookStateFor(it?.is_cooked ? it : undefined, v.now);
      openSheet(s, { t: 'cook', id: it?.is_cooked ? it.id : undefined, q: ck.q, lines: ck.lines }, ck.fields);
    } else if (d.s === 'barcode') {
      s.ui.barcodeLookup = null;
      s.ui.barcodeBusy = false;
      openSheet(s, { t: 'barcode', q: { bc: 1 } }, { barcodeCode: '', buyCost: '', bcLinkItem: '', bcMode: 'pack' });
      takeBarcodePhoto(); // inside the click so iOS keeps user activation
    } else if (d.s === 'expense') {
      openSheet(s, { t: 'expense', q: {} }, { expCost: '', expNote: '', expDate: isoDate(v.now) });
    }
  },
  step: el => stepQ(sheet(), el.dataset.k!, Number(el.dataset.d), Number(el.dataset.s)),
  numedit: el => { s.ui.editing = el.dataset.k!; },
  num: el => {
    const v = parseNum((el as HTMLInputElement).value);
    if (Number.isNaN(v)) toast("That's not a number");
    else setQ(sheet(), el.dataset.k!, v);
    s.ui.editing = null;
  },
  numend: () => { s.ui.editing = null; },
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
  login: async () => {
    const code = (s.ui.f.code ?? '').trim().toLowerCase();
    if (!code) return;
    try { receive(s, await api('POST', '/api/login', { code })); s.ui.f.code = ''; afterState(); } catch (e) { fail(e); }
  },
  startDemo: () => { enterDemo({ tour: true }); },
  exitDemo: () => { exitDemo(); void refresh(); void pump(); },
  tourStart: () => { goTourStep(0); },
  tourNext: () => {
    const cur = s.ui.tour?.step ?? 0;
    if (cur + 1 >= TOUR_STEPS.length) s.ui.tour = null;
    else goTourStep(cur + 1);
  },
  tourPrev: () => {
    const cur = s.ui.tour?.step ?? 0;
    if (cur > 0) goTourStep(cur - 1);
  },
  tourSkip: () => { s.ui.tour = null; },
};

export const actions: Record<string, (el: HTMLElement) => void | Promise<unknown>> = {
  ...core, ...itemActions, ...presetActions, ...eventActions, ...cookingActions, ...barcodeActions, ...jobActions,
  ...settingsActions, ...dealsActions, ...nutritionActions, ...spendActions, ...frameActions,
};
