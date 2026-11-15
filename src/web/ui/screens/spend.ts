import { html } from '../../html.ts';
import { isoDate, isoWeek, weekRange } from '../../../shared/dates.ts';
import { fmtCost } from '../../../shared/text.ts';
import type { ExpenseLock, FoodEvent } from '../../../shared/types.ts';
import { clock, lineText, userOf } from '../components/bits.ts';
import type { V } from '../components/bits.ts';

interface WeekGroup {
  period: string;
  label: string;
  totalCents: number;
  byUser: Map<number, number>;
  events: FoodEvent[];
  lock?: ExpenseLock;
}

function groupExpensesByWeek(expenses: FoodEvent[], locks: ExpenseLock[], now: number | Date): WeekGroup[] {
  const lockMap = new Map(locks.map(l => [l.period, l]));
  const map = new Map<string, WeekGroup>();
  const ensure = (period: string): WeekGroup => {
    let g = map.get(period);
    if (!g) {
      g = {
        period,
        label: weekRange(period)?.label ?? period,
        totalCents: 0,
        byUser: new Map(),
        events: [],
        lock: lockMap.get(period),
      };
      map.set(period, g);
    }
    return g;
  };
  for (const e of [...expenses].sort((a, b) => b.at - a.at)) {
    const cents = e.cost_cents ?? 0;
    if (cents <= 0) continue;
    const g = ensure(isoWeek(e.at));
    g.totalCents += cents;
    g.byUser.set(e.user_id, (g.byUser.get(e.user_id) ?? 0) + cents);
    g.events.push(e);
  }
  for (const l of locks) {
    const g = ensure(l.period);
    if (!g.events.length && l.total_cents > 0) g.totalCents = l.total_cents;
  }
  if (!map.size) ensure(isoWeek(now));
  return [...map.values()].sort((a, b) => b.period.localeCompare(a.period));
}

export function spend(v: V, now: number | Date = new Date()) {
  const { st, ui } = v;
  const nowMs = now instanceof Date ? now.getTime() : now;
  const groups = groupExpensesByWeek(st.expenses, st.expense_locks, nowMs);
  const hasAny = st.expenses.some(e => (e.cost_cents ?? 0) > 0) || st.expense_locks.length > 0;

  return html`
    <div class="top">
      <h1 style="margin:0">Spend</h1>
      <button class="btn right" data-a="open" data-s="expense">+ Log expense</button>
    </div>
    ${hasAny ? '' : html`<p class="note">No expenses logged yet. Tap "+ Log expense" or scan a receipt with prices.</p>`}
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
            <span class="grow clip"><b>${summary}</b> <span class="small muted">${isoDate(e.at)} · ${clock(e.at)}</span></span>
            <span class="cost">${fmtCost(e.cost_cents ?? 0, st.currency)}</span>
          </button>`;
        })}</div>` : ''}
      </div>
    `)}
  `;
}
