import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { openDb } from '../src/server/db.ts';
import { addDays, daysUntil, isoDate, isoWeek, weekRange } from '../src/shared/dates.ts';
import { computeDailyNutrition, eventNutrition } from '../src/shared/nutrition.ts';
import { applyOps, computeStock, isExpiringSoon, isLow, levelParts, portionCount, shown, toLines } from '../src/shared/stock.ts';
import { SettingsBody } from '../src/shared/types.ts';
import { aliasKey, currencySymbol, fmtCost, fmtNum, nameKey, parseCostCents, parseNum } from '../src/shared/text.ts';
import { AiResult } from '../src/shared/types.ts';
import { amount, levelName, levelReadLabel, lineText } from '../src/web/ui/components/bits.ts';
import { fixture } from './fixture.ts';

const d = (item_id: number, qty: number) => ({ item_id, qty, is_set: false });
const s = (item_id: number, qty: number) => ({ item_id, qty, is_set: true });

test('deltas add up, fractions included', () => {
  expect(computeStock([d(1, 12), d(1, -1.5), d(1, -1.5), d(2, 10)]).get(1)).toBe(9);
});

test('eating before the receipt is logged still ends at the right amount', () => {
  const stock = computeStock([d(1, -3), d(1, 10)]).get(1)!;
  expect(stock).toBe(7);
  expect(shown(computeStock([d(1, -3)]).get(1)!)).toBe(0);
});

test('a set replaces what came before and later deltas apply on top', () => {
  expect(computeStock([d(1, 10), d(1, -4), s(1, 6), d(1, -2)]).get(1)).toBe(4);
});

test('level eat set lines replace the open container and preserve sealed spares', () => {
  const eat = (qty: number) => ({ ...s(1, qty), kind: 'eat' as const });
  expect(computeStock([{ ...d(1, 1.5), kind: 'buy' as const }, eat(0)]).get(1)).toBe(1);
  expect(computeStock([{ ...d(1, 2), kind: 'buy' as const }, eat(0.5)]).get(1)).toBe(1.5);
  expect(computeStock([eat(0.5)]).get(1)).toBe(0.5);
  expect(computeStock([{ ...d(1, -1), kind: 'buy' as const }, eat(0.25)]).get(1)).toBe(0.25);
  expect(computeStock([{ ...d(1, 1), kind: 'buy' as const }, { ...s(1, 0.5), kind: 'eat' as const }]).get(1)).toBe(0.5);
});

test('levelParts labels open contents and sealed spares', () => {
  expect(levelParts(1.5)).toEqual({ open: 0.5, sealed: 1 });
  expect(levelParts(2)).toEqual({ open: 1, sealed: 1 });
  expect(levelParts(0.25)).toEqual({ open: 0.25, sealed: 0 });
  expect(levelParts(-1)).toEqual({ open: 0, sealed: 0 });
});

test('level labels report the open amount and spare count', () => {
  const garlic = { ...fixture.items[6]!, emoji: '🧄', name: 'Garlic', stock: 1.5 };
  expect(levelName(levelParts(1.5).open)).toBe('half');
  expect(amount(garlic, 1.5)).toBe('half +1');
  expect(levelReadLabel(garlic, 1.5)).toBe('🧄 Garlic: half +1');
  expect(lineText([garlic], { item_id: garlic.id, qty: 0.5, is_set: true, level_sealed_before: 1 }, 'eat')).toBe('🧄 Garlic: half +1');
});

test('float noise is rounded away', () => {
  expect(computeStock([d(1, 0.1), d(1, 0.2)]).get(1)).toBe(0.3);
});

test('toLines: level buy adds, level eat sets, adjust sets, unknown items dropped', () => {
  const unit = (id: number) => (id === 7 ? 'level' : id === 1 ? 'pc' : undefined);
  expect(toLines({ kind: 'buy', lines: [{ item_id: 1, qty: 10 }, { item_id: 7, qty: 1 }, { item_id: 99, qty: 1 }] }, unit)).toEqual([d(1, 10), d(7, 1)]);
  expect(toLines({ kind: 'eat', lines: [{ item_id: 1, qty: 3 }, { item_id: 7, qty: 0.5 }] }, unit)).toEqual([d(1, -3), s(7, 0.5)]);
  expect(toLines({ kind: 'adjust', lines: [{ item_id: 1, qty: 6 }] }, unit)).toEqual([s(1, 6)]);
});

