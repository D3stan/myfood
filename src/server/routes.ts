import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { ZodType } from 'zod';
import { nameKey } from '../shared/text.ts';
import {
  ApplyBody,
  BarcodeLinkBody,
  CookBody,
  EventBody,
  EventPatch,
  ItemBody,
  ItemPatch,
  JobMode,
  LoginBody,
  MeBody,
  PresetBody,
  PushSubscribeBody,
  PushUnsubscribeBody,
  SettingsBody,
  ShortcutBody,
  TokenBody,
} from '../shared/types.ts';
import type { Health } from '../shared/types.ts';
import { createApiToken, createSession, createThrottle, deleteSession, findApiToken, findSession, revokeApiToken } from './auth.ts';
import { linkBarcode, resolveBarcode } from './barcodes.ts';
import type { BarcodeLookupFn } from './barcodes.ts';
import { bumpRev } from './db.ts';
import type { Db } from './db.ts';
import * as d from './domain.ts';
import { guestCode, guestCodeMatches, guestLoginPage, guestPage, guestToken, regenerateGuestCode } from './guest.ts';
import { createJobs, runShortcutAi } from './jobs.ts';
import { findMeal, mealChoices, portionQty } from './shortcut.ts';
import type { JobFile, RunAi } from './jobs.ts';
import { ensureVapidKeys, notifyLowCrossings, sendTestPush, subscribePush, unsubscribePush } from './push.ts';
import type { PushSender } from './push.ts';
import { createMyFoodMcpServer } from './mcp.ts';
import { registerSpendRoutes } from './spend/routes.ts';

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
  sendPush?: PushSender;
  lookupBarcode?: BarcodeLookupFn;
  /** Secret protecting the /mcp Streamable HTTP endpoint (disabled with 503 when unset). */
  mcpSecret?: string;
}
export type AppOpts = Deps;

type Env = { Variables: { uid: number } };

// wasm-unsafe-eval lets the barcode decoder (zxing WebAssembly) compile; it does not allow JS eval.
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'";
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
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

function extractMcpSecret(c: Context): string | null {
  const authHdr = c.req.header('authorization')?.trim();
  if (authHdr) {
    const m = /^Bearer\s+(.+)$/i.exec(authHdr);
    return m?.[1]?.trim() || null;
  }
  // Path token (/mcp/<secret>) is for clients that can't send headers, e.g. claude.ai custom connectors.
  return c.req.header('x-mcp-secret')?.trim() || c.req.param('token')?.trim() || null;
}

