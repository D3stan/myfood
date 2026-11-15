import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { scryptSync } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dbPath = resolve(process.env.MYFOOD_DB ?? 'data/myfood.db');
mkdirSync(dirname(dbPath), { recursive: true });
export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL, pin_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL,
    category TEXT NOT NULL, unit TEXT NOT NULL, step REAL NOT NULL,
    pack_size REAL NOT NULL, low_at REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY, cid TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL,
    kind TEXT NOT NULL, source TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL DEFAULT (datetime('now')), undone_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS event_lines (
    id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, item_id INTEGER NOT NULL,
    delta REAL NOT NULL,
    FOREIGN KEY(event_id) REFERENCES events(id),
    FOREIGN KEY(item_id) REFERENCES items(id)
  );
  CREATE TABLE IF NOT EXISTS presets (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL, hour INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS preset_lines (
    preset_id INTEGER NOT NULL, item_id INTEGER NOT NULL, qty REAL NOT NULL,
    FOREIGN KEY(preset_id) REFERENCES presets(id),
    FOREIGN KEY(item_id) REFERENCES items(id)
  );
`);

const users = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
if (users.n === 0) {
  const production = process.env.NODE_ENV === 'production';
  const pinOne = process.env.MYFOOD_PIN_PUDDU ?? (production ? '' : '1234');
  const pinTwo = process.env.MYFOOD_PIN_ROOMIE ?? (production ? '' : '2468');
  if (pinOne.length < 6 || pinTwo.length < 6 || (production && pinOne === pinTwo)) {
    if (production) throw new Error('Set MYFOOD_PIN_PUDDU and MYFOOD_PIN_ROOMIE to unique 6+ digit PINs before first startup.');
  }
  const hashPin = (pin: string) => {
    const salt = randomBytes(16).toString('hex');
    return `${salt}:${scryptSync(pin, salt, 64).toString('hex')}`;
  };
  const addUser = db.prepare('INSERT INTO users (name, emoji, pin_hash) VALUES (?, ?, ?)');
  addUser.run('Puddu', '👨🏻‍🍳', hashPin(pinOne));
  addUser.run('Roomie', '🧑🏻‍🍳', hashPin(pinTwo));

  const addItem = db.prepare(`INSERT INTO items
    (name, emoji, category, unit, step, pack_size, low_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const items = [
    ['Eggs', '🥚', 'Fridge', 'pc', 1, 10, 4],
    ['Bacon', '🥓', 'Fridge', 'slice', 0.5, 8, 4],
    ['Cheese', '🧀', 'Fridge', 'slice', 0.5, 12, 4],
    ['Bread', '🍞', 'Fridge', 'slice', 0.5, 12, 4],
    ['Pasta', '🍝', 'Pantry', 'g', 50, 500, 200],
    ['Minced meat', '🥩', 'Fridge', 'g', 50, 500, 200],
    ['Oregano', '🌿', 'Spices', 'level', 0.25, 1, 0.25],
  ] as const;
  for (const item of items) addItem.run(...item);

  const addPreset = db.prepare('INSERT INTO presets (name, emoji, hour) VALUES (?, ?, ?)');
  const breakfast = Number(addPreset.run('Breakfast', '🍳', 8).lastInsertRowid);
  const addPresetLine = db.prepare('INSERT INTO preset_lines (preset_id, item_id, qty) VALUES (?, ?, ?)');
  const breakfastItems: Array<[number, number]> = [[2, 2], [3, 1.5], [1, 3], [4, 3]];
  for (const [itemId, qty] of breakfastItems) addPresetLine.run(breakfast, itemId, qty);

  const seed = db.prepare('INSERT INTO events (cid, user_id, kind, source, note) VALUES (?, 1, \'buy\', \'manual\', \'Starting pantry\')');
  const eventId = Number(seed.run('seed-starting-pantry').lastInsertRowid);
  const addLine = db.prepare('INSERT INTO event_lines (event_id, item_id, delta) VALUES (?, ?, ?)');
  const startingStock: Array<[number, number]> = [[1, 8], [2, 16], [3, 11], [4, 9], [5, 1000], [6, 400], [7, 0.5]];
  for (const [itemId, qty] of startingStock) addLine.run(eventId, itemId, qty);
}

export function resetDbForTests(): void {
  db.exec('DELETE FROM event_lines; DELETE FROM events; DELETE FROM preset_lines; DELETE FROM presets; DELETE FROM items; DELETE FROM users;');
}
