// Shared by actions: render, toast, API mutate, session end. Kept out of actions.ts so feature action modules need no cycle.
import { ApiError, api, onUnauthorized } from '../api.ts';
import { clear, save } from '../outbox.ts';
import { parseCostCents } from '../../shared/text.ts';
import { receive, store as s, view } from '../store.ts';
import { render } from './render.ts';

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

export const signedOut = (): void => {
  s.server = null; s.pending = []; s.ui.loggedOut = true; s.ui.sheet = null; s.ui.tab = 'pantry';
  s.ui.newToken = null; s.ui.newCode = null; s.ui.data = null; s.ui.stats = { spend: {}, nutrition: {} }; s.ui.prices = {}; s.ui.barcodeLookup = null; s.ui.page = [];
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
