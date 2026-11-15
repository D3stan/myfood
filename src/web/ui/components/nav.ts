import { html } from '../../html.ts';
import type { Tab, Ui } from '../../store.ts';

const TABS: [Tab, string, string][] = [['pantry', '🥫', 'Pantry'], ['history', '📜', 'History'], ['me', '🙂', 'Me']];

export const tabbar = (tab: Tab) => html`<nav class="tabbar" aria-label="Tabs">${TABS.map(([t, e, l]) =>
  html`<button id="tab-${t}" class="${tab === t ? 'on' : ''}" data-a="tab" data-tab="${t}" aria-current="${tab === t ? 'page' : 'false'}"><span class="e">${e}</span>${l}</button>`)}</nav>`;

/** Looks like a text field; tapping it opens the top sheet so the keyboard never covers the real one. */
export const composer = () => html`<div class="composer">
  <button class="fake" id="composer" data-a="open" data-s="compose">Ate 2 eggs… bought milk… or snap a receipt</button>
  <button class="btn icon" data-a="open" data-s="compose" aria-label="Snap a receipt">📷</button>
</div>`;

export const toast = (ui: Ui) => ui.toast
  ? html`<div class="toast" id="toast-${ui.toast.id}" role="status"><span>${ui.toast.msg}</span>${ui.toast.cids ? html`<button class="linkbtn" data-a="toastUndo">Undo</button>` : ''}</div>`
  : html``;
