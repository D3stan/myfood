import { aliasKey, nameKey } from '../shared/text.ts';
import type { BarcodeLookup, BarcodeProduct, Category, Unit } from '../shared/types.ts';
import type { Db } from './db.ts';
import { all, bumpRev, get, getMeta, run, transaction } from './db.ts';
import { fail } from './domain.ts';

export interface BarcodeLookupOptions {
  country?: string | null;
  forceRefresh?: boolean;
}

export type BarcodeLookupFn = (code: string, opts?: BarcodeLookupOptions) => Promise<BarcodeProduct | null>;

const BARCODE_RE = /^\d{6,14}$/;
const COUNTRY_RE = /^[a-z]{2}$/;
const INCOMPLETE_TTL_MS = 24 * 60 * 60 * 1000;
const COMPLETE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OFF_TIMEOUT_MS = 5000;

const COUNTRY_LANG: Record<string, string> = {
  dk: 'da', se: 'sv', no: 'nb', fi: 'fi',
  de: 'de', at: 'de', ch: 'de',
  it: 'it', fr: 'fr', es: 'es', pt: 'pt', nl: 'nl', be: 'fr', pl: 'pl',
  gb: 'en', uk: 'en', us: 'en', ie: 'en', ca: 'en', au: 'en', nz: 'en',
};

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.trim().replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function boundNum(v: unknown, max: number): number | null {
  const n = num(v);
  return n != null && n >= 0 && n <= max ? n : null;
}

export function normalizeCountry(raw: string | null | undefined): string | null {
  const c = (raw ?? '').trim().toLowerCase();
  if (!COUNTRY_RE.test(c)) return null;
  return c === 'uk' ? 'gb' : c;
}

function toBaseAmount(value: number, unitRaw: string): { unit: 'g' | 'ml'; amount: number } | null {
  const u = unitRaw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!(value > 0)) return null;
  if (u === 'kg') return { unit: 'g', amount: round3(value * 1000) };
  if (u === 'g') return { unit: 'g', amount: round3(value) };
  if (u === 'oz') return { unit: 'g', amount: round3(value * 28.3495) };
  if (u === 'lb') return { unit: 'g', amount: round3(value * 453.592) };
  if (u === 'l') return { unit: 'ml', amount: round3(value * 1000) };
  if (u === 'dl') return { unit: 'ml', amount: round3(value * 100) };
  if (u === 'cl') return { unit: 'ml', amount: round3(value * 10) };
  if (u === 'ml') return { unit: 'ml', amount: round3(value) };
  if (u === 'fl oz' || u === 'fl. oz') return { unit: 'ml', amount: round3(value * 29.5735) };
  return null;
}

