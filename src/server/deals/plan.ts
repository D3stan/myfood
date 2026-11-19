import { DEFAULT_CURRENCY } from '../../shared/currency.ts';
import { daysUntil, isoDate } from '../../shared/dates.ts';
import { burnRate, campaigns, planTrips, promoCadence, stockUp } from '../../shared/deals.ts';
import type { BurnLine, Need, TripOffer } from '../../shared/deals.ts';
import { isLow } from '../../shared/stock.ts';
import type { Category, DealsPlan, DealsSummary, Kind, PlanItem } from '../../shared/types.ts';
import { all, getMeta } from '../db.ts';
import type { Db } from '../db.ts';
import { allStock } from '../domain.ts';
import { normalPrice } from './repo.ts';

interface Cand { item_id: number; store_id: string; store_name: string; store_emoji: string; title: string; price_cents: number; pre_price_cents: number | null; max_per_customer: number | null; valid_from: string; valid_to: string; qty_per_pack: number; unit_cents: number }

/**
 * The shopping plan, computed from `now` on every call and never stored: a buy changes it at once.
 * Items: not archived, not cooked, not `level`, with a matched live or upcoming offer (enabled store, household currency, known pack size).
 */
export function buildPlan(db: Db, now: number): DealsPlan {
  const today = isoDate(now), currency = getMeta(db, 'currency') ?? DEFAULT_CURRENCY;
  const empty: DealsPlan = { generated_at: now, today, trips: [], items: [], total_saving_cents: 0 };
  const eligible = `JOIN offer_matches m ON m.offer_key = o.offer_key AND m.qty_per_pack > 0
    JOIN items i ON i.id = m.item_id AND i.archived_at IS NULL AND i.is_cooked = 0 AND i.unit <> 'level'`;
  const cands = all<Cand>(db, `
    SELECT m.item_id, o.store_id, s.name AS store_name, s.emoji AS store_emoji, o.title, o.price_cents, o.pre_price_cents, o.max_per_customer, o.valid_from, o.valid_to,
      m.qty_per_pack, o.price_cents * 1.0 / m.qty_per_pack AS unit_cents
    FROM offers o ${eligible} JOIN stores s ON s.id = o.store_id AND s.enabled = 1
    WHERE o.valid_to >= ? AND o.currency = ?`, today, currency);
  if (!cands.length) return empty;

  const ids = [...new Set(cands.map(c => c.item_id))], marks = ids.map(() => '?').join(',');
  const itemRows = new Map(all<{ id: number; name: string; emoji: string; category: Category; low_at: number | null; shelf_life_days: number | null }>(
    db, `SELECT id, name, emoji, category, low_at, shelf_life_days FROM items WHERE id IN (${marks})`, ...ids).map(r => [r.id, r]));
  const lines = new Map<number, BurnLine[]>();
  for (const l of all<{ item_id: number; at: number; qty: number; is_set: number; kind: Kind }>(db, `
    SELECT l.item_id, e.at, l.qty, l.is_set, e.kind FROM event_lines l JOIN events e ON e.cid = l.event_cid
    WHERE e.undone_at IS NULL AND l.item_id IN (${marks}) ORDER BY e.at, e.seq, l.rowid`, ...ids)) {
    (lines.get(l.item_id) ?? lines.set(l.item_id, []).get(l.item_id)!).push({ at: l.at, qty: l.qty, is_set: !!l.is_set, kind: l.kind });
  }
  // Every matched offer ever seen (all stores), for how often the item goes on offer.
  const history = new Map<number, { store_id: string; valid_from: string; valid_to: string; unit_cents: number }[]>();
  for (const h of all<{ item_id: number; store_id: string; valid_from: string; valid_to: string; unit_cents: number }>(db, `
    SELECT m.item_id, o.store_id, o.valid_from, o.valid_to, o.price_cents * 1.0 / m.qty_per_pack AS unit_cents
    FROM offers o ${eligible} WHERE m.item_id IN (${marks}) AND o.currency = ?`, ...ids, currency)) {
    (history.get(h.item_id) ?? history.set(h.item_id, []).get(h.item_id)!).push(h);
  }
  const stock = allStock(db);

  const items: PlanItem[] = [], needs: Need[] = [], tripOffers: TripOffer[] = [];
  const packsOf = new Map<number, number>(), reasonOf = new Map<number, string>();
  for (const id of ids) {
    const it = itemRows.get(id)!, mine = cands.filter(c => c.item_id === id);
    const live = mine.filter(c => c.valid_from <= today);
    const best = (live.length ? live : mine).reduce((b, c) => live.length
      ? (c.unit_cents < b.unit_cents ? c : b)
      : (c.valid_from < b.valid_from || (c.valid_from === b.valid_from && c.unit_cents < b.unit_cents) ? c : b));
    const cheaper = mine.filter(c => c.valid_from > today && c.unit_cents < best.unit_cents).map(c => daysUntil(c.valid_from, now));
    const st = stock.get(id) ?? 0, low = isLow({ stock: st, low_at: it.low_at });
    const rate = burnRate(lines.get(id) ?? [], now);
    const normal = normalPrice(db, id)?.cents_per_unit ?? (best.pre_price_cents ? best.pre_price_cents / best.qty_per_pack : null);
    const cadence = promoCadence(campaigns(history.get(id) ?? []).map(c => c.from), it.category);
    const out = stockUp({
      stock: st, lowAt: it.low_at, rate, normalCents: normal, offerUnitCents: best.unit_cents, qtyPerPack: best.qty_per_pack,
      maxPerCustomer: best.max_per_customer, cadenceDays: cadence, shelfLifeDays: it.shelf_life_days,
      nextCheaperInDays: cheaper.length ? Math.min(...cheaper) : null, currency,
    });
    const packs = out.packs === 0 && low ? 1 : out.packs; // low items always get at least one pack
    const deadlineDay = low ? 0 : rate ? Math.floor((st - (it.low_at ?? 0)) / rate) : null;
    if (packs > 0) needs.push({ item_id: id, deadlineDay, units: packs * best.qty_per_pack, normalCents: normal });
    packsOf.set(id, packs); reasonOf.set(id, out.reason);
    items.push({
      item_id: id, name: it.name, emoji: it.emoji, rate, normal_cents: normal, pct_off: out.pctOff, packs, reason: out.reason, offer_title: best.title,
      store_id: best.store_id, store_name: best.store_name, store_emoji: best.store_emoji, unit_cents: best.unit_cents, valid_from: best.valid_from, valid_to: best.valid_to, on_trip: false,
    });
    if (packs > 0) for (const c of mine) tripOffers.push({ item_id: id, store_id: c.store_id, valid_from: c.valid_from, valid_to: c.valid_to, unit_cents: c.unit_cents });
  }

  const { trips, total_saving_cents } = planTrips({ needs, offers: tripOffers, today });
  const onTrip = new Set(trips.flatMap(t => t.items.map(x => x.item_id)));
  for (const i of items) i.on_trip = onTrip.has(i.item_id);
  items.sort((a, b) => Number(b.on_trip) - Number(a.on_trip) || b.pct_off - a.pct_off || a.name.localeCompare(b.name));
  return {
    generated_at: now, today, total_saving_cents, items,
    trips: trips.map(t => {
      const store = cands.find(c => c.store_id === t.store_id)!;
      return {
        date: t.date, store_id: t.store_id, store_name: store.store_name, store_emoji: store.store_emoji, saving_cents: t.saving_cents,
        items: t.items.map(x => {
          const it = itemRows.get(x.item_id)!;
          // Cheapest live offer at that store on that date: never fails, unlike matching a float unit price.
          const offer = cands.filter(c => c.item_id === x.item_id && c.store_id === t.store_id && c.valid_from <= t.date && t.date <= c.valid_to).reduce((b, c) => c.unit_cents < b.unit_cents ? c : b);
          return {
            item_id: x.item_id, name: it.name, emoji: it.emoji, packs: packsOf.get(x.item_id)!, unit_cents: x.unit_cents, saving_cents: x.saving_cents,
            reason: reasonOf.get(x.item_id)!, offer_title: offer.title, qty_per_pack: offer.qty_per_pack, price_cents: offer.price_cents,
          };
        }),
      };
    }),
  };
}

/** First trip of the plan for `State`; null when there is none. A broken plan must never break the app. */
export function dealsSummary(db: Db, now: number): DealsSummary | null {
  try {
    const t = buildPlan(db, now).trips[0];
    return t ? { date: t.date, store_name: t.store_name, store_emoji: t.store_emoji, saving_cents: t.saving_cents, deal_count: t.items.length } : null;
  } catch (e) {
    console.error('[deals] plan failed:', e instanceof Error ? e.message : e);
    return null;
  }
}
