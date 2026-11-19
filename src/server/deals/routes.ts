import type { Hono } from 'hono';
import { isoDate } from '../../shared/dates.ts';
import { DealLocationBody, DealMatchBody, DealStoreBody } from '../../shared/types.ts';
import { bumpRev, get, getMeta, run, setMeta, transaction } from '../db.ts';
import { fail } from '../domain.ts';
import type { AppEnv, RouteDeps } from '../route-kit.ts';
import { buildPlan } from './plan.ts';
import { itemDeals, listCatalogs, linkOffer, listStores } from './repo.ts';
import { syncStores } from './sync.ts';

export function registerDealsRoutes(app: Hono<AppEnv>, { db, now, state, fetch: fetchFn, matchOffers, json, parse, id }: RouteDeps): void {
  app.post('/api/deals/sync', async c => c.json(await syncStores(db, { fetch: fetchFn ?? fetch, now, matchOffers })));
  app.get('/api/deals/catalogs', c => c.json({
    stores: listStores(db).map(({ id, name, emoji, enabled, last_synced_at, last_error }) => ({ id, name, emoji, enabled: !!enabled, last_synced_at, last_error })),
    catalogs: listCatalogs(db, isoDate(now())),
    lat: Number(getMeta(db, 'deals_lat')), lng: Number(getMeta(db, 'deals_lng')), radius_m: Number(getMeta(db, 'deals_radius_m')),
  }));
  app.get('/api/deals/plan', c => c.json(buildPlan(db, now())));
  app.put('/api/deals/stores/:id', async c => {
    const b = parse(DealStoreBody, await json(c));
    if (!get(db, 'SELECT 1 FROM stores WHERE id = ?', c.req.param('id'))) fail(404, 'No such store');
    run(db, 'UPDATE stores SET enabled = ? WHERE id = ?', b.enabled ? 1 : 0, c.req.param('id'));
    bumpRev(db);
    return c.json(state(c.get('uid')));
  });
  app.put('/api/deals/location', async c => {
    const b = parse(DealLocationBody, await json(c));
    transaction(db, () => { setMeta(db, 'deals_lat', String(b.lat)); setMeta(db, 'deals_lng', String(b.lng)); setMeta(db, 'deals_radius_m', String(b.radius_m)); bumpRev(db); });
    return c.json(state(c.get('uid')));
  });
  app.post('/api/deals/match', async c => {
    const b = parse(DealMatchBody, await json(c));
    linkOffer(db, b.offer_key, b.item_id, b.qty_per_pack ?? null, now());
    return c.json({ offer_key: b.offer_key, item_id: b.item_id });
  });
  app.get('/api/items/:id/deals', c => {
    const itemId = id(c);
    if (!get(db, 'SELECT 1 FROM items WHERE id = ?', itemId)) fail(404, 'No such item');
    return c.json(itemDeals(db, itemId, isoDate(now())));
  });
}
