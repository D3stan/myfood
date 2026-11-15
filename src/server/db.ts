import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  return db;
}

export const get = <T>(db: Db, sql: string, ...p: SQLInputValue[]): T | undefined => db.prepare(sql).get(...p) as T | undefined;
export const all = <T>(db: Db, sql: string, ...p: SQLInputValue[]): T[] => db.prepare(sql).all(...p) as T[];
export const run = (db: Db, sql: string, ...p: SQLInputValue[]) => db.prepare(sql).run(...p);

/** All-or-nothing. Callbacks are synchronous, so nothing else touches the connection meanwhile. Do not nest. */
export function transaction<T>(db: Db, fn: () => T): T {
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
