import type { Hono } from 'hono';
import { BarcodeLinkBody, ItemBody, ItemPatch } from '../../shared/types.ts';
import { linkBarcode, resolveBarcode } from '../barcodes.ts';
import { get } from '../db.ts';
import { fail } from '../domain.ts';
import { itemPrices } from '../events/repo.ts';
import type { AppEnv, RouteDeps } from '../route-kit.ts';
import { archiveItem, createItem, deleteAlias, listData, patchItem, restoreItem } from './repo.ts';

export function registerItemRoutes(
  app: Hono<AppEnv>,
  { db, now, state, json, parse, id, lookupBarcode }: RouteDeps,
): void {
  app.get('/api/data', c => c.json(listData(db)));

  // Level items have no per-unit price, so their history is empty.
  app.get('/api/items/:id/prices', c => {
    const itemId = id(c);
    const item = get<{ unit: string }>(db, 'SELECT unit FROM items WHERE id = ?', itemId);
    if (!item) fail(404, 'No such item');
    return c.json(item!.unit === 'level' ? [] : itemPrices(db, itemId));
  });

  app.post('/api/items', async c => {
    createItem(db, parse(ItemBody, await json(c)), now());
    return c.json(state(c.get('uid')));
  });
  app.patch('/api/items/:id', async c => {
    patchItem(db, id(c), parse(ItemPatch, await json(c)));
    return c.json(state(c.get('uid')));
  });
  app.post('/api/items/:id/restore', c => {
    restoreItem(db, id(c));
    return c.json(state(c.get('uid')));
  });
  app.delete('/api/aliases/:text', c => {
    deleteAlias(db, c.req.param('text'));
    return c.json(state(c.get('uid')));
  });
  app.delete('/api/items/:id', c => {
    archiveItem(db, id(c), now());
    return c.json(state(c.get('uid')));
  });

  app.get('/api/barcodes/:code', async c => {
    const refresh = c.req.query('refresh');
    const forceRefresh = refresh === '1' || refresh === 'true';
    const lookup = await resolveBarcode(db, c.req.param('code'), lookupBarcode, now(), { forceRefresh });
    return c.json(lookup);
  });
  app.post('/api/barcodes/link', async c => {
    const body = parse(BarcodeLinkBody, await json(c));
    linkBarcode(db, body.code, body.item_id, now());
    return c.json(state(c.get('uid')));
  });
}
