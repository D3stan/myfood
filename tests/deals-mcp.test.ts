import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApiToken, sha256 } from '../src/server/auth.ts';
import { get, getMeta, openDb } from '../src/server/db.ts';
import type { Db } from '../src/server/db.ts';
import { isoWeek } from '../src/shared/dates.ts';
import { matchOffersForDir } from '../src/server/deals/matcher.ts';
import type { MatchOffers } from '../src/server/deals/matcher.ts';
import { createApp } from '../src/server/routes.ts';

const NOW = new Date(2026, 10, 19, 12, 0).getTime();
const SECRET = 'deals-mcp-secret-0123456789abcdef';
let db: Db;
let app: ReturnType<typeof createApp>;
let matcher: ReturnType<typeof vi.fn<MatchOffers>>;
let ext = 0;

const item = (id: number, name: string, lowAt: number | null = 200) =>
  db.prepare(`INSERT INTO items(id, name, name_key, emoji, category, unit, step, pack_size, low_at, cost_per_unit_cents, created_at) VALUES (?, ?, ?, '🥛', 'dairy', 'ml', 1, 1000, ?, 2, 0)`).run(id, name, name, lowAt);
/** An offer of 1000 ml; `match` false leaves it unmatched, null item ignores it. */
function offer(key: string, o: { store?: string; price?: number; cur?: string; match?: false; item?: number | null; source?: string } = {}) {
  db.prepare(`INSERT INTO offers(store_id, source, external_id, title, offer_key, price_cents, currency, unit, unit_qty, valid_from, valid_to, fetched_at) VALUES (?, 'tjek', ?, ?, ?, ?, ?, 'ml', 1000, '2026-11-14', '2026-11-27', 0)`)
    .run(o.store ?? 'netto-dk', `x${++ext}`, `Title ${key}`, key, o.price ?? 1000, o.cur ?? 'DKK');
  if (o.match !== false) db.prepare('INSERT OR REPLACE INTO offer_matches(offer_key, item_id, qty_per_pack, confidence, source, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
    .run(key, o.item === undefined ? 1 : o.item, o.item === null ? null : 1000, o.source ?? 'manual', ++ext);
}

async function connect(headers: Record<string, string> = { Authorization: `Bearer ${SECRET}` }) {
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: async (input, init) => { const r = input instanceof Request ? input : new Request(input, init); const u = new URL(r.url); return app.request(u.pathname + u.search, r); },
    requestInit: { headers },
  }));
  return client;
}
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args });
const data = (r: Awaited<ReturnType<Client['callTool']>>) => { expect(r.isError).not.toBe(true); return r.structuredContent as any; };

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = openDb(':memory:');
  for (const [n, e] of [['Alice', '🦊'], ['Bob', '🐻']] as const) db.prepare('INSERT INTO users(name, emoji, code_hash, created_at) VALUES (?, ?, ?, 0)').run(n, e, sha256(`${n}-code-0000`));
  matcher = vi.fn<MatchOffers>(async () => []);
  app = createApp({
    db, runAi: async () => ({ reply: 'ok', events: [] }), dataDir: mkdtempSync(join(tmpdir(), 'mf-dmcp-')), build: 't', webDir: '/nonexistent',
    now: () => NOW, mcpSecret: SECRET, fetch: (async () => new Response('[]')) as typeof fetch, matchOffers: matcher,
  });
});
afterEach(() => vi.restoreAllMocks());

