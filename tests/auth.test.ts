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
