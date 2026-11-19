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
import { commit, hooks } from './ui/actions.ts';
import { enterDemo } from './ui/helpers.ts';
import { pump, refresh } from './ui/logging.ts';
import { wire } from './ui/events.ts';

s.ui.online = navigator.onLine;
s.ui.standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
s.ui.pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
s.ui.pushPermission = s.ui.pushSupported ? Notification.permission : 'unsupported';

const demo = new URLSearchParams(location.search).has('demo');
// `npx vite` alone: ?fixture serves tests/fixture.ts and applies events locally.
const fixture = !demo && import.meta.env.DEV && location.search.includes('fixture');
if (demo) {
  enterDemo({ tour: true });
} else if (import.meta.env.DEV && fixture) {
  let st = structuredClone((await import('../../tests/fixture.ts')).fixture);
  s.server = null; s.pending = [];
  useFake(async (method, path, body) => {
    if (path === '/api/data') return { aliases: [], archived: [] } as never;
    if (path.startsWith('/api/stats/')) return { paid: [], ate: [], rows: [] } as never;
    if (path.endsWith('/prices')) return [] as never;
    if (path.endsWith('/deals')) return { normal: null, offers: [] } as never;
    if (path === '/api/deals/plan') return { generated_at: 0, today: '', trips: [], items: [], total_saving_cents: 0 } as never;
    if (path === '/api/deals/catalogs') return { stores: [], catalogs: [], lat: 55.6761, lng: 12.5683, radius_m: 5000 } as never;
    if (path === '/api/deals/sync') return { stores: [], newOffers: 0 } as never;
    const op = path === '/api/events' ? { type: 'event' as const, body: body as EventBody }
      : method === 'DELETE' && path.startsWith('/api/events/') ? { type: 'undo' as const, cid: path.split('/').pop()! } : null;
    st = { ...(op ? applyOps(st, [op]) : st), rev: st.rev + 1 };
    return st;
  });
} else {
  const saved = load();
  s.server = saved.server;
  s.pending = saved.pending;
}

// A newer build is deployed: update the service worker and reload once, when no sheet is open.
let reg: ServiceWorkerRegistration | undefined;
let updating = false;
async function syncPushState(r?: ServiceWorkerRegistration): Promise<void> {
  if (s.ui.demo || !s.ui.pushSupported) return;
  s.ui.pushPermission = Notification.permission;
  const activeReg = r ?? reg ?? (await navigator.serviceWorker?.getRegistration().catch(() => undefined));
  if (!activeReg?.pushManager) return;
  const sub = await activeReg.pushManager.getSubscription().catch(() => null);
  if (s.server && s.server.push_subscribed !== !!sub) {
    s.server = { ...s.server, push_subscribed: !!sub };
    commit();
  }
}
if (!fixture && !demo) registerSW({ immediate: true, onRegisteredSW: (_url, r) => { reg = r; void syncPushState(r); } });
hooks.state = async () => {
  const b = s.server?.build;
  if (s.ui.demo || !b || b === 'dev' || __BUILD__ === 'dev' || b === __BUILD__ || s.ui.sheet || updating) return;
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

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { void refresh(); void pump(); void syncPushState(); } });
addEventListener('focus', () => { void pump(); void syncPushState(); });
addEventListener('popstate', () => { s.ui.page.pop(); commit(); });
addEventListener('online', () => { s.ui.online = true; commit(); void pump(); void refresh(); });
addEventListener('offline', () => { s.ui.online = false; commit(); });

// Refresh every 30 s while visible, every 2 s while a job is working; retry queued ops every 10 s.
let tick = 0;
setInterval(() => {
  if (document.visibilityState !== 'visible' || !s.server || s.ui.demo) return;
  tick++;
  const working = s.server.jobs.some(j => j.status === 'queued' || j.status === 'running');
  if (tick % (working ? 2 : 30) === 0) void refresh();
  if (s.pending.length && tick % 10 === 0) void pump();
}, 1000);
