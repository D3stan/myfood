import { linkBarcode, lookupBarcode } from '../../api.ts';
import { closeSheet, openSheet, qOf, receive, setQ, store as s } from '../../store.ts';
import { fmtNum, parseNum } from '../../../shared/text.ts';
import { CATEGORIES, UNITS } from '../../../shared/types.ts';
import type { Category, LineIn, Unit } from '../../../shared/types.ts';
import { barcodeToFields, bcModeOf, bcTotal, decodeBarcodePhoto } from '../components/barcode.ts';
import { macroBasis } from '../components/sheets.ts';
import { afterState, commit, fail, mutate, parseOptCostCents, sheet, st, toast } from '../helpers.ts';
import { findCreatedItem, item, logged, parseOptNum } from '../logging.ts';

const amountText = (unit: Unit, q: number): string =>
  unit === 'level' ? `${fmtNum(q)} ${q === 1 ? 'container' : 'containers'}` : `${fmtNum(q)} ${unit}`;

async function runBarcodeLookup(rawCode: string): Promise<void> {
  const code = rawCode.trim();
  if (!/^\d{6,14}$/.test(code)) return void toast('Enter 6 to 14 barcode digits');
  if (!navigator.onLine) return void toast("You're offline");
  s.ui.barcodeBusy = true;
  commit();
  try {
    const lk = await lookupBarcode(code);
    s.ui.barcodeLookup = lk;
    if (s.ui.sheet?.t === 'barcode') s.ui.sheet.q.bc = 1;
    s.ui.f.bcMode = 'pack';
    if (lk.item_id == null) Object.assign(s.ui.f, barcodeToFields(lk));
    else s.ui.f.buyCost = '';
  } catch (e) { fail(e); } finally {
    s.ui.barcodeBusy = false;
    commit();
  }
}

async function scanBarcodePhoto(file: File): Promise<void> {
  s.ui.barcodeBusy = true; commit();
  let code: string | undefined;
  try { code = await decodeBarcodePhoto(file); } finally { s.ui.barcodeBusy = false; }
  if (!code) return void toast('No barcode found in that photo — try closer, in focus');
  s.ui.f.barcodeCode = code;
  await runBarcodeLookup(code);
}

/** Opens the native camera; must run synchronously inside a click for iOS user activation. */
export function takeBarcodePhoto(): void {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*'; input.setAttribute('capture', 'environment');
  input.hidden = true;
  // iOS Safari may drop change events on detached inputs, so keep it in the DOM until used.
  input.onchange = () => { const f = input.files?.[0]; input.remove(); if (f) void scanBarcodePhoto(f); };
  document.querySelectorAll('input[data-bc-cam]').forEach(n => n.remove());
  input.dataset.bcCam = '';
  document.body.append(input);
  input.click();
}

