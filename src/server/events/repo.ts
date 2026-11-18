import { addDays, isoDate, isoWeek } from '../../shared/dates.ts';
import { levelParts, nextStock, shown, toLines } from '../../shared/stock.ts';
import type { EventBody, EventLine, EventPatch, FoodEvent, ItemPrice, Source, Unit } from '../../shared/types.ts';
import type { Db } from '../db.ts';
import { all, bumpRev, get, run, transaction } from '../db.ts';
import { allStock, fail, unitOf } from '../domain.ts';

const round1 = (n: number): number => Math.round(n * 10) / 10;

export interface EventRow {
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
  fat_g: number | null;
  carbs_g: number | null;
  value_cents: number | null;
}

const eventLines = (db: Db, cid: string): EventLine[] =>
  all<EventLineRow>(
    db,
    'SELECT item_id, qty, is_set, cost_cents, expires_at, kcal, protein_g, fat_g, carbs_g, value_cents FROM event_lines WHERE event_cid = ? ORDER BY rowid',
    cid,
  ).map(l => {
    const out: EventLine = { item_id: l.item_id, qty: l.qty, is_set: !!l.is_set };
    if (l.cost_cents !== null) out.cost_cents = l.cost_cents;
    if (l.expires_at !== null) out.expires_at = l.expires_at;
    if (l.kcal !== null) out.kcal = l.kcal;
    if (l.protein_g !== null) out.protein_g = l.protein_g;
    if (l.fat_g !== null) out.fat_g = l.fat_g;
    if (l.carbs_g !== null) out.carbs_g = l.carbs_g;
    if (l.value_cents !== null) out.value_cents = l.value_cents;
    return out;
  });

export const mapEvents = (db: Db, rows: EventRow[]): FoodEvent[] =>
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

/** Historical sealed counts for level readings, replayed from the complete active ledger. */
export function annotateLevelReadings(db: Db, events: FoodEvent[]): void {
  const units = new Map(all<{ id: number; unit: Unit }>(db, 'SELECT id, unit FROM items').map(i => [i.id, i.unit]));
  const selected = new Map(events.map(e => [e.cid, e]));
  const stocks = new Map<number, number>();
  const lineIndices = new Map<string, number>();
  for (const row of all<{ cid: string; item_id: number; qty: number; is_set: number; kind: FoodEvent['kind'] }>(
    db,
    `SELECT e.cid, l.item_id, l.qty, l.is_set, e.kind FROM event_lines l JOIN events e ON e.cid = l.event_cid
     WHERE e.undone_at IS NULL ORDER BY e.at, e.seq, l.rowid`,
  )) {
    const line: EventLine = { item_id: row.item_id, qty: row.qty, is_set: !!row.is_set };
    const lineIndex = lineIndices.get(row.cid) ?? 0;
    lineIndices.set(row.cid, lineIndex + 1);
    if (units.get(row.item_id) === 'level' && row.kind === 'eat' && line.is_set && selected.has(row.cid)) {
      const event = selected.get(row.cid);
      const eventLine = event?.lines[lineIndex];
      if (eventLine) eventLine.level_sealed_before = levelParts(stocks.get(row.item_id) ?? 0).sealed;
    }
    stocks.set(row.item_id, nextStock(stocks.get(row.item_id) ?? 0, line, row.kind));
  }
}

