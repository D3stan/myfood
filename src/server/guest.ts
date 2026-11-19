// Guest view: GET /guest shows the shared pantry, read-only, to anyone holding the household guest passcode.
//
// WHERE TO GET THE PASSCODE (signed-in people only): Me tab -> "Guest access" card (with a New code button).
// Or on the server: it is printed once in the app log at start-up (Dokploy app logs, search "guest code"),
// or read it with:
//   node -e "const {DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync('/var/lib/myfood/myfood.db').prepare(\"SELECT value FROM meta WHERE key='guest_code'\").get().value)"
// Guests see shared items only (never personal ones, prices, events or names). A new code logs every guest out.
import { randomInt } from 'node:crypto';
import { CATEGORIES } from '../shared/types.ts';
import type { Category, Unit } from '../shared/types.ts';
import { daysUntil } from '../shared/dates.ts';
import { levelLabel, shown } from '../shared/stock.ts';
import { sha256 } from './auth.ts';
import { all, getMeta, setMeta } from './db.ts';
import type { Db } from './db.ts';
import { allStock } from './domain.ts';

const KEY = 'guest_code';
// No 0/o/1/l/i: it gets read out loud and typed on a phone.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const makeCode = (): string => {
  const c = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${c.slice(0, 4)}-${c.slice(4)}`;
};

/** The current guest passcode; created on first use. */
export function guestCode(db: Db): string {
  const cur = getMeta(db, KEY);
  if (cur) return cur;
  const code = makeCode();
  setMeta(db, KEY, code);
  return code;
}

export function regenerateGuestCode(db: Db): string {
  const code = makeCode();
  setMeta(db, KEY, code);
  return code;
}

export const guestCodeMatches = (db: Db, typed: string): boolean => norm(typed) === norm(guestCode(db));
/** The cookie value: changes when the code changes, so a new code ends every guest session. */
export const guestToken = (db: Db): string => sha256(`guest:${norm(guestCode(db))}`);

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const CSS = `
:root{--ink:#1d1a16;--paper:#ece2c6;--card:#fbf5e4;--muted:#5d5446;--red:#d9412b;--gold:#f2b632;--green:#2e7d3a}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:18px/1.35 "Patrick Hand",system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:max(14px,env(safe-area-inset-top)) 14px 40px}
h1{font-size:1.8rem;margin:10px 0 4px}h2{font-size:1.1rem;margin:22px 0 8px;text-transform:capitalize}
.card,form{background:var(--card);border:3px solid var(--ink);box-shadow:3px 3px 0 var(--ink);padding:10px 12px;margin-bottom:10px}
.row{display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px dashed #0003}.row:last-child{border:0}
.row .e{font-size:1.5rem}.row .n{flex:1}.muted{color:var(--muted)}.out{opacity:.5}
.tag{font-size:.8rem;border:2px solid var(--ink);padding:0 6px;background:var(--gold);margin-left:6px}.tag.red{background:#f6cfc4}
input{font:inherit;width:100%;padding:10px;border:3px solid var(--ink);background:#fff;margin:8px 0}
button{font:inherit;padding:10px 16px;border:3px solid var(--ink);background:var(--gold);box-shadow:3px 3px 0 var(--ink);cursor:pointer}
.err{color:var(--red);font-weight:700}`;

const shell = (body: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="robots" content="noindex">
<title>MyFood guest</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;

export const guestLoginPage = (error?: string): string => shell(`
<h1>🥫 MyFood</h1><p class="muted">Enter the guest passcode to see what's in the pantry.</p>
<form method="post" action="/guest"><label for="code">Passcode</label>
<input id="code" name="code" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" autofocus required>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}<button type="submit">View pantry</button></form>`);

const amount = (stock: number, unit: Unit): string => {
  const n = shown(stock);
  if (unit === 'level') return levelLabel(n);
  return `${Math.round(n * 100) / 100} ${unit}`;
};

interface Row { name: string; emoji: string; category: Category; unit: Unit; low_at: number | null; expires_at: string | null }

export function guestPage(db: Db, now: number): string {
  const stock = allStock(db);
  const rows = all<Row & { id: number }>(
    db,
    'SELECT id, name, emoji, category, unit, low_at, expires_at FROM items WHERE archived_at IS NULL AND owner_id IS NULL',
  );
  const groups = CATEGORIES.map(cat => {
    const items = rows.filter(r => r.category === cat).sort((a, b) => a.name.localeCompare(b.name));
    const lines = items.map(r => {
      const s = stock.get(r.id) ?? 0, n = shown(s);
      const days = r.expires_at && n > 0 ? daysUntil(r.expires_at, now) : null;
      const tags = [
        n === 0 ? '' : n <= (r.low_at ?? 0) ? '<span class="tag">low</span>' : '',
        days != null && days <= 3 ? `<span class="tag red">${days < 0 ? 'expired' : days === 0 ? 'expires today' : `${days}d left`}</span>` : '',
      ].join('');
      return `<div class="row${n === 0 ? ' out' : ''}"><span class="e">${esc(r.emoji)}</span><span class="n">${esc(r.name)}${tags}</span><span class="muted">${esc(amount(s, r.unit))}</span></div>`;
    }).join('');
    return items.length ? `<h2>${cat}</h2><div class="card">${lines}</div>` : '';
  }).join('');
  return shell(`<h1>🥫 What's in the pantry</h1><p class="muted">Shared items, read-only.</p>${groups || '<p class="muted">Nothing here yet.</p>'}`);
}
