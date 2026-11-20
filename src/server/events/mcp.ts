import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ISO_DATE_RE } from '../../shared/dates.ts';
import { EventBody, EventPatch, Kind, SOURCES } from '../../shared/types.ts';
import type { Source } from '../../shared/types.ts';
import { all, get, getRev } from '../db.ts';
import { fail } from '../domain.ts';
import { IDEMPOTENT_WRITE_ANNOTATIONS, DESTRUCTIVE_ANNOTATIONS, READ_ANNOTATIONS, WRITE_ANNOTATIONS, McpLineIn, okResult, resolveLines, resolveUserId, runTool, stripUndefined } from '../mcp-kit.ts';
import type { McpCtx } from '../mcp-kit.ts';
import { loadHydratedItems, requireActiveItems } from '../items/repo.ts';
import { createEvent, editEvent, eventRowToJson, hydrateEventByCid, undoEvent } from './repo.ts';
import type { EventRowFull } from './repo.ts';

const csvCell = (value: unknown): string => {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};


export function registerEventTools(server: McpServer, { db, now, defaultUserId, forcedUserId, onLowCrossings }: McpCtx): void {
  server.registerTool(
    'list_events',
    {
      title: 'List Events',
      description: 'Query the full event ledger newest first using before_at + before_seq to paginate beyond 500 events. Set format=csv for a flat event-line table that is easy to load into pandas. On level items, an eat event line with is_set=true records the remaining level of the open container; buy adds containers and adjust sets the exact total container count.',
      inputSchema: {
        user_id: z.number().int().positive().optional().describe('Filter by user ID'),
        kind: Kind.optional().describe('Filter by kind: buy, eat, or adjust'),
        source: z.enum(SOURCES).optional().describe('Filter by source'),
        item_id: z.number().int().positive().optional().describe('Filter to events containing this item ID'),
        limit: z.number().int().min(1).max(500).optional().describe('Maximum events to return (default 50, max 500)'),
        include_undone: z.boolean().optional().describe('Include undone events (default false)'),
        before_at: z.number().int().optional().describe('Pagination cursor timestamp returned by the previous page'),
        before_seq: z.number().int().positive().optional().describe('Pagination cursor sequence returned by the previous page'),
        format: z.enum(['json', 'csv']).optional().describe('Return structured events or CSV rows (default json)'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ user_id: userArg, kind, source, item_id, limit, include_undone, before_at, before_seq, format }) => runTool(() => {
      const user_id = forcedUserId ?? userArg;
      const conds: string[] = [];
      const params: (string | number)[] = [];
      if (!include_undone) conds.push('e.undone_at IS NULL');
      if (user_id !== undefined) {
        conds.push('e.user_id = ?');
        params.push(user_id);
      }
      if (kind !== undefined) {
        conds.push('e.kind = ?');
        params.push(kind);
      }
      if (source !== undefined) {
        conds.push('e.source = ?');
        params.push(source);
      }
      if (item_id !== undefined) {
        conds.push('EXISTS (SELECT 1 FROM event_lines l WHERE l.event_cid = e.cid AND l.item_id = ?)');
        params.push(item_id);
      }
      if (before_at !== undefined || before_seq !== undefined) {
        if (before_at === undefined || before_seq === undefined) fail(400, 'before_at and before_seq must be provided together');
        conds.push('(e.at < ? OR (e.at = ? AND e.seq < ?))');
        params.push(before_at, before_at, before_seq);
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const cap = limit ?? 50;
      const rows = all<EventRowFull>(
        db,
        `SELECT e.cid, e.seq, e.user_id, e.at, e.kind, e.source, e.note, e.preset_id, e.cost_cents, e.counts_nutrition, e.undone_at
         FROM events e ${where} ORDER BY e.at DESC, e.seq DESC LIMIT ?`,
        ...params,
        cap,
      );
      const events = rows.map(ev => eventRowToJson(db, ev, !!include_undone));
      const last = rows.at(-1);
      const next = rows.length === cap && last ? { before_at: last.at, before_seq: last.seq } : null;
      if (format === 'csv') {
        const columns = ['seq', 'cid', 'at', 'kind', 'source', 'user_id', 'note', 'preset_id', 'cost_cents', 'counts_nutrition', 'undone_at', 'item_id', 'qty', 'is_set', 'line_cost_cents', 'expires_at', 'kcal', 'protein_g'];
        const lines = events.flatMap(ev => (ev.lines.length ? ev.lines : [null]).map(line => [ev.seq, ev.cid, ev.at, ev.kind, ev.source, ev.user_id, ev.note, ev.preset_id, ev.cost_cents, ev.counts_nutrition, ev.undone_at, line?.item_id, line?.qty, line?.is_set, line?.cost_cents, line?.expires_at, line?.kcal, line?.protein_g]));
        const csv = [columns, ...lines].map(row => row.map(csvCell).join(',')).join('\r\n');
        return okResult(`Returned ${events.length} event(s) as CSV${next ? '; request the next page with its cursor' : ''}.`, { count: events.length, next, csv });
      }
      return okResult(`Returned ${events.length} event(s).${next ? ' More events are available; use the returned cursor.' : ''}`, { count: events.length, next, events });
    }),
  );

  server.registerTool(
    'log_event',
    {
      title: 'Log Pantry Event',
      description: 'Log a buy, eat, or adjust stock event (with optional cost_cents, expires_at, note) preserving nutrition snapshots and weekly expense locks.',
      inputSchema: {
        user_id: z.number().int().positive().optional().describe('User ID (optional only when household has 1 user)'),
        kind: Kind.describe('Event kind: buy, eat, or adjust'),
        lines: z.array(McpLineIn).min(1).max(60).describe('Lines to log, each with item_id or item (name); qty >= 0. For level items, buy qty is containers bought (usually 1), eat qty is the remaining level of the open container (1, 0.75, 0.5, 0.25, or 0), and adjust qty is the exact total container count.'),
        cost_cents: EventBody.shape.cost_cents.describe('Total event cost in minor currency units'),
        expires_at: z.string().regex(ISO_DATE_RE, 'Expected YYYY-MM-DD').nullish().describe('Default expiry YYYY-MM-DD applied to bought lines lacking per-line expires_at'),
        note: EventBody.shape.note.describe('Optional event note'),
        preset_id: EventBody.shape.preset_id.describe('Optional preset ID'),
        source: z.enum(SOURCES).optional().describe('Optional event source (defaults to preset or ai)'),
        at: z.number().int().positive().optional().describe('Optional unix ms timestamp (default now)'),
        cid: EventBody.shape.cid.optional().describe('Optional client idempotency ID'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    (args) => runTool(async () => {
      const nowMs = now();
      const uid = resolveUserId(db, args.user_id, defaultUserId, forcedUserId);
      const cid = args.cid ?? `mcp-${randomUUID()}`;
      const lines = resolveLines(db, 'lines', args.lines, uid).map(l => ({
        ...l,
        ...(args.expires_at != null && l.expires_at == null ? { expires_at: args.expires_at } : {}),
      }));
      requireActiveItems(db, lines.map(l => l.item_id));
      const body = EventBody.parse({
        cid,
        at: args.at ?? nowMs,
        kind: args.kind,
        lines,
        preset_id: args.preset_id ?? null,
        note: args.note ?? null,
        cost_cents: args.cost_cents,
      });
      const source: Source | undefined = args.source ?? (body.preset_id ? undefined : 'ai');
      const { prevStocks } = createEvent(db, uid, body, nowMs, source ? { source } : undefined);
      await onLowCrossings?.(prevStocks);

      const event = hydrateEventByCid(db, cid)!;
      const touchedIds = new Set(lines.map(l => l.item_id));
      const updated_items = loadHydratedItems(db, nowMs, false).filter(i => touchedIds.has(i.id));
      return okResult(
        `Logged ${body.kind} event ${cid} (${event.lines.length} line(s)).`,
        { event, updated_items, rev: getRev(db) },
      );
    }),
  );

  server.registerTool(
    'undo_event',
    {
      title: 'Undo Event',
      description: 'Soft-undo an event by cid (enforces weekly expense locks when the event has cost_cents).',
      inputSchema: {
        cid: z.string().trim().min(1).max(64).describe('Event cid to undo'),
      },
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    ({ cid }) => runTool(() => {
      undoEvent(db, cid, now());
      return okResult(`Undid event ${cid}.`, { undone_cid: cid, rev: getRev(db) });
    }),
  );

  server.registerTool(
    'edit_event',
    {
      title: 'Edit Event',
      description: 'Replace lines, cost_cents, or note of an active event (enforces weekly expense locks and updates nutrition snapshots). Level purchases add containers, level eats set the open container level, and level adjustments set the exact total; older absolute level purchase events retain their original meaning when edited.',
      inputSchema: {
        cid: z.string().trim().min(1).max(64).describe('Event cid to edit'),
        lines: z.array(McpLineIn).min(1).max(60).describe('Replacement lines, each with item_id or item (name). For level items, buy qty adds containers, eat qty sets the open container level, and adjust qty sets the exact total count.'),
        cost_cents: EventPatch.shape.cost_cents.describe('Updated total cost_cents'),
        note: EventPatch.shape.note.describe('Updated note'),
      },
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    (args) => runTool(async () => {
      const owner = get<{ user_id: number }>(db, 'SELECT user_id FROM events WHERE cid = ?', args.cid);
      const lines = resolveLines(db, 'lines', args.lines, owner?.user_id ?? null);
      requireActiveItems(db, lines.map(l => l.item_id));
      const patch = EventPatch.parse(
        stripUndefined({
          lines,
          cost_cents: args.cost_cents,
          note: args.note,
        }),
      );
      const prevStocks = editEvent(db, args.cid, patch);
      await onLowCrossings?.(prevStocks);
      const event = hydrateEventByCid(db, args.cid)!;
      return okResult(`Edited event ${args.cid}.`, { event, rev: getRev(db) });
    }),
  );
}
