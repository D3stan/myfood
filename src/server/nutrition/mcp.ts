import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { User } from '../../shared/types.ts';
import { all, get } from '../db.ts';
import * as d from '../domain.ts';
import { READ_ANNOTATIONS, okResult, runTool } from '../mcp-kit.ts';
import type { McpCtx } from '../mcp-kit.ts';
import { dailyNutrition } from './repo.ts';

const DAY_MS = 86_400_000;

export function registerNutritionTools(server: McpServer, { db, now, forcedUserId }: McpCtx): void {
  server.registerTool(
    'get_daily_nutrition',
    {
      title: 'Get Daily Nutrition',
      description: 'Aggregate daily eaten kcal, protein_g, fat_g and carbs_g (null when unknown) totals (excluding raw cooking ingredient consumption) over the past N days.',
      inputSchema: {
        days: z.number().int().min(1).max(365).optional().describe('Lookback window in days (default 14, max 365)'),
        user_id: z.number().int().positive().optional().describe('Optional user ID filter'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ days, user_id: userArg }) => runTool(() => {
      const user_id = forcedUserId ?? userArg;
      if (user_id !== undefined && !get(db, 'SELECT 1 FROM users WHERE id = ?', user_id)) {
        d.fail(400, `Unknown user_id: ${user_id}`);
      }
      const lookback = days ?? 14;
      const cutoff = now() - lookback * DAY_MS;
      const users = new Map(all<User>(db, 'SELECT id, name, emoji FROM users').map(u => [u.id, u.name]));
      const entries = dailyNutrition(db, cutoff, user_id).map(({ day, user_id: uid, ...macros }) => ({
        day, user_id: uid, user_name: users.get(uid), ...macros,
      }));
      return okResult(`Returned ${entries.length} daily nutrition entry(ies) over ${lookback} day(s).`, {
        days: lookback,
        user_id: user_id ?? null,
        entries,
      });
    }),
  );
}
