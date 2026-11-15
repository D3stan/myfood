import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { sha256 } from '../src/server/auth.ts';
import type { BarcodeLookupFn } from '../src/server/barcodes.ts';
import { openDb } from '../src/server/db.ts';
import type { Db } from '../src/server/db.ts';
import { checkExpiryPushes } from '../src/server/push.ts';
import type { PushPayload, PushSender, VapidConfig } from '../src/server/push.ts';
import { createApp } from '../src/server/routes.ts';
import { isoDate, isoWeek } from '../src/shared/dates.ts';
import type { AiInput, AiResult, BarcodeLookup, State } from '../src/shared/types.ts';

let clock: number;
let db: Db;
let app: ReturnType<typeof createApp>;
let cookie: Record<string, string>;
let pushed: { endpoint: string; payload: PushPayload; vapid: VapidConfig }[];
let pushBehavior: (endpoint: string) => Promise<void>;
let barcodeCalls: string[];
let barcodeResult: BarcodeLookup['product'];
let aiHandler: (input: AiInput) => Promise<AiResult>;

async function req(method: string, path: string, body?: unknown, who = 'alice'): Promise<Response> {
  return app.request(path, {
    method,
    headers: { 'X-MyFood': '1', 'Content-Type': 'application/json', ...(cookie[who] ? { cookie: cookie[who] } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function st(method: string, path: string, body?: unknown, who = 'alice'): Promise<State> {
  const r = await req(method, path, body, who);
  expect(r.status).toBe(200);
  return r.json();
}

beforeEach(async () => {
  clock = Date.UTC(2026, 10, 15, 9, 0); // 2026-11-15 (ISO week 2026-W46)
  db = openDb(':memory:');
  db.prepare('INSERT INTO users(name, emoji, code_hash, created_at) VALUES (?, ?, ?, 0)').run('Alice', '🦊', sha256('aaaa-aaaa-aaaa'));
  db.prepare('INSERT INTO users(name, emoji, code_hash, created_at) VALUES (?, ?, ?, 0)').run('Bob', '🐻', sha256('bbbb-bbbb-bbbb'));

  pushed = [];
  pushBehavior = async () => {};
  const sendPush: PushSender = async (sub, payload, vapid) => {
    await pushBehavior(sub.endpoint);
    pushed.push({ endpoint: sub.endpoint, payload, vapid });
  };

  barcodeCalls = [];
  barcodeResult = null;
  const lookupBarcode: BarcodeLookupFn = async (code) => {
    barcodeCalls.push(code);
    return barcodeResult;
  };

  aiHandler = async () => ({ reply: 'Logged nothing', events: [] });

  app = createApp({
    db,
    runAi: (input) => aiHandler(input),
    dataDir: mkdtempSync(join(tmpdir(), 'mf-feat-')),
    build: 't',
    webDir: '/nonexistent',
    now: () => clock,
    sendPush,
    lookupBarcode,
  });

  cookie = {};
  for (const [who, code] of [['alice', 'aaaa-aaaa-aaaa'], ['bob', 'bbbb-bbbb-bbbb']]) {
    const r = await req('POST', '/api/login', { code }, who!);
    cookie[who!] = r.headers.get('set-cookie')!.split(';')[0]!;
  }
});

test('cook batch: portions+grams computes portion_g, macros from ingredients, counts_nutrition=0, skips usual, saves recipe', async () => {
  const s0 = await st('POST', '/api/items', {
    name: 'Minced beef', emoji: '🥩', category: 'meat', unit: 'g', step: 50, pack_size: 500, low_at: null,
    kcal_per_unit: 2.0, protein_per_unit: 0.2, fat_per_unit: 0.15,
  });
  const s1 = await st('POST', '/api/items', {
    name: 'Pasta', emoji: '🍝', category: 'pantry', unit: 'g', step: 50, pack_size: 1000, low_at: 200,
    kcal_per_unit: 3.5, protein_per_unit: 0.12, fat_per_unit: 0.01,
  });
  const s2 = await st('POST', '/api/items', {
    name: 'Salt', emoji: '🧂', category: 'spices', unit: 'level', step: 0.25, pack_size: 1, low_at: null,
    kcal_per_unit: 500, protein_per_unit: 20,
  });
  const beefId = s1.items.find(i => i.name === 'Minced beef')!.id;
  const pastaId = s1.items.find(i => i.name === 'Pasta')!.id;
  const saltId = s2.items.find(i => i.name === 'Salt')!.id;

  await st('POST', '/api/events', {
    cid: 'seed-cook-1', at: clock - 10_000, kind: 'buy',
    lines: [{ item_id: beefId, qty: 1000 }, { item_id: pastaId, qty: 1000 }, { item_id: saltId, qty: 1.5 }],
  });

  // Cook 4 portions = 1200g (300g per portion); total kcal = 500*2 + 400*3.5 = 2400; protein = 500*0.2 + 400*0.12 = 148; fat = 500*0.15 + 400*0.01 = 79.
  // A typed (wrong) total must lose against the ingredients.
  const cooked = await st('POST', '/api/meals/cook', {
    cid: 'cook-batch-1',
    at: clock,
    name: 'Bolognese',
    emoji: '🍲',
    portions: 4,
    total_g: 1200,
    kcal_total: 99999, protein_total: 99999, fat_total: 99999,
    ingredients: [{ item_id: beefId, qty: 500 }, { item_id: pastaId, qty: 400 }, { item_id: saltId, qty: 0.25 }],
  });

  const meal = cooked.items.find(i => i.name === 'Bolognese')!;
  expect(meal).toMatchObject({
    category: 'meals',
    unit: 'g',
    is_cooked: true,
    portion_g: 300,
    step: 300,
    stock: 1200,
    expires_at: isoDate(clock + 4 * 86_400_000),
    kcal_per_unit: 2,
    protein_per_unit: 0.1233,
    fat_per_unit: 0.0658,
    recipe: [{ item_id: beefId, qty: 500 }, { item_id: pastaId, qty: 400 }],
  });
  expect(cooked.items.find(i => i.id === beefId)!.stock).toBe(500);
  expect(cooked.items.find(i => i.id === pastaId)!.stock).toBe(600);
  expect(cooked.items.find(i => i.id === saltId)!.stock).toBe(1.5);
  // Raw ingredients consumed with source='cook' do NOT count as eaten nutrition or usual
  expect(cooked.daily_nutrition).toEqual([]);
  expect(cooked.usual[beefId]).toBeUndefined();
  expect(cooked.usual[pastaId]).toBeUndefined();

  // Eating 1 portion (300g) of the cooked meal DOES count toward daily_nutrition and usual
  const afterEat = await st('POST', '/api/events', {
    cid: 'eat-meal-1', at: clock + 1000, kind: 'eat',
    lines: [{ item_id: meal.id, qty: 300 }],
  });
  expect(afterEat.items.find(i => i.id === meal.id)!.stock).toBe(900);
  expect(afterEat.usual[meal.id]).toBe(300);
  expect(afterEat.daily_nutrition).toEqual([{ day: isoDate(clock), user_id: afterEat.me.id, kcal: 600, protein_g: 37, fat_g: 19.7 }]);
  expect(s0.rev).toBeLessThan(afterEat.rev);

  // Archiving an ingredient prunes it from meal_recipes so cookSheet has no stale Unknown line
  const afterArchiveIng = await st('DELETE', `/api/items/${pastaId}`);
  expect(afterArchiveIng.items.find(i => i.id === meal.id)!.recipe).toEqual([{ item_id: beefId, qty: 500 }]);
});

test('cook batch: portions-only and grams-only modes + manual macro override', async () => {
  const s = await st('POST', '/api/meals/cook', {
    cid: 'cook-port-1', at: clock, name: 'Soup', portions: 3, kcal_total: 900, protein_total: 45, ingredients: [],
  });
  const soup = s.items.find(i => i.name === 'Soup')!;
  expect(soup).toMatchObject({ unit: 'portion', portion_g: null, stock: 3, kcal_per_unit: 300, protein_per_unit: 15 });

  const s2 = await st('POST', '/api/meals/cook', {
    cid: 'cook-gram-1', at: clock, name: 'Chili', total_g: 800, ingredients: [],
  });
  const chili = s2.items.find(i => i.name === 'Chili')!;
  expect(chili).toMatchObject({ unit: 'g', portion_g: null, stock: 800, is_cooked: true });

  expect((await req('POST', '/api/meals/cook', { cid: 'bad-cook', at: clock, name: 'X', ingredients: [] })).status).toBe(400);
});

test('expenses, weekly locks (409 enforcement), and formula-safe CSV/JSON export', async () => {
  const s0 = await st('POST', '/api/items', {
    name: 'Coffee', emoji: '☕', category: 'drinks', unit: 'g', step: 50, pack_size: 500, low_at: null,
  });
  const coffeeId = s0.items[0]!.id;
  const week = isoWeek(clock);

  await st('POST', '/api/events', {
    cid: 'cost-ev-1', at: clock, kind: 'buy', cost_cents: 4500, note: '=SUM(A1:A2)',
    lines: [{ item_id: coffeeId, qty: 500, cost_cents: 4500 }],
  });
  const s1 = await st('POST', '/api/expenses', {
    cid: 'exp-only-1', at: clock + 1000, cost_cents: 12050, note: '+Grocery delivery',
  }, 'bob');
  expect(s1.expenses).toHaveLength(2);

  // Lock the week
  const locked = await st('POST', '/api/expenses/lock', { period: week, note: 'Settled' });
  expect(locked.expense_locks[0]).toMatchObject({ period: week, total_cents: 16550, event_count: 2, note: 'Settled' });

  // Double-lock -> 409
  expect((await req('POST', '/api/expenses/lock', { period: week })).status).toBe(409);

  // Creating, editing, or undoing a cost event in the locked week -> 409
  expect((await req('POST', '/api/expenses', { cid: 'exp-locked', at: clock + 2000, cost_cents: 500 })).status).toBe(409);
  expect((await req('POST', '/api/events', {
    cid: 'cost-locked', at: clock + 2000, kind: 'buy', cost_cents: 1000, lines: [{ item_id: coffeeId, qty: 500 }],
  })).status).toBe(409);
  expect((await req('PATCH', '/api/events/cost-ev-1', { lines: [{ item_id: coffeeId, qty: 250 }] })).status).toBe(409);
  expect((await req('DELETE', '/api/events/cost-ev-1')).status).toBe(409);

  // Non-cost event in locked week still succeeds!
  expect((await req('POST', '/api/events', {
    cid: 'free-event-1', at: clock + 2000, kind: 'eat', lines: [{ item_id: coffeeId, qty: 50 }],
  })).status).toBe(200);

  // CSV export neutralizes formula triggers (= and +)
  const csvRes = await req('GET', `/api/expenses/export?period=${week}&format=csv`);
  expect(csvRes.status).toBe(200);
  expect(csvRes.headers.get('content-type')).toContain('text/csv');
  const csv = await csvRes.text();
  expect(csv).toContain("'=SUM(A1:A2)");
  expect(csv).toContain("'+Grocery delivery");

  // JSON export
  const jsonRes = await req('GET', `/api/expenses/export?period=${week}&format=json`);
  expect(jsonRes.status).toBe(200);
  const json = (await jsonRes.json()) as { period: string; expenses: { cost_cents: number }[] };
  expect(json.period).toBe(week);
  expect(json.expenses).toHaveLength(2);
});

test('barcodes: lookup caches in DB, fuzzy-matches existing item, and links explicitly', async () => {
  await st('POST', '/api/items', {
    name: 'Oat Milk', emoji: '🥛', category: 'drinks', unit: 'ml', step: 100, pack_size: 1000, low_at: 200,
  });

  barcodeResult = {
    code: '5701234567890',
    product_name: 'Organic Oat Milk Barista',
    brand: 'Oatly',
    unit: 'ml',
    pack_size: 1000,
    kcal_per_unit: 0.59,
    protein_per_unit: 0.01,
    category: 'drinks',
    source: 'openfoodfacts',
  };

  // First lookup hits lookupBarcode and fuzzy-matches "Oat Milk"
  const r1 = await req('GET', '/api/barcodes/5701234567890');
  expect(r1.status).toBe(200);
  const b1 = (await r1.json()) as BarcodeLookup;
  expect(b1.found).toBe(true);
  expect(b1.item_id).toBeTruthy();
  expect(b1.product?.brand).toBe('Oatly');
  expect(barcodeCalls).toHaveLength(1);

  // Second lookup serves from DB cache without calling lookupBarcode again
  const r2 = await req('GET', '/api/barcodes/5701234567890');
  expect(r2.status).toBe(200);
  expect(barcodeCalls).toHaveLength(1);

  // Explicit link to another item
  const sMilk = await st('POST', '/api/items', {
    name: 'Whole Milk', emoji: '🥛', category: 'dairy', unit: 'ml', step: 100, pack_size: 1000, low_at: null,
  });
  const wholeMilkId = sMilk.items.find(i => i.name === 'Whole Milk')!.id;
  await st('POST', '/api/barcodes/link', { code: '5701234567890', item_id: wholeMilkId });

  const b3 = (await (await req('GET', '/api/barcodes/5701234567890')).json()) as BarcodeLookup;
  expect(b3.item_id).toBe(wholeMilkId);

  expect((await req('GET', '/api/barcodes/not-digits')).status).toBe(400);
  expect((await req('POST', '/api/barcodes/link', { code: '5701234567890', item_id: 99999 })).status).toBe(404);
});

test('web push: VAPID persisted, low-stock crossing & expiry pushes respect owner/prefs/dedupe & prune 410', async () => {
  const s0 = await st('GET', '/api/state');
  expect(s0.vapid_public_key).toBeTruthy();
  expect(s0.push_subscribed).toBe(false);

  // Subscribe Alice and Bob
  const subA = await st('POST', '/api/push/subscribe', {
    endpoint: 'https://push.example/alice',
    keys: { p256dh: 'BAliceKey0000000000000', auth: 'AliceAuth1' },
  }, 'alice');
  expect(subA.push_subscribed).toBe(true);
  await st('POST', '/api/push/subscribe', {
    endpoint: 'https://push.example/bob',
    keys: { p256dh: 'BBobKey000000000000000', auth: 'BobAuth001' },
  }, 'bob');

  // Test push
  const testRes = await req('POST', '/api/push/test', {}, 'alice');
  expect(testRes.status).toBe(200);
  expect(await testRes.json()).toEqual({ ok: true, sent: 1, pruned: 0 });
  expect(pushed).toHaveLength(1);
  pushed = [];

  // Shared item with low_at=2, expires in 1 day; Personal item for Alice with low_at=1
  await st('POST', '/api/items', {
    name: 'Eggs', emoji: '🥚', category: 'dairy', unit: 'pc', step: 1, pack_size: 10, low_at: 2,
    expires_at: isoDate(clock + 86_400_000),
  });
  const sItems = await st('POST', '/api/items', {
    name: 'Protein bar', emoji: '🍫', category: 'pantry', unit: 'pc', step: 1, pack_size: 12, low_at: 1,
    owner_id: s0.me.id,
  });
  const eggsId = sItems.items.find(i => i.name === 'Eggs')!.id;
  const barId = sItems.items.find(i => i.name === 'Protein bar')!.id;
  const saltState = await st('POST', '/api/items', {
    name: 'Salt', emoji: '🧂', category: 'spices', unit: 'level', step: 0.25, pack_size: 1, low_at: 0.25,
  });
  const saltId = saltState.items.find(i => i.name === 'Salt')!.id;

  // Buy above low_at
  await st('POST', '/api/events', {
    cid: 'push-seed', at: clock, kind: 'buy',
    lines: [{ item_id: eggsId, qty: 5 }, { item_id: barId, qty: 3 }, { item_id: saltId, qty: 1.25 }],
  });
  expect(pushed).toHaveLength(0);

  await st('POST', '/api/events', { cid: 'push-level-out', at: clock + 500, kind: 'eat', lines: [{ item_id: saltId, qty: 0 }] });
  expect((await st('GET', '/api/state')).items.find(i => i.id === saltId)!.stock).toBe(1);
  expect(pushed).toHaveLength(0);

  // Bob disables notify_low
  await st('PATCH', '/api/me', { notify_low: false }, 'bob');

  // Cross low_at on shared Eggs (5 -> 2) and personal Protein bar (3 -> 1)
  await st('POST', '/api/events', {
    cid: 'push-cross-1', at: clock + 1000, kind: 'eat',
    lines: [{ item_id: eggsId, qty: 3 }, { item_id: barId, qty: 2 }],
  });
  // Only Alice gets notified (Bob has notify_low=false; Protein bar is Alice's personal item anyway)
  expect(pushed.filter(p => p.endpoint === 'https://push.example/alice')).toHaveLength(2);
  expect(pushed.filter(p => p.endpoint === 'https://push.example/bob')).toHaveLength(0);

  // Crossing again same day is deduped via push_log
  pushed = [];
  await st('POST', '/api/events', {
    cid: 'push-refill', at: clock + 2000, kind: 'buy', lines: [{ item_id: eggsId, qty: 5 }],
  });
  await st('POST', '/api/events', {
    cid: 'push-cross-2', at: clock + 3000, kind: 'eat', lines: [{ item_id: eggsId, qty: 5 }],
  });
  expect(pushed).toHaveLength(0);

  // Expiry check: Eggs has stock=2 and expires in 1 day (<=2). Both Alice and Bob have notify_expiry=1.
  // Simulate Bob's endpoint returning HTTP 410 Gone -> pruned!
  pushBehavior = async (ep) => {
    if (ep.endsWith('/bob')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
  };
  const expRes1 = await checkExpiryPushes(db, async (sub, payload, vapid) => {
    await pushBehavior(sub.endpoint);
    pushed.push({ endpoint: sub.endpoint, payload, vapid });
  }, clock);
  expect(expRes1).toEqual({ sent: 1, pruned: 1 });
  expect(pushed[0]!.payload.title).toBe('Expiring soon');
  expect((await st('GET', '/api/state', undefined, 'bob')).push_subscribed).toBe(false);

  // Second expiry check same day is deduped
  const expRes2 = await checkExpiryPushes(db, async (sub, payload, vapid) => {
    pushed.push({ endpoint: sub.endpoint, payload, vapid });
  }, clock + 60_000);
  expect(expRes2).toEqual({ sent: 0, pruned: 0 });

  // Unsubscribe Alice
  const unsub = await app.request('/api/push/subscribe', {
    method: 'DELETE',
    headers: { 'X-MyFood': '1', 'Content-Type': 'application/json', cookie: cookie.alice! },
    body: JSON.stringify({ endpoint: 'https://push.example/alice' }),
  });
  expect(((await unsub.json()) as State).push_subscribed).toBe(false);
});

test('shortcut: fast preset match skips AI; freeform text invokes runShortcutAi', async () => {
  const s0 = await st('POST', '/api/items', {
    name: 'Eggs', emoji: '🥚', category: 'dairy', unit: 'pc', step: 1, pack_size: 10, low_at: null,
  });
  const eggsId = s0.items[0]!.id;
  await st('POST', '/api/events', { cid: 'sc-seed-1', at: clock, kind: 'buy', lines: [{ item_id: eggsId, qty: 10 }] });
  await st('POST', '/api/presets', { name: 'Morning', emoji: '🍳', hour: 8, lines: [{ item_id: eggsId, qty: 2 }] });
  const tok = (await (await req('POST', '/api/tokens', { name: 'Shortcut' })).json()) as { token: string };

  let aiCalls = 0;
  aiHandler = async () => {
    aiCalls++;
    return {
      reply: 'Logged 1 egg',
      events: [{ kind: 'eat', preset_id: null, lines: [{ item_id: eggsId, new_item: null, qty: 1, raw: null }] }],
    };
  };

  // Fast preset match by name (via text) does NOT invoke AI
  const r1 = await app.request('/api/shortcut', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'morning' }),
  });
  expect(r1.status).toBe(200);
  expect(await r1.json()).toMatchObject({ ok: true, reply: 'Logged Morning' });
  expect(aiCalls).toBe(0);
  expect((await st('GET', '/api/state')).items[0]!.stock).toBe(8);

  // Non-preset text calls runShortcutAi
  const r2 = await app.request('/api/shortcut', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'ate 1 egg' }),
  });
  expect(r2.status).toBe(200);
  const b2 = (await r2.json()) as { ok: boolean; reply: string; event_ids: number[] };
  expect(b2.ok).toBe(true);
  expect(b2.reply).toBe('Logged 1 egg');
  expect(b2.event_ids).toHaveLength(1);
  expect(aiCalls).toBe(1);
  expect((await st('GET', '/api/state')).items[0]!.stock).toBe(7);
});