test('set-to-value lines contribute no event or daily nutrition', () => {
  const event = { ...fixture.events[0]!, kind: 'eat' as const, counts_nutrition: true, at: fixture.now, user_id: 1,
    lines: [s(9, 0.5)] };
  const levelItem = { id: 9, kcal_per_unit: 100, protein_per_unit: 25, fat_per_unit: 5 };
  expect(eventNutrition(event, [levelItem])).toEqual({ kcal: 0, protein_g: 0, fat_g: 0, carbs_g: null });
  expect(computeDailyNutrition([event], [levelItem])).toEqual([]);
});

test('pending level eat preserves spares, shows zero calories, and undo restores stock', () => {
  const base = structuredClone(fixture);
  base.items.push({ ...base.items[0]!, id: 99, unit: 'level', stock: 1.5, kcal_per_unit: 500, protein_per_unit: 10 });
  const op = { type: 'event' as const, body: { cid: 'level-pending', at: fixture.now, kind: 'eat' as const, lines: [{ item_id: 99, qty: 0.5 }] } };
  const out = applyOps(base, [op]);
  expect(out.items.find(i => i.id === 99)!.stock).toBe(1.5);
  expect(out.daily_nutrition.find(x => x.day === isoDate(fixture.now) && x.user_id === 1)).toBeUndefined();
  expect(applyOps(out, [{ type: 'undo', cid: 'level-pending' }]).items.find(i => i.id === 99)!.stock).toBe(1.5);
});

test('applyOps shows pending work on top of server state and updates nutrition and expenses', () => {
  const eat = { type: 'event' as const, body: { cid: 'pending-0001', at: fixture.now, kind: 'eat' as const, lines: [{ item_id: 1, qty: 2 }] } };
  const out = applyOps(fixture, [eat]);
  expect(out.items.find(i => i.id === 1)!.stock).toBe(5);
  expect(out.events[0]!.cid).toBe('pending-0001');
  expect(out.usual[1]).toBe(2);
  expect(fixture.items.find(i => i.id === 1)!.stock).toBe(7);
  const today = isoDate(fixture.now);
  expect(out.daily_nutrition.find(x => x.day === today && x.user_id === 1)).toEqual({ day: today, user_id: 1, kcal: 156, protein_g: 12.6, fat_g: 0, carbs_g: null, value_cents: 0, unpriced: 1, no_kcal: 0 });
  // once the server lists the event, the pending op adds nothing
  expect(applyOps(out, [eat]).items.find(i => i.id === 1)!.stock).toBe(5);
  // undo of a server event
  const undone = applyOps(fixture, [{ type: 'undo', cid: 'ev-00000003' }]);
  expect(undone.items.find(i => i.id === 6)!.stock).toBe(1000);
  expect(undone.events.some(e => e.cid === 'ev-00000003')).toBe(false);
  expect(undone.daily_nutrition.find(x => x.day === isoDate(fixture.events[0]!.at) && x.user_id === 2)).toEqual({ day: isoDate(fixture.events[0]!.at), user_id: 2, kcal: 0, protein_g: 0, fat_g: 0, carbs_g: null, value_cents: 0, unpriced: 0, no_kcal: 0 });
  // optimistic buy with cost shows in expenses
  const buy = { type: 'event' as const, body: { cid: 'pending-buy-1', at: fixture.now, kind: 'buy' as const, lines: [{ item_id: 1, qty: 10 }], cost_cents: 3000 } };
  const bought = applyOps(fixture, [buy]);
  expect(bought.expenses[0]!.cid).toBe('pending-buy-1');
  expect(bought.expenses[0]!.cost_cents).toBe(3000);
});

test('isLow and isExpiringSoon', () => {
  expect(isLow({ stock: 2, low_at: 2 })).toBe(true);
  expect(isLow({ stock: 3, low_at: 2 })).toBe(false);
  expect(isLow({ stock: -1, low_at: null })).toBe(true);
  expect(isLow({ stock: 1, low_at: null })).toBe(false);

  const today = isoDate(fixture.now);
  expect(isExpiringSoon({ stock: 1, expires_at: today }, fixture.now)).toBe(true);
  expect(isExpiringSoon({ stock: 0, expires_at: today }, fixture.now)).toBe(false);
  expect(isExpiringSoon({ stock: 1, expires_at: addDays(today, 3) }, fixture.now)).toBe(true);
  expect(isExpiringSoon({ stock: 1, expires_at: addDays(today, 4) }, fixture.now)).toBe(false);
});

