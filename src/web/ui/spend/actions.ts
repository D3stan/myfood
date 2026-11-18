// Spend sheet and week actions.
import { addExpense, exportExpensesUrl, lockExpenses, settle } from '../../api.ts';
import { buildDemoExpenseExport } from '../../demo.ts';
import { isoDate, parseIsoDate } from '../../../shared/dates.ts';
import { closeSheet, receive, store as s } from '../../store.ts';
import { afterState, commit, fail, parseOptCostCents, sheet, st, toast } from '../helpers.ts';

export const spendActions: Record<string, (el: HTMLElement) => void | Promise<unknown>> = {
  saveExpense: async () => {
    const sh = sheet(), f = s.ui.f;
    if (sh.busy) return;
    if (!navigator.onLine) return void toast("You're offline");
    const cost_cents = parseOptCostCents(f.expCost);
    if (cost_cents === 'invalid' || !(cost_cents && cost_cents > 0)) return void toast('Enter an amount');
    const dateStr = (f.expDate ?? '').trim();
    const parsedDate = dateStr ? parseIsoDate(dateStr) : null;
    if (dateStr && !parsedDate) return void toast('Check the date');
    const at = parsedDate
      ? (dateStr === isoDate(st().now) ? Date.now() : parsedDate.getTime() + 12 * 3_600_000)
      : Date.now();
    const note = (f.expNote ?? '').trim() || null;
    sh.busy = true; commit();
    try {
      receive(s, await addExpense({ cid: crypto.randomUUID(), at, cost_cents, note }));
      closeSheet(s);
      toast('Expense logged');
      afterState();
    } catch (e) { fail(e); } finally { sh.busy = false; }
  },
  spendScope: el => {
    s.ui.spendScope = el.dataset.v === 'mine' ? 'mine' : 'all';
  },
  lockWeek: async el => {
    const period = el.dataset.p;
    if (!period || !navigator.onLine) return void (period ? toast("You're offline") : null);
    if (!confirm(`Lock expenses for ${period}? Locked weeks cannot be edited.`)) return;
    try { receive(s, await lockExpenses({ period })); toast(`Locked ${period}`); afterState(); } catch (e) { fail(e); }
  },
  settleUp: async () => {
    if (!navigator.onLine) return void toast("You're offline");
    if (!confirm('Mark everything as settled? Balances start again from zero.')) return;
    try { receive(s, await settle()); toast('Settled'); afterState(); } catch (e) { fail(e); }
  },
  exportExpenses: el => {
    const period = el.dataset.p ?? '';
    const format = el.dataset.fmt === 'json' ? 'json' : 'csv';
    const a = document.createElement('a');
    if (s.ui.demo) {
      const out = buildDemoExpenseExport(st(), period, format);
      const url = URL.createObjectURL(new Blob([out.body], { type: out.contentType }));
      a.href = url;
      a.download = out.filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
    const url = exportExpensesUrl(period, format);
    a.href = url;
    a.download = `expenses-${period || 'all'}.${format}`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  },
};
