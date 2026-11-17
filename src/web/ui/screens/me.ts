import { html } from '../../html.ts';
import { isoDate } from '../../../shared/dates.ts';
import { computeDailyNutrition } from '../../../shared/nutrition.ts';
import type { V } from '../components/bits.ts';

const n = (x: number): string => x.toLocaleString('en-US');
/** Thin progress bar; over goal stays full and turns red. Rule 5: the number is never clamped. */
const bar = (value: number, goal: number) => html`<div class="bar${value > goal ? ' over' : ''}"><i style="width:${Math.min(100, (value / goal) * 100)}%"></i></div>`;
const line = (label: string, value: number | null, goal: number | null, unit: string) => html`
  <div class="row" style="margin-top:8px"><span class="grow">${label}</span><span>${value == null ? '—' : n(value)}${value != null && goal != null ? ` / ${n(goal)}` : ''} ${value == null ? '' : unit}</span></div>
  ${value != null && goal != null ? bar(value, goal) : ''}`;

export function me({ st, ui }: V) {
  const today = isoDate(Date.now());
  const t = computeDailyNutrition(st.events, st.items, st.daily_nutrition).find(d => d.user_id === st.me.id && d.day === today);
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
    ${ui.standalone ? '' : html`<p class="note">Install it: tap Share, then Add to Home Screen. Sign in inside the installed app.</p>`}
  `;
}
