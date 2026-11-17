import { html } from '../../html.ts';
import { hourToTime } from '../components/bits.ts';
import type { V } from '../components/bits.ts';

export function presets({ st, ui }: V) {
  return html`
    <h2>Presets</h2>
    ${st.presets.map(p => html`<div class="line" id="pre-${p.id}"><span class="emoji">${p.emoji}</span><span class="n">${p.name} <span class="muted small">${hourToTime(p.hour)}</span></span>
      <button class="btn alt icon" data-a="open" data-s="presetEdit" data-id="${p.id}" aria-label="Edit ${p.name}">✏️</button>
      <button class="btn alt icon" data-a="delPreset" data-id="${p.id}" aria-label="Delete ${p.name}" ${ui.online ? '' : 'disabled'}>🗑️</button></div>`)}
    <div class="row" style="margin:12px 0"><button class="btn" data-a="open" data-s="presetEdit">New preset</button></div>
  `;
}
