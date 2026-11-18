import { html } from '../../html.ts';
import { currencySymbol, fmtNum } from '../../../shared/text.ts';
import { CATEGORIES, UNITS } from '../../../shared/types.ts';
import type { BarcodeLookup, Unit } from '../../../shared/types.ts';
import { qOf } from '../../store.ts';
import type { Sheet } from '../../store.ts';
import { unitOf } from './bits.ts';
import type { V } from './bits.ts';
import { macroBasis } from './sheets.ts';
import { stepper } from './stepper.ts';

interface DetectedBarcode { rawValue?: string }
interface BarcodeDetectorLike { detect(source: ImageBitmapSource): Promise<DetectedBarcode[]> }
type BarcodeDetectorCtor = (new (opts?: { formats?: string[] }) => BarcodeDetectorLike) & { getSupportedFormats?: () => Promise<string[]> };

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'];

let detectorP: Promise<BarcodeDetectorLike> | null = null;

/** Native BarcodeDetector when it reads EAN-13, else the zxing-wasm ponyfill (iOS Safari has none). */
function getDetector(): Promise<BarcodeDetectorLike> {
  detectorP ??= (async () => {
    const Native = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
    const nativeFormats = Native ? await Native.getSupportedFormats?.().catch(() => []) ?? [] : [];
    if (Native && nativeFormats.includes('ean_13')) return new Native({ formats: FORMATS });
    const [{ BarcodeDetector, setZXingModuleOverrides }, { default: wasmUrl }] = await Promise.all([
      import('barcode-detector/ponyfill'),
      import('zxing-wasm/reader/zxing_reader.wasm?url'),
    ]);
    // Serve the wasm from our own origin instead of the library's CDN default.
    setZXingModuleOverrides({ locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) });
    return new BarcodeDetector({ formats: FORMATS as never });
  })();
  detectorP.catch(() => { detectorP = null; });
  return detectorP;
}

const firstCode = (hits: DetectedBarcode[]): string | undefined =>
  hits.map(h => (h.rawValue ?? '').trim()).find(c => /^\d{6,14}$/.test(c));

/** Reads a barcode from a still photo. Undefined when none is found. */
export async function decodeBarcodePhoto(file: Blob): Promise<string | undefined> {
  const detector = await getDetector();
  const bmp = await createImageBitmap(file);
  try { return firstCode(await detector.detect(bmp)); } finally { bmp.close(); }
}

/** Barcode quantity mode: whole packs, or the item's own unit (g, ml, pc…). Level items always count containers. */
export type BcMode = 'pack' | 'unit';
const packOf = (unit: Unit, packSize: number): number => (unit === 'level' ? 1 : packSize);
export const bcModeOf = (f: Record<string, string>, unit: Unit, packSize: number): BcMode =>
  f.bcMode === 'unit' && packOf(unit, packSize) !== 1 ? 'unit' : 'pack';
/** What the add buys, in the item's unit: n packs × pack size, or n units as typed. */
export const bcTotal = (n: number, mode: BcMode, unit: Unit, packSize: number): number =>
  Math.round((mode === 'unit' ? n : n * packOf(unit, packSize)) * 1000) / 1000;

function qtyPicker(v: V, sh: Sheet, unit: Unit, packSize: number) {
  const { ui } = v, pack = packOf(unit, packSize), mode = bcModeOf(ui.f, unit, packSize), n = qOf(sh, 'bc');
  const u = unit === 'level' ? '' : unit;
  const step = mode === 'unit' ? (unit === 'g' || unit === 'ml' ? 50 : unit === 'slice' ? 0.5 : 1) : 1;
  const total = bcTotal(n, mode, unit, packSize);
  return html`<label class="field">How many</label>
    ${pack !== 1 ? html`<div class="seg" role="group" aria-label="Count in">
      <button class="${mode === 'pack' ? 'on' : ''}" data-a="bcMode" data-v="pack" data-p="${pack}">Packs (${fmtNum(pack)} ${u})</button>
      <button class="${mode === 'unit' ? 'on' : ''}" data-a="bcMode" data-v="unit" data-p="${pack}">${u}</button>
    </div>` : ''}
    ${stepper(ui, 'bc', n, step, unit === 'level' ? (n === 1 ? 'container' : 'containers') : mode === 'unit' ? u : n === 1 ? 'pack' : 'packs')}
    ${mode === 'pack' && pack !== 1 ? html`<p class="small muted center" style="margin:4px 0 0">= ${fmtNum(total)} ${u}</p>` : ''}`;
}

const addLabel = (n: number, unit: Unit, packSize: number, mode: BcMode): string => {
  const total = bcTotal(n, mode, unit, packSize);
  return unit === 'level' ? `Add ${fmtNum(total)} ${total === 1 ? 'container' : 'containers'}` : `Add ${fmtNum(total)} ${unit}`;
};

