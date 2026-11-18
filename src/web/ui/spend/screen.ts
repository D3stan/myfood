import { html } from '../../html.ts';
import { MONTHS, isoDate, isoWeek, parseIsoDate } from '../../../shared/dates.ts';
import { computeDailyNutrition } from '../../../shared/nutrition.ts';
import { frameNav, periodBuckets, periodRange } from '../../../shared/period.ts';
import { settleTransfers } from '../../../shared/settle.ts';
import { bucketByUser, groupExpensesByWeek, paidRows, sumRows } from '../../../shared/spend.ts';
import { fmtCost } from '../../../shared/text.ts';
import { clock, lineText, userOf } from '../components/bits.ts';
import type { V } from '../components/bits.ts';
import { COLORS, barChart } from '../components/chart.ts';
import { frameBar, frameOf } from '../components/frame.ts';
import { statsFor } from '../stats.ts';

export function spend(v: V, now: number | Date = new Date()) {
  const { st, ui } = v;
  const nowMs = now instanceof Date ? now.getTime() : now;
  const fr = frameOf(ui, 'spend'), range = periodRange(fr.frame, fr.offset, nowMs), nav = frameNav(fr.frame, fr.offset, nowMs, ui.online);
  const wide = statsFor(ui, 'spend', fr.frame, range, nowMs); // outside the 90-day window: fetched rows, not State
  const inFrame = new Set(range.days);
  const mineOnly = ui.spendScope === 'mine';
  const paidEvents = wide.data || wide.loading ? [] : st.expenses.filter(e => (e.cost_cents ?? 0) > 0 && inFrame.has(isoDate(e.at)));
  const paid = wide.data ? wide.data.paid : paidRows(paidEvents);
  const shown = mineOnly ? paid.filter(r => r.user_id === st.me.id) : paid;
  const shownEvents = mineOnly ? paidEvents.filter(e => e.user_id === st.me.id) : paidEvents;
  // Week cards list State events, so they are hidden in a Year frame (month totals are the bars) and for fetched periods.
  const weeks = new Set(range.days.map(d => isoWeek(parseIsoDate(d)!)));
  const groups = fr.frame === 'year' || wide.data || wide.loading ? [] : groupExpensesByWeek(shownEvents, st.expense_locks, nowMs)
    .filter(g => weeks.has(g.period));
  const total = sumRows(paid);
  const ate = wide.data ? wide.data.ate : wide.loading ? [] : computeDailyNutrition(st.events, st.items, st.daily_nutrition).filter(d => inFrame.has(d.day));
  const paidBy = (id: number) => sumRows(paid.filter(r => r.user_id === id));
  const bars = periodBuckets(fr.frame, range).map(b => ({ label: b.label, values: bucketByUser(shown, st.users, fr.frame, b.key) }));
  const transfers = settleTransfers(st.settle.balances);
  const since = st.settle.since ? new Date(st.settle.since) : null;
  const who = (id: number) => { const u = st.users.find(x => x.id === id); return `${u?.emoji ?? '🙂'} ${u?.name ?? '?'}`; };
  const hasAny = st.expenses.some(e => (e.cost_cents ?? 0) > 0) || st.expense_locks.length > 0;

  return html`
    <div class="top">
      <h1 style="margin:0">Spend</h1>
      <button class="btn right" data-a="open" data-s="expense">+ Log expense</button>
    </div>
    ${hasAny ? '' : html`<p class="note">No expenses logged yet. Tap "+ Log expense" or scan a receipt with prices.</p>`}
    ${frameBar('spend', fr.frame, fr.offset, range.label, nav.canPrev, nav.partial && !wide.data && !wide.loading, wide.loading)}
    <div class="card" id="spend-summary">
      <div class="row" style="align-items:center"><span class="small muted grow">Household paid</span><span id="spend-total" style="font-family:'Permanent Marker',cursive;font-size:1.6rem">${fmtCost(total, st.currency)}</span></div>
      ${barChart({ bars, fmt: c => fmtCost(c, st.currency) })}
      <div class="row small muted" style="gap:10px;flex-wrap:wrap;margin:6px 0">
        ${st.users.map((u, i) => html`<span><i style="display:inline-block;width:10px;height:10px;border:1px solid var(--ink);background:${COLORS[i % COLORS.length]!}"></i> ${u.emoji} ${u.name}</span>`)}
      </div>
      <div class="seg" style="margin:0 0 6px" role="group" aria-label="Spend scope">
        <button id="spend-scope-all" class="${mineOnly ? '' : 'on'}" data-a="spendScope" data-v="all">All</button>
        <button id="spend-scope-mine" class="${mineOnly ? 'on' : ''}" data-a="spendScope" data-v="mine">Mine</button>
      </div>
      <div id="spend-users">${st.users.map(u => {
        const p = paidBy(u.id), mine = ate.filter(d => d.user_id === u.id);
        const unpriced = mine.reduce((a, d) => a + d.unpriced, 0);
        return html`<div id="spend-user-${u.id}" style="margin-top:6px">
          <div class="row"><span class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${u.emoji} ${u.name}</span>
            <span class="small" style="white-space:nowrap">paid ${fmtCost(p, st.currency)}${total > 0 ? ` (${Math.round((p / total) * 100)}%)` : ''} · ate ${fmtCost(mine.reduce((a, d) => a + d.value_cents, 0), st.currency)}</span></div>
          ${unpriced > 0 ? html`<div class="small muted" style="text-align:right">+${unpriced} unpriced</div>` : ''}
        </div>`;
      })}</div>
    </div>
    <div class="card" id="settle">
      <b>Settle up</b> <span class="small muted">${since ? `since ${since.getDate()} ${MONTHS[since.getMonth()]}` : 'since the start'}</span>
      ${transfers.length
        ? transfers.map(t => html`<div class="row" style="margin-top:6px">${who(t.from)} → ${who(t.to)} <b class="right">${fmtCost(t.cents, st.currency)}</b></div>`)
        : html`<p class="small" style="margin:6px 0">All square</p>`}
      ${st.settle.unpriced > 0 ? html`<p class="small muted" style="margin:6px 0">${st.settle.unpriced} eaten items had no price</p>` : ''}
      <button class="btn alt" data-a="settleUp" ${ui.online ? '' : 'disabled'}>Mark as settled</button>
    </div>
    ${groups.map(g => html`
      <div class="card" id="week-${g.period}">
        <div class="row" style="align-items:center;gap:8px;flex-wrap:wrap">
          <div>
            <b>${g.period}</b> <span class="small muted">${g.label}</span>
          </div>
          <span class="right" style="font-family:'Permanent Marker',cursive;font-size:1.25rem">${fmtCost(g.totalCents, st.currency)}</span>
        </div>
        <div class="row small muted" style="gap:10px;margin:6px 0 10px;flex-wrap:wrap">
          ${st.users.map(u => {
            const c = g.byUser.get(u.id) ?? 0;
            return c > 0 ? html`<span>${u.emoji} ${u.name}: ${fmtCost(c, st.currency)}</span>` : '';
          })}
        </div>
        <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
          ${g.lock
            ? html`<span class="lock-pill">🔒 Locked</span>`
            : html`<button class="btn alt" data-a="lockWeek" data-p="${g.period}" ${ui.online ? '' : 'disabled'}>Lock week</button>`}
          <button class="btn alt" data-a="exportExpenses" data-p="${g.period}" data-fmt="csv">CSV</button>
          <button class="btn alt" data-a="exportExpenses" data-p="${g.period}" data-fmt="json">JSON</button>
        </div>
        ${g.events.length ? html`<div style="margin-top:10px">${g.events.map(e => {
          const u = userOf(st, e);
          const summary = e.note || e.lines.map(l => lineText(st.items, l)).join(', ') || 'Expense';
          return html`<button class="spend-row" id="exp-${e.cid}" data-a="open" data-s="event" data-id="${e.cid}">
            <span>${u?.emoji ?? '🙂'}</span>
            <span class="grow" style="min-width:0"><b class="clip">${summary}</b><span class="small muted">${isoDate(e.at)} · ${clock(e.at)}</span></span>
            <span class="cost">${fmtCost(e.cost_cents ?? 0, st.currency)}</span>
          </button>`;
        })}</div>` : ''}
      </div>
    `)}
  `;
}
