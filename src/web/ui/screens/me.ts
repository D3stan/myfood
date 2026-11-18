import { html } from '../../html.ts';
import { computeDailyNutrition } from '../../../shared/nutrition.ts';
import type { V } from '../components/bits.ts';
import { todayCard, trendCard } from '../nutrition/cards.ts';

export function me(v: V) {
  const { st, ui } = v;
  // Server clock (st.now), not the phone's, so the day matches the server's day keys.
  const mine = computeDailyNutrition(st.events, st.items, st.daily_nutrition).filter(d => d.user_id === st.me.id);
  return html`
    <div class="top"><h1 class="grow" style="margin:0">Me</h1><button id="me-settings" class="btn alt icon" data-a="go" data-p="settings" aria-label="Settings">⚙️</button></div>
    ${todayCard(st, mine)}
    ${trendCard(v, mine)}
    ${ui.standalone ? '' : html`<p class="note">Install it: tap Share, then Add to Home Screen. Sign in inside the installed app.</p>`}
  `;
}
