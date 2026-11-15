import { html } from '../../html.ts';
import { daysUntil } from '../../../shared/dates.ts';
import { isExpiringSoon, isLow, levelParts, portionCount, shown } from '../../../shared/stock.ts';
import { fmtNum } from '../../../shared/text.ts';
import type { FoodEvent, Item, Job, Preset } from '../../../shared/types.ts';
import { expiryLabel, levelName, ownerOf } from '../components/bits.ts';
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

const level = (n: number) => {
  const { open, sealed } = levelParts(n);
  return html`<span class="level" role="img" aria-label="${levelName(open)}">${[1, 2, 3, 4].map(i => html`<i class="${i <= Math.ceil(open * 4) ? 'on' : ''}"></i>`)}</span>${sealed ? html` <span class="small muted">+${sealed}</span>` : ''}`;
};

const tags = (v: V, p: Preset) => p.lines.map(l => html`<span>${v.st.items.find(i => i.id === l.item_id)?.emoji ?? '❔'} ${fmtNum(l.qty)}</span>`);

function jobCard(j: Job) {
  if (j.status === 'queued' || j.status === 'running')
    return html`<div class="card thinking" id="job-${j.id}"><div class="spinner">🍳</div><div class="grow"><b>Thinking…</b><div class="small muted clip">${j.text || (j.mode === 'audit' ? 'Fridge audit' : 'Receipt photo')}</div></div></div>`;
  if (j.status === 'failed')
    return html`<div class="banner bad" id="job-${j.id}"><div>${j.error ?? 'That did not work.'}</div><button class="linkbtn" data-a="dismissJob" data-id="${j.id}">Dismiss</button></div>`;
  if (j.status === 'review') {
    const n = j.result?.events.reduce((a, e) => a + e.lines.length, 0) ?? 0;
    const label = j.mode === 'audit' ? 'Fridge audit ready' : 'Receipt ready';
    return html`<div class="card" id="job-${j.id}"><b>${label}: ${n} ${n === 1 ? 'item' : 'items'}</b>
      <div class="row" style="margin-top:8px"><button class="btn" data-a="open" data-s="review" data-id="${j.id}">Have a look</button></div></div>`;
  }
  return html``;
}

function macroSub(it: Item): string | null {
  if (it.kcal_per_unit == null && it.protein_per_unit == null && it.fat_per_unit == null) return null;
  const per100 = it.unit === 'g' || it.unit === 'ml';
  const mult = per100 ? 100 : 1;
  const parts: string[] = [];
  if (it.kcal_per_unit != null) parts.push(`${Math.round(it.kcal_per_unit * mult)} kcal`);
  if (it.protein_per_unit != null) parts.push(`${fmtNum(it.protein_per_unit * mult)}g P`);
  if (it.fat_per_unit != null) parts.push(`${fmtNum(it.fat_per_unit * mult)}g F`);
  return per100 ? `${parts.join(' · ')} / 100${it.unit}` : parts.join(' · ');
}

function itemCard(v: V, it: Item, nowMs: number) {
  const n = shown(it.stock), out = n === 0, usual = v.st.usual[it.id] ?? it.step;
  const owed = it.unit !== 'level' && it.stock < 0 ? shown(-it.stock) : 0;
  const owner = ownerOf(v.st, it.owner_id);
  const exp = n > 0 ? expiryLabel(it.expires_at, nowMs) : null;
  const expSoon = exp != null && it.expires_at != null && daysUntil(it.expires_at, nowMs) <= 3;
  const ports = it.is_cooked && it.portion_g != null ? portionCount(it, n) : null;
  const macros = macroSub(it);
  return html`<div class="item ${out ? 'out' : isLow(it) ? 'low' : ''}" id="item-${it.id}" role="button" tabindex="0" data-a="open" data-s="item" data-id="${it.id}">
    <div class="emoji">${it.emoji}${owner ? html`<span class="owner-badge" title="${owner.name}">${owner.emoji}</span>` : ''}</div>
    <span class="name">${it.name}</span>
    <div class="qty">${it.unit === 'level' ? level(n)
      : ports != null ? html`${fmtNum(ports)} <small>port · ${fmtNum(n)} g</small>`
      : html`${fmtNum(n)} <small>${it.unit}</small>`}${owed > 0 ? html` <span class="debt-badge">${fmtNum(owed)} owed</span>` : ''}</div>
    ${exp ? html`<div class="small ${expSoon ? 'exp-soon' : 'muted'}">⏰ ${exp}</div>` : ''}
    ${macros ? html`<div class="small muted clip">${macros}</div>` : ''}
    ${it.unit === 'level' ? '' : html`<button class="take" data-a="take" data-id="${it.id}" aria-label="Eat ${fmtNum(usual)} ${it.unit} of ${it.name}">${fmtNum(usual)}</button>`}
  </div>`;
}

