import { html } from '../../html.ts';
import { CURRENCIES } from '../../../shared/currency.ts';
import { currencySymbol } from '../../../shared/text.ts';
import type { V } from '../components/bits.ts';

const names = new Intl.DisplayNames(['en'], { type: 'currency' });
// a stored legacy non-ISO value is listed too, so the select shows what is really saved
const options = (cur: string) => [...(CURRENCIES as readonly string[]).includes(cur) ? [] : [cur], ...CURRENCIES].map(c =>
  html`<option value="${c}" ${c === cur ? 'selected' : ''}>${c} · ${names.of(c) ?? c} (${currencySymbol(c)})</option>`);

export function household({ st, ui }: V) {
  const origin = typeof location !== 'undefined' && location.origin && location.origin !== 'null'
    ? location.origin
    : 'https://your-myfood-host';
  return html`
    <div class="card">
      <h2 style="margin-top:0">Household currency</h2>
      <div class="row" style="gap:8px;align-items:center">
        <select id="currency" data-f="currency" aria-label="Currency">${options(ui.f.currency ?? st.currency)}</select>
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
