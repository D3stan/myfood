import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { beforeEach, expect, test } from 'vitest';
import { sha256 } from '../src/server/auth.ts';
import { ensureJolly, jollyId, openDb } from '../src/server/db.ts';
import type { Db } from '../src/server/db.ts';
import { createApp } from '../src/server/routes.ts';
import { nameKey } from '../src/shared/text.ts';
import type { AiResult, State } from '../src/shared/types.ts';

let app: ReturnType<typeof createApp>;
let db: Db;
let sid: string;
let answer: AiResult;
let seen: { id: number }[];

const headers = () => ({ 'X-MyFood': '1', cookie: sid });
const state = async (): Promise<State> => (await app.request('/api/state', { headers: headers() })).json();
const api = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { ...headers(), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const pizza = { note: 'Pizza margherita, Gino', kcal: 850, protein_g: 32, fat_g: 30, carbs_g: 105 };
const today = (s: State) => s.daily_nutrition.find(d => d.user_id === 1)!;

async function job(text: string): Promise<State> {
  await app.request('/api/jobs', { method: 'POST', headers: headers(), body: (() => { const fd = new FormData(); fd.append('text', text); return fd; })() });
  for (let i = 0; i < 200; i++) {
    const s = await state();
    if (s.jobs.every(j => j.status !== 'queued' && j.status !== 'running')) return s;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('job did not settle');
}

beforeEach(async () => {
  db = openDb(':memory:');
  db.prepare('INSERT INTO users(name, emoji, code_hash, created_at) VALUES (?, ?, ?, 0)').run('Alice', '🦊', sha256('aaaa-aaaa-aaaa'));
  answer = { reply: 'ok', events: [], eat_out: [pizza] };
  seen = [];
  app = createApp({ db, runAi: async input => { seen = input.context.items; return answer; }, dataDir: mkdtempSync(join(tmpdir(), 'mf-')), build: 't', webDir: '/nonexistent' });
  const r = await app.request('/api/login', { method: 'POST', headers: { 'X-MyFood': '1' }, body: JSON.stringify({ code: 'aaaa-aaaa-aaaa' }) });
  sid = r.headers.get('set-cookie')!.split(';')[0]!;
});

test('ensureJolly is idempotent and the jolly is hidden from state items and the AI catalog', async () => {
  ensureJolly(db);
  ensureJolly(db);
  expect(db.prepare("SELECT COUNT(*) AS n FROM items WHERE name_key = '__jolly__'").get()).toEqual({ n: 1 });
  expect(nameKey('Eat out')).not.toBe('__jolly__');
  const s = await state();
  expect(s.jolly_id).toBe(jollyId(db));
  expect(s.items.map(i => i.id)).not.toContain(s.jolly_id);
  await job('pizza at Gino');
  expect(seen.map(i => i.id)).not.toContain(s.jolly_id);
});

test('an AI eat_out becomes one jolly eat event that counts kcal, with nothing unpriced', async () => {
  const s = await job('pizza at Gino, large');
  expect(s.jobs[0]).toMatchObject({ status: 'done', error: null });
  expect(s.events).toHaveLength(1);
  expect(s.events[0]).toMatchObject({ kind: 'eat', source: 'ai', note: pizza.note, lines: [{ item_id: s.jolly_id, qty: -1, kcal: 850, protein_g: 32, fat_g: 30, carbs_g: 105 }] });
  expect(today(s)).toMatchObject({ kcal: 850, protein_g: 32, unpriced: 0 });
  expect(s.items).toHaveLength(0);
});

test('eat_out numbers are clamped', async () => {
  answer = { reply: 'ok', events: [], eat_out: [{ ...pizza, kcal: 9000, fat_g: 5000 }] };
  const s = await job('feast');
  expect(s.events[0]!.lines[0]).toMatchObject({ kcal: 5000, fat_g: 1000 });
});

test('an AI new item called "Eat out" is a normal item, not the jolly', async () => {
  answer = { reply: 'ok', eat_out: [], events: [{ kind: 'buy', preset_id: null, lines: [{ item_id: null, new_item: { name: 'Eat out', emoji: '🍽', category: 'other', unit: 'pc', step: 1, pack_size: 1 }, qty: 1, raw: null }] }] };
  const s = await job('x');
  await api('POST', `/api/jobs/${s.jobs[0]!.id}/apply`, { events: s.jobs[0]!.result!.events });
  const after = await state();
  const item = after.items.find(i => i.name === 'Eat out');
  expect(item?.id).not.toBe(after.jolly_id);
  expect(db.prepare('SELECT archived_at FROM items WHERE id = ?').get(after.jolly_id)).toEqual({ archived_at: expect.any(Number) });
});

test('only eat lines may use the jolly', async () => {
  const { jolly_id } = await state();
  for (const kind of ['buy', 'adjust']) {
    expect((await api('POST', '/api/events', { cid: `bad-${kind}-1`, at: 1, kind, lines: [{ item_id: jolly_id, qty: 1 }] })).status).toBe(400);
  }
  expect((await api('POST', '/api/events', { cid: 'ok-eat-001', at: 1, kind: 'eat', lines: [{ item_id: jolly_id, qty: 1 }] })).status).toBe(200);
});

test('undo removes the eat-out from the day totals', async () => {
  const s = await job('pizza');
  const cid = s.events[0]!.cid;
  expect(today(s).kcal).toBe(850);
  const after: State = await (await api('DELETE', `/api/events/${cid}`)).json();
  expect(after.events).toHaveLength(0);
  expect(after.daily_nutrition.find(d => d.user_id === 1)?.kcal ?? 0).toBe(0);
});

test('REST: a jolly eat with kcal counts it, and editing keeps the kcal', async () => {
  const { jolly_id } = await state();
  const line = { item_id: jolly_id, qty: 1, kcal: 600, protein_g: 20 };
  await api('POST', '/api/events', { cid: 'rest-eat-01', at: Date.now(), kind: 'eat', note: 'Burger', lines: [line] });
  expect(today(await state())).toMatchObject({ kcal: 600, protein_g: 20, unpriced: 0 });
  const r = await api('PATCH', '/api/events/rest-eat-01', { lines: [{ ...line, kcal: 700 }] });
  expect(r.status).toBe(200);
  expect(today(await state())).toMatchObject({ kcal: 700, protein_g: 20, unpriced: 0 });
  // An edit that only changes the note (lines resent without the estimate) keeps the numbers.
  await api('PATCH', '/api/events/rest-eat-01', { lines: [{ item_id: jolly_id, qty: 1 }], note: 'Big burger' });
  expect(today(await state())).toMatchObject({ kcal: 700, protein_g: 20 });
});

test('MCP: log_eat_out makes one eat event; edit_event keeps it; log_event buy on the jolly is rejected', async () => {
  const secret = 'eat-out-secret-0123456789abcdef';
  const mcp = createApp({ db, runAi: async () => ({ reply: 'ok', events: [] }), dataDir: mkdtempSync(join(tmpdir(), 'mf-')), build: 't', webDir: '/nonexistent', mcpSecret: secret });
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: async (input, init) => { const r = input instanceof Request ? input : new Request(input, init); const u = new URL(r.url); return mcp.request(u.pathname + u.search, r); },
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  }));
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const r = await call('log_eat_out', { note: pizza.note, kcal: 850, protein_g: 32 });
  expect(r.isError).not.toBe(true);
  const { event } = r.structuredContent as { event: { cid: string } };
  const s = await state();
  expect(s.events).toHaveLength(1);
  expect(s.events[0]).toMatchObject({ kind: 'eat', note: pizza.note, lines: [{ item_id: s.jolly_id, kcal: 850, protein_g: 32 }] });
  expect(today(s)).toMatchObject({ kcal: 850, unpriced: 0 });
  expect((await call('edit_event', { cid: event.cid, note: 'Pizza, large', lines: [{ item_id: s.jolly_id, qty: 1, kcal: 1000 }] })).isError).not.toBe(true);
  expect(today(await state()).kcal).toBe(1000);
  expect((await call('log_event', { kind: 'buy', lines: [{ item_id: s.jolly_id, qty: 1 }] })).isError).toBe(true);
  expect((await call('log_eat_out', { note: 'x', kcal: 9000 })).isError).toBe(true);
});