function snapshotLineNutrition(db: Db, lines: EventLine[], snapshotNutrition: boolean): EventLine[] {
  if (!snapshotNutrition) return lines;
  type Rate = { kcal_per_unit: number | null; protein_per_unit: number | null; fat_per_unit: number | null; carbs_per_unit: number | null; cost_per_unit_cents: number | null };
  const rates = new Map<number, Rate>();
  return lines.map(l => {
    if (l.is_set) return l;
    let rate = rates.get(l.item_id);
    if (!rate) {
      rate = get<Rate>(
        db,
        'SELECT kcal_per_unit, protein_per_unit, fat_per_unit, carbs_per_unit, cost_per_unit_cents FROM items WHERE id = ?',
        l.item_id,
      ) ?? { kcal_per_unit: null, protein_per_unit: null, fat_per_unit: null, carbs_per_unit: null, cost_per_unit_cents: null };
      rates.set(l.item_id, rate);
    }
    const q = Math.abs(l.qty);
    const kcal = l.kcal ?? (rate.kcal_per_unit != null ? Math.round(q * rate.kcal_per_unit) : null);
    const protein_g = l.protein_g ?? (rate.protein_per_unit != null ? round1(q * rate.protein_per_unit) : null);
    const fat_g = l.fat_g ?? (rate.fat_per_unit != null ? round1(q * rate.fat_per_unit) : null);
    const carbs_g = l.carbs_g ?? (rate.carbs_per_unit != null ? round1(q * rate.carbs_per_unit) : null);
    const value_cents = l.value_cents ?? (rate.cost_per_unit_cents != null ? Math.round(q * rate.cost_per_unit_cents) : null);
    return {
      ...l,
      ...(value_cents !== null ? { value_cents } : {}),
      ...(kcal !== null ? { kcal } : {}),
      ...(protein_g !== null ? { protein_g } : {}),
      ...(fat_g !== null ? { fat_g } : {}),
      ...(carbs_g !== null ? { carbs_g } : {}),
    };
  });
}

