import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { newCode, sha256 } from '../src/server/auth.ts';
import { openDb } from '../src/server/db.ts';
import { createApp } from '../src/server/routes.ts';

function setup(opts: { webDir?: string; insecureCookies?: boolean } = {}) {
  const state = { now: 10_000_000 };
  const db = openDb(':memory:');
  db.prepare('INSERT INTO users(name, emoji, code_hash, created_at) VALUES (?, ?, ?, 0)').run('Alice', '🦊', sha256('aaaa-aaaa-aaaa'));
  const app = createApp({
    db, runAi: async () => { throw new Error('x'); }, dataDir: mkdtempSync(join(tmpdir(), 'mf-')), build: 't',
    webDir: opts.webDir ?? '/nonexistent', now: () => state.now, insecureCookies: opts.insecureCookies,
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { 'X-MyFood': '1', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { app, db, state, post };
}

test('login: success sets a hardened cookie, the session works, logout ends it', async () => {
  const { app, db, post } = setup();
  const r = await post('/api/login', { code: '  AAAA-aaaa-AAAA ' });
  expect(r.status).toBe(200);
  const setCookie = r.headers.get('set-cookie')!;
  expect(setCookie).toMatch(/^sid=[\w-]{43};/);
  for (const part of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=31536000', 'Secure']) expect(setCookie).toContain(part);
  const sid = setCookie.split(';')[0]!;
  const token = sid.slice(4);
  // only the hash is stored
  expect((db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string }).token_hash).toBe(sha256(token));
  expect((await app.request('/api/state', { headers: { cookie: sid } })).status).toBe(200);
  expect((await post('/api/logout', {}, { cookie: sid })).status).toBe(200);
  expect((await app.request('/api/state', { headers: { cookie: sid } })).status).toBe(401);
});

test('INSECURE_COOKIES drops Secure', async () => {
  const { post } = setup({ insecureCookies: true });
  expect((await post('/api/login', { code: 'aaaa-aaaa-aaaa' })).headers.get('set-cookie')).not.toContain('Secure');
});

test('wrong code is 401 with a message', async () => {
  const { post } = setup();
  const r = await post('/api/login', { code: 'zzzz-zzzz-zzzz' });
  expect(r.status).toBe(401);
  expect((await r.json()).error).toBeTruthy();
  expect((await post('/api/login', { code: 'x' })).status).toBe(400);
});

test('throttle: five failures a minute per client, then 429 even for the right code; other clients and later minutes are fine', async () => {
  const { post, state } = setup();
  const cf = (ip: string) => ({ 'CF-Connecting-IP': ip });
  for (let i = 0; i < 5; i++) expect((await post('/api/login', { code: 'zzzz-zzzz-zzzz' }, cf('1.1.1.1'))).status).toBe(401);
  expect((await post('/api/login', { code: 'zzzz-zzzz-zzzz' }, cf('1.1.1.1'))).status).toBe(429);
  expect((await post('/api/login', { code: 'aaaa-aaaa-aaaa' }, cf('1.1.1.1'))).status).toBe(429);
  expect((await post('/api/login', { code: 'aaaa-aaaa-aaaa' }, cf('2.2.2.2'))).status).toBe(200);
  state.now += 61_000;
  expect((await post('/api/login', { code: 'aaaa-aaaa-aaaa' }, cf('1.1.1.1'))).status).toBe(200);
});

test('no session is 401; missing X-MyFood on a write is 400; health is open', async () => {
  const { app, post } = setup();
  expect((await app.request('/api/state')).status).toBe(401);
  expect((await app.request('/api/state', { headers: { cookie: 'sid=garbage' } })).status).toBe(401);
  expect((await app.request('/api/health')).status).toBe(200);
  const sid = (await post('/api/login', { code: 'aaaa-aaaa-aaaa' })).headers.get('set-cookie')!.split(';')[0]!;
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const r = await app.request('/api/items/1', { method, headers: { cookie: sid, 'Content-Type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' });
    expect(r.status, method).toBe(400);
  }
  expect((await app.request('/api/login', { method: 'POST', body: '{}' })).status).toBe(400);
  expect((await app.request('/api/nothing', { headers: { cookie: sid } })).status).toBe(404);
});

test('the cookie is renewed at most once a day', async () => {
  const { app, state, post } = setup();
  const sid = (await post('/api/login', { code: 'aaaa-aaaa-aaaa' })).headers.get('set-cookie')!.split(';')[0]!;
  const get = () => app.request('/api/state', { headers: { cookie: sid } });
  expect((await get()).headers.get('set-cookie')).toBeNull();
  state.now += 86_400_000 + 1;
  expect((await get()).headers.get('set-cookie')).toContain(sid);
  expect((await get()).headers.get('set-cookie')).toBeNull();
});

test('access codes look right', () => {
  for (let i = 0; i < 50; i++) expect(newCode()).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{4}(-[abcdefghjkmnpqrstuvwxyz23456789]{4}){2}$/);
});

test('static files: index fallback, cache headers, no path traversal', async () => {
  const web = mkdtempSync(join(tmpdir(), 'mf-web-'));
  mkdirSync(join(web, 'assets'));
  writeFileSync(join(web, 'index.html'), '<h1>hi</h1>');
  writeFileSync(join(web, 'assets', 'a.js'), 'x');
  writeFileSync(join(web, 'build.txt'), 'b1');
  const { app } = setup({ webDir: web });
  const root = await app.request('/some/route');
  expect(await root.text()).toBe('<h1>hi</h1>');
  expect(root.headers.get('cache-control')).toBe('no-cache');
  expect(root.headers.get('content-type')).toContain('text/html');
  const asset = await app.request('/assets/a.js');
  expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(asset.headers.get('content-type')).toContain('javascript');
  expect((await app.request('/build.txt')).headers.get('cache-control')).toBe('no-cache');
  expect(await (await app.request('/..%2f..%2fetc/passwd')).text()).toBe('<h1>hi</h1>');
  expect((await app.request('/api/state')).status).toBe(401);
});

test('api tokens: create, bearer auth bypasses cookie & X-MyFood, enforces shortcut scope, revoke', async () => {
  const { app, db, state, post } = setup();
  const sid = (await post('/api/login', { code: 'aaaa-aaaa-aaaa' })).headers.get('set-cookie')!.split(';')[0]!;

  // Create preset & item so /api/shortcut has something to match
  const itemRes = await post('/api/items', { name: 'Eggs', emoji: '🥚', category: 'dairy', unit: 'pc', step: 1, pack_size: 10, low_at: null }, { cookie: sid });
  expect(itemRes.status).toBe(200);
  const itemId = ((await itemRes.json()) as { items: { id: number }[] }).items[0]!.id;
  await post('/api/presets', { name: 'Breakfast', emoji: '🍳', hour: 8, lines: [{ item_id: itemId, qty: 2 }] }, { cookie: sid });

  const tokRes = await post('/api/tokens', { name: 'iPhone Siri' }, { cookie: sid });
  expect(tokRes.status).toBe(200);
  const tokBody = (await tokRes.json()) as { token: string; info: { id: number; name: string; prefix: string; scopes: string }; state: { tokens: unknown[] } };
  expect(tokBody.token).toMatch(/^mf_/);
  expect(tokBody.info).toMatchObject({ name: 'iPhone Siri', scopes: 'shortcut' });
  expect(tokBody.state.tokens).toHaveLength(1);
  // Plaintext token is not stored in DB
  expect((db.prepare('SELECT token_hash FROM api_tokens WHERE id = ?').get(tokBody.info.id) as { token_hash: string }).token_hash).toBe(sha256(tokBody.token));

  // Bearer token works WITHOUT cookie and WITHOUT X-MyFood on POST /api/shortcut & GET /api/health
  const health = await app.request('/api/health', { headers: { Authorization: `Bearer ${tokBody.token}` } });
  expect(health.status).toBe(200);

  state.now += 5000;
  const sc = await app.request('/api/shortcut', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokBody.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ preset: 'Breakfast' }),
  });
  expect(sc.status).toBe(200);
  expect(await sc.json()).toMatchObject({ ok: true, reply: 'Logged Breakfast' });

  // last_used_at updated
  const row = db.prepare('SELECT last_used_at FROM api_tokens WHERE id = ?').get(tokBody.info.id) as { last_used_at: number };
  expect(row.last_used_at).toBe(state.now);

  // Scopes='shortcut' returns 403 on other routes
  expect((await app.request('/api/state', { headers: { Authorization: `Bearer ${tokBody.token}` } })).status).toBe(403);
  expect((await app.request('/api/items', { method: 'POST', headers: { Authorization: `Bearer ${tokBody.token}`, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);

  // Invalid bearer token -> 401
  expect((await app.request('/api/shortcut', { method: 'POST', headers: { Authorization: 'Bearer mf_wrong', 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);

  // Revoke token -> 401 afterwards and 404 for unknown token
  const del = await app.request(`/api/tokens/${tokBody.info.id}`, { method: 'DELETE', headers: { 'X-MyFood': '1', cookie: sid } });
  expect(del.status).toBe(200);
  expect(((await del.json()) as { tokens: unknown[] }).tokens).toEqual([]);
  expect((await app.request('/api/tokens/999', { method: 'DELETE', headers: { 'X-MyFood': '1', cookie: sid } })).status).toBe(404);
  expect((await app.request('/api/shortcut', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokBody.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ preset: 'Breakfast' }),
  })).status).toBe(401);
});
