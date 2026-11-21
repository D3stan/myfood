import { afterEach, describe, expect, test, vi } from 'vitest';
import { isoDate } from '../src/shared/dates.ts';
import { frameNav, needsStats, periodBuckets, periodRange } from '../src/shared/period.ts';
import type { NutritionStats, SpendStats, State } from '../src/shared/types.ts';
import { newStore, store as singleton } from '../src/web/store.ts';
import { htmlToString } from '../src/web/html.ts';
import { barChart } from '../src/web/ui/components/chart.ts';
import { actions } from '../src/web/ui/actions.ts';
import { appHtml } from '../src/web/ui/render.ts';
import { trendStats } from '../src/web/ui/nutrition/cards.ts';
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

describe('Day frame', () => {
  const now = new Date(2026, 10, 20); // Fri 20 Nov 2026
  test('periodRange: one day, offset steps back', () => {
    const d = periodRange('day', 0, now);
    expect(d).toMatchObject({ from: '2026-11-20', to: '2026-11-20', label: 'Fri 20 Nov', days: ['2026-11-20'] });
    expect(periodRange('day', -1, now).label).toBe('Thu 19 Nov');
    expect(needsStats('day', periodRange('day', -100, now), now)).toBe(true);
    expect(needsStats('day', d, now)).toBe(false);
  });
});

describe('Year frame', () => {
  test('range is Jan 1..Dec 31 with the year as label, offsets move whole years, leap years have 366 days', () => {
    const y = periodRange('year', 0, new Date(2026, 10, 17));
    expect([y.from, y.to, y.label, y.days.length]).toEqual(['2026-01-01', '2026-12-31', '2026', 365]);
    expect(periodRange('year', -1, new Date(2026, 10, 17)).label).toBe('2025');
    expect(periodRange('year', 0, new Date(2028, 5, 1)).days).toHaveLength(366);
  });
  test('buckets: 12 months for a year, a day each otherwise; stats are needed for a year and past the window', () => {
    const now = new Date(2026, 10, 17), y = periodRange('year', 0, now);
    const b = periodBuckets('year', y);
    expect(b).toHaveLength(12);
    expect([b[0]!.key, b[11]!.key, b[0]!.label, b[11]!.label]).toEqual(['2026-01', '2026-12', 'J', 'D']);
    expect(periodBuckets('week', periodRange('week', 0, now)).map(x => x.label).join('')).toBe('MTWTFSS');
    expect(periodBuckets('month', periodRange('month', 0, now))).toHaveLength(30);
    expect(needsStats('year', y, now)).toBe(true);
    expect(needsStats('week', periodRange('week', 0, now), now)).toBe(false);
    expect(needsStats('week', periodRange('week', -13, now), now)).toBe(true);
    expect(frameNav('year', 0, now, true).canPrev).toBe(true);
    expect(frameNav('year', 0, now).canPrev).toBe(false);
  });
});

