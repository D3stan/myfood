import { randomUUID } from 'node:crypto';
import { constants } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { addDays, daysUntil, ISO_DATE_RE, ISO_WEEK_RE, isoDate, isoWeek } from '../shared/dates.ts';
import { eventLineNutrition, isExpiringSoon, isLow, portionCount, shown } from '../shared/stock.ts';
import { aliasKey, nameKey } from '../shared/text.ts';
import {
  BarcodeLinkBody,
  CATEGORIES,
  Category,
  CookBody,
  CookIngredientIn,
  EventBody,
  EventPatch,
  ExpenseBody,
  ItemBody,
  ItemPatch,
  Kind,
  LineIn,
  LockPeriodBody,
  MeBody,
  PresetBody,
  SOURCES,
  SettingsBody,
  Unit,
} from '../shared/types.ts';
import type { DailyNutrition, FoodEvent, Item, Preset, Source, User } from '../shared/types.ts';
import { defaultBarcodeLookup, linkBarcode, resolveBarcode } from './barcodes.ts';
import type { BarcodeLookupFn } from './barcodes.ts';
import { all, bumpRev, get, getRev, getMeta, run, transaction } from './db.ts';
import type { Db } from './db.ts';
import * as d from './domain.ts';

const DAY_MS = 86_400_000;
const MAX_SQL_ROWS = 200;
const round1 = (n: number): number => Math.round(n * 10) / 10;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export interface MyFoodMcpOptions {
  now?: () => number;
  build?: string;
  defaultUserId?: number;
  lookupBarcode?: BarcodeLookupFn;
  onLowCrossings?: (prevStocks: Map<number, number>) => Promise<void>;
}

interface ItemRowFull {
  id: number;
  name: string;
  name_key: string;
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
  fat_per_unit: number | null;
  archived_at: number | null;
  created_at: number;
}

interface HydratedItem extends Item {
  shown_stock: number;
  portions: number | null;
  is_low: boolean;
  days_until_expiry: number | null;
  archived_at?: number | null;
}

interface EventRowFull {
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

interface EventLineRow {
  item_id: number;
  qty: number;
  is_set: number;
  cost_cents: number | null;
  expires_at: string | null;
  kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
}

const READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const IDEMPOTENT_WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const DESTRUCTIVE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

function okResult(summary: string, data: Record<string, unknown>) {
  return {
    content: [
      { type: 'text' as const, text: summary },
      { type: 'text' as const, text: JSON.stringify(data, null, 2) },
    ],
    structuredContent: data,
  };
}

const csvCell = (value: unknown): string => {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true as const,
  };
}

// Zod's own .message is a JSON dump of issues; flatten it like routes.ts parse() does.
function errMessage(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map(i => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message).join('; ');
  }
  return (err instanceof Error ? err.message : String(err)).replace(/\.$/, '');
}

async function runTool(fn: () => ReturnType<typeof okResult> | Promise<ReturnType<typeof okResult>>) {
  try {
    return await fn();
  } catch (err) {
    return errorResult(errMessage(err));
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

function resolveUserId(db: Db, requested?: number, defaultUserId?: number): number {
  const target = requested ?? defaultUserId;
  if (target !== undefined) {
    const u = get<{ id: number }>(db, 'SELECT id FROM users WHERE id = ?', target);
    if (!u) d.fail(400, `Unknown user_id: ${target}`);
    return u.id;
  }
  const users = all<{ id: number; name: string }>(db, 'SELECT id, name FROM users ORDER BY id');
  if (users.length === 0) d.fail(400, 'No users exist in the database');
  if (users.length === 1) return users[0]!.id;
  d.fail(
    400,
    `Multiple household users exist (${users.map(u => `${u.id}: ${u.name}`).join(', ')}); pass user_id explicitly`,
  );
}

function resolveReadUserId(db: Db, requested?: number, defaultUserId?: number): number | null {
  const target = requested ?? defaultUserId;
  if (target !== undefined) {
    const u = get<{ id: number }>(db, 'SELECT id FROM users WHERE id = ?', target);
    if (!u) d.fail(400, `Unknown user_id: ${target}`);
    return u.id;
  }
  return get<{ id: number }>(db, 'SELECT id FROM users ORDER BY id LIMIT 1')?.id ?? null;
}

function loadRecipeMap(db: Db): Map<number, { item_id: number; qty: number }[]> {
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
  return recipes;
}

function toHydratedItem(
  row: ItemRowFull,
  stockMap: Map<number, number>,
  recipes: Map<number, { item_id: number; qty: number }[]>,
  nowMs: number,
  includeArchived: boolean,
): HydratedItem {
  const stock = stockMap.get(row.id) ?? 0;
  const recipe = recipes.get(row.id);
  const item: HydratedItem = {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    category: row.category,
    unit: row.unit,
    step: row.step,
    pack_size: row.pack_size,
    low_at: row.low_at,
    stock,
    shown_stock: shown(stock),
    owner_id: row.owner_id,
    is_cooked: !!row.is_cooked,
    portion_g: row.portion_g,
    portions: portionCount({ unit: row.unit, portion_g: row.portion_g }, stock),
    is_low: isLow({ stock, low_at: row.low_at }),
    expires_at: row.expires_at,
    days_until_expiry: row.expires_at ? daysUntil(row.expires_at, nowMs) : null,
    shelf_life_days: row.shelf_life_days,
    kcal_per_unit: row.kcal_per_unit,
    protein_per_unit: row.protein_per_unit,
    fat_per_unit: row.fat_per_unit,
  };
  if (recipe) item.recipe = recipe;
  if (includeArchived) item.archived_at = row.archived_at;
  return item;
}

function loadHydratedItems(db: Db, nowMs: number, includeArchived = false): HydratedItem[] {
  const stockMap = d.allStock(db);
  const recipes = loadRecipeMap(db);
  const where = includeArchived ? '' : 'WHERE archived_at IS NULL';
  return all<ItemRowFull>(
    db,
    `SELECT id, name, name_key, emoji, category, unit, step, pack_size, low_at,
            owner_id, is_cooked, portion_g, expires_at, shelf_life_days,
            kcal_per_unit, protein_per_unit, fat_per_unit, archived_at, created_at
     FROM items ${where}`,
  )
    .map(r => toHydratedItem(r, stockMap, recipes, nowMs, includeArchived))
    .sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.name.localeCompare(b.name));
}

function getHydratedItemById(db: Db, itemId: number, nowMs: number, includeArchived = false): HydratedItem | null {
  const where = includeArchived ? 'id = ?' : 'id = ? AND archived_at IS NULL';
  const row = get<ItemRowFull>(
    db,
    `SELECT id, name, name_key, emoji, category, unit, step, pack_size, low_at,
            owner_id, is_cooked, portion_g, expires_at, shelf_life_days,
            kcal_per_unit, protein_per_unit, fat_per_unit, archived_at, created_at
     FROM items WHERE ${where}`,
    itemId,
  );
  if (!row) return null;
  return toHydratedItem(row, d.allStock(db), loadRecipeMap(db), nowMs, includeArchived);
}

function requireActiveItems(db: Db, itemIds: number[]): void {
  const seen = new Set<number>();
  for (const id of itemIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!d.unitOf(db, id)) {
      d.fail(400, `Item ${id} does not exist or is archived`);
    }
  }
}

function hydrateEventLines(db: Db, cid: string) {
  return all<EventLineRow>(
    db,
    'SELECT item_id, qty, is_set, cost_cents, expires_at, kcal, protein_g, fat_g FROM event_lines WHERE event_cid = ? ORDER BY rowid',
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
  }));
}

