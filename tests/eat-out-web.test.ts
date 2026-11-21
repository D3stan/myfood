import { expect, test } from 'vitest';
import { applyOps } from '../src/shared/stock.ts';
import { fixture } from './fixture.ts';

test('an offline eat-out (jolly line) survives the optimistic replay with its kcal and no unpriced', () => {
  const base = { ...fixture, jolly_id: 98765 };
  const out = applyOps(base, [{ type: 'event', body: { cid: 'eat-out-0001', at: base.now, kind: 'eat', note: 'Pizza', lines: [{ item_id: 98765, qty: 1, kcal: 850, protein_g: 30, fat_g: 20, carbs_g: 100 }] } }]);
  expect(out.events[0]!.lines).toMatchObject([{ item_id: 98765, qty: -1, kcal: 850, value_cents: 0 }]);
  expect(out.daily_nutrition.reduce((a, d) => a + d.kcal, 0) - base.daily_nutrition.reduce((a, d) => a + d.kcal, 0)).toBe(850);
  expect(out.daily_nutrition.reduce((a, d) => a + d.unpriced, 0)).toBe(base.daily_nutrition.reduce((a, d) => a + d.unpriced, 0));
});
