import { html } from '../../html.ts';
import { isoDate } from '../../../shared/dates.ts';
import { computeDailyNutrition } from '../../../shared/nutrition.ts';
import { frameNav, periodRange, windowStart } from '../../../shared/period.ts';
import type { DailyNutrition } from '../../../shared/types.ts';
import type { V } from '../components/bits.ts';
import { barChart } from '../components/chart.ts';
import { frameBar, frameOf } from '../components/frame.ts';

const n = (x: number): string => x.toLocaleString('en-US');
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

export function me({ st, ui }: V) {
  const now = Date.now(), today = isoDate(now);
  const mine = computeDailyNutrition(st.events, st.items, st.daily_nutrition).filter(d => d.user_id === st.me.id);
  const t = mine.find(d => d.day === today);
  const fr = frameOf(ui, 'me'), range = periodRange(fr.frame, fr.offset, now), nav = frameNav(fr.frame, fr.offset, now);
  const kcalOf = new Map(mine.map(d => [d.day, d.kcal]));
  const tr = trendStats(mine, range.days, today, windowStart(now));
  const avgCell = (l: string, v: number | null, u: string) => html`<span class="grow center"><b>${v == null ? '—' : n(v)}</b> <span class="muted small">${l}${v == null ? '' : ` ${u}`}</span></span>`;
  const g = st.me.goals;
  return html`
    <div class="row" style="align-items:center"><h1 class="grow" style="margin:0">Me</h1><button id="me-settings" class="btn alt icon" data-a="go" data-p="settings" aria-label="Settings">⚙️</button></div>
    <div class="card" id="today">
      <h2 style="margin-top:0">Today</h2>
      ${line('Calories', t?.kcal ?? 0, g.kcal, 'kcal')}
      ${line('P', t?.protein_g ?? 0, g.protein_g, 'g')}
      ${line('F', t?.fat_g ?? 0, g.fat_g, 'g')}
      ${line('C', t?.carbs_g ?? null, g.carbs_g, 'g')}
      ${Object.values(g).some(v => v != null) ? '' : html`<button id="today-goals" class="linkbtn small muted" data-a="go" data-p="goals">Set goals</button>`}
    </div>
    <div class="card" id="trend">
      ${frameBar('me', fr.frame, fr.offset, range.label, nav.canPrev, nav.partial)}
      ${barChart({ bars: range.days.map((d, i) => ({ label: fr.frame === 'week' ? 'MTWTFSS'[i]! : String(i + 1), values: [kcalOf.get(d) ?? 0] })), goal: g.kcal, fmt: n })}
      <div class="row" style="margin-top:8px">${avgCell('kcal', tr.kcal, '')}${avgCell('P', tr.p, 'g')}${avgCell('F', tr.f, 'g')}${avgCell('C', tr.c, 'g')}</div>
      <p class="muted small" style="margin:6px 0 0">Daily average · ${tr.logged} of ${tr.of} days logged</p>
    </div>
    ${ui.standalone ? '' : html`<p class="note">Install it: tap Share, then Add to Home Screen. Sign in inside the installed app.</p>`}
  `;
}