describe('Stats beyond the window', () => {
  const now = fixture.now;
  const mount = (tab: 'me' | 'spend', frame: { frame: 'week' | 'month' | 'year'; offset: number }) => {
    singleton.server = structuredClone(fixture);
    singleton.ui.tab = tab;
    singleton.ui.online = true;
    singleton.ui.stats = { spend: {}, nutrition: {} };
    singleton.ui.frames[tab] = frame;
    return () => appHtml(singleton);
  };
  const reply = (body: unknown) => {
    const f = vi.fn(async (..._a: unknown[]) => ({ ok: true, status: 200, json: async () => body }));
    vi.stubGlobal('fetch', f);
    return f;
  };
  afterEach(() => { vi.unstubAllGlobals(); singleton.server = null; singleton.ui.frames = {}; singleton.ui.online = true; });
  const el = (d: Record<string, string>) => ({ dataset: d }) as unknown as HTMLElement;

  test('Me: a Year frame renders 12 bars from the fetched rows (monthly daily average), no partial note', () => {
    const view = mount('me', { frame: 'year', offset: 0 });
    const y = periodRange('year', 0, now);
    expect(view()).toContain('Loading…');
    const rows = ['01', '01', '06'].map((m, i) => ({ day: `${y.label}-${m}-0${i + 1}`, user_id: 1, kcal: i === 1 ? 3000 : 1000, protein_g: 10, fat_g: 10, carbs_g: 1, value_cents: 0, unpriced: 0, no_kcal: 0 }));
    singleton.ui.stats.nutrition[`${y.from}|${y.to}`] = { from: y.from, to: y.to, rows } satisfies NutritionStats;
    const out = view();
    expect(out).not.toContain('Loading…');
    expect(out).not.toContain('partial');
    expect(out.match(/<rect/g)).toHaveLength(2); // Jan and Jun
    expect(out).toContain('id="me-frame-year"');
    expect(out).toContain('>2026<'); // year label
    expect(out).toMatch(/Daily average · 3 of \d+ days logged/);
  });

  test('Spend: a Year frame renders 12 month bars and totals from the fetched rows, no week cards', () => {
    const view = mount('spend', { frame: 'year', offset: 0 });
    const y = periodRange('year', 0, now);
    const data: SpendStats = {
      from: y.from, to: y.to,
      paid: [{ day: `${y.label}-01-05`, user_id: 1, cents: 3000 }, { day: `${y.label}-01-20`, user_id: 2, cents: 1000 }, { day: `${y.label}-03-02`, user_id: 2, cents: 500 }],
      ate: [{ day: `${y.label}-01-06`, user_id: 1, value_cents: 700, unpriced: 3 }],
    };
    singleton.ui.stats.spend[`${y.from}|${y.to}`] = data;
    const out = view();
    expect(out).toMatch(/id="spend-total"[^>]*>45\s?kr\./);
    expect(out.match(/<rect/g)).toHaveLength(3); // Jan: 2 users, Mar: 1
    expect(out.match(/<text/g)!.length).toBeLessThanOrEqual(12);
    expect(out).toMatch(/id="spend-user-1"[\s\S]*?paid 30\s?kr\.[\s\S]*?ate 7\s?kr\.[\s\S]*?\+3 unpriced/);
    expect(out).not.toContain('id="week-');
    expect(out).not.toContain('partial');
  });

  test('a period outside the window shows Loading… until the stats arrive, then renders them', async () => {
    const view = mount('me', { frame: 'week', offset: 0 });
    const p = periodRange('week', -40, now);
    const fetchMock = reply({ from: p.from, to: p.to, rows: [{ day: p.days[2], user_id: 1, kcal: 1800, protein_g: 1, fat_g: 1, carbs_g: 1, value_cents: 0, unpriced: 0, no_kcal: 0 }] });
    actions.frameStep!(el({ k: 'me', d: '-1' })); // week -1: inside the window, nothing fetched
    expect(fetchMock).not.toHaveBeenCalled();
    singleton.ui.frames.me = { frame: 'week', offset: -39 };
    actions.frameStep!(el({ k: 'me', d: '-1' }));
    expect(view()).toContain('Loading…');
    expect(view()).not.toContain('partial');
    expect(view()).not.toMatch(/id="me-prev"[^>]*disabled/); // online: can keep stepping back
    await vi.waitFor(() => expect(view()).not.toContain('Loading…'));
    expect(fetchMock).toHaveBeenCalledWith(`/api/stats/nutrition?from=${p.from}&to=${p.to}`, expect.anything());
    expect(view()).toContain('1 of 7 days logged');
    expect(view().match(/<rect/g)).toHaveLength(3);
    // stepping forward fetches that neighbour once; coming back to the first is a cache hit
    actions.frameStep!(el({ k: 'me', d: '1' }));
    actions.frameStep!(el({ k: 'me', d: '-1' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('a failed fetch falls back to State with the partial note; offline never fetches', async () => {
    const view = mount('spend', { frame: 'week', offset: -39 });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    actions.frameStep!(el({ k: 'spend', d: '-1' }));
    await vi.waitFor(() => expect(view()).toContain('partial: only the last 90 days'));
    expect(view()).not.toContain('Loading…');
    singleton.ui.online = false;
    const fetchMock = reply({});
    actions.frameStep!(el({ k: 'spend', d: '-1' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(view()).toContain('partial: only the last 90 days');
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
  const now = fixture.now, today = isoDate(now); // the screen reads the server clock
  const row = (day: string, kcal: number, carbs_g: number | null = 100, user_id = 1) =>
    ({ day, user_id, kcal, protein_g: 50, fat_g: 30, carbs_g, value_cents: 0, unpriced: 0, no_kcal: 0 });
  const html = (daily: State['daily_nutrition'], frame?: { frame: 'week' | 'month'; offset: number }, online = true) => {
    const s = newStore(structuredClone(fixture));
    s.ui.online = online;
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
    expect(week.match(/<rect/g)).toHaveLength(3);
    s.ui.frames.me = { frame: 'month', offset: 0 };
    expect(appHtml(s)).toContain('role="img"');
  });
  test('week chart stacks P/F/C kcal per day; day frame shows that day as macro lines', () => {
    const s = newStore(structuredClone(fixture));
    s.server!.daily_nutrition = [row(today, 1500)];
    s.ui.tab = 'me';
    expect(appHtml(s).match(/<rect/g)).toHaveLength(3); // 200 + 270 + 400 kcal
    s.ui.frames.me = { frame: 'day', offset: 0 };
    const day = appHtml(s);
    expect(day).toContain('id="me-frame-day"');
    expect(day).toContain('Calories');
    expect(day).not.toContain('<svg class="chart"');
    expect(day).not.toContain('days logged');
  });
  test('only my rows feed the trend', () => {
    expect(html([row(today, 1500, 100, 2)])).toContain('0 of ');
  });
  test('offline, prev is disabled at the window edge, next at the current period', () => {
    const edge = html([], { frame: 'week', offset: -13 }, false); // offline: no stats, so State only
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