test('shortcut modes: ai always asks the AI; log matches presets and cooked meals, fuzzily, or guesses by time', async () => {
  const s0 = await st('POST', '/api/items', { name: 'Eggs', emoji: '🥚', category: 'dairy', unit: 'pc', step: 1, pack_size: 10, low_at: null });
  const eggsId = s0.items[0]!.id;
  await st('POST', '/api/events', { cid: 'sc-seed-2', at: clock, kind: 'buy', lines: [{ item_id: eggsId, qty: 10 }] });
  await st('POST', '/api/presets', { name: 'Morning', emoji: '🍳', hour: 8, lines: [{ item_id: eggsId, qty: 2 }] });
  await st('POST', '/api/meals/cook', { cid: 'sc-cook-1', at: clock, name: 'Chili', portions: 4, total_g: 1200, ingredients: [] });
  const tok = (await (await req('POST', '/api/tokens', { name: 'Shortcut' })).json()) as { token: string };
  const sc = (method: string, path: string, body?: unknown) => app.request(path, {
    method, headers: { Authorization: `Bearer ${tok.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });

  let aiCalls = 0;
  aiHandler = async () => { aiCalls++; return { reply: 'AI said hi', events: [] }; };
  // text equal to a preset name still goes to the AI in mode ai
  expect(await (await sc('POST', '/api/shortcut', { mode: 'ai', text: 'morning' })).json()).toMatchObject({ reply: 'AI said hi' });
  expect(aiCalls).toBe(1);
  expect((await sc('POST', '/api/shortcut', { mode: 'ai' })).status).toBe(400);

  // list for "Choose from List"
  expect(await (await sc('GET', '/api/shortcut/meals')).json()).toEqual({ ok: true, meals: ['Morning', 'Chili'], suggested: 'Morning' });
  // a token with the shortcut scope still cannot read the state
  expect((await sc('GET', '/api/state')).status).toBe(403);

  // fuzzy preset, then empty = guess, then cooked meal (1 portion = 300 g), then nothing found
  expect(await (await sc('POST', '/api/shortcut', { mode: 'log', meal: 'my morning' })).json()).toMatchObject({ reply: 'Logged Morning' });
  expect(await (await sc('POST', '/api/shortcut', { mode: 'log' })).json()).toMatchObject({ reply: 'Logged Morning' });
  expect(await (await sc('POST', '/api/shortcut', { mode: 'log', meal: 'chili', portions: 2 })).json()).toMatchObject({ reply: 'Logged Chili' });
  expect((await sc('POST', '/api/shortcut', { mode: 'log', meal: 'sushi' })).status).toBe(404);
  const s = await st('GET', '/api/state');
  expect(s.items.find(i => i.id === eggsId)!.stock).toBe(6);
  expect(s.items.find(i => i.name === 'Chili')!.stock).toBe(600);
  expect(aiCalls).toBe(1);
});
