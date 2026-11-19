import type { Hono } from 'hono';
import { isoDate } from '../../shared/dates.ts';
import { DealMatchBody } from '../../shared/types.ts';
import { bumpRev, get } from '../db.ts';
import { fail } from '../domain.ts';
import type { AppEnv, RouteDeps } from '../route-kit.ts';
import { itemDeals, listCatalogs, listStores, setMatch } from './repo.ts';
import { syncStores } from './sync.ts';

export function registerDealsRoutes(app: Hono<AppEnv>, { db, now, fetch: fetchFn, matchOffers, json, parse, id }: RouteDeps): void {
  app.post('/api/deals/sync', async c => c.json(await syncStores(db, { fetch: fetchFn ?? fetch, now, matchOffers })));
  app.get('/api/deals/catalogs', c => c.json({
    stores: listStores(db).map(({ id, name, emoji, enabled, last_synced_at, last_error }) => ({ id, name, emoji, enabled: !!enabled, last_synced_at, last_error })),
    catalogs: listCatalogs(db, isoDate(now())),
  }));
  app.post('/api/deals/match', async c => {
    const b = parse(DealMatchBody, await json(c));
    if (!get(db, 'SELECT 1 FROM offers WHERE offer_key = ?', b.offer_key)) fail(404, 'No such offer');
    if (b.item_id !== null && !get(db, 'SELECT 1 FROM items WHERE id = ?', b.item_id)) fail(404, 'No such item');
    setMatch(db, b.offer_key, b.item_id, b.qty_per_pack ?? null, 1, 'manual', now(), true);
    bumpRev(db);
    return c.json({ offer_key: b.offer_key, item_id: b.item_id });
  });
  app.get('/api/items/:id/deals', c => {
    const itemId = id(c);
    if (!get(db, 'SELECT 1 FROM items WHERE id = ?', itemId)) fail(404, 'No such item');
    return c.json(itemDeals(db, itemId, isoDate(now())));
  });
}
