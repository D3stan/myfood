import { aliasKey, nameKey } from '../shared/text.ts';
import type { BarcodeLookup, BarcodeProduct, Category, Unit } from '../shared/types.ts';
import type { Db } from './db.ts';
import { all, bumpRev, get, run, transaction } from './db.ts';
import { fail } from './domain.ts';

export type BarcodeLookupFn = (code: string) => Promise<BarcodeProduct | null>;

const BARCODE_RE = /^\d{6,14}$/;
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

function parseQuantity(p: Record<string, unknown>): { unit: Unit; pack_size: number } {
  const pq = num(p.product_quantity);
  const pqu = str(p.product_quantity_unit)?.toLowerCase();
  if (pq && pq > 0 && pqu) {
    if (pqu === 'kg') return { unit: 'g', pack_size: round3(pq * 1000) };
    if (pqu === 'g') return { unit: 'g', pack_size: round3(pq) };
    if (pqu === 'l') return { unit: 'ml', pack_size: round3(pq * 1000) };
    if (pqu === 'dl') return { unit: 'ml', pack_size: round3(pq * 100) };
    if (pqu === 'cl') return { unit: 'ml', pack_size: round3(pq * 10) };
    if (pqu === 'ml') return { unit: 'ml', pack_size: round3(pq) };
  }

  const raw = str(p.quantity)?.toLowerCase() ?? '';
  const multi = /(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|dl|l)\b/.exec(raw);
  if (multi) {
    const count = Number(multi[1]);
    const each = Number(multi[2]!.replace(',', '.'));
    const u = multi[3]!;
    const mult = u === 'kg' || u === 'l' ? 1000 : u === 'dl' ? 100 : u === 'cl' ? 10 : 1;
    return { unit: u === 'kg' || u === 'g' ? 'g' : 'ml', pack_size: round3(count * each * mult) };
  }

  const single = /(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|dl|l)\b/.exec(raw);
  if (single) {
    const q = Number(single[1]!.replace(',', '.'));
    const u = single[2]!;
    const mult = u === 'kg' || u === 'l' ? 1000 : u === 'dl' ? 100 : u === 'cl' ? 10 : 1;
    if (q > 0) return { unit: u === 'kg' || u === 'g' ? 'g' : 'ml', pack_size: round3(q * mult) };
  }

  const pieces = /(\d+)\s*(pcs?|stk|pieces?|slices?|pack)\b/.exec(raw);
  if (pieces && Number(pieces[1]) > 0) {
    return { unit: pieces[2]!.startsWith('slice') ? 'slice' : 'pc', pack_size: Number(pieces[1]) };
  }

  return { unit: 'pc', pack_size: 1 };
}

function inferCategory(tags: unknown): Category {
  if (!Array.isArray(tags)) return 'pantry';
  const joined = tags.map(t => String(t).toLowerCase()).join(' ');
  if (/meal|ready-meal|prepared|pizza|soup/.test(joined)) return 'meals';
  if (/dairy|milk|cheese|yogurt|butter|egg/.test(joined)) return 'dairy';
  if (/meat|poultry|beef|pork|chicken|fish|seafood|bacon|sausage/.test(joined)) return 'meat';
  if (/bread|bakery|pastry|bun|croissant/.test(joined)) return 'bakery';
  if (/fruit|vegetable|produce|salad|tomato|apple|banana/.test(joined)) return 'produce';
  if (/frozen|ice-cream/.test(joined)) return 'frozen';
  if (/spice|herb|seasoning|salt|pepper|sauce|condiment|oil|vinegar/.test(joined)) return 'spices';
  if (/beverage|drink|juice|soda|coffee|tea|water|beer|wine/.test(joined)) return 'drinks';
  return 'pantry';
}

