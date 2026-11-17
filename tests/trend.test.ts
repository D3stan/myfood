import { describe, expect, test, vi } from 'vitest';
import { isoDate } from '../src/shared/dates.ts';
import { frameNav, periodRange } from '../src/shared/period.ts';
import type { State } from '../src/shared/types.ts';
import { newStore, store as singleton } from '../src/web/store.ts';
import { htmlToString } from '../src/web/html.ts';
import { barChart } from '../src/web/ui/components/chart.ts';
import { actions } from '../src/web/ui/actions.ts';
import { appHtml } from '../src/web/ui/render.ts';
import { trendStats } from '../src/web/ui/screens/me.ts';
import { fixture } from './fixture.ts';

vi.mock('../src/web/ui/helpers.ts', async orig => ({ ...(await orig<typeof import('../src/web/ui/helpers.ts')>()), commit: () => {} }));

describe('periodRange', () => {
  test('ISO week across a year end, with offsets', () => {
    const r = periodRange('week', 0, new Date(2026, 11, 31)); // Thu 31 Dec 2026, week 53
    expect([r.from, r.to, r.label]).toEqual(['2026-12-28', '2027-01-03', 'Dec 28 – Jan 3']);
    expect(r.days).toHaveLength(7);
    expect(periodRange('week', -1, new Date(2026, 11, 31)).from).toBe('2026-12-21');
    expect(periodRange('week', 1, new Date(2026, 11, 31)).from).toBe('2027-01-04');
  });
  test('Sunday belongs to the week that started on Monday', () => {
    expect(periodRange('week', 0, new Date(2026, 10, 15)).from).toBe('2026-11-09');
  });
  test('month lengths, leap February, label and offsets', () => {
    const feb = periodRange('month', 0, new Date(2028, 1, 10));
    expect([feb.from, feb.to, feb.label, feb.days.length]).toEqual(['2028-02-01', '2028-02-29', 'Feb 2028', 29]);
    expect(periodRange('month', 0, new Date(2027, 1, 10)).days).toHaveLength(28);
    const nov = periodRange('month', 0, new Date(2026, 10, 17));
    expect([nov.label, nov.days.length]).toEqual(['Nov 2026', 30]);
    expect(periodRange('month', -11, new Date(2026, 10, 17)).label).toBe('Dec 2025');
    expect(periodRange('month', -1, new Date(2026, 0, 5)).to).toBe('2025-12-31');
  });
  test('frameNav: prev stops at the 90-day window, partial when the start is before it', () => {
    const now = new Date(2026, 10, 17);
    expect(frameNav('week', 0, now)).toEqual({ canPrev: true, partial: false });
    expect(frameNav('week', -12, now).canPrev).toBe(true);
    expect(frameNav('week', -13, now)).toEqual({ canPrev: false, partial: true });
    expect(frameNav('month', -3, now)).toEqual({ canPrev: false, partial: true }); // Aug starts before Aug 19
    expect(frameNav('month', -1, now).canPrev).toBe(true);
  });
});

describe('barChart', () => {
  const svg = (o: Parameters<typeof barChart>[0]) => htmlToString(barChart(o));
  test('empty', () => {
    const s = svg({ bars: [] });
    expect(s).toContain('role="img"');
    expect(s).toContain('no data');
    expect(s).not.toContain('<rect');
  });
  test('single bar reaches the full plot height', () => {
    const s = svg({ bars: [{ label: 'M', values: [50] }] });
    expect(s.match(/<rect/g)).toHaveLength(1);
    expect(s).toContain('height="100.0"');
    expect(s).toContain('>M<');
  });
  test('stacked values make one rect per segment, bottom-up', () => {
    const s = svg({ bars: [{ label: 'a', values: [10, 30] }, { label: 'b', values: [20, 0] }] });
    expect(s.match(/<rect/g)).toHaveLength(3); // zero segment skipped
    expect(s).toContain('height="75.0"'); // 30 of max 40
    expect(s).toContain('var(--green)');
    expect(s).toContain('var(--blue)');
  });
  test('goal line present only with a goal, and it sets the scale when taller', () => {
    expect(svg({ bars: [{ label: 'a', values: [10] }] })).not.toContain('class="goal"');
    const s = svg({ bars: [{ label: 'a', values: [10] }], goal: 40 });
    expect(s).toContain('class="goal"');
    expect(s).toContain('height="25.0"'); // 10 of 40
  });
  test('month shows every Nth label', () => {
    const bars = Array.from({ length: 30 }, (_, i) => ({ label: String(i + 1), values: [1] }));
    expect(svg({ bars }).match(/<text/g)!.length).toBeLessThan(10);
  });
});

