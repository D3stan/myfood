import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addDays, isoDate } from '../shared/dates.ts';
import { shown, toLines } from '../shared/stock.ts';
import { aliasKey, nameKey } from '../shared/text.ts';
import { AiResult, JOB_MODES } from '../shared/types.ts';
import type {
  AiContext,
  AiContextItem,
  AiCook,
  AiEvent,
  AiInput,
  AiLine,
  CookBody,
  JobMode,
  LineIn,
  NewItem,
  Source,
  Unit,
} from '../shared/types.ts';
import type { Db } from './db.ts';
import { all, bumpRev, get, run, transaction } from './db.ts';
import {
  allStock,
  applyCookBatch,
  applyPurchasedLineMeta,
  assertPeriodUnlocked,
  fail,
  insertEvent,
  listPresets,
  notifyLowCrossings,
  unitOf,
} from './domain.ts';
import type { PushSender } from './domain.ts';

export type RunAi = (input: AiInput) => Promise<AiResult>;
export interface JobFile { bytes: Uint8Array; ext: string }
export interface JobsDeps {
  db: Db;
  runAi: RunAi;
  jobsDir: string;
  now: () => number;
  sendPush?: PushSender;
}
export interface ShortcutAiDeps {
  runAi: RunAi;
  jobsDir: string;
  now: () => number;
  sendPush?: PushSender;
}

interface JobRow {
  id: number;
  user_id: number;
  mode: JobMode;
  text: string;
  images: string;
  status: string;
  result: string | null;
  dismissed_at: number | null;
}

interface ItemMetaRow {
  id: number;
  name: string;
  unit: Unit;
  portion_g: number | null;
}

const MAX_UNFINISHED = 3;
const RESTARTED = 'The server restarted, please try again.';
const roundQty = (n: number): number => Math.round(n * 1000) / 1000;

