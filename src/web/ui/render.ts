import { Idiomorph } from 'idiomorph';
import { html, htmlToString } from '../html.ts';
import type { Html } from '../html.ts';
import { view } from '../store.ts';
import type { Store } from '../store.ts';
import type { V } from './components/bits.ts';
import { barcodeSheet } from './components/barcode.ts';
import { composeSheet, reviewSheet } from './components/compose.ts';
import { cookSheet } from './components/cook.ts';
import { composer, tabbar, toast } from './components/nav.ts';
import { eventSheet, expenseSheet, itemFormSheet, itemSheet, presetEditSheet, presetSheet } from './components/sheets.ts';
import { syncTour, tourHtml } from './components/tour.ts';
import { history } from './screens/history.ts';
import { login } from './screens/login.ts';
import { me } from './screens/me.ts';
import { pantry } from './screens/pantry.ts';
import { PAGES } from './settings/index.ts';
import { spend } from './spend/screen.ts';

const page = (v: V, key: string): Html => {
  const p = PAGES[key];
  return html`<div class="top"><button id="page-back" class="btn alt icon" data-a="back" aria-label="Back">←</button><h1 class="grow" style="margin:0">${p?.title ?? ''}</h1></div>${p?.render(v)}`;
};

const demoBanner = (s: Store): Html => s.ui.demo
  ? html`<div class="demo-bar" id="demo-bar">
      <span class="grow"><b>Demo mode</b> · Sample pantry</span>
      <button type="button" class="btn alt sm" id="demo-tour" data-a="tourStart">Tour</button>
      <button type="button" class="btn alt sm" id="demo-exit" data-a="exitDemo">Exit</button>
    </div>`
  : html``;

// Pure: state in, HTML string out (so tests need no DOM).
export function appHtml(s: Store, now = new Date()): string {
  const st = view(s);
  const out: Html = !st
    ? (s.ui.loggedOut ? login(s.ui) : html`<p class="center muted" style="margin-top:30vh">Loading…</p>`)
    : html`${demoBanner(s)}${s.ui.page.length ? page({ st, ui: s.ui }, s.ui.page[s.ui.page.length - 1]!)
        : s.ui.tab === 'pantry' ? pantry({ st, ui: s.ui }, now)
        : s.ui.tab === 'spend' ? spend({ st, ui: s.ui }, now)
        : s.ui.tab === 'history' ? history({ st, ui: s.ui }, now)
        : me({ st, ui: s.ui }, now)}${composer()}${tabbar(s.ui.tab)}`;
  return htmlToString(out);
}

export function sheetHtml(s: Store): string {
  const st = view(s), sh = s.ui.sheet;
  if (!st || !sh) return '';
  const v = { st, ui: s.ui };
  const body = {
    item: itemSheet, preset: presetSheet, presetEdit: presetEditSheet, itemForm: itemFormSheet,
    compose: composeSheet, review: reviewSheet, event: eventSheet,
    cook: cookSheet, barcode: barcodeSheet, expense: expenseSheet,
  }[sh.t];
  return htmlToString(body(v, sh));
}

export const toastHtml = (s: Store): string => htmlToString(toast(s.ui));

const morph = (el: Element, h: string): void => { Idiomorph.morph(el, h, { morphStyle: 'innerHTML', ignoreActiveValue: true }); };
const $ = (id: string): HTMLElement => document.getElementById(id)!;

let lastKey = '';
let restore: Element | null = null;

export function render(s: Store): void {
  morph($('app'), appHtml(s));
  morph($('toast'), toastHtml(s));
  const sh = s.ui.sheet, ov = $('overlay'), sheet = $('sheet');
  if (sh) {
    morph(sheet, sheetHtml(s));
    ov.classList.toggle('top', sh.t === 'compose');
    sheet.classList.toggle('top', sh.t === 'compose');
  }
  ov.classList.toggle('open', !!sh);
  ov.setAttribute('aria-hidden', String(!sh));
  document.documentElement.classList.toggle('locked', !!sh);
  const key = sh ? `${sh.t}:${sh.id ?? ''}` : '';
  if (sh && key !== lastKey) {
    restore ??= document.activeElement;
    sheet.scrollTop = 0;
    (sheet.querySelector<HTMLElement>('[autofocus]') ?? sheet).focus({ preventScroll: true });
  } else if (!sh && lastKey) {
    (restore as HTMLElement | null)?.focus?.({ preventScroll: true });
    restore = null;
  }
  lastKey = key;
  const num = s.ui.editing && document.querySelector<HTMLInputElement>('input[data-c=num]');
  if (num && document.activeElement !== num) { num.focus(); num.select(); }
  const tourEl = document.getElementById('tour');
  if (tourEl) {
    Idiomorph.morph(tourEl, tourHtml(s), { morphStyle: 'innerHTML' });
    syncTour(s);
  }
  document.title = 'MyFood';
}