const insertLines = (db: Db, cid: string, lines: EventLine[]): void => {
  for (const l of lines) {
    run(
      db,
      'INSERT INTO event_lines(event_cid, item_id, qty, is_set, cost_cents, expires_at, kcal, protein_g, fat_g, carbs_g, value_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      cid,
      l.item_id,
      l.qty,
      l.is_set ? 1 : 0,
      l.cost_cents ?? null,
      l.expires_at ?? null,
      l.kcal ?? null,
      l.protein_g ?? null,
      l.fat_g ?? null,
      l.carbs_g ?? null,
      l.value_cents ?? null,
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
  if (e.kind === 'buy') learnBuyPrices(db, e.lines, costCents);
  return seq;
}

/** One row per live, non-set buy line of item ?1: when, and its per-unit price `u` (a lone line without its own cost takes the event cost). */
const PRICED_BUYS = `SELECT e.at, e.seq, COALESCE(l.cost_cents, CASE WHEN (SELECT COUNT(*) FROM event_lines x WHERE x.event_cid = e.cid) = 1 THEN e.cost_cents END) * 1.0 / l.qty AS u
  FROM event_lines l JOIN events e ON e.cid = l.event_cid
  WHERE l.item_id = ?1 AND e.kind = 'buy' AND e.undone_at IS NULL AND l.is_set = 0 AND l.qty > 0`;

/** The item's last `limit` priced buys, newest first (what the learned price averages the top 3 of). */
export function itemPrices(db: Db, itemId: number, limit = 10): ItemPrice[] {
  return all<ItemPrice>(db, `SELECT at, u AS unit_cents FROM (${PRICED_BUYS}) WHERE u > 0 ORDER BY at DESC, seq DESC LIMIT ?2`, itemId, limit);
}

/** Item price = average per-unit price of its last 3 priced, live buys. A lone line without its own cost takes the event cost (barcode / quick buys). Level items have no per-unit price. */
function learnBuyPrices(db: Db, lines: NewEvent['lines'], eventCost: number | null): void {
  for (const l of lines) {
    const cost = l.cost_cents ?? (lines.length === 1 ? eventCost : null);
    if (!l.is_set && l.qty > 0 && cost != null && cost > 0) {
      run(db, `UPDATE items SET cost_per_unit_cents = (SELECT AVG(u) FROM (
          SELECT u FROM (${PRICED_BUYS}) WHERE u > 0 ORDER BY at DESC, seq DESC LIMIT 3))
        WHERE id = ?1 AND unit <> 'level'`, l.item_id);
    }
  }
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
    const previousLines = all<{ item_id: number; is_set: number }>(db, 'SELECT item_id, is_set FROM event_lines WHERE event_cid = ?', cid);
    const previousByItem = new Map(previousLines.map(l => [l.item_id, !!l.is_set]));
    const lines = toLines({ kind: ev.kind, lines: body.lines }, id => unitOf(db, id));
    // Older level purchases were stored as absolute set lines. Preserve that meaning if edited.
    if (ev.kind === 'buy') for (const line of lines) {
      if (unitOf(db, line.item_id) === 'level' && previousByItem.get(line.item_id)) line.is_set = true;
    }
    if (!lines.length) noLines();

    const lineCost = sumLineCosts(lines);
    const nextCost = body.cost_cents !== undefined ? body.cost_cents : (lineCost !== null ? lineCost : ev.cost_cents);
    if (ev.cost_cents != null || nextCost != null) assertPeriodUnlocked(db, ev.at);

    const nextNote = body.note !== undefined ? (body.note || null) : ev.note;
    run(db, 'UPDATE events SET cost_cents = ?, note = ? WHERE cid = ?', nextCost, nextNote, cid);
    run(db, 'DELETE FROM event_lines WHERE event_cid = ?', cid);
    const prepared = snapshotLineNutrition(db, lines, ev.kind === 'eat' && !!ev.counts_nutrition);
    insertLines(db, cid, prepared);
    if (ev.kind === 'buy') learnBuyPrices(db, lines, nextCost);
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

// ---- JSON views (MCP) ----

export interface EventRowFull {
  cid: string;
  seq: number;
  user_id: number;
  at: number;
  kind: FoodEvent['kind'];
  source: Source;
  note: string | null;
  preset_id: number | null;
  cost_cents: number | null;
  counts_nutrition: number;
  undone_at: number | null;
}

interface EventLineRowLite {
  item_id: number;
  qty: number;
  is_set: number;
  cost_cents: number | null;
  expires_at: string | null;
  kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
}

function hydrateEventLines(db: Db, cid: string) {
  return all<EventLineRowLite>(
    db,
    'SELECT item_id, qty, is_set, cost_cents, expires_at, kcal, protein_g, fat_g, carbs_g FROM event_lines WHERE event_cid = ? ORDER BY rowid',
    cid,
  ).map(l => ({
    item_id: l.item_id,
    qty: l.qty,
    is_set: !!l.is_set,
    ...(l.cost_cents !== null ? { cost_cents: l.cost_cents } : {}),
    ...(l.expires_at !== null ? { expires_at: l.expires_at } : {}),
    ...(l.kcal !== null ? { kcal: l.kcal } : {}),
    ...(l.protein_g !== null ? { protein_g: l.protein_g } : {}),
    ...(l.fat_g !== null ? { fat_g: l.fat_g } : {}),
    ...(l.carbs_g !== null ? { carbs_g: l.carbs_g } : {}),
  }));
}

export function eventRowToJson(db: Db, ev: EventRowFull, withUndone = false) {
  return {
    cid: ev.cid,
    seq: ev.seq,
    user_id: ev.user_id,
    at: ev.at,
    kind: ev.kind,
    source: ev.source,
    note: ev.note,
    preset_id: ev.preset_id,
    cost_cents: ev.cost_cents,
    counts_nutrition: !!ev.counts_nutrition,
    ...(withUndone ? { undone_at: ev.undone_at } : {}),
    lines: hydrateEventLines(db, ev.cid),
  };
}

export function hydrateEventByCid(db: Db, cid: string): (FoodEvent & { seq: number }) | null {
  const ev = get<EventRowFull>(
    db,
    `SELECT cid, seq, user_id, at, kind, source, note, preset_id, cost_cents, counts_nutrition, undone_at
     FROM events WHERE cid = ?`,
    cid,
  );
  return ev ? eventRowToJson(db, ev) : null;
}
