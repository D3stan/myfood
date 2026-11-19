import { DEFAULT_CURRENCY } from '../shared/currency.ts';
import { CATEGORIES } from '../shared/types.ts';
import type { ExpenseLock, Item, Job, JobMode, Me, State, Unit, User } from '../shared/types.ts';
import { listApiTokens } from './auth.ts';
import type { Db } from './db.ts';
import { all, get, getMeta, getRev } from './db.ts';
import { allStock } from './domain.ts';
import { annotateLevelReadings, mapEvents } from './events/repo.ts';
import type { EventRow } from './events/repo.ts';
import { dealsSummary } from './deals/plan.ts';
import { dailyNutrition } from './nutrition/repo.ts';
import { listPresets } from './presets/repo.ts';
import { hasPushSubscriptions } from './push.ts';
import { settleInfo } from './spend/repo.ts';

const DAY_MS = 86_400_000;

export interface StateEnv { build: string; now: number; ai: boolean | null }

interface ItemRow {
  id: number;
  name: string;
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
}

export function buildState(db: Db, userId: number, env: StateEnv): State {
  const stock = allStock(db);
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

  const items: Item[] = all<ItemRow>(
    db,
    `SELECT id, name, emoji, category, unit, step, pack_size, low_at,
            owner_id, is_cooked, portion_g, expires_at, shelf_life_days, kcal_per_unit, protein_per_unit, fat_per_unit, carbs_per_unit, cost_per_unit_cents
     FROM items WHERE archived_at IS NULL`,
  )
    .map(i => {
      const rec = recipes.get(i.id);
      const item: Item = {
        id: i.id,
        name: i.name,
        emoji: i.emoji,
        category: i.category,
        unit: i.unit,
        step: i.step,
        pack_size: i.pack_size,
        low_at: i.low_at,
        stock: stock.get(i.id) ?? 0,
        owner_id: i.owner_id,
        is_cooked: !!i.is_cooked,
        portion_g: i.portion_g,
        expires_at: i.expires_at,
        shelf_life_days: i.shelf_life_days,
        kcal_per_unit: i.kcal_per_unit,
        protein_per_unit: i.protein_per_unit,
        fat_per_unit: i.fat_per_unit,
        carbs_per_unit: i.carbs_per_unit,
        cost_per_unit_cents: i.cost_per_unit_cents,
      };
      if (rec) item.recipe = rec;
      return item;
    })
    .sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.name.localeCompare(b.name));

  const usual: Record<number, number> = {};
  for (const l of all<{ item_id: number; qty: number }>(
    db,
    `SELECT l.item_id, l.qty FROM event_lines l JOIN events e ON e.cid = l.event_cid
     WHERE e.user_id = ? AND e.kind = 'eat' AND e.source <> 'cook' AND e.undone_at IS NULL AND l.is_set = 0
     ORDER BY e.at DESC, e.seq DESC`,
    userId,
  )) {
    usual[l.item_id] ??= -l.qty;
  }

  const events = mapEvents(
    db,
    all<EventRow>(
      db,
      `SELECT cid, user_id, at, kind, source, note, preset_id, cost_cents, counts_nutrition
       FROM events WHERE undone_at IS NULL ORDER BY at DESC, seq DESC LIMIT 100`,
    ),
  );
  annotateLevelReadings(db, events);

  const expenses = mapEvents(
    db,
    all<EventRow>(
      db,
      `SELECT cid, user_id, at, kind, source, note, preset_id, cost_cents, counts_nutrition
       FROM events WHERE undone_at IS NULL AND cost_cents IS NOT NULL AND at >= ?
       ORDER BY at DESC, seq DESC`,
      env.now - 90 * DAY_MS,
    ),
  );

  const daily_nutrition = dailyNutrition(db, env.now - 90 * DAY_MS);

  const jobs: Job[] = all<{
    id: number;
    mode: JobMode;
    status: Job['status'];
    text: string;
    images: string;
    result: string | null;
    error: string | null;
    event_cids: string;
    created_at: number;
  }>(
    db,
    `SELECT id, mode, status, text, images, result, error, event_cids, created_at FROM jobs
     WHERE user_id = ? AND dismissed_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 10`,
    userId,
  ).map(j => ({
    id: j.id,
    mode: j.mode ?? 'auto',
    status: j.status,
    text: j.text,
    has_images: JSON.parse(j.images).length > 0,
    result: j.result ? JSON.parse(j.result) : null,
    error: j.error,
    event_cids: JSON.parse(j.event_cids),
    created_at: j.created_at,
  }));

  const meRow = get<{ id: number; name: string; emoji: string; notify_low: number; notify_expiry: number; notify_deals: number; goal_kcal: number | null; goal_protein_g: number | null; goal_fat_g: number | null; goal_carbs_g: number | null }>(
    db,
    'SELECT id, name, emoji, notify_low, notify_expiry, notify_deals, goal_kcal, goal_protein_g, goal_fat_g, goal_carbs_g FROM users WHERE id = ?',
    userId,
  )!;
  const me: Me = {
    id: meRow.id,
    name: meRow.name,
    emoji: meRow.emoji,
    notify_low: !!meRow.notify_low,
    notify_expiry: !!meRow.notify_expiry,
    notify_deals: !!meRow.notify_deals,
    goals: { kcal: meRow.goal_kcal, protein_g: meRow.goal_protein_g, fat_g: meRow.goal_fat_g, carbs_g: meRow.goal_carbs_g },
  };

  return {
    rev: getRev(db),
    build: env.build,
    now: env.now,
    me,
    users: all<User>(db, 'SELECT id, name, emoji FROM users ORDER BY id'),
    items,
    presets: listPresets(db, userId),
    usual,
    events,
    jobs,
    ai: { ready: env.ai },
    currency: getMeta(db, 'currency') ?? DEFAULT_CURRENCY,
    country: getMeta(db, 'country') ?? '',
    vapid_public_key: getMeta(db, 'vapid_public_key'),
    push_subscribed: hasPushSubscriptions(db, userId),
    tokens: listApiTokens(db, userId),
    expense_locks: all<ExpenseLock>(db, 'SELECT period, locked_by, locked_at, total_cents, event_count, note FROM expense_locks ORDER BY period DESC'),
    settle: settleInfo(db),
    expenses,
    daily_nutrition,
    guest_code: getMeta(db, 'guest_code') ?? '',
    deals_summary: dealsSummary(db, env.now),
  };
}
