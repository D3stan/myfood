import { bumpRev, get, getMeta, run, transaction } from '../db.ts';
import type { Db } from '../db.ts';
import { listStores } from './repo.ts';
import { fetchTjek } from './providers/tjek.ts';

export interface SyncDeps { fetch: typeof fetch; now: () => number }
export interface SyncResult { stores: { id: string; ok: boolean; error?: string; newOffers: number }[]; newOffers: number }

export async function syncStores(db: Db, deps: SyncDeps): Promise<SyncResult> {
  const where = {
    lat: Number(getMeta(db, 'deals_lat') ?? 55.6761), lng: Number(getMeta(db, 'deals_lng') ?? 12.5683),
    radius: Number(getMeta(db, 'deals_radius_m') ?? 5000),
  };
  const result: SyncResult = { stores: [], newOffers: 0 };
  let changed = false;
  for (const store of listStores(db).filter(s => s.enabled)) {
    try {
      const sources: { provider: string; config: { dealer_id?: string } }[] = JSON.parse(store.sources);
      const fetched: Awaited<ReturnType<typeof fetchTjek>>[] = [];
      for (const s of sources) {
        if (s.provider === 'tjek' && s.config?.dealer_id) fetched.push(await fetchTjek(s.config.dealer_id, where, deps.fetch));
      }
      const at = deps.now();
      const n = transaction(db, () => {
        let added = 0;
        for (const { catalogs, offers } of fetched) {
          const catId = new Map<string, number>();
          for (const c of catalogs) {
            run(db, `INSERT INTO catalogs(store_id, source, external_id, title, valid_from, valid_to, fetched_at) VALUES (?, 'tjek', ?, ?, ?, ?, ?)
              ON CONFLICT(store_id, source, external_id) DO UPDATE SET title = excluded.title, valid_from = excluded.valid_from, valid_to = excluded.valid_to, fetched_at = excluded.fetched_at`,
            store.id, c.external_id, c.title, c.valid_from, c.valid_to, at);
            catId.set(c.external_id, get<{ id: number }>(db, "SELECT id FROM catalogs WHERE store_id = ? AND source = 'tjek' AND external_id = ?", store.id, c.external_id)!.id);
          }
          for (const o of offers) {
            const prev = get<{ price_cents: number; pre_price_cents: number | null; valid_from: string; valid_to: string }>(
              db, "SELECT price_cents, pre_price_cents, valid_from, valid_to FROM offers WHERE store_id = ? AND source = 'tjek' AND external_id = ?", store.id, o.external_id);
            if (!prev) added++;
            else if (prev.price_cents !== o.price_cents || prev.pre_price_cents !== o.pre_price_cents || prev.valid_from !== o.valid_from || prev.valid_to !== o.valid_to) changed = true;
            run(db, `INSERT INTO offers(store_id, catalog_id, source, external_id, title, offer_key, price_cents, pre_price_cents, currency, unit, unit_qty, max_per_customer, ean, valid_from, valid_to, fetched_at)
              VALUES (?, ?, 'tjek', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(store_id, source, external_id) DO UPDATE SET catalog_id = excluded.catalog_id, title = excluded.title, offer_key = excluded.offer_key,
                price_cents = excluded.price_cents, pre_price_cents = excluded.pre_price_cents, currency = excluded.currency, unit = excluded.unit, unit_qty = excluded.unit_qty,
                max_per_customer = excluded.max_per_customer, ean = excluded.ean, valid_from = excluded.valid_from, valid_to = excluded.valid_to, fetched_at = excluded.fetched_at`,
            store.id, catId.get(o.catalog_external_id) ?? null, o.external_id, o.title, o.offer_key, o.price_cents, o.pre_price_cents, o.currency,
            o.unit, o.unit_qty, o.max_per_customer, o.ean, o.valid_from, o.valid_to, at);
          }
        }
        run(db, 'UPDATE stores SET last_synced_at = ?, last_error = NULL WHERE id = ?', at, store.id);
        return added;
      });
      if (n) changed = true;
      result.stores.push({ id: store.id, ok: true, newOffers: n });
      result.newOffers += n;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      run(db, 'UPDATE stores SET last_error = ? WHERE id = ?', error, store.id);
      result.stores.push({ id: store.id, ok: false, error, newOffers: 0 });
    }
  }
  if (changed) bumpRev(db);
  return result;
}
