// Deals page and Settings > Stores.
import { getDealsInfo, getDealsPlan, syncDeals } from '../../api.ts';
import { store as s } from '../../store.ts';
import { commit, fail, mutate, toast } from '../helpers.ts';
import { refresh } from '../logging.ts';

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