/** "2026-11-15 08:10 Sunday" in the server's time zone. */
export function localNow(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${d.toLocaleDateString('en-GB', { weekday: 'long' })}`;
}

function itemMeta(db: Db, id: number): ItemMetaRow | undefined {
  return get<ItemMetaRow>(db, 'SELECT id, name, unit, portion_g FROM items WHERE id = ? AND archived_at IS NULL', id);
}

/** Converts an AiLine quantity to the target item's stored unit, rejecting incompatible unit mismatches. */
function resolveLineQty(line: AiLine, target: { name: string; unit: Unit; portion_g: number | null }): number {
  if (line.unit == null || line.unit === target.unit) return line.qty;
  if (line.unit === 'portion' && target.unit === 'g' && target.portion_g != null && target.portion_g > 0) {
    return roundQty(line.qty * target.portion_g);
  }
  fail(400, `Incompatible unit "${line.unit}" for ${target.name} (${target.unit})`);
}

/** Validates AI events and cook batches before saving for review or applying. */
function validateProposal(db: Db, userId: number, events: AiEvent[], cook: AiCook[] = []): AiEvent[] {
  const checkedEvents = events.map((ev) => {
    for (const l of ev.lines) {
      if ((l.item_id === null) === (l.new_item === null)) fail(400, 'Each line needs either an existing item or a new item');
      if (l.item_id !== null) {
        const info = itemMeta(db, l.item_id);
        if (!info) fail(400, `A line points at an item that is not in the pantry (id ${l.item_id})`);
        resolveLineQty(l, info);
      } else {
        resolveLineQty(l, { name: l.new_item!.name, unit: l.new_item!.unit, portion_g: null });
      }
    }
    const ok = ev.preset_id !== null && get(db, 'SELECT 1 FROM presets WHERE id = ? AND user_id = ?', ev.preset_id, userId);
    return { ...ev, preset_id: ok ? ev.preset_id : null };
  });

  for (const c of cook) {
    if (c.portions === null && c.total_g === null) fail(400, 'Cooked meal needs portions or grams');
    if (c.meal_item_id !== null) {
      if (!unitOf(db, c.meal_item_id)) fail(400, `Cooked meal points at an item that is not in the pantry (id ${c.meal_item_id})`);
    } else if (!c.name) {
      fail(400, 'New cooked meal needs a name');
    }
    for (const ing of c.ingredients) {
      if (!unitOf(db, ing.item_id)) fail(400, `Cook ingredient points at an item that is not in the pantry (id ${ing.item_id})`);
    }
  }

  return checkedEvents;
}

function buildContext(db: Db, userId: number, mode: JobMode, hasImages: boolean, nowMs: number): AiContext {
  const stock = allStock(db);
  const includeStock = mode === 'audit' || (!hasImages && mode !== 'receipt');
  const includeExpiry = mode === 'audit' || (!hasImages && mode !== 'receipt');
  const includeAliases = mode === 'receipt' || (hasImages && mode !== 'audit');

  const rows = all<{
    id: number;
    name: string;
    unit: Unit;
    pack_size: number;
    owner_id: number | null;
    is_cooked: number;
    portion_g: number | null;
    expires_at: string | null;
  }>(
    db,
    'SELECT id, name, unit, pack_size, owner_id, is_cooked, portion_g, expires_at FROM items WHERE archived_at IS NULL ORDER BY id',
  );

  const items: AiContextItem[] = rows.map((r) => {
    const item: AiContextItem = { id: r.id, name: r.name, unit: r.unit, pack_size: r.pack_size };
    if (includeStock) item.stock = shown(stock.get(r.id) ?? 0);
    if (r.owner_id !== null) item.owner = r.owner_id === userId ? 'mine' : 'other';
    if (r.is_cooked) item.is_cooked = true;
    if (r.portion_g !== null) item.portion_g = r.portion_g;
    if (includeExpiry && r.expires_at !== null) item.expires_at = r.expires_at;
    return item;
  });

  return {
    mode,
    items,
    presets: listPresets(db, userId).map((p) => ({ id: p.id, name: p.name, lines: p.lines })),
    aliases: includeAliases
      ? all<{ text: string; item_id: number }>(
          db,
          `SELECT a.text, a.item_id FROM aliases a JOIN items i ON i.id = a.item_id
           WHERE i.archived_at IS NULL ORDER BY a.rowid DESC LIMIT 300`,
        )
      : [],
    now: localNow(nowMs),
  };
}

function newItemId(db: Db, n: NewItem, userId: number, nowMs: number): number {
  const key = nameKey(n.name);
  const ownerId = n.owner === 'mine' ? userId : null;
  const old = get<{ id: number }>(
    db,
    'SELECT id FROM items WHERE name_key = ? AND COALESCE(owner_id, 0) = COALESCE(?, 0)',
    key,
    ownerId,
  );
  if (old) {
    run(db, 'UPDATE items SET archived_at = NULL WHERE id = ?', old.id);
    return old.id;
  }
  const shelfLife = n.expires_in_days != null && n.expires_in_days >= 1 ? n.expires_in_days : null;
  return Number(
    run(
      db,
      `INSERT INTO items(name, name_key, emoji, category, unit, step, pack_size, low_at, owner_id, shelf_life_days, kcal_per_unit, protein_per_unit, fat_per_unit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      n.name,
      key,
      n.emoji,
      n.category,
      n.unit,
      n.step,
      n.pack_size,
      ownerId,
      shelfLife,
      n.kcal_per_unit ?? null,
      n.protein_per_unit ?? null,
      n.fat_per_unit ?? null,
      nowMs,
    ).lastInsertRowid,
  );
}

interface ApplyOpts {
  cidPrefix: string;
  source: Source;
  note: string | null;
  jobId: number | null;
  saveAliases: boolean;
  nowMs: number;
  afterTx?: (eventCids: string[], at: number) => void;
}

