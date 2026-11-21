import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  migrate(db);
  return db;
}

export const get = <T>(db: Db, sql: string, ...p: SQLInputValue[]): T | undefined => db.prepare(sql).get(...p) as T | undefined;
export const all = <T>(db: Db, sql: string, ...p: SQLInputValue[]): T[] => db.prepare(sql).all(...p) as T[];
export const run = (db: Db, sql: string, ...p: SQLInputValue[]) => db.prepare(sql).run(...p);

/** All-or-nothing. Callbacks are synchronous, so nothing else touches the connection meanwhile.
 *  Nested calls join the outer transaction, so an inner throw rolls back everything. */
export function transaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const bumpRev = (db: Db): void => void run(db, "UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev'");
export const getRev = (db: Db): number => Number(get<{ value: string }>(db, "SELECT value FROM meta WHERE key = 'rev'")!.value);

export const getMeta = (db: Db, key: string): string | null =>
  get<{ value: string }>(db, 'SELECT value FROM meta WHERE key = ?', key)?.value ?? null;

export const setMeta = (db: Db, key: string, value: string): void =>
  void run(db, 'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);

const colsOf = (db: Db, table: string): Set<string> =>
  new Set(all<{ name: string }>(db, `PRAGMA table_info(${table})`).map(c => c.name));

function addCol(db: Db, table: string, col: string, ddl: string): void {
  if (!colsOf(db, table).has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

function hasLegacyItemsUnique(db: Db): boolean {
  const idxs = all<{ name: string; origin: string; unique: number }>(db, "PRAGMA index_list('items')");
  return idxs.some((idx) => {
    if (idx.origin !== 'u' && idx.unique !== 1) return false;
    const cols = all<{ name: string }>(db, `PRAGMA index_info('${idx.name.replace(/'/g, "''")}')`).map(c => c.name);
    return cols.length === 1 && cols[0] === 'name_key';
  });
}

function rebuildItemsTable(db: Db): void {
  const c = colsOf(db, 'items');
  const sel = (name: string, fallback: string) => (c.has(name) ? name : `${fallback} AS ${name}`);
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(db, () => {
      db.exec(`
        CREATE TABLE items_v2 (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          name_key TEXT NOT NULL,
          emoji TEXT NOT NULL,
          category TEXT NOT NULL,
          unit TEXT NOT NULL,
          step REAL NOT NULL,
          pack_size REAL NOT NULL,
          low_at REAL,
          owner_id INTEGER REFERENCES users(id),
          is_cooked INTEGER NOT NULL DEFAULT 0,
          portion_g REAL,
          expires_at TEXT,
          shelf_life_days INTEGER,
          kcal_per_unit REAL,
          protein_per_unit REAL,
          archived_at INTEGER,
          created_at INTEGER NOT NULL
        );
        INSERT INTO items_v2(
          id, name, name_key, emoji, category, unit, step, pack_size, low_at,
          owner_id, is_cooked, portion_g, expires_at, shelf_life_days, kcal_per_unit, protein_per_unit,
          archived_at, created_at
        )
        SELECT
          id, name, name_key, emoji, category, unit, step, pack_size, low_at,
          ${sel('owner_id', 'NULL')},
          ${sel('is_cooked', '0')},
          ${sel('portion_g', 'NULL')},
          ${sel('expires_at', 'NULL')},
          ${sel('shelf_life_days', 'NULL')},
          ${sel('kcal_per_unit', 'NULL')},
          ${sel('protein_per_unit', 'NULL')},
          archived_at, created_at
        FROM items;
        DROP TABLE items;
        ALTER TABLE items_v2 RENAME TO items;
      `);
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export const JOLLY_KEY = '__jolly__';

/** The hidden item every eat-out line points at. Price 0 so its lines get value_cents 0, not "unpriced". Archived, so every `archived_at IS NULL` query skips it; nameKey() never yields this key. */
export function ensureJolly(db: Db): void {
  if (get(db, 'SELECT 1 FROM items WHERE name_key = ?', JOLLY_KEY)) return;
  const now = Date.now();
  run(
    db,
    `INSERT INTO items(name, name_key, emoji, category, unit, step, pack_size, owner_id, cost_per_unit_cents, archived_at, created_at)
     VALUES ('Eat out', ?, '🃏', 'other', 'portion', 1, 1, NULL, 0, ?, ?)`,
    JOLLY_KEY,
    now,
    now,
  );
}

/** Id of the jolly, creating it on first use (not in openDb: that would take id 1 on a fresh database). */
export function jollyId(db: Db): number {
  ensureJolly(db);
  return get<{ id: number }>(db, 'SELECT id FROM items WHERE name_key = ?', JOLLY_KEY)!.id;
}

/** Idempotently upgrades v1 databases (and ensures v2 indexes on fresh ones). */
export function migrate(db: Db): void {
  const version = get<{ user_version: number }>(db, 'PRAGMA user_version')?.user_version ?? 0;

  if (version < 1) {
    if (!colsOf(db, 'items').has('owner_id') || hasLegacyItemsUnique(db)) {
      rebuildItemsTable(db);
    }
    transaction(db, () => {
      addCol(db, 'users', 'notify_low', 'INTEGER NOT NULL DEFAULT 1');
      addCol(db, 'users', 'notify_expiry', 'INTEGER NOT NULL DEFAULT 1');

      addCol(db, 'events', 'cost_cents', 'INTEGER');
      addCol(db, 'events', 'counts_nutrition', 'INTEGER NOT NULL DEFAULT 1');

      addCol(db, 'event_lines', 'cost_cents', 'INTEGER');
      addCol(db, 'event_lines', 'expires_at', 'TEXT');
      addCol(db, 'event_lines', 'kcal', 'REAL');
      addCol(db, 'event_lines', 'protein_g', 'REAL');

      addCol(db, 'jobs', 'mode', "TEXT NOT NULL DEFAULT 'auto'");

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS items_name_owner ON items(name_key, COALESCE(owner_id, 0));
        CREATE INDEX IF NOT EXISTS items_expires ON items(expires_at);
        PRAGMA user_version = 1;
      `);
    });
  }

  if (version < 2) {
    transaction(db, () => {
      addCol(db, 'items', 'fat_per_unit', 'REAL');
      addCol(db, 'event_lines', 'fat_g', 'REAL');
      addCol(db, 'barcodes', 'fat_per_unit', 'REAL');
      db.exec('PRAGMA user_version = 2');
    });
  }

  if (version < 3) {
    transaction(db, () => {
      addCol(db, 'items', 'carbs_per_unit', 'REAL');
      addCol(db, 'event_lines', 'carbs_g', 'REAL');
      addCol(db, 'barcodes', 'carbs_per_unit', 'REAL');
      for (const c of ['goal_kcal', 'goal_protein_g', 'goal_fat_g', 'goal_carbs_g']) addCol(db, 'users', c, 'REAL');
      db.exec('PRAGMA user_version = 3');
    });
  }

  if (version < 4) {
    transaction(db, () => {
      addCol(db, 'items', 'cost_per_unit_cents', 'REAL');
      addCol(db, 'event_lines', 'value_cents', 'INTEGER');
      db.exec('PRAGMA user_version = 4');
    });
  }

  if (version < 5) {
    transaction(db, () => {
      // the currency used to be a free-text symbol; 'kr' is the only value ever defaulted
      db.exec("UPDATE meta SET value = 'DKK' WHERE key = 'currency' AND value = 'kr'; PRAGMA user_version = 5");
    });
  }
  if (version < 6) {
    transaction(db, () => {
      db.exec(`CREATE TABLE IF NOT EXISTS settlements (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, by_user_id INTEGER NOT NULL REFERENCES users(id), note TEXT); PRAGMA user_version = 6`);
    });
  }
  if (version < 7) {
    transaction(db, () => {
      const ins = db.prepare('INSERT OR IGNORE INTO stores(id, name, emoji, sources) VALUES (?, ?, ?, ?)');
      for (const [id, name, emoji, dealer_id] of [['netto-dk', 'Netto', '🟡', '9ba51'], ['lidl-dk', 'Lidl', '🔵', '71c90'], ['coop365-dk', 'Coop 365', '🟢', 'DWZE1w']]) {
        ins.run(id!, name!, emoji!, JSON.stringify([{ provider: 'tjek', config: { dealer_id } }]));
      }
      for (const [k, v] of [['deals_lat', '55.6761'], ['deals_lng', '12.5683'], ['deals_radius_m', '5000']]) {
        db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run(k!, v!);
      }
      db.exec('PRAGMA user_version = 7');
    });
  }
  if (version < 8) {
    transaction(db, () => {
      addCol(db, 'users', 'notify_deals', 'INTEGER NOT NULL DEFAULT 1');
      db.exec('PRAGMA user_version = 8');
    });
  }
}
