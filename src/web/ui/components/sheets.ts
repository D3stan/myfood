import { html } from '../../html.ts';
import { isoDate } from '../../../shared/dates.ts';
import { eventNutrition, portionCount, shown } from '../../../shared/stock.ts';
import { fmtCost, fmtNum } from '../../../shared/text.ts';
import { CATEGORIES, UNITS } from '../../../shared/types.ts';
import type { Item, Unit } from '../../../shared/types.ts';
import { qOf } from '../../store.ts';
import type { Sheet } from '../../store.ts';
import { VERB, clock, hourToTime, levelName, stepOf, unitOf, userOf } from './bits.ts';
import type { V } from './bits.ts';
import { stepper } from './stepper.ts';

const field = (f: Record<string, string>, id: string, label: string, dec = false) =>
  html`<label class="field" for="f-${id}">${label}</label><input id="f-${id}" type="text" inputmode="${dec ? 'decimal' : 'text'}" data-f="${id}" value="${f[id] ?? ''}" autocomplete="off">`;

const select = (f: Record<string, string>, id: string, label: string, options: readonly (string | readonly [string, string])[], changeAction?: string) =>
  html`<label class="field" for="f-${id}">${label}</label><select id="f-${id}" data-f="${id}" ${changeAction ? html`data-c="${changeAction}"` : ''}>${options.map(o => {
    const [val, text] = typeof o === 'string' ? [o, o] : o;
    return html`<option value="${val}" ${f[id] === val ? 'selected' : ''}>${text}</option>`;
  })}</select>`;

export const macroBasis = (unit: Unit): { mult: number; label: string } =>
  unit === 'g' || unit === 'ml' ? { mult: 100, label: `100${unit}` } : { mult: 1, label: `1 ${unit}` };

export const itemFields = (f: Record<string, string>, isNew: boolean) => {
  const unit = (UNITS.includes(f.unit as Unit) ? f.unit : 'pc') as Unit;
  const { label } = macroBasis(unit);
  return html`
    ${field(f, 'name', 'Name')}${field(f, 'emoji', 'Emoji')}${select(f, 'category', 'Category', CATEGORIES)}${select(f, 'unit', 'Unit', UNITS, 'rerender')}
    ${select(f, 'itemOwner', 'Who owns this?', [['shared', 'Shared (household)'], ['mine', 'Mine (personal)']])}
    <label class="field" for="f-itemExpiry">Expires</label><input id="f-itemExpiry" type="date" data-f="itemExpiry" value="${f.itemExpiry ?? ''}">
    ${field(f, 'step', 'One tap changes by', true)}${field(f, 'pack', 'Units in a pack', true)}
    ${field(f, 'low', 'Running low at (empty = only when out)', true)}
    ${field(f, 'itemKcal', `Calories (kcal / ${label})`, true)}${field(f, 'itemProtein', `Protein (g / ${label})`, true)}
    ${isNew ? field(f, 'start', 'How much is there now? (optional)', true) : ''}`;
};

export const itemToFields = (i: Item): Record<string, string> => {
  const { mult } = macroBasis(i.unit);
  return {
    name: i.name, emoji: i.emoji, category: i.category, unit: i.unit,
    step: fmtNum(i.step), pack: fmtNum(i.pack_size), low: i.low_at == null ? '' : fmtNum(i.low_at),
    itemOwner: i.owner_id == null ? 'shared' : 'mine',
    itemExpiry: i.expires_at ?? '',
    itemKcal: i.kcal_per_unit == null ? '' : fmtNum(i.kcal_per_unit * mult),
    itemProtein: i.protein_per_unit == null ? '' : fmtNum(i.protein_per_unit * mult),
    buyCost: '',
  };
};

const level = (n: number) => html`<span class="level" role="img" aria-label="${levelName(n)}">${[1, 2, 3, 4].map(i => html`<i class="${i <= Math.ceil(n * 4) ? 'on' : ''}"></i>`)}</span>`;

