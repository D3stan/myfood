const pad2 = (n: number): string => String(n).padStart(2, '0');
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const ISO_WEEK_RE = /^\d{4}-W\d{2}$/;

/** Local calendar date as YYYY-MM-DD. */
export function isoDate(ts: number | Date): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Parses YYYY-MM-DD into local midnight Date, or null if invalid. */
export function parseIsoDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, day = Number(m[3]);
  const d = new Date(y, mo, day);
  if (d.getFullYear() !== y || d.getMonth() !== mo || d.getDate() !== day) return null;
  return d;
}

/** Adds calendar days to a YYYY-MM-DD string or timestamp and returns YYYY-MM-DD. */
export function addDays(base: string | number | Date, days: number): string {
  const d = typeof base === 'string'
    ? (parseIsoDate(base) ?? new Date())
    : base instanceof Date ? new Date(base.getFullYear(), base.getMonth(), base.getDate())
    : (() => { const x = new Date(base); return new Date(x.getFullYear(), x.getMonth(), x.getDate()); })();
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

/** Local-midnight bounds of inclusive ISO dates: [from 00:00, day after `to` 00:00). */
export const dayRangeMs = (from: string, to: string): { fromMs: number; toMs: number } =>
  ({ fromMs: parseIsoDate(from)!.getTime(), toMs: parseIsoDate(addDays(to, 1))!.getTime() });

/** Whole local calendar days from `now` until `yyyyMmDd` (negative = expired, 0 = today). */
export function daysUntil(yyyyMmDd: string, now: number | Date = Date.now()): number {
  const target = parseIsoDate(yyyyMmDd);
  if (!target) return Number.POSITIVE_INFINITY;
  const n = now instanceof Date ? now : new Date(now);
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

/** ISO-8601 week string ("YYYY-Www", Monday start) in local time. */
export function isoWeek(ts: number | Date): string {
  const raw = ts instanceof Date ? ts : new Date(ts);
  const d = new Date(raw.getFullYear(), raw.getMonth(), raw.getDate());
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() + 3 - dow);
  const isoYear = d.getFullYear();
  const jan4 = new Date(isoYear, 0, 4);
  const jan4Dow = (jan4.getDay() + 6) % 7;
  const week1Mon = new Date(isoYear, 0, 4 - jan4Dow);
  const week = 1 + Math.round((d.getTime() - week1Mon.getTime()) / 604_800_000);
  return `${isoYear}-W${pad2(week)}`;
}

/** Half-open local ms bounds [start, end) and readable label for an ISO week "YYYY-Www", or null if invalid. */
export function weekRange(period: string): { start: number; end: number; label: string } | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(period);
  if (!m) return null;
  const year = Number(m[1]), week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  const jan4 = new Date(year, 0, 4);
  const jan4Dow = (jan4.getDay() + 6) % 7;
  const mon = new Date(year, 0, 4 - jan4Dow + (week - 1) * 7);
  if (isoWeek(mon) !== period) return null;
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  const nextMon = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 7);
  const fmt = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return { start: mon.getTime(), end: nextMon.getTime(), label: `${fmt(mon)} – ${fmt(sun)}` };
}