test('portionCount and eventNutrition / computeDailyNutrition', () => {
  expect(portionCount({ unit: 'portion', portion_g: null }, 2.5)).toBe(2.5);
  expect(portionCount({ unit: 'g', portion_g: 300 }, 900)).toBe(3);
  expect(portionCount({ unit: 'g', portion_g: null }, 500)).toBeNull();

  const cookEat = {
    kind: 'eat' as const, counts_nutrition: false,
    lines: [{ item_id: 4, qty: -500, is_set: false }],
  };
  expect(eventNutrition(cookEat, fixture.items)).toEqual({ kcal: 0, protein_g: 0, fat_g: 0, carbs_g: null });
  expect(eventNutrition(fixture.events[1]!, fixture.items)).toEqual({ kcal: 657, protein_g: 40.2, fat_g: 0, carbs_g: null });
  const agg = computeDailyNutrition(fixture.events, fixture.items);
  expect(agg.find(d => d.user_id === 1)?.kcal).toBe(657);
});

test('dates and cost helpers', () => {
  expect(isoWeek(new Date(2026, 10, 15))).toBe('2026-W46');
  const r = weekRange('2026-W46')!;
  expect(r.label).toBe('Nov 9 – Nov 15');
  expect(r.end - r.start).toBe(7 * 86_400_000);
  expect(weekRange('2026-W53')?.label).toBe('Dec 28 – Jan 3');
  expect(weekRange('2025-W53')).toBeNull();
  expect(daysUntil('2026-11-18', new Date(2026, 10, 15, 22, 0))).toBe(3);
  expect(addDays('2026-11-15', 4)).toBe('2026-11-19');

  expect(parseCostCents('24,95')).toBe(2495);
  expect(parseCostCents('100')).toBe(10000);
  expect(parseCostCents('12.345')).toBeNaN();
  expect(fmtCost(2495, 'DKK')).toBe('24,95\u00a0kr.');
  expect(fmtCost(10000, 'DKK')).toBe('100\u00a0kr.');
  expect(fmtCost(-2495, 'EUR')).toBe('-24,95\u00a0€');
  expect(fmtCost(10000, 'JPY')).toBe('100\u00a0¥');
  expect(fmtCost(2495, 'kr')).toBe('24.95 kr'); // legacy non-ISO value
  expect(currencySymbol('DKK')).toBe('kr.');
  expect(currencySymbol('kr')).toBe('kr');
});

test('SettingsBody accepts only listed ISO currency codes', () => {
  expect(SettingsBody.safeParse({ currency: 'EUR' }).success).toBe(true);
  for (const bad of ['kr', 'eur', 'XXX', '', '€']) expect(SettingsBody.safeParse({ currency: bad }).success, bad).toBe(false);
});

test('text helpers', () => {
  expect(nameKey('  Eggs  ')).toBe('eggs');
  expect(aliasKey('ØKO ÆG M/L  10 STK')).toBe('øko æg m l 10 stk');
  expect(parseNum('1,5')).toBe(1.5);
  expect(parseNum('2')).toBe(2);
  expect(parseNum('abc')).toBeNaN();
  expect(fmtNum(0.1 + 0.2)).toBe('0.3');
});

test('AiResult produces a valid JSON schema and parses both legacy and v2 outputs', () => {
  const schema = z.toJSONSchema(AiResult) as { type?: string };
  expect(schema.type).toBe('object');
  expect(AiResult.safeParse({
    reply: 'Logged breakfast.',
    events: [{ kind: 'eat', preset_id: 1, lines: [{ item_id: 1, new_item: null, qty: 3, raw: null }] }],
  }).success).toBe(true);
  expect(AiResult.safeParse({
    reply: 'Cooked Bolognese.',
    events: [],
    cook: [{
      meal_item_id: null, name: 'Bolognese', emoji: '🍝', portions: 4, total_g: 1200,
      expires_in_days: 4, owner: 'shared', kcal_total: 1680, protein_total: 108,
      ingredients: [{ item_id: 4, qty: 500 }],
    }],
  }).success).toBe(true);
});

