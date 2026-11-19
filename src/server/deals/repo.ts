import { all } from '../db.ts';
import type { Db } from '../db.ts';

export interface StoreRow { id: string; name: string; emoji: string; sources: string; enabled: number; last_synced_at: number | null; last_error: string | null }
export interface CatalogRow { id: number; store_id: string; title: string; valid_from: string; valid_to: string; offer_count: number }

export const listStores = (db: Db): StoreRow[] => all<StoreRow>(db, 'SELECT * FROM stores ORDER BY name');

/** Catalogs still running or upcoming on `today` (YYYY-MM-DD). */
export const listCatalogs = (db: Db, today: string): CatalogRow[] => all<CatalogRow>(db, `
  SELECT c.id, c.store_id, c.title, c.valid_from, c.valid_to, (SELECT COUNT(*) FROM offers o WHERE o.catalog_id = c.id) AS offer_count
  FROM catalogs c WHERE c.valid_to >= ? ORDER BY c.valid_from, c.store_id`, today);
