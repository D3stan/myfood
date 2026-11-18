import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { sha256 } from '../src/server/auth.ts';
import { defaultBarcodeLookup } from '../src/server/barcodes.ts';
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
    kcal_per_unit: 2.0, protein_per_unit: 0.2, fat_per_unit: 0.15, carbs_per_unit: 0.02,
  });
  const s1 = await st('POST', '/api/items', {
    name: 'Pasta', emoji: '🍝', category: 'pantry', unit: 'g', step: 50, pack_size: 1000, low_at: 200,
    kcal_per_unit: 3.5, protein_per_unit: 0.12, fat_per_unit: 0.01, carbs_per_unit: 0.7,
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

  // Cook 4 portions = 1200g (300g per portion); total kcal = 500*2 + 400*3.5 = 2400; protein = 500*0.2 + 400*0.12 = 148; fat = 500*0.15 + 400*0.01 = 79; carbs = 500*0.02 + 400*0.7 = 290.
  // A typed (wrong) total must lose against the ingredients.
  const cooked = await st('POST', '/api/meals/cook', {
    cid: 'cook-batch-1',
    at: clock,
    name: 'Bolognese',
    emoji: '🍲',
    portions: 4,
    total_g: 1200,
    kcal_total: 99999, protein_total: 99999, fat_total: 99999, carbs_total: 99999,
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
    carbs_per_unit: 0.2417,
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
  expect(afterEat.daily_nutrition).toEqual([{ day: isoDate(clock), user_id: afterEat.me.id, kcal: 600, protein_g: 37, fat_g: 19.7, carbs_g: 72.5, value_cents: 0, unpriced: 1 }]);
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

test('carbs: eat snapshots known carbs, unknown stays null (never 0), daily carbs_g sums only known', async () => {
  await st('POST', '/api/items', { name: 'Rice', emoji: '🍚', category: 'pantry', unit: 'g', step: 50, pack_size: 1000, low_at: null, carbs_per_unit: 0.28 });
  const s1 = await st('POST', '/api/items', { name: 'Zero', emoji: '🧂', category: 'pantry', unit: 'g', step: 50, pack_size: 1000, low_at: null, kcal_per_unit: 1, carbs_per_unit: 0 });
  const s2 = await st('POST', '/api/items', { name: 'Mystery', emoji: '❓', category: 'pantry', unit: 'g', step: 50, pack_size: 1000, low_at: null, kcal_per_unit: 2 });
  const [rice, zero, mystery] = ['Rice', 'Zero', 'Mystery'].map(n => s2.items.find(i => i.name === n)!.id);
  expect(s1.items.find(i => i.name === 'Zero')!.carbs_per_unit).toBe(0);
  expect(s2.items.find(i => i.name === 'Mystery')!.carbs_per_unit).toBeNull();

  // Only an unknown-carbs line today: carbs_g is null, not 0.
  const e1 = await st('POST', '/api/events', { cid: 'carb-eat-1', at: clock, kind: 'eat', lines: [{ item_id: mystery!, qty: 100 }] });
  expect(e1.events[0]!.lines[0]!.carbs_g).toBeUndefined();
  expect(e1.daily_nutrition).toEqual([{ day: isoDate(clock), user_id: e1.me.id, kcal: 200, protein_g: 0, fat_g: 0, carbs_g: null, value_cents: 0, unpriced: 1 }]);

  // A known zero is a real 0; known carbs are summed, the unknown line adds nothing.
  await st('POST', '/api/events', { cid: 'carb-eat-2', at: clock + 1, kind: 'eat', lines: [{ item_id: zero!, qty: 100 }] });
  expect((await st('GET', '/api/state')).daily_nutrition[0]!.carbs_g).toBe(0);
  const e3 = await st('POST', '/api/events', { cid: 'carb-eat-3', at: clock + 2, kind: 'eat', lines: [{ item_id: rice!, qty: 150 }] });
  expect(e3.events.find(e => e.cid === 'carb-eat-3')!.lines[0]!.carbs_g).toBe(42);
  expect(e3.daily_nutrition[0]!.carbs_g).toBe(42);

  // The snapshot survives a later rate change.
  const e4 = await st('PATCH', `/api/items/${rice}`, { carbs_per_unit: 1 });
  expect(e4.daily_nutrition[0]!.carbs_g).toBe(42);
});

test('patchMe goals: set, partial update leaves others, null clears', async () => {
  const s1 = await st('PATCH', '/api/me', { goals: { kcal: 2200, protein_g: 140, fat_g: 70, carbs_g: 250 } });
  expect(s1.me.goals).toEqual({ kcal: 2200, protein_g: 140, fat_g: 70, carbs_g: 250 });
  const s2 = await st('PATCH', '/api/me', { goals: { kcal: 2000, fat_g: null } });
  expect(s2.me.goals).toEqual({ kcal: 2000, protein_g: 140, fat_g: null, carbs_g: 250 });
  expect((await st('GET', '/api/state', undefined, 'bob')).me.goals).toEqual({ kcal: null, protein_g: null, fat_g: null, carbs_g: null });
  expect((await req('PATCH', '/api/me', { goals: { kcal: 0 } })).status).toBe(400);
});

test('barcode lookup parses OpenFoodFacts carbohydrates (per 100g, per serving) and leaves missing as null', async () => {
  const off = (product: Record<string, unknown>) => vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ status: 1, product })));
  try {
    off({ product_name: 'Muesli', quantity: '500 g', nutriments: { 'energy-kcal_100g': 370, carbohydrates_100g: 60.5 } });
    expect((await defaultBarcodeLookup('5701234567890'))!.carbs_per_unit).toBe(0.605);
    off({ product_name: 'Bar', quantity: '3 bars', serving_quantity: 40, nutriments: { carbohydrates_serving: 22.46 } });
    expect((await defaultBarcodeLookup('5701234567891'))!.carbs_per_unit).toBe(22.46);
    off({ product_name: 'Bar2', quantity: '3 bars', serving_quantity: 40, nutriments: { carbohydrates_100g: 50 } });
    expect((await defaultBarcodeLookup('5701234567892'))!.carbs_per_unit).toBe(20);
    off({ product_name: 'Plain', quantity: '1 kg', nutriments: {} });
    expect((await defaultBarcodeLookup('5701234567893'))!.carbs_per_unit).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});

const mk = (name: string, unit: string, extra: Record<string, unknown> = {}) =>
  st('POST', '/api/items', { name, emoji: '🍚', category: 'pantry', unit, step: 1, pack_size: 1, low_at: null, ...extra });
const idOf = (s: State, name: string) => s.items.find(i => i.name === name)!.id;
const priceOf = (s: State, id: number) => s.items.find(i => i.id === id)!.cost_per_unit_cents;
const valueOf = (cid: string) => (db.prepare('SELECT value_cents FROM event_lines WHERE event_cid = ?').get(cid) as { value_cents: number | null }).value_cents;

test('item price: a priced buy learns it, an unpriced buy keeps it, last price wins', async () => {
  const id = idOf(await mk('Rice', 'g'), 'Rice');
  expect(priceOf(await st('GET', '/api/state'), id)).toBeNull();
  await st('POST', '/api/events', { cid: 'price-b1', at: clock - 3000, kind: 'buy', lines: [{ item_id: id, qty: 1000, cost_cents: 2500 }] });
  expect(priceOf(await st('GET', '/api/state'), id)).toBe(2.5);
  await st('POST', '/api/events', { cid: 'price-b2', at: clock - 2000, kind: 'buy', lines: [{ item_id: id, qty: 500 }] });
  expect(priceOf(await st('GET', '/api/state'), id)).toBe(2.5);
  await st('POST', '/api/events', { cid: 'price-b3', at: clock - 1000, kind: 'buy', lines: [{ item_id: id, qty: 500, cost_cents: 1500 }] });
  expect(priceOf(await st('GET', '/api/state'), id)).toBe(3);
});

test('item price: a single line without its own cost takes the event cost; several lines do not', async () => {
  await mk('Milk', 'ml');
  const s = await mk('Oats', 'g');
  const milk = idOf(s, 'Milk'), oat = idOf(s, 'Oats');
  await st('POST', '/api/events', { cid: 'price-q1', at: clock - 3000, kind: 'buy', cost_cents: 1999, lines: [{ item_id: milk, qty: 1000 }] });
  expect(priceOf(await st('GET', '/api/state'), milk)).toBe(1.999);
  await st('POST', '/api/events', { cid: 'price-q2', at: clock - 2000, kind: 'buy', cost_cents: 5000, lines: [{ item_id: milk, qty: 1000 }, { item_id: oat, qty: 500 }] });
  const s2 = await st('GET', '/api/state');
  expect(priceOf(s2, milk)).toBe(1.999);
  expect(priceOf(s2, oat)).toBeNull();
});

test('item price: set/adjust lines, zero cost and level items never learn', async () => {
  await mk('Eggs', 'pc');
  const s = await mk('Olive oil', 'level');
  const pc = idOf(s, 'Eggs'), lvl = idOf(s, 'Olive oil');
  await st('POST', '/api/events', { cid: 'price-a1', at: clock - 3000, kind: 'adjust', lines: [{ item_id: pc, qty: 6, cost_cents: 3000 }] });
  await st('POST', '/api/events', { cid: 'price-a2', at: clock - 2000, kind: 'buy', lines: [{ item_id: pc, qty: 6, cost_cents: 0 }] });
  await st('POST', '/api/events', { cid: 'price-a3', at: clock - 1000, kind: 'buy', lines: [{ item_id: lvl, qty: 1, cost_cents: 4900 }] });
  const s2 = await st('GET', '/api/state');
  expect(priceOf(s2, pc)).toBeNull();
  expect(priceOf(s2, lvl)).toBeNull();
});

test('eating snapshots value_cents from the price; unknown price is null; a later price change leaves history alone', async () => {
  await mk('Eggs', 'pc', { cost_per_unit_cents: 250 });
  const s0 = await mk('Salt', 'pc');
  const eggs = idOf(s0, 'Eggs'), salt = idOf(s0, 'Salt');
  await st('POST', '/api/events', { cid: 'price-e1', at: clock - 2000, kind: 'eat', lines: [{ item_id: eggs, qty: 3 }, { item_id: salt, qty: 1 }] });
  const rows = db.prepare('SELECT item_id, value_cents FROM event_lines WHERE event_cid = ? ORDER BY rowid').all('price-e1');
  expect(rows).toEqual([{ item_id: eggs, value_cents: 750 }, { item_id: salt, value_cents: null }]);
  const s = await st('PATCH', `/api/items/${eggs}`, { cost_per_unit_cents: 400 });
  expect(priceOf(s, eggs)).toBe(400);
  expect(s.events.find(e => e.cid === 'price-e1')!.lines[0]!.value_cents).toBe(750);
  // A new eat uses the new price; editing the old event re-snapshots at the current price (like kcal).
  await st('POST', '/api/events', { cid: 'price-e2', at: clock - 1000, kind: 'eat', lines: [{ item_id: eggs, qty: 1 }] });
  expect(valueOf('price-e2')).toBe(400);
  await st('PATCH', '/api/events/price-e1', { lines: [{ item_id: eggs, qty: 2 }] });
  expect(valueOf('price-e1')).toBe(800);
  // value is not money paid
  expect(db.prepare('SELECT cost_cents FROM events WHERE cid = ?').get('price-e1')).toEqual({ cost_cents: null });
});

test('cook batch: meal price per unit is ingredient prices over the batch, kept when no ingredient is priced', async () => {
  await mk('Beef', 'g', { cost_per_unit_cents: 2 });
  await mk('Pasta', 'g', { cost_per_unit_cents: 1 });
  const s0 = await mk('Water', 'g');
  const beef = idOf(s0, 'Beef'), pasta = idOf(s0, 'Pasta'), plain = idOf(s0, 'Water');
  await st('POST', '/api/events', { cid: 'price-cs', at: clock - 5000, kind: 'buy', lines: [{ item_id: beef, qty: 1000 }, { item_id: pasta, qty: 1000 }, { item_id: plain, qty: 1000 }] });
  // 500*2 + 400*1 = 1400 cents over 1200 g
  const s = await st('POST', '/api/meals/cook', { cid: 'price-ck1', at: clock - 4000, name: 'Bolognese', portions: 4, total_g: 1200, ingredients: [{ item_id: beef, qty: 500 }, { item_id: pasta, qty: 400 }, { item_id: plain, qty: 100 }] });
  const meal = s.items.find(i => i.name === 'Bolognese')!;
  expect(meal.cost_per_unit_cents).toBe(1.1667);
  // The meal buy carries no cost: it neither pays anything nor overwrites the computed price.
  expect(db.prepare('SELECT cost_cents FROM events WHERE cid = ?').get('price-ck1-buy')).toEqual({ cost_cents: null });
  const s2 = await st('POST', '/api/meals/cook', { cid: 'price-ck2', at: clock - 3000, meal_item_id: meal.id, portions: 2, total_g: 600, ingredients: [{ item_id: plain, qty: 100 }] });
  expect(priceOf(s2, meal.id)).toBe(1.1667);
  await st('POST', '/api/events', { cid: 'price-em', at: clock - 1000, kind: 'eat', lines: [{ item_id: meal.id, qty: 300 }] });
  expect(valueOf('price-em')).toBe(350);
});

test('item body accepts and clears cost_per_unit_cents, and rejects negatives', async () => {
  const id = idOf(await mk('Rice', 'g', { cost_per_unit_cents: 3 }), 'Rice');
  expect(priceOf(await st('GET', '/api/state'), id)).toBe(3);
  expect(priceOf(await st('PATCH', `/api/items/${id}`, { cost_per_unit_cents: null }), id)).toBeNull();
  expect((await req('PATCH', `/api/items/${id}`, { cost_per_unit_cents: -1 })).status).toBe(400);
});

test('daily_nutrition value_cents sums eat lines, unpriced counts null ones, a value-only day still has a row', async () => {
  await mk('Eggs', 'pc', { cost_per_unit_cents: 250 });
  const s0 = await mk('Salt', 'pc');
  const eggs = idOf(s0, 'Eggs'), salt = idOf(s0, 'Salt');
  // No macros anywhere: the day exists only because of value / unpriced.
  const s1 = await st('POST', '/api/events', { cid: 'dv-eat-1', at: clock - 2000, kind: 'eat', lines: [{ item_id: eggs, qty: 3 }, { item_id: salt, qty: 1 }] });
  expect(s1.daily_nutrition).toEqual([{ day: isoDate(clock), user_id: s1.me.id, kcal: 0, protein_g: 0, fat_g: 0, carbs_g: null, value_cents: 750, unpriced: 1 }]);
  const s2 = await st('POST', '/api/events', { cid: 'dv-eat-2', at: clock - 1000, kind: 'eat', lines: [{ item_id: eggs, qty: 1 }] });
  expect(s2.daily_nutrition[0]).toMatchObject({ value_cents: 1000, unpriced: 1 });
});

test('barcode lookup hardening: missing quantity keeps 100g macros, parses kJ/serving_size/oz, and uses country locale', async () => {
  const urls: string[] = [];
  let responder: (url: string, attempt: number) => Response = () => new Response(JSON.stringify({ status: 0 }), { status: 404 });
  let calls = 0;
  vi.stubGlobal('fetch', async (input: unknown) => {
    urls.push(String(input));
    calls++;
    return responder(String(input), calls);
  });
  try {
    // 1. Missing quantity + per-100g macros -> switches from dummy 'pc' to 'g' (or 'ml' for drinks) so macros are kept
    responder = () => new Response(JSON.stringify({
      status: 1,
      product: {
        product_name: 'Skyr',
        categories_tags: ['da:mejeri'],
        nutriments: { 'energy-kj_100g': 251.04, proteins_100g: 11, fat_100g: 0.2, carbohydrates_100g: 3.5 },
      },
    }));
    const skyr = (await defaultBarcodeLookup('5700000000001', { country: 'dk' }))!;
    expect(urls.at(-1)).toContain('cc=dk');
    expect(urls.at(-1)).toContain('lc=da');
    expect(skyr.unit).toBe('g');
    expect(skyr.pack_size).toBe(100);
    expect(skyr.category).toBe('dairy');
    expect(skyr.kcal_per_unit).toBe(0.6);
    expect(skyr.protein_per_unit).toBe(0.11);
    expect(skyr.fat_per_unit).toBe(0.002);
    expect(skyr.carbs_per_unit).toBe(0.035);

    // 2. Drink without quantity infers 'ml' and uses localized product_name_da when country is dk
    responder = () => new Response(JSON.stringify({
      status: 1,
      product: {
        product_name_en: 'Apple Juice',
        product_name_da: 'Æblejuice',
        categories_tags: ['en:beverages'],
        nutriments: { 'energy-kcal_value': 45, carbohydrates_value: 10.5 },
      },
    }));
    const juice = (await defaultBarcodeLookup('5700000000002', { country: 'dk' }))!;
    expect(juice.product_name).toBe('Æblejuice');
    expect(juice.unit).toBe('ml');
    expect(juice.kcal_per_unit).toBe(0.45);
    expect(juice.carbs_per_unit).toBe(0.105);

    // 3. Explicit pieces with serving_size string (no serving_quantity) + serving-only g fallback
    responder = () => new Response(JSON.stringify({
      status: 1,
      product: {
        product_name: 'Crispbread',
        quantity: '12 stk',
        serving_size: '1 slice (15 g)',
        nutriments: { 'energy-kcal_100g': 360, proteins_100g: 10, carbohydrates_100g: 60 },
      },
    }));
    const crisp = (await defaultBarcodeLookup('5700000000003'))!;
    expect(crisp.unit).toBe('pc');
    expect(crisp.pack_size).toBe(12);
    expect(crisp.kcal_per_unit).toBe(54);
    expect(crisp.protein_per_unit).toBe(1.5);
    expect(crisp.carbs_per_unit).toBe(9);

    // 4. 12-digit UPC-A retries once on 503 and falls back to zero-padded EAN-13
    calls = 0;
    responder = (url, attempt) => {
      if (attempt === 1) return new Response('busy', { status: 503 });
      if (url.includes('/123456789052.json')) return new Response('missing', { status: 404 });
      expect(url).toContain('/0123456789052.json');
      return new Response(JSON.stringify({
        status: 1,
        product: { product_name: 'US Oats', quantity: '16 oz', serving_size: '40 g', nutriments: { 'energy-kcal_serving': 150, proteins_serving: 5 } },
      }));
    };
    const upc = (await defaultBarcodeLookup('123456789052'))!;
    expect(upc.code).toBe('123456789052');
    expect(upc.unit).toBe('g');
    expect(upc.pack_size).toBeCloseTo(453.592, 2);
    expect(upc.kcal_per_unit).toBe(3.75);
    expect(upc.protein_per_unit).toBe(0.125);

    // 5. Non-mass serving_quantity_unit (tbsp) falls through to serving_size ("1 tbsp (15 g)"), and 100ml infers ml
    responder = () => new Response(JSON.stringify({
      status: 1,
      product: {
        product_name: 'Olive Oil',
        nutrition_data_per: '100ml',
        nutriments: { 'energy-kcal_100g': 822, fat_100g: 91 },
      },
    }));
    const oil = (await defaultBarcodeLookup('5700000000004'))!;
    expect(oil.unit).toBe('ml');
    expect(oil.kcal_per_unit).toBe(8.22);
    expect(oil.fat_per_unit).toBe(0.91);

    responder = () => new Response(JSON.stringify({
      status: 1,
      product: {
        product_name: 'Peanut Butter',
        quantity: '350 g',
        serving_quantity: 1,
        serving_quantity_unit: 'tbsp',
        serving_size: '1 tbsp (15 g)',
        nutriments: { 'energy-kcal_serving': 90, proteins_serving: 3.75 },
      },
    }));
    const pb = (await defaultBarcodeLookup('5700000000005'))!;
    expect(pb.unit).toBe('g');
    expect(pb.kcal_per_unit).toBe(6);
    expect(pb.protein_per_unit).toBe(0.25);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('barcodes: country setting, ?refresh=1, and incomplete-nutrition TTL revalidate cached entries safely', async () => {
  barcodeResult = {
    code: '5709998887771',
    product_name: 'Rye Bread',
    brand: 'Kohberg',
    unit: 'g',
    pack_size: 500,
    kcal_per_unit: null,
    protein_per_unit: null,
    fat_per_unit: null,
    carbs_per_unit: null,
    category: 'bakery',
    source: 'openfoodfacts',
  };

  // First lookup caches product with missing nutrition
  const r1 = (await (await req('GET', '/api/barcodes/5709998887771')).json()) as BarcodeLookup;
  expect(r1.product?.kcal_per_unit).toBeNull();
  expect(barcodeCalls).toHaveLength(1);

  // Within TTL without refresh or country change, serves from cache
  await req('GET', '/api/barcodes/5709998887771');
  expect(barcodeCalls).toHaveLength(1);

  // After 25h, incomplete nutrition entry expires and re-fetches automatically
  clock += 25 * 60 * 60 * 1000;
  barcodeResult = { ...barcodeResult, kcal_per_unit: 2.1, protein_per_unit: 0.06, fat_per_unit: 0.02, carbs_per_unit: 0.39 };
  const r2 = (await (await req('GET', '/api/barcodes/5709998887771')).json()) as BarcodeLookup;
  expect(barcodeCalls).toHaveLength(2);
  expect(r2.product?.kcal_per_unit).toBe(2.1);

  // Complete nutrition stays cached after another 25h, until >30d or ?refresh=1
  clock += 25 * 60 * 60 * 1000;
  await req('GET', '/api/barcodes/5709998887771');
  expect(barcodeCalls).toHaveLength(2);

  barcodeResult = { ...barcodeResult, kcal_per_unit: 2.2 };
  const r2Refresh = (await (await req('GET', '/api/barcodes/5709998887771?refresh=1')).json()) as BarcodeLookup;
  expect(barcodeCalls).toHaveLength(3);
  expect(r2Refresh.product?.kcal_per_unit).toBe(2.2);

  // Changing country setting in /api/settings persists in state and triggers fresh lookup on next scan
  const sCountry = await st('PATCH', '/api/settings', { country: 'DK' });
  expect(sCountry.country).toBe('dk');
  barcodeResult = { ...barcodeResult, product_name: 'Rugbrød' };
  const r3 = (await (await req('GET', '/api/barcodes/5709998887771')).json()) as BarcodeLookup;
  expect(barcodeCalls).toHaveLength(4);
  expect(r3.product?.product_name).toBe('Rugbrød');

  // If a subsequent refresh fails (lookup returns null), cached product is preserved
  barcodeResult = null;
  const r4 = (await (await req('GET', '/api/barcodes/5709998887771?refresh=1')).json()) as BarcodeLookup;
  expect(r4.found).toBe(true);
  expect(r4.product?.product_name).toBe('Rugbrød');
  expect((await req('PATCH', '/api/settings', { country: 'invalid' })).status).toBe(400);

  // Cached OFF entry with product_name: null remains visible (found: true)
  barcodeResult = {
    code: '5709998887772',
    product_name: null,
    brand: 'NoName',
    unit: 'g',
    pack_size: 250,
    kcal_per_unit: 1.5,
    protein_per_unit: 0.05,
    category: 'pantry',
    source: 'openfoodfacts',
  };
  await req('GET', '/api/barcodes/5709998887772');
  const rAnon = (await (await req('GET', '/api/barcodes/5709998887772')).json()) as BarcodeLookup;
  expect(rAnon.found).toBe(true);
  expect(rAnon.product?.brand).toBe('NoName');
});
