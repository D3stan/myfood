import { html } from '../../html.ts';
import { fmtNum } from '../../../shared/text.ts';
import type { Ui } from '../../store.ts';

/**
 * − number +. The number turns into a field when tapped (so "1,5" works).
 * Ids are stable so the morph keeps the buttons under the finger during fast taps.
 */
export function stepper(ui: Ui, k: string, v: number, step: number, unit = '', mini = false) {
  const id = `st-${k}`;
  return html`<div class="stepper ${mini ? 'mini' : ''}">
    <button class="btn alt" id="${id}-m" data-a="step" data-k="${k}" data-d="-1" data-s="${step}" aria-label="Less">−</button>
    ${ui.editing === k
      ? html`<input class="v" id="${id}-in" type="text" inputmode="decimal" value="${fmtNum(v)}" data-c="num" data-k="${k}" aria-label="Amount">`
      : html`<button class="v" id="${id}-v" data-a="numedit" data-k="${k}" aria-label="Change amount">${fmtNum(v)}${unit && !mini ? html`<small>${unit}</small>` : ''}</button>`}
    <button class="btn" id="${id}-p" data-a="step" data-k="${k}" data-d="1" data-s="${step}" aria-label="More">+</button>
  </div>`;
}
