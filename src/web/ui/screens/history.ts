import { html } from '../../html.ts';
import type { FoodEvent } from '../../../shared/types.ts';
import { VERB, clock, lineText, userOf } from '../components/bits.ts';
import type { V } from '../components/bits.ts';

/** Newest first, split by local day: Today, Yesterday, then dates. */
export function groupByDay(events: FoodEvent[], now = new Date()): { label: string; events: FoodEvent[] }[] {
  const day = (t: number | Date): number => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const today = day(now), yesterday = day(today - 1);
  const groups: { key: number; label: string; events: FoodEvent[] }[] = [];
  for (const e of [...events].sort((a, b) => b.at - a.at)) {
    const key = day(e.at);
    let g = groups.at(-1);
    if (g?.key !== key) {
      const label = key === today ? 'Today' : key === yesterday ? 'Yesterday'
        : new Date(key).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
      groups.push(g = { key, label, events: [] });
    }
    g.events.push(e);
  }
  return groups;
}

export const history = ({ st }: V) => html`<h1>History</h1>
  ${st.events.length ? '' : html`<p class="note">Nothing logged yet.</p>`}
  ${groupByDay(st.events).map(g => html`<div class="day">${g.label}</div>${g.events.map(e => html`
    <button class="ev ${e.kind}" id="ev-${e.cid}" data-a="open" data-s="event" data-id="${e.cid}">
      <span class="who">${userOf(st, e)?.emoji ?? '🙂'}</span>
      <span class="grow"><b>${VERB[e.kind]}</b> ${e.lines.map(l => lineText(st.items, l)).join(', ')}${e.note ? html`<span class="small muted clip">${e.note}</span>` : ''}</span>
      <span class="t">${clock(e.at)}</span></button>`)}`)}`;