const QTY_UNIT_RE = '(fl\\.?\\s*oz|kg|g|ml|cl|dl|l|oz|lb)';
const MULTI_QTY_RE = new RegExp(`(\\d+)\\s*[x×*]\\s*(\\d+(?:[.,]\\d+)?)\\s*${QTY_UNIT_RE}(?:e\\b|\\b)`, 'i');
const SINGLE_QTY_RE = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${QTY_UNIT_RE}(?:e\\b|\\b)`, 'i');

function parseQuantity(p: Record<string, unknown>): { unit: Unit; pack_size: number; explicit: boolean } {
  const pq = num(p.product_quantity);
  const pqu = str(p.product_quantity_unit);
  if (pq && pq > 0 && pqu) {
    const base = toBaseAmount(pq, pqu);
    if (base) return { unit: base.unit, pack_size: base.amount, explicit: true };
  }

  const raw = str(p.quantity)?.toLowerCase() ?? '';
  const multi = MULTI_QTY_RE.exec(raw);
  if (multi) {
    const count = Number(multi[1]);
    const each = Number(multi[2]!.replace(',', '.'));
    const base = toBaseAmount(count * each, multi[3]!);
    if (base) return { unit: base.unit, pack_size: base.amount, explicit: true };
  }

  const single = SINGLE_QTY_RE.exec(raw);
  if (single) {
    const q = Number(single[1]!.replace(',', '.'));
    const base = toBaseAmount(q, single[2]!);
    if (base) return { unit: base.unit, pack_size: base.amount, explicit: true };
  }

  const pieces = /(\d+)\s*(pcs?|stk\.?|pieces?|slices?|skiver|pack)\b/i.exec(raw);
  if (pieces && Number(pieces[1]) > 0) {
    const u = pieces[2]!.toLowerCase();
    return {
      unit: u.startsWith('slice') || u.startsWith('skive') ? 'slice' : 'pc',
      pack_size: Number(pieces[1]),
      explicit: true,
    };
  }

  return { unit: 'pc', pack_size: 1, explicit: false };
}

function parseServingQty(p: Record<string, unknown>): number | null {
  const sq = num(p.serving_quantity);
  if (sq && sq > 0) {
    const squ = str(p.serving_quantity_unit);
    if (!squ) return sq;
    const base = toBaseAmount(sq, squ);
    if (base) return base.amount;
  }
  const raw = str(p.serving_size);
  if (!raw) return null;
  const m = SINGLE_QTY_RE.exec(raw);
  if (!m) return null;
  const base = toBaseAmount(Number(m[1]!.replace(',', '.')), m[2]!);
  return base ? base.amount : null;
}

function inferCategory(tags: unknown, text?: string | null): Category {
  const parts: string[] = [];
  if (Array.isArray(tags)) parts.push(...tags.map(t => String(t).toLowerCase()));
  if (text) parts.push(text.toLowerCase());
  if (!parts.length) return 'pantry';
  const joined = parts.join(' ');
  if (/meal|ready-meal|prepared|pizza|soup|færdigret/.test(joined)) return 'meals';
  if (/dairy|milk|cheese|yogurt|butter|egg|mejeri|mælk|ost|skyr|smør|fløde|æg/.test(joined)) return 'dairy';
  if (/meat|poultry|beef|pork|chicken|fish|seafood|bacon|sausage|kød|kylling|okse|svin|fisk|laks|pølse/.test(joined)) return 'meat';
  if (/bread|bakery|pastry|bun|croissant|brød|bageri|bolle|rugbrød/.test(joined)) return 'bakery';
  if (/fruit|vegetable|produce|salad|tomato|apple|banana|frugt|grønt|salat|tomat|æble|banan/.test(joined)) return 'produce';
  if (/frozen|ice-cream|frossen|frost|dybfrost/.test(joined)) return 'frozen';
  if (/spice|herb|seasoning|salt|pepper|sauce|condiment|oil|vinegar|krydderi|olie|eddike/.test(joined)) return 'spices';
  if (/beverage|drink|juice|soda|coffee|tea|water|beer|wine|drik|sodavand|kaffe|te|øl|vin|vand/.test(joined)) return 'drinks';
  return 'pantry';
}

function parseOffProduct(code: string, p: Record<string, unknown>, lang: string | null): BarcodeProduct {
  const product_name = (lang && lang !== 'en'
    ? (str(p[`product_name_${lang}`]) ?? str(p.product_name) ?? str(p.product_name_en) ?? str(p[`generic_name_${lang}`]) ?? str(p.generic_name) ?? str(p.generic_name_en))
    : (str(p.product_name_en) ?? str(p.product_name) ?? str(p.generic_name_en) ?? str(p.generic_name))) ?? null;
  const brand = str(p.brands)?.split(',')[0]?.trim() || null;
  const category = inferCategory(p.categories_tags, str(p.categories));
  const qty = parseQuantity(p);

  const nut = (p.nutriments && typeof p.nutriments === 'object' ? p.nutriments : {}) as Record<string, unknown>;
  const dataPer = str(p.nutrition_data_per)?.toLowerCase();
  const valueIsPer100 = dataPer === '100g' || dataPer === '100ml' || dataPer == null;

  const macro100 = (base: string): number | null => {
    const direct = boundNum(nut[`${base}_100g`], 100);
    if (direct != null) return direct;
    if (!valueIsPer100) return null;
    const val = boundNum(nut[`${base}_value`], 100_000);
    if (val == null) return null;
    const u = str(nut[`${base}_unit`])?.toLowerCase();
    if (u === 'mg') return val / 1000 <= 100 ? round4(val / 1000) : null;
    if (!u || u === 'g') return val <= 100 ? val : null;
    return null;
  };

  const kcal100 = (() => {
    const direct = boundNum(nut['energy-kcal_100g'], 950);
    if (direct != null) return direct;
    if (valueIsPer100) {
      const kcalUnit = str(nut['energy-kcal_unit'])?.toLowerCase();
      const kcalVal = boundNum(nut['energy-kcal_value'], 950);
      if (kcalVal != null && kcalUnit !== 'kj') return kcalVal;
    }
    const kj = boundNum(nut['energy-kj_100g'], 4000) ?? boundNum(nut.energy_100g, 4000);
    return kj != null ? kj / 4.184 : null;
  })();

  const prot100 = macro100('proteins');
  const fat100 = macro100('fat');
  const carbs100 = macro100('carbohydrates');

  const kcalServing = (() => {
    const direct = boundNum(nut['energy-kcal_serving'], 5000);
    if (direct != null) return direct;
    const kj = boundNum(nut['energy-kj_serving'], 21_000) ?? boundNum(nut.energy_serving, 21_000);
    return kj != null ? kj / 4.184 : null;
  })();
  const protServing = boundNum(nut.proteins_serving, 1000);
  const fatServing = boundNum(nut.fat_serving, 1000);
  const carbsServing = boundNum(nut.carbohydrates_serving, 1000);
  const servingQty = parseServingQty(p);

  let { unit, pack_size } = qty;
  const hasPer100 = kcal100 != null || prot100 != null || fat100 != null || carbs100 != null;
  const hasServing = kcalServing != null || protServing != null || fatServing != null || carbsServing != null || (servingQty != null && servingQty > 0);
  // If OFF omitted package quantity but provided per-100g nutrition, keep g/ml instead of dropping macros on a dummy 'pc' unit.
  if (!qty.explicit && unit === 'pc' && hasPer100 && !hasServing) {
    const servingText = str(p.serving_size) ?? '';
    const squ = str(p.serving_quantity_unit)?.toLowerCase() ?? '';
    unit = category === 'drinks' || dataPer === '100ml' || squ === 'ml' || /\b(ml|cl|dl|l)\b/i.test(servingText) ? 'ml' : 'g';
    pack_size = 100;
  }

  let kcal_per_unit: number | null = null;
  let protein_per_unit: number | null = null;
  let fat_per_unit: number | null = null;
  let carbs_per_unit: number | null = null;
  if (unit === 'g' || unit === 'ml') {
    const from100orServing = (v100: number | null, vServ: number | null): number | null => {
      if (v100 != null) return round4(v100 / 100);
      if (vServ != null && servingQty && servingQty > 0) return round4(vServ / servingQty);
      return null;
    };
    kcal_per_unit = from100orServing(kcal100, kcalServing);
    protein_per_unit = from100orServing(prot100, protServing);
    fat_per_unit = from100orServing(fat100, fatServing);
    carbs_per_unit = from100orServing(carbs100, carbsServing);
  } else {
    const fromServingOr100 = (vServ: number | null, v100: number | null): number | null => {
      if (vServ != null) return round3(vServ);
      if (v100 != null && servingQty && servingQty > 0) return round3((v100 * servingQty) / 100);
      return null;
    };
    kcal_per_unit = fromServingOr100(kcalServing, kcal100);
    protein_per_unit = fromServingOr100(protServing, prot100);
    fat_per_unit = fromServingOr100(fatServing, fat100);
    carbs_per_unit = fromServingOr100(carbsServing, carbs100);
  }

  return {
    code,
    product_name,
    brand,
    unit,
    pack_size,
    kcal_per_unit,
    protein_per_unit,
    fat_per_unit,
    carbs_per_unit,
    category,
    source: 'openfoodfacts',
  };
}

const OFF_FIELDS = [
  'code', 'product_name', 'product_name_en', 'generic_name', 'generic_name_en',
  'brands', 'quantity', 'product_quantity', 'product_quantity_unit',
  'serving_quantity', 'serving_quantity_unit', 'serving_size',
  'nutriments', 'nutrition_data_per', 'categories', 'categories_tags',
];

async function fetchOffJson(code: string, country: string | null, lang: string | null): Promise<Record<string, unknown> | null> {
  const fields = lang && lang !== 'en'
    ? [...OFF_FIELDS, `product_name_${lang}`, `generic_name_${lang}`]
    : OFF_FIELDS;
  const params = new URLSearchParams({ fields: fields.join(',') });
  if (country) params.set('cc', country);
  if (lang) params.set('lc', lang);
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?${params.toString()}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(OFF_TIMEOUT_MS),
        headers: { 'User-Agent': 'MyFood/2.0 (https://food.0xpuddu.com)' },
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && attempt === 0) {
          await new Promise(r => setTimeout(r, 150));
          continue;
        }
        return null;
      }
      const data = (await res.json()) as { status?: number; product?: Record<string, unknown> };
      if (data.status !== 1 || !data.product) return null;
      return data.product;
    } catch {
      if (attempt === 0) {
        await new Promise(r => setTimeout(r, 150));
        continue;
      }
      return null;
    }
  }
  return null;
}

export const defaultBarcodeLookup: BarcodeLookupFn = async (
  code: string,
  opts?: BarcodeLookupOptions,
): Promise<BarcodeProduct | null> => {
  const country = normalizeCountry(opts?.country);
  const lang = country ? (COUNTRY_LANG[country] ?? 'en') : null;

  let product = await fetchOffJson(code, country, lang);
  // UPC-A (12 digits) is often indexed in Open Food Facts as zero-padded EAN-13.
  if (!product && code.length === 12) {
    product = await fetchOffJson(`0${code}`, country, lang);
  }
  if (!product) return null;

  return parseOffProduct(code, product, lang);
};

function fuzzyMatchItemId(db: Db, productName: string | null): number | null {
  if (!productName) return null;
  const items = all<{ id: number; name: string; name_key: string; category: Category }>(
    db,
    'SELECT id, name, name_key, category FROM items WHERE archived_at IS NULL ORDER BY id',
  );
  const targetKey = nameKey(productName);
  const exact = items.find(i => i.name_key === targetKey);
  if (exact) return exact.id;

  const targetWords = new Set(aliasKey(productName).split(' ').filter(Boolean));
  let bestId: number | null = null;
  let bestLen = 0;
  for (const item of items) {
    const words = aliasKey(item.name).split(' ').filter(Boolean);
    if (!words.length || item.name_key.length < 3) continue;
    if (words.every(w => targetWords.has(w)) && item.name_key.length > bestLen) {
      bestLen = item.name_key.length;
      bestId = item.id;
    }
  }
  return bestId;
}

interface CachedBarcodeRow {
  code: string;
  item_id: number | null;
  product_name: string | null;
  brand: string | null;
  unit: Unit | null;
  pack_size: number | null;
  kcal_per_unit: number | null;
  protein_per_unit: number | null;
  fat_per_unit: number | null;
  carbs_per_unit: number | null;
  source: 'manual' | 'openfoodfacts';
  raw_json: string | null;
  updated_at: number;
}

function parseRawMeta(rawJson: string | null): { category: Category; country: string | null } {
  if (!rawJson) return { category: 'pantry', country: null };
  try {
    const p = JSON.parse(rawJson) as { category?: Category; _country?: string | null };
    return {
      category: p.category ?? 'pantry',
      country: normalizeCountry(p._country),
    };
  } catch {
    return { category: 'pantry', country: null };
  }
}

export async function resolveBarcode(
  db: Db,
  code: string,
  lookupFn: BarcodeLookupFn = defaultBarcodeLookup,
  now = Date.now(),
  opts?: BarcodeLookupOptions,
): Promise<BarcodeLookup> {
  const cleanCode = code.trim();
  if (!BARCODE_RE.test(cleanCode)) fail(400, 'Barcode must be 6 to 14 digits');

  const country = normalizeCountry(opts?.country ?? getMeta(db, 'country'));

  const cached = get<CachedBarcodeRow>(
    db,
    'SELECT code, item_id, product_name, brand, unit, pack_size, kcal_per_unit, protein_per_unit, fat_per_unit, carbs_per_unit, source, raw_json, updated_at FROM barcodes WHERE code = ?',
    cleanCode,
  );

  let activeItemId: number | null = null;
  if (cached?.item_id != null) {
    const exists = get(db, 'SELECT 1 FROM items WHERE id = ? AND archived_at IS NULL', cached.item_id);
    if (exists) activeItemId = cached.item_id;
    else run(db, 'UPDATE barcodes SET item_id = NULL WHERE code = ?', cleanCode);
  }

  let cachedProduct: BarcodeProduct | null = null;
  if (cached && (cached.product_name || cached.source === 'openfoodfacts')) {
    const meta = parseRawMeta(cached.raw_json);
    cachedProduct = {
      code: cached.code,
      product_name: cached.product_name,
      brand: cached.brand,
      unit: cached.unit ?? 'pc',
      pack_size: cached.pack_size ?? 1,
      kcal_per_unit: cached.kcal_per_unit,
      protein_per_unit: cached.protein_per_unit,
      fat_per_unit: cached.fat_per_unit,
      carbs_per_unit: cached.carbs_per_unit,
      category: meta.category,
      source: cached.source,
    };

    const hasNutrition = cached.kcal_per_unit != null || cached.protein_per_unit != null || cached.fat_per_unit != null || cached.carbs_per_unit != null;
    const ttl = hasNutrition ? COMPLETE_TTL_MS : INCOMPLETE_TTL_MS;
    const age = now - cached.updated_at;
    const countryChanged = meta.country !== country;
    const shouldRefresh = Boolean(opts?.forceRefresh) || countryChanged || age > ttl || age < 0;

    if (!shouldRefresh) {
      const matched = activeItemId ?? fuzzyMatchItemId(db, cachedProduct?.product_name ?? null);
      return { found: !!(cachedProduct || activeItemId), code: cleanCode, item_id: matched, product: cachedProduct };
    }
  }

  let product: BarcodeProduct | null = null;
  try {
    product = await lookupFn(cleanCode, { ...opts, country });
  } catch {
    product = null;
  }

  if (!product) {
    if (cachedProduct || activeItemId != null) {
      const matched = activeItemId ?? fuzzyMatchItemId(db, cachedProduct?.product_name ?? null);
      return { found: !!(cachedProduct || activeItemId != null), code: cleanCode, item_id: matched, product: cachedProduct };
    }
    return { found: false, code: cleanCode, item_id: null, product: null };
  }

  run(
    db,
    `INSERT INTO barcodes(code, item_id, product_name, brand, unit, pack_size, kcal_per_unit, protein_per_unit, fat_per_unit, carbs_per_unit, source, raw_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET
       product_name = excluded.product_name,
       brand = excluded.brand,
       unit = excluded.unit,
       pack_size = excluded.pack_size,
       kcal_per_unit = excluded.kcal_per_unit,
       protein_per_unit = excluded.protein_per_unit,
       fat_per_unit = excluded.fat_per_unit,
       carbs_per_unit = excluded.carbs_per_unit,
       source = excluded.source,
       raw_json = excluded.raw_json,
       updated_at = excluded.updated_at`,
    cleanCode,
    activeItemId,
    product.product_name,
    product.brand,
    product.unit,
    product.pack_size,
    product.kcal_per_unit,
    product.protein_per_unit,
    product.fat_per_unit ?? null,
    product.carbs_per_unit ?? null,
    product.source,
    JSON.stringify({ ...product, _country: country }),
    now,
  );

  const matched = activeItemId ?? fuzzyMatchItemId(db, product.product_name);
  return { found: true, code: cleanCode, item_id: matched, product };
}

export function linkBarcode(db: Db, code: string, itemId: number, now: number): void {
  const cleanCode = code.trim();
  if (!BARCODE_RE.test(cleanCode)) fail(400, 'Barcode must be 6 to 14 digits');
  transaction(db, () => {
    if (!get(db, 'SELECT 1 FROM items WHERE id = ? AND archived_at IS NULL', itemId)) {
      fail(404, 'No such item');
    }
    run(
      db,
      `INSERT INTO barcodes(code, item_id, source, updated_at) VALUES (?, ?, 'manual', ?)
       ON CONFLICT(code) DO UPDATE SET item_id = excluded.item_id, updated_at = excluded.updated_at`,
      cleanCode,
      itemId,
      now,
    );
    bumpRev(db);
  });
}