test('get_state carries deals_summary; get_shopping_plan adds stores, location and unmatched_offer_count', async () => {
  item(1, 'Milk'); item(2, 'Bread');
  offer('arla mini mælk');
  offer('sourdough', { match: false });
  offer('sourdough', { match: false, store: 'lidl-dk' }); // same key in two stores counts once
  const c = await connect();
  for (const full of [false, true]) expect(data(await call(c, 'get_state', { full })).deals_summary).toMatchObject({ store_name: 'Netto', deal_count: 1 });
  const plan = data(await call(c, 'get_shopping_plan'));
  expect(plan.trips).toHaveLength(1);
  expect(plan.stores.map((s: any) => s.id).sort()).toEqual(['coop365-dk', 'lidl-dk', 'netto-dk']);
  expect(plan.stores[0]).toHaveProperty('last_synced_at');
  expect(plan.location).toEqual({ lat: Number(getMeta(db, 'deals_lat')), lng: Number(getMeta(db, 'deals_lng')), radius_m: Number(getMeta(db, 'deals_radius_m')) });
  expect(plan.unmatched_offer_count).toBe(1);
  expect(data(await call(await connect(), 'get_state')).deals_summary).not.toBeUndefined();
});

describe('log_trip', () => {
  const events = () => db.prepare(`SELECT e.cid, e.source, e.kind, e.note, e.user_id, e.cost_cents FROM events e`).all() as any[];
  const lines = () => db.prepare('SELECT item_id, qty, cost_cents FROM event_lines ORDER BY item_id').all() as any[];

  test('defaults to the planned items: one buy with offer qty and cost, note is the store', async () => {
    item(1, 'Milk'); offer('arla mini mælk', { price: 1500 });
    const c = await connect();
    const r = data(await call(c, 'log_trip', { user_id: 1, store_id: 'netto-dk' }));
    expect(r.event).toMatchObject({ kind: 'buy', note: 'Netto', source: 'manual' });
    expect(events()).toHaveLength(1);
    expect(lines()).toEqual([{ item_id: 1, qty: expect.any(Number), cost_cents: expect.any(Number) }]);
    const l = lines()[0], packs = l.cost_cents / 1500;
    expect(Number.isInteger(packs) && packs >= 1).toBe(true);
    expect(l.qty).toBe(packs * 1000);
  });

  test('explicit items use the cheapest live offer at the store; items without one are rejected', async () => {
    item(1, 'Milk'); item(2, 'Bread');
    offer('dear milk', { price: 1500 }); offer('cheap milk', { price: 1000 });
    offer('bread', { item: 2, store: 'lidl-dk' });
    const c = await connect();
    expect((await call(c, 'log_trip', { user_id: 1, store_id: 'netto-dk', items: [{ item_id: 2, packs: 1 }] })).isError).toBe(true);
    expect((await call(c, 'log_trip', { user_id: 1, store_id: 'nope', items: [{ item_id: 1, packs: 1 }] })).isError).toBe(true);
    expect((await call(c, 'log_trip', { user_id: 1, store_id: 'coop365-dk' })).isError).toBe(true); // no trip, no items
    expect(events()).toHaveLength(0);
    data(await call(c, 'log_trip', { user_id: 1, store_id: 'netto-dk', items: [{ item_id: 1, packs: 3 }] }));
    expect(lines()).toEqual([{ item_id: 1, qty: 3000, cost_cents: 3000 }]);
  });

  test('a locked week is an error and logs nothing', async () => {
    item(1, 'Milk'); offer('arla mini mælk');
    const c = await connect();
    data(await call(c, 'lock_expense_week', { user_id: 1, period: isoWeek(NOW) }));
    expect((await call(c, 'log_trip', { user_id: 1, store_id: 'netto-dk' })).isError).toBe(true);
    expect(events()).toHaveLength(0);
  });

  test('forcedUserId wins over user_id', async () => {
    item(1, 'Milk'); offer('arla mini mælk');
    const { token } = createApiToken(db, 1, 'Claude', NOW, 'mcp');
    data(await call(await connect({ Authorization: `Bearer ${token}` }), 'log_trip', { store_id: 'netto-dk', user_id: 2 }));
    expect(events()[0].user_id).toBe(1);
  });
});

