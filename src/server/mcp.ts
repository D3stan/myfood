import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CURRENCIES, DEFAULT_CURRENCY } from '../shared/currency.ts';
import { isExpiringSoon, isLow, portionCount, shown } from '../shared/stock.ts';
import { MeBody, SettingsBody } from '../shared/types.ts';
import type { BarcodeLookupFn } from './barcodes.ts';
import { all, get, getMeta, getRev } from './db.ts';
import type { Db } from './db.ts';
import { fail, patchMe, patchSettings } from './domain.ts';
import { loadHydratedItems } from './items/repo.ts';
import { registerCookingTools } from './cooking/mcp.ts';
import { registerEventTools } from './events/mcp.ts';
import { registerItemTools } from './items/mcp.ts';
import { IDEMPOTENT_WRITE_ANNOTATIONS, READ_ANNOTATIONS, okResult, resolveReadUserId, resolveUserId, runTool, stripUndefined } from './mcp-kit.ts';
import { MAX_SQL_ROWS, executeReadOnlySql } from './mcp-sql.ts';
import { registerNutritionTools } from './nutrition/mcp.ts';
import { registerPresetTools } from './presets/mcp.ts';
import { registerSpendTools } from './spend/mcp.ts';
import { buildState } from './state.ts';

export interface MyFoodMcpOptions {
  now?: () => number;
  build?: string;
  defaultUserId?: number;
  forcedUserId?: number;
  lookupBarcode?: BarcodeLookupFn;
  onLowCrossings?: (prevStocks: Map<number, number>) => Promise<void>;
}

export function createMyFoodMcpServer(db: Db, opts?: MyFoodMcpOptions): McpServer {
  const now = opts?.now ?? Date.now;
  const server = new McpServer({
    name: 'myfood',
    version: opts?.build ?? '0.1.0',
  });

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
      const uid = resolveReadUserId(db, user_id, opts?.defaultUserId, opts?.forcedUserId);
      const currency = getMeta(db, 'currency') ?? DEFAULT_CURRENCY;
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

      const st = buildState(db, uid, { build: opts?.build ?? 'mcp', now: nowMs, ai: null });
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
  server.registerTool(
    'set_settings',
    {
      title: 'Update Household or User Settings',
      description: 'Update household currency (ISO 4217 code: ' + CURRENCIES.join(', ') + ') and/or a user notification preferences (notify_low, notify_expiry) and daily nutrition goals (goals: kcal, protein_g, fat_g, carbs_g; null clears one).',
      inputSchema: {
        currency: SettingsBody.shape.currency.optional().describe('Household currency, ISO 4217 code'),
        user_id: z.number().int().positive().optional().describe('User ID when updating notify_low or notify_expiry'),
        notify_low: MeBody.shape.notify_low.describe('Enable/disable low-stock notifications'),
        notify_expiry: MeBody.shape.notify_expiry.describe('Enable/disable expiry notifications'),
        goals: MeBody.shape.goals.describe('Daily nutrition goals; omitted keys unchanged, null clears'),
      },
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    (args) => runTool(() => {
      const hasUserUpdate = args.notify_low !== undefined || args.notify_expiry !== undefined || args.goals !== undefined;
      if (args.currency === undefined && !hasUserUpdate) {
        fail(400, 'Provide currency, notify_low, notify_expiry, and/or goals');
      }
      if (args.currency !== undefined) {
        patchSettings(db, SettingsBody.parse({ currency: args.currency }));
      }
      let updatedUser: { id: number; name: string; emoji: string; notify_low: boolean; notify_expiry: boolean; goals: Record<'kcal' | 'protein_g' | 'fat_g' | 'carbs_g', number | null> } | null = null;
      if (hasUserUpdate) {
        const uid = resolveUserId(db, args.user_id, opts?.defaultUserId, opts?.forcedUserId);
        patchMe(
          db,
          uid,
          MeBody.parse(
            stripUndefined({
              notify_low: args.notify_low,
              notify_expiry: args.notify_expiry,
              goals: args.goals,
            }),
          ),
        );
        const row = get<{ id: number; name: string; emoji: string; notify_low: number; notify_expiry: number; goal_kcal: number | null; goal_protein_g: number | null; goal_fat_g: number | null; goal_carbs_g: number | null }>(
          db,
          'SELECT id, name, emoji, notify_low, notify_expiry, goal_kcal, goal_protein_g, goal_fat_g, goal_carbs_g FROM users WHERE id = ?',
          uid,
        )!;
        updatedUser = {
          id: row.id,
          name: row.name,
          emoji: row.emoji,
          notify_low: !!row.notify_low,
          notify_expiry: !!row.notify_expiry,
          goals: { kcal: row.goal_kcal, protein_g: row.goal_protein_g, fat_g: row.goal_fat_g, carbs_g: row.goal_carbs_g },
        };
      }
      const currency = getMeta(db, 'currency') ?? DEFAULT_CURRENCY;
      return okResult(`Updated settings (currency=${currency}).`, {
        currency,
        user: updatedUser,
        rev: getRev(db),
      });
    }),
  );

  const ctx = { db, now, defaultUserId: opts?.defaultUserId, forcedUserId: opts?.forcedUserId, build: opts?.build, lookupBarcode: opts?.lookupBarcode, onLowCrossings: opts?.onLowCrossings };
  registerItemTools(server, ctx);
  registerEventTools(server, ctx);
  registerCookingTools(server, ctx);
  registerPresetTools(server, ctx);
  registerNutritionTools(server, ctx);
  registerSpendTools(server, ctx);

  return server;
}
