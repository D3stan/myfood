import type { Hono } from 'hono';
import { ExpenseBody, LockPeriodBody } from '../../shared/types.ts';
import { fail } from '../domain.ts';
import { statsRange } from '../route-kit.ts';
import type { AppEnv, RouteDeps } from '../route-kit.ts';
import { addExpense, exportExpenses, lockExpensePeriod, settleUp, spendStats, unlockExpensePeriod } from './repo.ts';

export function registerSpendRoutes(
  app: Hono<AppEnv>,
  { db, now, state, json, parse }: RouteDeps,
): void {
  app.get('/api/stats/spend', c => {
    const { from, to } = statsRange(c, parse);
    return c.json(spendStats(db, from, to));
  });
  app.post('/api/expenses', async c => {
    addExpense(db, c.get('uid'), parse(ExpenseBody, await json(c)), now());
    return c.json(state(c.get('uid')));
  });
  app.post('/api/expenses/lock', async c => {
    lockExpensePeriod(db, c.get('uid'), parse(LockPeriodBody, await json(c)), now());
    return c.json(state(c.get('uid')));
  });
  app.delete('/api/expenses/lock/:period', c => {
    unlockExpensePeriod(db, parse(LockPeriodBody.shape.period, c.req.param('period')));
    return c.json(state(c.get('uid')));
  });
  app.post('/api/settle', c => {
    settleUp(db, c.get('uid'), null, now());
    return c.json(state(c.get('uid')));
  });
  app.get('/api/expenses/export', c => {
    const period = c.req.query('period') || undefined;
    const formatRaw = (c.req.query('format') || 'csv').toLowerCase();
    if (formatRaw !== 'csv' && formatRaw !== 'json') fail(400, 'Format must be csv or json');
    const out = exportExpenses(db, { period, format: formatRaw });
    return c.body(out.body, 200, {
      'Content-Type': out.contentType,
      'Content-Disposition': `attachment; filename="${out.filename}"`,
    });
  });
}
