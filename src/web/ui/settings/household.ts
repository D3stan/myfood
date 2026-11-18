import { html } from '../../html.ts';
import type { V } from '../components/bits.ts';

const COUNTRIES: readonly [string, string][] = [
  ['', 'Global (auto)'],
  ['dk', 'Denmark (DK)'],
  ['se', 'Sweden (SE)'],
  ['no', 'Norway (NO)'],
  ['fi', 'Finland (FI)'],
  ['de', 'Germany (DE)'],
  ['gb', 'United Kingdom (GB)'],
  ['us', 'United States (US)'],
  ['it', 'Italy (IT)'],
  ['fr', 'France (FR)'],
  ['es', 'Spain (ES)'],
  ['nl', 'Netherlands (NL)'],
];

export function household({ st, ui }: V) {
  const origin = typeof location !== 'undefined' && location.origin && location.origin !== 'null'
    ? location.origin
    : 'https://your-myfood-host';
  const curCountry = ui.f.country ?? st.country ?? '';
  const hasCustomCountry = Boolean(curCountry && !COUNTRIES.some(([code]) => code === curCountry));
  return html`
    <div class="card">
      <h2 style="margin-top:0">Household settings</h2>
      <label class="field" for="currency">Currency symbol</label>
      <input id="currency" type="text" maxlength="8" data-f="currency" value="${ui.f.currency ?? st.currency}" autocomplete="off" aria-label="Currency symbol">
      <label class="field" for="country">Country (for barcode lookups)</label>
      <select id="country" data-f="country" aria-label="Country for barcode lookups">
        ${COUNTRIES.map(([code, label]) => html`<option value="${code}" ${curCountry === code ? 'selected' : ''}>${label}</option>`)}
        ${hasCustomCountry ? html`<option value="${curCountry}" selected>${curCountry.toUpperCase()}</option>` : ''}
      </select>
      <div class="row" style="margin-top:10px">
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
