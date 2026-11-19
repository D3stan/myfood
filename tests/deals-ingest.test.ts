import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { sha256 } from '../src/server/auth.ts';
import { all, get, getMeta, getRev, migrate, openDb } from '../src/server/db.ts';
import { fetchTjek, localDay, packSize } from '../src/server/deals/providers/tjek.ts';
import { syncStores } from '../src/server/deals/sync.ts';
import { createApp } from '../src/server/routes.ts';

const sample = (n: string) => JSON.parse(readFileSync(new URL(`./samples/${n}`, import.meta.url), 'utf8')) as any[];
const catalogs = sample('tjek-catalogs.json');
const offers = sample('tjek-offers.json');
const where = { lat: 55.6761, lng: 12.5683, radius: 5000 };
const NOW = Date.UTC(2026, 10, 19, 10);

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
/** Netto (9ba51) serves the recorded samples (offers only for the first catalog); Lidl fails; Coop 365 has nothing. */
const fakeFetch = (calls: string[] = []): typeof fetch => (async (input: any) => {
  const url = String(input);
  calls.push(url);
  if (url.includes('dealer_ids=71c90')) return new Response('nope', { status: 503 });
  if (!url.includes('dealer_ids=9ba51') && url.includes('/catalogs')) return json([]);
  if (url.includes('/catalogs')) return json(catalogs);
  return json(url.includes(`catalog_ids=${catalogs[0].id}`) && url.includes('offset=0') ? offers : []);
}) as typeof fetch;

describe('tjek normalisation', () => {
  test('units, minor units and local dates from the recorded samples', async () => {
    const calls: string[] = [];
    const r = await fetchTjek('9ba51', where, fakeFetch(calls));
    expect(calls[0]).toContain('squid-api.tjek.com/v2/catalogs?dealer_ids=9ba51&r_lat=55.6761&r_lng=12.5683&r_radius=5000');
    expect(r.catalogs[0]).toMatchObject({ external_id: 'Bswgx2rE', valid_from: '2026-11-21', valid_to: '2026-11-27' });
    const by = (t: string) => r.offers.find(o => o.title.startsWith(t))!;
    expect(r.offers).toHaveLength(offers.length);
    expect(by('Faxe Kondi eller Pepsi Max sodavand')).toMatchObject({ price_cents: 1000, unit: 'ml', unit_qty: 1500, max_per_customer: 6 });
    expect(r.offers.find(o => o.unit_qty === 7920)).toMatchObject({ unit: 'ml', price_cents: 7500 }); // 24 x 33 cl
    expect(by('ØGO')).toMatchObject({ unit: 'pc', unit_qty: 10, max_per_customer: null });
    expect(by('Arla Protein')).toMatchObject({ unit: 'ml', unit_qty: 500 });
    expect(by('Ovnklar')).toMatchObject({ price_cents: 1695, unit: 'g', unit_qty: 500 });
    expect(by('Brunchy')).toMatchObject({ price_cents: 597, pre_price_cents: 1200, unit: 'g', unit_qty: 100 });
    expect(by('KiMs')).toMatchObject({ unit: null, unit_qty: null }); // 125-160 g is a range
    expect(by('Monster')).toMatchObject({ unit: null, unit_qty: null });
    expect(by('Brunchy').offer_key).toBe('brunchy bacon i skiver 100g');
  });
  test('dates are local Copenhagen days; kg/l/cl scale', () => {
    expect(localDay('2026-11-27T22:59:59+0000')).toBe('2026-11-27');
    expect(localDay('2026-11-20T23:00:00+0000')).toBe('2026-11-21');
    expect(localDay('2026-07-01T21:59:59+0000')).toBe('2026-07-01'); // CEST
    const q = (symbol: string, si: string, factor: number, size: number) => ({ unit: { symbol, si: { symbol: si, factor } }, size: { from: size, to: size } });
    expect(packSize(q('kg', 'kg', 1, 0.5))).toEqual({ unit: 'g', qty: 500 });
    expect(packSize(q('cl', 'l', 0.01, 33))).toEqual({ unit: 'ml', qty: 330 });
    expect(packSize({})).toEqual({ unit: null, qty: null });
  });
});

