import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { addDays, isoDate } from '../../shared/dates.ts';
import { CookBody } from '../../shared/types.ts';
import { getRev } from '../db.ts';
import { getHydratedItemById } from '../items/repo.ts';
import { WRITE_ANNOTATIONS, McpCookIngredientIn, okResult, resolveLines, resolveUserId, runTool } from '../mcp-kit.ts';
import type { McpCtx } from '../mcp-kit.ts';
import { applyCookBatch } from './repo.ts';


export function registerCookingTools(server: McpServer, { db, now, defaultUserId, forcedUserId, onLowCrossings }: McpCtx): void {
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
        carbs_total: CookBody.shape.carbs_total.describe('Fallback total carbs (g), used only when no ingredient has carbs data (otherwise summed from ingredients)'),
        ingredients: z.array(McpCookIngredientIn).max(30).optional().describe('Raw ingredients consumed, each with item_id or item (name) (defaults to [])'),
        at: z.number().int().positive().optional().describe('Optional unix ms timestamp (default now)'),
        cid: CookBody.shape.cid.optional().describe('Optional idempotency batch cid'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    (args) => runTool(async () => {
      const nowMs = now();
      const uid = resolveUserId(db, args.user_id, defaultUserId, forcedUserId);
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
        carbs_total: args.carbs_total ?? null,
        ingredients: resolveLines(db, 'ingredients', args.ingredients ?? [], uid),
      });
      const res = applyCookBatch(db, uid, body, {
        now: nowMs,
        expires_in_days: args.expires_in_days ?? null,
      });
      await onLowCrossings?.(res.prevStocks);
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
}
