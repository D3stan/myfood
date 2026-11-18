import { addDays, isoDate } from '../../shared/dates.ts';
import { toLines } from '../../shared/stock.ts';
import { nameKey } from '../../shared/text.ts';
import type { CookBody, Source, Unit } from '../../shared/types.ts';
import type { Db } from '../db.ts';
import { bumpRev, get, run, transaction } from '../db.ts';
import { allStock, fail, unitOf } from '../domain.ts';
import { applyPurchasedLineMeta, insertEvent } from '../events/repo.ts';
import { clash, nextNameClashes } from '../items/repo.ts';

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

export interface CookBatchOptions {
  now?: number;
  source?: Source;
  jobId?: number | null;
  expires_in_days?: number | null;
}

export function applyCookBatch(
  db: Db,
  userId: number,
  body: CookBody,
  opts?: CookBatchOptions,
): { mealItemId: number; eventCids: string[]; prevStocks: Map<number, number> } {
  const hasPortions = body.portions != null && body.portions > 0;
  const hasGrams = body.total_g != null && body.total_g > 0;
  if (!hasPortions && !hasGrams) fail(400, 'Specify portions, grams, or both');
  if (body.meal_item_id == null && !body.name?.trim()) fail(400, 'Choose a meal or enter a meal name');

  const exec = () => {
    const prevStocks = allStock(db);
    const eatCid = `${body.cid}-eat`;
    const buyCid = `${body.cid}-buy`;
    const already = get<{ cid: string }>(db, 'SELECT cid FROM events WHERE cid = ? OR cid = ?', buyCid, eatCid);
    if (already) {
      const existingId = body.meal_item_id ?? 0;
      return { mealItemId: existingId, eventCids: [], prevStocks };
    }

    const at = Math.min(body.at, opts?.now ?? Date.now());
    const ownerId = body.owner_id ?? null;
    if (ownerId !== null && !get(db, 'SELECT 1 FROM users WHERE id = ?', ownerId)) fail(400, 'Unknown user');

    const unit: Unit = hasGrams ? 'g' : 'portion';
    const buyQty = hasGrams ? body.total_g! : body.portions!;
    const portionG = hasPortions && hasGrams ? round3(body.total_g! / body.portions!) : null;
    const step = hasGrams ? (portionG ?? 50) : 1;
    const packSize = buyQty;

    // Aggregate & validate ingredients
    const agg = new Map<number, number>();
    for (const ing of body.ingredients) {
      agg.set(ing.item_id, round3((agg.get(ing.item_id) ?? 0) + ing.qty));
    }

    let ingKcal = 0;
    let ingProtein = 0;
    let ingFat = 0;
    let ingCarbs = 0;
    let hasKcal = false;
    let hasProtein = false;
    let hasFat = false;
    let hasCarbs = false;
    let ingCost = 0;
    let hasCost = false;
    const ingList: { item_id: number; qty: number }[] = [];
    for (const [itemId, qty] of agg) {
      const item = get<{ id: number; unit: Unit; kcal_per_unit: number | null; protein_per_unit: number | null; fat_per_unit: number | null; carbs_per_unit: number | null; cost_per_unit_cents: number | null }>(
        db,
        'SELECT id, unit, kcal_per_unit, protein_per_unit, fat_per_unit, carbs_per_unit, cost_per_unit_cents FROM items WHERE id = ? AND archived_at IS NULL',
        itemId,
      );
      if (!item) fail(400, `Ingredient item ${itemId} does not exist`);
      if (item.unit === 'level') continue;
      ingList.push({ item_id: itemId, qty });
      if (item.kcal_per_unit != null) {
        hasKcal = true;
        ingKcal += qty * item.kcal_per_unit;
      }
      if (item.protein_per_unit != null) {
        hasProtein = true;
        ingProtein += qty * item.protein_per_unit;
      }
      if (item.fat_per_unit != null) {
        hasFat = true;
        ingFat += qty * item.fat_per_unit;
      }
      if (item.carbs_per_unit != null) {
        hasCarbs = true;
        ingCarbs += qty * item.carbs_per_unit;
      }
      if (item.cost_per_unit_cents != null) {
        hasCost = true;
        ingCost += qty * item.cost_per_unit_cents;
      }
    }

    // The ingredients decide the macros; a typed total is only the fallback when they carry no data for that macro.
    const totalKcal = hasKcal ? ingKcal : (body.kcal_total ?? null);
    const totalProtein = hasProtein ? ingProtein : (body.protein_total ?? null);
    const totalFat = hasFat ? ingFat : (body.fat_total ?? null);
    const totalCarbs = hasCarbs ? ingCarbs : (body.carbs_total ?? null);
    const kcalPerUnit = totalKcal != null ? round4(totalKcal / buyQty) : null;
    const proteinPerUnit = totalProtein != null ? round4(totalProtein / buyQty) : null;
    const fatPerUnit = totalFat != null ? round4(totalFat / buyQty) : null;
    const carbsPerUnit = totalCarbs != null ? round4(totalCarbs / buyQty) : null;
    const costPerUnit = hasCost ? round4(ingCost / buyQty) : null;

    const expiresAt = body.expires_at
      ?? (opts?.expires_in_days != null ? addDays(isoDate(at), opts.expires_in_days) : addDays(isoDate(at), 4));

    let mealItemId: number;
    let mealName: string;

    if (body.meal_item_id != null) {
      const existing = get<{ id: number; name: string; emoji: string; owner_id: number | null }>(
        db,
        'SELECT id, name, emoji, owner_id FROM items WHERE id = ? AND archived_at IS NULL',
        body.meal_item_id,
      );
      if (!existing) fail(404, 'No such meal item');
      mealItemId = existing.id;
      mealName = body.name?.trim() || existing.name;
      const nextEmoji = body.emoji?.trim() || existing.emoji;
      const nextOwner = body.owner_id !== undefined ? body.owner_id : existing.owner_id;
      if (nextNameClashes(db, mealName, nextOwner, mealItemId)) clash(mealName);
      run(
        db,
        `UPDATE items SET
           name = ?, name_key = ?, emoji = ?, owner_id = ?, is_cooked = 1,
           unit = ?, step = ?, pack_size = ?, portion_g = ?,
           kcal_per_unit = COALESCE(?, kcal_per_unit),
           protein_per_unit = COALESCE(?, protein_per_unit),
           fat_per_unit = COALESCE(?, fat_per_unit),
           carbs_per_unit = COALESCE(?, carbs_per_unit),
           cost_per_unit_cents = COALESCE(?, cost_per_unit_cents),
           shelf_life_days = COALESCE(shelf_life_days, 4)
         WHERE id = ?`,
        mealName,
        nameKey(mealName),
        nextEmoji,
        nextOwner,
        unit,
        step,
        packSize,
        portionG,
        kcalPerUnit,
        proteinPerUnit,
        fatPerUnit,
        carbsPerUnit,
        costPerUnit,
        mealItemId,
      );
    } else {
      mealName = body.name!.trim();
      const mealEmoji = body.emoji?.trim() || '🍲';
      const old = get<{ id: number; is_cooked: number; archived_at: number | null }>(
        db,
        'SELECT id, is_cooked, archived_at FROM items WHERE name_key = ? AND COALESCE(owner_id, 0) = ?',
        nameKey(mealName),
        ownerId ?? 0,
      );
      if (old && old.archived_at === null) {
        if (!old.is_cooked) clash(mealName);
        mealItemId = old.id;
        run(
          db,
          `UPDATE items SET
             name = ?, emoji = ?, unit = ?, step = ?, pack_size = ?, portion_g = ?,
             kcal_per_unit = COALESCE(?, kcal_per_unit),
             protein_per_unit = COALESCE(?, protein_per_unit),
             fat_per_unit = COALESCE(?, fat_per_unit),
             carbs_per_unit = COALESCE(?, carbs_per_unit),
             cost_per_unit_cents = COALESCE(?, cost_per_unit_cents),
             shelf_life_days = COALESCE(shelf_life_days, 4)
           WHERE id = ?`,
          mealName,
          mealEmoji,
          unit,
          step,
          packSize,
          portionG,
          kcalPerUnit,
          proteinPerUnit,
          fatPerUnit,
          carbsPerUnit,
          costPerUnit,
          mealItemId,
        );
      } else if (old) {
        mealItemId = old.id;
        run(
          db,
          `UPDATE items SET
             name = ?, emoji = ?, category = 'meals', unit = ?, step = ?, pack_size = ?, low_at = NULL,
             owner_id = ?, is_cooked = 1, portion_g = ?, expires_at = NULL, shelf_life_days = 4,
             kcal_per_unit = ?, protein_per_unit = ?, fat_per_unit = ?, carbs_per_unit = ?, cost_per_unit_cents = ?, archived_at = NULL
           WHERE id = ?`,
          mealName,
          mealEmoji,
          unit,
          step,
          packSize,
          ownerId,
          portionG,
          kcalPerUnit,
          proteinPerUnit,
          fatPerUnit,
          carbsPerUnit,
          costPerUnit,
          mealItemId,
        );
      } else {
        mealItemId = Number(
          run(
            db,
            `INSERT INTO items(
               name, name_key, emoji, category, unit, step, pack_size, low_at,
               owner_id, is_cooked, portion_g, expires_at, shelf_life_days, kcal_per_unit, protein_per_unit, fat_per_unit, carbs_per_unit, cost_per_unit_cents, created_at
             ) VALUES (?, ?, ?, 'meals', ?, ?, ?, NULL, ?, 1, ?, NULL, 4, ?, ?, ?, ?, ?, ?)`,
            mealName,
            nameKey(mealName),
            mealEmoji,
            unit,
            step,
            packSize,
            ownerId,
            portionG,
            kcalPerUnit,
            proteinPerUnit,
            fatPerUnit,
            carbsPerUnit,
            costPerUnit,
            at,
          ).lastInsertRowid,
        );
      }
    }

    applyPurchasedLineMeta(db, mealItemId, prevStocks.get(mealItemId) ?? 0, { expires_at: expiresAt, now: at });

    if (ingList.length > 0) {
      run(db, 'DELETE FROM meal_recipes WHERE meal_item_id = ?', mealItemId);
      for (const ing of ingList) {
        run(db, 'INSERT INTO meal_recipes(meal_item_id, ingredient_item_id, qty) VALUES (?, ?, ?)', mealItemId, ing.item_id, ing.qty);
      }
    }

    const eventCids: string[] = [];
    const jobId = opts?.jobId ?? null;
    if (ingList.length > 0) {
      const eatLines = toLines({ kind: 'eat', lines: ingList }, id => unitOf(db, id));
      if (eatLines.length) {
        insertEvent(db, {
          cid: eatCid,
          userId,
          at,
          kind: 'eat',
          source: 'cook',
          note: mealName,
          presetId: null,
          jobId,
          countsNutrition: false,
          lines: eatLines,
        });
        eventCids.push(eatCid);
      }
    }

    insertEvent(db, {
      cid: buyCid,
      userId,
      at,
      kind: 'buy',
      source: opts?.source ?? 'cook',
      note: mealName,
      presetId: null,
      jobId,
      countsNutrition: true,
      lines: [{ item_id: mealItemId, qty: buyQty, is_set: false, expires_at: expiresAt }],
    });
    eventCids.push(buyCid);

    bumpRev(db);
    return { mealItemId, eventCids, prevStocks };
  };

  return transaction(db, exec);
}
