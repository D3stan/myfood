import { constants } from 'node:sqlite';
import type { Db } from './db.ts';
import { fail } from './domain.ts';

export const MAX_SQL_ROWS = 200;

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
  if (!sql) fail(400, 'SQL query must not be empty');

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
      if (end === -1) fail(400, 'Unterminated SQL block comment');
      i = end + 2;
      continue;
    }

    if (sawSemiAt !== -1) {
      fail(400, 'Multiple SQL statements are not allowed');
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
      if (end === -1) fail(400, 'Unterminated SQL bracket identifier');
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
    fail(400, `Only read-only SELECT, WITH, PRAGMA, or EXPLAIN queries are allowed (got "${words[0] ?? ''}")`);
  }

  if (firstKeyword === 'PRAGMA') {
    if (sawEq) fail(400, 'Mutating PRAGMA assignments are not allowed');
    const candidate = (words[1]?.toLowerCase() === 'main' && words[2] ? words[2] : words[1])?.toLowerCase() ?? '';
    if (!READ_ONLY_PRAGMA_WITH_ARG.has(candidate) && !READ_ONLY_PRAGMA_NO_ARG.has(candidate)) {
      fail(400, `PRAGMA "${candidate}" is not in the read-only allowlist`);
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

export function executeReadOnlySql(
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
