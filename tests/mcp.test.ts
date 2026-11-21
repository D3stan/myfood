import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { beforeEach, expect, test } from 'vitest';
import { createApiToken, sha256 } from '../src/server/auth.ts';
import type { BarcodeLookupFn } from '../src/server/barcodes.ts';
import { openDb } from '../src/server/db.ts';
import type { Db } from '../src/server/db.ts';
import type { PushPayload, PushSender } from '../src/server/push.ts';
import { subscribePush } from '../src/server/push.ts';
import { createApp } from '../src/server/routes.ts';
import { isoDate, isoWeek } from '../src/shared/dates.ts';
import type { BarcodeLookup } from '../src/shared/types.ts';

const SECRET = 'test-mcp-secret-0123456789abcdef';

let clock: number;
let db: Db;
let app: ReturnType<typeof createApp>;
let pushed: { endpoint: string; payload: PushPayload }[];
let barcodeResult: BarcodeLookup['product'];

function makeApp(mcpSecret?: string) {
  const sendPush: PushSender = async (sub, payload) => {
    pushed.push({ endpoint: sub.endpoint, payload });
  };
  const lookupBarcode: BarcodeLookupFn = async () => barcodeResult;
  return createApp({
    db,
    runAi: async () => ({ reply: 'ok', events: [] }),
    dataDir: mkdtempSync(join(tmpdir(), 'mf-mcp-')),
    build: 'mcp-test',
    webDir: '/nonexistent',
    now: () => clock,
    sendPush,
    lookupBarcode,
    mcpSecret,
  });
}

async function rpc(
  targetApp: ReturnType<typeof createApp>,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return targetApp.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${SECRET}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function connectClient(targetApp: ReturnType<typeof createApp>, authHeaders: Record<string, string> = {}) {
  const client = new Client({ name: 'mcp-test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      return await targetApp.request(url.pathname + url.search, req);
    },
    requestInit: {
      headers: {
        Authorization: `Bearer ${SECRET}`,
        ...authHeaders,
      },
    },
  });
  await client.connect(transport);
  return { client, transport };
}

function parseJsonResult(res: Awaited<ReturnType<Client['callTool']>>) {
  expect(res.isError).not.toBe(true);
  expect(res.structuredContent).toBeTruthy();
  return res.structuredContent as Record<string, unknown>;
}

beforeEach(() => {
  clock = Date.UTC(2026, 10, 15, 10, 0); // 2026-11-15, ISO week 2026-W46
  db = openDb(':memory:');
  db.prepare('INSERT INTO users(name, emoji, code_hash, created_at) VALUES (?, ?, ?, 0)').run(
    'Alice',
    '🦊',
    sha256('aaaa-aaaa-aaaa'),
  );
  pushed = [];
  barcodeResult = {
    code: '5701234567890',
    product_name: 'Whole Milk 1L',
    brand: 'Arla',
    unit: 'ml',
    pack_size: 1000,
    kcal_per_unit: 0.64,
    protein_per_unit: 0.035,
    category: 'dairy',
    source: 'openfoodfacts',
  };
  app = makeApp(SECRET);
});

test('/mcp auth: 503 when unset, 401 when missing/wrong, 200 on Bearer and x-mcp-secret, 405 on GET/DELETE', async () => {
  const initBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'curl-test', version: '1.0.0' },
    },
  };

  // Disabled (fail closed)
  const disabledApp = makeApp(undefined);
  const r503 = await rpc(disabledApp, initBody);
  expect(r503.status).toBe(503);
  expect(await r503.json()).toEqual({ error: 'MCP server is disabled (MCP_SECRET not set)' });

  const blankApp = makeApp('   ');
  expect((await rpc(blankApp, initBody)).status).toBe(503);

  // Missing secret -> 401 + WWW-Authenticate: Bearer
  const rNoAuth = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(initBody),
  });
  expect(rNoAuth.status).toBe(401);
  expect(rNoAuth.headers.get('www-authenticate')).toBe('Bearer');
  expect(await rNoAuth.json()).toEqual({ error: 'Unauthorized' });

  // Wrong Bearer and wrong x-mcp-secret -> 401
  const rWrongBearer = await rpc(app, initBody, { Authorization: 'Bearer wrong-secret' });
  expect(rWrongBearer.status).toBe(401);
  expect(rWrongBearer.headers.get('www-authenticate')).toBe('Bearer');

  const rWrongHeader = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'x-mcp-secret': 'wrong-secret',
    },
    body: JSON.stringify(initBody),
  });
  expect(rWrongHeader.status).toBe(401);

  // Valid Authorization: Bearer <secret> -> 200 (no cookie or X-MyFood needed)
  const rBearer = await rpc(app, initBody);
  expect(rBearer.status).toBe(200);
  const jBearer = (await rBearer.json()) as { result: { serverInfo: { name: string } } };
  expect(jBearer.result.serverInfo.name).toBe('myfood');

  // Valid x-mcp-secret -> 200
  const rHeader = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'x-mcp-secret': SECRET,
    },
    body: JSON.stringify(initBody),
  });
  expect(rHeader.status).toBe(200);
  const jHeader = (await rHeader.json()) as { result: { serverInfo: { name: string } } };
  expect(jHeader.result.serverInfo.name).toBe('myfood');

  // Authenticated GET and DELETE -> 405 (stateless Streamable HTTP)
  const rGet = await app.request('/mcp', {
    method: 'GET',
    headers: { Authorization: `Bearer ${SECRET}`, Accept: 'text/event-stream' },
  });
  expect(rGet.status).toBe(405);
  expect(rGet.headers.get('allow')).toBe('POST');

  const rDel = await app.request('/mcp', {
    method: 'DELETE',
    headers: { 'x-mcp-secret': SECRET },
  });
  expect(rDel.status).toBe(405);
});

