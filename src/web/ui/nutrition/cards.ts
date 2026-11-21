import { html } from '../../html.ts';
import type { Frame } from '../../../shared/period.ts';
import { frameNav, periodBuckets, bucketKey, periodRange, windowStart } from '../../../shared/period.ts';
import type { DailyNutrition, State } from '../../../shared/types.ts';
import { isoDate } from '../../../shared/dates.ts';
import { COLORS, barChart } from '../components/chart.ts';
import { frameBar, frameOf } from '../components/frame.ts';
import { statsFor } from '../stats.ts';
import type { V } from '../components/bits.ts';

export const n = (x: number): string => x.toLocaleString('en-US');
/** Thin progress bar; over goal stays full and turns red. Rule 5: the number is never clamped. */
const bar = (value: number, goal: number) => html`<div class="bar${value > goal ? ' over' : ''}"><i style="width:${Math.min(100, (value / goal) * 100)}%"></i></div>`;
const line = (label: string, value: number | null, goal: number | null, unit: string) => html`
  <div class="row" style="margin-top:8px"><span class="grow">${label}</span><span>${value == null ? '—' : n(value)}${value != null && goal != null ? ` / ${n(goal)}` : ''} ${value == null ? '' : unit}</span></div>
  ${value != null && goal != null ? bar(value, goal) : ''}`;

/** Averages over logged days only; carbs only over days with known carbs. */
export function trendStats(rows: DailyNutrition[], days: string[], today: string, from: string) {
  const byDay = new Map(rows.map(d => [d.day, d]));
  const logged = days.map(d => byDay.get(d)).filter((d): d is DailyNutrition => !!d && (d.kcal > 0 || d.protein_g > 0 || d.fat_g > 0 || (d.carbs_g ?? 0) > 0));
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, v) => a + v, 0) / xs.length) : null);
  return {
    logged: logged.length,
    // days that could have been logged: not in the future, not before the loaded window
    of: days.filter(d => d <= today && d >= from).length,
    kcal: avg(logged.map(d => d.kcal)), p: avg(logged.map(d => d.protein_g)), f: avg(logged.map(d => d.fat_g)),
    c: avg(logged.flatMap(d => (d.carbs_g == null ? [] : [d.carbs_g]))),
  };
}

const noKcalHint = (k: number) => (k > 0 ? html`<p class="muted small" style="margin:6px 0 0">${k} ${k === 1 ? 'item' : 'items'} without kcal</p>` : '');

/** One day's macros as progress lines against the goals. */
const dayLines = (t: DailyNutrition | undefined, g: State['me']['goals']) => html`
  ${line('Calories', t?.kcal ?? 0, g.kcal, 'kcal')}
  ${line('P', t?.protein_g ?? 0, g.protein_g, 'g')}
  ${line('F', t?.fat_g ?? 0, g.fat_g, 'g')}
  ${line('C', t?.carbs_g ?? null, g.carbs_g, 'g')}
  ${noKcalHint(t?.no_kcal ?? 0)}`;

/** `mine`: this user's daily rows. */
export function todayCard(st: State, mine: DailyNutrition[]) {
  const t = mine.find(d => d.day === isoDate(st.now));
  const g = st.me.goals;
  return html`
    <div class="card" id="today">
      <h2 style="margin-top:0">Today</h2>
      ${dayLines(t, g)}
      ${Object.values(g).some(v => v != null) ? '' : html`<button id="today-goals" class="linkbtn small muted" data-a="go" data-p="goals">Set goals</button>`}
    </div>`;
}

/** Year bars: a month's bar is its daily average over logged days, so it compares with the daily goal line. */
const barKcal = (frame: Frame, rows: DailyNutrition[], key: string): number => {
  const xs = rows.filter(d => d.kcal > 0 && bucketKey(frame, d.day) === key);
  return xs.length ? Math.round(xs.reduce((a, d) => a + d.kcal, 0) / xs.length) : 0;
};

export function trendCard({ st, ui }: V, stateMine: DailyNutrition[]) {
  const now = st.now, today = isoDate(now);
  const fr = frameOf(ui, 'me'), range = periodRange(fr.frame, fr.offset, now), nav = frameNav(fr.frame, fr.offset, now, ui.online);
  const wide = statsFor(ui, 'nutrition', fr.frame, range, now); // outside the 90-day window: fetched rows, not State
  const mine = wide.data ? wide.data.rows : wide.loading ? [] : stateMine;
  const tr = trendStats(mine, range.days, today, wide.data ? range.from : windowStart(now));
  const avgCell = (l: string, v: number | null, u: string) => html`<span class="grow center"><span class="muted small">${l}</span> <b>${v == null ? '—' : n(v)}</b>${v == null || !u ? '' : html` <span class="muted small">${u}</span>`}</span>`;
  const inFrame = new Set(range.days);
  const head = frameBar('me', fr.frame, fr.offset, range.label, nav.canPrev, nav.partial && !wide.data && !wide.loading, wide.loading);
  if (fr.frame === 'day') return html`<div class="card" id="trend">${head}${dayLines(mine.find(d => d.day === range.from), st.me.goals)}</div>`;
  // Week/Month: each day stacked as protein, fat, carbs kcal; Year keeps the monthly kcal average.
  const byDay = new Map(mine.map(d => [d.day, d]));
  const values = (key: string) => {
    if (fr.frame === 'year') return [barKcal(fr.frame, mine, key)];
    const d = byDay.get(key);
    return d ? [d.protein_g * 4, d.fat_g * 9, (d.carbs_g ?? 0) * 4] : [0, 0, 0];
  };
  const legend = ['P', 'F', 'C'].map((l, i) => html`<span><i style="display:inline-block;width:10px;height:10px;border:1px solid var(--ink);background:${COLORS[i]!}"></i> ${l}</span>`);
  return html`
    <div class="card" id="trend">
      ${head}
      ${barChart({ bars: periodBuckets(fr.frame, range).map(b => ({ label: b.label, values: values(b.key) })), goal: st.me.goals.kcal, fmt: n })}
      ${fr.frame === 'year' ? '' : html`<div class="row small muted" style="gap:10px;flex-wrap:wrap;margin:6px 0">${legend}</div>`}
      <div class="row" style="margin-top:8px">${avgCell('kcal', tr.kcal, '')}${avgCell('P', tr.p, 'g')}${avgCell('F', tr.f, 'g')}${avgCell('C', tr.c, 'g')}</div>
      <p class="muted small" style="margin:6px 0 0">Daily average · ${tr.logged} of ${tr.of} days logged</p>
      ${noKcalHint(mine.filter(d => inFrame.has(d.day)).reduce((a, d) => a + d.no_kcal, 0))}
    </div>`;
}
