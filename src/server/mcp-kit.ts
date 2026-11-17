import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Db } from './db.ts';
import { all, get } from './db.ts';
import * as d from './domain.ts';

/** What every feature's `registerXTools(server, ctx)` receives. */
export interface McpCtx {
  db: Db;
  now: () => number;
  defaultUserId?: number;
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

export function resolveUserId(db: Db, requested?: number, defaultUserId?: number): number {
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
