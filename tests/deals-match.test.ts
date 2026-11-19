import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { sha256 } from '../src/server/auth.ts';
import { all, get, openDb } from '../src/server/db.ts';
import type { Db } from '../src/server/db.ts';
import { matchNewOffers } from '../src/server/deals/matcher.ts';
import type { MatchOffers } from '../src/server/deals/matcher.ts';
import { normalPrice } from '../src/server/deals/repo.ts';
import { syncStores } from '../src/server/deals/sync.ts';
import { createApp } from '../src/server/routes.ts';

const NOW = new Date(2026, 10, 19, 12).getTime();
const at = (d: number) => new Date(2026, 10, d, 12).getTime();
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

function setup() {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO users(name, emoji, code_hash, created_at) VALUES (?, ?, ?, 0)').run('Alice', '🦊', sha256('aaaa-aaaa-aaaa'));
  const item = (id: number, name: string, unit = 'g', extra = '') => db.exec(`INSERT INTO items(id, name, name_key, emoji, category, unit, step, pack_size, created_at${extra ? ', ' + extra.split('=')[0] : ''}) VALUES (${id}, '${name}', '${name}', 'x', 'dairy', '${unit}', 1, 500, 0${extra ? ', ' + extra.split('=')[1] : ''})`);
  item(1, 'milk', 'ml'); item(2, 'pasta'); item(3, 'salt', 'level'); item(4, 'cooked', 'g', 'is_cooked=1');
  return { db, item };
}
let ext = 0;
const offer = (db: Db, o: { key: string; title?: string; price?: number; pre?: number | null; unit?: string | null; qty?: number | null; ean?: string | null; from?: string; to?: string; cur?: string; store?: string }) =>
  db.prepare(`INSERT INTO offers(store_id, source, external_id, title, offer_key, price_cents, pre_price_cents, currency, unit, unit_qty, ean, valid_from, valid_to, fetched_at)
    VALUES (?, 'tjek', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(o.store ?? 'netto-dk', `e${++ext}`, o.title ?? o.key, o.key, o.price ?? 1000, o.pre ?? null, o.cur ?? 'DKK',
    o.unit === undefined ? 'ml' : o.unit, o.qty === undefined ? 1000 : o.qty, o.ean ?? null, o.from ?? '2026-11-14', o.to ?? '2026-11-27');
const matches = (db: Db) => Object.fromEntries(all<any>(db, 'SELECT * FROM offer_matches').map(m => [m.offer_key, m]));

describe('matchNewOffers', () => {
  test('barcode tier needs no AI; qty falls back to the offer size in the item unit', async () => {
    const { db } = setup();
    db.exec("INSERT INTO barcodes(code, item_id, source, updated_at) VALUES ('5701', 1, 'x', 0)");
    offer(db, { key: 'arla mini', ean: '5701', unit: 'ml', qty: 500 });
    const ai = vi.fn<MatchOffers>(async () => []);
    await matchNewOffers(db, ai, NOW);
    expect(ai).not.toHaveBeenCalled();
    expect(matches(db)['arla mini']).toMatchObject({ item_id: 1, qty_per_pack: 500, confidence: 1, source: 'barcode' });
  });

  test('batch tier: stores matches, low confidence and null become ignored, unknown item dropped, only eligible items sent', async () => {
    const { db } = setup();
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) offer(db, { key: k, unit: k === 'e' ? 'g' : 'ml', qty: 1000 });
    db.exec("INSERT INTO offer_matches(offer_key, item_id, qty_per_pack, confidence, source, updated_at) VALUES ('f', NULL, NULL, 1, 'manual', 0)");
    const ai = vi.fn<MatchOffers>(async () => [
      { offer_key: 'a', item_id: 1, qty_per_pack: null, confidence: 0.9 }, // qty from the offer: ml = ml
      { offer_key: 'b', item_id: 1, qty_per_pack: 750, confidence: 0.3 }, // too unsure
      { offer_key: 'c', item_id: null, qty_per_pack: null, confidence: 0.9 },
      { offer_key: 'd', item_id: 99, qty_per_pack: 1, confidence: 0.9 }, // not an input item
      { offer_key: 'e', item_id: 2, qty_per_pack: null, confidence: 0.8 }, // offer g = item g
    ]);
    await matchNewOffers(db, ai, NOW);
    const input = ai.mock.calls[0]![0];
    expect(input.items.map(i => i.id)).toEqual([1, 2]); // not salt (level), not the cooked meal
    expect(input.offers.map(o => o.offer_key)).toEqual(['a', 'b', 'c', 'd', 'e']); // f already matched
    const m = matches(db);
    expect(m.a).toMatchObject({ item_id: 1, qty_per_pack: 1000, source: 'ai' });
    expect(m.b).toMatchObject({ item_id: null, qty_per_pack: null });
    expect(m.c.item_id).toBeNull();
    expect(m.d).toBeUndefined();
    expect(m.e).toMatchObject({ item_id: 2, qty_per_pack: 1000 });
    expect(m.f.source).toBe('manual');
  });

  test('a throwing matcher leaves the keys unmatched and the sync ok', async () => {
    const { db } = setup();
    const fetchFn = (async (u: any) => new Response(JSON.stringify(String(u).includes('dealer_ids=9ba51') && String(u).includes('/catalogs') ? JSON.parse(readFileSync(new URL('./samples/tjek-catalogs.json', import.meta.url), 'utf8')) : []))) as typeof fetch;
    const r = await syncStores(db, { fetch: fetchFn, now: () => NOW, matchOffers: async () => { throw new Error('boom'); } });
    expect(r.stores.every(s => s.ok)).toBe(true);
    offer(db, { key: 'x' });
    await expect(matchNewOffers(db, async () => { throw new Error('boom'); }, NOW)).resolves.toBe(0);
    expect(all(db, 'SELECT * FROM offer_matches')).toEqual([]);
    await matchNewOffers(db, undefined, NOW);
    expect(all(db, 'SELECT * FROM offer_matches')).toEqual([]);
  });
});

describe('matchNewOffers freshness', () => {
  test('skips expired offers; asks again about an AI "no match" once a newer item exists, never a manual one', async () => {
    const { db } = setup();
    offer(db, { key: 'old', to: '2026-11-10' });
    offer(db, { key: 'skyr' }); offer(db, { key: 'man' });
    db.exec("INSERT INTO offer_matches(offer_key, item_id, confidence, source, updated_at) VALUES ('skyr', NULL, 0.9, 'ai', 5), ('man', NULL, 1, 'manual', 5)");
    const ai = vi.fn<MatchOffers>(async () => [{ offer_key: 'skyr', item_id: 9, qty_per_pack: 450, confidence: 0.9 }]);
    await matchNewOffers(db, ai, NOW);
    expect(ai).not.toHaveBeenCalled(); // nothing new: 'old' expired, both ignores are newer than every item
    db.exec("INSERT INTO items(id, name, name_key, emoji, category, unit, step, pack_size, created_at) VALUES (9, 'skyr', 'skyr', 'x', 'dairy', 'g', 1, 450, 10)");
    await matchNewOffers(db, ai, NOW);
    expect(ai.mock.calls[0]![0].offers.map(o => o.offer_key)).toEqual(['skyr']);
    expect(matches(db).skyr).toMatchObject({ item_id: 9, qty_per_pack: 450 });
    expect(matches(db).man.item_id).toBeNull();
  });
});

describe('normalPrice', () => {
  const buy = (db: Db, cid: string, day: number, item: number, qty: number, cost: number, lines = 1) => {
    db.prepare("INSERT INTO events(cid, seq, user_id, at, kind, source, cost_cents) VALUES (?, ?, 1, ?, 'buy', 'manual', ?)").run(cid, ++ext, at(day), lines === 1 ? cost : null);
    db.prepare('INSERT INTO event_lines(event_cid, item_id, qty, is_set, cost_cents) VALUES (?, ?, ?, 0, ?)').run(cid, item, qty, lines === 1 ? null : cost);
  };

  test('median of buys, leaving out promo buys; total-only single-line buy counts', () => {
    const { db } = setup();
    buy(db, 'a', 1, 2, 500, 1000); // 2.0 / g, total only
    buy(db, 'b', 2, 2, 500, 1100, 2); // 2.2
    buy(db, 'c', 3, 2, 500, 1200, 2); // 2.4
    buy(db, 'd', 10, 2, 500, 600, 2); // 1.2: on offer
    offer(db, { key: 'pasta deal', price: 600, unit: 'g', qty: 500, from: '2026-11-09', to: '2026-11-12' });
    db.exec("INSERT INTO offer_matches VALUES ('pasta deal', 2, 500, 1, 'manual', 0)");
    expect(normalPrice(db, 2)).toEqual({ cents_per_unit: 2.2, basis: 'buys' });
    db.exec("UPDATE offers SET currency = 'EUR'"); // other currency: the buy no longer looks like a promo
    expect(normalPrice(db, 2)!.cents_per_unit).toBeCloseTo(2.1);
  });

  test('falls back to the item price, level is null', () => {
    const { db } = setup();
    expect(normalPrice(db, 2)).toBeNull();
    db.exec('UPDATE items SET cost_per_unit_cents = 3.5 WHERE id IN (2, 3)');
    expect(normalPrice(db, 2)).toEqual({ cents_per_unit: 3.5, basis: 'item' });
    expect(normalPrice(db, 3)).toBeNull();
  });

  test('every priced buy was a promo: null, not the item price', () => {
    const { db } = setup();
    db.exec('UPDATE items SET cost_per_unit_cents = 1.2 WHERE id = 2');
    buy(db, 'p', 10, 2, 500, 600, 2);
    offer(db, { key: 'pasta deal', price: 600, unit: 'g', qty: 500, from: '2026-11-09', to: '2026-11-12' });
    db.exec("INSERT INTO offer_matches VALUES ('pasta deal', 2, 500, 1, 'manual', 0)");
    expect(normalPrice(db, 2)).toBeNull();
  });
});

describe('routes', () => {
  async function app() {
    const { db } = setup();
    const a = createApp({ db, runAi: async () => { throw new Error('x'); }, dataDir: mkdtempSync(join(tmpdir(), 'mf-')), build: 't', webDir: '/nonexistent', now: () => NOW });
    const login = await a.request('/api/login', { method: 'POST', headers: { 'X-MyFood': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'aaaa-aaaa-aaaa' }) });
    const h = { 'X-MyFood': '1', 'Content-Type': 'application/json', cookie: login.headers.get('set-cookie')!.split(';')[0]! };
    const post = (body: unknown) => a.request('/api/deals/match', { method: 'POST', headers: h, body: JSON.stringify(body) });
    return { db, post, deals: (id: number) => a.request(`/api/items/${id}/deals`, { headers: h }) };
  }

  test('POST /api/deals/match sets and ignores a key', async () => {
    const { db, post } = await app();
    offer(db, { key: 'k', unit: 'g', qty: 500 });
    expect((await post({ offer_key: 'k', item_id: 99 })).status).toBe(404);
    expect((await post({ offer_key: 'nope', item_id: 1 })).status).toBe(404);
    expect((await post({ offer_key: 'k', item_id: 'x' })).status).toBe(400);
    expect((await post({ offer_key: 'k', item_id: 2, qty_per_pack: 400 })).status).toBe(200);
    expect(get(db, 'SELECT * FROM offer_matches')).toMatchObject({ item_id: 2, qty_per_pack: 400, confidence: 1, source: 'manual' });
    expect((await post({ offer_key: 'k', item_id: null })).status).toBe(200);
    expect(get(db, 'SELECT * FROM offer_matches')).toMatchObject({ item_id: null, source: 'manual' });
  });

  test('GET /api/items/:id/deals lists live matched offers with % off', async () => {
    const { db, post, deals } = await app();
    db.exec('UPDATE items SET cost_per_unit_cents = 2 WHERE id = 2');
    offer(db, { key: 'live', price: 800, unit: 'g', qty: 500, from: '2026-11-17', to: '2026-11-20' }); // 1.6/g vs normal 2 = 20%
    offer(db, { key: 'pre', price: 600, pre: 1200, unit: 'g', qty: 500, store: 'lidl-dk' }); // pre_price wins: 50%
    offer(db, { key: 'old', unit: 'g', qty: 500, from: '2026-11-01', to: '2026-11-10' });
    offer(db, { key: 'eur', unit: 'g', qty: 500, cur: 'EUR' });
    offer(db, { key: 'other', unit: 'g', qty: 500 });
    for (const k of ['live', 'pre', 'old', 'eur']) await post({ offer_key: k, item_id: 2 });
    const r = await (await deals(2)).json();
    expect(r.normal).toEqual({ cents_per_unit: 2, basis: 'item' });
    expect(r.offers.map((o: any) => [o.store_name, o.title, o.pct_off, o.unit_cents])).toEqual([['Lidl', 'pre', 50, 1.2], ['Netto', 'live', 20, 1.6]]);
    expect(r.offers[0]).toMatchObject({ store_emoji: expect.any(String), valid_from: '2026-11-14', price_cents: 600 });
    expect((await deals(99)).status).toBe(404);
  });
});
