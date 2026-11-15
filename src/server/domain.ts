import { addDays, isoDate, isoWeek, weekRange } from '../shared/dates.ts';
import { computeStock, eventLineNutrition, shown, toLines } from '../shared/stock.ts';
import { nameKey } from '../shared/text.ts';
import { CATEGORIES } from '../shared/types.ts';
import type {
  CookBody,
  DailyNutrition,
  EventBody,
  EventLine,
  EventPatch,
  ExpenseBody,
  ExpenseLock,
  FoodEvent,
  Item,
  ItemBody,
  ItemPatch,
  Job,
  JobMode,
  LockPeriodBody,
  Me,
  MeBody,
  Preset,
  PresetBody,
  SettingsBody,
  Source,
  State,
  Unit,
  User,
} from '../shared/types.ts';
import { listApiTokens } from './auth.ts';
import type { Db } from './db.ts';
import { all, bumpRev, get, getMeta, getRev, run, setMeta, transaction } from './db.ts';
import { hasPushSubscriptions, notifyLowCrossings } from './push.ts';
import type { PushSender } from './push.ts';

export { notifyLowCrossings };
export type { PushSender };

const DAY_MS = 86_400_000;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** An error the routes turn into `{ error }` with this status. */
export function fail(status: 400 | 401 | 403 | 404 | 409 | 429, message: string): never {
  throw Object.assign(new Error(message), { status });
}

/** Stock of every item over all events that are not undone, oldest first. Not floored. */
export function allStock(db: Db): Map<number, number> {
  return computeStock(
    all<{ item_id: number; qty: number; is_set: number }>(
      db,
      `SELECT l.item_id, l.qty, l.is_set FROM event_lines l JOIN events e ON e.cid = l.event_cid
       WHERE e.undone_at IS NULL ORDER BY e.at, e.seq, l.rowid`,
    ).map(l => ({ item_id: l.item_id, qty: l.qty, is_set: !!l.is_set })),
  );
}

/** Unit of an item that can be used (exists and is not archived). */
export const unitOf = (db: Db, id: number): Unit | undefined =>
  get<{ unit: Unit }>(db, 'SELECT unit FROM items WHERE id = ? AND archived_at IS NULL', id)?.unit;

export function listPresets(db: Db, userId: number): Preset[] {
  return all<Omit<Preset, 'lines'>>(db, 'SELECT id, user_id, name, emoji, hour FROM presets WHERE user_id = ? ORDER BY id', userId).map(p => ({
    ...p,
    lines: all<{ item_id: number; qty: number }>(db, 'SELECT item_id, qty FROM preset_lines WHERE preset_id = ? ORDER BY rowid', p.id),
  }));
}

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
}

interface EventRow {
  cid: string;
  user_id: number;
  at: number;
  kind: FoodEvent['kind'];
  source: Source;
  note: string | null;
  preset_id: number | null;
  cost_cents: number | null;
  counts_nutrition: number;
}

interface EventLineRow {
  item_id: number;
  qty: number;
  is_set: number;
  cost_cents: number | null;
  expires_at: string | null;
  kcal: number | null;
  protein_g: number | null;
}

const eventLines = (db: Db, cid: string): EventLine[] =>
  all<EventLineRow>(
    db,
    'SELECT item_id, qty, is_set, cost_cents, expires_at, kcal, protein_g FROM event_lines WHERE event_cid = ? ORDER BY rowid',
    cid,
  ).map(l => {
    const out: EventLine = { item_id: l.item_id, qty: l.qty, is_set: !!l.is_set };
    if (l.cost_cents !== null) out.cost_cents = l.cost_cents;
    if (l.expires_at !== null) out.expires_at = l.expires_at;
    if (l.kcal !== null) out.kcal = l.kcal;
    if (l.protein_g !== null) out.protein_g = l.protein_g;
    return out;
  });

