import { CATEGORIES } from '../shared/types.ts';
import type { EventBody, EventLine, FoodEvent, Item, ItemBody, ItemPatch, Job, MeBody, Preset, PresetBody, Source, State, Unit, User } from '../shared/types.ts';
import { computeStock, toLines } from '../shared/stock.ts';
import { nameKey } from '../shared/text.ts';
import type { Db } from './db.ts';
import { all, bumpRev, get, getRev, run, transaction } from './db.ts';

/** An error the routes turn into `{ error }` with this status. */
export function fail(status: 400 | 401 | 404 | 409 | 429, message: string): never {
  throw Object.assign(new Error(message), { status });
}

/** Stock of every item over all events that are not undone, oldest first. Not floored. */
export function allStock(db: Db): Map<number, number> {
  return computeStock(all<{ item_id: number; qty: number; is_set: number }>(db,
    `SELECT l.item_id, l.qty, l.is_set FROM event_lines l JOIN events e ON e.cid = l.event_cid
     WHERE e.undone_at IS NULL ORDER BY e.at, e.seq, l.rowid`).map(l => ({ item_id: l.item_id, qty: l.qty, is_set: !!l.is_set })));
}

/** Unit of an item that can be used (exists and is not archived). */
export const unitOf = (db: Db, id: number): Unit | undefined =>
  get<{ unit: Unit }>(db, 'SELECT unit FROM items WHERE id = ? AND archived_at IS NULL', id)?.unit;

export function listPresets(db: Db, userId: number): Preset[] {
  return all<Omit<Preset, 'lines'>>(db, 'SELECT id, user_id, name, emoji, hour FROM presets WHERE user_id = ? ORDER BY id', userId).map(p => ({
    ...p, lines: all<{ item_id: number; qty: number }>(db, 'SELECT item_id, qty FROM preset_lines WHERE preset_id = ? ORDER BY rowid', p.id),
  }));
}

export interface StateEnv { build: string; now: number; ai: boolean | null }

export function buildState(db: Db, userId: number, env: StateEnv): State {
  const stock = allStock(db);
  const items = all<Omit<Item, 'stock'>>(db,
    'SELECT id, name, emoji, category, unit, step, pack_size, low_at FROM items WHERE archived_at IS NULL')
    .map(i => ({ ...i, stock: stock.get(i.id) ?? 0 }))
    .sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.name.localeCompare(b.name));

  const usual: Record<number, number> = {};
  for (const l of all<{ item_id: number; qty: number }>(db,
    `SELECT l.item_id, l.qty FROM event_lines l JOIN events e ON e.cid = l.event_cid
     WHERE e.user_id = ? AND e.kind = 'eat' AND e.undone_at IS NULL AND l.is_set = 0 ORDER BY e.at DESC, e.seq DESC`, userId)) {
    usual[l.item_id] ??= -l.qty;
  }

  const events = all<Omit<FoodEvent, 'lines'>>(db,
    'SELECT cid, user_id, at, kind, source, note, preset_id FROM events WHERE undone_at IS NULL ORDER BY at DESC, seq DESC LIMIT 100')
    .map(e => ({ ...e, lines: eventLines(db, e.cid) }));

  const jobs = all<{ id: number; status: Job['status']; text: string; images: string; result: string | null; error: string | null; event_cids: string; created_at: number }>(db,
    `SELECT id, status, text, images, result, error, event_cids, created_at FROM jobs
     WHERE user_id = ? AND dismissed_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 10`, userId)
    .map(j => ({
      id: j.id, status: j.status, text: j.text, has_images: JSON.parse(j.images).length > 0,
      result: j.result ? JSON.parse(j.result) : null, error: j.error, event_cids: JSON.parse(j.event_cids), created_at: j.created_at,
    }));

  return {
    rev: getRev(db), build: env.build, now: env.now,
    me: get<User>(db, 'SELECT id, name, emoji FROM users WHERE id = ?', userId)!,
    users: all<User>(db, 'SELECT id, name, emoji FROM users ORDER BY id'),
    items, presets: listPresets(db, userId), usual, events, jobs, ai: { ready: env.ai },
  };
}

const eventLines = (db: Db, cid: string): EventLine[] =>
  all<{ item_id: number; qty: number; is_set: number }>(db, 'SELECT item_id, qty, is_set FROM event_lines WHERE event_cid = ? ORDER BY rowid', cid)
    .map(l => ({ item_id: l.item_id, qty: l.qty, is_set: !!l.is_set }));

const insertLines = (db: Db, cid: string, lines: EventLine[]): void => {
  for (const l of lines) run(db, 'INSERT INTO event_lines(event_cid, item_id, qty, is_set) VALUES (?, ?, ?, ?)', cid, l.item_id, l.qty, l.is_set ? 1 : 0);
};

