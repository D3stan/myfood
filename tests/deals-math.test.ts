import { describe, expect, test } from 'vitest';
import { burnRate, campaigns, planTrips, promoCadence, stockUp, type StockUpIn } from '../src/shared/deals.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 19, 12);
const ago = (d: number) => NOW - d * DAY;
const buy = (d: number, qty: number) => ({ at: ago(d), qty, is_set: false, kind: 'buy' as const });
const eat = (d: number, qty: number) => ({ at: ago(d), qty: -qty, is_set: false, kind: 'eat' as const });

describe('burnRate', () => {
  test('sums eats over days observed', () => {
    // 20 days of history, 4 eats of 1 => 4 / 20
    expect(burnRate([buy(20, 10), eat(15, 1), eat(10, 1), eat(5, 1), eat(1, 1)], NOW)).toBeCloseTo(0.2);
  });
  test('buys never count and downward adjusts do', () => {
    const lines = [buy(20, 10), eat(15, 1), eat(10, 1), { at: ago(5), qty: 5, is_set: true, kind: 'adjust' as const }, buy(2, 20)];
    expect(burnRate(lines, NOW)).toBeCloseTo((1 + 1 + 3) / 20); // 8 -> set 5 is a drop of 3
  });
  test('an upward adjust is not a decrease', () => {
    const lines = [buy(20, 2), eat(15, 1), eat(10, 1), { at: ago(5), qty: 9, is_set: true, kind: 'adjust' as const }, eat(1, 1)];
    expect(burnRate(lines, NOW)).toBeCloseTo(3 / 20);
  });
  test('window is capped at 30 days and older drops are ignored', () => {
    const lines = [buy(60, 100), eat(50, 5), eat(40, 5), eat(20, 1), eat(10, 1), eat(2, 1)];
    expect(burnRate(lines, NOW)).toBeCloseTo(3 / 30);
  });
  test('under 14 days of history is null', () => {
    expect(burnRate([buy(10, 10), eat(8, 1), eat(5, 1), eat(1, 1)], NOW)).toBeNull();
  });
  test('under 3 decreases is null', () => {
    expect(burnRate([buy(20, 10), eat(10, 1), eat(1, 1)], NOW)).toBeNull();
  });
  test('no lines is null', () => expect(burnRate([], NOW)).toBeNull());
  test('level-style set line: eat set replaces only the open level', () => {
    const set = (d: number, qty: number) => ({ at: ago(d), qty, is_set: true, kind: 'eat' as const });
    // 3 containers, open one goes 1 -> 0.5 -> 0.25 -> 0 (stock 3 -> 2.5 -> 2.25 -> 2)
    const lines = [buy(20, 3), set(15, 0.5), set(10, 0.25), set(5, 0)];
    expect(burnRate(lines, NOW)).toBeCloseTo(1 / 20);
  });
});

describe('campaigns', () => {
  const o = (store_id: number, valid_from: string, valid_to: string, unit_cents: number) => ({ store_id, valid_from, valid_to, unit_cents });
  test('overlapping offers merge, lowest price wins', () => {
    expect(campaigns([o(1, '2026-11-20', '2026-11-26', 900), o(1, '2026-11-24', '2026-11-30', 800)]))
      .toEqual([{ store_id: 1, from: '2026-11-20', to: '2026-11-30', unit_cents: 800 }]);
  });
  test('touching (gap 1 day) merges', () => {
    expect(campaigns([o(1, '2026-11-20', '2026-11-26', 900), o(1, '2026-11-27', '2026-12-03', 950)]))
      .toEqual([{ store_id: 1, from: '2026-11-20', to: '2026-12-03', unit_cents: 900 }]);
  });
  test('a 2-day gap stays separate', () => {
    expect(campaigns([o(1, '2026-11-20', '2026-11-26', 900), o(1, '2026-11-28', '2026-12-03', 900)])).toHaveLength(2);
  });
  test('stores stay separate, input order does not matter', () => {
    const r = campaigns([o(2, '2026-11-20', '2026-11-26', 700), o(1, '2026-11-24', '2026-11-30', 800), o(1, '2026-11-20', '2026-11-26', 900)]);
    expect(r.map(c => c.store_id)).toEqual([1, 2]);
    expect(r[0]).toMatchObject({ from: '2026-11-20', to: '2026-11-30' });
  });
  test('a contained offer does not shorten the campaign', () => {
    expect(campaigns([o(1, '2026-11-20', '2026-11-30', 900), o(1, '2026-11-22', '2026-11-23', 900)])[0]!.to).toBe('2026-11-30');
  });
  test('empty', () => expect(campaigns([])).toEqual([]));
});