test('openDb migrates an existing v1 database idempotently without losing rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mf-mig-'));
  const file = join(dir, 'myfood.db');
  try {
    const raw = new DatabaseSync(file);
    raw.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, emoji TEXT NOT NULL, code_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
      CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, emoji TEXT NOT NULL, category TEXT NOT NULL, unit TEXT NOT NULL, step REAL NOT NULL, pack_size REAL NOT NULL, low_at REAL, archived_at INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE aliases (text TEXT PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id));
      CREATE TABLE events (cid TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id), at INTEGER NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, note TEXT, preset_id INTEGER, job_id INTEGER, undone_at INTEGER);
      CREATE TABLE event_lines (event_cid TEXT NOT NULL REFERENCES events(cid) ON DELETE CASCADE, item_id INTEGER NOT NULL REFERENCES items(id), qty REAL NOT NULL, is_set INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE presets (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, emoji TEXT NOT NULL, hour REAL NOT NULL);
      CREATE TABLE preset_lines (preset_id INTEGER NOT NULL REFERENCES presets(id) ON DELETE CASCADE, item_id INTEGER NOT NULL REFERENCES items(id), qty REAL NOT NULL, PRIMARY KEY (preset_id, item_id));
      CREATE TABLE jobs (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), text TEXT NOT NULL, images TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, result TEXT, error TEXT, event_cids TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, finished_at INTEGER, dismissed_at INTEGER);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta(key, value) VALUES ('rev', '7');
      INSERT INTO users(id, name, emoji, code_hash, created_at) VALUES (1, 'Sam', '🦊', 'hash1', 100), (2, 'Robin', '🐻', 'hash2', 100);
      INSERT INTO items(id, name, name_key, emoji, category, unit, step, pack_size, low_at, created_at) VALUES (1, 'Eggs', 'eggs', '🥚', 'dairy', 'pc', 1, 10, 3, 100);
      INSERT INTO aliases(text, item_id) VALUES ('oko aeg', 1);
      INSERT INTO events(cid, seq, user_id, at, kind, source) VALUES ('c1', 1, 1, 200, 'buy', 'manual');
      INSERT INTO event_lines(event_cid, item_id, qty, is_set) VALUES ('c1', 1, 10, 0);
    `);
    raw.close();

    const db = openDb(file);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 6 });
    // v4 adds item price and eat-line value: old rows read NULL (unknown)
    expect(db.prepare('SELECT cost_per_unit_cents FROM items').get()).toEqual({ cost_per_unit_cents: null });
    expect(db.prepare('SELECT value_cents, qty FROM event_lines').get()).toEqual({ value_cents: null, qty: 10 });
    // v3 adds carbs and goal columns; old rows keep their data and read NULL (unknown), not 0
    expect(db.prepare('SELECT carbs_per_unit FROM items').get()).toEqual({ carbs_per_unit: null });
    expect(db.prepare('SELECT carbs_g FROM event_lines').get()).toEqual({ carbs_g: null });
    expect(db.prepare('SELECT carbs_per_unit FROM barcodes').all()).toEqual([]);
    expect(db.prepare('SELECT goal_kcal, goal_protein_g, goal_fat_g, goal_carbs_g FROM users WHERE id = 1').get()).toEqual({ goal_kcal: null, goal_protein_g: null, goal_fat_g: null, goal_carbs_g: null });
    expect(db.prepare('SELECT id, name, owner_id, is_cooked FROM items').get()).toEqual({ id: 1, name: 'Eggs', owner_id: null, is_cooked: 0 });
    expect(db.prepare('SELECT text, item_id FROM aliases').get()).toEqual({ text: 'oko aeg', item_id: 1 });
    expect(db.prepare('SELECT cid, counts_nutrition FROM events').get()).toEqual({ cid: 'c1', counts_nutrition: 1 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // Shared item duplicate still fails, personal items per user succeed
    expect(() => db.prepare("INSERT INTO items(name, name_key, emoji, category, unit, step, pack_size, owner_id, created_at) VALUES ('Eggs', 'eggs', '🥚', 'dairy', 'pc', 1, 10, NULL, 1)").run()).toThrow();
    db.prepare("INSERT INTO items(name, name_key, emoji, category, unit, step, pack_size, owner_id, created_at) VALUES ('Eggs', 'eggs', '🥚', 'dairy', 'pc', 1, 10, 1, 1)").run();
    db.prepare("INSERT INTO items(name, name_key, emoji, category, unit, step, pack_size, owner_id, created_at) VALUES ('Eggs', 'eggs', '🥚', 'dairy', 'pc', 1, 10, 2, 1)").run();
    expect(() => db.prepare("INSERT INTO items(name, name_key, emoji, category, unit, step, pack_size, owner_id, created_at) VALUES ('Eggs', 'eggs', '🥚', 'dairy', 'pc', 1, 10, 1, 1)").run()).toThrow();
    db.close();

    // Re-opening migrated DB is idempotent
    const db2 = openDb(file);
    expect(db2.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 3 });
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openDb migrates a v3 database to v4 keeping its rows, with price and value unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mf-mig4-'));
  const file = join(dir, 'myfood.db');
  try {
    const first = openDb(file);
    first.exec('ALTER TABLE items DROP COLUMN cost_per_unit_cents; ALTER TABLE event_lines DROP COLUMN value_cents; PRAGMA user_version = 3');
    first.exec("INSERT INTO users(id, name, emoji, code_hash, created_at) VALUES (1, 'Sam', 'x', 'h', 1)");
    first.exec("INSERT INTO items(id, name, name_key, emoji, category, unit, step, pack_size, created_at, carbs_per_unit) VALUES (1, 'Eggs', 'eggs', 'e', 'dairy', 'pc', 1, 10, 1, 0.5)");
    first.exec("INSERT INTO events(cid, seq, user_id, at, kind, source, cost_cents) VALUES ('c1', 1, 1, 2, 'eat', 'manual', 900)");
    first.exec("INSERT INTO event_lines(event_cid, item_id, qty, is_set, cost_cents, carbs_g) VALUES ('c1', 1, -2, 0, 900, 1)");
    first.close();

    const db = openDb(file);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 6 });
    expect(db.prepare('SELECT carbs_per_unit, cost_per_unit_cents FROM items').get()).toEqual({ carbs_per_unit: 0.5, cost_per_unit_cents: null });
    expect(db.prepare('SELECT qty, cost_cents, carbs_g, value_cents FROM event_lines').get()).toEqual({ qty: -2, cost_cents: 900, carbs_g: 1, value_cents: null });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openDb migrates a stored legacy "kr" currency to DKK and leaves other values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mf-mig5-'));
  const file = join(dir, 'myfood.db');
  try {
    for (const [before, after] of [['kr', 'DKK'], ['EUR', 'EUR'], ['zł', 'zł']]) {
      const first = openDb(file);
      first.exec(`UPDATE meta SET value = '${before}' WHERE key = 'currency'; PRAGMA user_version = 4`);
      first.close();
      const db = openDb(file);
      expect(db.prepare("SELECT value FROM meta WHERE key = 'currency'").get()).toEqual({ value: after });
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pending eat ops add value and unpriced to daily nutrition', () => {
  const items = [{ id: 1, cost_per_unit_cents: 2.5 }, { id: 2, cost_per_unit_cents: null }];
  const ev = { ...fixture.events[0]!, kind: 'eat' as const, counts_nutrition: true, at: fixture.now, user_id: 1,
    lines: [{ item_id: 1, qty: -3, is_set: false }, { item_id: 2, qty: -1, is_set: false }] };
  expect(computeDailyNutrition([ev], items)).toEqual([{ day: isoDate(fixture.now), user_id: 1, kcal: 0, protein_g: 0, fat_g: 0, carbs_g: null, value_cents: 8, unpriced: 1, no_kcal: 2 }]);
  const eat = { type: 'event' as const, body: { cid: 'pv-1', at: fixture.now, kind: 'eat' as const, lines: [{ item_id: 1, qty: 2 }] } };
  const out = applyOps({ ...fixture, items: fixture.items.map(i => i.id === 1 ? { ...i, cost_per_unit_cents: 100 } : i) }, [eat]);
  expect(out.daily_nutrition.find(d => d.user_id === 1 && d.day === isoDate(fixture.now))).toMatchObject({ value_cents: 200, unpriced: 0, no_kcal: 0 });
});
