import { html } from '../../html.ts';
import { fmtNum } from '../../../shared/text.ts';
import { CATEGORIES, UNITS } from '../../../shared/types.ts';
import type { BarcodeLookup, Unit } from '../../../shared/types.ts';
import { store as defaultStore } from '../../store.ts';
import type { Sheet, Store } from '../../store.ts';
import { unitOf } from './bits.ts';
import type { V } from './bits.ts';
import { macroBasis } from './sheets.ts';

interface DetectedBarcode { rawValue?: string }
interface BarcodeDetectorLike { detect(source: HTMLVideoElement): Promise<DetectedBarcode[]> }
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

let activeStream: MediaStream | null = null;
let scanTimer = 0;
let scanning = false;

export function isBarcodeDetectorSupported(): boolean {
  return typeof globalThis !== 'undefined'
    && 'BarcodeDetector' in globalThis
    && typeof navigator !== 'undefined'
    && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

/** Stops any active camera track and detection loop so the camera never leaks. */
export function stopScanner(s: Store = defaultStore): void {
  scanning = false;
  if (scanTimer) { clearTimeout(scanTimer); scanTimer = 0; }
  if (activeStream) {
    for (const track of activeStream.getTracks()) track.stop();
    activeStream = null;
  }
  if (typeof document !== 'undefined') {
    const vid = document.getElementById('bc-video') as HTMLVideoElement | null;
    if (vid) vid.srcObject = null;
  }
  s.ui.scannerActive = false;
}

export async function startBarcodeScanner(
  onCode: (code: string) => void | Promise<void>,
  onStateChange?: () => void,
  s: Store = defaultStore,
): Promise<boolean> {
  stopScanner(s);
  if (!isBarcodeDetectorSupported()) {
    s.ui.scannerSupported = false;
    onStateChange?.();
    return false;
  }
  s.ui.scannerSupported = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    if (s.ui.sheet?.t !== 'barcode') {
      for (const track of stream.getTracks()) track.stop();
      return false;
    }
    activeStream = stream;
    scanning = true;
    s.ui.scannerActive = true;
    onStateChange?.();

    const attachVideo = () => {
      const vid = typeof document !== 'undefined' ? document.getElementById('bc-video') as HTMLVideoElement | null : null;
      if (vid && activeStream && vid.srcObject !== activeStream) {
        vid.srcObject = activeStream;
        void vid.play().catch(() => {});
      }
      return vid;
    };
    attachVideo();

    const Detector = (globalThis as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
    const detector = new Detector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] });

    const tick = async () => {
      if (!scanning || s.ui.sheet?.t !== 'barcode') { stopScanner(s); return; }
      const vid = attachVideo();
      if (vid && vid.readyState >= 2) {
        try {
          const hits = await detector.detect(vid);
          const code = hits.map(h => (h.rawValue ?? '').trim()).find(c => /^\d{6,14}$/.test(c));
          if (code) {
            stopScanner(s);
            s.ui.f.barcodeCode = code;
            await onCode(code);
            return;
          }
        } catch { /* ignore transient frame decode errors */ }
      }
      if (scanning) scanTimer = window.setTimeout(() => void tick(), 250);
    };
    scanTimer = window.setTimeout(() => void tick(), 200);
    return true;
  } catch {
    stopScanner(s);
    onStateChange?.();
    return false;
  }
}

/** Pre-fills quick-create fields from an Open Food Facts / cached barcode lookup. */
export function barcodeToFields(lk: BarcodeLookup): Record<string, string> {
  const p = lk.product;
  const unit: Unit = p?.unit ?? 'g';
  const { mult } = macroBasis(unit);
  return {
    bcName: p?.product_name ?? '',
    bcEmoji: '📦',
    bcCategory: p?.category ?? 'pantry',
    bcUnit: unit,
    bcPack: fmtNum(p?.pack_size ?? 1),
    bcKcal: p?.kcal_per_unit != null ? fmtNum(p.kcal_per_unit * mult) : '',
    bcProtein: p?.protein_per_unit != null ? fmtNum(p.protein_per_unit * mult) : '',
    bcFat: p?.fat_per_unit != null ? fmtNum(p.fat_per_unit * mult) : '',
    buyCost: '',
  };
}

