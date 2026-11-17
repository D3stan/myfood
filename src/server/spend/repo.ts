import { isoDate, isoWeek, weekRange } from '../../shared/dates.ts';
import type { ExpenseBody, LockPeriodBody, Source } from '../../shared/types.ts';
import { all, bumpRev, get, getMeta, run, transaction } from '../db.ts';
import type { Db } from '../db.ts';
import { assertPeriodUnlocked, fail, insertEvent } from '../domain.ts';

export function addExpense(db: Db, userId: number, body: ExpenseBody, now: number): void {
  transaction(db, () => {
    if (get(db, 'SELECT 1 FROM events WHERE cid = ?', body.cid)) return;
    const at = Math.min(body.at, now);
    assertPeriodUnlocked(db, at);
    insertEvent(db, {
      cid: body.cid,
      userId,
      at,
      kind: 'buy',
      source: 'expense',
      note: body.note || null,
      presetId: null,
      jobId: null,
      costCents: body.cost_cents,
      countsNutrition: false,
      lines: [],
    });
    bumpRev(db);
  });
}

export function lockExpensePeriod(db: Db, userId: number, body: LockPeriodBody, now: number): void {
  const range = weekRange(body.period);
  if (!range) fail(400, 'Invalid ISO week');
  transaction(db, () => {
    if (get(db, 'SELECT 1 FROM expense_locks WHERE period = ?', body.period)) {
      fail(409, `Week ${body.period} is already locked`);
    }
    const agg = get<{ total_cents: number; event_count: number }>(
      db,
      `SELECT COALESCE(SUM(cost_cents), 0) AS total_cents, COUNT(*) AS event_count
       FROM events WHERE undone_at IS NULL AND cost_cents IS NOT NULL AND at >= ? AND at < ?`,
      range.start,
      range.end,
    )!;
    run(
      db,
      'INSERT INTO expense_locks(period, locked_by, locked_at, total_cents, event_count, note) VALUES (?, ?, ?, ?, ?, ?)',
      body.period,
      userId,
      now,
      agg.total_cents,
      agg.event_count,
      body.note ?? null,
    );
    bumpRev(db);
  });
}

function csvCell(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function exportExpenses(
  db: Db,
  opts: { period?: string; format: 'csv' | 'json' },
): { contentType: string; filename: string; body: string } {
  const currency = getMeta(db, 'currency') ?? 'kr';
  let rows: { cid: string; at: number; user_id: number; user_name: string; source: Source; note: string | null; cost_cents: number }[];
  if (opts.period) {
    const range = weekRange(opts.period);
    if (!range) fail(400, 'Invalid ISO week');
    rows = all(
      db,
      `SELECT e.cid, e.at, e.user_id, u.name AS user_name, e.source, e.note, e.cost_cents
       FROM events e JOIN users u ON u.id = e.user_id
       WHERE e.undone_at IS NULL AND e.cost_cents IS NOT NULL AND e.at >= ? AND e.at < ?
       ORDER BY e.at DESC, e.seq DESC`,
      range.start,
      range.end,
    );
  } else {
    rows = all(
      db,
      `SELECT e.cid, e.at, e.user_id, u.name AS user_name, e.source, e.note, e.cost_cents
       FROM events e JOIN users u ON u.id = e.user_id
       WHERE e.undone_at IS NULL AND e.cost_cents IS NOT NULL
       ORDER BY e.at DESC, e.seq DESC`,
    );
  }

  const enriched = rows.map(r => {
    const items = all<{ name: string }>(
      db,
      'SELECT i.name FROM event_lines l JOIN items i ON i.id = l.item_id WHERE l.event_cid = ? ORDER BY l.rowid',
      r.cid,
    ).map(x => x.name);
    return {
      cid: r.cid,
      date: isoDate(r.at),
      week: isoWeek(r.at),
      at: r.at,
      user_id: r.user_id,
      user: r.user_name,
      source: r.source,
      note: r.note,
      items,
      cost_cents: r.cost_cents,
      amount: (r.cost_cents / 100).toFixed(2),
      currency,
    };
  });

  const tag = opts.period ?? 'all';
  if (opts.format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      filename: `myfood-expenses-${tag}.json`,
      body: JSON.stringify({ period: tag, currency, expenses: enriched }, null, 2),
    };
  }

  const header = 'date,week,user,source,note,items,cost_cents,amount,currency';
  const lines = enriched.map(r =>
    [r.date, r.week, r.user, r.source, r.note ?? '', r.items.join('; '), r.cost_cents, r.amount, r.currency]
      .map(csvCell)
      .join(','),
  );
  return {
    contentType: 'text/csv; charset=utf-8',
    filename: `myfood-expenses-${tag}.csv`,
    body: [header, ...lines].join('\n'),
  };
}
