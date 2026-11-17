import { html } from '../../html.ts';
import type { V } from '../components/bits.ts';

export function me({ ui }: V) {
  return html`
    <div class="row" style="align-items:center"><h1 class="grow" style="margin:0">Me</h1><button id="me-settings" class="btn alt icon" data-a="go" data-p="settings" aria-label="Settings">⚙️</button></div>
    ${ui.standalone ? '' : html`<p class="note">Install it: tap Share, then Add to Home Screen. Sign in inside the installed app.</p>`}
  `;
}
