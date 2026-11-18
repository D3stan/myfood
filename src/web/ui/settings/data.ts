import { html } from '../../html.ts';
import { isoDate } from '../../../shared/dates.ts';
import { fmtCost } from '../../../shared/text.ts';
import type { V } from '../components/bits.ts';

// Only knowable: whether the last AI job worked (the same value /api/health reports) and the error of a failed job still listed.
const AI_STATUS = { null: 'Not used yet since the server started', true: 'Working (the last AI job succeeded)', false: 'Not working (the last AI job failed)' };

export function data({ st, ui }: V) {
  const d = ui.data;
  const off = ui.online ? '' : 'disabled';
  const lastError = st.jobs.find(j => j.status === 'failed' && j.error)?.error;
  return html`
    <div class="card">
      <h2 style="margin-top:0">AI</h2>
      <div id="ai-status">${AI_STATUS[String(st.ai.ready) as 'null' | 'true' | 'false']}</div>
      ${lastError ? html`<p class="small muted" style="margin:6px 0 0">Last error: ${lastError}</p>` : ''}
    </div>

    <div class="card">
      <h2 style="margin-top:0">Week locks</h2>
      ${st.expense_locks.length ? st.expense_locks.map(l => html`
        <div class="line" id="lock-${l.period}">
          <span class="n"><b>${l.period}</b> <span class="small muted">${fmtCost(l.total_cents, st.currency)} · ${l.event_count} events · ${st.users.find(u => u.id === l.locked_by)?.name ?? '?'} · ${isoDate(l.locked_at)}${l.note ? ` · ${l.note}` : ''}</span></span>
          <button class="btn alt" data-a="unlockWeek" data-p="${l.period}" ${off}>Unlock</button>
        </div>`) : html`<p class="small muted" style="margin:0">No locked weeks.</p>`}
    </div>

    <div class="card">
      <h2 style="margin-top:0">Archived items</h2>
      ${!d ? html`<p class="small muted" style="margin:0">Loading…</p>` : d.archived.length ? d.archived.map(i => html`
        <div class="line" id="archived-${i.id}">
          <span class="n">${i.emoji} <b>${i.name}</b> <span class="small muted">${isoDate(i.archived_at)}</span></span>
          <button class="btn alt" data-a="restoreItem" data-id="${i.id}" ${off}>Restore</button>
        </div>`) : html`<p class="small muted" style="margin:0">No archived items.</p>`}
    </div>

    <div class="card">
      <h2 style="margin-top:0">Receipt names</h2>
      <p class="small muted" style="margin:0 0 8px">Names the AI learned from receipts, each pointing at an item.</p>
      ${!d ? html`<p class="small muted" style="margin:0">Loading…</p>` : d.aliases.length ? d.aliases.map(a => html`
        <div class="line">
          <span class="n">${a.text} <span class="small muted">→ ${a.emoji} ${a.item_name}</span></span>
          <button class="btn alt" data-a="delAlias" data-text="${a.text}" ${off}>Delete</button>
        </div>`) : html`<p class="small muted" style="margin:0">None learned yet.</p>`}
    </div>
  `;
}
