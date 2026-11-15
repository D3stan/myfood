import { html } from '../../html.ts';
import { isLow, shown } from '../../../shared/stock.ts';
import { fmtNum } from '../../../shared/text.ts';
import type { FoodEvent, Item, Job, Preset } from '../../../shared/types.ts';
import { levelName } from '../components/bits.ts';
import type { V } from '../components/bits.ts';

/** The preset whose hour is nearest to now, if within 3 hours and not logged yet today. */
export function heroPreset(presets: Preset[], events: FoodEvent[], now = new Date()): Preset | null {
  const h = now.getHours() + now.getMinutes() / 60;
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const gap = (p: Preset): number => { const d = Math.abs(p.hour - h); return Math.min(d, 24 - d); };
  const best = presets.reduce<Preset | null>((b, p) => (!b || gap(p) < gap(b) ? p : b), null);
  if (!best || gap(best) > 3 || events.some(e => e.preset_id === best.id && e.at >= midnight)) return null;
  return best;
}

export const shoppingText = (low: Item[]): string => ['Shopping list', ...low.map(i => `- ${i.name}`)].join('\n');

const level = (n: number) => html`<span class="level" role="img" aria-label="${levelName(n)}">${[1, 2, 3, 4].map(i => html`<i class="${i <= Math.ceil(n * 4) ? 'on' : ''}"></i>`)}</span>`;

const tags = (v: V, p: Preset) => p.lines.map(l => html`<span>${v.st.items.find(i => i.id === l.item_id)?.emoji ?? '❔'} ${fmtNum(l.qty)}</span>`);

function jobCard(j: Job) {
  if (j.status === 'queued' || j.status === 'running')
    return html`<div class="card thinking" id="job-${j.id}"><div class="spinner">🍳</div><div class="grow"><b>Thinking…</b><div class="small muted clip">${j.text || 'Receipt photo'}</div></div></div>`;
  if (j.status === 'failed')
    return html`<div class="banner bad" id="job-${j.id}"><div>${j.error ?? 'That did not work.'}</div><button class="linkbtn" data-a="dismissJob" data-id="${j.id}">Dismiss</button></div>`;
  if (j.status === 'review') {
    const n = j.result?.events.reduce((a, e) => a + e.lines.length, 0) ?? 0;
    return html`<div class="card" id="job-${j.id}"><b>Receipt ready: ${n} ${n === 1 ? 'item' : 'items'}</b>
      <div class="row" style="margin-top:8px"><button class="btn" data-a="open" data-s="review" data-id="${j.id}">Have a look</button></div></div>`;
  }
  return html``;
}

function itemCard(v: V, it: Item) {
  const n = shown(it.stock), out = n === 0, usual = v.st.usual[it.id] ?? it.step;
  return html`<div class="item ${out ? 'out' : isLow(it) ? 'low' : ''}" id="item-${it.id}" role="button" tabindex="0" data-a="open" data-s="item" data-id="${it.id}">
    <div class="emoji">${it.emoji}</div><span class="name">${it.name}</span>
    <div class="qty">${it.unit === 'level' ? level(n) : html`${fmtNum(n)} <small>${it.unit}</small>`}</div>
    ${it.unit === 'level' ? '' : html`<button class="take" data-a="take" data-id="${it.id}" aria-label="Eat ${fmtNum(usual)} ${it.unit} of ${it.name}">${fmtNum(usual)}</button>`}
  </div>`;
}

export function pantry(v: V, now = new Date()) {
  const { st, ui } = v;
  const q = (ui.f.search ?? '').trim().toLowerCase();
  const items = q ? st.items.filter(i => i.name.toLowerCase().includes(q)) : st.items;
  const low = st.items.filter(isLow);
  const hero = heroPreset(st.presets, st.events, now);
  const cats = [...new Set(items.map(i => i.category))];
  const chipPresets = st.presets.filter(p => p.id !== hero?.id);
  return html`
    <div class="top"><span class="brand">MyFood</span>
      <button class="btn icon right" data-a="newItem" aria-label="Add an item">+</button>
      <button class="avatar" data-a="tab" data-tab="me" aria-label="Me">${st.me.emoji}</button></div>
    ${st.jobs.map(jobCard)}
    ${hero ? html`<div class="hero" id="hero" role="button" tabindex="0" data-a="open" data-s="preset" data-id="${hero.id}">
      <h2>${hero.emoji} ${hero.name}</h2><div class="what">${tags(v, hero)}</div>
      <button class="btn big" data-a="heroLog" data-id="${hero.id}">Log it</button></div>` : ''}
    ${chipPresets.length ? html`<div class="chips">${chipPresets.map(p => html`<button class="chip" id="chip-${p.id}" data-a="open" data-s="preset" data-id="${p.id}">${p.emoji} ${p.name}</button>`)}</div>` : ''}
    <input class="search" id="search" type="search" enterkeyhint="search" placeholder="Search" aria-label="Search the pantry" data-f="search" value="${ui.f.search ?? ''}" autocomplete="off">
    ${low.length ? html`<div class="note" id="low"><b>Running low</b>
      <div class="chips">${low.map(i => html`<span class="chip">${i.emoji} ${i.name}</span>`)}</div>
      <button class="btn alt" data-a="share">Share list</button></div>` : ''}
    ${cats.map(c => html`<div class="cat">${c}</div><div class="items">${items.filter(i => i.category === c).map(i => itemCard(v, i))}</div>`)}
    ${items.length ? '' : html`<p class="note">${q ? 'Nothing matches.' : 'Nothing here yet. Tap + or tell the bar below what you bought.'}</p>`}`;
}
