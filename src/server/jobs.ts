import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AiResult } from '../shared/types.ts';
import type { AiContext, AiEvent, AiInput, NewItem } from '../shared/types.ts';
import { shown, toLines } from '../shared/stock.ts';
import { aliasKey, nameKey } from '../shared/text.ts';
import type { Db } from './db.ts';
import { all, bumpRev, get, run, transaction } from './db.ts';
import { allStock, fail, insertEvent, listPresets, unitOf } from './domain.ts';

export type RunAi = (input: AiInput) => Promise<AiResult>;
export interface JobFile { bytes: Uint8Array; ext: string }

interface JobRow { id: number; user_id: number; text: string; images: string; status: string; result: string | null; dismissed_at: number | null }

const MAX_UNFINISHED = 3;
const RESTARTED = 'The server restarted, please try again.';

/** "2026-11-15 08:10 Sunday" in the server's time zone. */
export function localNow(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${d.toLocaleDateString('en-GB', { weekday: 'long' })}`;
}

export function createJobs(deps: { db: Db; runAi: RunAi; jobsDir: string; now: () => number }) {
  const { db, runAi, jobsDir, now } = deps;
  const ai: { ready: boolean | null } = { ready: null };
  const folder = (id: number) => join(jobsDir, String(id));
  const removeFolder = (id: number) => rmSync(folder(id), { recursive: true, force: true });
  const row = (id: number) => get<JobRow>(db, 'SELECT id, user_id, text, images, status, result, dismissed_at FROM jobs WHERE id = ?', id);

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

  /** Throws a 400 for anything the AI or the review sheet could send that is not safe to apply. Returns the events with a bad preset_id nulled. */
  function check(userId: number, events: AiEvent[]): AiEvent[] {
    return events.map(ev => {
      for (const l of ev.lines) {
        if ((l.item_id === null) === (l.new_item === null)) fail(400, 'Each line needs either an existing item or a new item');
        if (l.item_id !== null && !unitOf(db, l.item_id)) fail(400, `A line points at an item that is not in the pantry (id ${l.item_id})`);
      }
      const ok = ev.preset_id !== null && get(db, 'SELECT 1 FROM presets WHERE id = ? AND user_id = ?', ev.preset_id, userId);
      return { ...ev, preset_id: ok ? ev.preset_id : null };
    });
  }

  function context(job: JobRow, hasImages: boolean): AiContext {
    const stock = allStock(db);
    return {
      items: all<{ id: number; name: string; unit: AiContext['items'][number]['unit']; pack_size: number }>(db,
        'SELECT id, name, unit, pack_size FROM items WHERE archived_at IS NULL ORDER BY id')
        .map(i => (hasImages ? i : { ...i, stock: shown(stock.get(i.id) ?? 0) })),
      presets: listPresets(db, job.user_id).map(p => ({ id: p.id, name: p.name, lines: p.lines })),
      aliases: hasImages ? all<{ text: string; item_id: number }>(db,
        `SELECT a.text, a.item_id FROM aliases a JOIN items i ON i.id = a.item_id
         WHERE i.archived_at IS NULL ORDER BY a.rowid DESC LIMIT 300`) : [],
      now: localNow(now()),
    };
  }

  function newItemId(n: NewItem): number {
    const key = nameKey(n.name);
    const old = get<{ id: number }>(db, 'SELECT id FROM items WHERE name_key = ?', key);
    if (old) {
      run(db, 'UPDATE items SET archived_at = NULL WHERE id = ?', old.id);
      return old.id;
    }
    return Number(run(db, 'INSERT INTO items(name, name_key, emoji, category, unit, step, pack_size, low_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)',
      n.name, key, n.emoji, n.category, n.unit, n.step, n.pack_size, now()).lastInsertRowid);
  }

  /** One transaction: items, events, aliases, job status. The caller has checked the job is in `review` (or running). */
  function applyEvents(job: JobRow, events: AiEvent[], result: AiResult | null): void {
    const hasImages = JSON.parse(job.images).length > 0;
    transaction(db, () => {
      const out: string[] = [];
      events.forEach((ev, index) => {
        const lines = ev.lines.map(l => {
          const item_id = l.item_id ?? newItemId(l.new_item!);
          const key = l.raw ? aliasKey(l.raw) : '';
          if (hasImages && key) run(db, 'INSERT OR REPLACE INTO aliases(text, item_id) VALUES (?, ?)', key, item_id);
          return { item_id, qty: l.qty };
        });
        const stored = toLines({ kind: ev.kind, lines }, id => unitOf(db, id)).filter(l => l.is_set || l.qty !== 0);
        if (!stored.length) return;
        const cid = `job-${job.id}-${index}`;
        insertEvent(db, {
          cid, userId: job.user_id, at: now(), kind: ev.kind, source: hasImages ? 'receipt' : 'ai',
          note: job.text.trim().slice(0, 200) || null, presetId: ev.preset_id, jobId: job.id, lines: stored,
        });
        out.push(cid);
      });
      run(db, "UPDATE jobs SET status = 'done', result = COALESCE(?, result), event_cids = ?, finished_at = ? WHERE id = ?",
        result ? JSON.stringify(result) : null, JSON.stringify(out), now(), job.id);
      bumpRev(db);
    });
    removeFolder(job.id);
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
        raw = await runAi({ text: job.text, images: names.map(n => join(dir, n)), dir, context: context(job, names.length > 0) });
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
      try { events = check(job.user_id, parsed.data.events); }
      catch (e) { return failJob(id, `The AI gave an answer that does not fit the pantry: ${(e as Error).message}`); }
      const result = { ...parsed.data, events };
      if (names.length || events.some(ev => ev.lines.some(l => l.new_item))) {
        transaction(db, () => {
          run(db, "UPDATE jobs SET status = 'review', result = ? WHERE id = ?", JSON.stringify(result), id);
          bumpRev(db);
        });
      } else applyEvents(job, events, result);
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

    submit(userId: number, text: string, files: JobFile[]): void {
      if (text.length > 2000) fail(400, 'The message is too long (2000 characters at most)');
      if (!text && !files.length) fail(400, 'Write something or add a photo');
      const open = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND status IN ('queued', 'running')", userId)!.n;
      if (open >= MAX_UNFINISHED) fail(429, 'Three jobs are already running, wait for one to finish');
      const id = transaction(db, () => {
        const jobId = Number(run(db, "INSERT INTO jobs(user_id, text, status, created_at) VALUES (?, ?, 'queued', ?)", userId, text, now()).lastInsertRowid);
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
    apply(userId: number, id: number, events: AiEvent[]): void {
      const job = row(id);
      if (!job || job.user_id !== userId || job.dismissed_at) fail(404, 'No such job');
      if (job!.status !== 'review') return;
      applyEvents(job!, check(userId, events), null);
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
