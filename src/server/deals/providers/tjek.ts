import { aliasKey } from '../../../shared/text.ts';

const BASE = 'https://squid-api.tjek.com/v2';
const PAGE = 100;

export interface Where { lat: number; lng: number; radius: number }
export interface NormCatalog { external_id: string; title: string; valid_from: string; valid_to: string }
export interface NormOffer {
  external_id: string; catalog_external_id: string; title: string; offer_key: string;
  price_cents: number; pre_price_cents: number | null; currency: string;
  unit: 'g' | 'ml' | 'pc' | null; unit_qty: number | null; max_per_customer: number | null;
  ean: string | null; valid_from: string; valid_to: string;
}

const cph = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' });
/** Tjek's "2026-11-20T23:00:00+0000" -> local Copenhagen YYYY-MM-DD. */
export const localDay = (iso: string): string => cph.format(new Date(iso.replace(/([+-]\d\d)(\d\d)$/, '$1:$2')));

const cents = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : null);
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Tjek: unit.si is the SI base (kg, l, pcs) with `factor` from the shown unit; size/pieces are ranges. A range is unknown. */
export function packSize(q: any): { unit: 'g' | 'ml' | 'pc' | null; qty: number | null } {
  const si = q?.unit?.si?.symbol;
  const f = q?.unit?.si?.factor;
  const unit = si === 'kg' ? 'g' : si === 'l' ? 'ml' : si === 'pcs' ? 'pc' : null;
  const { from, to } = q?.size ?? {};
  if (!unit || typeof f !== 'number' || typeof from !== 'number' || from !== to) return { unit: null, qty: null };
  const p = q.pieces ?? {};
  const pieces = p.from == null ? 1 : p.from === p.to ? p.from : NaN;
  if (!(pieces > 0)) return { unit: null, qty: null };
  return { unit, qty: r3(from * f * (unit === 'pc' ? 1 : 1000) * pieces) };
}

export function normaliseOffer(o: any, catalogId: string, fallback: { from: string; to: string }): NormOffer | null {
  const price = cents(o?.pricing?.price);
  if (!o?.id || !o.heading || price == null) return null;
  const { unit, qty } = packSize(o.quantity);
  const max = o.quantity?.pieces?.max;
  return {
    external_id: String(o.id), catalog_external_id: catalogId, title: String(o.heading),
    offer_key: aliasKey(`${o.heading} ${o.quantity?.size?.from ?? ''}${o.quantity?.unit?.symbol ?? ''}`),
    price_cents: price, pre_price_cents: cents(o.pricing.pre_price), currency: String(o.pricing.currency ?? 'DKK'),
    unit, unit_qty: qty, max_per_customer: Number.isInteger(max) && max > 0 ? max : null, ean: null,
    valid_from: o.run_from ? localDay(o.run_from) : fallback.from,
    valid_to: o.run_till ? localDay(o.run_till) : fallback.to,
  };
}

async function getJson(fetchFn: typeof fetch, url: string): Promise<any[]> {
  const res = await fetchFn(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Tjek ${res.status} for ${url.split('?')[0]}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error('Tjek returned an unexpected body');
  return body;
}

/** Catalogs (current and upcoming) of one dealer and every offer in them. */
export async function fetchTjek(
  dealerId: string, where: Where, fetchFn: typeof fetch,
): Promise<{ catalogs: NormCatalog[]; offers: NormOffer[] }> {
  const q = new URLSearchParams({ dealer_ids: dealerId, r_lat: String(where.lat), r_lng: String(where.lng), r_radius: String(where.radius), limit: '20' });
  const catalogs: NormCatalog[] = [];
  const offers: NormOffer[] = [];
  for (const c of await getJson(fetchFn, `${BASE}/catalogs?${q}`)) {
    if (!c?.id || !c.run_from || !c.run_till) continue;
    const cat = { external_id: String(c.id), title: String(c.label ?? c.id), valid_from: localDay(c.run_from), valid_to: localDay(c.run_till) };
    catalogs.push(cat);
    for (let offset = 0; offset < 50 * PAGE; offset += PAGE) { // cap: a misbehaving API must not loop forever
      const page = await getJson(fetchFn, `${BASE}/offers?catalog_ids=${encodeURIComponent(cat.external_id)}&limit=${PAGE}&offset=${offset}`);
      for (const o of page) {
        const n = normaliseOffer(o, cat.external_id, { from: cat.valid_from, to: cat.valid_to });
        if (n) offers.push(n);
      }
      if (page.length < PAGE) break;
    }
  }
  return { catalogs, offers };
}
