import type { Hono } from 'hono';
import { dayRangeMs } from '../../shared/dates.ts';
import type { NutritionStats } from '../../shared/types.ts';
import { statsRange } from '../route-kit.ts';
import type { AppEnv, RouteDeps } from '../route-kit.ts';
import { dailyNutrition } from './repo.ts';

export function registerNutritionRoutes(app: Hono<AppEnv>, { db, parse }: RouteDeps): void {
  app.get('/api/stats/nutrition', c => {
    const { from, to } = statsRange(c, parse);
    const { fromMs, toMs } = dayRangeMs(from, to);
    return c.json({ from, to, rows: dailyNutrition(db, fromMs, c.get('uid'), toMs) } satisfies NutritionStats);
  });
}