test('/mcp/<secret> path token authenticates header-less clients (claude.ai connectors)', async () => {
  const init = (path: string) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    });
  expect((await init(`/mcp/${SECRET}`)).status).toBe(200);
  expect((await init('/mcp/wrong-secret')).status).toBe(401);
  expect((await init(`/mcp/${SECRET}/extra`)).status).not.toBe(200);
  // Disabled server stays closed even with a path token
  const off = await makeApp(undefined).request(`/mcp/${SECRET}`, { method: 'POST' });
  expect(off.status).toBe(503);
});

test('MCP HTTP initialize + tools/list + full item/event/cook/expense/lock lifecycle', async () => {
  const { client, transport } = await connectClient(app);

  // 1. tools/list exposes all expected tools with valid schemas
  const listed = await client.listTools();
  const names = new Set(listed.tools.map(t => t.name));
  for (const expected of [
    'get_state',
    'list_items',
    'get_item',
    'list_events',
    'list_presets',
    'list_expenses',
    'get_daily_nutrition',
    'query_sql',
    'create_item',
    'update_item',
    'archive_item',
    'log_event',
    'undo_event',
    'edit_event',
    'cook_meal',
    'create_preset',
    'delete_preset',
    'log_preset',
    'add_expense',
    'lock_expense_week',
    'unlock_expense_week',
    'lookup_barcode',
    'link_barcode',
    'set_alias',
    'delete_alias',
    'set_settings',
    'get_settle_up',
    'settle_up',
  ]) {
    expect(names.has(expected), `missing tool ${expected}`).toBe(true);
  }

  // Subscribe Alice to push notifications to verify low-stock crossing triggers push via MCP too
  subscribePush(
    db,
    1,
    { endpoint: 'https://push.example/alice', keys: { p256dh: 'BTestKey1234567890', auth: 'auth123456' } },
    'test-agent',
    clock,
  );

  // 2. Create items & update item
  const beefRes = parseJsonResult(
    await client.callTool({
      name: 'create_item',
      arguments: {
        name: 'Minced Beef',
        emoji: '🥩',
        category: 'meat',
        unit: 'g',
        step: 50,
        pack_size: 500,
        low_at: 200,
        kcal_per_unit: 2.0,
        protein_per_unit: 0.2,
      },
    }),
  );
  const beefId = (beefRes.item as { id: number }).id;
  expect(beefId).toBeGreaterThan(0);

  const eggsRes = parseJsonResult(
    await client.callTool({
      name: 'create_item',
      arguments: {
        name: 'Eggs',
        emoji: '🥚',
        category: 'dairy',
        unit: 'pc',
        step: 1,
        pack_size: 10,
        low_at: 3,
        kcal_per_unit: 78,
        protein_per_unit: 6.3,
      },
    }),
  );
  const eggsId = (eggsRes.item as { id: number }).id;

  const updatedEggs = parseJsonResult(
    await client.callTool({
      name: 'update_item',
      arguments: { item_id: eggsId, low_at: 4, shelf_life_days: 21 },
    }),
  );
  expect((updatedEggs.item as { low_at: number; shelf_life_days: number }).low_at).toBe(4);
  expect((updatedEggs.item as { shelf_life_days: number }).shelf_life_days).toBe(21);

  // 3. Log buy and eat events (verifying expires_at propagation, nutrition, and push crossing)
  const expDate = isoDate(clock + 2 * 86_400_000);
  const buyRes = parseJsonResult(
    await client.callTool({
      name: 'log_event',
      arguments: {
        kind: 'buy',
        cost_cents: 6500,
        expires_at: expDate,
        note: 'Netto run',
        lines: [
          { item_id: beefId, qty: 1000, cost_cents: 4500 },
          { item_id: eggsId, qty: 6, cost_cents: 2000 },
        ],
      },
    }),
  );
  expect((buyRes.event as { cost_cents: number }).cost_cents).toBe(6500);

  // Eat 3 eggs (6 -> 3, crosses low_at=4 and triggers push + nutrition)
  const eatRes = parseJsonResult(
    await client.callTool({
      name: 'log_event',
      arguments: {
        kind: 'eat',
        note: 'Scrambled eggs',
        lines: [{ item_id: eggsId, qty: 3 }],
      },
    }),
  );
  const eatCid = (eatRes.event as { cid: string }).cid;
  expect(pushed).toHaveLength(1);
  expect(pushed[0]!.payload.body).toContain('Eggs');

  // Edit event to 2 eggs, then verify nutrition updates (2 * 78 = 156 kcal, 2 * 6.3 = 12.6 g)
  await client.callTool({
    name: 'edit_event',
    arguments: {
      cid: eatCid,
      lines: [{ item_id: eggsId, qty: 2 }],
      note: 'Two eggs',
    },
  });

  const nutAfterEdit = parseJsonResult(
    await client.callTool({ name: 'get_daily_nutrition', arguments: { days: 7 } }),
  );
  expect((nutAfterEdit.entries as { kcal: number; protein_g: number }[])[0]).toMatchObject({
    kcal: 156,
    protein_g: 12.6,
  });

  // 4. cook_meal (portions + grams) -> consumes 500g beef with counts_nutrition=0, creates Bolognese
  const cookRes = parseJsonResult(
    await client.callTool({
      name: 'cook_meal',
      arguments: {
        name: 'Bolognese',
        emoji: '🍲',
        portions: 4,
        total_g: 1200,
        ingredients: [{ item_id: beefId, qty: 500 }],
      },
    }),
  );
  const mealId = cookRes.meal_item_id as number;
  expect(cookRes.meal_item).toMatchObject({
    id: mealId,
    is_cooked: true,
    unit: 'g',
    portion_g: 300,
    stock: 1200,
    kcal_per_unit: roundTo4(1000 / 1200),
  });

  // Eating 1 portion (300g) of cooked meal adds 250 kcal to daily nutrition
  await client.callTool({
    name: 'log_event',
    arguments: { kind: 'eat', lines: [{ item_id: mealId, qty: 300 }] },
  });
  const nutAfterMeal = parseJsonResult(
    await client.callTool({ name: 'get_daily_nutrition', arguments: { days: 7 } }),
  );
  expect((nutAfterMeal.entries as { kcal: number }[])[0]!.kcal).toBe(156 + 250);

  // 5. list_items filters & get_item
  const lowItems = parseJsonResult(await client.callTool({ name: 'list_items', arguments: { low_only: true } }));
  expect((lowItems.items as { id: number }[]).map(i => i.id)).toContain(eggsId);

  const cookedItems = parseJsonResult(await client.callTool({ name: 'list_items', arguments: { cooked_only: true } }));
  expect((cookedItems.items as { id: number }[]).map(i => i.id)).toEqual([mealId]);

  const expiringItems = parseJsonResult(
    await client.callTool({ name: 'list_items', arguments: { expiring_within_days: 3 } }),
  );
  expect((expiringItems.items as { id: number }[]).map(i => i.id)).toContain(eggsId);

  const itemDetail = parseJsonResult(await client.callTool({ name: 'get_item', arguments: { item_id: mealId } }));
  expect((itemDetail.item as { recipe: { item_id: number; qty: number }[] }).recipe).toEqual([
    { item_id: beefId, qty: 500 },
  ]);

  // 6. Presets (create, list, log, delete)
  const presetCreated = parseJsonResult(
    await client.callTool({
      name: 'create_preset',
      arguments: {
        name: 'Quick Eggs',
        emoji: '🍳',
        hour: 8,
        lines: [{ item_id: eggsId, qty: 1 }],
      },
    }),
  );
  const presetId = (presetCreated.preset as { id: number }).id;

  const presetsListed = parseJsonResult(await client.callTool({ name: 'list_presets', arguments: {} }));
  expect((presetsListed.presets as { id: number }[]).map(p => p.id)).toContain(presetId);

  await client.callTool({ name: 'log_preset', arguments: { preset_id: presetId, multiplier: 1 } });
  const eggsAfterPreset = parseJsonResult(await client.callTool({ name: 'get_item', arguments: { item_id: eggsId } }));
  expect((eggsAfterPreset.item as { stock: number }).stock).toBe(3);

  await client.callTool({ name: 'delete_preset', arguments: { preset_id: presetId } });

  // 7. Barcodes, aliases, settings
  const lookup = parseJsonResult(
    await client.callTool({ name: 'lookup_barcode', arguments: { code: '5701234567890', refresh: true } }),
  );
  expect(lookup.found).toBe(true);
  await client.callTool({ name: 'link_barcode', arguments: { code: '5701234567890', item_id: beefId } });
  await client.callTool({ name: 'set_alias', arguments: { text: 'HAKKET OKSEKØD 500G!', item_id: beefId } });
  await client.callTool({ name: 'delete_alias', arguments: { text: 'HAKKET OKSEKØD 500G!' } });
  const settingsRes = parseJsonResult(
    await client.callTool({
      name: 'set_settings',
      arguments: { currency: 'EUR', country: 'DK', notify_low: false, goals: { kcal: 2100, fat_g: null } },
    }),
  );
  expect(settingsRes.currency).toBe('EUR');
  expect(settingsRes.country).toBe('dk');
  expect((settingsRes.user as { notify_low: boolean }).notify_low).toBe(false);
  expect((settingsRes.user as { goals: unknown }).goals).toEqual({ kcal: 2100, protein_g: null, fat_g: null, carbs_g: null });

  // 8. Expenses & weekly lock enforcement
  const week = isoWeek(clock);
  await client.callTool({
    name: 'add_expense',
    arguments: { cost_cents: 1200, note: 'Bakery coffee' },
  });

  const expList = parseJsonResult(
    await client.callTool({ name: 'list_expenses', arguments: { period: week, format: 'json' } }),
  );
  expect(expList.total_cents).toBe(6500 + 1200);
  expect(expList.is_locked).toBe(false);

  const lockRes = parseJsonResult(
    await client.callTool({ name: 'lock_expense_week', arguments: { period: week, note: 'Settled' } }),
  );
  expect((lockRes.lock as { total_cents: number; event_count: number }).total_cents).toBe(7700);
  expect((lockRes.lock as { event_count: number }).event_count).toBe(2);

  // Adding another expense in the locked week returns an error
  const lockedErr = await client.callTool({
    name: 'add_expense',
    arguments: { cost_cents: 500, note: 'Too late' },
  });
  expect(lockedErr.isError).toBe(true);
  expect((lockedErr.content as { type: string; text: string }[])[0]!.text).toContain('locked');

  // unlocking frees the week again; a second unlock is an error
  const unlockRes = parseJsonResult(await client.callTool({ name: 'unlock_expense_week', arguments: { period: week } }));
  expect(unlockRes.period).toBe(week);
  expect((await client.callTool({ name: 'unlock_expense_week', arguments: { period: week } })).isError).toBe(true);
  parseJsonResult(await client.callTool({ name: 'lock_expense_week', arguments: { period: week, note: 'Settled' } }));

  // 9. get_state (compact & full) + list_events + undo_event + archive_item
  const stateCompact = parseJsonResult(await client.callTool({ name: 'get_state', arguments: { compact: true } }));
  expect(stateCompact.currency).toBe('EUR');
  expect(stateCompact.events).toBeUndefined();

  const eventsList = parseJsonResult(await client.callTool({ name: 'list_events', arguments: { kind: 'eat' } }));
  expect((eventsList.events as unknown[]).length).toBeGreaterThanOrEqual(2);

  await client.callTool({ name: 'undo_event', arguments: { cid: eatCid } });
  await client.callTool({ name: 'archive_item', arguments: { item_id: beefId } });

  await transport.close();
  await client.close();
});