const CATEGORY_EMOJI: Record<string, string> = {
  meals: '🍲', dairy: '🥛', meat: '🥩', bakery: '🍞', produce: '🥬',
  pantry: '📦', spices: '🧂', frozen: '🧊', drinks: '🥤', other: '📦',
};

/** Pre-fills quick-create fields from an Open Food Facts / cached barcode lookup. */
export function barcodeToFields(lk: BarcodeLookup): Record<string, string> {
  const p = lk.product;
  const unit: Unit = p?.unit ?? 'g';
  const category = p?.category ?? 'pantry';
  const { mult } = macroBasis(unit);
  return {
    bcName: p?.product_name ?? '',
    bcEmoji: CATEGORY_EMOJI[category] ?? '📦',
    bcCategory: category,
    bcUnit: unit,
    bcPack: fmtNum(p?.pack_size ?? 1),
    bcKcal: p?.kcal_per_unit != null ? fmtNum(p.kcal_per_unit * mult) : '',
    bcProtein: p?.protein_per_unit != null ? fmtNum(p.protein_per_unit * mult) : '',
    bcFat: p?.fat_per_unit != null ? fmtNum(p.fat_per_unit * mult) : '',
    bcCarbs: p?.carbs_per_unit != null ? fmtNum(p.carbs_per_unit * mult) : '',
    buyCost: '',
  };
}