test('set_settings notify_deals: forcedUserId wins over user_id', async () => {
  const c = await connect();
  const r = data(await call(c, 'set_settings', { notify_deals: false, user_id: 2 }));
  expect(r.user).toMatchObject({ id: 2, notify_deals: false });
  expect(get<{ notify_deals: number }>(db, 'SELECT notify_deals FROM users WHERE id = 1')!.notify_deals).toBe(1);

  const { token } = createApiToken(db, 1, 'Claude', NOW, 'mcp'); // Alice's token, asking for Bob
  const forced = await connect({ Authorization: `Bearer ${token}` });
  expect(data(await call(forced, 'set_settings', { notify_deals: false, user_id: 2 })).user).toMatchObject({ id: 1, notify_deals: false });
  expect(get<{ notify_deals: number }>(db, 'SELECT notify_deals FROM users WHERE id = 2')!.notify_deals).toBe(0);
  const bad = await call(c, 'set_settings', {});
  expect(bad.isError).toBe(true);
  expect(JSON.stringify(bad.content)).toContain('notify_deals');
});

test('set_deal_settings: stores and location, all-or-nothing, needs an argument', async () => {
  const c = await connect();
  const r = data(await call(c, 'set_deal_settings', { stores: [{ id: 'lidl-dk', enabled: false }], location: { lat: 56.1, lng: 10.2, radius_m: 8000 } }));
  expect(r.stores.find((s: any) => s.id === 'lidl-dk').enabled).toBe(false);
  expect(r.location).toEqual({ lat: 56.1, lng: 10.2, radius_m: 8000 });
  expect(get<{ enabled: number }>(db, "SELECT enabled FROM stores WHERE id = 'lidl-dk'")!.enabled).toBe(0);

  expect((await call(c, 'set_deal_settings', { stores: [{ id: 'netto-dk', enabled: false }, { id: 'nope', enabled: true }] })).isError).toBe(true);
  expect(get<{ enabled: number }>(db, "SELECT enabled FROM stores WHERE id = 'netto-dk'")!.enabled).toBe(1);
  expect((await call(c, 'set_deal_settings', { location: { lat: 156, lng: 10, radius_m: 8000 } })).isError).toBe(true);
  expect((await call(c, 'set_deal_settings', {})).isError).toBe(true);
});

test('get_item gains normal_price, deals and prices', async () => {
  item(1, 'Milk');
  offer('arla mini mælk', { price: 800 });
  const c = await connect();
  const before = data(await call(c, 'get_item', { item_id: 1 }));
  expect(before.prices).toEqual([]);
  expect(before.normal_price).toEqual({ cents_per_unit: 2, basis: 'item' });
  expect(before.deals).toHaveLength(1);
  expect(before.deals[0]).toMatchObject({ store_name: 'Netto', price_cents: 800, unit_cents: 0.8 });

  data(await call(c, 'log_event', { user_id: 1, kind: 'buy', lines: [{ item_id: 1, qty: 1000, cost_cents: 3000 }] }));
  const after = data(await call(c, 'get_item', { item_id: 1 }));
  expect(after.prices).toHaveLength(1);
  expect(after.prices[0].unit_cents).toBe(3);
  expect(after.normal_price).toEqual({ cents_per_unit: 3, basis: 'buys' });
});

test('list_offer_matches filters, shows stores and item name, newest first', async () => {
  item(1, 'Milk'); item(2, 'Bread');
  offer('milk a'); // updated_at 2
  offer('milk a', { store: 'lidl-dk' });
  offer('bread b', { item: 2, source: 'ai' });
  offer('junk c', { item: null, source: 'ai' });
  const c = await connect();
  const all = data(await call(c, 'list_offer_matches')).matches;
  expect(all.map((m: any) => m.offer_key)).toEqual(['junk c', 'bread b', 'milk a']);
  expect(all[2]).toMatchObject({ item_name: 'Milk', qty_per_pack: 1000, confidence: 1, source: 'manual', title: 'Title milk a' });
  expect(all[2].stores.sort()).toEqual(['Lidl', 'Netto']);
  const ai = data(await call(c, 'list_offer_matches', { source: 'ai' })).matches;
  expect(ai.map((m: any) => m.offer_key)).toEqual(['junk c', 'bread b']);
  expect(data(await call(c, 'list_offer_matches', { ignored: true })).matches.map((m: any) => m.offer_key)).toEqual(['junk c']);
  expect(data(await call(c, 'list_offer_matches', { ignored: false, item_id: 2 })).matches.map((m: any) => m.offer_key)).toEqual(['bread b']);
  expect(data(await call(c, 'list_offer_matches', { item_id: 2, ignored: true })).matches).toEqual([]);
});

