import { html } from '../../html.ts';
import { isoDate } from '../../../shared/dates.ts';

import type { V } from '../components/bits.ts';
import { SHORTCUTS, shortcutText } from './shortcuts.ts';
import type { ShortcutKind } from './shortcuts.ts';

export function siri({ st, ui }: V) {
  const origin = typeof location !== 'undefined' && location.origin && location.origin !== 'null'
    ? location.origin
    : 'https://your-myfood-host';
  return html`
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
      <p class="small muted" style="margin:12px 0 4px">Two shortcuts. Create a token above, copy a text below, then paste it into the Shortcuts app's AI builder (describe your shortcut) or follow the steps by hand.${ui.newToken ? ' The copied text includes your new token.' : ' Create a token first so the copy includes it, or paste it in yourself.'}</p>
      ${(Object.keys(SHORTCUTS) as ShortcutKind[]).map(k => html`<div class="note" style="margin-top:8px">
        <div class="row" style="gap:8px;align-items:center"><b class="grow">${SHORTCUTS[k].name}</b><button class="btn alt" data-a="copyShortcut" data-k="${k}">Copy setup text</button></div>
        <div class="small muted">${SHORTCUTS[k].blurb}</div>
        <details><summary class="small">Show the steps</summary><pre class="small" style="white-space:pre-wrap;word-break:break-word;margin:6px 0 0">${shortcutText(k, origin, ui.newToken)}</pre></details>
      </div>`)}
    </div>

  `;
}