test('query_sql reads across tables, caps rows at 200, and rejects DELETE/DROP/stacked/mutating PRAGMA', async () => {
  // Seed a token & job so we verify query_sql can inspect any table in the DB
  createApiToken(db, 1, 'Siri', clock);
  db.prepare("INSERT INTO jobs(user_id, mode, text, status, created_at) VALUES (1, 'auto', 'bought milk', 'done', ?)").run(clock);

  const { client, transport } = await connectClient(app);

  // Read across multiple tables via WITH / SELECT / PRAGMA / EXPLAIN
  const tablesRes = parseJsonResult(
    await client.callTool({
      name: 'query_sql',
      arguments: {
        sql: "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      },
    }),
  );
  const tableNames = (tablesRes.rows as { name: string }[]).map(r => r.name);
  for (const tbl of [
    'users',
    'items',
    'events',
    'event_lines',
    'presets',
    'preset_lines',
    'aliases',
    'barcodes',
    'meal_recipes',
    'expense_locks',
    'jobs',
    'meta',
    'api_tokens',
    'push_subscriptions',
  ]) {
    expect(tableNames).toContain(tbl);
  }

  const joinRes = parseJsonResult(
    await client.callTool({
      name: 'query_sql',
      arguments: {
        sql: 'WITH t AS (SELECT id, name, prefix FROM api_tokens) SELECT u.name AS user_name, t.prefix FROM t JOIN users u ON u.id = ?',
        params: [1],
      },
    }),
  );
  expect(joinRes.rows).toHaveLength(1);
  expect((joinRes.rows as { user_name: string }[])[0]!.user_name).toBe('Alice');

  const pragmaRes = parseJsonResult(
    await client.callTool({ name: 'query_sql', arguments: { sql: 'PRAGMA table_info(items)' } }),
  );
  expect((pragmaRes.rows as { name: string }[]).map(r => r.name)).toContain('name_key');

  const explainRes = parseJsonResult(
    await client.callTool({ name: 'query_sql', arguments: { sql: 'EXPLAIN QUERY PLAN SELECT * FROM items' } }),
  );
  expect(explainRes.row_count).toBeGreaterThan(0);

  // Row cap at 200
  const capRes = parseJsonResult(
    await client.callTool({
      name: 'query_sql',
      arguments: {
        sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 250) SELECT x FROM c',
      },
    }),
  );
  expect(capRes.row_count).toBe(200);
  expect(capRes.truncated).toBe(true);

  // Guard rejects non-read statements, stacked SQL, EXPLAIN DML, and mutating PRAGMAs
  for (const dangerous of [
    'DELETE FROM users',
    'DROP TABLE items',
    "INSERT INTO meta(key, value) VALUES ('x', 'y')",
    "UPDATE meta SET value = 'USD' WHERE key = 'currency'",
    'SELECT * FROM items; DROP TABLE users;',
    'EXPLAIN DELETE FROM items',
    'PRAGMA writable_schema = ON',
    'PRAGMA user_version = 99',
  ]) {
    const errRes = await client.callTool({ name: 'query_sql', arguments: { sql: dangerous } });
    expect(errRes.isError, `expected rejection for: ${dangerous}`).toBe(true);
  }

  // Confirm DB rows are untouched
  const userCheck = parseJsonResult(
    await client.callTool({ name: 'query_sql', arguments: { sql: 'SELECT COUNT(*) AS n FROM users' } }),
  );
  expect((userCheck.rows as { n: number }[])[0]!.n).toBe(1);

  await transport.close();
  await client.close();
});

