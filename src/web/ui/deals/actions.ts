// Deals page and Settings > Stores.
import { getDealsInfo, getDealsPlan, syncDeals } from '../../api.ts';
import { enqueueEvent, store as s } from '../../store.ts';
import { commit, fail, mutate, sync, toast } from '../helpers.ts';
import { pump, refresh } from '../logging.ts';

export async function loadDeals(): Promise<void> {
  try { s.ui.dealsPlan = await getDealsPlan(); } catch (e) { fail(e); }
  commit();
}
export async function loadStores(): Promise<void> {
  try { s.ui.dealsInfo = await getDealsInfo(); } catch (e) { fail(e); }
  commit();
}

export const dealsActions: Record<string, (el: HTMLElement) => void | Promise<unknown>> = {
  syncDeals: async () => {
    if (!navigator.onLine) return void toast("You're offline");
    toast('Syncing… this can take a minute');
    try { await syncDeals(); } catch (e) { return void fail(e); }
    toast('Synced');
    await Promise.all([loadDeals(), loadStores(), refresh()]);
  },
  // Queued like any other buy (works offline); the offer price is what gets logged, a scanned receipt stays the precise record.
  boughtTrip: async el => {
    const p = s.ui.dealsPlan, t = p?.trips[Number(el.dataset.n)];
    if (!p || !t || t.date !== p.today) return;
    const cid = enqueueEvent(s, { kind: 'buy', note: t.store_name, lines: t.items.map(i => ({ item_id: i.item_id, qty: i.packs * i.qty_per_pack, cost_cents: i.packs * i.price_cents })) });
    s.ui.dealsPlan = { ...p, trips: p.trips.filter(x => x !== t) };
    toast(`Logged the ${t.store_name} trip`, [cid]);
    sync();
    await pump();
    if (s.ui.online) await loadDeals();
  },
  toggleStore: async el => {
    if (await mutate('PUT', `/api/deals/stores/${el.dataset.id}`, { enabled: (el as HTMLInputElement).checked })) await Promise.all([loadStores(), loadDeals()]);
  },
  saveDealLocation: async () => {
    const f = s.ui.f, d = s.ui.dealsInfo;
    const lat = Number(f.dealLat ?? d?.lat), lng = Number(f.dealLng ?? d?.lng), radius_m = Number(f.dealRadius ?? d?.radius_m);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isInteger(radius_m) || radius_m < 100) return void toast('Check the location');
    if (await mutate('PUT', '/api/deals/location', { lat, lng, radius_m })) { delete f.dealLat; delete f.dealLng; delete f.dealRadius; toast('Saved'); await loadStores(); }
  },
};
