import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isoDate } from '../../shared/dates.ts';
import { aliasKey } from '../../shared/text.ts';
import { all } from '../db.ts';
import { IDEMPOTENT_WRITE_ANNOTATIONS, READ_ANNOTATIONS, WRITE_ANNOTATIONS, okResult, runTool } from '../mcp-kit.ts';
import type { McpCtx } from '../mcp-kit.ts';
import { buildPlan } from './plan.ts';
import { linkOffer } from './repo.ts';
import { syncStores } from './sync.ts';

export function registerDealsTools(server: McpServer, { db, now, fetch: fetchFn, matchOffers }: McpCtx): void {
  server.registerTool(
    'get_shopping_plan',
    {
      title: 'Get Shopping Plan',
      description: 'The deals-based shopping plan, computed now: which store and day to shop, which items and how many packs, with the saving. Also lists every matched deal with its reason.',
      inputSchema: {},
      annotations: READ_ANNOTATIONS,
    },
    () => runTool(() => {
      const plan = buildPlan(db, now());
      return okResult(
        plan.trips.length
          ? `${plan.trips.length} trip(s), saving ${plan.total_saving_cents} minor units: ${plan.trips.map(t => `${t.date} ${t.store_name} (${t.items.length} items)`).join('; ')}.`
          : 'No shopping trip is worth planning right now.',
        { ...plan },
      );
    }),
  );

  server.registerTool(
    'search_offers',
    {
      title: 'Search Offers',
      description: 'Search live and upcoming supermarket offers by title text (and optionally store id, e.g. netto-dk). Shows which pantry item each offer is matched to.',
      inputSchema: {
        query: z.string().trim().min(1).max(100).describe('Words from the offer title'),
        store: z.string().trim().min(1).max(40).optional().describe('Store id, e.g. netto-dk, lidl-dk, coop365-dk'),
        limit: z.number().int().min(1).max(50).optional().describe('Default 20, max 50'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ query, store, limit }) => runTool(() => {
      const offers = all(db, `
        SELECT o.store_id, o.title, o.offer_key, o.price_cents, o.pre_price_cents, o.currency, o.unit, o.unit_qty, o.max_per_customer, o.valid_from, o.valid_to, m.item_id, m.qty_per_pack
        FROM offers o LEFT JOIN offer_matches m ON m.offer_key = o.offer_key
        WHERE o.valid_to >= ? AND o.offer_key LIKE ? ${store ? 'AND o.store_id = ?' : ''} ORDER BY o.valid_from, o.price_cents LIMIT ?`,
      isoDate(now()), `%${aliasKey(query)}%`, ...(store ? [store] : []), limit ?? 20);
      return okResult(`Found ${offers.length} offer(s).`, { offers });
    }),
  );

  server.registerTool(
    'sync_catalogs',
    {
      title: 'Sync Catalogs',
      description: 'Fetch the current and upcoming offers of the enabled stores now and match new ones to pantry items (can take about a minute).',
      inputSchema: {},
      annotations: WRITE_ANNOTATIONS,
    },
    () => runTool(async () => {
      const res = await syncStores(db, { fetch: fetchFn ?? fetch, now, matchOffers });
      return okResult(`Synced ${res.stores.filter(s => s.ok).length}/${res.stores.length} store(s), ${res.newOffers} new offer(s).`, { ...res });
    }),
  );

  server.registerTool(
    'link_offer',
    {
      title: 'Link Offer to Item',
      description: 'Match an offer (by offer_key from search_offers) to a pantry item, with the pack size in the item\'s unit; item_id null ignores the offer.',
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
}
