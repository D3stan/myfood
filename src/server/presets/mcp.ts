import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { nameKey } from '../../shared/text.ts';
import { EventBody, PresetBody } from '../../shared/types.ts';
import type { Preset, User } from '../../shared/types.ts';
import { all, get, getRev } from '../db.ts';
import { fail } from '../domain.ts';
import { createEvent, hydrateEventByCid } from '../events/repo.ts';
import { requireActiveItems } from '../items/repo.ts';
import { DESTRUCTIVE_ANNOTATIONS, IDEMPOTENT_WRITE_ANNOTATIONS, READ_ANNOTATIONS, WRITE_ANNOTATIONS, McpLineIn, okResult, resolveLines, resolveUserId, runTool, stripUndefined } from '../mcp-kit.ts';
import type { McpCtx } from '../mcp-kit.ts';
import { createPreset, deletePreset, listPresets, patchPreset } from './repo.ts';

const round3 = (n: number): number => Math.round(n * 1000) / 1000;


export function registerPresetTools(server: McpServer, { db, now, defaultUserId, forcedUserId, onLowCrossings }: McpCtx): void {
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
    ({ user_id: userArg }) => runTool(() => {
      const user_id = forcedUserId ?? userArg;
      let presets: (Preset & { user_name?: string })[];
      if (user_id !== undefined) {
        const u = get<User>(db, 'SELECT id, name, emoji FROM users WHERE id = ?', user_id);
        if (!u) fail(400, `Unknown user_id: ${user_id}`);
        presets = listPresets(db, user_id).map(p => ({ ...p, user_name: u.name }));
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
      const uid = resolveUserId(db, args.user_id, defaultUserId, forcedUserId);
      const body = PresetBody.parse({
        name: args.name,
        emoji: args.emoji ?? '🍳',
        hour: args.hour ?? 12,
        lines: resolveLines(db, 'lines', args.lines, uid),
      });
      createPreset(db, uid, body);
      const presets = listPresets(db, uid);
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
      const uid = resolveUserId(db, user_id, defaultUserId, forcedUserId);
      deletePreset(db, uid, preset_id);
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
      const uid = resolveUserId(db, user_id, defaultUserId, forcedUserId);
      const cur = listPresets(db, uid).find(p => p.id === preset_id);
      if (!cur) fail(404, 'No such preset for this user');
      const nextLines = lines ? resolveLines(db, 'lines', lines, uid) : cur.lines;
      // Archiving an item drops it from presets, so a preset can end up empty.
      if (!nextLines.length) fail(400, 'Preset has no items left; pass lines');
      patchPreset(db, uid, preset_id, PresetBody.parse({ name: cur.name, emoji: cur.emoji, hour: cur.hour, ...stripUndefined(patch), lines: nextLines }));
      const preset = listPresets(db, uid).find(p => p.id === preset_id)!;
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
        fail(400, 'Provide preset_id or name');
      }
      const nowMs = now();
      const uid = resolveUserId(db, args.user_id, defaultUserId, forcedUserId);
      const presets = listPresets(db, uid);
      const matched = args.preset_id !== undefined
        ? presets.find(p => p.id === args.preset_id)
        : presets.find(p => nameKey(p.name) === nameKey(args.name!));
      if (!matched) fail(404, 'No such preset for this user');
      if (!matched.lines.length) fail(400, 'Preset has no items');

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
      const { prevStocks } = createEvent(db, uid, body, nowMs, { source: 'preset' });
      await onLowCrossings?.(prevStocks);
      const event = hydrateEventByCid(db, cid)!;
      return okResult(`Logged preset ${matched.emoji} ${matched.name} (${cid}).`, {
        event,
        preset_id: matched.id,
        preset_name: matched.name,
        rev: getRev(db),
      });
    }),
  );
}
