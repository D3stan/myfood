import { html } from '../../html.ts';
import { isoDate } from '../../../shared/dates.ts';
import { computeDailyNutrition } from '../../../shared/stock.ts';
import { fmtCost, fmtNum } from '../../../shared/text.ts';
import type { FoodEvent } from '../../../shared/types.ts';
import { VERB, clock, lineText, userOf } from '../components/bits.ts';
import type { V } from '../components/bits.ts';

/** Newest first, split by local day: Today, Yesterday, then dates. */
export function groupByDay(events: FoodEvent[], now = new Date()): { day: string; label: string; events: FoodEvent[] }[] {
  const dayStart = (t: number | Date): number => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const today = dayStart(now), yesterday = dayStart(today - 1);
  const groups: { key: number; day: string; label: string; events: FoodEvent[] }[] = [];
  for (const e of [...events].sort((a, b) => b.at - a.at)) {
    const key = dayStart(e.at);
    let g = groups.at(-1);
    if (g?.key !== key) {
      const label = key === today ? 'Today' : key === yesterday ? 'Yesterday'
        : new Date(key).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
      groups.push(g = { key, day: isoDate(key), label, events: [] });
    }
    g.events.push(e);
  }
  return groups;
}

export function history({ st, ui }: V) {
  const daily = computeDailyNutrition(st.events, st.items, st.daily_nutrition);
  const dayMacros = (day: string): { kcal: number; protein_g: number } => {
    let kcal = 0, protein_g = 0;
    for (const d of daily) {
      if (d.day !== day) continue;
      if (ui.historyScope === 'me' && d.user_id !== st.me.id) continue;
      kcal += d.kcal;
      protein_g += d.protein_g;
    }
    return { kcal: Math.round(kcal), protein_g: Math.round(protein_g * 10) / 10 };
  };

  return html`
    <div class="top">
      <h1 style="margin:0">History</h1>
      <div class="seg right" style="margin:0" role="group" aria-label="Nutrition totals scope">
        <button class="${ui.historyScope === 'me' ? 'on' : ''}" data-a="historyScope" data-v="me">My totals</button>
        <button class="${ui.historyScope === 'all' ? 'on' : ''}" data-a="historyScope" data-v="all">Household</button>
      </div>
    </div>
    ${st.events.length ? '' : html`<p class="note">Nothing logged yet.</p>`}
    ${groupByDay(st.events).map(g => {
      const m = dayMacros(g.day);
      return html`
        <div class="day row" style="align-items:center;gap:8px;flex-wrap:wrap">
          <span>${g.label}</span>
          ${m.kcal > 0 || m.protein_g > 0
            ? html`<span class="macro-pill right">${m.kcal.toLocaleString()} kcal · ${fmtNum(m.protein_g)}g P</span>`
            : ''}
        </div>
        ${g.events.map(e => html`
          <button class="ev ${e.kind}" id="ev-${e.cid}" data-a="open" data-s="event" data-id="${e.cid}">
            <span class="who">${userOf(st, e)?.emoji ?? '🙂'}</span>
            <span class="grow">
              <b>${VERB[e.kind]}</b> ${e.lines.map(l => lineText(st.items, l)).join(', ')}
              ${e.source === 'cook' ? html` <span class="tag">cooked</span>` : ''}
              ${e.cost_cents != null && e.cost_cents > 0 ? html` <span class="tag">${fmtCost(e.cost_cents, st.currency)}</span>` : ''}
              ${e.note ? html`<span class="small muted clip">${e.note}</span>` : ''}
            </span>
            <span class="t">${clock(e.at)}</span>
          </button>
        `)}
      `;
    })}
  `;
}
