import { html } from '../../html.ts';
import { isoDate } from '../../../shared/dates.ts';
import { hourToTime } from '../components/bits.ts';
import type { V } from '../components/bits.ts';

export function me({ st, ui }: V) {
  const origin = typeof location !== 'undefined' && location.origin && location.origin !== 'null'
    ? location.origin
    : 'https://your-myfood-host';
  const shortcutUrl = `${origin}/api/shortcut`;

  return html`
    <h1>Me</h1>
    <div class="card">
      <label class="field" for="me-name">Name</label>
      <input id="me-name" type="text" maxlength="60" data-f="meName" value="${ui.f.meName ?? st.me.name}" autocomplete="off">
      <label class="field" for="me-emoji">Emoji</label>
      <input id="me-emoji" type="text" maxlength="8" data-f="meEmoji" value="${ui.f.meEmoji ?? st.me.emoji}" autocomplete="off">
      <div class="row" style="margin-top:12px"><button class="btn right" data-a="saveMe" ${ui.online ? '' : 'disabled'}>Save</button></div>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Household currency</h2>
      <div class="row" style="gap:8px;align-items:center">
        <input id="currency" type="text" maxlength="8" data-f="currency" value="${ui.f.currency ?? st.currency}" autocomplete="off" aria-label="Currency symbol">
        <button class="btn" data-a="saveSettings" ${ui.online ? '' : 'disabled'}>Save</button>
      </div>
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

    <div class="card">
      <h2 style="margin-top:0">Siri Shortcut</h2>
      <div class="row" style="gap:8px;align-items:center">
        <input id="token-name" type="text" maxlength="60" placeholder="Token name (e.g. iPhone Siri)" data-f="tokenName" value="${ui.f.tokenName ?? ''}" autocomplete="off">
        <button class="btn" data-a="createToken" ${ui.online ? '' : 'disabled'}>Create</button>
      </div>
      ${ui.newToken ? html`
        <div class="note" style="margin-top:10px">
          <div><b>Copy this token now</b> — it won't be shown again:</div>
          <div class="row" style="gap:8px;align-items:center;margin-top:6px">
            <code style="word-break:break-all;flex:1">${ui.newToken}</code>
            <button class="btn alt" data-a="copyToken">Copy</button>
          </div>
        </div>
      ` : ''}
      ${st.tokens.length ? html`<div style="margin-top:10px">${st.tokens.map(t => html`
        <div class="line" id="tok-${t.id}">
          <span class="n"><b>${t.name}</b> <span class="small muted">${t.prefix}… · ${isoDate(t.created_at)}</span></span>
          <button class="btn alt" data-a="revokeToken" data-id="${t.id}" ${ui.online ? '' : 'disabled'}>Revoke</button>
        </div>
      `)}</div>` : ''}
      <div class="small muted" style="margin-top:12px">
        <div><b>Endpoint:</b> <code>POST ${shortcutUrl}</code></div>
        <div><b>Header:</b> <code>Authorization: Bearer &lt;token&gt;</code></div>
        <div><b>Body (JSON):</b> <code>{"text":"log breakfast"}</code></div>
        <ol style="padding-left:18px;margin:8px 0 0">
          <li>Open iOS <b>Shortcuts</b> and create a new shortcut (e.g. "Log food").</li>
          <li>Add <b>Ask for Input</b> (Text) or pass a phrase directly.</li>
          <li>Add <b>Get Contents of URL</b> → URL: <code>${shortcutUrl}</code>, Method: <b>POST</b>, Header <code>Authorization: Bearer &lt;token&gt;</code>, Request Body: JSON <code>{"text": Provided Input}</code>.</li>
          <li>Add <b>Get Dictionary Value</b> for <code>reply</code> and <b>Speak Text</b> / <b>Show Result</b>.</li>
        </ol>
      </div>
    </div>

    <h2>Presets</h2>
    ${st.presets.map(p => html`<div class="line" id="pre-${p.id}"><span class="emoji">${p.emoji}</span><span class="n">${p.name} <span class="muted small">${hourToTime(p.hour)}</span></span>
      <button class="btn alt icon" data-a="open" data-s="presetEdit" data-id="${p.id}" aria-label="Edit ${p.name}">✏️</button>
      <button class="btn alt icon" data-a="delPreset" data-id="${p.id}" aria-label="Delete ${p.name}" ${ui.online ? '' : 'disabled'}>🗑️</button></div>`)}
    <div class="row" style="margin:12px 0"><button class="btn" data-a="open" data-s="presetEdit">New preset</button></div>
    ${ui.standalone ? '' : html`<p class="note">Install it: tap Share, then Add to Home Screen. Sign in inside the installed app.</p>`}
    <div class="row" style="margin-top:20px"><button class="linkbtn" data-a="logout">Sign out</button><span class="small muted right">build ${__BUILD__}</span></div>
  `;
}
