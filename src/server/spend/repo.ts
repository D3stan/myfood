import { DEFAULT_CURRENCY } from '../../shared/currency.ts';
import { dayRangeMs, isoDate, isoWeek, weekRange } from '../../shared/dates.ts';
import type { ExpenseBody, LockPeriodBody, Settle, Source, SpendStats } from '../../shared/types.ts';
import { all, bumpRev, get, getMeta, run, transaction } from '../db.ts';
import type { Db } from '../db.ts';
import { fail } from '../domain.ts';
import { assertPeriodUnlocked, insertEvent } from '../events/repo.ts';
import { dailyNutrition } from '../nutrition/repo.ts';

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

/** Per-day, per-user paid cents and eaten value for the inclusive local dates `from`..`to` (already validated). */
export function spendStats(db: Db, from: string, to: string): SpendStats {
  const { fromMs, toMs } = dayRangeMs(from, to);
  const paid = new Map<string, { day: string; user_id: number; cents: number }>();
  for (const e of all<{ at: number; user_id: number; cost_cents: number }>(
    db,
    'SELECT at, user_id, cost_cents FROM events WHERE undone_at IS NULL AND cost_cents > 0 AND at >= ? AND at < ?',
    fromMs,
    toMs,
  )) {
    const day = isoDate(e.at), key = `${day}:${e.user_id}`;
    const cur = paid.get(key) ?? { day, user_id: e.user_id, cents: 0 };
    cur.cents += e.cost_cents;
    paid.set(key, cur);
  }
  return {
    from,
    to,
    paid: [...paid.values()].sort((a, b) => a.day.localeCompare(b.day) || a.user_id - b.user_id),
    ate: dailyNutrition(db, fromMs, undefined, toMs)
      .filter(d => d.value_cents > 0 || d.unpriced > 0)
      .map(({ day, user_id, value_cents, unpriced }) => ({ day, user_id, value_cents, unpriced }))
      .sort((a, b) => a.day.localeCompare(b.day) || a.user_id - b.user_id),
  };
}

/** Paid and ate per user since the last settlement; the unpriced count tells the UI that "ate" is a lower bound. */
export function settleInfo(db: Db): Settle {
  const since = get<{ at: number | null }>(db, 'SELECT MAX(at) AS at FROM settlements')?.at ?? null;
  const eaten = "e.user_id = u.id AND e.undone_at IS NULL AND e.kind = 'eat' AND e.counts_nutrition = 1 AND l.is_set = 0 AND e.at > ?";
  const from = since ?? 0;
  const balances = all<{ user_id: number; paid_cents: number; ate_cents: number }>(
    db,
    `SELECT u.id AS user_id,
       COALESCE((SELECT SUM(cost_cents) FROM events WHERE user_id = u.id AND undone_at IS NULL AND cost_cents IS NOT NULL AND at > ?), 0) AS paid_cents,
       COALESCE((SELECT SUM(l.value_cents) FROM event_lines l JOIN events e ON e.cid = l.event_cid WHERE ${eaten}), 0) AS ate_cents
     FROM users u ORDER BY u.id`,
    from,
    from,
  ).map(b => ({ ...b, balance_cents: b.paid_cents - b.ate_cents }));
  const unpriced = get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM event_lines l JOIN events e ON e.cid = l.event_cid JOIN users u ON u.id = e.user_id WHERE l.value_cents IS NULL AND ${eaten}`,
    from,
  )!.n;
  return { since, balances, unpriced };
}

/** Balances start at zero afterwards. Independent of week locks. */
export function settleUp(db: Db, userId: number, note: string | null, now: number): void {
  transaction(db, () => {
    run(db, 'INSERT INTO settlements(at, by_user_id, note) VALUES (?, ?, ?)', now, userId, note);
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

export function unlockExpensePeriod(db: Db, period: string): void {
  transaction(db, () => {
    if (!run(db, 'DELETE FROM expense_locks WHERE period = ?', period).changes) fail(404, `Week ${period} is not locked`);
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
  const currency = getMeta(db, 'currency') ?? DEFAULT_CURRENCY;
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