function applyProposalToDb(
  db: Db,
  userId: number,
  events: AiEvent[],
  cook: AiCook[],
  opts: ApplyOpts,
): { eventCids: string[]; prevStocks: Map<number, number>; at: number } {
  const at = opts.nowMs;
  const today = isoDate(at);
  return transaction(db, () => {
    const prevStocks = allStock(db);
    const eventCids: string[] = [];

    events.forEach((ev, index) => {
      const lineInputs: LineIn[] = [];
      const metaList: { itemId: number; prevStock: number; expiresAt: string | null; expiresInDays: number | null }[] = [];

      for (const l of ev.lines) {
        const itemId = l.item_id ?? newItemId(db, l.new_item!, userId, at);
        const key = l.raw ? aliasKey(l.raw) : '';
        if (opts.saveAliases && key) run(db, 'INSERT OR REPLACE INTO aliases(text, item_id) VALUES (?, ?)', key, itemId);

        const info = itemMeta(db, itemId)!;
        const qty = resolveLineQty(l, info);
        const costCents = l.price != null ? Math.round(l.price * 100) : null;
        const expDays = l.expires_in_days ?? l.new_item?.expires_in_days ?? null;
        const expiresAt = expDays != null ? addDays(today, expDays) : null;

        lineInputs.push({ item_id: itemId, qty, cost_cents: costCents, expires_at: expiresAt });
        metaList.push({ itemId, prevStock: prevStocks.get(itemId) ?? 0, expiresAt, expiresInDays: expDays });
      }

      const stored = toLines({ kind: ev.kind, lines: lineInputs }, (id) => unitOf(db, id)).filter((l) => l.is_set || l.qty !== 0);
      if (!stored.length) return;

      const lineCostSum = stored.some((l) => l.cost_cents != null)
        ? stored.reduce((sum, l) => sum + (l.cost_cents ?? 0), 0)
        : null;
      const costCents = ev.total_cost != null ? Math.round(ev.total_cost * 100) : ev.kind === 'buy' ? lineCostSum : null;
      if (costCents != null) assertPeriodUnlocked(db, at);

      const cid = `${opts.cidPrefix}-${index}`;
      insertEvent(db, {
        cid,
        userId,
        at,
        kind: ev.kind,
        source: opts.source,
        note: opts.note,
        presetId: ev.preset_id,
        jobId: opts.jobId,
        costCents,
        countsNutrition: true,
        lines: stored,
      });
      eventCids.push(cid);

      if (ev.kind === 'buy') {
        for (const m of metaList) {
          applyPurchasedLineMeta(db, m.itemId, m.prevStock, {
            expires_at: m.expiresAt,
            expires_in_days: m.expiresInDays,
            now: at,
          });
        }
      } else if (ev.kind === 'adjust') {
        for (const m of metaList) {
          if (m.expiresAt !== null) run(db, 'UPDATE items SET expires_at = ? WHERE id = ?', m.expiresAt, m.itemId);
        }
      }
    });

    cook.forEach((c, idx) => {
      const cookBody: CookBody = {
        cid: `${opts.cidPrefix}-cook-${idx}`,
        at,
        meal_item_id: c.meal_item_id,
        name: c.name,
        emoji: c.emoji,
        owner_id: c.owner === 'mine' ? userId : c.owner === 'shared' ? null : (c.meal_item_id != null ? undefined : null),
        portions: c.portions,
        total_g: c.total_g,
        expires_at: c.expires_in_days != null ? addDays(today, c.expires_in_days) : null,
        kcal_total: c.kcal_total,
        protein_total: c.protein_total,
        fat_total: c.fat_total,
        ingredients: c.ingredients,
      };
      const res = applyCookBatch(db, userId, cookBody, {
        now: at,
        source: 'cook',
        jobId: opts.jobId,
        expires_in_days: c.expires_in_days,
      });
      eventCids.push(...res.eventCids);
    });

    opts.afterTx?.(eventCids, at);
    bumpRev(db);
    return { eventCids, prevStocks, at };
  });
}

function jobSource(mode: JobMode, hasImages: boolean): Source {
  if (mode === 'audit') return 'audit';
  if (hasImages || mode === 'receipt') return 'receipt';
  return 'ai';
}

