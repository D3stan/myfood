import { html } from '../../html.ts';
import { addDays, isoDate } from '../../../shared/dates.ts';
import { shown } from '../../../shared/stock.ts';
import { fmtCost, fmtNum } from '../../../shared/text.ts';
import { qOf } from '../../store.ts';
import type { Sheet } from '../../store.ts';
import { VERB, stepOf, unitOf } from './bits.ts';
import type { V } from './bits.ts';
import { stepper } from './stepper.ts';

export function composeSheet({ ui }: V, sh: Sheet) {
  const isAudit = (sh.mode ?? ui.jobMode) === 'audit';
  return html`<h2 id="sheet-title">${isAudit ? 'Fridge audit' : 'Tell me'}</h2>
    <div class="seg" role="group" aria-label="Mode" style="margin-bottom:10px">
      <button class="${!isAudit ? 'on' : ''}" data-a="jobMode" data-v="auto">Receipt / Note</button>
      <button class="${isAudit ? 'on' : ''}" data-a="jobMode" data-v="audit">Fridge audit</button>
    </div>
    <textarea id="f-text" rows="3" autofocus data-f="text" placeholder="${isAudit ? 'Snap your open fridge (optional note, e.g. half a carton of milk left)' : 'Ate 2 eggs… bought milk… or snap a receipt'}" aria-label="${isAudit ? 'Fridge audit note' : 'What did you eat or buy?'}">${ui.f.text ?? ''}</textarea>
    ${ui.files.length ? html`<div class="thumbs">${ui.files.map((f, i) => html`<div class="thumb" id="th-${i}-${f.file.size}"><img src="${f.url}" alt="Photo ${i + 1}">
      <button data-a="rmPhoto" data-k="${i}" aria-label="Remove photo ${i + 1}">×</button></div>`)}</div>` : ''}
    <div class="row" style="margin-top:12px">
      <label class="btn alt icon" for="photo-input" aria-label="Add photos">📷</label>
      <input id="photo-input" class="sr" type="file" accept="image/*" multiple data-c="photos">
      <button class="btn right" data-a="send" ${ui.online && !sh.busy ? '' : 'disabled'}>${sh.busy ? 'Sending…' : 'Send'}</button></div>`;
}

