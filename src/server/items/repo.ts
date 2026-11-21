import { daysUntil } from '../../shared/dates.ts';
import { isLow, portionCount, shown } from '../../shared/stock.ts';
import { aliasKey, nameKey } from '../../shared/text.ts';
import { CATEGORIES } from '../../shared/types.ts';
import type { DataInfo, Item, ItemBody, ItemPatch, Kind, Unit } from '../../shared/types.ts';
import type { Db } from '../db.ts';
import { JOLLY_KEY, all, bumpRev, get, run, transaction } from '../db.ts';
import { allStock, fail, unitOf } from '../domain.ts';

export const clash = (name: string): never => fail(409, `There is already an item called ${name}`);

export function nextNameClashes(db: Db, name: string, ownerId: number | null, excludeId?: number): boolean {
  const key = nameKey(name);
  const ownerKey = ownerId ?? 0;
  return excludeId != null
    ? !!get(db, 'SELECT 1 FROM items WHERE name_key = ? AND COALESCE(owner_id, 0) = ? AND id <> ?', key, ownerKey, excludeId)
    : !!get(db, 'SELECT 1 FROM items WHERE name_key = ? AND COALESCE(owner_id, 0) = ?', key, ownerKey);
}

export function createItem(db: Db, b: ItemBody, now: number): void {
  transaction(db, () => {
    const ownerId = b.owner_id ?? null;
    if (ownerId !== null && !get(db, 'SELECT 1 FROM users WHERE id = ?', ownerId)) fail(400, 'Unknown user');
    const old = get<{ id: number; archived_at: number | null }>(
      db,
      'SELECT id, archived_at FROM items WHERE name_key = ? AND COALESCE(owner_id, 0) = ?',
      nameKey(b.name),
      ownerId ?? 0,
    );
    if (old && old.archived_at === null) clash(b.name);

    let itemId: number;
    if (old) {
      itemId = old.id;
      // Re-adding an archived name brings the old item back, so its history stays attached.
      run(
        db,
        `UPDATE items SET
           name = ?, emoji = ?, category = ?, unit = ?, step = ?, pack_size = ?, low_at = ?,
           owner_id = ?, is_cooked = ?, portion_g = ?, expires_at = ?, shelf_life_days = ?,
           kcal_per_unit = ?, protein_per_unit = ?, fat_per_unit = ?, carbs_per_unit = ?, cost_per_unit_cents = ?, archived_at = NULL
         WHERE id = ?`,
        b.name,
        b.emoji,
        b.category,
        b.unit,
        b.step,
        b.pack_size,
        b.low_at,
        ownerId,
        b.is_cooked ? 1 : 0,
        b.portion_g ?? null,
        b.expires_at ?? null,
        b.shelf_life_days ?? null,
        b.kcal_per_unit ?? null,
        b.protein_per_unit ?? null,
        b.fat_per_unit ?? null,
        b.carbs_per_unit ?? null,
        b.cost_per_unit_cents ?? null,
        itemId,
      );
    } else {
      itemId = Number(
        run(
          db,
          `INSERT INTO items(
             name, name_key, emoji, category, unit, step, pack_size, low_at,
             owner_id, is_cooked, portion_g, expires_at, shelf_life_days, kcal_per_unit, protein_per_unit, fat_per_unit, carbs_per_unit, cost_per_unit_cents, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          b.name,
          nameKey(b.name),
          b.emoji,
          b.category,
          b.unit,
          b.step,
          b.pack_size,
          b.low_at,
          ownerId,
          b.is_cooked ? 1 : 0,
          b.portion_g ?? null,
          b.expires_at ?? null,
          b.shelf_life_days ?? null,
          b.kcal_per_unit ?? null,
          b.protein_per_unit ?? null,
          b.fat_per_unit ?? null,
          b.carbs_per_unit ?? null,
          b.cost_per_unit_cents ?? null,
          now,
        ).lastInsertRowid,
      );
    }

    if (b.barcode) {
      run(
        db,
        `INSERT INTO barcodes(code, item_id, source, updated_at) VALUES (?, ?, 'manual', ?)
         ON CONFLICT(code) DO UPDATE SET item_id = excluded.item_id, updated_at = excluded.updated_at`,
        b.barcode,
        itemId,
        now,
      );
    }
    bumpRev(db);
  });
}

export function patchItem(db: Db, id: number, patch: ItemPatch): void {
  transaction(db, () => {
    const existing = get<{ name: string; owner_id: number | null }>(
      db,
      'SELECT name, owner_id FROM items WHERE id = ? AND archived_at IS NULL',
      id,
    );
    if (!existing) fail(404, 'No such item');

    const { barcode, ...fields } = patch;
    if (fields.owner_id !== undefined && fields.owner_id !== null) {
      if (!get(db, 'SELECT 1 FROM users WHERE id = ?', fields.owner_id)) fail(400, 'Unknown user');
    }

    const nextName = fields.name ?? existing.name;
    const nextOwner = fields.owner_id !== undefined ? (fields.owner_id ?? null) : existing.owner_id;
    if ((fields.name !== undefined || fields.owner_id !== undefined) && nextNameClashes(db, nextName, nextOwner, id)) {
      clash(nextName);
    }

    // Column names come from the zod-parsed keys (ItemPatch minus barcode), never from raw input.
    const cols = Object.keys(fields) as (keyof typeof fields)[];
    if (cols.length) {
      const sets = cols.map(c => `${c} = ?`);
      const vals = cols.map(c => {
        const v = fields[c];
        if (c === 'is_cooked') return v ? 1 : 0;
        return (v ?? null) as string | number | null;
      });
      if (fields.name !== undefined) {
        sets.push('name_key = ?');
        vals.push(nameKey(fields.name));
      }
      run(db, `UPDATE items SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    }

    if (barcode) {
      run(
        db,
        `INSERT INTO barcodes(code, item_id, source, updated_at) VALUES (?, ?, 'manual', ?)
         ON CONFLICT(code) DO UPDATE SET item_id = excluded.item_id, updated_at = excluded.updated_at`,
        barcode,
        id,
        Date.now(),
      );
    }
    bumpRev(db);
  });
}

export function archiveItem(db: Db, id: number, now: number): void {
  transaction(db, () => {
    if (!get(db, 'SELECT 1 FROM items WHERE id = ?', id)) fail(404, 'No such item');
    run(db, 'UPDATE items SET archived_at = COALESCE(archived_at, ?) WHERE id = ?', now, id);
    run(db, 'DELETE FROM preset_lines WHERE item_id = ?', id);
    run(db, 'DELETE FROM meal_recipes WHERE ingredient_item_id = ? OR meal_item_id = ?', id, id);
    bumpRev(db);
  });
}

export function restoreItem(db: Db, id: number): void {
  transaction(db, () => {
    const it = get<{ name: string; owner_id: number | null; archived_at: number | null }>(db, 'SELECT name, owner_id, archived_at FROM items WHERE id = ?', id);
    if (!it) fail(404, 'No such item');
    if (it!.archived_at === null) fail(409, `${it!.name} is not archived`);
    if (nextNameClashes(db, it!.name, it!.owner_id, id)) clash(it!.name);
    run(db, 'UPDATE items SET archived_at = NULL WHERE id = ?', id);
    bumpRev(db);
  });
}

/** Removes a learned receipt alias by its stored text or a raw phrase. */
export function deleteAlias(db: Db, text: string): { key: string; changes: number } {
  const key = aliasKey(text);
  return transaction(db, () => {
    const changes = Number(run(db, 'DELETE FROM aliases WHERE text = ? OR text = ?', text, key).changes);
    if (changes === 0) fail(404, `No alias matching "${text}"`);
    bumpRev(db);
    return { key, changes };
  });
}

/** What the Settings > Data page lists; kept out of State because it is rarely opened. */
export function listData(db: Db): DataInfo {
  return {
    aliases: all<DataInfo['aliases'][number]>(db, 'SELECT a.text, a.item_id, i.name AS item_name, i.emoji FROM aliases a JOIN items i ON i.id = a.item_id ORDER BY i.name, a.text'),
    archived: all<DataInfo['archived'][number]>(db, 'SELECT id, name, emoji, archived_at FROM items WHERE archived_at IS NOT NULL AND name_key <> ? ORDER BY archived_at DESC', JOLLY_KEY),
  };
}

// ---- hydrated views (MCP) ----

export interface ItemRowFull {
  id: number;
  name: string;
  name_key: string;
  emoji: string;
  category: Item['category'];
  unit: Unit;
  step: number;
  pack_size: number;
  low_at: number | null;
  owner_id: number | null;
  is_cooked: number;
  portion_g: number | null;
  expires_at: string | null;
  shelf_life_days: number | null;
  kcal_per_unit: number | null;
  protein_per_unit: number | null;
  fat_per_unit: number | null;
  carbs_per_unit: number | null;
  cost_per_unit_cents: number | null;
  archived_at: number | null;
  created_at: number;
}

export interface HydratedItem extends Item {
  shown_stock: number;
  portions: number | null;
  is_low: boolean;
  days_until_expiry: number | null;
  archived_at?: number | null;
}

function loadRecipeMap(db: Db): Map<number, { item_id: number; qty: number }[]> {
  const recipes = new Map<number, { item_id: number; qty: number }[]>();
  for (const r of all<{ meal_item_id: number; ingredient_item_id: number; qty: number }>(
    db,
    'SELECT meal_item_id, ingredient_item_id, qty FROM meal_recipes ORDER BY rowid',
  )) {
    const list = recipes.get(r.meal_item_id);
    const entry = { item_id: r.ingredient_item_id, qty: r.qty };
    if (list) list.push(entry);
    else recipes.set(r.meal_item_id, [entry]);
  }
  return recipes;
}

function toHydratedItem(
  row: ItemRowFull,
  stockMap: Map<number, number>,
  recipes: Map<number, { item_id: number; qty: number }[]>,
  nowMs: number,
  includeArchived: boolean,
): HydratedItem {
  const stock = stockMap.get(row.id) ?? 0;
  const recipe = recipes.get(row.id);
  const item: HydratedItem = {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    category: row.category,
    unit: row.unit,
    step: row.step,
    pack_size: row.pack_size,
    low_at: row.low_at,
    stock,
    shown_stock: shown(stock),
    owner_id: row.owner_id,
    is_cooked: !!row.is_cooked,
    portion_g: row.portion_g,
    portions: portionCount({ unit: row.unit, portion_g: row.portion_g }, stock),
    is_low: isLow({ stock, low_at: row.low_at }),
    expires_at: row.expires_at,
    days_until_expiry: row.expires_at ? daysUntil(row.expires_at, nowMs) : null,
    shelf_life_days: row.shelf_life_days,
    kcal_per_unit: row.kcal_per_unit,
    protein_per_unit: row.protein_per_unit,
    fat_per_unit: row.fat_per_unit,
    carbs_per_unit: row.carbs_per_unit,
    cost_per_unit_cents: row.cost_per_unit_cents,
  };
  if (recipe) item.recipe = recipe;
  if (includeArchived) item.archived_at = row.archived_at;
  return item;
}

export function loadHydratedItems(db: Db, nowMs: number, includeArchived = false): HydratedItem[] {
  const stockMap = allStock(db);
  const recipes = loadRecipeMap(db);
  const where = includeArchived ? '' : 'WHERE archived_at IS NULL';
  return all<ItemRowFull>(
    db,
    `SELECT id, name, name_key, emoji, category, unit, step, pack_size, low_at,
            owner_id, is_cooked, portion_g, expires_at, shelf_life_days,
            kcal_per_unit, protein_per_unit, fat_per_unit, carbs_per_unit, cost_per_unit_cents, archived_at, created_at
     FROM items ${where}`,
  )
    .map(r => toHydratedItem(r, stockMap, recipes, nowMs, includeArchived))
    .sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.name.localeCompare(b.name));
}

export function getHydratedItemById(db: Db, itemId: number, nowMs: number, includeArchived = false): HydratedItem | null {
  const where = includeArchived ? 'id = ?' : 'id = ? AND archived_at IS NULL';
  const row = get<ItemRowFull>(
    db,
    `SELECT id, name, name_key, emoji, category, unit, step, pack_size, low_at,
            owner_id, is_cooked, portion_g, expires_at, shelf_life_days,
            kcal_per_unit, protein_per_unit, fat_per_unit, carbs_per_unit, cost_per_unit_cents, archived_at, created_at
     FROM items WHERE ${where}`,
    itemId,
  );
  if (!row) return null;
  return toHydratedItem(row, allStock(db), loadRecipeMap(db), nowMs, includeArchived);
}

export function requireActiveItems(db: Db, itemIds: number[], kind?: Kind): void {
  const seen = new Set<number>();
  for (const id of itemIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!unitOf(db, id, kind)) {
      fail(400, `Item ${id} does not exist or is archived`);
    }
  }
}
