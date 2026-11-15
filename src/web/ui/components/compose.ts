import { html } from '../../html.ts';
import { qOf } from '../../store.ts';
import type { Sheet } from '../../store.ts';
import { VERB, stepOf, unitOf } from './bits.ts';
import type { V } from './bits.ts';
import { stepper } from './stepper.ts';

export const composeSheet = ({ ui }: V, sh: Sheet) => html`<h2 id="sheet-title">Tell me</h2>
  <textarea id="f-text" rows="3" autofocus data-f="text" placeholder="Ate 2 eggs… bought milk… or snap a receipt" aria-label="What did you eat or buy?">${ui.f.text ?? ''}</textarea>
  ${ui.files.length ? html`<div class="thumbs">${ui.files.map((f, i) => html`<div class="thumb" id="th-${i}-${f.file.size}"><img src="${f.url}" alt="Photo ${i + 1}">
    <button data-a="rmPhoto" data-k="${i}" aria-label="Remove photo ${i + 1}">×</button></div>`)}</div>` : ''}
  <div class="row" style="margin-top:12px">
    <label class="btn alt icon" for="photo-input" aria-label="Add photos">📷</label>
    <input id="photo-input" class="sr" type="file" accept="image/*" multiple data-c="photos">
    <button class="btn right" data-a="send" ${ui.online && !sh.busy ? '' : 'disabled'}>${sh.busy ? 'Sending…' : 'Send'}</button></div>`;

export function reviewSheet(v: V, sh: Sheet) {
  const { st, ui } = v, job = st.jobs.find(j => j.id === sh.id), events = sh.events ?? [];
  const left = events.reduce((a, e) => a + e.lines.length, 0);
  return html`<h2 id="sheet-title">Receipt</h2>
    <p>${job?.result?.reply ?? ''}</p>
    ${events.map((e, ei) => html`<h3>${VERB[e.kind]}</h3>${e.lines.map((l, li) => {
      const k = `${ei}.${li}`, it = l.item_id == null ? undefined : st.items.find(i => i.id === l.item_id);
      const nu = l.new_item, orig = sh.orig?.[ei]?.lines[li];
      return html`<div class="rv" id="rv-${k}">
        <div class="line"><span class="emoji">${it?.emoji ?? nu?.emoji ?? '❔'}</span>
          <span class="n">${it?.name ?? nu?.name ?? 'Unknown'} ${nu ? html`<span class="tag">new</span>` : ''}
            ${nu ? html`<span class="muted small">${nu.category}, ${nu.unit}, pack ${nu.pack_size}</span>` : ''}</span>
          <button class="btn alt icon" data-a="rmLine" data-k="${k}" aria-label="Remove line">×</button></div>
        ${stepper(ui, k, qOf(sh, k), (it ? stepOf(it) : nu?.step) ?? 1, it ? unitOf(it) : (nu?.unit ?? ''), true)}
        ${l.raw ? html`<div class="small muted clip">${l.raw}</div>` : ''}
        <select id="rm-${k}" data-c="rematch" data-k="${k}" aria-label="Match to">
          ${orig?.new_item ? html`<option value="new" ${nu ? 'selected' : ''}>New: ${orig.new_item.name}</option>` : ''}
          ${st.items.map(i => html`<option value="${i.id}" ${l.item_id === i.id ? 'selected' : ''}>${i.emoji} ${i.name}</option>`)}
        </select></div>`;
    })}`)}
    ${left ? '' : html`<p class="note">Nothing left to add.</p>`}
    <div class="row" style="margin-top:16px"><button class="btn alt" data-a="discard" ${ui.online && !sh.busy ? '' : 'disabled'}>Discard</button>
      <button class="btn right" data-a="apply" ${ui.online && !sh.busy && left ? '' : 'disabled'}>Add to pantry</button></div>`;
}
