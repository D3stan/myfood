import type { Hono } from 'hono';
import { isoDate } from '../../shared/dates.ts';
import { DealLocationBody, DealMatchBody, DealStoreBody } from '../../shared/types.ts';
import { get } from '../db.ts';
import { fail } from '../domain.ts';
import type { AppEnv, RouteDeps } from '../route-kit.ts';
import { buildPlan } from './plan.ts';
import { dealsInfo, itemDeals, linkOffer, setLocation, setStoreEnabled } from './repo.ts';
import { syncStores } from './sync.ts';

export function registerDealsRoutes(app: Hono<AppEnv>, { db, now, state, fetch: fetchFn, matchOffers, json, parse, id }: RouteDeps): void {
  app.post('/api/deals/sync', async c => c.json(await syncStores(db, { fetch: fetchFn ?? fetch, now, matchOffers })));
  app.get('/api/deals/catalogs', c => c.json(dealsInfo(db, isoDate(now()))));
  app.get('/api/deals/plan', c => c.json(buildPlan(db, now())));
  app.put('/api/deals/stores/:id', async c => {
    const b = parse(DealStoreBody, await json(c));
    setStoreEnabled(db, c.req.param('id'), b.enabled);
    return c.json(state(c.get('uid')));
  });
  app.put('/api/deals/location', async c => {
    setLocation(db, parse(DealLocationBody, await json(c)));
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
