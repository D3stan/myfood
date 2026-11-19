import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { sha256 } from '../src/server/auth.ts';
import { all, get, getMeta, migrate, openDb } from '../src/server/db.ts';
import type { Db } from '../src/server/db.ts';
import { buildPlan } from '../src/server/deals/plan.ts';
import { checkDealsSync, dealsSlot } from '../src/server/deals/sync.ts';
import { checkDealsPushes, subscribePush } from '../src/server/push.ts';
import type { PushPayload, PushSender } from '../src/server/push.ts';
import { createApp } from '../src/server/routes.ts';
import type { DealsPlan, State } from '../src/shared/types.ts';

const at = (d: number, h = 12, m = 0) => new Date(2026, 10, d, h, m).getTime();
const NOW = at(19); // Thu 2026-11-19, 12:00 local
let ext = 0;

let db: Db;
let clock: number;
let pushed: { endpoint: string; payload: PushPayload }[];
let app: ReturnType<typeof createApp>;
let cookie: string;
const SECRET = 'plan-test-secret-0123456789abcdef';
const sendPush: PushSender = async (sub, payload) => { pushed.push({ endpoint: sub.endpoint, payload }); };

const item = (id: number, name: string, lowAt: number | null = 200, costPerUnit = 2) =>
  db.prepare(`INSERT INTO items(id, name, name_key, emoji, category, unit, step, pack_size, low_at, cost_per_unit_cents, created_at) VALUES (?, ?, ?, '🥛', 'dairy', 'ml', 1, 1000, ?, ?, 0)`).run(id, name, name, lowAt, costPerUnit);
/** An offer matched to `itemId`; 1000 ml per pack, so price 1000 = 1 cent/ml. */
function offer(itemId: number, o: { key?: string; store?: string; price?: number; from?: string; to?: string; cur?: string } = {}) {
  const key = o.key ?? `offer ${++ext}`;
  db.prepare(`INSERT INTO offers(store_id, source, external_id, title, offer_key, price_cents, currency, unit, unit_qty, valid_from, valid_to, fetched_at) VALUES (?, 'tjek', ?, ?, ?, ?, ?, 'ml', 1000, ?, ?, 0)`)
    .run(o.store ?? 'netto-dk', `x${++ext}`, `Title ${key}`, key, o.price ?? 1000, o.cur ?? 'DKK', o.from ?? '2026-11-14', o.to ?? '2026-11-27');
  db.prepare('INSERT OR REPLACE INTO offer_matches(offer_key, item_id, qty_per_pack, confidence, source, updated_at) VALUES (?, ?, 1000, 1, ?, 0)').run(key, itemId, 'manual');
}
const req = (method: string, path: string, body?: unknown) => app.request(path, {
  method, headers: { 'X-MyFood': '1', cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});
const logBuy = async (itemId: number, qty: number, cid: string) => { const r = await req('POST', '/api/events', { cid, at: clock - 1000, kind: 'buy', lines: [{ item_id: itemId, qty }] }); expect(r.status, await r.clone().text()).toBe(200); };
const plan = async () => (await (await req('GET', '/api/deals/plan')).json()) as DealsPlan;

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  clock = NOW;
  db = openDb(':memory:');
  db.prepare('INSERT INTO users(name, emoji, code_hash, created_at) VALUES (?, ?, ?, 0)').run('Alice', '🦊', sha256('aaaa-aaaa-aaaa'));
  pushed = [];
  app = createApp({
    db, runAi: async () => ({ reply: 'ok', events: [] }), dataDir: mkdtempSync(join(tmpdir(), 'mf-plan-')), build: 't', webDir: '/nonexistent',
    now: () => clock, sendPush, mcpSecret: SECRET, fetch: (async () => new Response('[]')) as typeof fetch,
  });
  const login = await app.request('/api/login', { method: 'POST', headers: { 'X-MyFood': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'aaaa-aaaa-aaaa' }) });
  cookie = login.headers.get('set-cookie')!.split(';')[0]!;
});
afterEach(() => vi.restoreAllMocks());