export function pantry(v: V, now: Date | number = new Date()) {
  const { st, ui } = v;
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const q = (ui.f.search ?? '').trim().toLowerCase();
  const ownerFiltered = st.items.filter(i =>
    ui.ownerFilter === 'mine' ? i.owner_id === st.me.id
    : ui.ownerFilter === 'shared' ? i.owner_id == null
    : true);
  const items = q ? ownerFiltered.filter(i => i.name.toLowerCase().includes(q)) : ownerFiltered;
  const eatSoon = st.items
    .filter(i => (i.owner_id == null || i.owner_id === st.me.id) && isExpiringSoon(i, nowMs))
    .sort((a, b) => daysUntil(a.expires_at!, nowMs) - daysUntil(b.expires_at!, nowMs));
  const low = st.items.filter(i => isLow(i) && (i.owner_id == null || i.owner_id === st.me.id));
  const hero = heroPreset(st.presets, st.events, nowDate);
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
    <div class="chips quick-actions">
      <button class="chip" data-a="open" data-s="cook">🍳 Cook meal</button>
      <button class="chip" data-a="open" data-s="barcode">📷 Barcode</button>
      <button class="chip" data-a="openAudit">🧊 Fridge audit</button>
    </div>
    ${chipPresets.length ? html`<div class="chips">${chipPresets.map(p => html`<button class="chip" id="chip-${p.id}" data-a="open" data-s="preset" data-id="${p.id}">${p.emoji} ${p.name}</button>`)}</div>` : ''}
    <div class="seg" role="group" aria-label="Filter by owner">
      <button class="${ui.ownerFilter === 'all' ? 'on' : ''}" data-a="ownerFilter" data-v="all">All</button>
      <button class="${ui.ownerFilter === 'mine' ? 'on' : ''}" data-a="ownerFilter" data-v="mine">Mine</button>
      <button class="${ui.ownerFilter === 'shared' ? 'on' : ''}" data-a="ownerFilter" data-v="shared">Shared</button>
    </div>
    <input class="search" id="search" type="search" enterkeyhint="search" placeholder="Search" aria-label="Search the pantry" data-f="search" value="${ui.f.search ?? ''}" autocomplete="off">
    ${eatSoon.length ? html`<div class="warn-strip" id="eat-soon"><b>Eat soon</b>
      <div class="chips">${eatSoon.map(i => html`<button class="chip" data-a="open" data-s="item" data-id="${i.id}">${i.emoji} ${i.name} · ${expiryLabel(i.expires_at, nowMs)}</button>`)}</div>
    </div>` : ''}
    ${low.length ? html`<div class="note" id="low"><b>Running low</b>
      <div class="chips">${low.map(i => html`<span class="chip">${i.emoji} ${i.name}</span>`)}</div>
      <button class="btn alt" data-a="share">Share list</button></div>` : ''}
    ${cats.map(c => html`<div class="cat">${c}</div><div class="items">${items.filter(i => i.category === c).map(i => itemCard(v, i, nowMs))}</div>`)}
    ${items.length ? '' : html`<p class="note">${q ? 'Nothing matches.' : 'Nothing here yet. Tap + or tell the bar below what you bought.'}</p>`}`;
}