export const defaultBarcodeLookup: BarcodeLookupFn = async (code: string): Promise<BarcodeProduct | null> => {
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(5000),
    headers: { 'User-Agent': 'MyFood/2.0 (https://food.0xpuddu.com)' },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { status?: number; product?: Record<string, unknown> };
  if (data.status !== 1 || !data.product) return null;

  const p = data.product;
  const product_name = str(p.product_name_en) ?? str(p.product_name) ?? str(p.generic_name) ?? null;
  const brand = str(p.brands)?.split(',')[0]?.trim() || null;
  const { unit, pack_size } = parseQuantity(p);

  const nut = (p.nutriments && typeof p.nutriments === 'object' ? p.nutriments : {}) as Record<string, unknown>;
  const kcal100 = num(nut['energy-kcal_100g']) ?? (num(nut.energy_100g) != null ? num(nut.energy_100g)! / 4.184 : null);
  const prot100 = num(nut.proteins_100g);
  const fat100 = num(nut.fat_100g);
  const kcalServing = num(nut['energy-kcal_serving']);
  const protServing = num(nut.proteins_serving);
  const fatServing = num(nut.fat_serving);
  const servingQty = num(p.serving_quantity);

  let kcal_per_unit: number | null = null;
  let protein_per_unit: number | null = null;
  let fat_per_unit: number | null = null;
  if (unit === 'g' || unit === 'ml') {
    if (kcal100 != null) kcal_per_unit = round4(kcal100 / 100);
    if (prot100 != null) protein_per_unit = round4(prot100 / 100);
    if (fat100 != null) fat_per_unit = round4(fat100 / 100);
  } else {
    if (kcalServing != null) kcal_per_unit = round3(kcalServing);
    else if (kcal100 != null && servingQty && servingQty > 0) kcal_per_unit = round3((kcal100 * servingQty) / 100);
    if (protServing != null) protein_per_unit = round3(protServing);
    else if (prot100 != null && servingQty && servingQty > 0) protein_per_unit = round3((prot100 * servingQty) / 100);
    if (fatServing != null) fat_per_unit = round3(fatServing);
    else if (fat100 != null && servingQty && servingQty > 0) fat_per_unit = round3((fat100 * servingQty) / 100);
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
    category: inferCategory(p.categories_tags),
    source: 'openfoodfacts',
  };
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
  source: 'manual' | 'openfoodfacts';
  raw_json: string | null;
}

export async function resolveBarcode(
  db: Db,
  code: string,
  lookupFn: BarcodeLookupFn = defaultBarcodeLookup,
  now = Date.now(),
): Promise<BarcodeLookup> {
  const cleanCode = code.trim();
  if (!BARCODE_RE.test(cleanCode)) fail(400, 'Barcode must be 6 to 14 digits');

  const cached = get<CachedBarcodeRow>(
    db,
    'SELECT code, item_id, product_name, brand, unit, pack_size, kcal_per_unit, protein_per_unit, fat_per_unit, source, raw_json FROM barcodes WHERE code = ?',
    cleanCode,
  );

  let activeItemId: number | null = null;
  if (cached?.item_id != null) {
    const exists = get(db, 'SELECT 1 FROM items WHERE id = ? AND archived_at IS NULL', cached.item_id);
    if (exists) activeItemId = cached.item_id;
    else run(db, 'UPDATE barcodes SET item_id = NULL WHERE code = ?', cleanCode);
  }

  if (cached && (cached.product_name || cached.source === 'openfoodfacts')) {
    const parsedCategory = (() => {
      if (!cached.raw_json) return 'pantry' as Category;
      try {
        const p = JSON.parse(cached.raw_json) as { category?: Category };
        return p.category ?? 'pantry';
      } catch {
        return 'pantry' as Category;
      }
    })();
    const product: BarcodeProduct | null = cached.product_name
      ? {
          code: cached.code,
          product_name: cached.product_name,
          brand: cached.brand,
          unit: cached.unit ?? 'pc',
          pack_size: cached.pack_size ?? 1,
          kcal_per_unit: cached.kcal_per_unit,
          protein_per_unit: cached.protein_per_unit,
          fat_per_unit: cached.fat_per_unit,
          category: parsedCategory,
          source: cached.source,
        }
      : null;
    const matched = activeItemId ?? fuzzyMatchItemId(db, product?.product_name ?? null);
    return { found: !!(product || activeItemId), code: cleanCode, item_id: matched, product };
  }

  let product: BarcodeProduct | null = null;
  try {
    product = await lookupFn(cleanCode);
  } catch {
    product = null;
  }

  if (!product) {
    return { found: activeItemId != null, code: cleanCode, item_id: activeItemId, product: null };
  }

  run(
    db,
    `INSERT INTO barcodes(code, item_id, product_name, brand, unit, pack_size, kcal_per_unit, protein_per_unit, fat_per_unit, source, raw_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET
       product_name = excluded.product_name,
       brand = excluded.brand,
       unit = excluded.unit,
       pack_size = excluded.pack_size,
       kcal_per_unit = excluded.kcal_per_unit,
       protein_per_unit = excluded.protein_per_unit,
       fat_per_unit = excluded.fat_per_unit,
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
    product.source,
    JSON.stringify(product),
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
