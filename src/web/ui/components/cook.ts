import { html } from '../../html.ts';
import { addDays, isoDate } from '../../../shared/dates.ts';
import { shown } from '../../../shared/stock.ts';
import { fmtNum, parseNum } from '../../../shared/text.ts';
import type { Item } from '../../../shared/types.ts';
import { qOf } from '../../store.ts';
import type { Sheet } from '../../store.ts';
import { stepOf, unitOf } from './bits.ts';
import type { V } from './bits.ts';
import { stepper } from './stepper.ts';

/** Sums kcal and protein across selected ingredient quantities. */
export function cookBatchMacros(
  items: Item[],
  ids: number[],
  q: Record<string, number>,
): { kcal: number; protein: number; hasKcal: boolean; hasProtein: boolean } {
  let kcal = 0, protein = 0, hasKcal = false, hasProtein = false;
  for (const id of ids) {
    const qty = q[String(id)] ?? 0;
    if (!(qty > 0)) continue;
    const it = items.find(i => i.id === id);
    if (!it) continue;
    if (it.kcal_per_unit != null) { kcal += qty * it.kcal_per_unit; hasKcal = true; }
    if (it.protein_per_unit != null) { protein += qty * it.protein_per_unit; hasProtein = true; }
  }
  return { kcal: Math.round(kcal), protein: Math.round(protein * 10) / 10, hasKcal, hasProtein };
}

export function cookSheet(v: V, sh: Sheet) {
  const { st, ui } = v;
  const cookedMeals = st.items.filter(i => i.is_cooked);
  const ids = sh.lines ?? [];
  const free = st.items.filter(i => i.id !== sh.id && !ids.includes(i.id));
  const portions = parseNum(ui.f.cookPortions ?? '');
  const grams = parseNum(ui.f.cookGrams ?? '');
  const perPortion = portions > 0 && grams > 0 ? grams / portions : null;
  const auto = cookBatchMacros(st.items, ids, sh.q);
  const defaultExpiry = addDays(isoDate(st.now), 4);

  return html`<h2 id="sheet-title">🍲 Cook a meal</h2>
    ${cookedMeals.length ? html`<label class="field" for="f-cookMealPick">Existing cooked meal (or make new)</label>
      <select id="f-cookMealPick" data-c="cookMealPick">
        <option value="" ${sh.id == null ? 'selected' : ''}>+ New cooked meal</option>
        ${cookedMeals.map(m => html`<option value="${m.id}" ${sh.id === m.id ? 'selected' : ''}>${m.emoji} ${m.name}</option>`)}
      </select>` : ''}
    <div class="row" style="gap:10px">
      <div class="grow">
        <label class="field" for="f-cookName">Meal name</label>
        <input id="f-cookName" type="text" maxlength="60" placeholder="e.g. Bolognese" data-f="cookName" value="${ui.f.cookName ?? ''}" autocomplete="off">
      </div>
      <div style="width:76px">
        <label class="field" for="f-cookEmoji">Emoji</label>
        <input id="f-cookEmoji" type="text" maxlength="8" data-f="cookEmoji" value="${ui.f.cookEmoji ?? '🍲'}" autocomplete="off">
      </div>
    </div>
    <label class="field" for="f-cookOwner">Who owns this batch?</label>
    <select id="f-cookOwner" data-f="cookOwner">
      <option value="shared" ${(ui.f.cookOwner ?? 'shared') === 'shared' ? 'selected' : ''}>Shared (household)</option>
      <option value="mine" ${ui.f.cookOwner === 'mine' ? 'selected' : ''}>Mine (personal)</option>
    </select>
    <div class="row" style="gap:10px">
      <div class="grow">
        <label class="field" for="f-cookPortions">Portions</label>
        <input id="f-cookPortions" type="text" inputmode="decimal" placeholder="e.g. 4" data-f="cookPortions" value="${ui.f.cookPortions ?? ''}" autocomplete="off">
      </div>
      <div class="grow">
        <label class="field" for="f-cookGrams">Total grams</label>
        <input id="f-cookGrams" type="text" inputmode="decimal" placeholder="e.g. 1200" data-f="cookGrams" value="${ui.f.cookGrams ?? ''}" autocomplete="off">
      </div>
    </div>
    <p class="small muted" style="margin:4px 0 0">${perPortion != null
      ? `= ${fmtNum(perPortion)} g / portion (enter portions, grams, or both)`
      : 'Enter portions, total grams, or both'}</p>
    <label class="field" for="f-cookExpiry">Expires</label>
    <input id="f-cookExpiry" type="date" data-f="cookExpiry" value="${ui.f.cookExpiry ?? defaultExpiry}">
    <label class="field">Ingredients used (deducted from pantry)</label>
    ${ids.length ? ids.map(id => {
      const it = st.items.find(i => i.id === id);
      const qty = qOf(sh, String(id));
      const avail = it ? shown(it.stock) : 0;
      const over = !!(it && it.unit !== 'level' && qty > avail);
      return html`<div class="line" id="ck-${id}">
        <span class="emoji">${it?.emoji ?? '❔'}</span>
        <span class="n">${it?.name ?? 'Unknown'} <span class="muted small">${it ? unitOf(it) : ''}</span></span>
        ${it ? stepper(ui, String(id), qty, stepOf(it), '', true) : ''}
        <button class="btn alt icon" data-a="rmLine" data-k="${id}" aria-label="Remove ${it?.name ?? 'ingredient'}">×</button>
      </div>
      ${over ? html`<div class="overdraw-warn compact">⚠️ Only ${fmtNum(avail)} ${it.unit} in stock (will leave ${fmtNum(shown(qty - it.stock))} ${it.unit} owed)</div>` : ''}`;
    }) : html`<p class="small muted" style="margin:4px 0">No ingredients picked (optional — you can still log a cooked batch directly).</p>`}
    ${free.length ? html`<select id="cook-add-ing" data-c="cookAddIng" aria-label="Add ingredient" style="margin-top:8px">
      <option value="">+ Add an ingredient…</option>
      ${free.map(i => html`<option value="${i.id}">${i.emoji} ${i.name}</option>`)}
    </select>` : ''}
    <div class="row" style="gap:10px">
      <div class="grow">
        <label class="field" for="f-cookKcal">Total kcal (batch)</label>
        <input id="f-cookKcal" type="text" inputmode="decimal" placeholder="${auto.hasKcal ? String(auto.kcal) : 'Optional'}" data-f="cookKcal" value="${ui.f.cookKcal ?? ''}" autocomplete="off">
      </div>
      <div class="grow">
        <label class="field" for="f-cookProtein">Total protein g (batch)</label>
        <input id="f-cookProtein" type="text" inputmode="decimal" placeholder="${auto.hasProtein ? fmtNum(auto.protein) : 'Optional'}" data-f="cookProtein" value="${ui.f.cookProtein ?? ''}" autocomplete="off">
      </div>
    </div>
    ${auto.hasKcal || auto.hasProtein ? html`<p class="small muted" style="margin:4px 0 0">Auto from ingredients: ${auto.kcal} kcal · ${fmtNum(auto.protein)}g protein</p>` : ''}
    <div class="row" style="margin-top:16px">
      <button class="btn alt" data-a="close">Cancel</button>
      <button class="btn right" data-a="saveCook" ${ui.online && !sh.busy ? '' : 'disabled'}>${sh.busy ? 'Saving…' : 'Log cooked batch'}</button>
    </div>`;
}
