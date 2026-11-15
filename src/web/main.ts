import '@fontsource/patrick-hand/400.css';
import '@fontsource/permanent-marker/400.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import { registerSW } from 'virtual:pwa-register';
import { applyOps } from '../shared/stock.ts';
import type { EventBody } from '../shared/types.ts';
import { useFake } from './api.ts';
import { load } from './outbox.ts';
import { store as s } from './store.ts';
import { commit, hooks, pump, refresh } from './ui/actions.ts';
import { wire } from './ui/events.ts';

const saved = load();
s.server = saved.server;
s.pending = saved.pending;
s.ui.online = navigator.onLine;
s.ui.standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;

// `npx vite` alone: ?fixture serves tests/fixture.ts and applies events locally.
const fixture = import.meta.env.DEV && location.search.includes('fixture');
if (import.meta.env.DEV && fixture) {
  let st = structuredClone((await import('../../tests/fixture.ts')).fixture);
  s.server = null; s.pending = [];
  useFake(async (method, path, body) => {
    const op = path === '/api/events' ? { type: 'event' as const, body: body as EventBody }
      : method === 'DELETE' && path.startsWith('/api/events/') ? { type: 'undo' as const, cid: path.split('/').pop()! } : null;
    st = { ...(op ? applyOps(st, [op]) : st), rev: st.rev + 1 };
    return st;
  });
}

// A newer build is deployed: update the service worker and reload once, when no sheet is open.
let reg: ServiceWorkerRegistration | undefined;
let updating = false;
if (!fixture) registerSW({ immediate: true, onRegisteredSW: (_url, r) => { reg = r; } });
hooks.state = async () => {
  const b = s.server?.build;
  if (!b || b === 'dev' || __BUILD__ === 'dev' || b === __BUILD__ || s.ui.sheet || updating) return;
  try {
    if (sessionStorage.getItem('myfood:reloaded') === b) return; // already tried: do not loop
    sessionStorage.setItem('myfood:reloaded', b);
  } catch { return; }
  updating = true;
  await reg?.update().catch(() => {});
  await Promise.race([
    new Promise(r => navigator.serviceWorker?.addEventListener('controllerchange', r, { once: true })),
    new Promise(r => setTimeout(r, 4000)),
  ]);
  location.reload();
};

wire();
commit();
void refresh();
void pump();

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { void refresh(); void pump(); } });
addEventListener('focus', () => void pump());
addEventListener('online', () => { s.ui.online = true; commit(); void pump(); void refresh(); });
addEventListener('offline', () => { s.ui.online = false; commit(); });

// Refresh every 30 s while visible, every 2 s while a job is working; retry queued ops every 10 s.
let tick = 0;
setInterval(() => {
  if (document.visibilityState !== 'visible' || !s.server) return;
  tick++;
  const working = s.server.jobs.some(j => j.status === 'queued' || j.status === 'running');
  if (tick % (working ? 2 : 30) === 0) void refresh();
  if (s.pending.length && tick % 10 === 0) void pump();
}, 1000);
