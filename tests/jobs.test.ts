import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { sha256 } from '../src/server/auth.ts';
import { openDb } from '../src/server/db.ts';
import type { Db } from '../src/server/db.ts';
import { createApp } from '../src/server/routes.ts';
import type { AiInput, AiResult, State } from '../src/shared/types.ts';

let app: ReturnType<typeof createApp>;
let db: Db;
let dataDir: string;
let sid: string;
let calls: AiInput[];
let answer: (input: AiInput) => Promise<AiResult>;

const line = (item_id: number | null, qty: number, extra: object = {}) => ({ item_id, new_item: null, qty, raw: null, ...extra });
const eventOf = (kind: string, lines: object[], preset_id: number | null = null) => ({ kind, preset_id, lines });
const reply = (events: object[]) => async () => ({ reply: 'ok', events }) as AiResult;
const butter = { name: 'Butter', emoji: '🧈', category: 'dairy', unit: 'g', step: 10, pack_size: 250 };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const headers = () => ({ 'X-MyFood': '1', cookie: sid });
async function state(): Promise<State> { return (await app.request('/api/state', { headers: headers() })).json(); }
async function api(method: string, path: string, body?: unknown) {
  return app.request(path, { method, headers: { ...headers(), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function submit(text: string, images = 0) {
  const fd = new FormData();
  fd.append('text', text);
  for (let i = 0; i < images; i++) fd.append('images', new File([PNG], `r${i}.png`, { type: 'image/png' }));
  return app.request('/api/jobs', { method: 'POST', headers: headers(), body: fd });
}
/** Waits until no job is queued or running. */
async function settle(): Promise<State> {
  for (let i = 0; i < 200; i++) {
    const s = await state();
    if (s.jobs.every(j => j.status !== 'queued' && j.status !== 'running')) return s;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('jobs did not settle');
}
const eggsId = (s: State) => s.items.find(i => i.name === 'Eggs')!.id;

beforeEach(async () => {
  db = openDb(':memory:');
  db.prepare('INSERT INTO users(name, emoji, code_hash, created_at) VALUES (?, ?, ?, 0)').run('Alice', '🦊', sha256('aaaa-aaaa-aaaa'));
  db.prepare('INSERT INTO users(name, emoji, code_hash, created_at) VALUES (?, ?, ?, 0)').run('Bob', '🐻', sha256('bbbb-bbbb-bbbb'));
  dataDir = mkdtempSync(join(tmpdir(), 'mf-'));
  calls = [];
  answer = reply([]);
  app = createApp({ db, runAi: input => { calls.push(input); return answer(input); }, dataDir, build: 't', webDir: '/nonexistent' });
  const r = await app.request('/api/login', { method: 'POST', headers: { 'X-MyFood': '1' }, body: JSON.stringify({ code: 'aaaa-aaaa-aaaa' }) });
  sid = r.headers.get('set-cookie')!.split(';')[0]!;
  await api('POST', '/api/items', { name: 'Eggs', emoji: '🥚', category: 'dairy', unit: 'pc', step: 1, pack_size: 10, low_at: 3 });
});

test('a text job with known items applies at once and the context is built', async () => {
  const eggs = eggsId(await state());
  await api('POST', '/api/events', { cid: 'seed-0001', at: 1, kind: 'buy', lines: [{ item_id: eggs, qty: 10 }] });
  await api('POST', '/api/presets', { name: 'B', emoji: '🍳', hour: 8, lines: [{ item_id: eggs, qty: 3 }] });
  answer = reply([eventOf('eat', [line(eggs, 3)])]);
  expect((await submit('had breakfast')).status).toBe(200);
  const s = await settle();
  expect(s.jobs[0]).toMatchObject({ status: 'done', text: 'had breakfast', has_images: false, error: null, event_cids: [`job-${s.jobs[0]!.id}-0`] });
  expect(s.items[0]!.stock).toBe(7);
  expect(s.events[0]).toMatchObject({ source: 'ai', note: 'had breakfast', kind: 'eat' });
  expect(s.ai.ready).toBe(true);
  const ctx = calls[0]!.context;
  expect(ctx.items).toEqual([{ id: eggs, name: 'Eggs', unit: 'pc', pack_size: 10, stock: 10 }]);
  expect(ctx.presets).toHaveLength(1);
  expect(ctx.aliases).toEqual([]);
  expect(ctx.now).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d \w+day$/);
  expect(calls[0]!.images).toEqual([]);
});

test('a result with a new item stops at review and applies nothing', async () => {
  answer = reply([eventOf('buy', [line(null, 250, { new_item: butter })])]);
  await submit('bought butter');
  const s = await settle();
  expect(s.jobs[0]!.status).toBe('review');
  expect(s.jobs[0]!.result!.events).toHaveLength(1);
  expect(s.items.map(i => i.name)).toEqual(['Eggs']);
  expect(s.events).toEqual([]);
});

test('an image job stops at review; apply creates items, events and aliases once, a second apply is a no-op', async () => {
  const eggs = eggsId(await state());
  answer = reply([eventOf('buy', [line(eggs, 10, { raw: 'ØKO ÆG 10 STK' }), line(null, 250, { new_item: butter, raw: 'LURPAK SMØR 250G' }), line(eggs, 0)])]);
  expect((await submit('REMA', 2)).status).toBe(200);
  let s = await settle();
  const job = s.jobs[0]!;
  expect(job).toMatchObject({ status: 'review', has_images: true });
  expect(calls[0]!.images).toHaveLength(2);
  expect(calls[0]!.context.items[0]).not.toHaveProperty('stock');
  const folder = join(dataDir, 'jobs', String(job.id));
  expect(readdirSync(folder).every(f => /^[0-9a-f]{24}\.png$/.test(f))).toBe(true);

  const body = { events: job.result!.events };
  s = await (await api('POST', `/api/jobs/${job.id}/apply`, body)).json();
  const done = s.jobs[0]!;
  expect(done.status).toBe('done');
  expect(done.event_cids).toEqual([`job-${job.id}-0`]);
  const stockOf = (n: string) => s.items.find(i => i.name === n)!.stock;
  expect(stockOf('Eggs')).toBe(10);
  expect(stockOf('Butter')).toBe(250);
  expect(s.events[0]).toMatchObject({ source: 'receipt', note: 'REMA' });
  expect(s.events[0]!.lines).toHaveLength(2); // the qty 0 buy line is skipped
  expect(existsSync(folder)).toBe(false);
  expect(db.prepare('SELECT text FROM aliases ORDER BY text').all()).toEqual([{ text: 'lurpak smør 250g' }, { text: 'øko æg 10 stk' }]);

  const rev = s.rev;
  s = await (await api('POST', `/api/jobs/${job.id}/apply`, body)).json();
  expect(s.rev).toBe(rev);
  expect(s.events).toHaveLength(1);
  expect(stockOf('Eggs')).toBe(10);

  // the next receipt sees the aliases
  answer = reply([]);
  await submit('', 1);
  await settle();
  expect(calls[1]!.context.aliases).toHaveLength(2);
});

test('apply reuses an existing item with the same name and takes edited events', async () => {
  const eggs = eggsId(await state());
  answer = reply([eventOf('buy', [line(null, 6, { new_item: { ...butter, name: ' eggs ', unit: 'pc' } })])]);
  await submit('', 1);
  const job = (await settle()).jobs[0]!;
  const edited = { events: [eventOf('adjust', [line(eggs, 4)])] };
  const s: State = await (await api('POST', `/api/jobs/${job.id}/apply`, edited)).json();
  expect(s.items).toHaveLength(1);
  expect(s.items[0]!.stock).toBe(4);
  expect((await api('POST', `/api/jobs/${job.id}/apply`, { events: [eventOf('buy', [line(777, 1)])] })).status).toBe(200); // already done: ignored
});

test('apply refuses unknown items and lines that are neither item nor new item', async () => {
  answer = reply([eventOf('buy', [line(null, 250, { new_item: butter })])]);
  await submit('x');
  const job = (await settle()).jobs[0]!;
  expect((await api('POST', `/api/jobs/${job.id}/apply`, { events: [eventOf('buy', [line(777, 1)])] })).status).toBe(400);
  expect((await api('POST', `/api/jobs/${job.id}/apply`, { events: [eventOf('buy', [line(null, 1)])] })).status).toBe(400);
  expect((await state()).jobs[0]!.status).toBe('review');
  expect((await api('POST', '/api/jobs/999/apply', { events: [eventOf('buy', [line(1, 1)])] })).status).toBe(404);
});

test('an unknown item id fails the job with a readable error', async () => {
  answer = reply([eventOf('eat', [line(777, 1)])]);
  await submit('ate something');
  const j = (await settle()).jobs[0]!;
  expect(j.status).toBe('failed');
  expect(j.error).toContain('777');
});

test('a line with both item_id and new_item, or an unreadable result, fails the job', async () => {
  const eggs = eggsId(await state());
  answer = reply([eventOf('buy', [line(eggs, 1, { new_item: butter })])]);
  await submit('a');
  expect((await settle()).jobs[0]!.status).toBe('failed');
  answer = async () => ({ nonsense: true }) as unknown as AiResult;
  await submit('b');
  const j = (await settle()).jobs[0]!;
  expect(j).toMatchObject({ status: 'failed' });
  expect(j.error).toContain('could not read');
});

test('a foreign preset_id is nulled', async () => {
  const eggs = eggsId(await state());
  db.prepare("INSERT INTO presets(user_id, name, emoji, hour) VALUES (2, 'Bobs', 'x', 1)").run();
  answer = reply([eventOf('eat', [line(eggs, 1)], 1)]);
  await submit('a');
  const s = await settle();
  expect(s.jobs[0]!.status).toBe('done');
  expect(s.events[0]!.preset_id).toBeNull();
});

test('runAi throwing fails the job with its message and flips ai.ready', async () => {
  answer = async () => { throw new Error('agy is not logged in'); };
  await submit('hi', 0);
  const s = await settle();
  expect(s.jobs[0]).toMatchObject({ status: 'failed', error: 'agy is not logged in' });
  expect(s.ai.ready).toBe(false);
  expect(await (await app.request('/api/health')).json()).toEqual({ ok: true, build: 't', ai: false });
  answer = reply([]);
  await submit('again');
  expect((await settle()).ai.ready).toBe(true);
});

test('failed image jobs delete their folder', async () => {
  answer = async () => { throw new Error('nope'); };
  await submit('', 1);
  const s = await settle();
  expect(existsSync(join(dataDir, 'jobs', String(s.jobs[0]!.id)))).toBe(false);
});

test('dismissing a running job prevents apply; dismissing frees the folder of a review job', async () => {
  const eggs = eggsId(await state());
  let release!: () => void;
  answer = () => new Promise(res => { release = () => res({ reply: 'ok', events: [eventOf('buy', [line(eggs, 5)])] } as AiResult); });
  await submit('buy eggs');
  for (let i = 0; i < 100 && !release; i++) await new Promise(r => setTimeout(r, 5));
  let s = await state();
  expect(s.jobs[0]!.status).toBe('running');
  const id = s.jobs[0]!.id;
  s = await (await api('DELETE', `/api/jobs/${id}`)).json();
  expect(s.jobs).toEqual([]);
  release();
  await new Promise(r => setTimeout(r, 30));
  s = await state();
  expect(s.events).toEqual([]);
  expect(s.items[0]!.stock).toBe(0);
  expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(id)).toEqual({ status: 'failed' });

  answer = reply([eventOf('buy', [line(null, 1, { new_item: butter })])]);
  await submit('', 1);
  const review = (await settle()).jobs[0]!;
  await api('DELETE', `/api/jobs/${review.id}`);
  expect(existsSync(join(dataDir, 'jobs', String(review.id)))).toBe(false);
  expect((await api('POST', `/api/jobs/${review.id}/apply`, { events: review.result!.events })).status).toBe(404);
});

test('at most three unfinished jobs per user', async () => {
  const gates: (() => void)[] = [];
  answer = () => new Promise(res => gates.push(() => res({ reply: 'ok', events: [] })));
  for (let i = 0; i < 3; i++) expect((await submit(`job ${i}`)).status).toBe(200);
  const r = await submit('one more');
  expect(r.status).toBe(429);
  expect((await r.json()).error).toBeTruthy();
  // text jobs run one at a time
  await new Promise(r => setTimeout(r, 20));
  expect(gates).toHaveLength(1);
  while (gates.length < 3) { gates[gates.length - 1]!(); await new Promise(r => setTimeout(r, 10)); }
  gates[2]!();
  await settle();
  expect((await submit('now fine')).status).toBe(200);
  while (!gates[3]) await new Promise(r => setTimeout(r, 5));
  gates[3]();
  await settle();
});

test('an image job does not wait behind a text job (two lanes)', async () => {
  let releaseText!: () => void;
  answer = input => input.images.length ? Promise.resolve({ reply: 'seen', events: [] }) : new Promise(res => { releaseText = () => res({ reply: 'ok', events: [] }); });
  await submit('slow text');
  await submit('', 1);
  for (let i = 0; i < 100; i++) {
    const s = await state();
    if (s.jobs.find(j => j.has_images)?.status === 'review') break;
    await new Promise(r => setTimeout(r, 5));
  }
  const s = await state();
  expect(s.jobs.find(j => j.has_images)!.status).toBe('review');
  expect(s.jobs.find(j => !j.has_images)!.status).toBe('running');
  releaseText();
  await settle();
});

test('upload validation', async () => {
  expect((await submit('')).status).toBe(400);
  expect((await submit('x'.repeat(2001))).status).toBe(400);
  expect((await submit('x', 5)).status).toBe(400);
  const bad = (name: string, type: string, bytes: Uint8Array<ArrayBuffer>) => {
    const fd = new FormData();
    fd.append('images', new File([bytes], name, { type }));
    return app.request('/api/jobs', { method: 'POST', headers: headers(), body: fd });
  };
  expect((await bad('a.gif', 'image/gif', PNG)).status).toBe(400);
  expect((await bad('a.png', 'image/png', new Uint8Array([1, 2, 3, 4]))).status).toBe(400);
  expect((await bad('big.png', 'image/png', new Uint8Array(8 * 1024 * 1024 + 1).fill(0).map((_, i) => (i < 4 ? PNG[i]! : 0)))).status).toBe(400);
  expect((await api('POST', '/api/jobs', { text: 'json' })).status).toBe(400);
  expect((await state()).jobs).toEqual([]);
});

test('jobs left queued or running by a restart are failed at start-up', async () => {
  db.prepare("INSERT INTO jobs(user_id, text, status, created_at) VALUES (1, 'old', 'running', 1)").run();
  db.prepare("INSERT INTO jobs(user_id, text, status, created_at) VALUES (1, 'older', 'queued', 1)").run();
  app = createApp({ db, runAi: async () => ({ reply: '', events: [] }), dataDir, build: 't', webDir: '/nonexistent' });
  const s = await state();
  expect(s.jobs.map(j => [j.status, j.error])).toEqual([['failed', 'The server restarted, please try again.'], ['failed', 'The server restarted, please try again.']]);
});

test('users only see and touch their own jobs', async () => {
  answer = reply([eventOf('buy', [line(null, 1, { new_item: butter })])]);
  await submit('mine');
  const job = (await settle()).jobs[0]!;
  const bob = (await app.request('/api/login', { method: 'POST', headers: { 'X-MyFood': '1' }, body: JSON.stringify({ code: 'bbbb-bbbb-bbbb' }) })).headers.get('set-cookie')!.split(';')[0]!;
  const asBob = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'X-MyFood': '1', cookie: bob, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(((await (await asBob('GET', '/api/state')).json()) as State).jobs).toEqual([]);
  expect((await asBob('POST', `/api/jobs/${job.id}/apply`, { events: job.result!.events })).status).toBe(404);
  expect((await asBob('DELETE', `/api/jobs/${job.id}`)).status).toBe(404);
});

test('a text job gets a working folder for the AI process, removed afterwards', async () => {
  let existed = false;
  answer = async (input) => { existed = existsSync(input.dir); return { reply: 'ok', events: [] }; };
  await submit('nothing to log');
  await settle();
  expect(existed).toBe(true);
  expect(readdirSync(join(dataDir, 'jobs'))).toEqual([]);
});
