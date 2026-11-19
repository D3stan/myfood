import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { runAi } from './ai/index.ts';
import { matchOffersAi } from './deals/matcher.ts';
import { checkDealsSync } from './deals/sync.ts';
import { openDb } from './db.ts';
import { guestCode } from './guest.ts';
import { checkExpiryPushes, ensureVapidKeys } from './push.ts';
import { createApp } from './routes.ts';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const dataDir = resolve(process.env.DATA_DIR ?? './data');
const webDir = resolve(process.env.WEB_DIR ?? 'dist/web');

// The database folder is private. Job folders may live elsewhere (JOBS_DIR) so the AI's unix user can read them and nothing else.
const jobsDir = resolve(process.env.JOBS_DIR ?? join(dataDir, 'jobs'));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
mkdirSync(jobsDir, { recursive: true, mode: 0o750 });
const dbFile = join(dataDir, 'myfood.db');
const db = openDb(dbFile);
chmodSync(dbFile, 0o600);
ensureVapidKeys(db);

const buildFile = join(webDir, 'build.txt');
const build = existsSync(buildFile) ? readFileSync(buildFile, 'utf8').trim() : 'dev';

const matchOffers = matchOffersAi(jobsDir);
const app = createApp({
  db,
  runAi,
  matchOffers,
  dataDir,
  jobsDir,
  build,
  webDir,
  insecureCookies: process.env.INSECURE_COOKIES === '1',
  mcpSecret: process.env.MCP_SECRET,
});
serve({ fetch: app.fetch, port, hostname: host }, i => console.log(`MyFood ${build} on http://${host}:${i.port} (guest code: ${guestCode(db)})`));

// Every 15 minutes: expiry notifications in the morning window (08:00-09:59 local time), and the catalog sync once per slot.
setInterval(() => {
  void checkDealsSync(db, { fetch, now: Date.now, matchOffers });
  const hour = new Date().getHours();
  if (hour >= 8 && hour < 10) {
    void checkExpiryPushes(db).catch(err => console.error('[push] expiry check failed', err));
  }
}, 15 * 60_000).unref();
