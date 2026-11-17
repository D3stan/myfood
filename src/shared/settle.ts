export interface Transfer { from: number; to: number; cents: number }

/** Greedy: the biggest debtor pays the biggest creditor until one side runs out. Balances = paid - ate, so they need not sum to 0; any leftover stays unsettled (food bought but not yet eaten). */
export function settleTransfers(balances: { user_id: number; balance_cents: number }[]): Transfer[] {
  const owed = balances.map(b => ({ id: b.user_id, c: Math.round(b.balance_cents) }));
  const out: Transfer[] = [];
  while (owed.length) {
    const cred = owed.reduce((a, b) => (b.c > a.c ? b : a));
    const debt = owed.reduce((a, b) => (b.c < a.c ? b : a));
    const cents = Math.min(cred.c, -debt.c);
    if (!(cents > 0)) break;
    out.push({ from: debt.id, to: cred.id, cents });
    cred.c -= cents;
    debt.c += cents;
  }
  return out;
}
