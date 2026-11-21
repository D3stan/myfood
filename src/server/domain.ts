import { computeStock } from '../shared/stock.ts';
import type { EventBody, MeBody, SettingsBody, Unit } from '../shared/types.ts';
import type { Db } from './db.ts';
import { JOLLY_KEY, all, bumpRev, get, run, setMeta, transaction } from './db.ts';

/** An error the routes turn into `{ error }` with this status. */
export function fail(status: 400 | 401 | 403 | 404 | 409 | 429, message: string): never {
  throw Object.assign(new Error(message), { status });
}

/** Stock of every item over all events that are not undone, oldest first. Not floored. */
export function allStock(db: Db): Map<number, number> {
  return computeStock(
    all<{ item_id: number; qty: number; is_set: number; kind: EventBody['kind'] }>(
      db,
      `SELECT l.item_id, l.qty, l.is_set, e.kind FROM event_lines l JOIN events e ON e.cid = l.event_cid
       WHERE e.undone_at IS NULL ORDER BY e.at, e.seq, l.rowid`,
    ).map(l => ({ item_id: l.item_id, qty: l.qty, is_set: !!l.is_set, kind: l.kind })),
  );
}

/** Unit of an item that can be used (exists and is not archived). The archived jolly counts too, but only for an `eat` line. */
export const unitOf = (db: Db, id: number, kind?: EventBody['kind']): Unit | undefined =>
  get<{ unit: Unit }>(
    db,
    "SELECT unit FROM items WHERE id = ? AND (archived_at IS NULL OR (? = 'eat' AND name_key = ?))",
    id,
    kind ?? null,
    JOLLY_KEY,
  )?.unit;

export function patchMe(db: Db, userId: number, b: MeBody): void {
  transaction(db, () => {
    if (b.name !== undefined) {
      if (get(db, 'SELECT 1 FROM users WHERE name = ? AND id <> ?', b.name, userId)) fail(409, `There is already someone called ${b.name}`);
      run(db, 'UPDATE users SET name = ? WHERE id = ?', b.name, userId);
    }
    if (b.emoji !== undefined) run(db, 'UPDATE users SET emoji = ? WHERE id = ?', b.emoji, userId);
    if (b.notify_low !== undefined) run(db, 'UPDATE users SET notify_low = ? WHERE id = ?', b.notify_low ? 1 : 0, userId);
    if (b.notify_expiry !== undefined) run(db, 'UPDATE users SET notify_expiry = ? WHERE id = ?', b.notify_expiry ? 1 : 0, userId);
    if (b.notify_deals !== undefined) run(db, 'UPDATE users SET notify_deals = ? WHERE id = ?', b.notify_deals ? 1 : 0, userId);
    if (b.goals) {
      for (const [k, col] of [['kcal', 'goal_kcal'], ['protein_g', 'goal_protein_g'], ['fat_g', 'goal_fat_g'], ['carbs_g', 'goal_carbs_g']] as const) {
        if (b.goals[k] !== undefined) run(db, `UPDATE users SET ${col} = ? WHERE id = ?`, b.goals[k], userId);
      }
    }
    bumpRev(db);
  });
}

export function patchSettings(db: Db, b: SettingsBody): void {
  if (b.currency === undefined && b.country === undefined) {
    fail(400, 'Provide currency or country');
  }
  transaction(db, () => {
    if (b.currency !== undefined) setMeta(db, 'currency', b.currency.trim());
    if (b.country !== undefined) setMeta(db, 'country', b.country.trim().toLowerCase());
    bumpRev(db);
  });
}
