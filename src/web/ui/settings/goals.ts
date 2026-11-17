import { html } from '../../html.ts';
import type { V } from '../components/bits.ts';

export const GOAL_FIELDS = [['kcal', 'Calories (kcal)'], ['protein_g', 'Protein (g)'], ['fat_g', 'Fat (g)'], ['carbs_g', 'Carbs (g)']] as const;

export function goals({ st, ui }: V) {
  return html`
    <div class="card">
      <p class="small muted" style="margin-top:0">Daily targets. Leave a field empty for no goal.</p>
      ${GOAL_FIELDS.map(([k, label]) => html`
        <label class="field" for="goal-${k}">${label}</label>
        <input id="goal-${k}" type="text" inputmode="decimal" data-f="goal_${k}" value="${ui.f[`goal_${k}`] ?? st.me.goals[k] ?? ''}" autocomplete="off">`)}
      <div class="row" style="margin-top:12px"><button class="btn right" data-a="saveGoals" ${ui.online ? '' : 'disabled'}>Save</button></div>
    </div>
  `;
}