export function itemSheet(v: V, sh: Sheet) {
  const it = v.st.items.find(i => i.id === sh.id);
  if (!it) return html``;
  const { st, ui } = v, off = ui.online ? '' : 'disabled', n = shown(it.stock);
  const owed = it.unit !== 'level' && it.stock < 0 ? shown(-it.stock) : 0;
  const canPortion = !!(it.is_cooked && it.portion_g != null);
  const usePortions = !!(canPortion && sh.portionMode);
  const ports = canPortion ? portionCount(it, n) : null;
  const rawQ = qOf(sh, 'main');
  const eatQty = usePortions ? Math.round(rawQ * it.portion_g! * 1000) / 1000 : rawQ;
  const overdraw = it.unit !== 'level' && eatQty > n;
  const owner = it.owner_id == null ? null : st.users.find(u => u.id === it.owner_id);
  const { mult, label } = macroBasis(it.unit);
  const metaBits: string[] = [
    owner ? `${owner.emoji} ${owner.name}'s` : 'Shared',
    ...(it.expires_at ? [`Expires ${it.expires_at}`] : []),
    ...(it.kcal_per_unit != null || it.protein_per_unit != null
      ? [`${it.kcal_per_unit != null ? `${fmtNum(it.kcal_per_unit * mult)} kcal` : ''}${it.kcal_per_unit != null && it.protein_per_unit != null ? ' · ' : ''}${it.protein_per_unit != null ? `${fmtNum(it.protein_per_unit * mult)}g P` : ''} / ${label}`]
      : []),
  ];
  return html`<h2 id="sheet-title">${it.emoji} ${it.name}</h2>
    <p class="stock center">${it.unit === 'level' ? html`${level(n)} ${levelName(n)}`
      : ports != null ? `${fmtNum(ports)} port · ${fmtNum(n)} g` : `${fmtNum(n)} ${it.unit}`}${owed > 0 ? html` <span class="debt-badge">${fmtNum(owed)} owed</span>` : ''}</p>
    <p class="small muted center" style="margin:-2px 0 10px">${metaBits.join(' · ')}</p>
    ${owed > 0 ? html`<p class="debt-note">${fmtNum(owed)} ${it.unit} owed from earlier eats — Set exact amount to clear</p>` : ''}
    ${canPortion ? html`<div class="seg" role="group" aria-label="Unit mode" style="margin-bottom:10px">
      <button class="${usePortions ? 'on' : ''}" data-a="portionMode" data-v="1">Portions (${fmtNum(it.portion_g!)}g)</button>
      <button class="${!usePortions ? 'on' : ''}" data-a="portionMode" data-v="0">Grams</button>
    </div>` : ''}
    ${it.unit === 'level'
      ? html`<div class="row wrap">${([['Full', 1], ['Half', 0.5], ['Low', 0.25], ['Out', 0]] as const).map(([l, x]) => html`<button class="btn alt grow" data-a="level" data-v="${x}">${l}</button>`)}</div>`
      : html`${stepper(ui, 'main', rawQ, usePortions ? 0.5 : it.step, usePortions ? 'portion' : it.unit)}
        ${overdraw ? html`<p class="overdraw-warn">⚠️ Only ${fmtNum(n)} ${it.unit} in stock — eating ${fmtNum(eatQty)} ${it.unit} will leave ${fmtNum(shown(eatQty - it.stock))} ${it.unit} owed</p>` : ''}
        <div class="row"><button class="btn grow" data-a="eat">Eat</button><button class="btn alt grow" data-a="add">Add</button></div>
        <div class="row wrap" style="margin-top:12px"><button class="btn alt grow" data-a="pack">Add a pack (+${fmtNum(it.pack_size)})</button>
          <button class="linkbtn grow" data-a="setExact">Set exact amount</button></div>
        <label class="field" for="f-buyCost">Cost when buying (optional, ${st.currency})</label>
        <input id="f-buyCost" type="text" inputmode="decimal" placeholder="e.g. 29.50" data-f="buyCost" value="${ui.f.buyCost ?? ''}" autocomplete="off">`}
    ${it.is_cooked ? html`<div class="row" style="margin-top:10px"><button class="btn alt grow" data-a="open" data-s="cook" data-id="${it.id}">🍲 Cook another batch</button></div>` : ''}
    <div class="row" style="margin-top:8px"><button class="linkbtn" data-a="more" aria-expanded="${!!sh.more}">Edit item ${sh.more ? '▴' : '▾'}</button></div>
    ${sh.more ? html`${itemFields(ui.f, false)}
      <div class="row" style="margin-top:14px"><button class="btn red" data-a="archive" ${off}>Archive</button><button class="btn right" data-a="saveItem" ${off}>Save</button></div>` : ''}`;
}

export const itemFormSheet = ({ ui }: V) => html`<h2 id="sheet-title">New item</h2>${itemFields(ui.f, true)}
  <div class="row" style="margin-top:14px"><button class="btn alt" data-a="close">Cancel</button><button class="btn right" data-a="saveItem" ${ui.online ? '' : 'disabled'}>Add item</button></div>`;