function eventRowToJson(db: Db, ev: EventRowFull, withUndone = false) {
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

function hydrateEventByCid(db: Db, cid: string): (FoodEvent & { seq: number }) | null {
  const ev = get<EventRowFull>(
    db,
    `SELECT cid, seq, user_id, at, kind, source, note, preset_id, cost_cents, counts_nutrition, undone_at
     FROM events WHERE cid = ?`,
    cid,
  );
  return ev ? eventRowToJson(db, ev) : null;
}

type ItemRef = { item_id?: number; item?: string };

/**
 * Turns {item_id} or {item: name} into an active item id. Name matches the acting user's
 * personal items plus shared ones, then falls back to a learned receipt alias.
 */
function resolveItemRef(db: Db, ref: ItemRef, userId: number | null): number {
  if (ref.item_id !== undefined) {
    if (ref.item !== undefined) d.fail(400, 'Pass item_id or item, not both');
    return ref.item_id;
  }
  if (!ref.item) d.fail(400, 'Each line needs item_id or item (name)');
  const matches = all<{ id: number; owner_id: number | null }>(
    db,
    'SELECT id, owner_id FROM items WHERE name_key = ? AND archived_at IS NULL AND (owner_id IS NULL OR owner_id = ?)',
    nameKey(ref.item),
    userId ?? 0,
  );
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    d.fail(400, `"${ref.item}" matches several items (${matches.map(m => `id=${m.id} owner_id=${m.owner_id}`).join('; ')}); pass item_id`);
  }
  const alias = get<{ item_id: number }>(
    db,
    'SELECT a.item_id FROM aliases a JOIN items i ON i.id = a.item_id WHERE a.text = ? AND i.archived_at IS NULL',
    aliasKey(ref.item),
  );
  if (alias) return alias.item_id;
  d.fail(404, `No active item called "${ref.item}"`);
}

/** Resolves every line before any write; errors name the line index. */
function resolveLines<T extends ItemRef>(db: Db, field: string, lines: T[], userId: number | null) {
  return lines.map((l, i) => {
    try {
      const { item: _name, ...rest } = l;
      return { ...rest, item_id: resolveItemRef(db, l, userId) };
    } catch (err) {
      d.fail(400, `${field}[${i}]: ${errMessage(err)}`);
    }
  });
}

// MCP-facing line schemas: item_id or item (name), refined in the handler.
const itemRefShape = {
  item_id: z.number().int().positive().optional().describe('Item ID (or pass item instead)'),
  item: z.string().trim().min(1).max(60).optional().describe('Item name, used when item_id is omitted'),
};
const McpLineIn = LineIn.extend(itemRefShape);
const McpCookIngredientIn = CookIngredientIn.extend(itemRefShape);

// ---- Read-only SQL guard ----

const ALLOWED_LEAD_KEYWORDS = new Set(['SELECT', 'WITH', 'PRAGMA', 'EXPLAIN']);
const READ_ONLY_PRAGMA_WITH_ARG = new Set([
  'table_info',
  'table_xinfo',
  'table_list',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
]);
const READ_ONLY_PRAGMA_NO_ARG = new Set([
  'database_list',
  'compile_options',
  'user_version',
  'schema_version',
  'collation_list',
  'function_list',
  'pragma_list',
  'journal_mode',
  'foreign_keys',
  'query_only',
]);
const AUTHORIZED_SQLITE_CODES = new Set<number>([
  constants.SQLITE_SELECT,
  constants.SQLITE_READ,
  constants.SQLITE_PRAGMA,
  constants.SQLITE_FUNCTION,
  constants.SQLITE_RECURSIVE,
]);

interface SqlScanResult {
  sql: string;
  firstKeyword: string;
}

/**
 * Validates that a SQL string is a single read-only SELECT/WITH/PRAGMA/EXPLAIN statement
 * with no stacked statements, unterminated comments, or mutating PRAGMA assignments.
 */
function scanReadOnlySql(rawSql: string): SqlScanResult {
  const sql = rawSql.trim();
  if (!sql) d.fail(400, 'SQL query must not be empty');

  const words: string[] = [];
  let sawSemiAt = -1;
  let sawEq = false;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    // Whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    // Line comment
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    // Block comment
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) d.fail(400, 'Unterminated SQL block comment');
      i = end + 2;
      continue;
    }

    if (sawSemiAt !== -1) {
      d.fail(400, 'Multiple SQL statements are not allowed');
    }

    // Quoted string / identifier
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '[') {
      const end = sql.indexOf(']', i + 1);
      if (end === -1) d.fail(400, 'Unterminated SQL bracket identifier');
      i = end + 1;
      continue;
    }

    if (ch === ';') {
      sawSemiAt = i;
      i++;
      continue;
    }

    if (ch === '=') {
      sawEq = true;
      i++;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
      if (words.length < 4) words.push(sql.slice(i, j));
      i = j;
      continue;
    }

    i++;
  }

  const firstKeyword = words[0]?.toUpperCase() ?? '';
  if (!ALLOWED_LEAD_KEYWORDS.has(firstKeyword)) {
    d.fail(400, `Only read-only SELECT, WITH, PRAGMA, or EXPLAIN queries are allowed (got "${words[0] ?? ''}")`);
  }

  if (firstKeyword === 'PRAGMA') {
    if (sawEq) d.fail(400, 'Mutating PRAGMA assignments are not allowed');
    const candidate = (words[1]?.toLowerCase() === 'main' && words[2] ? words[2] : words[1])?.toLowerCase() ?? '';
    if (!READ_ONLY_PRAGMA_WITH_ARG.has(candidate) && !READ_ONLY_PRAGMA_NO_ARG.has(candidate)) {
      d.fail(400, `PRAGMA "${candidate}" is not in the read-only allowlist`);
    }
  }

  const cleaned = sawSemiAt !== -1 ? sql.slice(0, sawSemiAt).trim() : sql;
  return { sql: cleaned, firstKeyword };
}

function sanitizeSqlValue(v: unknown): unknown {
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v.toString();
  }
  if (v instanceof Uint8Array) {
    return Buffer.from(v).toString('base64');
  }
  return v;
}

function executeReadOnlySql(
  db: Db,
  rawSql: string,
  params: (string | number | null)[] = [],
  limit = MAX_SQL_ROWS,
) {
  const { sql } = scanReadOnlySql(rawSql);
  const cap = Math.min(Math.max(1, limit), MAX_SQL_ROWS);

  db.setAuthorizer((actionCode, arg1, arg2) => {
    if (!AUTHORIZED_SQLITE_CODES.has(actionCode)) return constants.SQLITE_DENY;
    if (actionCode === constants.SQLITE_FUNCTION) {
      const fn = (arg2 ?? '').toLowerCase();
      if (fn === 'load_extension' || fn === 'fts3_tokenizer') return constants.SQLITE_DENY;
    }
    if (actionCode === constants.SQLITE_PRAGMA) {
      const pragma = (arg1 ?? '').toLowerCase();
      if (READ_ONLY_PRAGMA_WITH_ARG.has(pragma)) return constants.SQLITE_OK;
      if (READ_ONLY_PRAGMA_NO_ARG.has(pragma) && arg2 === null) return constants.SQLITE_OK;
      return constants.SQLITE_DENY;
    }
    return constants.SQLITE_OK;
  });

  try {
    const stmt = db.prepare(sql);
    const columns = stmt.columns().map(c => c.name);
    const rows: Record<string, unknown>[] = [];
    let truncated = false;
    for (const rawRow of stmt.iterate(...params)) {
      if (rows.length >= cap) {
        truncated = true;
        break;
      }
      const clean: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(rawRow)) {
        clean[k] = sanitizeSqlValue(val);
      }
      rows.push(clean);
    }
    return { columns, rows, row_count: rows.length, truncated };
  } finally {
    db.setAuthorizer(null);
  }
}

