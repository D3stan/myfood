import { expect, test } from 'vitest';
import { settleTransfers } from '../src/shared/settle.ts';

const b = (...c: number[]) => c.map((balance_cents, i) => ({ user_id: i + 1, balance_cents }));
const sum = (t: { cents: number }[]) => t.reduce((a, x) => a + x.cents, 0);

test('two users: the debtor pays the creditor', () => {
  expect(settleTransfers(b(4000, -4000))).toEqual([{ from: 2, to: 1, cents: 4000 }]);
});
test('three users: largest debtor pays largest creditor, transfers settle everyone', () => {
  const t = settleTransfers(b(5000, -3000, -2000));
  expect(t).toEqual([{ from: 2, to: 1, cents: 3000 }, { from: 3, to: 1, cents: 2000 }]);
  const mixed = settleTransfers(b(3000, 1000, -4000));
  expect(mixed).toEqual([{ from: 3, to: 1, cents: 3000 }, { from: 3, to: 2, cents: 1000 }]);
});
test('all zero: nothing to do', () => {
  expect(settleTransfers(b(0, 0, 0))).toEqual([]);
  expect(settleTransfers([])).toEqual([]);
});
test('rounds to whole cents and transfers sum exactly; uneaten surplus is not invented as a debt', () => {
  const t = settleTransfers(b(1000.4, -333.6, -666.5));
  expect(t.every(x => Number.isInteger(x.cents))).toBe(true);
  expect(sum(t)).toBe(1000);
  expect(sum(settleTransfers(b(9000, -2500)))).toBe(2500);
});
