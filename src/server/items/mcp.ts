import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { aliasKey, nameKey } from '../../shared/text.ts';
import { BarcodeLinkBody, Category, ItemBody, ItemPatch, Unit } from '../../shared/types.ts';
import { defaultBarcodeLookup, linkBarcode, resolveBarcode } from '../barcodes.ts';
import { all, bumpRev, get, getRev, run, transaction } from '../db.ts';
import { fail, unitOf } from '../domain.ts';
import { DESTRUCTIVE_ANNOTATIONS, IDEMPOTENT_WRITE_ANNOTATIONS, READ_ANNOTATIONS, WRITE_ANNOTATIONS, errMessage, okResult, runTool, stripUndefined } from '../mcp-kit.ts';
import type { McpCtx } from '../mcp-kit.ts';
import { archiveItem, createItem, deleteAlias, getHydratedItemById, loadHydratedItems, patchItem } from './repo.ts';
import type { HydratedItem } from './repo.ts';
import { eventRowToJson, itemPrices } from '../events/repo.ts';
import { itemDeals } from '../deals/repo.ts';
import { isoDate } from '../../shared/dates.ts';
import type { EventRowFull } from '../events/repo.ts';

export function registerItemTools(server: McpServer, { db, now, lookupBarcode }: McpCtx): void {
  server.registerTool(
    'list_items',
    {
      title: 'List Pantry Items',
      description: 'List pantry and cooked meal items with live stock, portion counts, low-stock flags, and expiry filters.',
      inputSchema: {
        category: Category.optional().describe('Filter by item category'),
        owner_id: z.number().int().positive().optional().describe('Filter to personal items owned by this user ID'),
        shared_only: z.boolean().optional().describe('When true, only include shared household items (owner_id is null)'),
        low_only: z.boolean().optional().describe('When true, only include items at or below low_at (or out of stock)'),
        expiring_within_days: z.number().int().min(0).max(3650).optional().describe('Only include in-stock items expiring within N days'),
        cooked_only: z.boolean().optional().describe('When true, only include cooked meal items'),
        include_archived: z.boolean().optional().describe('Include archived items (default false)'),
        search: z.string().trim().max(100).optional().describe('Case-insensitive substring match against item name'),
      },
      annotations: READ_ANNOTATIONS,
    },
    (args) => runTool(() => {
      const nowMs = now();
      let items = loadHydratedItems(db, nowMs, !!args.include_archived);
      if (args.category !== undefined) items = items.filter(i => i.category === args.category);
      if (args.shared_only) items = items.filter(i => i.owner_id === null);
      if (args.owner_id !== undefined) items = items.filter(i => i.owner_id === args.owner_id);
      if (args.cooked_only) items = items.filter(i => i.is_cooked);
      if (args.low_only) items = items.filter(i => i.is_low && !i.archived_at);
      if (args.expiring_within_days !== undefined) {
        items = items.filter(
          i => i.shown_stock > 0 && i.days_until_expiry !== null && i.days_until_expiry <= args.expiring_within_days!,
        );
      }
      if (args.search) {
        const needle = nameKey(args.search);
        items = items.filter(i => nameKey(i.name).includes(needle));
      }
      return okResult(`Found ${items.length} item(s).`, { count: items.length, items });
    }),
  );

  server.registerTool(
    'get_item',
    {
      title: 'Get Item Details',
      description: 'Get one item by ID or name, including stock, recipe, barcodes, receipt aliases, recent events, normal_price (per 1 unit, minor currency units), live and upcoming matched deals and the last 10 priced buys. For level items, an eat event line with is_set=true records the remaining level of the open container; buy adds containers and adjust sets the exact total container count.',
      inputSchema: {
        item_id: z.number().int().positive().optional().describe('Item ID'),
        name: z.string().trim().min(1).max(60).optional().describe('Item name (when item_id is omitted)'),
        owner_id: z.number().int().positive().nullable().optional().describe('Optional owner_id (or null for shared) to disambiguate lookup by name'),
        include_archived: z.boolean().optional().describe('Allow matching archived items (default false)'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ item_id, name, owner_id, include_archived }) => runTool(() => {
      if (item_id === undefined && !name) fail(400, 'Provide item_id or name');
      const nowMs = now();
      let item: HydratedItem | null = null;
      if (item_id !== undefined) {
        item = getHydratedItemById(db, item_id, nowMs, !!include_archived);
        if (!item) fail(404, `No item with id ${item_id}`);
      } else {
        const key = nameKey(name!);
        const allItems = loadHydratedItems(db, nowMs, !!include_archived).filter(i => nameKey(i.name) === key);
        const filtered = owner_id !== undefined ? allItems.filter(i => i.owner_id === owner_id) : allItems;
        if (filtered.length === 0) fail(404, `No item called "${name}"`);
        if (filtered.length > 1) {
          fail(
            400,
            `Multiple items called "${name}" exist (${filtered.map(i => `id=${i.id}, owner_id=${i.owner_id}`).join('; ')}); pass item_id or owner_id`,
          );
        }
        item = filtered[0]!;
      }

      const barcodes = all<{ code: string; product_name: string | null; brand: string | null; source: string }>(
        db,
        'SELECT code, product_name, brand, source FROM barcodes WHERE item_id = ? ORDER BY updated_at DESC',
        item.id,
      ).map(r => ({ ...r }));
      const aliases = all<{ text: string }>(db, 'SELECT text FROM aliases WHERE item_id = ? ORDER BY text', item.id).map(a => a.text);
      const eventRows = all<EventRowFull>(
        db,
        `SELECT DISTINCT e.cid, e.seq, e.user_id, e.at, e.kind, e.source, e.note, e.preset_id, e.cost_cents, e.counts_nutrition, e.undone_at
         FROM events e JOIN event_lines l ON l.event_cid = e.cid
         WHERE l.item_id = ? AND e.undone_at IS NULL
         ORDER BY e.at DESC, e.seq DESC LIMIT 20`,
        item.id,
      );
      const recent_events = eventRows.map(ev => eventRowToJson(db, ev));
      const deals = itemDeals(db, item.id, isoDate(nowMs));

      return okResult(`${item.emoji} ${item.name} (#${item.id}): stock ${item.stock} ${item.unit}.`, {
        item,
        barcodes,
        aliases,
        recent_events,
        normal_price: deals.normal,
        deals: deals.offers,
        prices: itemPrices(db, item.id, 10),
      });
    }),
  );

  const createItemShape = {
    name: ItemBody.shape.name.describe('Item name (unique per owner scope)'),
    category: Category.describe('Category'),
    unit: Unit.describe('Unit: pc, slice, g, ml, level, or portion'),
    emoji: ItemBody.shape.emoji.optional().describe('Emoji icon (default 🍽️)'),
    step: ItemBody.shape.step.optional().describe('Stepper increment (default 50 for g/ml, else 1)'),
    pack_size: ItemBody.shape.pack_size.optional().describe('Units per bought pack (default 1)'),
    low_at: ItemBody.shape.low_at.optional().describe('Low-stock threshold, or null (default null)'),
    owner_id: ItemBody.shape.owner_id.describe('User ID for personal item, or null/omitted for shared'),
    is_cooked: ItemBody.shape.is_cooked.describe('Whether item is a cooked meal'),
    portion_g: ItemBody.shape.portion_g.describe('Grams per 1 portion (for g-tracked meals)'),
    expires_at: ItemBody.shape.expires_at.describe('Expiry date YYYY-MM-DD'),
    shelf_life_days: ItemBody.shape.shelf_life_days.describe('Default shelf life in days on buy'),
    kcal_per_unit: ItemBody.shape.kcal_per_unit.describe('Calories per 1 unit'),
    protein_per_unit: ItemBody.shape.protein_per_unit.describe('Protein (g) per 1 unit'),
    fat_per_unit: ItemBody.shape.fat_per_unit.describe('Fat (g) per 1 unit'),
    carbs_per_unit: ItemBody.shape.carbs_per_unit.describe('Carbs (g) per 1 unit'),
    cost_per_unit_cents: ItemBody.shape.cost_per_unit_cents.describe('Price per 1 unit in minor currency units (also learned from priced buys)'),
    barcode: ItemBody.shape.barcode.describe('Optional 6-14 digit barcode to link'),
  };
  const CreateItemArgs = z.object(createItemShape);

  const updateItemShape = {
    item_id: z.number().int().positive().describe('Active item ID to update'),
    name: ItemPatch.shape.name.describe('Updated name'),
    emoji: ItemPatch.shape.emoji.describe('Updated emoji'),
    category: ItemPatch.shape.category.describe('Updated category'),
    unit: ItemPatch.shape.unit.describe('Updated unit'),
    step: ItemPatch.shape.step.describe('Updated step'),
    pack_size: ItemPatch.shape.pack_size.describe('Updated pack_size'),
    low_at: ItemPatch.shape.low_at.describe('Updated low_at threshold (or null)'),
    owner_id: ItemPatch.shape.owner_id.describe('Updated owner_id (or null for shared)'),
    is_cooked: ItemPatch.shape.is_cooked.describe('Updated is_cooked flag'),
    portion_g: ItemPatch.shape.portion_g.describe('Updated portion_g'),
    expires_at: ItemPatch.shape.expires_at.describe('Updated expires_at YYYY-MM-DD (or null)'),
    shelf_life_days: ItemPatch.shape.shelf_life_days.describe('Updated shelf_life_days'),
    kcal_per_unit: ItemPatch.shape.kcal_per_unit.describe('Updated kcal_per_unit'),
    protein_per_unit: ItemPatch.shape.protein_per_unit.describe('Updated protein_per_unit'),
    fat_per_unit: ItemPatch.shape.fat_per_unit.describe('Updated fat_per_unit'),
    carbs_per_unit: ItemPatch.shape.carbs_per_unit.describe('Updated carbs_per_unit'),
    cost_per_unit_cents: ItemPatch.shape.cost_per_unit_cents.describe('Updated price per 1 unit in minor currency units (or null)'),
    barcode: ItemPatch.shape.barcode.describe('Optional 6-14 digit barcode to link'),
  };
  const UpdateItemArgs = z.object(updateItemShape);

  const createOneItem = (args: z.infer<typeof CreateItemArgs>, nowMs: number): HydratedItem => {
    const parsed = ItemBody.parse({
      ...args,
      emoji: args.emoji ?? '🍽️',
      step: args.step ?? (args.unit === 'g' || args.unit === 'ml' ? 50 : 1),
      pack_size: args.pack_size ?? 1,
      low_at: args.low_at ?? null,
    });
    createItem(db, parsed, nowMs);
    const row = get<{ id: number }>(
      db,
      'SELECT id FROM items WHERE name_key = ? AND COALESCE(owner_id, 0) = ? AND archived_at IS NULL',
      nameKey(parsed.name),
      parsed.owner_id ?? 0,
    )!;
    return getHydratedItemById(db, row.id, nowMs)!;
  };

  const updateOneItem = ({ item_id, ...rest }: z.infer<typeof UpdateItemArgs>, nowMs: number): HydratedItem => {
    patchItem(db, item_id, ItemPatch.parse(stripUndefined(rest)));
    return getHydratedItemById(db, item_id, nowMs)!;
  };


  server.registerTool(
    'batch_items',
    {
      title: 'Batch Create / Update / Archive Items',
      description:
        'Create, update, and archive many items in one atomic call (all succeed or nothing changes). Runs all creates, then all updates, then all archives, so one batch cannot create a name that a later update or archive in the same batch frees up (split those into two calls). Use this instead of repeated create_item/update_item/archive_item calls.',
      inputSchema: {
        create: z.array(CreateItemArgs).max(100).optional().describe('Items to create (same fields as create_item)'),
        update: z.array(UpdateItemArgs).max(100).optional().describe('Item patches (same fields as update_item, item_id required)'),
        archive: z.array(z.number().int().positive()).max(100).optional().describe('Item IDs to archive'),
      },
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    ({ create = [], update = [], archive = [] }) => runTool(() => {
      if (!create.length && !update.length && !archive.length) fail(400, 'Provide create, update, and/or archive');
      const nowMs = now();
      const step = <T, R>(label: string, list: T[], name: (x: T) => string, fn: (x: T) => R): R[] =>
        list.map((x, i) => {
          try {
            return fn(x);
          } catch (err) {
            throw new Error(`${label}[${i}] (${name(x)}): ${errMessage(err)}. Nothing was changed.`);
          }
        });
      const result = transaction(db, () => {
        const created = step('create', create, a => a.name, a => createOneItem(a, nowMs));
        const updated = step('update', update, a => `#${a.item_id}`, a => updateOneItem(a, nowMs));
        const archived = step('archive', archive, id => `#${id}`, id => (archiveItem(db, id, nowMs), id));
        return { created, updated, archived_item_ids: archived };
      });
      return okResult(
        `Created ${result.created.length}, updated ${result.updated.length}, archived ${result.archived_item_ids.length} item(s).`,
        { ...result, rev: getRev(db) },
      );
    }),
  );

  server.registerTool(
    'create_item',
    {
      title: 'Create Item',
      description: 'Create a new pantry or meal item (or revive a matching archived item). To create several, use batch_items.',
      inputSchema: createItemShape,
      annotations: WRITE_ANNOTATIONS,
    },
    (args) => runTool(() => {
      const item = createOneItem(args, now());
      return okResult(`Created ${item.emoji} ${item.name} (#${item.id}).`, { item, rev: getRev(db) });
    }),
  );

  server.registerTool(
    'update_item',
    {
      title: 'Update Item',
      description: 'Update metadata, thresholds, nutrition, expiry, ownership, or barcode of an existing active item. To update several, use batch_items.',
      inputSchema: updateItemShape,
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    (args) => runTool(() => {
      const item = updateOneItem(args, now());
      return okResult(`Updated ${item.emoji} ${item.name} (#${item.id}).`, { item, rev: getRev(db) });
    }),
  );

  server.registerTool(
    'archive_item',
    {
      title: 'Archive Item',
      description: 'Archive an item and remove it from preset lines and meal recipes while keeping historical events intact.',
      inputSchema: {
        item_id: z.number().int().positive().describe('Item ID to archive'),
      },
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    ({ item_id }) => runTool(() => {
      archiveItem(db, item_id, now());
      return okResult(`Archived item #${item_id}.`, { archived_item_id: item_id, rev: getRev(db) });
    }),
  );

  server.registerTool(
    'lookup_barcode',
    {
      title: 'Lookup Barcode',
      description: 'Resolve a 6-14 digit barcode against the local barcodes cache and Open Food Facts.',
      inputSchema: {
        code: z.string().trim().regex(/^\d{6,14}$/, 'Barcode must be 6 to 14 digits').describe('6-14 digit EAN/UPC barcode'),
        refresh: z.boolean().optional().describe('Bypass the local cache and re-query Open Food Facts'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    ({ code, refresh }) => runTool(async () => {
      const nowMs = now();
      const lookup = await resolveBarcode(db, code, lookupBarcode ?? defaultBarcodeLookup, nowMs, {
        forceRefresh: Boolean(refresh),
      });
      const item = lookup.item_id != null ? getHydratedItemById(db, lookup.item_id, nowMs) : null;
      return okResult(
        lookup.found
          ? `Barcode ${lookup.code}: ${lookup.product?.product_name ?? item?.name ?? 'matched item #' + lookup.item_id}.`
          : `Barcode ${lookup.code} not found.`,
        { ...lookup, item },
      );
    }),
  );

  server.registerTool(
    'link_barcode',
    {
      title: 'Link Barcode to Item',
      description: 'Link a 6-14 digit barcode to an active pantry item.',
      inputSchema: {
        code: BarcodeLinkBody.shape.code.describe('6-14 digit barcode'),
        item_id: BarcodeLinkBody.shape.item_id.describe('Active item ID'),
      },
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    (args) => runTool(() => {
      const body = BarcodeLinkBody.parse(args);
      linkBarcode(db, body.code, body.item_id, now());
      return okResult(`Linked barcode ${body.code} to item #${body.item_id}.`, {
        code: body.code,
        item_id: body.item_id,
        rev: getRev(db),
      });
    }),
  );

  server.registerTool(
    'set_alias',
    {
      title: 'Set Receipt Alias',
      description: 'Map a receipt/text phrase (normalized via aliasKey) to an active item ID.',
      inputSchema: {
        text: z.string().trim().min(1).max(200).describe('Receipt line or phrase to map'),
        item_id: z.number().int().positive().describe('Active item ID'),
      },
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    ({ text, item_id }) => runTool(() => {
      const key = aliasKey(text);
      if (!key) fail(400, 'Alias text must contain letters or digits');
      transaction(db, () => {
        if (!unitOf(db, item_id)) fail(404, `No active item #${item_id}`);
        run(db, 'INSERT OR REPLACE INTO aliases(text, item_id) VALUES (?, ?)', key, item_id);
        bumpRev(db);
      });
      return okResult(`Mapped alias "${key}" -> item #${item_id}.`, {
        text: key,
        item_id,
        rev: getRev(db),
      });
    }),
  );

  server.registerTool(
    'delete_alias',
    {
      title: 'Delete Receipt Alias',
      description: 'Remove a learned receipt alias by exact text or raw phrase.',
      inputSchema: {
        text: z.string().trim().min(1).max(200).describe('Alias text or raw phrase to delete'),
      },
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    ({ text }) => runTool(() => {
      const { key, changes } = deleteAlias(db, text);
      return okResult(`Deleted alias "${key || text}".`, {
        deleted: text,
        key,
        changes,
        rev: getRev(db),
      });
    }),
  );
}