test('multi-user household requires user_id for ambiguous mutations and isolates personal items', async () => {
  db.prepare('INSERT INTO users(name, emoji, code_hash, created_at) VALUES (?, ?, ?, 0)').run(
    'Bob',
    '🐻',
    sha256('bbbb-bbbb-bbbb'),
  );
  const { client, transport } = await connectClient(app);

  const milk = parseJsonResult(
    await client.callTool({
      name: 'create_item',
      arguments: { name: 'Oat Milk', category: 'drinks', unit: 'ml', owner_id: 2 },
    }),
  );
  const milkId = (milk.item as { id: number }).id;

  // Omitting user_id when 2 users exist fails clearly instead of guessing wrong user
  const ambiguous = await client.callTool({
    name: 'log_event',
    arguments: { kind: 'buy', lines: [{ item_id: milkId, qty: 1000 }] },
  });
  expect(ambiguous.isError).toBe(true);
  expect((ambiguous.content as { type: string; text: string }[])[0]!.text).toContain('user_id');

  // Explicit user_id works cleanly
  const ok = parseJsonResult(
    await client.callTool({
      name: 'log_event',
      arguments: { user_id: 2, kind: 'buy', lines: [{ item_id: milkId, qty: 1000 }] },
    }),
  );
  expect((ok.event as { user_id: number }).user_id).toBe(2);

  await transport.close();
  await client.close();
});