export function createJobs(deps: JobsDeps) {
  const { db, runAi, jobsDir, now, sendPush } = deps;
  const ai: { ready: boolean | null } = { ready: null };
  const folder = (id: number) => join(jobsDir, String(id));
  const removeFolder = (id: number) => rmSync(folder(id), { recursive: true, force: true });
  const row = (id: number) =>
    get<JobRow>(db, 'SELECT id, user_id, mode, text, images, status, result, dismissed_at FROM jobs WHERE id = ?', id);

  const failJob = (id: number, message: string): void => {
    transaction(db, () => {
      run(db, "UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", message, now(), id);
      bumpRev(db);
    });
    removeFolder(id);
  };

  // Jobs cannot survive a restart: their AI call is gone.
  const stuck = all<{ id: number }>(db, "SELECT id FROM jobs WHERE status IN ('queued', 'running')");
  for (const j of stuck) failJob(j.id, RESTARTED);

  /** One transaction: items, events, cook batches, aliases, job status. */
  function applyEvents(job: JobRow, events: AiEvent[], cook: AiCook[], result: AiResult | null): { prevStocks: Map<number, number>; at: number } {
    const hasImages = JSON.parse(job.images).length > 0;
    const { prevStocks, at } = applyProposalToDb(db, job.user_id, events, cook, {
      cidPrefix: `job-${job.id}`,
      source: jobSource(job.mode, hasImages),
      note: job.text.trim().slice(0, 200) || null,
      jobId: job.id,
      saveAliases: hasImages && job.mode !== 'audit',
      nowMs: now(),
      afterTx: (out, finishedAt) => {
        run(
          db,
          "UPDATE jobs SET status = 'done', result = COALESCE(?, result), event_cids = ?, finished_at = ? WHERE id = ?",
          result ? JSON.stringify(result) : null,
          JSON.stringify(out),
          finishedAt,
          job.id,
        );
      },
    });
    removeFolder(job.id);
    return { prevStocks, at };
  }

  async function runJob(id: number): Promise<void> {
    try {
      let job = row(id);
      if (!job || job.status !== 'queued') return;
      if (job.dismissed_at) return failJob(id, 'Dismissed');
      transaction(db, () => { run(db, "UPDATE jobs SET status = 'running' WHERE id = ?", id); bumpRev(db); });
      const names: string[] = JSON.parse(job.images);
      const dir = folder(id);
      let raw: AiResult;
      try {
        raw = await runAi({
          text: job.text,
          images: names.map((n) => join(dir, n)),
          dir,
          context: buildContext(db, job.user_id, job.mode, names.length > 0, now()),
        });
        ai.ready = true;
      } catch (e) {
        ai.ready = false;
        return failJob(id, e instanceof Error && e.message ? e.message : 'The AI could not answer.');
      }
      job = row(id)!;
      if (job.dismissed_at) return failJob(id, 'Dismissed');
      const parsed = AiResult.safeParse(raw);
      if (!parsed.success) return failJob(id, 'The AI gave an answer the app could not read. Please try again.');
      let events: AiEvent[];
      const cook = parsed.data.cook ?? [];
      try { events = validateProposal(db, job.user_id, parsed.data.events, cook); }
      catch (e) { return failJob(id, `The AI gave an answer that does not fit the pantry: ${(e as Error).message}`); }
      const result: AiResult = { ...parsed.data, events };
      if (names.length || events.some((ev) => ev.lines.some((l) => l.new_item))) {
        transaction(db, () => {
          run(db, "UPDATE jobs SET status = 'review', result = ? WHERE id = ?", JSON.stringify(result), id);
          bumpRev(db);
        });
      } else {
        const { prevStocks, at } = applyEvents(job, events, cook, result);
        await notifyLowCrossings(db, prevStocks, sendPush, at).catch((e) => console.error('push', e));
      }
    } catch (e) {
      console.error('job', id, e);
      try { failJob(id, 'Something went wrong on the server.'); } catch { /* the database itself is failing */ }
    }
  }

  const lanes = { images: Promise.resolve(), text: Promise.resolve() };
  const enqueue = (id: number, lane: keyof typeof lanes) => { lanes[lane] = lanes[lane].then(() => runJob(id)); };

  return {
    ai,
    /** Resolves when everything queued so far has finished. For tests. */
    idle: () => Promise.all([lanes.images, lanes.text]).then(() => undefined),

    submit(userId: number, text: string, files: JobFile[], mode: JobMode = 'auto'): void {
      if (!JOB_MODES.includes(mode)) fail(400, 'Invalid job mode');
      if (text.length > 2000) fail(400, 'The message is too long (2000 characters at most)');
      if (!text && !files.length) fail(400, 'Write something or add a photo');
      const open = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND status IN ('queued', 'running')", userId)!.n;
      if (open >= MAX_UNFINISHED) fail(429, 'Three jobs are already running, wait for one to finish');
      const id = transaction(db, () => {
        const jobId = Number(run(db, "INSERT INTO jobs(user_id, mode, text, status, created_at) VALUES (?, ?, ?, 'queued', ?)", userId, mode, text, now()).lastInsertRowid);
        bumpRev(db);
        return jobId;
      });
      try {
        const names: string[] = [];
        // Text jobs get a folder too: it is the AI process's working directory.
        mkdirSync(folder(id), { recursive: true, mode: 0o750 });
        if (files.length) {
          for (const f of files) {
            const name = `${randomBytes(12).toString('hex')}.${f.ext}`;
            writeFileSync(join(folder(id), name), f.bytes, { mode: 0o640 });
            names.push(name);
          }
          run(db, 'UPDATE jobs SET images = ? WHERE id = ?', JSON.stringify(names), id);
        }
      } catch (e) {
        console.error('job files', e);
        failJob(id, 'The photos could not be stored.');
        return;
      }
      enqueue(id, files.length ? 'images' : 'text');
    },

    /** A job that is not in review is left alone: a double tap must not apply twice. */
    apply(userId: number, id: number, events: AiEvent[], cook: AiCook[] = []): void {
      const job = row(id);
      if (!job || job.user_id !== userId || job.dismissed_at) fail(404, 'No such job');
      if (job!.status !== 'review') return;
      const checked = validateProposal(db, userId, events, cook);
      const { prevStocks, at } = applyEvents(job!, checked, cook, null);
      void notifyLowCrossings(db, prevStocks, sendPush, at).catch((e) => console.error('push', e));
    },

    dismiss(userId: number, id: number): void {
      const job = row(id);
      if (!job || job.user_id !== userId) fail(404, 'No such job');
      if (job!.dismissed_at) return;
      transaction(db, () => { run(db, 'UPDATE jobs SET dismissed_at = ? WHERE id = ?', now(), id); bumpRev(db); });
      // A running job's folder is still in use; its run removes it when it ends.
      if (job!.status !== 'running') removeFolder(id);
    },
  };
}
export type Jobs = ReturnType<typeof createJobs>;

