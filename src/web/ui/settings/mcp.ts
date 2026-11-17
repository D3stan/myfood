import { html } from '../../html.ts';
import { isoDate } from '../../../shared/dates.ts';

import type { V } from '../components/bits.ts';

export function mcp({ st, ui }: V) {
  const origin = typeof location !== 'undefined' && location.origin && location.origin !== 'null'
    ? location.origin
    : 'https://your-myfood-host';
  const tokens = st.tokens.filter(t => t.scopes === 'mcp');
  return html`
    <div class="card">
      <h2 style="margin-top:0">MCP</h2>
      <div class="row" style="gap:8px;align-items:center">
        <input id="mcp-token-name" type="text" maxlength="60" placeholder="Token name (e.g. Claude)" data-f="tokenName" value="${ui.f.tokenName ?? ''}" autocomplete="off">
        <button id="mcp-create" class="btn" data-a="createToken" data-scope="mcp" ${ui.online ? '' : 'disabled'}>Create</button>
      </div>
      ${ui.newToken ? html`
        <div class="note" style="margin-top:10px">
          <div><b>Copy this connector URL now</b> — it won't be shown again:</div>
          <div class="row" style="gap:8px;align-items:center;margin-top:6px">
            <code style="word-break:break-all;flex:1">${origin}/mcp/${ui.newToken}</code>
            <button id="mcp-copy" class="btn alt" data-a="copyMcpUrl">Copy</button>
          </div>
        </div>
      ` : ''}
      ${tokens.length ? html`<div style="margin-top:10px">${tokens.map(t => html`
        <div class="line" id="mcp-tok-${t.id}">
          <span class="n"><b>${t.name}</b> <span class="small muted">${t.prefix}… · ${isoDate(t.created_at)}</span></span>
          <button id="mcp-revoke-${t.id}" class="btn alt" data-a="revokeToken" data-id="${t.id}" ${ui.online ? '' : 'disabled'}>Revoke</button>
        </div>
      `)}</div>` : ''}
      <p class="small muted" style="margin:12px 0 0">claude.ai: Settings → Connectors → Add custom connector → paste the URL.<br>Claude Code: <code>claude mcp add --transport http myfood &lt;url&gt;</code><br>The token acts as you: anyone with the URL can read and log as you.</p>
    </div>
  `;
}