test('/mcp takes precedence over SPA fallback and rejects session cookies without MCP_SECRET', async () => {
  const webDir = mkdtempSync(join(tmpdir(), 'mf-mcp-web-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'mf-mcp-data-'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><html><body>SPA</body></html>');
  const spaApp = createApp({
    db,
    runAi: async () => ({ reply: 'ok', events: [] }),
    dataDir,
    build: 'mcp-test',
    webDir,
    now: () => clock,
    mcpSecret: SECRET,
  });

  try {
    const spaRes = await spaApp.request('/');
    expect(spaRes.status).toBe(200);
    expect(await spaRes.text()).toContain('SPA');

    // Obtain a real session cookie via /api/login
    const loginRes = await spaApp.request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MyFood': '1' },
      body: JSON.stringify({ code: 'aaaa-aaaa-aaaa' }),
    });
    expect(loginRes.status).toBe(200);
    const setCookie = loginRes.headers.get('set-cookie') ?? '';
    const sidCookie = setCookie.split(';')[0]!;
    expect(sidCookie).toContain('sid=');

    // Session cookie + X-MyFood header alone must NOT authenticate /mcp
    const getNoSecret = await spaApp.request('/mcp', {
      method: 'GET',
      headers: { Cookie: sidCookie, 'X-MyFood': '1' },
    });
    expect(getNoSecret.status).toBe(401);
    expect(getNoSecret.headers.get('www-authenticate')).toBe('Bearer');

    const postNoSecret = await spaApp.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Cookie: sidCookie,
        'X-MyFood': '1',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'spa-check', version: '1.0.0' },
        },
      }),
    });
    expect(postNoSecret.status).toBe(401);

    // Authenticated GET /mcp returns 405 Allow: POST instead of SPA index.html
    const getAuthed = await spaApp.request('/mcp', {
      method: 'GET',
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(getAuthed.status).toBe(405);
    expect(getAuthed.headers.get('allow')).toBe('POST');

    // Authenticated POST /mcp returns MCP JSON-RPC instead of SPA index.html
    const postAuthed = await rpc(spaApp, {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'spa-check', version: '1.0.0' },
      },
    });
    expect(postAuthed.status).toBe(200);
    const body = (await postAuthed.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe('myfood');
  } finally {
    rmSync(webDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('list_expenses CSV export, locked-week edit/undo rejections, and cook_meal portions-only + owner preservation', async () => {
  const { client, transport } = await connectClient(app);

  const oats = parseJsonResult(
    await client.callTool({
      name: 'create_item',
      arguments: {
        name: 'Rolled Oats',
        emoji: '🥣',
        category: 'pantry',
        unit: 'g',
        kcal_per_unit: 3.7,
        protein_per_unit: 0.13,
      },
    }),
  );
  const oatsId = (oats.item as { id: number }).id;

  const buyRes = parseJsonResult(
    await client.callTool({
      name: 'log_event',
      arguments: {
        kind: 'buy',
        cost_cents: 2500,
        note: 'Grocery bag',
        lines: [{ item_id: oatsId, qty: 1000 }],
      },
    }),
  );
  const buyCid = (buyRes.event as { cid: string }).cid;

  const expRes = parseJsonResult(
    await client.callTool({
      name: 'add_expense',
      arguments: { cost_cents: 1000, note: 'Coffee beans' },
    }),
  );
  const expCid = expRes.cid as string;

  const week = isoWeek(clock);
  const csvRes = parseJsonResult(
    await client.callTool({
      name: 'list_expenses',
      arguments: { period: week, format: 'csv' },
    }),
  );
  expect(csvRes.period).toBe(week);
  expect(csvRes.is_locked).toBe(false);
  expect(typeof csvRes.csv).toBe('string');
  expect(csvRes.csv as string).toContain('Grocery bag');
  expect(csvRes.csv as string).toContain('Coffee beans');

  // Lock week and verify edit_event and undo_event are rejected
  await client.callTool({ name: 'lock_expense_week', arguments: { period: week } });

  const editLocked = await client.callTool({
    name: 'edit_event',
    arguments: { cid: buyCid, lines: [{ item_id: oatsId, qty: 1000 }], cost_cents: 2600 },
  });
  expect(editLocked.isError).toBe(true);
  expect((editLocked.content as { type: string; text: string }[])[0]!.text).toContain('locked');

  const undoLocked = await client.callTool({
    name: 'undo_event',
    arguments: { cid: expCid },
  });
  expect(undoLocked.isError).toBe(true);
  expect((undoLocked.content as { type: string; text: string }[])[0]!.text).toContain('locked');

  // Portions-only cook_meal creates pc meal with personal owner_id, and re-cook preserves owner_id when omitted
  const meal1 = parseJsonResult(
    await client.callTool({
      name: 'cook_meal',
      arguments: {
        name: 'Overnight Oats',
        emoji: '🥣',
        owner_id: 1,
        portions: 3,
        ingredients: [{ item_id: oatsId, qty: 300 }],
      },
    }),
  );
  const mealId = meal1.meal_item_id as number;
  expect(meal1.meal_item).toMatchObject({
    id: mealId,
    unit: 'portion',
    stock: 3,
    portions: 3,
    owner_id: 1,
    is_cooked: true,
  });

  const meal2 = parseJsonResult(
    await client.callTool({
      name: 'cook_meal',
      arguments: {
        meal_item_id: mealId,
        portions: 2,
        ingredients: [{ item_id: oatsId, qty: 200 }],
      },
    }),
  );
  expect(meal2.meal_item).toMatchObject({
    id: mealId,
    unit: 'portion',
    stock: 5,
    portions: 5,
    owner_id: 1,
  });

  await transport.close();
  await client.close();
});

test('stdio MCP transport connects against MYFOOD_DB and runs tools end-to-end', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mf-mcp-stdio-'));
  const dbPath = join(tmp, 'myfood.db');
  const seedDb = openDb(dbPath);
  seedDb
    .prepare('INSERT INTO users(name, emoji, code_hash, created_at) VALUES (?, ?, ?, 0)')
    .run('Alice', '🦊', sha256('aaaa-aaaa-aaaa'));
  seedDb.close();

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  env.MYFOOD_DB = dbPath;

  const client = new Client({ name: 'stdio-test-client', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/server/mcp-stdio.ts'],
    cwd: process.cwd(),
    env,
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(38);
    expect(tools.tools.map(t => t.name)).toContain('get_state');
    expect(tools.tools.map(t => t.name)).toContain('query_sql');

    const created = parseJsonResult(
      await client.callTool({
        name: 'create_item',
        arguments: { name: 'Espresso', category: 'drinks', unit: 'ml' },
      }),
    );
    expect((created.item as { name: string }).name).toBe('Espresso');

    const state = parseJsonResult(
      await client.callTool({ name: 'get_state', arguments: { compact: true } }),
    );
    expect((state.items as { name: string }[]).map(i => i.name)).toContain('Espresso');
  } finally {
    await transport.close();
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

function roundTo4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

test('batch_items creates/updates/archives atomically; update_preset merges fields', async () => {
  const { client, transport } = await connectClient(app);
  try {
    const first = parseJsonResult(
      await client.callTool({
        name: 'batch_items',
        arguments: {
          create: [
            { name: 'Oats', category: 'pantry', unit: 'g' },
            { name: 'Milk', category: 'dairy', unit: 'ml', low_at: 500 },
          ],
        },
      }),
    );
    const [oats, milk] = first.created as { id: number; name: string; step: number }[];
    expect(oats!.step).toBe(50);

    // A failing op (unknown id) rolls back the whole batch, including the create before it.
    const bad = await client.callTool({
      name: 'batch_items',
      arguments: { create: [{ name: 'Rice', category: 'pantry', unit: 'g' }], update: [{ item_id: 9999, name: 'X' }] },
    });
    expect(bad.isError).toBe(true);
    expect((bad.content as { text: string }[])[0]!.text).toContain('update[0] (#9999)');
    expect(db.prepare("SELECT COUNT(*) AS n FROM items WHERE name = 'Rice'").get()).toEqual({ n: 0 });

    const mixed = parseJsonResult(
      await client.callTool({
        name: 'batch_items',
        arguments: { update: [{ item_id: oats!.id, kcal_per_unit: 3.8 }], archive: [milk!.id] },
      }),
    );
    expect((mixed.updated as { kcal_per_unit: number }[])[0]!.kcal_per_unit).toBe(3.8);
    expect(mixed.archived_item_ids).toEqual([milk!.id]);

    const created = parseJsonResult(
      await client.callTool({
        name: 'create_preset',
        arguments: { name: 'Porridge', lines: [{ item_id: oats!.id, qty: 80 }] },
      }),
    );
    const presetId = (created.preset as { id: number }).id;
    const upd = parseJsonResult(
      await client.callTool({ name: 'update_preset', arguments: { preset_id: presetId, hour: 7.5 } }),
    );
    expect(upd.preset).toMatchObject({ name: 'Porridge', hour: 7.5, lines: [{ item_id: oats!.id, qty: 80 }] });
  } finally {
    await transport.close();
    await client.close();
  }
});

test('lines accept item names; get_state is compact by default; empty preset gives a clear error', async () => {
  const { client, transport } = await connectClient(app);
  try {
    db.prepare('INSERT INTO users(name, emoji, code_hash, created_at) VALUES (?, ?, ?, 0)').run('Bob', '🐻', sha256('bbbb-bbbb-bbbb'));
    const { created } = parseJsonResult(
      await client.callTool({
        name: 'batch_items',
        arguments: {
          create: [
            { name: 'Eggs', category: 'dairy', unit: 'pc' },
            { name: 'Yogurt', category: 'dairy', unit: 'g', owner_id: 1 },
            { name: 'Yogurt', category: 'dairy', unit: 'g', owner_id: 2 },
          ],
        },
      }),
    ) as { created: { id: number }[] };
    const [eggs, aliceYogurt] = created;

    // Bob's personal Yogurt doesn't make Alice's lookup ambiguous.
    const logged = parseJsonResult(
      await client.callTool({
        name: 'log_event',
        arguments: { user_id: 1, kind: 'buy', lines: [{ item: 'eggs', qty: 6 }, { item: 'Yogurt', qty: 500 }] },
      }),
    );
    expect((logged.event as { lines: { item_id: number }[] }).lines.map(l => l.item_id)).toEqual([eggs!.id, aliceYogurt!.id]);

    const missing = await client.callTool({
      name: 'log_event',
      arguments: { user_id: 1, kind: 'eat', lines: [{ item_id: eggs!.id, qty: 1 }, { item: 'Caviar', qty: 1 }] },
    });
    expect(missing.isError).toBe(true);
    expect((missing.content as { text: string }[])[0]!.text).toBe('lines[1]: No active item called "Caviar"');

    const state = parseJsonResult(await client.callTool({ name: 'get_state', arguments: { user_id: 1 } }));
    expect(state.events).toBeUndefined();
    const full = parseJsonResult(await client.callTool({ name: 'get_state', arguments: { user_id: 1, full: true } }));
    expect(Array.isArray(full.events)).toBe(true);

    const preset = parseJsonResult(
      await client.callTool({ name: 'create_preset', arguments: { user_id: 1, name: 'Eggs', lines: [{ item: 'Eggs', qty: 2 }] } }),
    ).preset as { id: number };
    await client.callTool({ name: 'archive_item', arguments: { item_id: eggs!.id } });
    const empty = await client.callTool({ name: 'update_preset', arguments: { user_id: 1, preset_id: preset.id, hour: 8 } });
    expect((empty.content as { text: string }[])[0]!.text).toBe('Preset has no items left; pass lines');
  } finally {
    await transport.close();
    await client.close();
  }
});

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
};
const addBob = () => db.prepare('INSERT INTO users(name, emoji, code_hash, created_at) VALUES (?, ?, ?, 0)').run('Bob', '🐻', sha256('bbbb-bbbb-bbbb'));

test('/mcp per-user token: works with and without MCP_SECRET; shortcut and revoked tokens stay out; 503/401 split', async () => {
  const { token } = createApiToken(db, 1, 'Claude', clock, 'mcp');
  const { token: shortcutTok } = createApiToken(db, 1, 'Siri', clock);
  for (const a of [app, makeApp(undefined)]) {
    expect((await rpc(a, INIT, { Authorization: `Bearer ${token}` })).status).toBe(200);
    const path = await a.request(`/mcp/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(INIT),
    });
    expect(path.status).toBe(200);
  }
  // shortcut scope never opens /mcp: 401 with a secret set, 503 without
  expect((await rpc(app, INIT, { Authorization: `Bearer ${shortcutTok}` })).status).toBe(401);
  expect((await rpc(makeApp(undefined), INIT, { Authorization: `Bearer ${shortcutTok}` })).status).toBe(503);
  expect((await rpc(app, INIT, { Authorization: 'Bearer mf_nope' })).status).toBe(401);
  // global secret still works
  expect((await rpc(app, INIT)).status).toBe(200);
  db.prepare('UPDATE api_tokens SET revoked_at = 1 WHERE scopes = ?').run('mcp');
  expect((await rpc(app, INIT, { Authorization: `Bearer ${token}` })).status).toBe(401);
});

test('mcp-scoped token is refused by /api routes (Bearer)', async () => {
  const { token } = createApiToken(db, 1, 'Claude', clock, 'mcp');
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  expect((await app.request('/api/shortcut', { method: 'POST', headers: h, body: '{"text":"x"}' })).status).toBe(403);
  expect((await app.request('/api/shortcut/meals', { headers: h })).status).toBe(403);
  expect((await app.request('/api/state', { headers: h })).status).toBe(403);
});

test('POST /api/tokens takes scope (default shortcut, rejects unknown)', async () => {
  const login = await app.request('/api/login', {
    method: 'POST', headers: { 'X-MyFood': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'aaaa-aaaa-aaaa' }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const mk = (body: unknown) => app.request('/api/tokens', {
    method: 'POST', headers: { 'X-MyFood': '1', 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body),
  });
  expect(((await (await mk({ name: 'a' })).json()) as { info: { scopes: string } }).info.scopes).toBe('shortcut');
  expect(((await (await mk({ name: 'b', scope: 'mcp' })).json()) as { info: { scopes: string } }).info.scopes).toBe('mcp');
  expect((await mk({ name: 'c', scope: 'admin' })).status).toBe(400);
});

test('per-user token binds tools to its user: user_id argument is ignored', async () => {
  addBob();
  const { token } = createApiToken(db, 1, 'Alice MCP', clock, 'mcp');
  const { client, transport } = await connectClient(app, { Authorization: `Bearer ${token}` });
  const milk = parseJsonResult(await client.callTool({ name: 'create_item', arguments: { name: 'Milk', category: 'drinks', unit: 'ml' } }));
  const id = (milk.item as { id: number }).id;
  // with 2 users and no user_id the global secret would fail as ambiguous; the token just acts as Alice
  const own = parseJsonResult(await client.callTool({ name: 'log_event', arguments: { kind: 'buy', lines: [{ item_id: id, qty: 5 }] } }));
  expect((own.event as { user_id: number }).user_id).toBe(1);
  // asking to act as Bob (2) still acts as Alice
  const other = parseJsonResult(await client.callTool({ name: 'log_event', arguments: { user_id: 2, kind: 'buy', lines: [{ item_id: id, qty: 5 }] } }));
  expect((other.event as { user_id: number }).user_id).toBe(1);
  // read filters are forced too
  const evs = parseJsonResult(await client.callTool({ name: 'list_events', arguments: { user_id: 2 } }));
  expect((evs.events as { user_id: number }[]).every(e => e.user_id === 1)).toBe(true);
  expect((evs.events as unknown[]).length).toBe(2);
  const nut = parseJsonResult(await client.callTool({ name: 'get_daily_nutrition', arguments: { user_id: 2 } }));
  expect(nut.user_id).toBe(1);
  await transport.close();
  await client.close();
});

test('get_settle_up suggests transfers; settle_up resets them', async () => {
  addBob();
  const { client, transport } = await connectClient(app);
  await client.callTool({ name: 'add_expense', arguments: { user_id: 1, cost_cents: 3000 } });
  const before = parseJsonResult(await client.callTool({ name: 'get_settle_up', arguments: {} }));
  expect(before.since).toBeNull();
  expect(before.transfers).toEqual([]); // nobody ate anything: no debtor
  expect((before.balances as { user_id: number; balance_cents: number }[]).find(b => b.user_id === 1)!.balance_cents).toBe(3000);
  clock += 1000;
  const done = parseJsonResult(await client.callTool({ name: 'settle_up', arguments: { user_id: 2, note: 'cash' } }));
  expect(done.since).toBe(clock);
  const after = parseJsonResult(await client.callTool({ name: 'get_settle_up', arguments: {} }));
  expect(after.since).toBe(clock);
  expect((after.balances as { balance_cents: number }[]).every(b => b.balance_cents === 0)).toBe(true);
  await transport.close();
  await client.close();
});
