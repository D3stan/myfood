import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { createEvent, createItem, getState, interpretText, login, undoEvent, updateMe, userForSession } from './domain.ts';
import type { CreateEventInput } from '../shared/types.ts';

const app = new Hono();
const port = Number(process.env.PORT ?? 3000);
const prod = process.env.NODE_ENV === 'production';
const hostname = process.env.HOST ?? (prod ? '0.0.0.0' : '127.0.0.1');
const loginAttempts = new Map<string, { count: number; started: number }>();
const currentUserId = (c: Context) =>
  userForSession(getCookie(c, 'myfood_session')) ?? (prod ? undefined : 1);

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health' || c.req.path === '/api/login') return next();
  if (!currentUserId(c)) return c.text('PIN sign-in required.', 401);
  return next();
});

app.get('/api/health', (c) => c.json({ ok: true, ai: { mode: 'demo', available: true } }));
app.post('/api/login', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  const now = Date.now();
  const attempts = loginAttempts.get(ip);
  if (attempts && now - attempts.started < 60_000 && attempts.count >= 5) return c.text('Too many tries. Wait a minute, then try again.', 429);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ pin: z.string().min(1).max(32) }).safeParse(body);
  if (!parsed.success) return c.text('Enter your PIN.', 400);
  const session = login(parsed.data.pin);
  if (!session) {
    if (!attempts || now - attempts.started >= 60_000) loginAttempts.set(ip, { count: 1, started: now });
    else attempts.count += 1;
    return c.text('That PIN did not match either kitchen pal.', 401);
  }
  loginAttempts.delete(ip);
  setCookie(c, 'myfood_session', session.token, { httpOnly: true, sameSite: 'Lax', secure: prod, path: '/', maxAge: 60 * 60 * 24 * 30 });
  return c.json(getState(session.user.id));
});

app.get('/api/state', (c) => c.json(getState(currentUserId(c) ?? 1)));

app.post('/api/events', async (c) => {
  if (c.req.header('X-MyFood') !== '1') return c.text('Missing request token.', 403);
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    cid: z.string().min(1).max(80),
    kind: z.enum(['buy', 'eat', 'adjust']),
    lines: z.array(z.object({ itemId: z.number().int().positive(), qty: z.number().positive().finite().max(100000) })).min(1).max(60),
    presetId: z.number().int().optional(),
    note: z.string().max(300).optional(),
  }).safeParse(body);
  if (!parsed.success) return c.text('Check the food and quantity, then try again.', 400);
  try {
    const userId = currentUserId(c) ?? 1;
    return c.json(createEvent(userId, parsed.data as CreateEventInput, parsed.data.presetId ? 'preset' : 'manual'));
  } catch (error) {
    return c.text(error instanceof Error ? error.message : 'Could not save that change.', 400);
  }
});

app.post('/api/items', async (c) => {
  if (c.req.header('X-MyFood') !== '1') return c.text('Missing request token.', 403);
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    name: z.string().trim().min(1).max(70), emoji: z.string().max(8).default('🥫'),
    category: z.string().trim().min(1).max(40).default('Other'),
    unit: z.enum(['pc', 'slice', 'g', 'ml', 'level']),
    step: z.number().positive().max(10000), packSize: z.number().positive().max(100000),
    lowAt: z.number().min(0).max(100000).default(1),
  }).safeParse(body);
  if (!parsed.success) return c.text('Check the food details and try again.', 400);
  return c.json(createItem(parsed.data));
});

app.post('/api/assistant', async (c) => {
  if (c.req.header('X-MyFood') !== '1') return c.text('Missing request token.', 403);
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ text: z.string().trim().min(1).max(1000) }).safeParse(body);
  if (!parsed.success) return c.text('Write a food note first.', 400);
  return c.json(interpretText(currentUserId(c) ?? 1, parsed.data.text));
});

app.delete('/api/events/:id', (c) => {
  if (c.req.header('X-MyFood') !== '1') return c.text('Missing request token.', 403);
  const eventId = Number(c.req.param('id'));
  if (!Number.isSafeInteger(eventId) || eventId <= 0) return c.text('That entry could not be found.', 404);
  return c.json(undoEvent(currentUserId(c) ?? 1, eventId));
});

app.patch('/api/me', async (c) => {
  if (c.req.header('X-MyFood') !== '1') return c.text('Missing request token.', 403);
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    name: z.string().trim().min(1).max(40).optional(),
    emoji: z.string().trim().min(1).max(8).optional(),
    pin: z.string().trim().min(4).max(32).optional(),
  }).refine((data) => data.name !== undefined || data.emoji !== undefined || data.pin !== undefined, {
    message: 'Provide a new PIN, name, or emoji.',
  }).safeParse(body);
  if (!parsed.success) return c.text('Enter a valid 6+ digit PIN or profile details.', 400);
  try {
    const userId = currentUserId(c) ?? 1;
    return c.json(updateMe(userId, parsed.data));
  } catch (error) {
    return c.text(error instanceof Error ? error.message : 'Could not update your profile.', 400);
  }
});

app.get('*', serveStatic({ root: './dist/web', index: 'index.html' }));

serve({ fetch: app.fetch, hostname, port }, (info) => {
  console.log(`MyFood API ready at http://${hostname}:${info.port}`);
});