export const barcodeActions: Record<string, (el: HTMLElement) => void | Promise<unknown>> = {
  barcodeLookup: () => runBarcodeLookup(s.ui.f.barcodeCode ?? ''),
  barcodeCamera: () => takeBarcodePhoto(),
  barcodePhoto: el => {
    const input = el as HTMLInputElement, file = input.files?.[0];
    input.value = '';
    if (file) return scanBarcodePhoto(file);
  },
  barcodeFallbackPhoto: () => {
    s.ui.jobMode = 'auto';
    openSheet(s, { t: 'compose', q: {}, mode: 'auto' });
  },
  bcMode: el => {
    const sh = sheet(), next = el.dataset.v === 'unit' ? 'unit' : 'pack', pack = Number(el.dataset.p) || 1;
    if ((s.ui.f.bcMode === 'unit' ? 'unit' : 'pack') === next) return;
    const n = qOf(sh, 'bc');
    setQ(sh, 'bc', next === 'unit' ? n * pack : n / pack); // keep the same amount when switching
    s.ui.f.bcMode = next;
  },
  barcodeAddPack: el => {
    const it = item(el.dataset.id);
    if (!it) return;
    const cost_cents = parseOptCostCents(s.ui.f.buyCost);
    if (cost_cents === 'invalid') return void toast('Check the cost');
    const qty = bcTotal(qOf(sheet(), 'bc'), bcModeOf(s.ui.f, it.unit, it.pack_size), it.unit, it.pack_size);
    if (!(qty > 0)) return void toast('Pick an amount first');
    const line: LineIn = { item_id: it.id, qty, ...(cost_cents != null ? { cost_cents } : {}) };
    logged('buy', [line], `Added ${amountText(it.unit, qty)} of ${it.name}`, cost_cents != null ? { cost_cents } : {});
    s.ui.f.buyCost = '';
    closeSheet(s);
  },
  barcodeCreateAdd: async () => {
    const f = s.ui.f, lk = s.ui.barcodeLookup;
    if (!navigator.onLine) return void toast("You're offline");
    const name = (f.bcName ?? '').trim();
    const pack = parseNum(f.bcPack ?? '');
    const kcalIn = parseOptNum(f.bcKcal), proteinIn = parseOptNum(f.bcProtein), fatIn = parseOptNum(f.bcFat), carbsIn = parseOptNum(f.bcCarbs);
    const cost_cents = parseOptCostCents(f.buyCost);
    if (!name || !(pack > 0) || kcalIn === 'invalid' || proteinIn === 'invalid' || fatIn === 'invalid' || carbsIn === 'invalid' || cost_cents === 'invalid') {
      return void toast('Check the name, pack size, and numbers');
    }
    const unit = (UNITS.includes(f.bcUnit as Unit) ? f.bcUnit : 'g') as Unit;
    const category = (CATEGORIES.includes(f.bcCategory as Category) ? f.bcCategory : 'pantry') as Category;
    const { mult } = macroBasis(unit);
    const body = {
      name, emoji: (f.bcEmoji ?? '').trim() || '📦', category, unit,
      step: unit === 'g' || unit === 'ml' ? 50 : 1,
      pack_size: pack, low_at: null,
      kcal_per_unit: kcalIn == null ? null : Math.round((kcalIn / mult) * 1000) / 1000,
      protein_per_unit: proteinIn == null ? null : Math.round((proteinIn / mult) * 1000) / 1000,
      fat_per_unit: fatIn == null ? null : Math.round((fatIn / mult) * 1000) / 1000,
      carbs_per_unit: carbsIn == null ? null : Math.round((carbsIn / mult) * 1000) / 1000,
      ...(lk?.code ? { barcode: lk.code } : {}),
    };
    const qty = bcTotal(qOf(sheet(), 'bc'), bcModeOf(f, unit, pack), unit, pack);
    if (!(qty > 0)) return void toast('Pick an amount first');
    if (!(await mutate('POST', '/api/items', body))) return;
    const created = findCreatedItem(st().items, name, null);
    if (created) {
      const line: LineIn = { item_id: created.id, qty, ...(cost_cents != null ? { cost_cents } : {}) };
      logged('buy', [line], `Added ${amountText(unit, qty)} of ${name}`, cost_cents != null ? { cost_cents } : {});
    } else toast(`Added ${name}`);
    s.ui.f.buyCost = '';
    closeSheet(s);
  },
  barcodeLink: async () => {
    const f = s.ui.f, it = item(f.bcLinkItem), code = (s.ui.barcodeLookup?.code ?? f.barcodeCode ?? '').trim();
    if (!it || !/^\d{6,14}$/.test(code)) return void toast('Pick an item first');
    const cost_cents = parseOptCostCents(f.buyCost);
    if (cost_cents === 'invalid') return void toast('Check the cost');
    if (!navigator.onLine) return void toast("You're offline");
    // The picker shows the create form's unit/pack; for linking, read its count against the chosen item.
    const qty = bcTotal(qOf(sheet(), 'bc'), bcModeOf(f, it.unit, it.pack_size), it.unit, it.pack_size);
    if (!(qty > 0)) return void toast('Pick an amount first');
    try {
      receive(s, await linkBarcode({ code, item_id: it.id }));
      afterState();
      const line: LineIn = { item_id: it.id, qty, ...(cost_cents != null ? { cost_cents } : {}) };
      logged('buy', [line], `Linked & added ${it.name}`, cost_cents != null ? { cost_cents } : {});
      f.buyCost = '';
      closeSheet(s);
    } catch (e) { fail(e); }
  },
};