export function barcodeSheet(v: V, _sh: Sheet) {
  const { st, ui } = v;
  const lk = ui.barcodeLookup;
  const matched = lk?.item_id != null ? st.items.find(i => i.id === lk.item_id) : undefined;
  const bcUnit = (UNITS.includes(ui.f.bcUnit as Unit) ? ui.f.bcUnit : 'g') as Unit;
  const { label: macroLabel } = macroBasis(bcUnit);
  const bcPackRaw = Number((ui.f.bcPack ?? '1').replace(',', '.'));
  const bcPackN = bcPackRaw > 0 ? bcPackRaw : 1;
  const linkItem = st.items.find(i => String(i.id) === ui.f.bcLinkItem);

  return html`<h2 id="sheet-title">📷 Scan barcode</h2>
    <form class="row" style="gap:8px;margin-top:10px" data-submit="barcodeLookup">
      <input id="f-barcodeCode" type="text" inputmode="numeric" autofocus placeholder="Barcode digits (e.g. 5701234567890)" data-f="barcodeCode" value="${ui.f.barcodeCode ?? ''}" autocomplete="off">
      <button class="btn" type="submit" ${ui.online && !ui.barcodeBusy ? '' : 'disabled'}>${ui.barcodeBusy ? 'Looking…' : 'Look up'}</button>
    </form>
    <div class="row" style="margin-top:8px">
      <button class="btn alt grow" data-a="barcodeCamera">📷 Take photo</button>
      <label class="btn alt grow center" for="f-bcPhoto">🖼️ Upload photo</label>
      <input id="f-bcPhoto" type="file" accept="image/*" data-c="barcodePhoto" hidden>
    </div>
    <div class="row" style="margin-top:8px">
      <button class="btn alt grow" data-a="barcodeFallbackPhoto">🤖 Ask the AI instead</button>
    </div>
    ${lk ? (matched
      ? html`<div class="card" style="margin-top:14px">
          <div class="line" style="border:0"><span class="emoji">${matched.emoji}</span>
            <span class="n"><b>${matched.name}</b> <span class="muted small">pack ${fmtNum(matched.pack_size)} ${unitOf(matched)}</span></span></div>
          <label class="field" for="f-buyCost">Cost (optional, ${currencySymbol(st.currency)})</label>
          <input id="f-buyCost" type="text" inputmode="decimal" placeholder="e.g. 29.50" data-f="buyCost" value="${ui.f.buyCost ?? ''}" autocomplete="off">
          ${qtyPicker(v, _sh, matched.unit, matched.pack_size)}
          <button class="btn big" style="margin-top:10px" data-a="barcodeAddPack" data-id="${matched.id}" ${qOf(_sh, 'bc') > 0 ? '' : 'disabled'}>${addLabel(qOf(_sh, 'bc'), matched.unit, matched.pack_size, bcModeOf(ui.f, matched.unit, matched.pack_size))}</button>
        </div>`
      : html`<div class="card" style="margin-top:14px">
          ${lk.found && lk.product
            ? html`<div class="row" style="align-items:center;gap:8px;margin-bottom:8px">
                <p class="grow" style="margin:0"><b>${lk.product.product_name ?? 'Product found'}</b>${lk.product.brand ? ` · ${lk.product.brand}` : ''}</p>
                <button class="btn alt small" data-a="barcodeRefresh" ${ui.online && !ui.barcodeBusy ? '' : 'disabled'}>↻ Refresh</button>
              </div>
              ${lk.product.kcal_per_unit == null && lk.product.protein_per_unit == null && lk.product.fat_per_unit == null && lk.product.carbs_per_unit == null
                ? html`<p class="muted small" style="margin:0 0 8px">Open Food Facts had no nutrition data for this product — enter macros below if needed.</p>`
                : ''}`
            : html`<div class="row" style="align-items:center;gap:8px;margin-bottom:8px">
                <p class="muted small grow" style="margin:0">Not found in database for ${lk.code}. Create a new item or link an existing one:</p>
                <button class="btn alt small" data-a="barcodeRefresh" ${ui.online && !ui.barcodeBusy ? '' : 'disabled'}>↻ Retry</button>
              </div>`}
          <h3>Create &amp; Add</h3>
          <label class="field" for="f-bcName">Name</label>
          <input id="f-bcName" type="text" data-f="bcName" value="${ui.f.bcName ?? ''}" autocomplete="off">
          <div class="row" style="gap:10px">
            <div style="width:76px"><label class="field" for="f-bcEmoji">Emoji</label><input id="f-bcEmoji" type="text" data-f="bcEmoji" value="${ui.f.bcEmoji ?? '📦'}" autocomplete="off"></div>
            <div class="grow"><label class="field" for="f-bcCategory">Category</label>
              <select id="f-bcCategory" data-f="bcCategory">${CATEGORIES.map(c => html`<option value="${c}" ${ui.f.bcCategory === c ? 'selected' : ''}>${c}</option>`)}</select></div>
          </div>
          <div class="row" style="gap:10px">
            <div class="grow"><label class="field" for="f-bcUnit">Unit</label>
              <select id="f-bcUnit" data-f="bcUnit" data-c="rerender">${UNITS.map(u => html`<option value="${u}" ${bcUnit === u ? 'selected' : ''}>${u}</option>`)}</select></div>
            <div class="grow"><label class="field" for="f-bcPack">Pack size</label>
              <input id="f-bcPack" type="text" inputmode="decimal" data-f="bcPack" data-c="rerender" value="${ui.f.bcPack ?? '1'}" autocomplete="off"></div>
          </div>
          <div class="row" style="gap:10px">
            <div class="grow"><label class="field" for="f-bcKcal">kcal / ${macroLabel}</label>
              <input id="f-bcKcal" type="text" inputmode="decimal" data-f="bcKcal" value="${ui.f.bcKcal ?? ''}" autocomplete="off"></div>
            <div class="grow"><label class="field" for="f-bcProtein">Protein g / ${macroLabel}</label>
              <input id="f-bcProtein" type="text" inputmode="decimal" data-f="bcProtein" value="${ui.f.bcProtein ?? ''}" autocomplete="off"></div>
            <div class="grow"><label class="field" for="f-bcFat">Fat g / ${macroLabel}</label>
              <input id="f-bcFat" type="text" inputmode="decimal" data-f="bcFat" value="${ui.f.bcFat ?? ''}" autocomplete="off"></div>
            <div class="grow"><label class="field" for="f-bcCarbs">Carbs g / ${macroLabel}</label>
              <input id="f-bcCarbs" type="text" inputmode="decimal" data-f="bcCarbs" value="${ui.f.bcCarbs ?? ''}" autocomplete="off"></div>
          </div>
          <label class="field" for="f-buyCost">Cost (optional, ${currencySymbol(st.currency)})</label>
          <input id="f-buyCost" type="text" inputmode="decimal" placeholder="e.g. 29.50" data-f="buyCost" value="${ui.f.buyCost ?? ''}" autocomplete="off">
          ${qtyPicker(v, _sh, bcUnit, bcPackN)}
          <button class="btn big" style="margin-top:10px" data-a="barcodeCreateAdd" ${ui.online && qOf(_sh, 'bc') > 0 ? '' : 'disabled'}>Create &amp; ${addLabel(qOf(_sh, 'bc'), bcUnit, bcPackN, bcModeOf(ui.f, bcUnit, bcPackN))}</button>
          ${st.items.length ? html`<h3 style="margin-top:14px">Or link to existing item</h3>
            <div class="row" style="gap:8px">
              <select id="f-bcLinkItem" data-f="bcLinkItem" data-c="rerender" aria-label="Existing item">
                <option value="">Choose item…</option>
                ${st.items.map(i => html`<option value="${i.id}" ${ui.f.bcLinkItem === String(i.id) ? 'selected' : ''}>${i.emoji} ${i.name}</option>`)}
              </select>
              <button class="btn alt" data-a="barcodeLink" ${ui.online ? '' : 'disabled'}>${linkItem
                ? `Link & ${addLabel(qOf(_sh, 'bc'), linkItem.unit, linkItem.pack_size, bcModeOf(ui.f, linkItem.unit, linkItem.pack_size))}`
                : 'Link & Add'}</button>
            </div>` : ''}
        </div>`)
      : ''}`;
}