/** Synchronously runs AI text logging for POST /api/shortcut and returns the created event seq ids. */
export async function runShortcutAi(
  db: Db,
  deps: ShortcutAiDeps,
  userId: number,
  text: string,
): Promise<{ reply: string; event_ids: number[] }> {
  const trimmed = text.trim();
  if (!trimmed) fail(400, 'Write something to log');
  if (trimmed.length > 2000) fail(400, 'The message is too long (2000 characters at most)');

  const dir = join(deps.jobsDir, `sc-${randomBytes(8).toString('hex')}`);
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  try {
    const nowMs = deps.now();
    const raw = await deps.runAi({
      text: trimmed,
      images: [],
      dir,
      context: buildContext(db, userId, 'auto', false, nowMs),
    });
    const parsed = AiResult.safeParse(raw);
    if (!parsed.success) fail(400, 'The AI gave an answer the app could not read. Please try again.');
    const cook = parsed.data.cook ?? [];
    const events = validateProposal(db, userId, parsed.data.events, cook);

    const { eventCids, prevStocks, at } = applyProposalToDb(db, userId, events, cook, {
      cidPrefix: `sc-${nowMs}-${randomBytes(4).toString('hex')}`,
      source: 'shortcut',
      note: trimmed.slice(0, 200),
      jobId: null,
      saveAliases: false,
      nowMs,
    });

    const event_ids = eventCids
      .map((cid) => get<{ seq: number }>(db, 'SELECT seq FROM events WHERE cid = ?', cid)?.seq)
      .filter((seq): seq is number => seq !== undefined);

    if (eventCids.length > 0) {
      await notifyLowCrossings(db, prevStocks, deps.sendPush, at).catch((e) => console.error('push', e));
    }
    return { reply: parsed.data.reply, event_ids };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