test('search_offers: status, names, unit_cents, enabled stores and currency only, empty query rejected', async () => {
  item(1, 'Milk');
  offer('fresh milk');
  offer('fresh sourdough', { match: false, store: 'lidl-dk' });
  offer('fresh rye', { item: null, store: 'lidl-dk' });
  offer('fresh swedish', { cur: 'SEK' });
  offer('fresh coop', { store: 'coop365-dk', match: false });
  db.exec("UPDATE stores SET enabled = 0 WHERE id = 'coop365-dk'");
  const c = await connect();
  const found = data(await call(c, 'search_offers', { query: 'FRESH' })).offers as any[];
  expect(found.map(o => o.offer_key).sort()).toEqual(['fresh milk', 'fresh rye', 'fresh sourdough']);
  const by = (k: string) => found.find(o => o.offer_key === k);
  expect(by('fresh milk')).toMatchObject({ status: 'matched', item_name: 'Milk', store_name: 'Netto', unit_cents: 1 });
  expect(by('fresh sourdough')).toMatchObject({ status: 'unmatched', item_name: null, unit_cents: null });
  expect(by('fresh rye')).toMatchObject({ status: 'ignored', item_id: null, unit_cents: null });
  expect(data(await call(c, 'search_offers', { query: 'fresh', store: 'lidl-dk' })).offers).toHaveLength(2);
  const empty = await call(c, 'search_offers', { query: '%_!' });
  expect(empty.isError).toBe(true);
});

test('sync_catalogs: match=false never calls the matcher, default and true do; tool texts state the facts', async () => {
  item(1, 'Milk');
  offer('new thing', { match: false });
  const c = await connect();
  data(await call(c, 'sync_catalogs', { match: false }));
  expect(matcher).not.toHaveBeenCalled();
  data(await call(c, 'sync_catalogs'));
  expect(matcher).toHaveBeenCalledTimes(1);
  data(await call(c, 'sync_catalogs', { match: true }));
  expect(matcher).toHaveBeenCalledTimes(2);

  const tools = (await c.listTools()).tools;
  const desc = (n: string) => tools.find(t => t.name === n)!.description!;
  expect(desc('sync_catalogs')).toMatch(/70 s.*300/s);
  expect(desc('link_offer')).toMatch(/every store/);
  expect(desc('set_deal_settings')).toMatch(/household-wide/i);
  expect(desc('set_settings')).toContain('notify_deals');
});

describe('stdio wiring', () => {
  const OLD = process.env.AI_CMD;
  afterEach(() => { if (OLD === undefined) delete process.env.AI_CMD; else process.env.AI_CMD = OLD; });

  test('jobs dir is JOBS_DIR or DATA_DIR/jobs, created 0750 on first match only', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mf-stdio-'));
    expect(matchOffersForDir(tmp).jobsDir).toBe(join(tmp, 'jobs'));
    const { jobsDir, matchOffers } = matchOffersForDir(tmp, join(tmp, 'elsewhere'));
    expect(jobsDir).toBe(join(tmp, 'elsewhere'));
    expect(existsSync(jobsDir)).toBe(false);
    process.env.AI_CMD = 'true'; // exits 0 with no output: the matcher rejects, but ran inside the created dir
    await expect(matchOffers({ items: [], offers: [] })).rejects.toThrow();
    expect(statSync(jobsDir).mode & 0o777).toBe(0o750 & ~process.umask());
  });
});
