import type { Preset, PresetBody } from '../../shared/types.ts';
import type { Db } from '../db.ts';
import { all, bumpRev, get, run, transaction } from '../db.ts';
import { fail, unitOf } from '../domain.ts';

export function listPresets(db: Db, userId: number): Preset[] {
  return all<Omit<Preset, 'lines'>>(db, 'SELECT id, user_id, name, emoji, hour FROM presets WHERE user_id = ? ORDER BY id', userId).map(p => ({
    ...p,
    lines: all<{ item_id: number; qty: number }>(db, 'SELECT item_id, qty FROM preset_lines WHERE preset_id = ? ORDER BY rowid', p.id),
  }));
}

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
