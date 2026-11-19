import { isoDate } from '../../shared/dates.ts';
import { DEFAULT_CURRENCY } from '../../shared/currency.ts';
import type { DealsInfo, ItemDeals, NormalPrice } from '../../shared/types.ts';
import { all, bumpRev, get, getMeta, run, setMeta, transaction } from '../db.ts';
import { fail } from '../domain.ts';
import type { Db } from '../db.ts';
import { PRICED_BUYS } from '../events/repo.ts';

export interface StoreRow { id: string; name: string; emoji: string; sources: string; enabled: number; last_synced_at: number | null; last_error: string | null }
export interface CatalogRow { id: number; store_id: string; title: string; valid_from: string; valid_to: string; offer_count: number }

export const listStores = (db: Db): StoreRow[] => all<StoreRow>(db, 'SELECT * FROM stores ORDER BY name');

/** Catalogs still running or upcoming on `today` (YYYY-MM-DD). */
export const listCatalogs = (db: Db, today: string): CatalogRow[] => all<CatalogRow>(db, `
  SELECT c.id, c.store_id, c.title, c.valid_from, c.valid_to, (SELECT COUNT(*) FROM offers o WHERE o.catalog_id = c.id) AS offer_count
  FROM catalogs c WHERE c.valid_to >= ? ORDER BY c.valid_from, c.store_id`, today);

/** Stores, upcoming catalogs and location: the body of GET /api/deals/catalogs and the extra context of `get_shopping_plan`. */
export const dealsInfo = (db: Db, today: string): DealsInfo => ({
  stores: listStores(db).map(({ id, name, emoji, enabled, last_synced_at, last_error }) => ({ id, name, emoji, enabled: !!enabled, last_synced_at, last_error })),
  catalogs: listCatalogs(db, today),
  lat: Number(getMeta(db, 'deals_lat')), lng: Number(getMeta(db, 'deals_lng')), radius_m: Number(getMeta(db, 'deals_radius_m')),
});

/** Household-wide: turns a store's offers on or off for everyone. */
export function setStoreEnabled(db: Db, storeId: string, enabled: boolean): void {
  if (!get(db, 'SELECT 1 FROM stores WHERE id = ?', storeId)) fail(404, 'No such store');
  run(db, 'UPDATE stores SET enabled = ? WHERE id = ?', enabled ? 1 : 0, storeId);
  bumpRev(db);
}

export function setLocation(db: Db, loc: { lat: number; lng: number; radius_m: number }): void {
  transaction(db, () => { setMeta(db, 'deals_lat', String(loc.lat)); setMeta(db, 'deals_lng', String(loc.lng)); setMeta(db, 'deals_radius_m', String(loc.radius_m)); bumpRev(db); });
}

/** Stores a match. A null `qty` falls back to the offer's own pack size when its unit is the item's. `replace` overwrites an earlier match (manual edits). */
export function setMatch(db: Db, offerKey: string, itemId: number | null, qty: number | null, confidence: number, source: string, now: number, replace = false): void {
  run(db, `INSERT OR ${replace ? 'REPLACE' : 'IGNORE'} INTO offer_matches(offer_key, item_id, qty_per_pack, confidence, source, updated_at)
    VALUES (?1, ?2, CASE WHEN ?2 IS NULL THEN NULL ELSE COALESCE(?3, (SELECT o.unit_qty FROM offers o JOIN items i ON i.id = ?2 AND i.unit = o.unit WHERE o.offer_key = ?1 LIMIT 1)) END, ?4, ?5, ?6)`,
  offerKey, itemId, qty, confidence, source, now);
}

/** A manual link (or ignore, with a null item) of an offer_key; replaces any earlier match. */
export function linkOffer(db: Db, offerKey: string, itemId: number | null, qty: number | null, now: number): void {
  if (!get(db, 'SELECT 1 FROM offers WHERE offer_key = ?', offerKey)) fail(404, 'No such offer');
  if (itemId !== null && !get(db, 'SELECT 1 FROM items WHERE id = ?', itemId)) fail(404, 'No such item');
  setMatch(db, offerKey, itemId, qty, 1, 'manual', now, true);
  bumpRev(db);
}

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

/** Matched, in-currency offers of an item with a usable pack size (`unit_cents` = price per 1 item unit). */
function itemOffers(db: Db, itemId: number) {
  return all<{ id: number; store_id: string; store_name: string; store_emoji: string; title: string; price_cents: number; pre_price_cents: number | null; unit_cents: number; valid_from: string; valid_to: string }>(db, `
    SELECT o.id, o.store_id, s.name AS store_name, s.emoji AS store_emoji, o.title, o.price_cents, o.pre_price_cents, o.price_cents * 1.0 / m.qty_per_pack AS unit_cents, o.valid_from, o.valid_to
    FROM offers o JOIN offer_matches m ON m.offer_key = o.offer_key JOIN stores s ON s.id = o.store_id
    WHERE m.item_id = ? AND m.qty_per_pack > 0 AND o.currency = ? ORDER BY o.valid_from, o.price_cents`, itemId, getMeta(db, 'currency') ?? DEFAULT_CURRENCY);
}

/**
 * What the item usually costs per 1 unit: median of its last 10 priced buys that were not bought on offer, else its learned price.
 * (An offer's own pre_price is per offer and handled in `itemDeals`.)
 */
export function normalPrice(db: Db, itemId: number): NormalPrice | null {
  const item = get<{ unit: string; cost: number | null }>(db, 'SELECT unit, cost_per_unit_cents AS cost FROM items WHERE id = ?', itemId);
  if (!item || item.unit === 'level') return null;
  const offers = itemOffers(db, itemId);
  // A buy is promo when its day is inside a matched offer and its price is within 5% of the offer's.
  const promo = (b: { at: number; u: number }) => { const day = isoDate(b.at); return offers.some(o => o.valid_from <= day && day <= o.valid_to && Math.abs(b.u - o.unit_cents) <= 0.05 * o.unit_cents); };
  const buys = all<{ at: number; u: number }>(db, `SELECT at, u FROM (${PRICED_BUYS}) WHERE u > 0 ORDER BY at DESC, seq DESC LIMIT 50`, itemId).filter(b => !promo(b)).slice(0, 10);
  if (buys.length) return { cents_per_unit: median(buys.map(b => b.u)), basis: 'buys' };
  return item.cost != null && item.cost > 0 ? { cents_per_unit: item.cost, basis: 'item' } : null;
}

/** Live and upcoming offers matched to an item, with % off against the offer's own pre_price, else the normal price. */
export function itemDeals(db: Db, itemId: number, today: string): ItemDeals {
  const normal = normalPrice(db, itemId);
  const offers = itemOffers(db, itemId).filter(o => o.valid_to >= today).map(({ pre_price_cents, ...o }) => {
    const pct_off = pre_price_cents ? Math.round((1 - o.price_cents / pre_price_cents) * 100) : normal ? Math.round((1 - o.unit_cents / normal.cents_per_unit) * 100) : null;
    return { ...o, pct_off };
  });
  return { normal, offers };
}
