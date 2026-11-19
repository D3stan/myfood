import { html } from '../../html.ts';
import type { V } from '../components/bits.ts';

export function profile({ st, ui }: V) {
  return html`
    <div class="card">
      <label class="field" for="me-name">Name</label>
      <input id="me-name" type="text" maxlength="60" data-f="meName" value="${ui.f.meName ?? st.me.name}" autocomplete="off">
      <label class="field" for="me-emoji">Emoji</label>
      <input id="me-emoji" type="text" maxlength="8" data-f="meEmoji" value="${ui.f.meEmoji ?? st.me.emoji}" autocomplete="off">
      <div class="row" style="margin-top:12px"><button class="btn right" data-a="saveMe" ${ui.online ? '' : 'disabled'}>Save</button></div>
    </div>


    <div class="card">
      <h2 style="margin-top:0">Access code</h2>
      ${ui.newCode ? html`
        <div class="note" style="margin-bottom:8px"><b>Copy this code now</b> — it won't be shown again:
          <div class="row" style="gap:8px;align-items:center;margin-top:6px">
            <code id="new-code" style="flex:1;font-size:1.3rem">${ui.newCode}</code>
            <button id="copy-code" class="btn alt" data-a="copyAccessCode">Copy</button>
          </div>
        </div>` : ''}
      <button id="new-code-btn" class="btn alt" data-a="newAccessCode" ${ui.online ? '' : 'disabled'}>New access code</button>
      <p class="small muted" style="margin:8px 0 0">Signs out your other devices. This one stays signed in.</p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Notifications</h2>
      ${ui.standalone ? '' : html`<p class="note">On iPhone/iPad, push notifications require installing MyFood first: tap Share → Add to Home Screen, then open it from there.</p>`}
      <label class="row" style="gap:8px;align-items:center;margin:8px 0;cursor:pointer">
        <input type="checkbox" data-f="notifyLow" ${st.me.notify_low ? 'checked' : ''}>
        <span>Alert when shared or personal items run low</span>
      </label>
      <label class="row" style="gap:8px;align-items:center;margin:8px 0;cursor:pointer">
        <input type="checkbox" data-f="notifyExpiry" ${st.me.notify_expiry ? 'checked' : ''}>
        <span>Daily expiry reminder (~09:00)</span>
      </label>
      <label class="row" style="gap:8px;align-items:center;margin:8px 0;cursor:pointer">
        <input type="checkbox" data-f="notifyDeals" ${st.me.notify_deals ? 'checked' : ''}>
        <span>Shopping trip when new deals arrive</span>
      </label>
      <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
        ${!ui.pushSupported
          ? html`<span class="small muted">Push notifications are not supported in this browser.</span>`
          : st.push_subscribed
            ? html`
                <button class="btn alt" data-a="disablePush" ${ui.online ? '' : 'disabled'}>Disable push</button>
                <button class="btn" data-a="testPush" ${ui.online ? '' : 'disabled'}>Send test</button>
              `
            : html`<button class="btn" data-a="enablePush" ${ui.online ? '' : 'disabled'}>Enable push</button>`}
      </div>
    </div>

  `;
}
