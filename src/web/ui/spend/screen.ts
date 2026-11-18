import { html } from '../../html.ts';
import { isoDate, isoWeek, parseIsoDate, weekRange } from '../../../shared/dates.ts';
import { computeDailyNutrition } from '../../../shared/nutrition.ts';
import { frameNav, periodRange } from '../../../shared/period.ts';
import { fmtCost } from '../../../shared/text.ts';
import type { ExpenseLock, FoodEvent } from '../../../shared/types.ts';
import { clock, lineText, userOf } from '../components/bits.ts';
import type { V } from '../components/bits.ts';
import { COLORS, barChart } from '../components/chart.ts';
import { frameBar, frameOf } from '../components/frame.ts';

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
  const fr = frameOf(ui, 'spend'), range = periodRange(fr.frame, fr.offset, nowMs), nav = frameNav(fr.frame, fr.offset, nowMs);
  const inFrame = new Set(range.days);
  const mineOnly = ui.spendScope === 'mine';
  const paid = st.expenses.filter(e => (e.cost_cents ?? 0) > 0 && inFrame.has(isoDate(e.at)));
  const shown = mineOnly ? paid.filter(e => e.user_id === st.me.id) : paid;
  const weeks = new Set(range.days.map(d => isoWeek(parseIsoDate(d)!)));
  const groups = groupExpensesByWeek(st.expenses.filter(e => !mineOnly || e.user_id === st.me.id), st.expense_locks, nowMs)
    .filter(g => weeks.has(g.period));
  const total = paid.reduce((a, e) => a + e.cost_cents!, 0);
  const ate = computeDailyNutrition(st.events, st.items, st.daily_nutrition).filter(d => inFrame.has(d.day));
  const paidBy = (id: number) => paid.filter(e => e.user_id === id).reduce((a, e) => a + e.cost_cents!, 0);
  // month = one bar per day (about 8 labels): simpler than ISO-week buckets
  const bars = range.days.map((d, i) => ({
    label: fr.frame === 'week' ? 'MTWTFSS'[i]! : String(i + 1),
    values: st.users.map(u => shown.filter(e => e.user_id === u.id && isoDate(e.at) === d).reduce((a, e) => a + e.cost_cents!, 0)),
  }));
  const hasAny = st.expenses.some(e => (e.cost_cents ?? 0) > 0) || st.expense_locks.length > 0;

  return html`
    <div class="top">
      <h1 style="margin:0">Spend</h1>
      <button class="btn right" data-a="open" data-s="expense">+ Log expense</button>
    </div>
    ${hasAny ? '' : html`<p class="note">No expenses logged yet. Tap "+ Log expense" or scan a receipt with prices.</p>`}
    ${frameBar('spend', fr.frame, fr.offset, range.label, nav.canPrev, nav.partial)}
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
        return html`<div class="row" id="spend-user-${u.id}" style="margin-top:6px;flex-wrap:wrap">
          <span class="grow">${u.emoji} ${u.name}</span>
          <span>paid ${fmtCost(p, st.currency)}${total > 0 ? ` (${Math.round((p / total) * 100)}%)` : ''}</span>
          <span>· ate ${fmtCost(mine.reduce((a, d) => a + d.value_cents, 0), st.currency)}${unpriced > 0 ? html` <span class="small muted">+${unpriced} unpriced</span>` : ''}</span>
        </div>`;
      })}</div>
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
