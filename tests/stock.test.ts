import { expect, test } from 'vitest';
import { applyOps, computeStock, isLow, shown, toLines } from '../src/shared/stock.ts';
import { aliasKey, fmtNum, nameKey, parseNum } from '../src/shared/text.ts';
import { fixture } from './fixture.ts';

const d = (item_id: number, qty: number) => ({ item_id, qty, is_set: false });
const s = (item_id: number, qty: number) => ({ item_id, qty, is_set: true });

test('deltas add up, fractions included', () => {
  expect(computeStock([d(1, 12), d(1, -1.5), d(1, -1.5), d(2, 10)]).get(1)).toBe(9);
});

test('eating before the receipt is logged still ends at the right amount', () => {
  const stock = computeStock([d(1, -3), d(1, 10)]).get(1)!;
  expect(stock).toBe(7);
  expect(shown(computeStock([d(1, -3)]).get(1)!)).toBe(0);
});

test('a set replaces what came before and later deltas apply on top', () => {
  expect(computeStock([d(1, 10), d(1, -4), s(1, 6), d(1, -2)]).get(1)).toBe(4);
});

test('float noise is rounded away', () => {
  expect(computeStock([d(1, 0.1), d(1, 0.2)]).get(1)).toBe(0.3);
});

test('toLines: buy adds, eat removes, adjust sets, level items always set, unknown items dropped', () => {
  const unit = (id: number) => (id === 7 ? 'level' : id === 1 ? 'pc' : undefined);
  expect(toLines({ kind: 'buy', lines: [{ item_id: 1, qty: 10 }, { item_id: 7, qty: 1 }, { item_id: 99, qty: 1 }] }, unit)).toEqual([d(1, 10), s(7, 1)]);
  expect(toLines({ kind: 'eat', lines: [{ item_id: 1, qty: 3 }] }, unit)).toEqual([d(1, -3)]);
  expect(toLines({ kind: 'adjust', lines: [{ item_id: 1, qty: 6 }] }, unit)).toEqual([s(1, 6)]);
});

test('applyOps shows pending work on top of server state and does not mutate it', () => {
  const eat = { type: 'event' as const, body: { cid: 'pending-0001', at: fixture.now, kind: 'eat' as const, lines: [{ item_id: 1, qty: 2 }] } };
  const out = applyOps(fixture, [eat]);
  expect(out.items.find(i => i.id === 1)!.stock).toBe(5);
  expect(out.events[0]!.cid).toBe('pending-0001');
  expect(out.usual[1]).toBe(2);
  expect(fixture.items.find(i => i.id === 1)!.stock).toBe(7);
  // once the server lists the event, the pending op adds nothing
  expect(applyOps(out, [eat]).items.find(i => i.id === 1)!.stock).toBe(5);
  // undo of a server event
  const undone = applyOps(fixture, [{ type: 'undo', cid: 'ev-00000003' }]);
  expect(undone.items.find(i => i.id === 6)!.stock).toBe(1000);
  expect(undone.events.some(e => e.cid === 'ev-00000003')).toBe(false);
});

test('isLow', () => {
  expect(isLow({ stock: 2, low_at: 2 })).toBe(true);
  expect(isLow({ stock: 3, low_at: 2 })).toBe(false);
  expect(isLow({ stock: -1, low_at: null })).toBe(true);
  expect(isLow({ stock: 1, low_at: null })).toBe(false);
});

test('text helpers', () => {
  expect(nameKey('  Eggs  ')).toBe('eggs');
  expect(aliasKey('ØKO ÆG M/L  10 STK')).toBe('øko æg m l 10 stk');
  expect(parseNum('1,5')).toBe(1.5);
  expect(parseNum('2')).toBe(2);
  expect(parseNum('abc')).toBeNaN();
  expect(fmtNum(0.1 + 0.2)).toBe('0.3');
});
