import { describe, expect, test } from 'vitest';
import type { FoodEvent } from '../src/shared/types.ts';
import { newStore, store as singleton } from '../src/web/store.ts';
import { actions } from '../src/web/ui/actions.ts';
import { appHtml } from '../src/web/ui/render.ts';
import { fixture } from './fixture.ts';

const NOW = new Date(2026, 10, 15, 12); // Sun 15 Nov 2026, ISO week 46
const exp = (cid: string, user_id: number, day: number, cost_cents: number, month = 10): FoodEvent =>
  ({ cid, user_id, at: new Date(2026, month, day, 12).getTime(), kind: 'buy', source: 'manual', note: cid, preset_id: null, cost_cents, counts_nutrition: false, lines: [] }) as FoodEvent;

function page(opts: { frame?: 'week' | 'month'; scope?: 'all' | 'mine' } = {}) {
  const s = newStore(structuredClone(fixture));
  s.server!.expenses = [exp('w1', 1, 10, 3000), exp('w2', 2, 12, 1000), exp('old', 2, 5, 5000) /* previous week */];
  s.server!.daily_nutrition = [
    { day: '2026-11-10', user_id: 1, kcal: 500, protein_g: 0, fat_g: 0, carbs_g: null, value_cents: 2500, unpriced: 2, no_kcal: 0 },
    { day: '2026-11-05', user_id: 1, kcal: 500, protein_g: 0, fat_g: 0, carbs_g: null, value_cents: 9900, unpriced: 0, no_kcal: 0 },
  ];
  s.ui.tab = 'spend';
  s.ui.frames.spend = { frame: opts.frame ?? 'week', offset: 0 };
  s.ui.spendScope = opts.scope ?? 'all';
  return appHtml(s, NOW);
}

describe('Spend frames', () => {
  test('week: household total and per-user paid with share', () => {
    const out = page();
    expect(out).toMatch(/id="spend-total"[^>]*>40\s?kr\./);
    expect(out).toMatch(/id="spend-user-1"[\s\S]*?paid 30\s?kr\. \(75%\)/);
    expect(out).toMatch(/id="spend-user-2"[\s\S]*?paid 10\s?kr\. \(25%\)/);
    expect(out).toContain('id="spend-frame-week"');
    expect(out.match(/<rect/g)).toHaveLength(2);
    expect(out).not.toContain('id="exp-old"');
  });
  test('month: one bar per day, includes earlier weeks of the month and lists their cards', () => {
    const out = page({ frame: 'month' });
    expect(out).toMatch(/id="spend-total"[^>]*>90\s?kr\./);
    expect(out.match(/<rect/g)).toHaveLength(3);
    expect(out).toContain('id="exp-old"');
    expect(out).toContain('id="week-2026-W45"');
    expect(out).toContain('id="week-2026-W46"');
  });
  test('month: week cards hold only in-month expenses, so they sum to the month total', () => {
    const s = newStore(structuredClone(fixture));
    // 31 Oct (W44) sits outside November, 2 Nov is the same ISO week
    s.server!.expenses = [exp('oct', 1, 31, 7000), exp('nov', 1, 2, 300), exp('w1', 1, 10, 3000)];
    s.ui.tab = 'spend';
    s.ui.frames.spend = { frame: 'month', offset: 0 };
    const out = appHtml(s, NOW);
    expect(out).not.toContain('id="exp-oct"');
    const cards = [...out.matchAll(/id="week-[^"]+"[\s\S]*?<span class="right"[^>]*>(\d+)\s?kr\./g)].map(m => Number(m[1]));
    expect(cards.reduce((a, b) => a + b, 0)).toBe(33);
    expect(out).toMatch(/id="spend-total"[^>]*>33\s?kr\./);
  });
  test('ate sums value_cents in the frame and flags unpriced as a lower bound', () => {
    const out = page();
    expect(out).toMatch(/id="spend-user-1"[\s\S]*?ate 25\s?kr\.[\s\S]*?\+2 unpriced/);
    expect(out).not.toMatch(/id="spend-user-2"[\s\S]*?unpriced/);
    expect(page({ frame: 'month' })).toMatch(/ate 124\s?kr\./);
  });
  test('Mine filters the list but not the table', () => {
    const out = page({ scope: 'mine' });
    expect(out).toContain('id="exp-w1"');
    expect(out).not.toContain('id="exp-w2"');
    expect(out).toMatch(/id="spend-user-2"[\s\S]*?paid 10\s?kr\./);
    expect(out).toMatch(/id="spend-scope-mine" class="on"/);
    actions.spendScope!({ dataset: { v: 'mine' } } as unknown as HTMLElement);
    expect(singleton.ui.spendScope).toBe('mine');
  });
  test('lock, export and row ids still render', () => {
    const out = page();
    expect(out).toContain('data-a="lockWeek"');
    expect(out).toContain('data-a="exportExpenses"');
    expect(out).toContain('id="exp-w1"');
    expect(out).toContain('data-a="open" data-s="expense"');
  });
  test('partial note shows only when the frame starts before the loaded 90-day window', () => {
    const at = (frame: 'week' | 'month', offset: number) => {
      const s = newStore(structuredClone(fixture));
      s.ui.online = false; // online, a period outside the window loads its stats instead
      s.ui.tab = 'spend';
      s.ui.frames.spend = { frame, offset };
      return appHtml(s, NOW);
    };
    expect(at('week', 0)).not.toContain('partial: only the last 90 days');
    expect(at('week', -13)).toContain('partial: only the last 90 days');
  });
});
