import type { Hono } from 'hono';
import { CookBody } from '../../shared/types.ts';
import type { AppEnv, RouteDeps } from '../route-kit.ts';
import { applyCookBatch } from './repo.ts';

export function registerCookingRoutes(
  app: Hono<AppEnv>,
  { db, now, state, json, parse, pushLow }: RouteDeps,
): void {
  app.post('/api/meals/cook', async c => {
    const { prevStocks } = applyCookBatch(db, c.get('uid'), parse(CookBody, await json(c)), { now: now() });
    await pushLow(prevStocks);
    return c.json(state(c.get('uid')));
  });
}
