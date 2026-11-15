// Pending operations and the last server state live in localStorage. Only two kinds of op exist (log an event, undo an event); both are idempotent by cid.
import { ApiError } from './api.ts';
import { dropOp, receive } from './store.ts';
import type { Store } from './store.ts';
import type { PendingOp, State } from '../shared/types.ts';

const KEY = 'myfood:v1';

export function load(): { server: State | null; pending: PendingOp[] } {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (typeof j?.server?.rev === 'number' && Array.isArray(j.pending)) return j;
  } catch { /* storage blocked or corrupt: start empty */ }
  return { server: null, pending: [] };
}

export function save(s: Store): void {
  try { localStorage.setItem(KEY, JSON.stringify({ server: s.server, pending: s.pending })); } catch { /* full or blocked */ }
}

export function clear(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/**
 * Sends queued ops one at a time, oldest first. A network failure or a 5xx keeps the op for a later retry;
 * a 4xx drops it. Returns the last error message worth showing, if any.
 */
export async function flush(s: Store, send: (op: PendingOp) => Promise<State>): Promise<string | null> {
  if (s.flushing) return null;
  s.flushing = true;
  let err: string | null = null;
  try {
    for (let op = s.pending[0]; op; op = s.pending[0]) {
      const cid = op.type === 'event' ? op.body.cid : null;
      if (cid) s.inflight.add(cid);
      try {
        const st = await send(op);
        dropOp(s, op);
        receive(s, st);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500) return err;
        dropOp(s, op);
        err = e.message;
      } finally {
        if (cid) s.inflight.delete(cid);
      }
    }
  } finally { s.flushing = false; }
  return err;
}
