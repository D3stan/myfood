import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DealLocationBody } from '../../shared/types.ts';
import { isoDate } from '../../shared/dates.ts';
import { aliasKey } from '../../shared/text.ts';
import { all, get, getMeta, transaction } from '../db.ts';
import { DEFAULT_CURRENCY } from '../../shared/currency.ts';
import { fail } from '../domain.ts';
import { IDEMPOTENT_WRITE_ANNOTATIONS, READ_ANNOTATIONS, WRITE_ANNOTATIONS, okResult, runTool } from '../mcp-kit.ts';
import type { McpCtx } from '../mcp-kit.ts';
import { buildPlan } from './plan.ts';
import { dealsInfo, linkOffer, setLocation, setStoreEnabled } from './repo.ts';
import { syncStores } from './sync.ts';

export function registerDealsTools(server: McpServer, { db, now, fetch: fetchFn, matchOffers }: McpCtx): void {
  server.registerTool(
    'get_shopping_plan',
    {
      title: 'Get Shopping Plan',
      description: 'The deals-based shopping plan, computed now: which store and day to shop, which items and how many packs, with the saving. Also lists every matched deal with its reason, the stores (enabled, last sync, last error), the household location and unmatched_offer_count (live offers not yet matched to an item; one sync matches at most 300 new names).',
      inputSchema: {},
      annotations: READ_ANNOTATIONS,
    },
    () => runTool(() => {
      const plan = buildPlan(db, now());
      const { stores, lat, lng, radius_m } = dealsInfo(db, isoDate(now()));
      const unmatched = get<{ n: number }>(db, `SELECT COUNT(DISTINCT o.offer_key) AS n FROM offers o JOIN stores s ON s.id = o.store_id AND s.enabled = 1
        WHERE o.valid_to >= ? AND o.currency = ? AND o.offer_key NOT IN (SELECT offer_key FROM offer_matches)`, isoDate(now()), getMeta(db, 'currency') ?? DEFAULT_CURRENCY)!.n;
      return okResult(
        plan.trips.length
          ? `${plan.trips.length} trip(s), saving ${plan.total_saving_cents} minor units: ${plan.trips.map(t => `${t.date} ${t.store_name} (${t.items.length} items)`).join('; ')}.`
          : 'No shopping trip is worth planning right now.',
        { ...plan, stores, location: { lat, lng, radius_m }, unmatched_offer_count: unmatched },
      );
    }),
  );

  server.registerTool(
    'search_offers',
    {
      title: 'Search Offers',
      description: 'Search live and upcoming offers of the enabled stores (in the household currency) by title text, optionally one store id (e.g. netto-dk). Each offer has status matched, ignored or unmatched, with the pantry item_name when matched and unit_cents (price per 1 item unit) when the pack size is known. offer_key is shared by every store carrying the product.',
      inputSchema: {
        query: z.string().trim().min(1).max(100).describe('Words from the offer title'),
        store: z.string().trim().min(1).max(40).optional().describe('Store id, e.g. netto-dk, lidl-dk, coop365-dk'),
        limit: z.number().int().min(1).max(50).optional().describe('Default 20, max 50'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ query, store, limit }) => runTool(() => {
      const key = aliasKey(query);
      if (!key) fail(400, 'Query needs letters or digits');
      const offers = all(db, `
        SELECT o.store_id, s.name AS store_name, o.title, o.offer_key, o.price_cents, o.pre_price_cents, o.currency, o.unit, o.unit_qty, o.max_per_customer, o.valid_from, o.valid_to,
          CASE WHEN m.offer_key IS NULL THEN 'unmatched' WHEN m.item_id IS NULL THEN 'ignored' ELSE 'matched' END AS status,
          m.item_id, i.name AS item_name, m.qty_per_pack, CASE WHEN m.qty_per_pack > 0 THEN o.price_cents * 1.0 / m.qty_per_pack END AS unit_cents
        FROM offers o JOIN stores s ON s.id = o.store_id AND s.enabled = 1
          LEFT JOIN offer_matches m ON m.offer_key = o.offer_key LEFT JOIN items i ON i.id = m.item_id
        WHERE o.valid_to >= ? AND o.currency = ? AND o.offer_key LIKE ? ${store ? 'AND o.store_id = ?' : ''} ORDER BY o.valid_from, o.price_cents LIMIT ?`,
      isoDate(now()), getMeta(db, 'currency') ?? DEFAULT_CURRENCY, `%${key}%`, ...(store ? [store] : []), limit ?? 20);
      return okResult(`Found ${offers.length} offer(s).`, { offers });
    }),
  );

  server.registerTool(
    'list_offer_matches',
    {
      title: 'List Offer Matches',
      description: 'Review how offers were matched to pantry items (newest first, max 100): offer_key, a sample title, the stores carrying it, the item, qty_per_pack, confidence and source (ai, manual or barcode). Use it to audit AI matches, then correct one with link_offer. Beyond this, use query_sql.',
      inputSchema: {
        item_id: z.number().int().positive().optional().describe('Only matches to this item'),
        source: z.enum(['ai', 'manual', 'barcode']).optional().describe('Only matches made this way'),
        ignored: z.boolean().optional().describe('true: only ignored offers (no item); false: only linked ones'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ item_id, source, ignored }) => runTool(() => {
      const rows = all<{ stores: string } & Record<string, unknown>>(db, `
        SELECT m.offer_key,
          (SELECT o.title FROM offers o WHERE o.offer_key = m.offer_key ORDER BY o.valid_to DESC LIMIT 1) AS title,
          (SELECT json_group_array(DISTINCT s.name) FROM offers o JOIN stores s ON s.id = o.store_id WHERE o.offer_key = m.offer_key) AS stores,
          m.item_id, i.name AS item_name, m.qty_per_pack, m.confidence, m.source, m.updated_at
        FROM offer_matches m LEFT JOIN items i ON i.id = m.item_id
        WHERE 1 = 1 ${item_id !== undefined ? 'AND m.item_id = ?' : ''} ${source ? 'AND m.source = ?' : ''} ${ignored === undefined ? '' : `AND m.item_id IS ${ignored ? '' : 'NOT '}NULL`}
        ORDER BY m.updated_at DESC, m.offer_key LIMIT 100`,
      ...(item_id !== undefined ? [item_id] : []), ...(source ? [source] : []));
      const matches = rows.map(r => ({ ...r, stores: JSON.parse(r.stores) as string[] }));
      return okResult(`Found ${matches.length} match(es).`, { matches });
    }),
  );

  server.registerTool(
    'sync_catalogs',
    {
      title: 'Sync Catalogs',
      description: 'Fetch the current and upcoming offers of the enabled stores now and match new ones to pantry items. With match=true (default) one AI batch runs: typically about 70 s, up to 3 minutes; one sync matches at most 300 new names, so unmatched_offer_count (get_shopping_plan) can stay above 0 and a repeat sync continues. match=false returns in seconds and only matches by barcode. Servers without a scheduler (stdio) never sync on their own.',
      inputSchema: { match: z.boolean().optional().describe('Run the AI matcher (default true); false only fetches and barcode-matches') },
      annotations: WRITE_ANNOTATIONS,
    },
    ({ match }) => runTool(async () => {
      const res = await syncStores(db, { fetch: fetchFn ?? fetch, now, matchOffers: match === false ? undefined : matchOffers });
      return okResult(`Synced ${res.stores.filter(s => s.ok).length}/${res.stores.length} store(s), ${res.newOffers} new offer(s).`, { ...res });
    }),
  );

  server.registerTool(
    'link_offer',
    {
      title: 'Link Offer to Item',
      description: 'Match an offer (by offer_key from search_offers) to a pantry item, with the pack size in the item\'s unit; item_id null ignores the offer. offer_key is the same in every store, so the link or ignore applies to that product in every store, for the whole household.',
      inputSchema: {
        offer_key: z.string().min(1).describe('offer_key from search_offers'),
        item_id: z.number().int().positive().nullable().describe('Item to link, or null to ignore the offer'),
        qty_per_pack: z.number().positive().optional().describe('Pack size in the item\'s unit; default: the offer\'s own size when units agree'),
      },
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    ({ offer_key, item_id, qty_per_pack }) => runTool(() => {
      linkOffer(db, offer_key, item_id, qty_per_pack ?? null, now());
      return okResult(item_id === null ? `Ignoring ${offer_key}.` : `Linked ${offer_key} to item ${item_id}.`, { offer_key, item_id });
    }),
  );

  server.registerTool(
    'set_deal_settings',
    {
      title: 'Set Deal Settings',
      description: 'Enable or disable stores (ids from get_shopping_plan) and/or set the location offers are fetched for. Household-wide: it changes the deals for everyone, and any user\'s token may do it. The new location is used by the next sync.',
      inputSchema: {
        stores: z.array(z.object({ id: z.string().min(1), enabled: z.boolean() })).max(20).optional().describe('Stores to turn on or off'),
        location: DealLocationBody.optional().describe('lat, lng and radius_m (100-50000)'),
      },
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    ({ stores, location }) => runTool(() => {
      if (!stores && !location) fail(400, 'Provide stores and/or location');
      transaction(db, () => {
        for (const s of stores ?? []) setStoreEnabled(db, s.id, s.enabled);
        if (location) setLocation(db, location);
      });
      const { stores: current, lat, lng, radius_m } = dealsInfo(db, isoDate(now()));
      return okResult('Updated deal settings.', { stores: current, location: { lat, lng, radius_m } });
    }),
  );
}