const mapEvents = (db: Db, rows: EventRow[]): FoodEvent[] =>
  rows.map(e => ({
    cid: e.cid,
    user_id: e.user_id,
    at: e.at,
    kind: e.kind,
    source: e.source,
    note: e.note,
    preset_id: e.preset_id,
    cost_cents: e.cost_cents,
    counts_nutrition: !!e.counts_nutrition,
    lines: eventLines(db, e.cid),
  }));

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
            owner_id, is_cooked, portion_g, expires_at, shelf_life_days, kcal_per_unit, protein_per_unit
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

  const dailyMap = new Map<string, DailyNutrition>();
  for (const r of all<{
    at: number;
    user_id: number;
    item_id: number;
    qty: number;
    is_set: number;
    kcal: number | null;
    protein_g: number | null;
    kcal_per_unit: number | null;
    protein_per_unit: number | null;
  }>(
    db,
    `SELECT e.at, e.user_id, l.item_id, l.qty, l.is_set, l.kcal, l.protein_g, i.kcal_per_unit, i.protein_per_unit
     FROM event_lines l
     JOIN events e ON e.cid = l.event_cid
     JOIN items i ON i.id = l.item_id
     WHERE e.undone_at IS NULL AND e.kind = 'eat' AND e.counts_nutrition = 1 AND e.at >= ?`,
    env.now - 30 * DAY_MS,
  )) {
    if (r.is_set) continue;
    const n = eventLineNutrition(
      { item_id: r.item_id, qty: r.qty, is_set: false, kcal: r.kcal, protein_g: r.protein_g },
      { kcal_per_unit: r.kcal_per_unit, protein_per_unit: r.protein_per_unit },
    );
    if (n.kcal <= 0 && n.protein_g <= 0) continue;
    const day = isoDate(r.at);
    const key = `${day}:${r.user_id}`;
    const cur = dailyMap.get(key);
    if (cur) {
      cur.kcal = Math.round(cur.kcal + n.kcal);
      cur.protein_g = round1(cur.protein_g + n.protein_g);
    } else {
      dailyMap.set(key, { day, user_id: r.user_id, kcal: Math.round(n.kcal), protein_g: round1(n.protein_g) });
    }
  }
  const daily_nutrition = [...dailyMap.values()].sort((a, b) =>
    a.day === b.day ? a.user_id - b.user_id : b.day.localeCompare(a.day),
  );

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

  const meRow = get<{ id: number; name: string; emoji: string; notify_low: number; notify_expiry: number }>(
    db,
    'SELECT id, name, emoji, notify_low, notify_expiry FROM users WHERE id = ?',
    userId,
  )!;
  const me: Me = {
    id: meRow.id,
    name: meRow.name,
    emoji: meRow.emoji,
    notify_low: !!meRow.notify_low,
    notify_expiry: !!meRow.notify_expiry,
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
    currency: getMeta(db, 'currency') ?? 'kr',
    vapid_public_key: getMeta(db, 'vapid_public_key'),
    push_subscribed: hasPushSubscriptions(db, userId),
    tokens: listApiTokens(db, userId),
    expense_locks: all<ExpenseLock>(db, 'SELECT period, locked_by, locked_at, total_cents, event_count, note FROM expense_locks ORDER BY period DESC'),
    expenses,
    daily_nutrition,
  };
}

function snapshotLineNutrition(db: Db, lines: EventLine[], snapshotNutrition: boolean): EventLine[] {
  if (!snapshotNutrition) return lines;
  const rates = new Map<number, { kcal_per_unit: number | null; protein_per_unit: number | null }>();
  return lines.map(l => {
    if (l.is_set) return l;
    let rate = rates.get(l.item_id);
    if (!rate) {
      rate = get<{ kcal_per_unit: number | null; protein_per_unit: number | null }>(
        db,
        'SELECT kcal_per_unit, protein_per_unit FROM items WHERE id = ?',
        l.item_id,
      ) ?? { kcal_per_unit: null, protein_per_unit: null };
      rates.set(l.item_id, rate);
    }
    const q = Math.abs(l.qty);
    const kcal = l.kcal ?? (rate.kcal_per_unit != null ? Math.round(q * rate.kcal_per_unit) : null);
    const protein_g = l.protein_g ?? (rate.protein_per_unit != null ? round1(q * rate.protein_per_unit) : null);
    return {
      ...l,
      ...(kcal !== null ? { kcal } : {}),
      ...(protein_g !== null ? { protein_g } : {}),
    };
  });
}

const insertLines = (db: Db, cid: string, lines: EventLine[]): void => {
  for (const l of lines) {
    run(
      db,
      'INSERT INTO event_lines(event_cid, item_id, qty, is_set, cost_cents, expires_at, kcal, protein_g) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      cid,
      l.item_id,
      l.qty,
      l.is_set ? 1 : 0,
      l.cost_cents ?? null,
      l.expires_at ?? null,
      l.kcal ?? null,
      l.protein_g ?? null,
    );
  }
};