export function createMyFoodMcpServer(db: Db, opts?: MyFoodMcpOptions): McpServer {
  const now = opts?.now ?? Date.now;
  const server = new McpServer({
    name: 'myfood',
    version: opts?.build ?? '0.1.0',
  });

  // ---- Read / Query tools ----

  server.registerTool(
    'get_state',
    {
      title: 'Get Household State',
      description: 'Read the household state: users, active items with current stock, presets, daily nutrition, expenses, expense locks, and currency.',
      inputSchema: {
        user_id: z.number().int().positive().optional().describe('Optional user ID perspective for me, presets, and usual map. Defaults to first user.'),
        full: z.boolean().optional().describe('When true, also returns the events log and usual map and all expenses/nutrition (large). Default is compact.'),
        compact: z.boolean().optional().describe('Deprecated: compact is now the default; compact=false is the same as full=true.'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ user_id, full, compact: compactArg }) => runTool(() => {
      const compact = !full && compactArg !== false;
      const nowMs = now();
      const uid = resolveReadUserId(db, user_id, opts?.defaultUserId);
      const currency = getMeta(db, 'currency') ?? 'kr';
      const rev = getRev(db);

      if (uid === null) {
        const empty = {
          rev,
          now: nowMs,
          currency,
          me: null,
          users: [],
          items: loadHydratedItems(db, nowMs, false),
          presets: [],
          expense_locks: all(db, 'SELECT period, locked_by, locked_at, total_cents, event_count, note FROM expense_locks ORDER BY period DESC'),
          expenses: [],
          daily_nutrition: [],
        };
        return okResult(`Household has no users yet (rev ${rev}).`, empty);
      }

      const st = d.buildState(db, uid, { build: opts?.build ?? 'mcp', now: nowMs, ai: null });
      const items = st.items.map(i => ({
        ...i,
        shown_stock: shown(i.stock),
        portions: portionCount(i, i.stock),
        is_low: isLow(i),
        is_expiring_soon: isExpiringSoon(i, nowMs),
      }));

      const data: Record<string, unknown> = {
        rev: st.rev,
        now: st.now,
        currency: st.currency,
        me: st.me,
        users: st.users,
        items,
        presets: st.presets,
        expense_locks: st.expense_locks,
        expenses: compact ? st.expenses.slice(0, 25) : st.expenses,
        daily_nutrition: compact ? st.daily_nutrition.slice(0, 14) : st.daily_nutrition,
      };
      if (!compact) {
        data.usual = st.usual;
        data.events = st.events;
      }

      const lowCount = items.filter(i => i.is_low).length;
      return okResult(
        `State rev ${st.rev}: ${items.length} active items (${lowCount} low), ${st.users.length} users, ${st.presets.length} presets, currency ${st.currency}.${compact ? ' Compact view: events and usual omitted (pass full=true, or use list_events).' : ''}`,
        data,
      );
    }),
  );

  server.registerTool(
    'list_items',
    {
      title: 'List Pantry Items',
      description: 'List pantry and cooked meal items with live stock, portion counts, low-stock flags, and expiry filters.',
      inputSchema: {
        category: Category.optional().describe('Filter by item category'),
        owner_id: z.number().int().positive().optional().describe('Filter to personal items owned by this user ID'),
        shared_only: z.boolean().optional().describe('When true, only include shared household items (owner_id is null)'),
        low_only: z.boolean().optional().describe('When true, only include items at or below low_at (or out of stock)'),
        expiring_within_days: z.number().int().min(0).max(3650).optional().describe('Only include in-stock items expiring within N days'),
        cooked_only: z.boolean().optional().describe('When true, only include cooked meal items'),
        include_archived: z.boolean().optional().describe('Include archived items (default false)'),
        search: z.string().trim().max(100).optional().describe('Case-insensitive substring match against item name'),
      },
      annotations: READ_ANNOTATIONS,
    },
    (args) => runTool(() => {
      const nowMs = now();
      let items = loadHydratedItems(db, nowMs, !!args.include_archived);
      if (args.category !== undefined) items = items.filter(i => i.category === args.category);
      if (args.shared_only) items = items.filter(i => i.owner_id === null);
      if (args.owner_id !== undefined) items = items.filter(i => i.owner_id === args.owner_id);
      if (args.cooked_only) items = items.filter(i => i.is_cooked);
      if (args.low_only) items = items.filter(i => i.is_low && !i.archived_at);
      if (args.expiring_within_days !== undefined) {
        items = items.filter(
          i => i.shown_stock > 0 && i.days_until_expiry !== null && i.days_until_expiry <= args.expiring_within_days!,
        );
      }
      if (args.search) {
        const needle = nameKey(args.search);
        items = items.filter(i => nameKey(i.name).includes(needle));
      }
      return okResult(`Found ${items.length} item(s).`, { count: items.length, items });
    }),
  );

  server.registerTool(
    'get_item',
    {
      title: 'Get Item Details',
      description: 'Get one item by ID or name, including stock, recipe, barcodes, receipt aliases, and recent events. For level items, an eat event line with is_set=true records the remaining level of the open container; buy adds containers and adjust sets the exact total container count.',
      inputSchema: {
        item_id: z.number().int().positive().optional().describe('Item ID'),
        name: z.string().trim().min(1).max(60).optional().describe('Item name (when item_id is omitted)'),
        owner_id: z.number().int().positive().nullable().optional().describe('Optional owner_id (or null for shared) to disambiguate lookup by name'),
        include_archived: z.boolean().optional().describe('Allow matching archived items (default false)'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ item_id, name, owner_id, include_archived }) => runTool(() => {
      if (item_id === undefined && !name) d.fail(400, 'Provide item_id or name');
      const nowMs = now();
      let item: HydratedItem | null = null;
      if (item_id !== undefined) {
        item = getHydratedItemById(db, item_id, nowMs, !!include_archived);
        if (!item) d.fail(404, `No item with id ${item_id}`);
      } else {
        const key = nameKey(name!);
        const allItems = loadHydratedItems(db, nowMs, !!include_archived).filter(i => nameKey(i.name) === key);
        const filtered = owner_id !== undefined ? allItems.filter(i => i.owner_id === owner_id) : allItems;
        if (filtered.length === 0) d.fail(404, `No item called "${name}"`);
        if (filtered.length > 1) {
          d.fail(
            400,
            `Multiple items called "${name}" exist (${filtered.map(i => `id=${i.id}, owner_id=${i.owner_id}`).join('; ')}); pass item_id or owner_id`,
          );
        }
        item = filtered[0]!;
      }

      const barcodes = all<{ code: string; product_name: string | null; brand: string | null; source: string }>(
        db,
        'SELECT code, product_name, brand, source FROM barcodes WHERE item_id = ? ORDER BY updated_at DESC',
        item.id,
      ).map(r => ({ ...r }));
      const aliases = all<{ text: string }>(db, 'SELECT text FROM aliases WHERE item_id = ? ORDER BY text', item.id).map(a => a.text);
      const eventRows = all<EventRowFull>(
        db,
        `SELECT DISTINCT e.cid, e.seq, e.user_id, e.at, e.kind, e.source, e.note, e.preset_id, e.cost_cents, e.counts_nutrition, e.undone_at
         FROM events e JOIN event_lines l ON l.event_cid = e.cid
         WHERE l.item_id = ? AND e.undone_at IS NULL
         ORDER BY e.at DESC, e.seq DESC LIMIT 20`,
        item.id,
      );
      const recent_events = eventRows.map(ev => eventRowToJson(db, ev));

      return okResult(`${item.emoji} ${item.name} (#${item.id}): stock ${item.stock} ${item.unit}.`, {
        item,
        barcodes,
        aliases,
        recent_events,
      });
    }),
  );

  server.registerTool(
    'list_events',
    {
      title: 'List Events',
      description: 'Query the full event ledger newest first using before_at + before_seq to paginate beyond 500 events. Set format=csv for a flat event-line table that is easy to load into pandas. On level items, an eat event line with is_set=true records the remaining level of the open container; buy adds containers and adjust sets the exact total container count.',
      inputSchema: {
        user_id: z.number().int().positive().optional().describe('Filter by user ID'),
        kind: Kind.optional().describe('Filter by kind: buy, eat, or adjust'),
        source: z.enum(SOURCES).optional().describe('Filter by source'),
        item_id: z.number().int().positive().optional().describe('Filter to events containing this item ID'),
        limit: z.number().int().min(1).max(500).optional().describe('Maximum events to return (default 50, max 500)'),
        include_undone: z.boolean().optional().describe('Include undone events (default false)'),
        before_at: z.number().int().optional().describe('Pagination cursor timestamp returned by the previous page'),
        before_seq: z.number().int().positive().optional().describe('Pagination cursor sequence returned by the previous page'),
        format: z.enum(['json', 'csv']).optional().describe('Return structured events or CSV rows (default json)'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ user_id, kind, source, item_id, limit, include_undone, before_at, before_seq, format }) => runTool(() => {
      const conds: string[] = [];
      const params: (string | number)[] = [];
      if (!include_undone) conds.push('e.undone_at IS NULL');
      if (user_id !== undefined) {
        conds.push('e.user_id = ?');
        params.push(user_id);
      }
      if (kind !== undefined) {
        conds.push('e.kind = ?');
        params.push(kind);
      }
      if (source !== undefined) {
        conds.push('e.source = ?');
        params.push(source);
      }
      if (item_id !== undefined) {
        conds.push('EXISTS (SELECT 1 FROM event_lines l WHERE l.event_cid = e.cid AND l.item_id = ?)');
        params.push(item_id);
      }
      if (before_at !== undefined || before_seq !== undefined) {
        if (before_at === undefined || before_seq === undefined) d.fail(400, 'before_at and before_seq must be provided together');
        conds.push('(e.at < ? OR (e.at = ? AND e.seq < ?))');
        params.push(before_at, before_at, before_seq);
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const cap = limit ?? 50;
      const rows = all<EventRowFull>(
        db,
        `SELECT e.cid, e.seq, e.user_id, e.at, e.kind, e.source, e.note, e.preset_id, e.cost_cents, e.counts_nutrition, e.undone_at
         FROM events e ${where} ORDER BY e.at DESC, e.seq DESC LIMIT ?`,
        ...params,
        cap,
      );
      const events = rows.map(ev => eventRowToJson(db, ev, !!include_undone));
      const last = rows.at(-1);
      const next = rows.length === cap && last ? { before_at: last.at, before_seq: last.seq } : null;
      if (format === 'csv') {
        const columns = ['seq', 'cid', 'at', 'kind', 'source', 'user_id', 'note', 'preset_id', 'cost_cents', 'counts_nutrition', 'undone_at', 'item_id', 'qty', 'is_set', 'line_cost_cents', 'expires_at', 'kcal', 'protein_g'];
        const lines = events.flatMap(ev => (ev.lines.length ? ev.lines : [null]).map(line => [ev.seq, ev.cid, ev.at, ev.kind, ev.source, ev.user_id, ev.note, ev.preset_id, ev.cost_cents, ev.counts_nutrition, ev.undone_at, line?.item_id, line?.qty, line?.is_set, line?.cost_cents, line?.expires_at, line?.kcal, line?.protein_g]));
        const csv = [columns, ...lines].map(row => row.map(csvCell).join(',')).join('\r\n');
        return okResult(`Returned ${events.length} event(s) as CSV${next ? '; request the next page with its cursor' : ''}.`, { count: events.length, next, csv });
      }
      return okResult(`Returned ${events.length} event(s).${next ? ' More events are available; use the returned cursor.' : ''}`, { count: events.length, next, events });
    }),
  );

  server.registerTool(
    'list_presets',
    {
      title: 'List Meal Presets',
      description: 'List saved quick-log meal presets for one user or all users.',
      inputSchema: {
        user_id: z.number().int().positive().optional().describe('Optional user ID filter'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ user_id }) => runTool(() => {
      let presets: (Preset & { user_name?: string })[];
      if (user_id !== undefined) {
        const u = get<User>(db, 'SELECT id, name, emoji FROM users WHERE id = ?', user_id);
        if (!u) d.fail(400, `Unknown user_id: ${user_id}`);
        presets = d.listPresets(db, user_id).map(p => ({ ...p, user_name: u.name }));
      } else {
        const users = all<User>(db, 'SELECT id, name, emoji FROM users ORDER BY id');
        const names = new Map(users.map(u => [u.id, u.name]));
        presets = all<Omit<Preset, 'lines'>>(db, 'SELECT id, user_id, name, emoji, hour FROM presets ORDER BY user_id, id').map(p => ({
          ...p,
          user_name: names.get(p.user_id),
          lines: all<{ item_id: number; qty: number }>(db, 'SELECT item_id, qty FROM preset_lines WHERE preset_id = ? ORDER BY rowid', p.id)
            .map(l => ({ ...l })),
        }));
      }
      return okResult(`Found ${presets.length} preset(s).`, { count: presets.length, presets });
    }),
  );

  server.registerTool(
    'list_expenses',
    {
      title: 'List Expenses & Weekly Locks',
      description: 'List expenses (optionally for an ISO week YYYY-Www) including lock status and optional CSV export.',
      inputSchema: {
        period: z.string().regex(ISO_WEEK_RE, 'Expected YYYY-Www').optional().describe('Optional ISO week (YYYY-Www)'),
        format: z.enum(['json', 'csv']).optional().describe('Export format: json (default) or csv'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ period, format }) => runTool(() => {
      const fmt = format ?? 'json';
      const out = d.exportExpenses(db, { period, format: fmt });
      const locks = period
        ? all<{ period: string; locked_by: number; locked_at: number; total_cents: number; event_count: number; note: string | null }>(
            db,
            'SELECT period, locked_by, locked_at, total_cents, event_count, note FROM expense_locks WHERE period = ?',
            period,
          ).map(l => ({ ...l }))
        : all<{ period: string; locked_by: number; locked_at: number; total_cents: number; event_count: number; note: string | null }>(
            db,
            'SELECT period, locked_by, locked_at, total_cents, event_count, note FROM expense_locks ORDER BY period DESC',
          ).map(l => ({ ...l }));
      const is_locked = period ? locks.length > 0 : null;

      if (fmt === 'csv') {
        const currency = getMeta(db, 'currency') ?? 'kr';
        return okResult(`Exported CSV for ${period ?? 'all weeks'}.`, {
          period: period ?? 'all',
          currency,
          is_locked,
          locks,
          filename: out.filename,
          csv: out.body,
        });
      }

      const parsed = JSON.parse(out.body) as {
        period: string;
        currency: string;
        expenses: { cost_cents: number }[];
      };
      const total_cents = parsed.expenses.reduce((sum, e) => sum + e.cost_cents, 0);
      return okResult(
        `Found ${parsed.expenses.length} expense(s) totaling ${total_cents} minor units (${parsed.currency}).`,
        {
          period: parsed.period,
          currency: parsed.currency,
          is_locked,
          locks,
          total_cents,
          event_count: parsed.expenses.length,
          expenses: parsed.expenses,
        },
      );
    }),
  );

  server.registerTool(
    'get_daily_nutrition',
    {
      title: 'Get Daily Nutrition',
      description: 'Aggregate daily eaten kcal, protein_g and fat_g totals (excluding raw cooking ingredient consumption) over the past N days.',
      inputSchema: {
        days: z.number().int().min(1).max(365).optional().describe('Lookback window in days (default 14, max 365)'),
        user_id: z.number().int().positive().optional().describe('Optional user ID filter'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ days, user_id }) => runTool(() => {
      if (user_id !== undefined && !get(db, 'SELECT 1 FROM users WHERE id = ?', user_id)) {
        d.fail(400, `Unknown user_id: ${user_id}`);
      }
      const lookback = days ?? 14;
      const cutoff = now() - lookback * DAY_MS;
      const users = new Map(all<User>(db, 'SELECT id, name, emoji FROM users').map(u => [u.id, u.name]));
      const rows = all<{
        at: number;
        user_id: number;
        item_id: number;
        qty: number;
        is_set: number;
        kcal: number | null;
        protein_g: number | null;
        fat_g: number | null;
        kcal_per_unit: number | null;
        protein_per_unit: number | null;
        fat_per_unit: number | null;
      }>(
        db,
        `SELECT e.at, e.user_id, l.item_id, l.qty, l.is_set, l.kcal, l.protein_g, l.fat_g, i.kcal_per_unit, i.protein_per_unit, i.fat_per_unit
         FROM event_lines l
         JOIN events e ON e.cid = l.event_cid
         JOIN items i ON i.id = l.item_id
         WHERE e.undone_at IS NULL AND e.kind = 'eat' AND e.counts_nutrition = 1 AND e.at >= ?
           ${user_id !== undefined ? 'AND e.user_id = ?' : ''}`,
        ...(user_id !== undefined ? [cutoff, user_id] : [cutoff]),
      );

      const dailyMap = new Map<string, DailyNutrition & { user_name?: string }>();
      for (const r of rows) {
        if (r.is_set) continue;
        const n = eventLineNutrition(
          { item_id: r.item_id, qty: r.qty, is_set: false, kcal: r.kcal, protein_g: r.protein_g, fat_g: r.fat_g },
          { kcal_per_unit: r.kcal_per_unit, protein_per_unit: r.protein_per_unit, fat_per_unit: r.fat_per_unit },
        );
        if (n.kcal <= 0 && n.protein_g <= 0 && n.fat_g <= 0) continue;
        const day = isoDate(r.at);
        const key = `${day}:${r.user_id}`;
        const cur = dailyMap.get(key);
        if (cur) {
          cur.kcal = Math.round(cur.kcal + n.kcal);
          cur.protein_g = round1(cur.protein_g + n.protein_g);
          cur.fat_g = round1(cur.fat_g + n.fat_g);
        } else {
          dailyMap.set(key, {
            day,
            user_id: r.user_id,
            user_name: users.get(r.user_id),
            kcal: Math.round(n.kcal),
            protein_g: round1(n.protein_g),
            fat_g: round1(n.fat_g),
          });
        }
      }
      const entries = [...dailyMap.values()].sort((a, b) =>
        a.day === b.day ? a.user_id - b.user_id : b.day.localeCompare(a.day),
      );
      return okResult(`Returned ${entries.length} daily nutrition entry(ies) over ${lookback} day(s).`, {
        days: lookback,
        user_id: user_id ?? null,
        entries,
      });
    }),
  );

  server.registerTool(
    'query_sql',
    {
      title: 'Run Read-Only SQL Query',
      description:
        'Execute a read-only SQLite query (SELECT, WITH, PRAGMA, or EXPLAIN) across any table in the database (users, items, events, event_lines, presets, preset_lines, aliases, barcodes, meal_recipes, expense_locks, jobs, meta, api_tokens, push_subscriptions). Rejects writes and caps rows at 200.',
      inputSchema: {
        sql: z.string().trim().min(1).max(10_000).describe('Single read-only SQLite statement (SELECT, WITH, PRAGMA, or EXPLAIN)'),
        params: z.array(z.union([z.string(), z.number(), z.null()])).max(50).optional().describe('Optional positional ? parameters'),
        limit: z.number().int().min(1).max(MAX_SQL_ROWS).optional().describe('Row cap (default 200, max 200)'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ sql, params, limit }) => runTool(() => {
      const res = executeReadOnlySql(db, sql, params ?? [], limit ?? MAX_SQL_ROWS);
      return okResult(
        `Returned ${res.row_count} row(s)${res.truncated ? ' (truncated at limit)' : ''}.`,
        res,
      );
    }),
  );

  // ---- Write / Mutate tools ----

  const createItemShape = {
    name: ItemBody.shape.name.describe('Item name (unique per owner scope)'),
    category: Category.describe('Category'),
    unit: Unit.describe('Unit: pc, slice, g, ml, level, or portion'),
    emoji: ItemBody.shape.emoji.optional().describe('Emoji icon (default 🍽️)'),
    step: ItemBody.shape.step.optional().describe('Stepper increment (default 50 for g/ml, else 1)'),
    pack_size: ItemBody.shape.pack_size.optional().describe('Units per bought pack (default 1)'),
    low_at: ItemBody.shape.low_at.optional().describe('Low-stock threshold, or null (default null)'),
    owner_id: ItemBody.shape.owner_id.describe('User ID for personal item, or null/omitted for shared'),
    is_cooked: ItemBody.shape.is_cooked.describe('Whether item is a cooked meal'),
    portion_g: ItemBody.shape.portion_g.describe('Grams per 1 portion (for g-tracked meals)'),
    expires_at: ItemBody.shape.expires_at.describe('Expiry date YYYY-MM-DD'),
    shelf_life_days: ItemBody.shape.shelf_life_days.describe('Default shelf life in days on buy'),
    kcal_per_unit: ItemBody.shape.kcal_per_unit.describe('Calories per 1 unit'),
    protein_per_unit: ItemBody.shape.protein_per_unit.describe('Protein (g) per 1 unit'),
    fat_per_unit: ItemBody.shape.fat_per_unit.describe('Fat (g) per 1 unit'),
    barcode: ItemBody.shape.barcode.describe('Optional 6-14 digit barcode to link'),
  };
  const CreateItemArgs = z.object(createItemShape);

  const updateItemShape = {
    item_id: z.number().int().positive().describe('Active item ID to update'),
    name: ItemPatch.shape.name.describe('Updated name'),
    emoji: ItemPatch.shape.emoji.describe('Updated emoji'),
    category: ItemPatch.shape.category.describe('Updated category'),
    unit: ItemPatch.shape.unit.describe('Updated unit'),
    step: ItemPatch.shape.step.describe('Updated step'),
    pack_size: ItemPatch.shape.pack_size.describe('Updated pack_size'),
    low_at: ItemPatch.shape.low_at.describe('Updated low_at threshold (or null)'),
    owner_id: ItemPatch.shape.owner_id.describe('Updated owner_id (or null for shared)'),
    is_cooked: ItemPatch.shape.is_cooked.describe('Updated is_cooked flag'),
    portion_g: ItemPatch.shape.portion_g.describe('Updated portion_g'),
    expires_at: ItemPatch.shape.expires_at.describe('Updated expires_at YYYY-MM-DD (or null)'),
    shelf_life_days: ItemPatch.shape.shelf_life_days.describe('Updated shelf_life_days'),
    kcal_per_unit: ItemPatch.shape.kcal_per_unit.describe('Updated kcal_per_unit'),
    protein_per_unit: ItemPatch.shape.protein_per_unit.describe('Updated protein_per_unit'),
    fat_per_unit: ItemPatch.shape.fat_per_unit.describe('Updated fat_per_unit'),
    barcode: ItemPatch.shape.barcode.describe('Optional 6-14 digit barcode to link'),
  };
  const UpdateItemArgs = z.object(updateItemShape);

  const createOneItem = (args: z.infer<typeof CreateItemArgs>, nowMs: number): HydratedItem => {
    const parsed = ItemBody.parse({
      ...args,
      emoji: args.emoji ?? '🍽️',
      step: args.step ?? (args.unit === 'g' || args.unit === 'ml' ? 50 : 1),
      pack_size: args.pack_size ?? 1,
      low_at: args.low_at ?? null,
    });
    d.createItem(db, parsed, nowMs);
    const row = get<{ id: number }>(
      db,
      'SELECT id FROM items WHERE name_key = ? AND COALESCE(owner_id, 0) = ? AND archived_at IS NULL',
      nameKey(parsed.name),
      parsed.owner_id ?? 0,
    )!;
    return getHydratedItemById(db, row.id, nowMs)!;
  };

  const updateOneItem = ({ item_id, ...rest }: z.infer<typeof UpdateItemArgs>, nowMs: number): HydratedItem => {
    d.patchItem(db, item_id, ItemPatch.parse(stripUndefined(rest)));
    return getHydratedItemById(db, item_id, nowMs)!;
  };

  server.registerTool(
    'batch_items',
    {
      title: 'Batch Create / Update / Archive Items',
      description:
        'Create, update, and archive many items in one atomic call (all succeed or nothing changes). Runs all creates, then all updates, then all archives, so one batch cannot create a name that a later update or archive in the same batch frees up (split those into two calls). Use this instead of repeated create_item/update_item/archive_item calls.',
      inputSchema: {
        create: z.array(CreateItemArgs).max(100).optional().describe('Items to create (same fields as create_item)'),
        update: z.array(UpdateItemArgs).max(100).optional().describe('Item patches (same fields as update_item, item_id required)'),
        archive: z.array(z.number().int().positive()).max(100).optional().describe('Item IDs to archive'),
      },
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    ({ create = [], update = [], archive = [] }) => runTool(() => {
      if (!create.length && !update.length && !archive.length) d.fail(400, 'Provide create, update, and/or archive');
      const nowMs = now();
      const step = <T, R>(label: string, list: T[], name: (x: T) => string, fn: (x: T) => R): R[] =>
        list.map((x, i) => {
          try {
            return fn(x);
          } catch (err) {
            throw new Error(`${label}[${i}] (${name(x)}): ${errMessage(err)}. Nothing was changed.`);
          }
        });
      const result = transaction(db, () => {
        const created = step('create', create, a => a.name, a => createOneItem(a, nowMs));
        const updated = step('update', update, a => `#${a.item_id}`, a => updateOneItem(a, nowMs));
        const archived = step('archive', archive, id => `#${id}`, id => (d.archiveItem(db, id, nowMs), id));
        return { created, updated, archived_item_ids: archived };
      });
      return okResult(
        `Created ${result.created.length}, updated ${result.updated.length}, archived ${result.archived_item_ids.length} item(s).`,
        { ...result, rev: getRev(db) },
      );
    }),
  );

  server.registerTool(
    'create_item',
    {
      title: 'Create Item',
      description: 'Create a new pantry or meal item (or revive a matching archived item). To create several, use batch_items.',
      inputSchema: createItemShape,
      annotations: WRITE_ANNOTATIONS,
    },
    (args) => runTool(() => {
      const item = createOneItem(args, now());
      return okResult(`Created ${item.emoji} ${item.name} (#${item.id}).`, { item, rev: getRev(db) });
    }),
  );

  server.registerTool(
    'update_item',
    {
      title: 'Update Item',
      description: 'Update metadata, thresholds, nutrition, expiry, ownership, or barcode of an existing active item. To update several, use batch_items.',
      inputSchema: updateItemShape,
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    (args) => runTool(() => {
      const item = updateOneItem(args, now());
      return okResult(`Updated ${item.emoji} ${item.name} (#${item.id}).`, { item, rev: getRev(db) });
    }),
  );

  server.registerTool(
    'archive_item',
    {
      title: 'Archive Item',
      description: 'Archive an item and remove it from preset lines and meal recipes while keeping historical events intact.',
      inputSchema: {
        item_id: z.number().int().positive().describe('Item ID to archive'),
      },
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    ({ item_id }) => runTool(() => {
      d.archiveItem(db, item_id, now());
      return okResult(`Archived item #${item_id}.`, { archived_item_id: item_id, rev: getRev(db) });
    }),
  );

  server.registerTool(
    'log_event',
    {
      title: 'Log Pantry Event',
      description: 'Log a buy, eat, or adjust stock event (with optional cost_cents, expires_at, note) preserving nutrition snapshots and weekly expense locks.',
      inputSchema: {
        user_id: z.number().int().positive().optional().describe('User ID (optional only when household has 1 user)'),
        kind: Kind.describe('Event kind: buy, eat, or adjust'),
        lines: z.array(McpLineIn).min(1).max(60).describe('Lines to log, each with item_id or item (name); qty >= 0. For level items, buy qty is containers bought (usually 1), eat qty is the remaining level of the open container (1, 0.5, 0.25, or 0), and adjust qty is the exact total container count.'),
        cost_cents: EventBody.shape.cost_cents.describe('Total event cost in minor currency units'),
        expires_at: z.string().regex(ISO_DATE_RE, 'Expected YYYY-MM-DD').nullish().describe('Default expiry YYYY-MM-DD applied to bought lines lacking per-line expires_at'),
        note: EventBody.shape.note.describe('Optional event note'),
        preset_id: EventBody.shape.preset_id.describe('Optional preset ID'),
        source: z.enum(SOURCES).optional().describe('Optional event source (defaults to preset or ai)'),
        at: z.number().int().positive().optional().describe('Optional unix ms timestamp (default now)'),
        cid: EventBody.shape.cid.optional().describe('Optional client idempotency ID'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    (args) => runTool(async () => {
      const nowMs = now();
      const uid = resolveUserId(db, args.user_id, opts?.defaultUserId);
      const cid = args.cid ?? `mcp-${randomUUID()}`;
      const lines = resolveLines(db, 'lines', args.lines, uid).map(l => ({
        ...l,
        ...(args.expires_at != null && l.expires_at == null ? { expires_at: args.expires_at } : {}),
      }));
      requireActiveItems(db, lines.map(l => l.item_id));
      const body = EventBody.parse({
        cid,
        at: args.at ?? nowMs,
        kind: args.kind,
        lines,
        preset_id: args.preset_id ?? null,
        note: args.note ?? null,
        cost_cents: args.cost_cents,
      });
      const source: Source | undefined = args.source ?? (body.preset_id ? undefined : 'ai');
      const { prevStocks } = d.createEvent(db, uid, body, nowMs, source ? { source } : undefined);
      await opts?.onLowCrossings?.(prevStocks);

      const event = hydrateEventByCid(db, cid)!;
      const touchedIds = new Set(lines.map(l => l.item_id));
      const updated_items = loadHydratedItems(db, nowMs, false).filter(i => touchedIds.has(i.id));
      return okResult(
        `Logged ${body.kind} event ${cid} (${event.lines.length} line(s)).`,
        { event, updated_items, rev: getRev(db) },
      );
    }),
  );

  server.registerTool(
    'undo_event',
    {
      title: 'Undo Event',
      description: 'Soft-undo an event by cid (enforces weekly expense locks when the event has cost_cents).',
      inputSchema: {
        cid: z.string().trim().min(1).max(64).describe('Event cid to undo'),
      },
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    ({ cid }) => runTool(() => {
      d.undoEvent(db, cid, now());
      return okResult(`Undid event ${cid}.`, { undone_cid: cid, rev: getRev(db) });
    }),
  );

  server.registerTool(
    'edit_event',
    {
      title: 'Edit Event',
      description: 'Replace lines, cost_cents, or note of an active event (enforces weekly expense locks and updates nutrition snapshots). Level purchases add containers, level eats set the open container level, and level adjustments set the exact total; older absolute level purchase events retain their original meaning when edited.',
      inputSchema: {
        cid: z.string().trim().min(1).max(64).describe('Event cid to edit'),
        lines: z.array(McpLineIn).min(1).max(60).describe('Replacement lines, each with item_id or item (name). For level items, buy qty adds containers, eat qty sets the open container level, and adjust qty sets the exact total count.'),
        cost_cents: EventPatch.shape.cost_cents.describe('Updated total cost_cents'),
        note: EventPatch.shape.note.describe('Updated note'),
      },
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    (args) => runTool(async () => {
      const owner = get<{ user_id: number }>(db, 'SELECT user_id FROM events WHERE cid = ?', args.cid);
      const lines = resolveLines(db, 'lines', args.lines, owner?.user_id ?? null);
      requireActiveItems(db, lines.map(l => l.item_id));
      const patch = EventPatch.parse(
        stripUndefined({
          lines,
          cost_cents: args.cost_cents,
          note: args.note,
        }),
      );
      const prevStocks = d.editEvent(db, args.cid, patch);
      await opts?.onLowCrossings?.(prevStocks);
      const event = hydrateEventByCid(db, args.cid)!;
      return okResult(`Edited event ${args.cid}.`, { event, rev: getRev(db) });
    }),
  );

  server.registerTool(
    'cook_meal',
    {
      title: 'Cook Meal Batch',
      description:
        'Record a home-cooked meal batch (portions, total_g, or both) consuming measured raw ingredients without double-counting nutrition and saving the recipe. Level ingredients are ignored for stock and nutrition.',
      inputSchema: {
        user_id: z.number().int().positive().optional().describe('User ID cooking (optional when household has 1 user)'),
        meal_item_id: CookBody.shape.meal_item_id.describe('Existing cooked meal item ID, or omit to create/match by name'),
        name: CookBody.shape.name.describe('Meal name (required when meal_item_id is omitted)'),
        emoji: CookBody.shape.emoji.describe('Meal emoji (default 🍲)'),
        owner_id: CookBody.shape.owner_id.describe('Owner user ID or null for shared; omit to preserve existing owner when meal_item_id is given'),
        portions: CookBody.shape.portions.describe('Number of portions produced'),
        total_g: CookBody.shape.total_g.describe('Total cooked weight in grams'),
        expires_at: CookBody.shape.expires_at.describe('Explicit expiry date YYYY-MM-DD'),
        expires_in_days: z.number().int().min(0).max(60).optional().describe('Shelf life in days from today when expires_at is omitted (default 4)'),
        kcal_total: CookBody.shape.kcal_total.describe('Fallback total kcal, used only when no ingredient has calorie data (otherwise summed from ingredients)'),
        protein_total: CookBody.shape.protein_total.describe('Fallback total protein (g), used only when no ingredient has protein data (otherwise summed from ingredients)'),
        fat_total: CookBody.shape.fat_total.describe('Fallback total fat (g), used only when no ingredient has fat data (otherwise summed from ingredients)'),
        ingredients: z.array(McpCookIngredientIn).max(30).optional().describe('Raw ingredients consumed, each with item_id or item (name) (defaults to [])'),
        at: z.number().int().positive().optional().describe('Optional unix ms timestamp (default now)'),
        cid: CookBody.shape.cid.optional().describe('Optional idempotency batch cid'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    (args) => runTool(async () => {
      const nowMs = now();
      const uid = resolveUserId(db, args.user_id, opts?.defaultUserId);
      const at = args.at ?? nowMs;
      const expiresAt = args.expires_at !== undefined
        ? args.expires_at
        : args.expires_in_days != null
          ? addDays(isoDate(at), args.expires_in_days)
          : null;
      const body = CookBody.parse({
        cid: args.cid ?? `mcp-cook-${randomUUID()}`,
        at,
        meal_item_id: args.meal_item_id ?? null,
        name: args.name ?? null,
        emoji: args.emoji ?? null,
        ...(args.owner_id !== undefined ? { owner_id: args.owner_id } : {}),
        portions: args.portions ?? null,
        total_g: args.total_g ?? null,
        expires_at: expiresAt,
        kcal_total: args.kcal_total ?? null,
        protein_total: args.protein_total ?? null,
        fat_total: args.fat_total ?? null,
        ingredients: resolveLines(db, 'ingredients', args.ingredients ?? [], uid),
      });
      const res = d.applyCookBatch(db, uid, body, {
        now: nowMs,
        expires_in_days: args.expires_in_days ?? null,
      });
      await opts?.onLowCrossings?.(res.prevStocks);
      const meal_item = res.mealItemId ? getHydratedItemById(db, res.mealItemId, nowMs) : null;
      return okResult(
        `Cooked ${meal_item ? `${meal_item.emoji} ${meal_item.name}` : `meal #${res.mealItemId}`} (stock: ${meal_item?.stock ?? '?'} ${meal_item?.unit ?? ''}).`,
        {
          meal_item_id: res.mealItemId,
          meal_item,
          event_cids: res.eventCids,
          rev: getRev(db),
        },
      );
    }),
  );

  server.registerTool(
    'create_preset',
    {
      title: 'Create Meal Preset',
      description: 'Create a reusable quick-log meal preset for a user.',
      inputSchema: {
        user_id: z.number().int().positive().optional().describe('Owner user ID (optional when household has 1 user)'),
        name: PresetBody.shape.name.describe('Preset name'),
        emoji: PresetBody.shape.emoji.optional().describe('Preset emoji (default 🍳)'),
        hour: PresetBody.shape.hour.optional().describe('Typical local hour 0-23.99 (default 12)'),
        lines: z.array(McpLineIn).min(1).max(30).describe('Items and quantities, each with item_id or item (name)'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    (args) => runTool(() => {
      const uid = resolveUserId(db, args.user_id, opts?.defaultUserId);
      const body = PresetBody.parse({
        name: args.name,
        emoji: args.emoji ?? '🍳',
        hour: args.hour ?? 12,
        lines: resolveLines(db, 'lines', args.lines, uid),
      });
      d.createPreset(db, uid, body);
      const presets = d.listPresets(db, uid);
      const preset = presets[presets.length - 1]!;
      return okResult(`Created preset ${preset.emoji} ${preset.name} (#${preset.id}).`, {
        preset,
        rev: getRev(db),
      });
    }),
  );

  server.registerTool(
    'delete_preset',
    {
      title: 'Delete Meal Preset',
      description: 'Delete a saved meal preset owned by a user.',
      inputSchema: {
        preset_id: z.number().int().positive().describe('Preset ID to delete'),
        user_id: z.number().int().positive().optional().describe('Owner user ID (optional when household has 1 user)'),
      },
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    ({ preset_id, user_id }) => runTool(() => {
      const uid = resolveUserId(db, user_id, opts?.defaultUserId);
      d.deletePreset(db, uid, preset_id);
      return okResult(`Deleted preset #${preset_id}.`, { deleted_preset_id: preset_id, rev: getRev(db) });
    }),
  );

  server.registerTool(
    'update_preset',
    {
      title: 'Update Meal Preset',
      description: 'Rename a preset or change its emoji, hour, or lines. Omitted fields keep their current value; lines replaces the whole list.',
      inputSchema: {
        preset_id: z.number().int().positive().describe('Preset ID to update'),
        user_id: z.number().int().positive().optional().describe('Owner user ID (optional when household has 1 user)'),
        name: PresetBody.shape.name.optional().describe('New name'),
        emoji: PresetBody.shape.emoji.optional().describe('New emoji'),
        hour: PresetBody.shape.hour.optional().describe('New typical local hour 0-23.99'),
        lines: z.array(McpLineIn).min(1).max(30).optional().describe('Replacement items and quantities, each with item_id or item (name)'),
      },
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    ({ preset_id, user_id, lines, ...patch }) => runTool(() => {
      const uid = resolveUserId(db, user_id, opts?.defaultUserId);
      const cur = d.listPresets(db, uid).find(p => p.id === preset_id);
      if (!cur) d.fail(404, 'No such preset for this user');
      const nextLines = lines ? resolveLines(db, 'lines', lines, uid) : cur.lines;
      // Archiving an item drops it from presets, so a preset can end up empty.
      if (!nextLines.length) d.fail(400, 'Preset has no items left; pass lines');
      d.patchPreset(db, uid, preset_id, PresetBody.parse({ name: cur.name, emoji: cur.emoji, hour: cur.hour, ...stripUndefined(patch), lines: nextLines }));
      const preset = d.listPresets(db, uid).find(p => p.id === preset_id)!;
      return okResult(`Updated preset ${preset.emoji} ${preset.name} (#${preset.id}).`, { preset, rev: getRev(db) });
    }),
  );

  server.registerTool(
    'log_preset',
    {
      title: 'Log Preset Meal',
      description: 'Log an eat event from a saved preset by preset_id or preset name (with optional quantity multiplier).',
      inputSchema: {
        user_id: z.number().int().positive().optional().describe('User ID logging the meal (optional when household has 1 user)'),
        preset_id: z.number().int().positive().optional().describe('Preset ID to log'),
        name: z.string().trim().min(1).max(60).optional().describe('Preset name when preset_id is omitted'),
        multiplier: z.number().finite().gt(0).lte(20).optional().describe('Optional quantity multiplier (default 1)'),
        note: z.string().trim().max(200).nullish().describe('Optional note override'),
        at: z.number().int().positive().optional().describe('Optional unix ms timestamp (default now)'),
        cid: EventBody.shape.cid.optional().describe('Optional idempotency cid'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    (args) => runTool(async () => {
      if (args.preset_id === undefined && !args.name) {
        d.fail(400, 'Provide preset_id or name');
      }
      const nowMs = now();
      const uid = resolveUserId(db, args.user_id, opts?.defaultUserId);
      const presets = d.listPresets(db, uid);
      const matched = args.preset_id !== undefined
        ? presets.find(p => p.id === args.preset_id)
        : presets.find(p => nameKey(p.name) === nameKey(args.name!));
      if (!matched) d.fail(404, 'No such preset for this user');
      if (!matched.lines.length) d.fail(400, 'Preset has no items');

      const mult = args.multiplier ?? 1;
      const lines = matched.lines.map(l => ({ item_id: l.item_id, qty: round3(l.qty * mult) }));
      requireActiveItems(db, lines.map(l => l.item_id));
      const cid = args.cid ?? `mcp-preset-${randomUUID()}`;
      const body = EventBody.parse({
        cid,
        at: args.at ?? nowMs,
        kind: 'eat',
        preset_id: matched.id,
        note: args.note ?? matched.name,
        lines,
      });
      const { prevStocks } = d.createEvent(db, uid, body, nowMs, { source: 'preset' });
      await opts?.onLowCrossings?.(prevStocks);
      const event = hydrateEventByCid(db, cid)!;
      return okResult(`Logged preset ${matched.emoji} ${matched.name} (${cid}).`, {
        event,
        preset_id: matched.id,
        preset_name: matched.name,
        rev: getRev(db),
      });
    }),
  );

  server.registerTool(
    'add_expense',
    {
      title: 'Add Standalone Expense',
      description: 'Add a standalone grocery/food expense event without changing pantry stock (respects weekly locks).',
      inputSchema: {
        user_id: z.number().int().positive().optional().describe('User ID paying (optional when household has 1 user)'),
        cost_cents: ExpenseBody.shape.cost_cents.describe('Expense amount in minor currency units (> 0)'),
        note: ExpenseBody.shape.note.describe('Optional expense note'),
        at: z.number().int().positive().optional().describe('Optional unix ms timestamp (default now)'),
        cid: ExpenseBody.shape.cid.optional().describe('Optional idempotency cid'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    (args) => runTool(() => {
      const nowMs = now();
      const uid = resolveUserId(db, args.user_id, opts?.defaultUserId);
      const cid = args.cid ?? `mcp-exp-${randomUUID()}`;
      const body = ExpenseBody.parse({
        cid,
        at: args.at ?? nowMs,
        cost_cents: args.cost_cents,
        note: args.note ?? null,
      });
      d.addExpense(db, uid, body, nowMs);
      const storedAt = Math.min(body.at, nowMs);
      return okResult(`Recorded expense ${cid} (${body.cost_cents} minor units, ${isoWeek(storedAt)}).`, {
        cid,
        user_id: uid,
        at: storedAt,
        period: isoWeek(storedAt),
        cost_cents: body.cost_cents,
        note: body.note ?? null,
        rev: getRev(db),
      });
    }),
  );

  server.registerTool(
    'lock_expense_week',
    {
      title: 'Lock Expense Week',
      description: 'Freeze an ISO week (YYYY-Www) so no cost events in that week can be added, edited, or undone.',
      inputSchema: {
        period: LockPeriodBody.shape.period.describe('ISO week YYYY-Www (e.g. 2026-W46)'),
        user_id: z.number().int().positive().optional().describe('User ID locking the week (optional when household has 1 user)'),
        note: LockPeriodBody.shape.note.describe('Optional settlement note'),
      },
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    (args) => runTool(() => {
      const nowMs = now();
      const uid = resolveUserId(db, args.user_id, opts?.defaultUserId);
      const body = LockPeriodBody.parse({ period: args.period, note: args.note ?? null });
      d.lockExpensePeriod(db, uid, body, nowMs);
      const lock = get<{
        period: string;
        locked_by: number;
        locked_at: number;
        total_cents: number;
        event_count: number;
        note: string | null;
      }>(db, 'SELECT period, locked_by, locked_at, total_cents, event_count, note FROM expense_locks WHERE period = ?', body.period)!;
      return okResult(
        `Locked week ${lock.period} (${lock.event_count} events, total ${lock.total_cents} minor units).`,
        { lock: { ...lock }, rev: getRev(db) },
      );
    }),
  );

  server.registerTool(
    'lookup_barcode',
    {
      title: 'Lookup Barcode',
      description: 'Resolve a 6-14 digit barcode against the local barcodes cache and Open Food Facts.',
      inputSchema: {
        code: z.string().trim().regex(/^\d{6,14}$/, 'Barcode must be 6 to 14 digits').describe('6-14 digit EAN/UPC barcode'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    ({ code }) => runTool(async () => {
      const nowMs = now();
      const lookup = await resolveBarcode(db, code, opts?.lookupBarcode ?? defaultBarcodeLookup, nowMs);
      const item = lookup.item_id != null ? getHydratedItemById(db, lookup.item_id, nowMs) : null;
      return okResult(
        lookup.found
          ? `Barcode ${lookup.code}: ${lookup.product?.product_name ?? item?.name ?? 'matched item #' + lookup.item_id}.`
          : `Barcode ${lookup.code} not found.`,
        { ...lookup, item },
      );
    }),
  );

  server.registerTool(
    'link_barcode',
    {
      title: 'Link Barcode to Item',
      description: 'Link a 6-14 digit barcode to an active pantry item.',
      inputSchema: {
        code: BarcodeLinkBody.shape.code.describe('6-14 digit barcode'),
        item_id: BarcodeLinkBody.shape.item_id.describe('Active item ID'),
      },
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    (args) => runTool(() => {
      const body = BarcodeLinkBody.parse(args);
      linkBarcode(db, body.code, body.item_id, now());
      return okResult(`Linked barcode ${body.code} to item #${body.item_id}.`, {
        code: body.code,
        item_id: body.item_id,
        rev: getRev(db),
      });
    }),
  );

  server.registerTool(
    'set_alias',
    {
      title: 'Set Receipt Alias',
      description: 'Map a receipt/text phrase (normalized via aliasKey) to an active item ID.',
      inputSchema: {
        text: z.string().trim().min(1).max(200).describe('Receipt line or phrase to map'),
        item_id: z.number().int().positive().describe('Active item ID'),
      },
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    ({ text, item_id }) => runTool(() => {
      const key = aliasKey(text);
      if (!key) d.fail(400, 'Alias text must contain letters or digits');
      transaction(db, () => {
        if (!d.unitOf(db, item_id)) d.fail(404, `No active item #${item_id}`);
        run(db, 'INSERT OR REPLACE INTO aliases(text, item_id) VALUES (?, ?)', key, item_id);
        bumpRev(db);
      });
      return okResult(`Mapped alias "${key}" -> item #${item_id}.`, {
        text: key,
        item_id,
        rev: getRev(db),
      });
    }),
  );

  server.registerTool(
    'delete_alias',
    {
      title: 'Delete Receipt Alias',
      description: 'Remove a learned receipt alias by exact text or raw phrase.',
      inputSchema: {
        text: z.string().trim().min(1).max(200).describe('Alias text or raw phrase to delete'),
      },
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    ({ text }) => runTool(() => {
      const key = aliasKey(text);
      let changes = 0;
      transaction(db, () => {
        const res = run(db, 'DELETE FROM aliases WHERE text = ? OR text = ?', text, key);
        changes = Number(res.changes);
        if (changes === 0) d.fail(404, `No alias matching "${text}"`);
        bumpRev(db);
      });
      return okResult(`Deleted alias "${key || text}".`, {
        deleted: text,
        key,
        changes,
        rev: getRev(db),
      });
    }),
  );

  server.registerTool(
    'set_settings',
    {
      title: 'Update Household or User Settings',
      description: 'Update household currency and/or a user notification preferences (notify_low, notify_expiry).',
      inputSchema: {
        currency: SettingsBody.shape.currency.optional().describe('Household currency code/symbol'),
        user_id: z.number().int().positive().optional().describe('User ID when updating notify_low or notify_expiry'),
        notify_low: MeBody.shape.notify_low.describe('Enable/disable low-stock notifications'),
        notify_expiry: MeBody.shape.notify_expiry.describe('Enable/disable expiry notifications'),
      },
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    (args) => runTool(() => {
      const hasUserUpdate = args.notify_low !== undefined || args.notify_expiry !== undefined;
      if (args.currency === undefined && !hasUserUpdate) {
        d.fail(400, 'Provide currency, notify_low, and/or notify_expiry');
      }
      if (args.currency !== undefined) {
        d.patchSettings(db, SettingsBody.parse({ currency: args.currency }));
      }
      let updatedUser: { id: number; name: string; emoji: string; notify_low: boolean; notify_expiry: boolean } | null = null;
      if (hasUserUpdate) {
        const uid = resolveUserId(db, args.user_id, opts?.defaultUserId);
        d.patchMe(
          db,
          uid,
          MeBody.parse(
            stripUndefined({
              notify_low: args.notify_low,
              notify_expiry: args.notify_expiry,
            }),
          ),
        );
        const row = get<{ id: number; name: string; emoji: string; notify_low: number; notify_expiry: number }>(
          db,
          'SELECT id, name, emoji, notify_low, notify_expiry FROM users WHERE id = ?',
          uid,
        )!;
        updatedUser = {
          id: row.id,
          name: row.name,
          emoji: row.emoji,
          notify_low: !!row.notify_low,
          notify_expiry: !!row.notify_expiry,
        };
      }
      const currency = getMeta(db, 'currency') ?? 'kr';
      return okResult(`Updated settings (currency=${currency}).`, {
        currency,
        user: updatedUser,
        rev: getRev(db),
      });
    }),
  );

  return server;
}
