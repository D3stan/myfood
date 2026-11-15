import { daysUntil } from '../../../shared/dates.ts';
import { fmtNum } from '../../../shared/text.ts';
import type { EventLine, FoodEvent, Item, Kind, State } from '../../../shared/types.ts';
import type { Ui } from '../../store.ts';

/** What every screen and sheet is given: the state to show (server + pending) and the ui bits. */
export interface V { st: State; ui: Ui }

export const VERB: Record<Kind, string> = { eat: 'ate', buy: 'bought', adjust: 'set' };

export const levelName = (n: number): string => (n >= 1 ? 'full' : n >= 0.5 ? 'half' : n > 0 ? 'low' : 'out');
/** One tap of a stepper. Level items move a quarter at a time. */
export const stepOf = (it: Item): number => (it.unit === 'level' ? 0.25 : it.step);
export const unitOf = (it: Item): string => (it.unit === 'level' ? '' : it.unit);
export const amount = (it: Item | undefined, q: number): string => (it?.unit === 'level' ? levelName(q) : fmtNum(q));

/** "🥚 3": what a line says, whatever its sign. */
export const lineText = (items: Item[], l: EventLine): string => {
  const it = items.find(i => i.id === l.item_id);
  return `${it?.emoji ?? '❔'} ${amount(it, l.is_set ? l.qty : Math.abs(l.qty))}`;
};

export const userOf = (st: State, ev: FoodEvent) => st.users.find(u => u.id === ev.user_id);
export const ownerOf = (st: State, ownerId: number | null) => (ownerId == null ? undefined : st.users.find(u => u.id === ownerId));
export const clock = (t: number): string => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function expiryLabel(expiresAt: string | null, now: number | Date = Date.now()): string | null {
  if (!expiresAt) return null;
  const d = daysUntil(expiresAt, now);
  if (!Number.isFinite(d)) return null;
  if (d < 0) return 'Expired';
  if (d === 0) return 'Today';
  return `${d}d`;
}

const pad = (n: number): string => String(n).padStart(2, '0');
export const hourToTime = (h: number): string => { const m = Math.round(h * 60) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
export const timeToHour = (t: string): number => { const [h, m] = t.split(':').map(Number); return (h ?? 0) + (m ?? 0) / 60; };
