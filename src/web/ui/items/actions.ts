import { closeSheet, openSheet, qOf, setQ, store as s } from '../../store.ts';
import { ISO_DATE_RE } from '../../../shared/dates.ts';
import { levelParts, shown } from '../../../shared/stock.ts';
import { fmtNum, parseNum } from '../../../shared/text.ts';
import { CATEGORIES, UNITS } from '../../../shared/types.ts';
import type { Category, LineIn, Unit } from '../../../shared/types.ts';
import { amount, levelReadLabel, unitOf } from '../components/bits.ts';
import { itemToFields, macroBasis } from '../components/sheets.ts';
import { mutate, parseOptCostCents, sheet, st, toast } from '../helpers.ts';
import { confirmOverdraw, findCreatedItem, item, logged, parseOptNum, resolveItemQty } from '../logging.ts';

const ate = (it: { name: string; emoji: string; unit: string }, q: number) => it.unit === 'level'
  ? levelReadLabel(it, q)
  : `Ate ${fmtNum(q)} ${it.unit} of ${it.name}`;

export const itemActions: Record<string, (el: HTMLElement) => void | Promise<unknown>> = {
  newItem: () => {
    openSheet(s, { t: 'itemForm', q: {} }, {
      name: '', emoji: '🥫', category: 'pantry', unit: 'pc', step: '1', pack: '1',
      low: '', start: '', itemOwner: 'shared', itemExpiry: '', itemKcal: '', itemProtein: '', itemFat: '', itemCarbs: '', itemPrice: '',
    });
  },
  ownerFilter: el => {
    const v = el.dataset.v;
    s.ui.ownerFilter = v === 'mine' || v === 'shared' ? v : 'all';
  },
  take: el => {
    const it = item(el.dataset.id)!, q = st().usual[it.id] ?? it.step;
    const lines = [{ item_id: it.id, qty: q }];
    if (!confirmOverdraw(st(), lines)) return;
    logged('eat', lines, ate(it, q));
  },
  portionMode: el => {
    const sh = sheet(), it = item(sh.id);
    if (!it?.is_cooked || !it.portion_g) return;
    const next = el.dataset.v != null ? el.dataset.v === '1' : !sh.portionMode;
    if (!!sh.portionMode === next) return;
    const cur = qOf(sh, 'main');
    const converted = next ? cur / it.portion_g : cur * it.portion_g;
    sh.portionMode = next;
    setQ(sh, 'main', Math.round(converted * 100) / 100);
  },
  eat: () => {
    const sh = sheet(), it = item(sh.id)!, q = resolveItemQty(sh, it, qOf(sh, 'main'));
    if (!(q > 0)) return void toast('Pick an amount first');
    const lines = [{ item_id: it.id, qty: q }];
    if (!confirmOverdraw(st(), lines)) return;
    logged('eat', lines, ate(it, q)); closeSheet(s);
  },
  add: () => {
    const sh = sheet(), it = item(sh.id)!, q = resolveItemQty(sh, it, qOf(sh, 'main'));
    if (!(q > 0)) return void toast('Pick an amount first');
    const cost_cents = parseOptCostCents(s.ui.f.buyCost);
    if (cost_cents === 'invalid') return void toast('Check the cost');
    const line: LineIn = { item_id: it.id, qty: q, ...(cost_cents != null ? { cost_cents } : {}) };
    logged('buy', [line], `Added ${fmtNum(q)} ${unitOf(it)} ${it.name}`, cost_cents != null ? { cost_cents } : {});
    s.ui.f.buyCost = '';
    closeSheet(s);
  },
  pack: () => {
    const it = item(sheet().id)!;
    const cost_cents = parseOptCostCents(s.ui.f.buyCost);
    if (cost_cents === 'invalid') return void toast('Check the cost');
    const line: LineIn = { item_id: it.id, qty: it.unit === 'level' ? 1 : it.pack_size, ...(cost_cents != null ? { cost_cents } : {}) };
    logged('buy', [line], it.unit === 'level' ? `Added a container of ${it.name}` : `Added a pack of ${it.name}`, cost_cents != null ? { cost_cents } : {});
    s.ui.f.buyCost = '';
    closeSheet(s);
  },
  exactOpen: () => {
    const sh = sheet(), it = item(sh.id)!;
    sh.exact = true;
    s.ui.f.exact = fmtNum(shown(it.stock));
  },
  setExact: () => {
    const sh = sheet(), it = item(sh.id)!, raw = parseNum(s.ui.f.exact ?? '');
    if (Number.isNaN(raw) || raw < 0) return void toast("That's not an amount");
    const q = Math.round(raw * 1000) / 1000;
    const label = it.unit === 'level' ? amount(it, q) : `${fmtNum(q)} ${unitOf(it)}`;
    logged('adjust', [{ item_id: it.id, qty: q }], `${it.name} set to ${label}`); closeSheet(s);
  },
  level: el => {
    const it = item(sheet().id)!, q = Number(el.dataset.v);
    logged('eat', [{ item_id: it.id, qty: q }], levelReadLabel(it, levelParts(it.stock).sealed + q)); closeSheet(s);
  },
  more: () => { sheet().more = !sheet().more; },
  saveItem: async () => {
    const sh = sheet(), f = s.ui.f, isNew = sh.t === 'itemForm';
    const step = parseNum(f.step ?? ''), pack = parseNum(f.pack ?? '');
    const low = parseOptNum(f.low), start = (f.start ?? '').trim() ? parseNum(f.start!) : 0;
    const kcalIn = parseOptNum(f.itemKcal), proteinIn = parseOptNum(f.itemProtein), fatIn = parseOptNum(f.itemFat), carbsIn = parseOptNum(f.itemCarbs);
    const priceIn = parseOptCostCents(f.itemPrice);
    const exp = (f.itemExpiry ?? '').trim();
    if (!f.name?.trim() || !(step > 0) || !(pack > 0) || low === 'invalid' || Number.isNaN(start)
      || kcalIn === 'invalid' || proteinIn === 'invalid' || fatIn === 'invalid' || carbsIn === 'invalid' || priceIn === 'invalid' || (exp && !ISO_DATE_RE.test(exp))) {
      return void toast('Check the name and the numbers');
    }
    const name = f.name.trim();
    const unit = (UNITS.includes(f.unit as Unit) ? f.unit : 'pc') as Unit;
    const { mult } = macroBasis(unit);
    const body = {
      name, emoji: (f.emoji ?? '').trim() || '🥫',
      category: (CATEGORIES.includes(f.category as Category) ? f.category : 'pantry') as Category,
      unit, step, pack_size: pack, low_at: low,
      owner_id: f.itemOwner === 'mine' ? st().me.id : null,
      expires_at: exp || null,
      kcal_per_unit: kcalIn == null ? null : Math.round((kcalIn / mult) * 1000) / 1000,
      protein_per_unit: proteinIn == null ? null : Math.round((proteinIn / mult) * 1000) / 1000,
      fat_per_unit: fatIn == null ? null : Math.round((fatIn / mult) * 1000) / 1000,
      carbs_per_unit: carbsIn == null ? null : Math.round((carbsIn / mult) * 1000) / 1000,
      cost_per_unit_cents: priceIn == null ? null : Math.round((priceIn / mult) * 1000) / 1000,
    };
    // the field shows a rounded per-100 price: re-sending it untouched would round the stored one
    const { cost_per_unit_cents: _price, ...rest } = body;
    const payload = !isNew && f.itemPrice === itemToFields(item(sh.id)!).itemPrice ? rest : body;
    if (!(await mutate(isNew ? 'POST' : 'PATCH', isNew ? '/api/items' : `/api/items/${sh.id}`, payload))) return;
    const made = isNew && start > 0 ? findCreatedItem(st().items, name, body.owner_id) : undefined;
    if (made) logged('adjust', [{ item_id: made.id, qty: start }], `Added ${name}`);
    else toast(`Saved ${name}`);
    closeSheet(s);
  },
  archive: async () => {
    const it = item(sheet().id)!;
    if (confirm(`Archive ${it.name}?`) && await mutate('DELETE', `/api/items/${it.id}`)) toast(`Archived ${it.name}`);
  },
};
