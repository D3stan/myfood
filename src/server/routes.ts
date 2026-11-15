import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { ZodType } from 'zod';
import { ApplyBody, EventBody, EventPatch, ItemBody, ItemPatch, LoginBody, MeBody, PresetBody } from '../shared/types.ts';
import type { Health } from '../shared/types.ts';
import { createSession, createThrottle, deleteSession, findSession } from './auth.ts';
import type { Db } from './db.ts';
import * as d from './domain.ts';
import { createJobs } from './jobs.ts';
import type { JobFile, RunAi } from './jobs.ts';

export interface Deps {
  db: Db;
  runAi: RunAi;
  dataDir: string;
  /** Where job folders live. Kept apart from the database so the AI user can be let into it alone. Default: dataDir/jobs. */
  jobsDir?: string;
  build: string;
  webDir: string;
  now?: () => number;
  /** Drops the cookie's Secure flag, for http on localhost. */
  insecureCookies?: boolean;
}

type Env = { Variables: { uid: number } };

const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'";
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
};
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_IMAGES = 4;

/** File type from the first bytes, so a renamed file cannot pass. */
function sniff(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  return null;
}

function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  d.fail(400, r.error.issues.map(i => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message).join('; '));
}

export function createApp(deps: Deps): Hono<Env> {
  const { db, build, dataDir } = deps;
  const now = deps.now ?? Date.now;
  const jobs = createJobs({ db, runAi: deps.runAi, jobsDir: deps.jobsDir ?? join(dataDir, 'jobs'), now });
  const throttle = createThrottle();
  const webDir = resolve(deps.webDir);
  const app = new Hono<Env>();

  const state = (uid: number) => d.buildState(db, uid, { build, now: now(), ai: jobs.ai.ready });
  const json = async (c: Context): Promise<unknown> => {
    try { return await c.req.json(); } catch { return d.fail(400, 'The request body is not valid JSON'); }
  };
  const id = (c: Context): number => {
    const n = Number(c.req.param('id'));
    return Number.isSafeInteger(n) && n > 0 ? n : d.fail(404, 'Not found');
  };
  const sendCookie = (c: Context, token: string) =>
    setCookie(c, 'sid', token, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 365 * 86400, secure: !deps.insecureCookies });
  const clientKey = (c: Context): string => {
    const cf = c.req.header('cf-connecting-ip');
    if (cf) return cf;
    try { return getConnInfo(c).remote.address ?? 'unknown'; } catch { return 'unknown'; }
  };

  app.use('*', async (c, next) => {
    await next();
    c.header('Content-Security-Policy', CSP);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
  });

  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('X-MyFood') !== '1') d.fail(400, 'Missing X-MyFood header');
    await next();
  });

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/login' || c.req.path === '/api/health') return next();
    const s = findSession(db, getCookie(c, 'sid'), now());
    if (!s) d.fail(401, 'Please sign in');
    if (s!.renew) sendCookie(c, getCookie(c, 'sid')!);
    c.set('uid', s!.userId);
    await next();
  });

  app.get('/api/health', c => c.json({ ok: true, build, ai: jobs.ai.ready } satisfies Health));

  app.post('/api/login', async c => {
    const { code } = parse(LoginBody, await json(c));
    const key = clientKey(c);
    if (throttle.blocked(key, now())) d.fail(429, 'Too many tries, wait a minute and try again');
    const session = createSession(db, code, now());
    if (!session) {
      throttle.fail(key, now());
      d.fail(401, 'That code does not match anyone');
    }
    sendCookie(c, session!.token);
    return c.json(state(session!.userId));
  });

  app.post('/api/logout', c => {
    const token = getCookie(c, 'sid');
    if (token) deleteSession(db, token);
    deleteCookie(c, 'sid', { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/api/state', c => c.json(state(c.get('uid'))));

  app.patch('/api/me', async c => {
    d.patchMe(db, c.get('uid'), parse(MeBody, await json(c)));
    return c.json(state(c.get('uid')));
  });

  // ---- events ----
  app.post('/api/events', async c => {
    d.createEvent(db, c.get('uid'), parse(EventBody, await json(c)), now());
    return c.json(state(c.get('uid')));
  });
  app.patch('/api/events/:cid', async c => {
    d.editEvent(db, c.req.param('cid'), parse(EventPatch, await json(c)));
    return c.json(state(c.get('uid')));
  });
  app.delete('/api/events/:cid', c => {
    d.undoEvent(db, c.req.param('cid'), now());
    return c.json(state(c.get('uid')));
  });

  // ---- items ----
  app.post('/api/items', async c => {
    d.createItem(db, parse(ItemBody, await json(c)), now());
    return c.json(state(c.get('uid')));
  });
  app.patch('/api/items/:id', async c => {
    d.patchItem(db, id(c), parse(ItemPatch, await json(c)));
    return c.json(state(c.get('uid')));
  });
  app.delete('/api/items/:id', c => {
    d.archiveItem(db, id(c), now());
    return c.json(state(c.get('uid')));
  });

  // ---- presets ----
  app.post('/api/presets', async c => {
    d.createPreset(db, c.get('uid'), parse(PresetBody, await json(c)));
    return c.json(state(c.get('uid')));
  });
  app.patch('/api/presets/:id', async c => {
    d.patchPreset(db, c.get('uid'), id(c), parse(PresetBody, await json(c)));
    return c.json(state(c.get('uid')));
  });
  app.delete('/api/presets/:id', c => {
    d.deletePreset(db, c.get('uid'), id(c));
    return c.json(state(c.get('uid')));
  });

  // ---- jobs ----
  app.post('/api/jobs', bodyLimit({
    maxSize: MAX_IMAGES * MAX_IMAGE + 100_000,
    onError: () => { throw Object.assign(new Error('The photos are too big (8 MB each)'), { status: 400 }); },
  }), async c => {
    if (!c.req.header('content-type')?.startsWith('multipart/form-data')) d.fail(400, 'Send the job as a form');
    let form;
    try { form = await c.req.parseBody({ all: true }); } catch { return d.fail(400, 'The form could not be read'); }
    const text = form.text ?? '';
    if (typeof text !== 'string') d.fail(400, 'text must be text');
    const raw = [form.images].flat().filter(v => v !== undefined && v !== '');
    if (raw.length > MAX_IMAGES) d.fail(400, `At most ${MAX_IMAGES} photos`);
    const files: JobFile[] = [];
    for (const f of raw) {
      if (typeof f === 'string') d.fail(400, 'images must be files');
      const file = f as File;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) d.fail(400, 'Only JPEG, PNG and WebP photos are accepted');
      if (file.size > MAX_IMAGE) d.fail(400, 'A photo is bigger than 8 MB');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const ext = sniff(bytes);
      if (!ext) d.fail(400, 'Only JPEG, PNG and WebP photos are accepted');
      files.push({ bytes, ext: ext! });
    }
    jobs.submit(c.get('uid'), (text as string).trim(), files);
    return c.json(state(c.get('uid')));
  });
  app.post('/api/jobs/:id/apply', async c => {
    jobs.apply(c.get('uid'), id(c), parse(ApplyBody, await json(c)).events);
    return c.json(state(c.get('uid')));
  });
  app.delete('/api/jobs/:id', c => {
    jobs.dismiss(c.get('uid'), id(c));
    return c.json(state(c.get('uid')));
  });

  app.all('/api/*', () => d.fail(404, 'Not found'));

  // ---- static files; index.html answers every other GET ----
  app.get('*', c => {
    let path: string;
    try { path = decodeURIComponent(c.req.path); } catch { return c.text('Bad request', 400); }
    let file = resolve(webDir, '.' + path);
    const inside = file === webDir || file.startsWith(webDir + sep);
    if (!inside || !existsSync(file) || !statSync(file).isFile()) file = resolve(webDir, 'index.html');
    if (!existsSync(file)) return c.text('Not found', 404);
    const immutable = file.startsWith(resolve(webDir, 'assets') + sep);
    return c.body(readFileSync(file), 200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
  });

  app.onError((e, c) => {
    const status = (e as { status?: number }).status;
    if (status && status >= 400 && status < 500) return c.json({ error: e.message }, status as ContentfulStatusCode);
    console.error(e);
    return c.json({ error: 'Something went wrong on the server' }, 500);
  });

  return app;
}