describe('Me trend', () => {
  const now = Date.now(), today = isoDate(now);
  const row = (day: string, kcal: number, carbs_g: number | null = 100, user_id = 1) =>
    ({ day, user_id, kcal, protein_g: 50, fat_g: 30, carbs_g, value_cents: 0, unpriced: 0 });
  const html = (daily: State['daily_nutrition'], frame?: { frame: 'week' | 'month'; offset: number }) => {
    const s = newStore(structuredClone(fixture));
    s.server!.daily_nutrition = daily;
    s.ui.tab = 'me';
    if (frame) s.ui.frames.me = frame;
    return appHtml(s);
  };
  test('averages ignore unlogged days, carbs only known days', () => {
    const days = periodRange('week', 0, now).days;
    const rows = [row(days[0]!, 1000, 100), row(days[1]!, 2000, null), { ...row(days[2]!, 0, null), protein_g: 0, fat_g: 0 } /* value-only: not logged */];
    const t = trendStats(rows, days, days[6]!, days[0]!);
    expect(t).toMatchObject({ logged: 2, of: 7, kcal: 1500, p: 50, f: 30, c: 100 });
    expect(trendStats([], days, days[6]!, days[0]!)).toMatchObject({ logged: 0, kcal: null, c: null });
  });
  test('days in the future or before the window are not counted as unlogged', () => {
    const days = periodRange('week', 0, new Date(2026, 10, 17)).days; // Mon 16 .. Sun 22
    expect(trendStats([], days, '2026-11-17', '2026-08-19').of).toBe(2);
    expect(trendStats([], days, '2026-11-17', '2026-11-17').of).toBe(1);
  });
  test('renders a week chart with a goal line and a month chart', () => {
    const s = newStore(structuredClone(fixture));
    s.server!.me.goals = { kcal: 2000, protein_g: null, fat_g: null, carbs_g: null };
    s.server!.daily_nutrition = [row(today, 1500)];
    s.ui.tab = 'me';
    const week = appHtml(s);
    expect(week).toContain('id="me-frame-week"');
    expect(week).toContain('class="goal"');
    expect(week).toContain('1 of ');
    expect(week.match(/<rect/g)).toHaveLength(1);
    s.ui.frames.me = { frame: 'month', offset: 0 };
    expect(appHtml(s)).toContain('role="img"');
  });
  test('only my rows feed the trend', () => {
    expect(html([row(today, 1500, 100, 2)])).toContain('0 of ');
  });
  test('prev is disabled at the window edge, next at the current period', () => {
    const edge = html([], { frame: 'week', offset: -13 });
    expect(edge).toMatch(/id="me-prev"[^>]*disabled/);
    expect(edge).toContain('partial');
    expect(edge).not.toMatch(/id="me-next"[^>]*disabled/);
    const cur = html([]);
    expect(cur).not.toMatch(/id="me-prev"[^>]*disabled/);
    expect(cur).toMatch(/id="me-next"[^>]*disabled/);
  });
  test('frame actions: switch kind resets offset, step moves, never past the current period', () => {
    const el = (d: Record<string, string>) => ({ dataset: d }) as unknown as HTMLElement;
    const f = () => singleton.ui.frames.me;
    actions.frameStep!(el({ k: 'me', d: '-1' }));
    actions.frameStep!(el({ k: 'me', d: '-1' }));
    expect(f()).toEqual({ frame: 'week', offset: -2 });
    actions.frame!(el({ k: 'me', v: 'month' }));
    expect(f()).toEqual({ frame: 'month', offset: 0 });
    actions.frameStep!(el({ k: 'me', d: '1' }));
    expect(f()!.offset).toBe(0);
    expect(singleton.ui.frames.spend).toBeUndefined();
  });
});
