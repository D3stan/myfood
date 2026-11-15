// node scripts/seed.ts <name>...        creates users (and starter data on an empty pantry)
// node scripts/seed.ts --rotate <name>  new access code for an existing user; their sessions end
import { chmodSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deleteUserSessions, newCode, sha256 } from '../src/server/auth.ts';
import { openDb } from '../src/server/db.ts';
import type { Db } from '../src/server/db.ts';
import { get, run } from '../src/server/db.ts';
import { nameKey } from '../src/shared/text.ts';

const EMOJIS = ['🦊', '🐻', '🐼', '🐸', '🦉', '🐙'];
const ITEMS: [string, string, string, string, number, number, number | null][] = [
  ['Eggs', '🥚', 'dairy', 'pc', 1, 10, 3],
  ['Bacon', '🥓', 'meat', 'slice', 0.5, 8, 2],
  ['Cheese slices', '🧀', 'dairy', 'slice', 0.5, 10, 2],
  ['Bread', '🍞', 'bakery', 'slice', 0.5, 14, 3],
  ['Pasta', '🍝', 'pantry', 'g', 50, 500, 100],
  ['Minced meat', '🥩', 'meat', 'g', 50, 500, null],
  ['Salt', '🧂', 'spices', 'level', 1, 1, 0.25],
  ['Pepper', '🌶️', 'spices', 'level', 1, 1, 0.25],
];
const BREAKFAST: [string, number][] = [['Bacon', 2], ['Cheese slices', 1.5], ['Eggs', 3], ['Bread', 3]];

function addUser(db: Db, name: string): number | null {
  if (get(db, 'SELECT 1 FROM users WHERE name = ?', name)) return null;
  const n = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM users')!.n;
  const code = newCode();
  const id = Number(run(db, 'INSERT INTO users(name, emoji, code_hash, created_at) VALUES (?, ?, ?, ?)', name, EMOJIS[n % EMOJIS.length]!, sha256(code), Date.now()).lastInsertRowid);
  console.log(`${name}: ${code}   (shown once, it cannot be looked up later)`);
  return id;
}

function seedItems(db: Db, firstUser: number): void {
  const now = Date.now();
  for (const [name, emoji, category, unit, step, pack, low] of ITEMS) {
    run(db, 'INSERT INTO items(name, name_key, emoji, category, unit, step, pack_size, low_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      name, nameKey(name), emoji, category, unit, step, pack, low, now);
  }
  const preset = Number(run(db, 'INSERT INTO presets(user_id, name, emoji, hour) VALUES (?, ?, ?, ?)', firstUser, 'Breakfast', '🍳', 8).lastInsertRowid);
  for (const [name, qty] of BREAKFAST) {
    const item = get<{ id: number }>(db, 'SELECT id FROM items WHERE name_key = ?', nameKey(name))!;
    run(db, 'INSERT INTO preset_lines(preset_id, item_id, qty) VALUES (?, ?, ?)', preset, item.id, qty);
  }
}

const args = process.argv.slice(2);
const rotate = args[0] === '--rotate';
const names = (rotate ? args.slice(1) : args).filter(Boolean);
if (!names.length) {
  console.error('Usage: node scripts/seed.ts <name> [<name>...]\n       node scripts/seed.ts --rotate <name>');
  process.exit(1);
}

const dataDir = resolve(process.env.DATA_DIR ?? './data');
mkdirSync(join(dataDir, 'jobs'), { recursive: true, mode: 0o750 });
const dbFile = join(dataDir, 'myfood.db');
const db = openDb(dbFile);
chmodSync(dbFile, 0o600);

if (rotate) {
  for (const name of names) {
    const u = get<{ id: number }>(db, 'SELECT id FROM users WHERE name = ?', name);
    if (!u) { console.error(`No user called ${name}`); process.exitCode = 1; continue; }
    const code = newCode();
    run(db, 'UPDATE users SET code_hash = ? WHERE id = ?', sha256(code), u.id);
    deleteUserSessions(db, u.id);
    console.log(`${name}: ${code}   (shown once, it cannot be looked up later)`);
  }
} else {
  let first: number | null = null;
  for (const name of names) { const id = addUser(db, name); first ??= id; }
  if (get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM items')!.n === 0) {
    const owner = first ?? get<{ id: number }>(db, 'SELECT id FROM users ORDER BY id LIMIT 1')?.id;
    if (owner) seedItems(db, owner);
  }
}
