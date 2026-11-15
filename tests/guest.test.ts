import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { sha256 } from '../src/server/auth.ts';
import { openDb } from '../src/server/db.ts';
import { guestCode } from '../src/server/guest.ts';
import { createApp } from '../src/server/routes.ts';

function setup() {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO users(name, emoji, code_hash, created_at) VALUES (?, ?, ?, 0)').run('Alice', '🦊', sha256('aaaa-aaaa-aaaa'));
  db.prepare("INSERT INTO items(name, name_key, emoji, category, unit, step, pack_size, owner_id, created_at) VALUES ('Eggs','eggs','🥚','dairy','pc',1,10,NULL,0)").run();
  db.prepare("INSERT INTO items(name, name_key, emoji, category, unit, step, pack_size, owner_id, created_at) VALUES ('Secret <b>','secret','🤫','other','pc',1,1,1,0)").run();
  const app = createApp({ db, runAi: async () => { throw new Error('x'); }, dataDir: mkdtempSync(join(tmpdir(), 'mf-')), build: 't', webDir: '/nonexistent', now: () => 10_000_000 });
  const form = (code: string, cookie = '') => app.request('/guest', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams({ code }).toString(),
  });
  return { app, db, form };
}

test('guest view: passcode gate, shared items only, new code locks guests out', async () => {
  const { app, db, form } = setup();
  expect(await (await app.request('/guest')).text()).toContain('Passcode');
  expect((await form('nope-nope')).status).toBe(401);

  const code = guestCode(db);
  expect(code).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
  const ok = await form(code.toUpperCase().replace('-', ' '));
  expect(ok.status).toBe(303);
  const cookie = ok.headers.get('set-cookie')!.split(';')[0]!;
  const page = await (await app.request('/guest', { headers: { cookie } })).text();
  expect(page).toContain('Eggs');
  expect(page).not.toContain('Secret');

  // signed-in people get the code in state; a new code ends the guest session
  const login = await app.request('/api/login', { method: 'POST', headers: { 'X-MyFood': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'aaaa-aaaa-aaaa' }) });
  const sid = login.headers.get('set-cookie')!.split(';')[0]!;
  const regen = await app.request('/api/guest/code', { method: 'POST', headers: { 'X-MyFood': '1', cookie: sid } });
  const next = (await regen.json()).guest_code as string;
  expect(next).not.toBe(code);
  expect(await (await app.request('/guest', { headers: { cookie } })).text()).toContain('Passcode');
  // a guest cannot reach the API
  expect((await app.request('/api/state', { headers: { cookie } })).status).toBe(401);
});