describe('promoCadence', () => {
  test('prior only', () => {
    expect(promoCadence([], 'dairy')).toBe(14);
    expect(promoCadence(['2026-11-01'], 'bakery')).toBe(14);
    expect(promoCadence([], 'meat')).toBe(18);
    expect(promoCadence([], 'pantry')).toBe(28);
  });
  test('with data pulls toward observed gaps; dedupes and sorts', () => {
    // gaps 7 and 7: (2*28 + 14) / 4 = 17.5
    expect(promoCadence(['2026-11-15', '2026-11-01', '2026-11-08', '2026-11-08'], 'pantry')).toBe(17.5);
  });
});

describe('stockUp', () => {
  const base: StockUpIn = {
    stock: 0, lowAt: 1, rate: 1, normalCents: 3000, offerUnitCents: 2000, qtyPerPack: 4,
    maxPerCustomer: null, cadenceDays: 20, shelfLifeDays: null, nextCheaperInDays: null,
  };
  test('deep deal: longer horizon and packs', () => {
    const r = stockUp(base); // delta 1/3 => 20 * 1.3 = 26 days, need 26, 7 packs
    expect(r.pctOff).toBe(33);
    expect(r.horizonDays).toBeCloseTo(26);
    expect(r.packs).toBe(7);
    expect(r.units).toBe(28);
    expect(r.reason).toBe('7 packs · 80 kr/pack · 33% under usual · covers ~28 days');
  });
  test('need <= 0 buys nothing (never "buy 1")', () => {
    const r = stockUp({ ...base, stock: 100 });
    expect(r.packs).toBe(0);
    expect(r.units).toBe(0);
    expect(r.reason).not.toMatch(/1 pack/);
  });
  test('weak deal uses a 7-day horizon', () => {
    const r = stockUp({ ...base, offerUnitCents: 2800 });
    expect(r.horizonDays).toBe(7);
    expect(r.packs).toBe(2);
  });
  test('unknown normal price counts as no discount', () => {
    const r = stockUp({ ...base, normalCents: null });
    expect(r.horizonDays).toBe(7);
    expect(r.pctOff).toBe(0);
  });
  test('a cheaper offer coming soon shortens the horizon', () => {
    const r = stockUp({ ...base, nextCheaperInDays: 10 });
    expect(r.horizonDays).toBe(10);
    expect(r.packs).toBe(3);
  });
  test('shelf life clamps the horizon', () => {
    const r = stockUp({ ...base, shelfLifeDays: 5 });
    expect(r.horizonDays).toBe(5);
    expect(r.packs).toBe(2);
  });
  test('never beyond 60 days', () => {
    expect(stockUp({ ...base, cadenceDays: 100 }).horizonDays).toBe(60);
  });
  test('max per customer caps packs', () => {
    const r = stockUp({ ...base, maxPerCustomer: 2 });
    expect(r.packs).toBe(2);
    expect(r.units).toBe(8);
  });
  test('rate unknown: low buys exactly one pack', () => {
    const r = stockUp({ ...base, rate: null, stock: 1, lowAt: 1 });
    expect(r.packs).toBe(1);
    expect(r.reason).toContain('low and on offer');
  });
  test('rate unknown: no threshold, out of stock counts as low', () => {
    expect(stockUp({ ...base, rate: null, stock: 0, lowAt: null }).packs).toBe(1);
  });
  test('rate unknown: not low buys nothing', () => {
    expect(stockUp({ ...base, rate: null, stock: 5 }).packs).toBe(0);
  });
  test('rate unknown: max per customer 0 is respected', () => {
    expect(stockUp({ ...base, rate: null, stock: 0, maxPerCustomer: 0 }).packs).toBe(0);
  });
});

