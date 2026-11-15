/** Key that makes item names unique: "  Eggs " and "eggs" are the same item. */
export const nameKey = (name: string): string => name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Key for a receipt line: letters and digits only, so spacing and punctuation do not matter. */
export const aliasKey = (raw: string): string =>
  raw.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Parses what people type in a quantity field. Accepts the Danish decimal comma. NaN when it is not a number. */
export const parseNum = (s: string): number => {
  const t = s.trim().replace(',', '.');
  return /^\d+(\.\d+)?$|^\.\d+$/.test(t) ? Number(t) : NaN;
};

/** 1.5 -> "1.5", 3 -> "3", 0.30000000000000004 -> "0.3". */
export const fmtNum = (n: number): string => String(Math.round(n * 100) / 100);

/** Parses currency input ("24,95" or "24.95") into integer cents. NaN when invalid or >2 decimals. */
export function parseCostCents(s: string): number {
  const t = s.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$|^\.\d{1,2}$/.test(t)) return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

/** Formats minor currency units cleanly: 2495 -> "24.95 kr", 10000 -> "100 kr". */
export function fmtCost(cents: number, currency = 'kr'): string {
  const abs = Math.abs(Math.round(cents));
  const sign = cents < 0 ? '-' : '';
  const body = abs % 100 === 0 ? String(abs / 100) : (abs / 100).toFixed(2);
  return currency ? `${sign}${body} ${currency}` : `${sign}${body}`;
}
