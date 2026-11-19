import type { Hono } from 'hono';
import { isoDate } from '../../shared/dates.ts';
import type { AppEnv, RouteDeps } from '../route-kit.ts';
import { listCatalogs, listStores } from './repo.ts';
import { syncStores } from './sync.ts';

export function registerDealsRoutes(app: Hono<AppEnv>, { db, now, fetch: fetchFn }: RouteDeps): void {
  app.post('/api/deals/sync', async c => c.json(await syncStores(db, { fetch: fetchFn ?? fetch, now })));
  app.get('/api/deals/catalogs', c => c.json({
    stores: listStores(db).map(({ id, name, emoji, enabled, last_synced_at, last_error }) => ({ id, name, emoji, enabled: !!enabled, last_synced_at, last_error })),
    catalogs: listCatalogs(db, isoDate(now())),
  }));
}