export interface NewEvent {
  cid: string;
  userId: number;
  at: number;
  kind: EventBody['kind'];
  source: Source;
  note: string | null;
  presetId: number | null;
  jobId: number | null;
  costCents?: number | null;
  countsNutrition?: boolean;
  lines: EventLine[];
}

function sumLineCosts(lines: { cost_cents?: number | null }[]): number | null {
  let has = false;
  let total = 0;
  for (const l of lines) {
    if (l.cost_cents != null) {
      has = true;
      total += l.cost_cents;
    }
  }
  return has ? total : null;
}

/** Inserts an event and its lines (snapshotting nutrition on eat). Call inside a transaction. Returns seq. */
export function insertEvent(db: Db, e: NewEvent): number {
  const countsNutrition = e.countsNutrition ?? true;
  const costCents = e.costCents !== undefined ? e.costCents : sumLineCosts(e.lines);
  const seqRow = get<{ next_seq: number }>(db, 'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM events')!;
  const seq = seqRow.next_seq;
  run(
    db,
    `INSERT INTO events(cid, seq, user_id, at, kind, source, note, preset_id, job_id, cost_cents, counts_nutrition)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    e.cid,
    seq,
    e.userId,
    e.at,
    e.kind,
    e.source,
    e.note,
    e.presetId,
    e.jobId,
    costCents,
    countsNutrition ? 1 : 0,
  );
  const preparedLines = snapshotLineNutrition(db, e.lines, e.kind === 'eat' && countsNutrition);
  insertLines(db, e.cid, preparedLines);
  return seq;
}

export function assertPeriodUnlocked(db: Db, atMs: number): void {
  const period = isoWeek(atMs);
  if (get(db, 'SELECT 1 FROM expense_locks WHERE period = ?', period)) {
    fail(409, `Week ${period} is locked`);
  }
}

export function applyPurchasedLineMeta(
  db: Db,
  itemId: number,
  prevStock: number,
  meta: { expires_at?: string | null; expires_in_days?: number | null; shelf_life_days?: number | null; now?: number },
): void {
  const item = get<{ expires_at: string | null; shelf_life_days: number | null }>(
    db,
    'SELECT expires_at, shelf_life_days FROM items WHERE id = ?',
    itemId,
  );
  if (!item) return;

  const baseNow = meta.now ?? Date.now();
  let candidate: string | null = null;
  if (meta.expires_at) {
    candidate = meta.expires_at;
  } else if (meta.expires_in_days != null) {
    candidate = addDays(isoDate(baseNow), meta.expires_in_days);
  } else {
    const days = meta.shelf_life_days ?? item.shelf_life_days;
    if (days != null) candidate = addDays(isoDate(baseNow), days);
  }
  if (!candidate) return;

  const nextExpiry = shown(prevStock) <= 0 || !item.expires_at
    ? candidate
    : (candidate < item.expires_at ? candidate : item.expires_at);
  run(db, 'UPDATE items SET expires_at = ? WHERE id = ?', nextExpiry, itemId);
}

const noLines = (): never => fail(400, 'None of those items exist any more');

export function createEvent(
  db: Db,
  userId: number,
  body: EventBody,
  now: number,
  opts?: { source?: Source },
): { prevStocks: Map<number, number>; seq: number | null } {
  return transaction(db, () => {
    const prevStocks = allStock(db);
    if (get(db, 'SELECT 1 FROM events WHERE cid = ?', body.cid)) {
      return { prevStocks, seq: null };
    }
    const lines = toLines(body, id => unitOf(db, id));
    if (!lines.length) noLines();
    const at = Math.min(body.at, now);
    const costCents = body.cost_cents !== undefined ? body.cost_cents : sumLineCosts(lines);
    if (costCents != null) assertPeriodUnlocked(db, at);

    const presetId = body.preset_id && get(db, 'SELECT 1 FROM presets WHERE id = ? AND user_id = ?', body.preset_id, userId)
      ? body.preset_id
      : null;
    const seq = insertEvent(db, {
      cid: body.cid,
      userId,
      at,
      kind: body.kind,
      source: opts?.source ?? (presetId ? 'preset' : 'manual'),
      note: body.note || null,
      presetId,
      jobId: null,
      costCents,
      countsNutrition: true,
      lines,
    });

    if (body.kind === 'buy') {
      for (const l of lines) {
        applyPurchasedLineMeta(db, l.item_id, prevStocks.get(l.item_id) ?? 0, {
          expires_at: l.expires_at ?? null,
          now: at,
        });
      }
    }

    bumpRev(db);
    return { prevStocks, seq };
  });
}

export function editEvent(db: Db, cid: string, body: EventPatch): Map<number, number> {
  return transaction(db, () => {
    const prevStocks = allStock(db);
    const ev = get<{ at: number; kind: EventBody['kind']; cost_cents: number | null; counts_nutrition: number; note: string | null }>(
      db,
      'SELECT at, kind, cost_cents, counts_nutrition, note FROM events WHERE cid = ? AND undone_at IS NULL',
      cid,
    );
    if (!ev) fail(404, 'No such event');
    const lines = toLines({ kind: ev.kind, lines: body.lines }, id => unitOf(db, id));
    if (!lines.length) noLines();

    const lineCost = sumLineCosts(lines);
    const nextCost = body.cost_cents !== undefined ? body.cost_cents : (lineCost !== null ? lineCost : ev.cost_cents);
    if (ev.cost_cents != null || nextCost != null) assertPeriodUnlocked(db, ev.at);

    const nextNote = body.note !== undefined ? (body.note || null) : ev.note;
    run(db, 'UPDATE events SET cost_cents = ?, note = ? WHERE cid = ?', nextCost, nextNote, cid);
    run(db, 'DELETE FROM event_lines WHERE event_cid = ?', cid);
    const prepared = snapshotLineNutrition(db, lines, ev.kind === 'eat' && !!ev.counts_nutrition);
    insertLines(db, cid, prepared);
    bumpRev(db);
    return prevStocks;
  });
}

export function undoEvent(db: Db, cid: string, now: number): void {
  transaction(db, () => {
    const ev = get<{ undone_at: number | null; at: number; cost_cents: number | null }>(
      db,
      'SELECT undone_at, at, cost_cents FROM events WHERE cid = ?',
      cid,
    );
    if (!ev) fail(404, 'No such event');
    if (ev.undone_at !== null) return;
    if (ev.cost_cents != null) assertPeriodUnlocked(db, ev.at);
    run(db, 'UPDATE events SET undone_at = ? WHERE cid = ?', now, cid);
    bumpRev(db);
  });
}

// ---- cooked meals ----

export interface CookBatchOptions {
  now?: number;
  source?: Source;
  jobId?: number | null;
  inTx?: boolean;
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
    let hasKcal = false;
    let hasProtein = false;
    const ingList: { item_id: number; qty: number }[] = [];
    for (const [itemId, qty] of agg) {
      const item = get<{ id: number; kcal_per_unit: number | null; protein_per_unit: number | null }>(
        db,
        'SELECT id, kcal_per_unit, protein_per_unit FROM items WHERE id = ? AND archived_at IS NULL',
        itemId,
      );
      if (!item) fail(400, `Ingredient item ${itemId} does not exist`);
      ingList.push({ item_id: itemId, qty });
      if (item.kcal_per_unit != null) {
        hasKcal = true;
        ingKcal += qty * item.kcal_per_unit;
      }
      if (item.protein_per_unit != null) {
        hasProtein = true;
        ingProtein += qty * item.protein_per_unit;
      }
    }

    const totalKcal = body.kcal_total ?? (hasKcal ? ingKcal : null);
    const totalProtein = body.protein_total ?? (hasProtein ? ingProtein : null);
    const kcalPerUnit = totalKcal != null ? round4(totalKcal / buyQty) : null;
    const proteinPerUnit = totalProtein != null ? round4(totalProtein / buyQty) : null;

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
          mealItemId,
        );
      } else if (old) {
        mealItemId = old.id;
        run(
          db,
          `UPDATE items SET
             name = ?, emoji = ?, category = 'meals', unit = ?, step = ?, pack_size = ?, low_at = NULL,
             owner_id = ?, is_cooked = 1, portion_g = ?, expires_at = NULL, shelf_life_days = 4,
             kcal_per_unit = ?, protein_per_unit = ?, archived_at = NULL
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
          mealItemId,
        );
      } else {
        mealItemId = Number(
          run(
            db,
            `INSERT INTO items(
               name, name_key, emoji, category, unit, step, pack_size, low_at,
               owner_id, is_cooked, portion_g, expires_at, shelf_life_days, kcal_per_unit, protein_per_unit, created_at
             ) VALUES (?, ?, ?, 'meals', ?, ?, ?, NULL, ?, 1, ?, NULL, 4, ?, ?, ?)`,
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

  return opts?.inTx ? exec() : transaction(db, exec);
}

// ---- expenses ----

export function addExpense(db: Db, userId: number, body: ExpenseBody, now: number): void {
  transaction(db, () => {
    if (get(db, 'SELECT 1 FROM events WHERE cid = ?', body.cid)) return;
    const at = Math.min(body.at, now);
    assertPeriodUnlocked(db, at);
    insertEvent(db, {
      cid: body.cid,
      userId,
      at,
      kind: 'buy',
      source: 'expense',
      note: body.note || null,
      presetId: null,
      jobId: null,
      costCents: body.cost_cents,
      countsNutrition: false,
      lines: [],
    });
    bumpRev(db);
  });
}

export function lockExpensePeriod(db: Db, userId: number, body: LockPeriodBody, now: number): void {
  const range = weekRange(body.period);
  if (!range) fail(400, 'Invalid ISO week');
  transaction(db, () => {
    if (get(db, 'SELECT 1 FROM expense_locks WHERE period = ?', body.period)) {
      fail(409, `Week ${body.period} is already locked`);
    }
    const agg = get<{ total_cents: number; event_count: number }>(
      db,
      `SELECT COALESCE(SUM(cost_cents), 0) AS total_cents, COUNT(*) AS event_count
       FROM events WHERE undone_at IS NULL AND cost_cents IS NOT NULL AND at >= ? AND at < ?`,
      range.start,
      range.end,
    )!;
    run(
      db,
      'INSERT INTO expense_locks(period, locked_by, locked_at, total_cents, event_count, note) VALUES (?, ?, ?, ?, ?, ?)',
      body.period,
      userId,
      now,
      agg.total_cents,
      agg.event_count,
      body.note ?? null,
    );
    bumpRev(db);
  });
}

function csvCell(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function exportExpenses(
  db: Db,
  opts: { period?: string; format: 'csv' | 'json' },
): { contentType: string; filename: string; body: string } {
  const currency = getMeta(db, 'currency') ?? 'kr';
  let rows: { cid: string; at: number; user_id: number; user_name: string; source: Source; note: string | null; cost_cents: number }[];
  if (opts.period) {
    const range = weekRange(opts.period);
    if (!range) fail(400, 'Invalid ISO week');
    rows = all(
      db,
      `SELECT e.cid, e.at, e.user_id, u.name AS user_name, e.source, e.note, e.cost_cents
       FROM events e JOIN users u ON u.id = e.user_id
       WHERE e.undone_at IS NULL AND e.cost_cents IS NOT NULL AND e.at >= ? AND e.at < ?
       ORDER BY e.at DESC, e.seq DESC`,
      range.start,
      range.end,
    );
  } else {
    rows = all(
      db,
      `SELECT e.cid, e.at, e.user_id, u.name AS user_name, e.source, e.note, e.cost_cents
       FROM events e JOIN users u ON u.id = e.user_id
       WHERE e.undone_at IS NULL AND e.cost_cents IS NOT NULL
       ORDER BY e.at DESC, e.seq DESC`,
    );
  }

  const enriched = rows.map(r => {
    const items = all<{ name: string }>(
      db,
      'SELECT i.name FROM event_lines l JOIN items i ON i.id = l.item_id WHERE l.event_cid = ? ORDER BY l.rowid',
      r.cid,
    ).map(x => x.name);
    return {
      cid: r.cid,
      date: isoDate(r.at),
      week: isoWeek(r.at),
      at: r.at,
      user_id: r.user_id,
      user: r.user_name,
      source: r.source,
      note: r.note,
      items,
      cost_cents: r.cost_cents,
      amount: (r.cost_cents / 100).toFixed(2),
      currency,
    };
  });

  const tag = opts.period ?? 'all';
  if (opts.format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      filename: `myfood-expenses-${tag}.json`,
      body: JSON.stringify({ period: tag, currency, expenses: enriched }, null, 2),
    };
  }

  const header = 'date,week,user,source,note,items,cost_cents,amount,currency';
  const lines = enriched.map(r =>
    [r.date, r.week, r.user, r.source, r.note ?? '', r.items.join('; '), r.cost_cents, r.amount, r.currency]
      .map(csvCell)
      .join(','),
  );
  return {
    contentType: 'text/csv; charset=utf-8',
    filename: `myfood-expenses-${tag}.csv`,
    body: [header, ...lines].join('\n'),
  };
}

// ---- items ----

const clash = (name: string): never => fail(409, `There is already an item called ${name}`);

function nextNameClashes(db: Db, name: string, ownerId: number | null, excludeId?: number): boolean {
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
           kcal_per_unit = ?, protein_per_unit = ?, archived_at = NULL
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
        itemId,
      );
    } else {
      itemId = Number(
        run(
          db,
          `INSERT INTO items(
             name, name_key, emoji, category, unit, step, pack_size, low_at,
             owner_id, is_cooked, portion_g, expires_at, shelf_life_days, kcal_per_unit, protein_per_unit, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

// ---- presets ----

function writePresetLines(db: Db, presetId: number, lines: PresetBody['lines']): void {
  const sum = new Map<number, number>();
  for (const l of lines) {
    if (!unitOf(db, l.item_id)) fail(400, 'A preset line points at an item that does not exist');
    sum.set(l.item_id, (sum.get(l.item_id) ?? 0) + l.qty);
  }
  run(db, 'DELETE FROM preset_lines WHERE preset_id = ?', presetId);
  for (const [item, qty] of sum) run(db, 'INSERT INTO preset_lines(preset_id, item_id, qty) VALUES (?, ?, ?)', presetId, item, qty);
}

export function createPreset(db: Db, userId: number, b: PresetBody): void {
  transaction(db, () => {
    const id = Number(run(db, 'INSERT INTO presets(user_id, name, emoji, hour) VALUES (?, ?, ?, ?)', userId, b.name, b.emoji, b.hour).lastInsertRowid);
    writePresetLines(db, id, b.lines);
    bumpRev(db);
  });
}

const ownPreset = (db: Db, id: number, userId: number): void => {
  if (!get(db, 'SELECT 1 FROM presets WHERE id = ? AND user_id = ?', id, userId)) fail(404, 'No such preset');
};

export function patchPreset(db: Db, userId: number, id: number, b: PresetBody): void {
  transaction(db, () => {
    ownPreset(db, id, userId);
    run(db, 'UPDATE presets SET name = ?, emoji = ?, hour = ? WHERE id = ?', b.name, b.emoji, b.hour, id);
    writePresetLines(db, id, b.lines);
    bumpRev(db);
  });
}

export function deletePreset(db: Db, userId: number, id: number): void {
  transaction(db, () => {
    ownPreset(db, id, userId);
    run(db, 'DELETE FROM preset_lines WHERE preset_id = ?', id);
    run(db, 'DELETE FROM presets WHERE id = ?', id);
    bumpRev(db);
  });
}

export function patchMe(db: Db, userId: number, b: MeBody): void {
  transaction(db, () => {
    if (b.name !== undefined) {
      if (get(db, 'SELECT 1 FROM users WHERE name = ? AND id <> ?', b.name, userId)) fail(409, `There is already someone called ${b.name}`);
      run(db, 'UPDATE users SET name = ? WHERE id = ?', b.name, userId);
    }
    if (b.emoji !== undefined) run(db, 'UPDATE users SET emoji = ? WHERE id = ?', b.emoji, userId);
    if (b.notify_low !== undefined) run(db, 'UPDATE users SET notify_low = ? WHERE id = ?', b.notify_low ? 1 : 0, userId);
    if (b.notify_expiry !== undefined) run(db, 'UPDATE users SET notify_expiry = ? WHERE id = ?', b.notify_expiry ? 1 : 0, userId);
    bumpRev(db);
  });
}

export function patchSettings(db: Db, b: SettingsBody): void {
  transaction(db, () => {
    setMeta(db, 'currency', b.currency.trim());
    bumpRev(db);
  });
}