export function reviewSheet(v: V, sh: Sheet) {
  const { st, ui } = v, job = st.jobs.find(j => j.id === sh.id), events = sh.events ?? [];
  const cookBatches = sh.cook ?? job?.result?.cook ?? [];
  const isAudit = job?.mode === 'audit';
  const left = events.reduce((a, e) => a + e.lines.length, 0) + cookBatches.length;
  const today = isoDate(st.now);
  return html`<h2 id="sheet-title">${isAudit ? 'Fridge audit — review adjustments' : 'Receipt'}</h2>
    <p>${job?.result?.reply ?? ''}</p>
    ${events.map((e, ei) => html`<h3>${e.kind === 'eat' && e.lines.some(l => l.item_id != null && st.items.find(i => i.id === l.item_id)?.unit === 'level') ? 'set' : VERB[e.kind]}</h3>${e.lines.map((l, li) => {
      const k = `${ei}.${li}`, it = l.item_id == null ? undefined : st.items.find(i => i.id === l.item_id);
      const nu = l.new_item, orig = sh.orig?.[ei]?.lines[li];
      const lineUnit = l.unit ?? (it ? unitOf(it) : (nu?.unit ?? ''));
      const meta: string[] = [];
      if (isAudit && it) meta.push(`was ${fmtNum(shown(it.stock))} → ${fmtNum(qOf(sh, k))} ${unitOf(it)}`);
      if (!isAudit && l.price != null) meta.push(fmtCost(Math.round(l.price * 100), st.currency));
      if (l.expires_in_days != null) meta.push(`exp ${addDays(today, l.expires_in_days)}`);
      return html`<div class="rv" id="rv-${k}">
        <div class="line"><span class="emoji">${it?.emoji ?? nu?.emoji ?? '❔'}</span>
          <span class="n">${it?.name ?? nu?.name ?? 'Unknown'} ${nu ? html`<span class="tag">new</span>` : ''}
            ${nu ? html`<span class="muted small">${nu.category}, ${nu.unit}, pack ${nu.pack_size}</span>` : ''}</span>
          <button class="btn alt icon" data-a="rmLine" data-k="${k}" aria-label="Remove line">×</button></div>
        ${meta.length ? html`<div class="small muted">${meta.join(' · ')}</div>` : ''}
        ${stepper(ui, k, qOf(sh, k), (it ? stepOf(it) : nu?.step) ?? 1, lineUnit, true)}
        ${l.raw ? html`<div class="small muted clip">${l.raw}</div>` : ''}
        <select id="rm-${k}" data-c="rematch" data-k="${k}" aria-label="Match to">
          ${orig?.new_item ? html`<option value="new" ${nu ? 'selected' : ''}>New: ${orig.new_item.name}</option>` : ''}
          ${st.items.map(i => html`<option value="${i.id}" ${l.item_id === i.id ? 'selected' : ''}>${i.emoji} ${i.name}</option>`)}
        </select></div>`;
    })}`)}
    ${cookBatches.length ? html`<h3>Cooked batches</h3>${cookBatches.map((c, ci) => {
      const meal = c.meal_item_id != null ? st.items.find(i => i.id === c.meal_item_id) : undefined;
      const qtyBits = [c.portions ? `${fmtNum(c.portions)} port` : '', c.total_g ? `${fmtNum(c.total_g)} g` : ''].filter(Boolean).join(' · ');
      const macroBits = [c.kcal_total != null ? `${Math.round(c.kcal_total)} kcal` : '', c.protein_total != null ? `${fmtNum(c.protein_total)}g P` : '', c.fat_total != null ? `${fmtNum(c.fat_total)}g F` : '', c.carbs_total != null ? `${fmtNum(c.carbs_total)}g C` : ''].filter(Boolean).join(' · ');
      const exp = c.expires_in_days != null ? `exp ${addDays(today, c.expires_in_days)}` : '';
      return html`<div class="rv" id="rvc-${ci}">
        <div class="line"><span class="emoji">${meal?.emoji ?? c.emoji ?? '🍲'}</span>
          <span class="n"><b>${meal?.name ?? c.name ?? 'Cooked meal'}</b> <span class="tag">cook</span></span>
          <button class="btn alt icon" data-a="rmCook" data-k="${ci}" aria-label="Remove cooked batch">×</button></div>
        <div class="small muted">${[qtyBits, exp, macroBits].filter(Boolean).join(' · ')}</div>
        ${c.ingredients.length ? html`<div class="small muted">Uses: ${c.ingredients.map(ing => {
          const ii = st.items.find(i => i.id === ing.item_id);
          return `${ii?.emoji ?? '❔'} ${ii?.name ?? `#${ing.item_id}`} (${fmtNum(ing.qty)} ${ii ? unitOf(ii) : ''})`;
        }).join(', ')}</div>` : ''}
      </div>`;
    })}` : ''}
    ${!isAudit && events.length ? html`<label class="field" for="f-reviewTotalCost">Total cost (${st.currency}, optional)</label>
      <input id="f-reviewTotalCost" type="text" inputmode="decimal" placeholder="0.00" data-f="reviewTotalCost" value="${ui.f.reviewTotalCost ?? ''}" autocomplete="off">` : ''}
    ${left ? '' : html`<p class="note">Nothing left to add.</p>`}
    <div class="row" style="margin-top:16px"><button class="btn alt" data-a="discard" ${ui.online && !sh.busy ? '' : 'disabled'}>Discard</button>
      <button class="btn right" data-a="apply" ${ui.online && !sh.busy && left ? '' : 'disabled'}>${isAudit ? 'Apply adjustments' : 'Add to pantry'}</button></div>`;
}