describe('buildPlan', () => {
  test('a low item with a live offer gets a trip today; the summary reaches /api/state', async () => {
    item(1, 'Milk');
    offer(1);
    const p = await plan();
    expect(p.today).toBe('2026-11-19');
    expect(p.trips).toHaveLength(1);
    expect(p.trips[0]).toMatchObject({ date: '2026-11-19', store_id: 'netto-dk', store_name: 'Netto', saving_cents: 1000 }); // 1000 ml x (2 - 1)
    expect(p.trips[0]!.items[0]).toMatchObject({ item_id: 1, packs: 1, unit_cents: 1, offer_title: expect.stringContaining('Title'), qty_per_pack: 1000, price_cents: 1000 });
    expect(p.total_saving_cents).toBe(1000);
    expect(p.items[0]).toMatchObject({ item_id: 1, packs: 1, on_trip: true, pct_off: 50, rate: null });
    const st = (await (await req('GET', '/api/state')).json()) as State;
    expect(st.deals_summary).toMatchObject({ date: '2026-11-19', store_name: 'Netto', saving_cents: 1000, deal_count: 1 });
  });

  test('the trip item carries the pack of the lowest unit price, not the lowest pack price', async () => {
    item(1, 'Milk');
    offer(1, { key: 'big', price: 1500 }); // 1000 ml for 15 kr = 1.5/ml
    db.prepare(`INSERT INTO offers(store_id, source, external_id, title, offer_key, price_cents, currency, unit, unit_qty, valid_from, valid_to, fetched_at) VALUES ('netto-dk', 'tjek', 'small', 'Small', 'small', 1000, 'DKK', 'ml', 500, '2026-11-14', '2026-11-27', 0)`).run();
    db.prepare("INSERT INTO offer_matches(offer_key, item_id, qty_per_pack, confidence, source, updated_at) VALUES ('small', 1, 500, 1, 'manual', 0)").run(); // 500 ml for 10 kr = 2/ml
    const t = (await plan()).trips[0]!.items[0]!;
    expect(t).toMatchObject({ unit_cents: 1.5, qty_per_pack: 1000, price_cents: 1500 });
  });

  test('an item with plenty of stock is listed with 0 packs and no trip', async () => {
    item(1, 'Milk');
    offer(1);
    await logBuy(1, 5000, 'buy-0001');
    const p = await plan();
    expect(p.trips).toEqual([]);
    expect(p.items[0]).toMatchObject({ item_id: 1, packs: 0, on_trip: false });
    expect(((await (await req('GET', '/api/state')).json()) as State).deals_summary).toBeNull();
  });

  test('past, disabled-store, other-currency and unmatched-size offers are never planned; archived, cooked and level items neither', async () => {
    item(1, 'Milk'); item(2, 'Old'); item(3, 'Eur'); item(4, 'Off'); item(5, 'Cooked'); item(6, 'Gone');
    db.exec("UPDATE items SET is_cooked = 1 WHERE id = 5; UPDATE items SET archived_at = 1 WHERE id = 6");
    offer(2, { to: '2026-11-18' });
    offer(3, { cur: 'EUR' });
    offer(4, { store: 'lidl-dk' });
    offer(5); offer(6);
    db.exec("UPDATE stores SET enabled = 0 WHERE id = 'lidl-dk'");
    offer(1, { key: 'nosize' });
    db.exec("UPDATE offer_matches SET qty_per_pack = NULL WHERE offer_key = 'nosize'");
    expect(buildPlan(db, NOW)).toMatchObject({ trips: [], items: [], total_saving_cents: 0 });
  });

  test('a low item (due today) is not sent to a store whose offer only starts later', async () => {
    item(1, 'Milk');
    offer(1, { from: '2026-11-21', to: '2026-11-27' });
    const p = await plan();
    expect(p.trips).toEqual([]);
    expect(p.items[0]).toMatchObject({ item_id: 1, valid_from: '2026-11-21', on_trip: false });
  });

  test('stale plan: logging a buy changes the plan at once', async () => {
    item(1, 'Milk');
    offer(1);
    expect((await plan()).trips).toHaveLength(1);
    await logBuy(1, 3000, 'buy-0002');
    const p = await plan();
    expect(p.trips).toEqual([]);
    expect(p.items[0]!.packs).toBe(0);
  });
});