const qLine = (v: V, sh: Sheet, it: Item | undefined, k: string, remove = false) => html`
  <div class="line" id="ln-${k}"><span class="emoji">${it?.emoji ?? '❔'}</span><span class="n">${it?.name ?? 'Unknown'} <span class="muted small">${it ? unitOf(it) : ''}</span></span>
    ${it ? stepper(v.ui, k, qOf(sh, k), stepOf(it), '', true) : ''}
    ${remove ? html`<button class="btn alt icon" data-a="rmLine" data-k="${k}" aria-label="Remove ${it?.name ?? 'line'}">×</button>` : ''}</div>`;

export function presetSheet(v: V, sh: Sheet) {
  const p = v.st.presets.find(x => x.id === sh.id);
  if (!p) return html``;
  return html`<h2 id="sheet-title">${p.emoji} ${p.name}</h2>
    ${p.lines.map(l => qLine(v, sh, v.st.items.find(i => i.id === l.item_id), String(l.item_id)))}
    <button class="btn big" style="margin-top:16px" data-a="logPreset">Log it</button>`;
}

export function presetEditSheet(v: V, sh: Sheet) {
  const { st, ui } = v, ids = sh.lines ?? [];
  const free = st.items.filter(i => !ids.includes(i.id));
  return html`<h2 id="sheet-title">${sh.id == null ? 'New preset' : 'Edit preset'}</h2>
    ${field(ui.f, 'name', 'Name')}${field(ui.f, 'emoji', 'Emoji')}
    <label class="field" for="f-time">Usually around</label><input id="f-time" type="time" data-f="time" value="${ui.f.time ?? hourToTime(8)}">
    <label class="field">What goes in</label>
    ${ids.map(id => qLine(v, sh, st.items.find(i => i.id === id), String(id), true))}
    ${free.length ? html`<select id="preset-add" data-c="presetAdd" aria-label="Add an item" style="margin-top:10px"><option value="">+ Add an item…</option>${free.map(i => html`<option value="${i.id}">${i.emoji} ${i.name}</option>`)}</select>` : ''}
    <div class="row" style="margin-top:16px"><button class="btn alt" data-a="close">Cancel</button><button class="btn right" data-a="savePreset" ${ui.online ? '' : 'disabled'}>Save</button></div>`;
}

export function eventSheet(v: V, sh: Sheet) {
  const { st, ui } = v, e = st.events.find(x => x.cid === sh.id);
  if (!e) return html``;
  const nut = e.kind === 'eat' && e.counts_nutrition ? eventNutrition(e, st.items) : null;
  const info = [
    clock(e.at),
    ...(e.cost_cents != null ? [fmtCost(e.cost_cents, st.currency)] : []),
    ...(nut && (nut.kcal > 0 || nut.protein_g > 0) ? [`${nut.kcal} kcal · ${fmtNum(nut.protein_g)}g P`] : []),
    ...(e.note ? [e.note] : []),
  ];
  return html`<h2 id="sheet-title">${userOf(st, e)?.emoji ?? '🙂'} ${userOf(st, e)?.name ?? ''} ${VERB[e.kind]}</h2>
    <p class="muted small">${info.join(' · ')}</p>
    ${e.lines.map(l => qLine(v, sh, st.items.find(i => i.id === l.item_id), String(l.item_id)))}
    <div class="row" style="margin-top:16px"><button class="btn alt" data-a="undoEvent">Undo</button><button class="btn right" data-a="saveEvent" ${ui.online ? '' : 'disabled'}>Save changes</button></div>
    ${e.kind === 'eat' ? html`<div class="row"><button class="linkbtn" data-a="saveAsPreset">Save as preset</button></div>` : ''}`;
}

export function expenseSheet({ st, ui }: V, _sh: Sheet) {
  return html`<h2 id="sheet-title">Log expense</h2>
    <label class="field" for="f-expCost">Amount (${st.currency})</label>
    <input id="f-expCost" type="text" inputmode="decimal" autofocus placeholder="e.g. 125.50" data-f="expCost" value="${ui.f.expCost ?? ''}" autocomplete="off">
    <label class="field" for="f-expNote">Note (optional)</label>
    <input id="f-expNote" type="text" maxlength="200" placeholder="e.g. REMA 1000, takeout" data-f="expNote" value="${ui.f.expNote ?? ''}" autocomplete="off">
    <label class="field" for="f-expDate">Date</label>
    <input id="f-expDate" type="date" data-f="expDate" value="${ui.f.expDate ?? isoDate(st.now)}">
    <div class="row" style="margin-top:16px"><button class="btn alt" data-a="close">Cancel</button>
      <button class="btn right" data-a="saveExpense" ${ui.online ? '' : 'disabled'}>Save</button></div>`;
}