export function barcodeSheet(v: V, _sh: Sheet) {
  const { st, ui } = v;
  const lk = ui.barcodeLookup;
  const matched = lk?.item_id != null ? st.items.find(i => i.id === lk.item_id) : undefined;
  const supported = ui.scannerSupported || isBarcodeDetectorSupported();
  const bcUnit = (UNITS.includes(ui.f.bcUnit as Unit) ? ui.f.bcUnit : 'g') as Unit;
  const { label: macroLabel } = macroBasis(bcUnit);

  return html`<h2 id="sheet-title">📷 Scan barcode</h2>
    ${supported
      ? html`<div>
          <video id="bc-video" class="viewfinder" autoplay playsinline muted></video>
          <div class="row" style="margin-bottom:8px">
            ${ui.scannerActive
              ? html`<button class="btn alt grow" data-a="stopScan">Stop camera</button>`
              : html`<button class="btn alt grow" data-a="startScan">Start camera</button>`}
          </div>
        </div>`
      : html`<p class="note small">Live barcode scanning isn't supported in this browser — enter the barcode digits or snap a photo instead.</p>`}
    <form class="row" style="gap:8px;margin-top:10px" data-submit="barcodeLookup">
      <input id="f-barcodeCode" type="text" inputmode="numeric" autofocus placeholder="Barcode digits (e.g. 5701234567890)" data-f="barcodeCode" value="${ui.f.barcodeCode ?? ''}" autocomplete="off">
      <button class="btn" type="submit" ${ui.online && !ui.barcodeBusy ? '' : 'disabled'}>${ui.barcodeBusy ? 'Looking…' : 'Look up'}</button>
    </form>
    <div class="row" style="margin-top:8px">
      <button class="btn alt grow" data-a="barcodeFallbackPhoto">📷 Snap photo instead</button>
    </div>
    ${lk ? (matched
      ? html`<div class="card" style="margin-top:14px">
          <div class="line" style="border:0"><span class="emoji">${matched.emoji}</span>
            <span class="n"><b>${matched.name}</b> <span class="muted small">pack ${fmtNum(matched.pack_size)} ${unitOf(matched)}</span></span></div>
          <label class="field" for="f-buyCost">Cost (optional, ${st.currency})</label>
          <input id="f-buyCost" type="text" inputmode="decimal" placeholder="e.g. 29.50" data-f="buyCost" value="${ui.f.buyCost ?? ''}" autocomplete="off">
          <button class="btn big" style="margin-top:10px" data-a="barcodeAddPack" data-id="${matched.id}">Add pack (+${fmtNum(matched.pack_size)} ${unitOf(matched)})</button>
        </div>`
      : html`<div class="card" style="margin-top:14px">
          ${lk.found && lk.product
            ? html`<p style="margin:0 0 8px"><b>${lk.product.product_name ?? 'Product found'}</b>${lk.product.brand ? ` · ${lk.product.brand}` : ''}</p>`
            : html`<p class="muted small" style="margin:0 0 8px">Not found in database for ${lk.code}. Create a new item or link an existing one:</p>`}
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
              <input id="f-bcPack" type="text" inputmode="decimal" data-f="bcPack" value="${ui.f.bcPack ?? '1'}" autocomplete="off"></div>
          </div>
          <div class="row" style="gap:10px">
            <div class="grow"><label class="field" for="f-bcKcal">kcal / ${macroLabel}</label>
              <input id="f-bcKcal" type="text" inputmode="decimal" data-f="bcKcal" value="${ui.f.bcKcal ?? ''}" autocomplete="off"></div>
            <div class="grow"><label class="field" for="f-bcProtein">Protein g / ${macroLabel}</label>
              <input id="f-bcProtein" type="text" inputmode="decimal" data-f="bcProtein" value="${ui.f.bcProtein ?? ''}" autocomplete="off"></div>
            <div class="grow"><label class="field" for="f-bcFat">Fat g / ${macroLabel}</label>
              <input id="f-bcFat" type="text" inputmode="decimal" data-f="bcFat" value="${ui.f.bcFat ?? ''}" autocomplete="off"></div>
          </div>
          <label class="field" for="f-buyCost">Cost (optional, ${st.currency})</label>
          <input id="f-buyCost" type="text" inputmode="decimal" placeholder="e.g. 29.50" data-f="buyCost" value="${ui.f.buyCost ?? ''}" autocomplete="off">
          <button class="btn big" style="margin-top:10px" data-a="barcodeCreateAdd" ${ui.online ? '' : 'disabled'}>Create &amp; Add</button>
          ${st.items.length ? html`<h3 style="margin-top:14px">Or link to existing item</h3>
            <div class="row" style="gap:8px">
              <select id="f-bcLinkItem" data-f="bcLinkItem" aria-label="Existing item">
                <option value="">Choose item…</option>
                ${st.items.map(i => html`<option value="${i.id}" ${ui.f.bcLinkItem === String(i.id) ? 'selected' : ''}>${i.emoji} ${i.name}</option>`)}
              </select>
              <button class="btn alt" data-a="barcodeLink" ${ui.online ? '' : 'disabled'}>Link &amp; Add</button>
            </div>` : ''}
        </div>`)
      : ''}`;
}