describe('scheduler', () => {
  test('dealsSlot: latest started slot', () => {
    expect(dealsSlot(at(19, 5, 59))).toBe('2026-11-18T17');
    expect(dealsSlot(at(19, 6, 0))).toBe('2026-11-19T06');
    expect(dealsSlot(at(19, 16, 59))).toBe('2026-11-19T06');
    expect(dealsSlot(at(19, 17, 0))).toBe('2026-11-19T17');
  });

  test('runs once per slot and catches up only the latest', async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response('[]'); }) as typeof fetch;
    let t = at(19, 12);
    const tick = () => checkDealsSync(db, { fetch: f, now: () => t }, sendPush);
    expect(await tick()).toBe(true); // catch-up after a restart at 12:00: only the 06:00 slot
    expect(getMeta(db, 'deals_sync_slot')).toBe('2026-11-19T06');
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(0);
    t = at(19, 12, 15); expect(await tick()).toBe(false);
    expect(calls).toBe(afterFirst);
    t = at(19, 17, 5); expect(await tick()).toBe(true);
    expect(getMeta(db, 'deals_sync_slot')).toBe('2026-11-19T17');
    t = at(20, 3); expect(await tick()).toBe(false); // night: still yesterday's 17:00 slot
    t = at(20, 6, 30); expect(await tick()).toBe(true);
    expect(getMeta(db, 'deals_sync_slot')).toBe('2026-11-20T06');
  });

  test('a failing sync is logged, not thrown, and not retried within the slot', async () => {
    const f = (async () => { throw new Error('down'); }) as typeof fetch;
    expect(await checkDealsSync(db, { fetch: f, now: () => NOW }, sendPush)).toBe(true);
    expect(await checkDealsSync(db, { fetch: f, now: () => NOW }, sendPush)).toBe(false);
    expect(get<{ last_error: string }>(db, "SELECT last_error FROM stores WHERE id = 'netto-dk'")!.last_error).toContain('down');
  });
});

describe('deals push', () => {
  const sub = () => subscribePush(db, 1, { endpoint: 'https://push.example/alice', keys: { p256dh: 'BTestKey1234567890', auth: 'auth123456' } }, 'ua', NOW);

  test('one push per distinct plan, deduped in push_log; none when notify_deals is off', async () => {
    item(1, 'Milk'); item(2, 'Bread');
    offer(1);
    sub();
    expect(await checkDealsPushes(db, sendPush, NOW)).toMatchObject({ sent: 1 });
    expect(pushed[0]!.payload.body).toMatch(/^🛒 Today at Netto: 1 item, save /);
    expect(all<{ dedupe_key: string }>(db, "SELECT dedupe_key FROM push_log WHERE dedupe_key LIKE 'deals:%'")).toHaveLength(1);
    expect(await checkDealsPushes(db, sendPush, NOW + 1000)).toEqual({ sent: 0, pruned: 0 }); // same trips
    offer(2);
    expect(await checkDealsPushes(db, sendPush, NOW + 2000)).toMatchObject({ sent: 1 }); // plan changed
    expect(pushed[1]!.payload.body).toContain('2 items');
    await req('PATCH', '/api/me', { notify_deals: false });
    db.exec('DELETE FROM push_log');
    expect(await checkDealsPushes(db, sendPush, NOW + 3000)).toEqual({ sent: 0, pruned: 0 });
  });

  test('the scheduler pushes after a sync', async () => {
    item(1, 'Milk');
    offer(1);
    sub();
    await checkDealsSync(db, { fetch: (async () => new Response('[]')) as typeof fetch, now: () => NOW }, sendPush);
    expect(pushed).toHaveLength(1);
  });
});

test('a v7 database migrates to v8 with notify_deals on', () => {
  const old = new DatabaseSync(':memory:');
  old.exec(readFileSync(new URL('../src/server/schema.sql', import.meta.url), 'utf8'));
  old.exec('ALTER TABLE users DROP COLUMN notify_deals');
  old.prepare('INSERT INTO users(name, emoji, code_hash, created_at) VALUES (?, ?, ?, 0)').run('A', 'x', 'h');
  old.exec('PRAGMA user_version = 7');
  migrate(old);
  expect(get<{ user_version: number }>(old, 'PRAGMA user_version')!.user_version).toBe(8);
  expect(get<{ notify_deals: number }>(old, 'SELECT notify_deals FROM users')!.notify_deals).toBe(1);
  migrate(old);
});