function sameSecret(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

export function createApp(deps: Deps): Hono<Env> {
  const { db, build, dataDir } = deps;
  const now = deps.now ?? Date.now;
  const jobsDir = deps.jobsDir ?? join(dataDir, 'jobs');
  ensureVapidKeys(db);
  const jobs = createJobs({ db, runAi: deps.runAi, jobsDir, now, sendPush: deps.sendPush });
  const throttle = createThrottle();
  const guestThrottle = createThrottle();
  const webDir = resolve(deps.webDir);
  const app = new Hono<Env>();

  guestCode(db); // create it now so state() can just read it
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
  const pushLow = async (prevStocks: Map<number, number>) => {
    try {
      await notifyLowCrossings(db, prevStocks, deps.sendPush, now());
    } catch (e) {
      console.warn('[push] low check failed', e);
    }
  };

  app.use('*', async (c, next) => {
    await next();
    c.header('Content-Security-Policy', CSP);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
  });

  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const authHdr = c.req.header('authorization');
    const bearer = authHdr ? /^Bearer\s+(\S+)$/i.exec(authHdr.trim()) : null;
    if (bearer) {
      const tok = findApiToken(db, bearer[1], now());
      if (!tok) d.fail(401, 'Invalid or revoked token');
      const scopes = tok.scopes.split(',').map(s => s.trim());
      const isHealth = c.req.method === 'GET' && c.req.path === '/api/health';
      const isShortcut = (c.req.method === 'POST' && c.req.path === '/api/shortcut')
        || (c.req.method === 'GET' && c.req.path === '/api/shortcut/meals');
      if (!isHealth && !(isShortcut && scopes.includes('shortcut'))) {
        d.fail(403, 'Token scope does not allow this route');
      }
      c.set('uid', tok.userId);
      return next();
    }

    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('X-MyFood') !== '1') {
      d.fail(400, 'Missing X-MyFood header');
    }
    if (c.req.path === '/api/login' || c.req.path === '/api/health') return next();
    const s = findSession(db, getCookie(c, 'sid'), now());
    if (!s) d.fail(401, 'Please sign in');
    if (s.renew) sendCookie(c, getCookie(c, 'sid')!);
    c.set('uid', s.userId);
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

  app.post('/api/guest/code', c => {
    regenerateGuestCode(db);
    bumpRev(db);
    return c.json(state(c.get('uid')));
  });

  app.patch('/api/settings', async c => {
    d.patchSettings(db, parse(SettingsBody, await json(c)));
    return c.json(state(c.get('uid')));
  });

  // ---- events ----
  app.post('/api/events', async c => {
    const { prevStocks } = d.createEvent(db, c.get('uid'), parse(EventBody, await json(c)), now());
    await pushLow(prevStocks);
    return c.json(state(c.get('uid')));
  });
  app.patch('/api/events/:cid', async c => {
    const prevStocks = d.editEvent(db, c.req.param('cid'), parse(EventPatch, await json(c)));
    await pushLow(prevStocks);
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

  // ---- cooked meals ----
  app.post('/api/meals/cook', async c => {
    const { prevStocks } = d.applyCookBatch(db, c.get('uid'), parse(CookBody, await json(c)), { now: now() });
    await pushLow(prevStocks);
    return c.json(state(c.get('uid')));
  });

  registerSpendRoutes(app, { db, now, state, json, parse });

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

  // ---- api tokens & shortcut ----
  app.post('/api/tokens', async c => {
    const body = parse(TokenBody, await json(c));
    const { token, info } = createApiToken(db, c.get('uid'), body.name, now());
    bumpRev(db);
    return c.json({ token, info, state: state(c.get('uid')) });
  });
  app.delete('/api/tokens/:id', c => {
    const res = revokeApiToken(db, c.get('uid'), id(c), now());
    if (res === 'missing') d.fail(404, 'No such token');
    if (res === 'revoked') bumpRev(db);
    return c.json(state(c.get('uid')));
  });
  app.post('/api/shortcut', async c => {
    const uid = c.get('uid');
    const body = parse(ShortcutBody, await json(c));

    if (body.mode === 'ai') {
      if (!body.text) d.fail(400, 'Say or write what to log');
      const res = await runShortcutAi(db, { runAi: deps.runAi, jobsDir, now, sendPush: deps.sendPush }, uid, body.text!);
      return c.json({ ok: true, ...res });
    }

    if (body.mode === 'log') {
      const said = body.meal ?? body.preset ?? body.text;
      const found = body.preset_id != null
        ? ((p) => (p ? { kind: 'preset' as const, preset: p } : null))(d.listPresets(db, uid).find(x => x.id === body.preset_id))
        : findMeal(db, uid, said, now());
      if (!found) d.fail(404, said || body.preset_id != null ? 'No preset or cooked meal with that name' : 'You have no presets yet');
      const label = found!.kind === 'preset' ? found!.preset.name : found!.meal.name;
      const lines = found!.kind === 'preset'
        ? found!.preset.lines
        : [{ item_id: found!.meal.id, qty: portionQty(found!.meal, body.portions ?? 1) }];
      if (!lines.length) d.fail(400, 'Preset has no items');
      const { prevStocks, seq } = d.createEvent(
        db, uid,
        { cid: `sc-${randomUUID()}`, at: now(), kind: 'eat', preset_id: found!.kind === 'preset' ? found!.preset.id : null, note: label, lines },
        now(), { source: 'shortcut' },
      );
      await pushLow(prevStocks);
      return c.json({ ok: true, reply: `Logged ${label}`, event_ids: seq != null ? [seq] : [] });
    }

    if (body.preset_id == null && !body.preset && !body.text) {
      d.fail(400, 'Provide text, preset, or preset_id');
    }
    const presets = d.listPresets(db, uid);
    const matched = body.preset_id != null
      ? presets.find(p => p.id === body.preset_id)
      : body.preset != null
        ? presets.find(p => nameKey(p.name) === nameKey(body.preset!))
        : presets.find(p => nameKey(p.name) === nameKey(body.text!));

    if ((body.preset_id != null || (body.preset != null && !body.text)) && !matched) {
      d.fail(404, 'No such preset');
    }

    if (matched) {
      if (!matched.lines.length) d.fail(400, 'Preset has no items');
      const { prevStocks, seq } = d.createEvent(
        db,
        uid,
        {
          cid: `sc-${randomUUID()}`,
          at: now(),
          kind: 'eat',
          preset_id: matched.id,
          note: matched.name,
          lines: matched.lines,
        },
        now(),
        { source: 'shortcut' },
      );
      await pushLow(prevStocks);
      return c.json({ ok: true, reply: `Logged ${matched.name}`, event_ids: seq != null ? [seq] : [] });
    }

    const res = await runShortcutAi(db, { runAi: deps.runAi, jobsDir, now, sendPush: deps.sendPush }, uid, body.text!);
    return c.json({ ok: true, ...res });
  });

  // For the Log-meal Shortcut's "Choose from List": every preset and cooked meal name, plus the best guess for now.
  app.get('/api/shortcut/meals', c => c.json({ ok: true, ...mealChoices(db, c.get('uid'), now()) }));

  // ---- barcodes ----
  app.get('/api/barcodes/:code', async c => {
    const lookup = await resolveBarcode(db, c.req.param('code'), deps.lookupBarcode, now());
    return c.json(lookup);
  });
  app.post('/api/barcodes/link', async c => {
    const body = parse(BarcodeLinkBody, await json(c));
    linkBarcode(db, body.code, body.item_id, now());
    return c.json(state(c.get('uid')));
  });

  // ---- push ----
  app.post('/api/push/subscribe', async c => {
    subscribePush(db, c.get('uid'), parse(PushSubscribeBody, await json(c)), c.req.header('user-agent') ?? null, now());
    return c.json(state(c.get('uid')));
  });
  app.delete('/api/push/subscribe', async c => {
    const body = parse(PushUnsubscribeBody, await json(c));
    unsubscribePush(db, c.get('uid'), body.endpoint);
    return c.json(state(c.get('uid')));
  });
  app.post('/api/push/test', async c => {
    const res = await sendTestPush(db, c.get('uid'), deps.sendPush, now());
    return c.json({ ok: true, ...res });
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
    const rawMode = form.mode ?? 'auto';
    if (typeof rawMode !== 'string') d.fail(400, 'mode must be text');
    const mode = parse(JobMode, rawMode);
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
    jobs.submit(c.get('uid'), (text as string).trim(), files, mode);
    return c.json(state(c.get('uid')));
  });
  app.post('/api/jobs/:id/apply', async c => {
    const body = parse(ApplyBody, await json(c));
    jobs.apply(c.get('uid'), id(c), body.events, body.cook);
    return c.json(state(c.get('uid')));
  });
  app.delete('/api/jobs/:id', c => {
    jobs.dismiss(c.get('uid'), id(c));
    return c.json(state(c.get('uid')));
  });

  // ---- guest view (read-only shared pantry behind the household guest passcode; see guest.ts) ----
  const html = (c: Context, body: string, status: ContentfulStatusCode = 200) => {
    c.header('Cache-Control', 'no-store');
    return c.html(body, status);
  };
  app.get('/guest', c => (getCookie(c, 'guest') === guestToken(db) ? html(c, guestPage(db, now())) : html(c, guestLoginPage())));
  app.post('/guest', async c => {
    const key = clientKey(c);
    if (guestThrottle.blocked(key, now())) return html(c, guestLoginPage('Too many tries, wait a minute and try again'), 429);
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const code = typeof form.code === 'string' ? form.code : '';
    if (!guestCodeMatches(db, code)) {
      guestThrottle.fail(key, now());
      return html(c, guestLoginPage('That passcode is not right'), 401);
    }
    setCookie(c, 'guest', guestToken(db), { httpOnly: true, sameSite: 'Lax', path: '/guest', maxAge: 30 * 86400, secure: !deps.insecureCookies });
    return c.redirect('/guest', 303);
  });

  app.all('/api/*', () => d.fail(404, 'Not found'));

  // ---- MCP Streamable HTTP (stateless, authenticated by MCP_SECRET only) ----
  app.all('/mcp/:token?', async c => {
    c.header('Cache-Control', 'no-store');
    const secret = deps.mcpSecret?.trim();
    if (!secret) {
      return c.json({ error: 'MCP server is disabled (MCP_SECRET not set)' }, 503);
    }
    const provided = extractMcpSecret(c);
    if (!provided || !sameSecret(provided, secret)) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (c.req.method !== 'POST') {
      return c.json(
        { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null },
        405,
        { Allow: 'POST' },
      );
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const mcp = createMyFoodMcpServer(db, {
      now,
      build,
      lookupBarcode: deps.lookupBarcode,
      onLowCrossings: pushLow,
    });
    try {
      await mcp.connect(transport);
      const res = await transport.handleRequest(c.req.raw);
      res.headers.set('Cache-Control', 'no-store');
      return res;
    } finally {
      await transport.close();
      await mcp.close();
    }
  });

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
