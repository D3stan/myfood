import { html } from '../../html.ts';
import type { V } from '../components/bits.ts';

export function household({ st, ui }: V) {
  const origin = typeof location !== 'undefined' && location.origin && location.origin !== 'null'
    ? location.origin
    : 'https://your-myfood-host';
  return html`
    <div class="card">
      <h2 style="margin-top:0">Household currency</h2>
      <div class="row" style="gap:8px;align-items:center">
        <input id="currency" type="text" maxlength="8" data-f="currency" value="${ui.f.currency ?? st.currency}" autocomplete="off" aria-label="Currency symbol">
        <button class="btn" data-a="saveSettings" ${ui.online ? '' : 'disabled'}>Save</button>
      </div>
    </div>


    <div class="card">
      <h2 style="margin-top:0">Guest access</h2>
      <p class="small muted" style="margin:0 0 8px">Visitors open <code>${origin}/guest</code> and type this passcode to see the shared pantry (read-only, personal items hidden).</p>
      <div class="row" style="gap:8px;align-items:center">
        <code style="flex:1;font-size:1.3rem" id="guest-code">${st.guest_code || '—'}</code>
        <button class="btn alt" data-a="copyGuest">Copy</button>
        <button class="btn alt" data-a="newGuestCode" ${ui.online ? '' : 'disabled'}>New code</button>
      </div>
    </div>

  `;
}