describe('routes', () => {
  test('stores, location and me.notify_deals', async () => {
    const off = (await (await req('PUT', '/api/deals/stores/lidl-dk', { enabled: false })).json()) as State;
    expect(off.rev).toBeGreaterThan(0);
    expect(get<{ enabled: number }>(db, "SELECT enabled FROM stores WHERE id = 'lidl-dk'")!.enabled).toBe(0);
    expect((await (await req('GET', '/api/deals/catalogs')).json()).stores.find((s: any) => s.id === 'lidl-dk').enabled).toBe(false);
    expect((await req('PUT', '/api/deals/stores/nope', { enabled: true })).status).toBe(404);
    expect((await req('PUT', '/api/deals/stores/lidl-dk', { enabled: 'yes' })).status).toBe(400);

    expect((await req('PUT', '/api/deals/location', { lat: 56.1, lng: 10.2, radius_m: 8000 })).status).toBe(200);
    expect([getMeta(db, 'deals_lat'), getMeta(db, 'deals_lng'), getMeta(db, 'deals_radius_m')]).toEqual(['56.1', '10.2', '8000']);
    expect((await req('PUT', '/api/deals/location', { lat: 156, lng: 10, radius_m: 8000 })).status).toBe(400);

    expect(((await (await req('GET', '/api/state')).json()) as State).me.notify_deals).toBe(true);
    const st = (await (await req('PATCH', '/api/me', { notify_deals: false })).json()) as State;
    expect(st.me.notify_deals).toBe(false);
  });
});

describe('MCP tools', () => {
  async function connect() {
    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: async (input, init) => { const r = input instanceof Request ? input : new Request(input, init); const u = new URL(r.url); return app.request(u.pathname + u.search, r); },
      requestInit: { headers: { Authorization: `Bearer ${SECRET}` } },
    }));
    return client;
  }
  const data = (r: Awaited<ReturnType<Client['callTool']>>) => { expect(r.isError).not.toBe(true); return r.structuredContent as any; };

  test('listed; get_shopping_plan, search_offers and link_offer work; sync_catalogs runs', async () => {
    item(1, 'Milk'); item(2, 'Bread');
    offer(1, { key: 'arla mini mælk' });
    offer(2, { key: 'fresh sourdough', store: 'lidl-dk' });
    db.exec("DELETE FROM offer_matches WHERE offer_key = 'fresh sourdough'");
    const client = await connect();
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const n of ['get_shopping_plan', 'search_offers', 'sync_catalogs', 'link_offer']) expect(names).toContain(n);

    expect(data(await client.callTool({ name: 'get_shopping_plan', arguments: {} })).trips).toHaveLength(1);

    const found = data(await client.callTool({ name: 'search_offers', arguments: { query: 'Sourdough', store: 'lidl-dk' } }));
    expect(found.offers).toHaveLength(1);
    expect(found.offers[0]).toMatchObject({ offer_key: 'fresh sourdough', item_id: null });
    expect(data(await client.callTool({ name: 'search_offers', arguments: { query: 'sourdough', store: 'netto-dk' } })).offers).toEqual([]);
    expect((await client.callTool({ name: 'search_offers', arguments: { query: 'x', limit: 51 } })).isError).toBe(true);

    data(await client.callTool({ name: 'link_offer', arguments: { offer_key: 'fresh sourdough', item_id: 2, qty_per_pack: 1000 } }));
    expect(get<{ item_id: number; source: string }>(db, "SELECT item_id, source FROM offer_matches WHERE offer_key = 'fresh sourdough'")).toMatchObject({ item_id: 2, source: 'manual' });
    expect(data(await client.callTool({ name: 'get_shopping_plan', arguments: {} })).items).toHaveLength(2);
    data(await client.callTool({ name: 'link_offer', arguments: { offer_key: 'fresh sourdough', item_id: null } }));
    expect((await client.callTool({ name: 'link_offer', arguments: { offer_key: 'nope', item_id: null } })).isError).toBe(true);

    expect(data(await client.callTool({ name: 'sync_catalogs', arguments: {} })).stores).toHaveLength(3);
    const sql = data(await client.callTool({ name: 'query_sql', arguments: { sql: 'SELECT COUNT(*) AS n FROM offer_matches' } }));
    expect(sql.rows[0].n).toBe(2);
  });
});
