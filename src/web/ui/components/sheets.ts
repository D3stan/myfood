import { html } from '../../html.ts';
import { shown } from '../../../shared/stock.ts';
import { fmtNum } from '../../../shared/text.ts';
import { CATEGORIES, UNITS } from '../../../shared/types.ts';
import type { Item } from '../../../shared/types.ts';
import { qOf } from '../../store.ts';
import type { Sheet } from '../../store.ts';
import { VERB, clock, hourToTime, levelName, stepOf, unitOf, userOf } from './bits.ts';
import type { V } from './bits.ts';
import { stepper } from './stepper.ts';

const field = (f: Record<string, string>, id: string, label: string, dec = false) =>
  html`<label class="field" for="f-${id}">${label}</label><input id="f-${id}" type="text" inputmode="${dec ? 'decimal' : 'text'}" data-f="${id}" value="${f[id] ?? ''}" autocomplete="off">`;

const select = (f: Record<string, string>, id: string, label: string, options: readonly string[]) =>
  html`<label class="field" for="f-${id}">${label}</label><select id="f-${id}" data-f="${id}">${options.map(o => html`<option value="${o}" ${f[id] === o ? 'selected' : ''}>${o}</option>`)}</select>`;

export const itemFields = (f: Record<string, string>, isNew: boolean) => html`
  ${field(f, 'name', 'Name')}${field(f, 'emoji', 'Emoji')}${select(f, 'category', 'Category', CATEGORIES)}${select(f, 'unit', 'Unit', UNITS)}
  ${field(f, 'step', 'One tap changes by', true)}${field(f, 'pack', 'Units in a pack', true)}
  ${field(f, 'low', 'Running low at (empty = only when out)', true)}
  ${isNew ? field(f, 'start', 'How much is there now? (optional)', true) : ''}`;

export const itemToFields = (i: Item): Record<string, string> => ({
  name: i.name, emoji: i.emoji, category: i.category, unit: i.unit,
  step: fmtNum(i.step), pack: fmtNum(i.pack_size), low: i.low_at == null ? '' : fmtNum(i.low_at),
});

const level = (n: number) => html`<span class="level" role="img" aria-label="${levelName(n)}">${[1, 2, 3, 4].map(i => html`<i class="${i <= Math.ceil(n * 4) ? 'on' : ''}"></i>`)}</span>`;

export function itemSheet(v: V, sh: Sheet) {
  const it = v.st.items.find(i => i.id === sh.id);
  if (!it) return html``;
  const { ui } = v, off = ui.online ? '' : 'disabled', n = shown(it.stock);
  return html`<h2 id="sheet-title">${it.emoji} ${it.name}</h2>
    <p class="stock center">${it.unit === 'level' ? html`${level(n)} ${levelName(n)}` : `${fmtNum(n)} ${it.unit}`}</p>
    ${it.unit === 'level'
      ? html`<div class="row wrap">${([['Full', 1], ['Half', 0.5], ['Low', 0.25], ['Out', 0]] as const).map(([l, x]) => html`<button class="btn alt grow" data-a="level" data-v="${x}">${l}</button>`)}</div>`
      : html`${stepper(ui, 'main', qOf(sh, 'main'), it.step, it.unit)}
        <div class="row"><button class="btn grow" data-a="eat">Eat</button><button class="btn alt grow" data-a="add">Add</button></div>
        <div class="row wrap" style="margin-top:12px"><button class="btn alt grow" data-a="pack">Add a pack (+${fmtNum(it.pack_size)})</button>
          <button class="linkbtn grow" data-a="setExact">Set exact amount</button></div>`}
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
  return html`<h2 id="sheet-title">${userOf(st, e)?.emoji ?? '🙂'} ${userOf(st, e)?.name ?? ''} ${VERB[e.kind]}</h2>
    <p class="muted small">${clock(e.at)}${e.note ? ` · ${e.note}` : ''}</p>
    ${e.lines.map(l => qLine(v, sh, st.items.find(i => i.id === l.item_id), String(l.item_id)))}
    <div class="row" style="margin-top:16px"><button class="btn alt" data-a="undoEvent">Undo</button><button class="btn right" data-a="saveEvent" ${ui.online ? '' : 'disabled'}>Save changes</button></div>
    ${e.kind === 'eat' ? html`<div class="row"><button class="linkbtn" data-a="saveAsPreset">Save as preset</button></div>` : ''}`;
}

