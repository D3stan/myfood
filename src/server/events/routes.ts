import type { Hono } from 'hono';
import { EventBody, EventPatch } from '../../shared/types.ts';
import type { AppEnv, RouteDeps } from '../route-kit.ts';
import { createEvent, editEvent, undoEvent } from './repo.ts';

export function registerEventRoutes(
  app: Hono<AppEnv>,
  { db, now, state, json, parse, pushLow }: RouteDeps,
): void {
  app.post('/api/events', async c => {
    const { prevStocks } = createEvent(db, c.get('uid'), parse(EventBody, await json(c)), now());
    await pushLow(prevStocks);
    return c.json(state(c.get('uid')));
  });
  app.patch('/api/events/:cid', async c => {
    const prevStocks = editEvent(db, c.req.param('cid'), parse(EventPatch, await json(c)));
    await pushLow(prevStocks);
    return c.json(state(c.get('uid')));
  });
  app.delete('/api/events/:cid', c => {
    undoEvent(db, c.req.param('cid'), now());
    return c.json(state(c.get('uid')));
  });
}