describe('syncStores', () => {
  test('is idempotent, and one failing store does not stop the others', async () => {
    const db = openDb(':memory:');
    const r1 = await syncStores(db, { fetch: fakeFetch(), now: () => NOW });
    expect(r1.newOffers).toBe(offers.length);
    expect(r1.stores.map(s => [s.id, s.ok]).sort()).toEqual([['coop365-dk', true], ['lidl-dk', false], ['netto-dk', true]]);
    expect(get<{ n: number }>(db, 'SELECT COUNT(*) n FROM offers')!.n).toBe(offers.length);
    expect(get<{ n: number }>(db, 'SELECT COUNT(*) n FROM catalogs')!.n).toBe(catalogs.length);
    expect(get<{ n: number }>(db, 'SELECT COUNT(*) n FROM offers WHERE catalog_id IS NOT NULL')!.n).toBe(offers.length);
    const st = Object.fromEntries(all<any>(db, 'SELECT * FROM stores').map(s => [s.id, s]));
    expect(st['lidl-dk'].last_error).toContain('503');
    expect(st['lidl-dk'].last_synced_at).toBeNull();
    expect(st['netto-dk']).toMatchObject({ last_error: null, last_synced_at: NOW });

    const rev = getRev(db);
    const r2 = await syncStores(db, { fetch: fakeFetch(), now: () => NOW + 1000 });
    expect(r2.newOffers).toBe(0);
    expect(get<{ n: number }>(db, 'SELECT COUNT(*) n FROM offers')!.n).toBe(offers.length);
    expect(getRev(db)).toBe(rev); // nothing changed
  });
});

describe('migration and routes', () => {
  test('a v6 database migrates to 7 with seeded stores', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(readFileSync(new URL('../src/server/schema.sql', import.meta.url), 'utf8'));
    db.exec('PRAGMA user_version = 6');
    migrate(db);
    expect(get<{ user_version: number }>(db, 'PRAGMA user_version')!.user_version).toBe(8);
    expect(all<{ id: string }>(db, 'SELECT id FROM stores ORDER BY id').map(s => s.id)).toEqual(['coop365-dk', 'lidl-dk', 'netto-dk']);
    expect(JSON.parse(get<{ sources: string }>(db, "SELECT sources FROM stores WHERE id = 'lidl-dk'")!.sources)).toEqual([{ provider: 'tjek', config: { dealer_id: '71c90' } }]);
    expect([getMeta(db, 'deals_lat'), getMeta(db, 'deals_lng'), getMeta(db, 'deals_radius_m')]).toEqual(['55.6761', '12.5683', '5000']);
    migrate(db); // idempotent
  });

  test('POST /api/deals/sync and GET /api/deals/catalogs', async () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO users(name, emoji, code_hash, created_at) VALUES (?, ?, ?, 0)').run('Alice', '🦊', sha256('aaaa-aaaa-aaaa'));
    const app = createApp({ db, runAi: async () => { throw new Error('x'); }, dataDir: mkdtempSync(join(tmpdir(), 'mf-')), build: 't', webDir: '/nonexistent', now: () => NOW, fetch: fakeFetch() });
    expect((await app.request('/api/deals/catalogs')).status).toBe(401);
    const login = await app.request('/api/login', { method: 'POST', headers: { 'X-MyFood': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'aaaa-aaaa-aaaa' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const sync = await app.request('/api/deals/sync', { method: 'POST', headers: { 'X-MyFood': '1', cookie } });
    expect((await sync.json()).newOffers).toBe(offers.length);
    const body = await (await app.request('/api/deals/catalogs', { headers: { cookie } })).json();
    expect(body.stores.find((s: any) => s.id === 'lidl-dk').last_error).toContain('503');
    // today is 19 Nov: both Netto weeks (ends 20 Nov and 27 Nov) are listed
    expect(body.catalogs.map((c: any) => [c.title, c.offer_count])).toEqual([['Netto uge 47', 0], ['Netto uge 48', offers.length]]);
  });
});
