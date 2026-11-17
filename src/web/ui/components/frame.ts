// Week/Month selector with ‹ label ›. State lives in ui.frames[key]; actions are in ../frame-actions.ts.
import type { Frame } from '../../../shared/period.ts';
import { html } from '../../html.ts';
import type { Ui } from '../../store.ts';

export const frameOf = (ui: Ui, key: string): { frame: Frame; offset: number } => ui.frames[key] ?? { frame: 'week', offset: 0 };

/** `partial` = the shown period starts before the 90-day window (rule 4). */
export function frameBar(key: string, frame: Frame, offset: number, label: string, canPrev: boolean, partial = false) {
  const seg = (f: Frame, text: string) => html`<button id="${key}-frame-${f}" class="${frame === f ? 'on' : ''}" data-a="frame" data-k="${key}" data-v="${f}">${text}</button>`;
  return html`
    <div class="row wrap" style="margin:0 0 8px">
      <div class="seg" style="margin:0" role="group" aria-label="Time frame">${seg('week', 'Week')}${seg('month', 'Month')}</div>
      <div class="row right" style="gap:4px">
        <button id="${key}-prev" class="btn alt icon" data-a="frameStep" data-k="${key}" data-d="-1" aria-label="Previous" ${canPrev ? '' : 'disabled'}>‹</button>
        <span style="min-width:90px;text-align:center">${label}</span>
        <button id="${key}-next" class="btn alt icon" data-a="frameStep" data-k="${key}" data-d="1" aria-label="Next" ${offset < 0 ? '' : 'disabled'}>›</button>
      </div>
    </div>
    ${partial ? html`<p class="muted small" style="margin:0 0 6px">partial: only the last 90 days are loaded</p>` : ''}`;
}
