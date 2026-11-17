import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ISO_WEEK_RE, isoWeek } from '../../shared/dates.ts';
import { ExpenseBody, LockPeriodBody } from '../../shared/types.ts';
import { all, get, getMeta, getRev } from '../db.ts';
import { DESTRUCTIVE_ANNOTATIONS, READ_ANNOTATIONS, WRITE_ANNOTATIONS, okResult, resolveUserId, runTool } from '../mcp-kit.ts';
import type { McpCtx } from '../mcp-kit.ts';
import { addExpense, exportExpenses, lockExpensePeriod } from './repo.ts';

export function registerSpendTools(server: McpServer, { db, now, defaultUserId }: McpCtx): void {
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
      const out = exportExpenses(db, { period, format: fmt });
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
      const uid = resolveUserId(db, args.user_id, defaultUserId);
      const cid = args.cid ?? `mcp-exp-${randomUUID()}`;
      const body = ExpenseBody.parse({
        cid,
        at: args.at ?? nowMs,
        cost_cents: args.cost_cents,
        note: args.note ?? null,
      });
      addExpense(db, uid, body, nowMs);
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
      const uid = resolveUserId(db, args.user_id, defaultUserId);
      const body = LockPeriodBody.parse({ period: args.period, note: args.note ?? null });
      lockExpensePeriod(db, uid, body, nowMs);
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
}
