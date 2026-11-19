import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { aliasKey, nameKey } from '../shared/text.ts';
import { CookIngredientIn, LineIn } from '../shared/types.ts';
import type { BarcodeLookupFn } from './barcodes.ts';
import type { Db } from './db.ts';
import { all, get } from './db.ts';
import { fail } from './domain.ts';
import type { MatchOffers } from './deals/matcher.ts';

/** What every feature's `registerXTools(server, ctx)` receives. */
export interface McpCtx {
  db: Db;
  now: () => number;
  defaultUserId?: number;
  /** Per-user MCP token: wins over any user_id tool argument. */
  forcedUserId?: number;
  build?: string;
  lookupBarcode?: BarcodeLookupFn;
  onLowCrossings?: (prevStocks: Map<number, number>) => Promise<void>;
  /** Outbound HTTP and the offer matcher for `sync_catalogs`. */
  fetch?: typeof fetch;
  matchOffers?: MatchOffers;
}

export const READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export const IDEMPOTENT_WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const DESTRUCTIVE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export function okResult(summary: string, data: Record<string, unknown>) {
  return {
    content: [
      { type: 'text' as const, text: summary },
      { type: 'text' as const, text: JSON.stringify(data, null, 2) },
    ],
    structuredContent: data,
  };
}

export function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true as const,
  };
}

// Zod's own .message is a JSON dump of issues; flatten it like routes.ts parse() does.
export function errMessage(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map(i => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message).join('; ');
  }
  return (err instanceof Error ? err.message : String(err)).replace(/\.$/, '');
}

export async function runTool(fn: () => ReturnType<typeof okResult> | Promise<ReturnType<typeof okResult>>) {
  try {
    return await fn();
  } catch (err) {
    return errorResult(errMessage(err));
  }
}

export function resolveUserId(db: Db, requested?: number, defaultUserId?: number, forcedUserId?: number): number {
  const target = forcedUserId ?? requested ?? defaultUserId;
  if (target !== undefined) {
    const u = get<{ id: number }>(db, 'SELECT id FROM users WHERE id = ?', target);
    if (!u) fail(400, `Unknown user_id: ${target}`);
    return u.id;
  }
  const users = all<{ id: number; name: string }>(db, 'SELECT id, name FROM users ORDER BY id');
  if (users.length === 0) fail(400, 'No users exist in the database');
  if (users.length === 1) return users[0]!.id;
  fail(
    400,
    `Multiple household users exist (${users.map(u => `${u.id}: ${u.name}`).join(', ')}); pass user_id explicitly`,
  );
}

export function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

export type ItemRef = { item_id?: number; item?: string };

/**
 * Turns {item_id} or {item: name} into an active item id. Name matches the acting user's
 * personal items plus shared ones, then falls back to a learned receipt alias.
 */
export function resolveItemRef(db: Db, ref: ItemRef, userId: number | null): number {
  if (ref.item_id !== undefined) {
    if (ref.item !== undefined) fail(400, 'Pass item_id or item, not both');
    return ref.item_id;
  }
  if (!ref.item) fail(400, 'Each line needs item_id or item (name)');
  const matches = all<{ id: number; owner_id: number | null }>(
    db,
    'SELECT id, owner_id FROM items WHERE name_key = ? AND archived_at IS NULL AND (owner_id IS NULL OR owner_id = ?)',
    nameKey(ref.item),
    userId ?? 0,
  );
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    fail(400, `"${ref.item}" matches several items (${matches.map(m => `id=${m.id} owner_id=${m.owner_id}`).join('; ')}); pass item_id`);
  }
  const alias = get<{ item_id: number }>(
    db,
    'SELECT a.item_id FROM aliases a JOIN items i ON i.id = a.item_id WHERE a.text = ? AND i.archived_at IS NULL',
    aliasKey(ref.item),
  );
  if (alias) return alias.item_id;
  fail(404, `No active item called "${ref.item}"`);
}

/** Resolves every line before any write; errors name the line index. */
export function resolveLines<T extends ItemRef>(db: Db, field: string, lines: T[], userId: number | null) {
  return lines.map((l, i) => {
    try {
      const { item: _name, ...rest } = l;
      return { ...rest, item_id: resolveItemRef(db, l, userId) };
    } catch (err) {
      fail(400, `${field}[${i}]: ${errMessage(err)}`);
    }
  });
}

// MCP-facing line schemas: item_id or item (name), refined in the handler.
export const itemRefShape = {
  item_id: z.number().int().positive().optional().describe('Item ID (or pass item instead)'),
  item: z.string().trim().min(1).max(60).optional().describe('Item name, used when item_id is omitted'),
};
export const McpLineIn = LineIn.extend(itemRefShape);
export const McpCookIngredientIn = CookIngredientIn.extend(itemRefShape);

export function resolveReadUserId(db: Db, requested?: number, defaultUserId?: number, forcedUserId?: number): number | null {
  const target = forcedUserId ?? requested ?? defaultUserId;
  if (target !== undefined) {
    const u = get<{ id: number }>(db, 'SELECT id FROM users WHERE id = ?', target);
    if (!u) fail(400, `Unknown user_id: ${target}`);
    return u.id;
  }
  return get<{ id: number }>(db, 'SELECT id FROM users ORDER BY id LIMIT 1')?.id ?? null;
}
