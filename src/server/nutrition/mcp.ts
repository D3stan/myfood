import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isoDate } from '../../shared/dates.ts';
import { eventLineNutrition } from '../../shared/nutrition.ts';
import type { DailyNutrition, User } from '../../shared/types.ts';
import { all, get } from '../db.ts';
import * as d from '../domain.ts';
import { READ_ANNOTATIONS, okResult, runTool } from '../mcp-kit.ts';
import type { McpCtx } from '../mcp-kit.ts';

const DAY_MS = 86_400_000;
const round1 = (n: number): number => Math.round(n * 10) / 10;

export function registerNutritionTools(server: McpServer, { db, now }: McpCtx): void {
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
}