describe('planTrips', () => {
  const today = '2026-11-19';
  const need = (item_id: number, units: number, normalCents: number, deadlineDay: number | null = null) => ({ item_id, units, normalCents, deadlineDay });
  const offer = (item_id: number, store_id: number, valid_from: string, valid_to: string, unit_cents: number) => ({ item_id, store_id, valid_from, valid_to, unit_cents });

  test('nothing to save: no trips', () => {
    expect(planTrips({ needs: [need(1, 4, 1000)], offers: [offer(1, 1, today, today, 1200)], today })).toEqual({ trips: [], total_saving_cents: 0 });
    expect(planTrips({ needs: [], offers: [], today })).toEqual({ trips: [], total_saving_cents: 0 });
  });
  test('single trip on the best store', () => {
    const r = planTrips({
      needs: [need(1, 10, 1000)],
      offers: [offer(1, 1, today, '2026-11-25', 900), offer(1, 2, today, '2026-11-25', 700)],
      today,
    });
    expect(r.trips).toHaveLength(1);
    expect(r.trips[0]).toMatchObject({ store_id: 2, day: 0, date: today, saving_cents: 3000 });
    expect(r.total_saving_cents).toBe(3000);
  });
  test('uses the best live price of that store on the day', () => {
    const r = planTrips({
      needs: [need(1, 10, 1000)],
      offers: [offer(1, 1, today, '2026-11-25', 900), offer(1, 1, '2026-11-21', '2026-11-25', 600)],
      today,
    });
    expect(r.trips[0]).toMatchObject({ day: 2, saving_cents: 4000 });
  });
  test('second trip only when it adds at least 25 kr', () => {
    const offers = [offer(1, 1, today, today, 500), offer(2, 2, '2026-11-22', '2026-11-22', 500)];
    const mk = (units: number) => planTrips({ needs: [need(1, 10, 1000), need(2, units, 1000)], offers, today });
    expect(mk(4).trips).toHaveLength(1); // second would add 20 kr
    const r = mk(5); // exactly 25 kr
    expect(r.trips).toHaveLength(2);
    expect(r.trips.map(t => t.store_id)).toEqual([1, 2]);
    expect(r.total_saving_cents).toBe(5000 + 2500);
  });
  test('each item goes to the trip where it saves most', () => {
    const offers = [
      offer(1, 1, today, today, 500), offer(1, 2, '2026-11-22', '2026-11-22', 400), // item 1 saves more at store 2
      offer(2, 2, '2026-11-22', '2026-11-22', 100), offer(3, 1, today, today, 100),
    ];
    const r = planTrips({ needs: [need(1, 10, 1000), need(2, 10, 1000), need(3, 10, 1000)], offers, today });
    expect(r.trips).toHaveLength(2);
    const byStore = Object.fromEntries(r.trips.map(t => [t.store_id, t.items.map(i => i.item_id).sort()]));
    expect(byStore).toEqual({ 1: [3], 2: [1, 2] });
  });
  test('deadline 0 forces the first trip to be today', () => {
    const offers = [offer(1, 1, today, today, 900), offer(2, 2, '2026-11-22', '2026-11-22', 100)];
    const r = planTrips({ needs: [need(1, 1, 1000, 0), need(2, 20, 1000)], offers, today, tripCostCents: 1_000_000 });
    expect(r.trips).toHaveLength(1);
    expect(r.trips[0]).toMatchObject({ day: 0, store_id: 1 });
    // without the deadline the big saving on day 3 wins
    const free = planTrips({ needs: [need(1, 1, 1000), need(2, 20, 1000)], offers, today, tripCostCents: 1_000_000 });
    expect(free.trips[0]).toMatchObject({ day: 3, store_id: 2 });
  });
  test('items past their deadline save nothing on a later trip', () => {
    const r = planTrips({ needs: [need(1, 10, 1000, 1)], offers: [offer(1, 1, '2026-11-22', '2026-11-22', 100)], today });
    expect(r.trips).toEqual([]);
  });
  test('never plans a past day, even for offers that started earlier or already ended', () => {
    const r = planTrips({
      needs: [need(1, 10, 1000), need(2, 10, 1000)],
      offers: [offer(1, 1, '2026-11-10', '2026-11-21', 500), offer(2, 1, '2026-11-01', '2026-11-05', 100)],
      today,
    });
    expect(r.trips.every(t => t.day >= 0 && t.date >= today)).toBe(true);
    expect(r.trips.flatMap(t => t.items.map(i => i.item_id))).toEqual([1]);
  });
  test('unknown normal price saves nothing', () => {
    expect(planTrips({ needs: [{ item_id: 1, units: 5, deadlineDay: null, normalCents: null }], offers: [offer(1, 1, today, today, 1)], today }).trips).toEqual([]);
  });
});
