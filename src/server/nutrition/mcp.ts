import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EventBody } from '../../shared/types.ts';
import type { User } from '../../shared/types.ts';
import { randomUUID } from 'node:crypto';
import { all, get, getRev, jollyId } from '../db.ts';
import * as d from '../domain.ts';
import { READ_ANNOTATIONS, WRITE_ANNOTATIONS, okResult, resolveUserId, runTool } from '../mcp-kit.ts';
import type { McpCtx } from '../mcp-kit.ts';
import { createEvent, hydrateEventByCid } from '../events/repo.ts';
import { dailyNutrition } from './repo.ts';

const DAY_MS = 86_400_000;

export function registerNutritionTools(server: McpServer, { db, now, defaultUserId, forcedUserId }: McpCtx): void {
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

  server.registerTool(
    'log_eat_out',
    {
      title: 'Log Eat-Out Meal',
      description: 'Log food eaten outside the pantry (restaurant, takeaway, at a friend\'s) as one eat event with your own kcal/macro estimate for a normal portion. Never create a pantry item for it; stock and spend are untouched. note says what and where.',
      inputSchema: {
        user_id: z.number().int().positive().optional().describe('User ID (optional only when household has 1 user)'),
        note: z.string().trim().min(1).max(80).describe('What and where, e.g. "Pizza margherita, Gino"'),
        kcal: z.number().finite().min(0).max(5000).describe('Estimated kcal for the portion'),
        protein_g: z.number().finite().min(0).max(1000).optional(),
        fat_g: z.number().finite().min(0).max(1000).optional(),
        carbs_g: z.number().finite().min(0).max(1000).optional(),
        at: z.number().int().positive().optional().describe('Optional unix ms timestamp (default now)'),
        cid: z.string().min(8).max(64).optional().describe('Optional client idempotency ID'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    ({ user_id, note, kcal, protein_g, fat_g, carbs_g, at, cid: cidArg }) => runTool(() => {
      const nowMs = now();
      const uid = resolveUserId(db, user_id, defaultUserId, forcedUserId);
      const cid = cidArg ?? `mcp-${randomUUID()}`;
      const body = EventBody.parse({ cid, at: at ?? nowMs, kind: 'eat', note, lines: [{ item_id: jollyId(db), qty: 1, kcal, protein_g, fat_g, carbs_g }] });
      createEvent(db, uid, body, nowMs, { source: 'ai' });
      return okResult(`Logged eat-out event ${cid}.`, { event: hydrateEventByCid(db, cid)!, rev: getRev(db) });
    }),
  );
}
