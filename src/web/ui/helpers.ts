// Shared by actions: render, toast, API mutate, session end. Kept out of actions.ts so feature action modules need no cycle.
import { ApiError, api, onUnauthorized, useFake } from '../api.ts';
import { createDemoApi, createDemoState } from '../demo.ts';
import { clear, load, save } from '../outbox.ts';
import { parseCostCents } from '../../shared/text.ts';
import { receive, store as s, view } from '../store.ts';
import { render } from './render.ts';

export const hooks: { state?: () => void } = {};

export const commit = (): void => render(s);
export const sync = (): void => { if (!s.ui.demo) save(s); commit(); };

let toastId = 0, toastTimer = 0;
export function toast(msg: string, cids?: string[]): void {
  const id = ++toastId;
  s.ui.toast = { id, msg, cids };
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { if (s.ui.toast?.id === id) { s.ui.toast = null; commit(); } }, 5000);
}
export const fail = (e: unknown): void => toast(e instanceof ApiError ? e.message : 'Something went wrong');

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

export async function mutate(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<boolean> {
  if (!navigator.onLine) { toast("You're offline"); return false; }
  try { receive(s, await api(method, path, body)); afterState(); return true; } catch (e) { fail(e); return false; }
}

function resetSessionUi(): void {
  s.pending = [];
  s.inflight.clear();
  s.flushing = false;
  s.ui.sheet = null;
  s.ui.tab = 'pantry';
  s.ui.page = [];
  s.ui.toast = null;
  s.ui.editing = null;
  s.ui.newToken = null;
  s.ui.newCode = null;
  s.ui.data = null;
  s.ui.stats = { spend: {}, nutrition: {} };
  s.ui.prices = {};
  s.ui.deals = {};
  s.ui.barcodeLookup = null;
  s.ui.seenDone.clear();
  s.ui.f = {};
  s.ui.frames = {};
  s.ui.ownerFilter = 'all';
  s.ui.historyScope = 'me';
  s.ui.spendScope = 'all';
  for (const f of s.ui.files) {
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(f.url);
  }
  s.ui.files = [];
}

export function enterDemo(opts: { tour?: boolean; now?: number } = {}): void {
  resetSessionUi();
  const demoState = createDemoState(opts.now);
  useFake(createDemoApi(demoState));
  s.server = demoState;
  s.ui.demo = true;
  s.ui.loggedOut = false;
  s.ui.tour = opts.tour === false ? null : { step: 0 };
  commit();
}

export function exitDemo(): void {
  resetSessionUi();
  useFake(null);
  s.ui.demo = false;
  s.ui.tour = null;
  if (typeof location !== 'undefined' && typeof history !== 'undefined' && typeof history.replaceState === 'function') {
    const url = new URL(location.href);
    if (url.searchParams.has('demo')) {
      url.searchParams.delete('demo');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  }
  const saved = load();
  s.server = saved.server;
  s.pending = saved.pending;
  s.ui.loggedOut = !saved.server;
  commit();
}

export const signedOut = (): void => {
  if (s.ui.demo) { exitDemo(); return; }
  s.server = null; s.pending = []; s.ui.loggedOut = true; s.ui.sheet = null; s.ui.tab = 'pantry';
  s.ui.newToken = null; s.ui.newCode = null; s.ui.data = null; s.ui.stats = { spend: {}, nutrition: {} }; s.ui.prices = {}; s.ui.deals = {}; s.ui.barcodeLookup = null; s.ui.page = [];
  clear(); commit();
};
onUnauthorized(signedOut);

export const st = () => view(s)!;
export const sheet = () => s.ui.sheet!;

export const parseOptCostCents = (raw: string | undefined): number | null | 'invalid' => {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const c = parseCostCents(t);
  return Number.isNaN(c) ? 'invalid' : c;
};