export interface NewEvent {
  cid: string; userId: number; at: number; kind: EventBody['kind']; source: Source;
  note: string | null; presetId: number | null; jobId: number | null; lines: EventLine[];
}

/** Inserts an event and its lines. Call inside a transaction. */
export function insertEvent(db: Db, e: NewEvent): void {
  run(db, `INSERT INTO events(cid, seq, user_id, at, kind, source, note, preset_id, job_id)
           VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM events), ?, ?, ?, ?, ?, ?, ?)`,
    e.cid, e.userId, e.at, e.kind, e.source, e.note, e.presetId, e.jobId);
  insertLines(db, e.cid, e.lines);
}

const noLines = (): never => fail(400, 'None of those items exist any more');

export function createEvent(db: Db, userId: number, body: EventBody, now: number): void {
  transaction(db, () => {
    if (get(db, 'SELECT 1 FROM events WHERE cid = ?', body.cid)) return;
    const lines = toLines(body, id => unitOf(db, id));
    if (!lines.length) noLines();
    const presetId = body.preset_id && get(db, 'SELECT 1 FROM presets WHERE id = ? AND user_id = ?', body.preset_id, userId) ? body.preset_id : null;
    insertEvent(db, {
      cid: body.cid, userId, at: Math.min(body.at, now), kind: body.kind, source: presetId ? 'preset' : 'manual',
      note: body.note || null, presetId, jobId: null, lines,
    });
    bumpRev(db);
  });
}

export function editEvent(db: Db, cid: string, body: Pick<EventBody, 'lines'>): void {
  transaction(db, () => {
    const ev = get<{ kind: EventBody['kind'] }>(db, 'SELECT kind FROM events WHERE cid = ? AND undone_at IS NULL', cid);
    if (!ev) fail(404, 'No such event');
    const lines = toLines({ kind: ev!.kind, lines: body.lines }, id => unitOf(db, id));
    if (!lines.length) noLines();
    run(db, 'DELETE FROM event_lines WHERE event_cid = ?', cid);
    insertLines(db, cid, lines);
    bumpRev(db);
  });
}

export function undoEvent(db: Db, cid: string, now: number): void {
  transaction(db, () => {
    const ev = get<{ undone_at: number | null }>(db, 'SELECT undone_at FROM events WHERE cid = ?', cid);
    if (!ev) fail(404, 'No such event');
    if (ev!.undone_at !== null) return;
    run(db, 'UPDATE events SET undone_at = ? WHERE cid = ?', now, cid);
    bumpRev(db);
  });
}

// ---- items ----

const clash = (name: string): never => fail(409, `There is already an item called ${name}`);

export function createItem(db: Db, b: ItemBody, now: number): void {
  transaction(db, () => {
    const old = get<{ id: number; archived_at: number | null }>(db, 'SELECT id, archived_at FROM items WHERE name_key = ?', nameKey(b.name));
    if (old && old.archived_at === null) clash(b.name);
    // Re-adding an archived name brings the old item back, so its history stays attached.
    if (old) run(db, 'UPDATE items SET name = ?, emoji = ?, category = ?, unit = ?, step = ?, pack_size = ?, low_at = ?, archived_at = NULL WHERE id = ?',
      b.name, b.emoji, b.category, b.unit, b.step, b.pack_size, b.low_at, old.id);
    else run(db, 'INSERT INTO items(name, name_key, emoji, category, unit, step, pack_size, low_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      b.name, nameKey(b.name), b.emoji, b.category, b.unit, b.step, b.pack_size, b.low_at, now);
    bumpRev(db);
  });
}

export function patchItem(db: Db, id: number, patch: ItemPatch): void {
  transaction(db, () => {
    if (!get(db, 'SELECT 1 FROM items WHERE id = ? AND archived_at IS NULL', id)) fail(404, 'No such item');
    if (patch.name !== undefined && get(db, 'SELECT 1 FROM items WHERE name_key = ? AND id <> ?', nameKey(patch.name), id)) clash(patch.name);
    // Column names come from the zod-parsed keys (ItemPatch), never from raw input.
    const cols = Object.keys(patch) as (keyof ItemPatch)[];
    if (cols.length) {
      const sets = cols.map(c => `${c} = ?`);
      const vals = cols.map(c => patch[c] as string | number | null);
      if (patch.name !== undefined) { sets.push('name_key = ?'); vals.push(nameKey(patch.name)); }
      run(db, `UPDATE items SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    }
    bumpRev(db);
  });
}

export function archiveItem(db: Db, id: number, now: number): void {
  transaction(db, () => {
    if (!get(db, 'SELECT 1 FROM items WHERE id = ?', id)) fail(404, 'No such item');
    run(db, 'UPDATE items SET archived_at = COALESCE(archived_at, ?) WHERE id = ?', now, id);
    run(db, 'DELETE FROM preset_lines WHERE item_id = ?', id);
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
    bumpRev(db);
  });
}
