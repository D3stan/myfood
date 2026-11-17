import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { sha256 } from '../src/server/auth.ts';
import { openDb } from '../src/server/db.ts';
import { createApp } from '../src/server/routes.ts';
import type { State } from '../src/shared/types.ts';

let clock: number;
let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof openDb>;
let cookie: Record<string, string>;

async function req(method: string, path: string, body?: unknown, who = 'alice'): Promise<Response> {
  return app.request(path, {
    method,
    headers: { 'X-MyFood': '1', 'Content-Type': 'application/json', ...(cookie[who] ? { cookie: cookie[who] } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const st = async (method: string, path: string, body?: unknown, who = 'alice'): Promise<State> => {
  const r = await req(method, path, body, who);
  expect(r.status).toBe(200);
  return r.json();
};
const stock = (s: State, name: string) => s.items.find(i => i.name === name)!.stock;
const idOf = (s: State, name: string) => s.items.find(i => i.name === name)!.id;
const item = (name: string, unit = 'pc', category = 'dairy') => ({ name, emoji: '🥚', category, unit, step: 1, pack_size: 10, low_at: null });
let n = 0;
const ev = (kind: string, lines: [number, number][], at = clock) =>
  ({ cid: `cid-test-${++n}`, at, kind, lines: lines.map(([item_id, qty]) => ({ item_id, qty })) });

beforeEach(async () => {
  clock = 1_000_000;
  db = openDb(':memory:');
  db.prepare('INSERT INTO users(name, emoji, code_hash, created_at) VALUES (?, ?, ?, 0)').run('Alice', '🦊', sha256('aaaa-aaaa-aaaa'));
  db.prepare('INSERT INTO users(name, emoji, code_hash, created_at) VALUES (?, ?, ?, 0)').run('Bob', '🐻', sha256('bbbb-bbbb-bbbb'));
  app = createApp({ db, runAi: async () => { throw new Error('no ai'); }, dataDir: mkdtempSync(join(tmpdir(), 'mf-')), build: 't', webDir: '/nonexistent', now: () => clock });
  cookie = {};
  for (const [who, code] of [['alice', 'aaaa-aaaa-aaaa'], ['bob', 'bbbb-bbbb-bbbb']]) {
    const r = await req('POST', '/api/login', { code }, who!);
    cookie[who!] = r.headers.get('set-cookie')!.split(';')[0]!;
  }
  await st('POST', '/api/items', item('Eggs'));
  await st('POST', '/api/items', item('Salt', 'level', 'spices'));
  await st('POST', '/api/items', item('Cheese', 'slice'));
});

test('state is sorted, has the user and no archived items', async () => {
  const s = await st('GET', '/api/state');
  expect(s.me.name).toBe('Alice');
  expect(s.users).toHaveLength(2);
  expect(s.items.map(i => i.name)).toEqual(['Cheese', 'Eggs', 'Salt']);
  expect(s.ai.ready).toBeNull();
});

test('eat before buy still sums right, and a duplicate cid changes nothing', async () => {
  const eggs = idOf(await st('GET', '/api/state'), 'Eggs');
  const eat = ev('eat', [[eggs, 3]], 1000);
  let s = await st('POST', '/api/events', eat);
  expect(stock(s, 'Eggs')).toBe(-3);
  s = await st('POST', '/api/events', ev('buy', [[eggs, 10]], 2000));
  expect(stock(s, 'Eggs')).toBe(7);
  const rev = s.rev;
  s = await st('POST', '/api/events', eat);
  expect(s.rev).toBe(rev);
  expect(s.events).toHaveLength(2);
  expect(stock(s, 'Eggs')).toBe(7);
});

test('level buys add containers, eat readings preserve spares, adjustments set totals, edits and undo replay', async () => {
  let s = await st('GET', '/api/state');
  const [eggs, salt] = [idOf(s, 'Eggs'), idOf(s, 'Salt')];
  await st('POST', '/api/events', ev('buy', [[eggs, 10]], 100));
  await st('POST', '/api/events', ev('adjust', [[eggs, 6]], 200));
  s = await st('POST', '/api/events', ev('eat', [[eggs, 2]], 300));
  expect(stock(s, 'Eggs')).toBe(4);
  s = await st('POST', '/api/events', ev('buy', [[salt, 1]], 400));
  s = await st('POST', '/api/events', ev('buy', [[salt, 1]], 450));
  expect(stock(s, 'Salt')).toBe(2);
  const reading = ev('eat', [[salt, 0.5]], 500);
  s = await st('POST', '/api/events', reading);
  expect(stock(s, 'Salt')).toBe(1.5);
  s = await st('PATCH', `/api/events/${reading.cid}`, { lines: [{ item_id: salt, qty: 0 }] });
  expect(stock(s, 'Salt')).toBe(1);
  s = await st('DELETE', `/api/events/${reading.cid}`);
  expect(stock(s, 'Salt')).toBe(2);
  s = await st('POST', '/api/events', ev('adjust', [[salt, 2.5]], 600));
  expect(stock(s, 'Salt')).toBe(2.5);
  s = await st('POST', '/api/events', ev('buy', [[salt, 1]], 700));
  expect(stock(s, 'Salt')).toBe(3.5);
  const legacyBuy = ev('buy', [[salt, 1]], 800);
  await st('POST', '/api/events', legacyBuy);
  db.prepare('UPDATE event_lines SET is_set = 1 WHERE event_cid = ?').run(legacyBuy.cid);
  s = await st('POST', '/api/events', ev('buy', [[salt, 1]], 900));
  expect(stock(s, 'Salt')).toBe(2);
  s = await st('PATCH', `/api/events/${legacyBuy.cid}`, { lines: [{ item_id: salt, qty: 1 }] });
  expect(stock(s, 'Salt')).toBe(2);
});

test('the event time is capped at the server clock', async () => {
  const eggs = idOf(await st('GET', '/api/state'), 'Eggs');
  const s = await st('POST', '/api/events', ev('buy', [[eggs, 1]], clock + 999_999));
  expect(s.events[0]!.at).toBe(clock);
});

test('edit replaces lines with the event kind, undo removes the event, repeat is a no-op', async () => {
  let s = await st('GET', '/api/state');
  const eggs = idOf(s, 'Eggs');
  const e = ev('eat', [[eggs, 3]]);
  await st('POST', '/api/events', ev('buy', [[eggs, 10]], 1));
  await st('POST', '/api/events', e);
  s = await st('PATCH', `/api/events/${e.cid}`, { lines: [{ item_id: eggs, qty: 1 }] }, 'bob');
  expect(stock(s, 'Eggs')).toBe(9);
  s = await st('DELETE', `/api/events/${e.cid}`, undefined, 'bob');
  expect(stock(s, 'Eggs')).toBe(10);
  expect(s.events.some(x => x.cid === e.cid)).toBe(false);
  const rev = s.rev;
  expect((await st('DELETE', `/api/events/${e.cid}`)).rev).toBe(rev);
  expect((await req('DELETE', '/api/events/nope')).status).toBe(404);
  expect((await req('PATCH', `/api/events/${e.cid}`, { lines: [{ item_id: eggs, qty: 1 }] })).status).toBe(404);
});

test('unknown and archived items are dropped; no line left is a 400', async () => {
  let s = await st('GET', '/api/state');
  const eggs = idOf(s, 'Eggs');
  const r = await req('POST', '/api/events', ev('buy', [[9999, 1]]));
  expect(r.status).toBe(400);
  expect((await r.json()).error).toBeTruthy();
  s = await st('DELETE', `/api/items/${eggs}`);
  expect(s.items.some(i => i.id === eggs)).toBe(false);
  expect((await req('POST', '/api/events', ev('buy', [[eggs, 1]]))).status).toBe(400);
});

test('usual amount is this user\'s latest eat, per item, undone events skipped', async () => {
  const eggs = idOf(await st('GET', '/api/state'), 'Eggs');
  await st('POST', '/api/events', ev('eat', [[eggs, 2]], 100));
  const later = ev('eat', [[eggs, 3]], 200);
  await st('POST', '/api/events', later);
  await st('POST', '/api/events', ev('eat', [[eggs, 5]], 300), 'bob');
  await st('POST', '/api/events', ev('buy', [[eggs, 12]], 400));
  expect((await st('GET', '/api/state')).usual[eggs]).toBe(3);
  expect((await st('GET', '/api/state', undefined, 'bob')).usual[eggs]).toBe(5);
  const s = await st('DELETE', `/api/events/${later.cid}`);
  expect(s.usual[eggs]).toBe(2);
});

test('item names are unique ignoring case and spacing; patch checks too', async () => {
  const r = await req('POST', '/api/items', item('  eggs '));
  expect(r.status).toBe(409);
  expect((await r.json()).error).toBe('There is already an item called eggs');
  const s = await st('GET', '/api/state');
  expect((await req('PATCH', `/api/items/${idOf(s, 'Salt')}`, { name: 'EGGS' })).status).toBe(409);
  const p = await st('PATCH', `/api/items/${idOf(s, 'Salt')}`, { name: 'Sea salt', low_at: 0.5 });
  expect(p.items.find(i => i.name === 'Sea salt')!.low_at).toBe(0.5);
  expect((await req('PATCH', '/api/items/99', { name: 'x' })).status).toBe(404);
});

test('presets: create, edit, delete, only the owner, unknown items refused', async () => {
  const s0 = await st('GET', '/api/state');
  const [eggs, cheese] = [idOf(s0, 'Eggs'), idOf(s0, 'Cheese')];
  let s = await st('POST', '/api/presets', { name: 'Breakfast', emoji: '🍳', hour: 8, lines: [{ item_id: eggs, qty: 3 }, { item_id: cheese, qty: 1.5 }] });
  const p = s.presets[0]!;
  expect(p.lines).toHaveLength(2);
  expect((await st('GET', '/api/state', undefined, 'bob')).presets).toEqual([]);
  expect((await req('PATCH', `/api/presets/${p.id}`, { name: 'x', emoji: '🍳', hour: 1, lines: [{ item_id: eggs, qty: 1 }] }, 'bob')).status).toBe(404);
  expect((await req('DELETE', `/api/presets/${p.id}`, undefined, 'bob')).status).toBe(404);
  expect((await req('POST', '/api/presets', { name: 'x', emoji: '🍳', hour: 1, lines: [{ item_id: 999, qty: 1 }] })).status).toBe(400);
  s = await st('PATCH', `/api/presets/${p.id}`, { name: 'Brunch', emoji: '🥞', hour: 10, lines: [{ item_id: eggs, qty: 2 }] });
  expect(s.presets[0]).toMatchObject({ name: 'Brunch', hour: 10, lines: [{ item_id: eggs, qty: 2 }] });
  // an event using the preset is marked as such; someone else's preset id is ignored
  s = await st('POST', '/api/events', { ...ev('eat', [[eggs, 2]]), preset_id: p.id });
  expect(s.events[0]).toMatchObject({ source: 'preset', preset_id: p.id });
  s = await st('POST', '/api/events', { ...ev('eat', [[eggs, 1]]), preset_id: p.id }, 'bob');
  expect(s.events[0]).toMatchObject({ source: 'manual', preset_id: null });
  s = await st('DELETE', `/api/presets/${p.id}`);
  expect(s.presets).toEqual([]);
});

test('archiving an item removes it from presets', async () => {
  const s0 = await st('GET', '/api/state');
  const eggs = idOf(s0, 'Eggs');
  await st('POST', '/api/presets', { name: 'B', emoji: '🍳', hour: 8, lines: [{ item_id: eggs, qty: 3 }] });
  expect((await st('DELETE', `/api/items/${eggs}`)).presets[0]!.lines).toEqual([]);
});

test('every mutation raises rev', async () => {
  const s0 = await st('GET', '/api/state');
  const eggs = idOf(s0, 'Eggs');
  const e = ev('buy', [[eggs, 1]]);
  const steps: [string, string, unknown][] = [
    ['POST', '/api/events', e],
    ['PATCH', `/api/events/${e.cid}`, { lines: [{ item_id: eggs, qty: 2 }] }],
    ['DELETE', `/api/events/${e.cid}`, undefined],
    ['POST', '/api/items', item('Milk')],
    ['PATCH', `/api/items/${eggs}`, { emoji: '🍳' }],
    ['POST', '/api/presets', { name: 'P', emoji: '🍳', hour: 1, lines: [{ item_id: eggs, qty: 1 }] }],
    ['PATCH', '/api/me', { emoji: '🐼' }],
    ['DELETE', `/api/items/${eggs}`, undefined],
  ];
  let rev = s0.rev;
  for (const [m, p, b] of steps) {
    const s = await st(m, p, b);
    expect(s.rev, `${m} ${p}`).toBeGreaterThan(rev);
    rev = s.rev;
  }
});

test('me: name clash is a 409', async () => {
  expect((await req('PATCH', '/api/me', { name: 'Bob' })).status).toBe(409);
  expect((await st('PATCH', '/api/me', { name: 'Ally' })).me.name).toBe('Ally');
});

test('bad input answers 400 with a readable message', async () => {
  const r = await req('POST', '/api/items', { name: '' });
  expect(r.status).toBe(400);
  expect((await r.json()).error).toContain('name');
  const bad = await app.request('/api/items', { method: 'POST', headers: { 'X-MyFood': '1', cookie: cookie.alice! }, body: '{nope' });
  expect(bad.status).toBe(400);
});

test('security headers on every response, no-store on the API, API works without a web folder', async () => {
  const r = await app.request('/api/health');
  expect(await r.json()).toEqual({ ok: true, build: 't', ai: null });
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  expect(r.headers.get('referrer-policy')).toBe('same-origin');
  const page = await app.request('/anything');
  expect(page.status).toBe(404);
  expect(page.headers.get('x-content-type-options')).toBe('nosniff');
});

test('ownership: same item name allowed for shared and personal, clashes within same owner', async () => {
  const s0 = await st('GET', '/api/state');
  const aliceId = s0.me.id;
  // Shared "Eggs" already exists; Alice can create personal "Eggs"
  const s1 = await st('POST', '/api/items', { ...item('Eggs'), owner_id: aliceId });
  const personalEggs = s1.items.find(i => i.name === 'Eggs' && i.owner_id === aliceId)!;
  expect(personalEggs).toBeTruthy();

  // Duplicate personal "Eggs" for Alice -> 409
  expect((await req('POST', '/api/items', { ...item('eggs'), owner_id: aliceId })).status).toBe(409);

  // Moving personal "Eggs" to shared clashes with shared "Eggs" -> 409
  expect((await req('PATCH', `/api/items/${personalEggs.id}`, { owner_id: null })).status).toBe(409);

  // Bob can also have personal "Eggs"
  const bobId = s0.users.find(u => u.name === 'Bob')!.id;
  const s2 = await st('POST', '/api/items', { ...item('Eggs'), owner_id: bobId });
  expect(s2.items.filter(i => i.name === 'Eggs')).toHaveLength(3);
});

test('nutrition snapshots on eat, daily_nutrition aggregation, and me/settings updates', async () => {
  const s0 = await st('POST', '/api/items', {
    name: 'Oats', emoji: '🥣', category: 'pantry', unit: 'g', step: 50, pack_size: 1000, low_at: 200,
    kcal_per_unit: 3.7, protein_per_unit: 0.13,
  });
  const oatsId = idOf(s0, 'Oats');
  const s1 = await st('POST', '/api/events', {
    cid: 'nut-eat-1', at: clock, kind: 'eat',
    lines: [{ item_id: oatsId, qty: 100 }],
  });
  expect(s1.events[0]!.lines[0]).toMatchObject({ item_id: oatsId, qty: -100, kcal: 370, protein_g: 13 });
  expect(s1.daily_nutrition).toEqual([{ day: '1970-01-01', user_id: s1.me.id, kcal: 370, protein_g: 13, fat_g: 0, carbs_g: null, value_cents: 0, unpriced: 1 }]);

  // Editing item macros later does not alter historical snapshot
  await st('PATCH', `/api/items/${oatsId}`, { kcal_per_unit: 10 });
  const s2 = await st('GET', '/api/state');
  expect(s2.events[0]!.lines[0]!.kcal).toBe(370);
  expect(s2.daily_nutrition[0]!.kcal).toBe(370);

  // Settings & Me notification toggles
  const s3 = await st('PATCH', '/api/settings', { currency: 'EUR' });
  expect(s3.currency).toBe('EUR');
  const s4 = await st('PATCH', '/api/me', { notify_low: false, notify_expiry: false });
  expect(s4.me).toMatchObject({ notify_low: false, notify_expiry: false });
});

test('expiry updates on buy: sets shelf_life_days or min(existing, new) when in stock', async () => {
  const s0 = await st('POST', '/api/items', {
    name: 'Milk', emoji: '🥛', category: 'dairy', unit: 'ml', step: 100, pack_size: 1000, low_at: 200,
    shelf_life_days: 7,
  });
  const milkId = idOf(s0, 'Milk');

  // Buy with no explicit expires_at uses shelf_life_days (+7d = 1970-01-08)
  let s = await st('POST', '/api/events', { cid: 'exp-buy-1', at: clock, kind: 'buy', lines: [{ item_id: milkId, qty: 1000 }] });
  expect(s.items.find(i => i.id === milkId)!.expires_at).toBe('1970-01-08');

  // Buying a fresher carton (1970-01-12) while in stock keeps earlier 1970-01-08
  s = await st('POST', '/api/events', {
    cid: 'exp-buy-2', at: clock + 1000, kind: 'buy',
    lines: [{ item_id: milkId, qty: 1000, expires_at: '1970-01-12' }],
  });
  expect(s.items.find(i => i.id === milkId)!.expires_at).toBe('1970-01-08');

  // Buying an earlier-expiring carton (1970-01-04) updates to 1970-01-04
  s = await st('POST', '/api/events', {
    cid: 'exp-buy-3', at: clock + 2000, kind: 'buy',
    lines: [{ item_id: milkId, qty: 1000, expires_at: '1970-01-04' }],
  });
  expect(s.items.find(i => i.id === milkId)!.expires_at).toBe('1970-01-04');
});
