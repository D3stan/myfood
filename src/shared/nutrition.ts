import { isoDate } from './dates.ts';
import type { DailyNutrition, EventLine, FoodEvent, Item } from './types.ts';

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Sums two optional amounts: null (unknown) only when both are unknown, never 0. */
export const addKnown = (a: number | null | undefined, b: number | null | undefined): number | null =>
  a == null ? (b ?? null) : b == null ? a : a + b;

type Macros = { kcal: number; protein_g: number; fat_g: number; carbs_g: number | null };
type Rates = 'kcal_per_unit' | 'protein_per_unit' | 'fat_per_unit' | 'carbs_per_unit';

/** Calories, protein, fat and carbs for one event line (explicit snapshot first, else item rate). */
export function eventLineNutrition(
  line: EventLine,
  item?: Partial<Pick<Item, Rates>>,
): Macros {
  if (line.is_set) return { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: null };
  const q = Math.abs(line.qty);
  const kcal = line.kcal != null ? line.kcal : (item?.kcal_per_unit != null ? q * item.kcal_per_unit : 0);
  const protein_g = line.protein_g != null ? line.protein_g : (item?.protein_per_unit != null ? q * item.protein_per_unit : 0);
  const fat_g = line.fat_g != null ? line.fat_g : (item?.fat_per_unit != null ? q * item.fat_per_unit : 0);
  const carbs = line.carbs_g != null ? line.carbs_g : (item?.carbs_per_unit != null ? q * item.carbs_per_unit : null);
  return { kcal: Math.round(kcal), protein_g: round1(protein_g), fat_g: round1(fat_g), carbs_g: carbs == null ? null : round1(carbs) };
}

/** Calories, protein, fat and carbs contributed by an event (only non-cook eat events count). */
export function eventNutrition(
  ev: Pick<FoodEvent, 'kind' | 'counts_nutrition' | 'lines'>,
  items: (Pick<Item, 'id'> & Partial<Pick<Item, Rates>>)[],
): Macros {
  if (ev.kind !== 'eat' || !ev.counts_nutrition) return { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: null };
  const byId = new Map(items.map(i => [i.id, i]));
  let kcal = 0, protein_g = 0, fat_g = 0;
  let carbs_g: number | null = null;
  for (const l of ev.lines) {
    const n = eventLineNutrition(l, byId.get(l.item_id));
    kcal += n.kcal;
    protein_g += n.protein_g;
    fat_g += n.fat_g;
    carbs_g = addKnown(carbs_g, n.carbs_g);
  }
  return { kcal: Math.round(kcal), protein_g: round1(protein_g), fat_g: round1(fat_g), carbs_g: carbs_g == null ? null : round1(carbs_g) };
}

/** Value of an eat event's lines (qty x item price, same rounding as the server snapshot); lines with no price are counted as unpriced, lines with no kcal as no_kcal. */
export function eventValue(
  ev: Pick<FoodEvent, 'kind' | 'counts_nutrition' | 'lines'>,
  items: (Pick<Item, 'id'> & Partial<Pick<Item, 'cost_per_unit_cents' | 'kcal_per_unit'>>)[],
): { value_cents: number; unpriced: number; no_kcal: number } {
  let value_cents = 0, unpriced = 0, no_kcal = 0;
  if (ev.kind !== 'eat' || !ev.counts_nutrition) return { value_cents, unpriced, no_kcal };
  const byId = new Map(items.map(i => [i.id, i]));
  for (const l of ev.lines) {
    if (l.is_set) continue;
    if (l.kcal == null && byId.get(l.item_id)?.kcal_per_unit == null) no_kcal++;
    const price = byId.get(l.item_id)?.cost_per_unit_cents;
    const v = l.value_cents ?? (price != null ? Math.round(Math.abs(l.qty) * price) : null);
    if (v == null) unpriced++; else value_cents += v;
  }
  return { value_cents, unpriced, no_kcal };
}

/** Merges server daily nutrition totals with pending unconfirmed eat/undo ops, or aggregates events directly. */
export function computeDailyNutrition(
  events: FoodEvent[],
  items: (Pick<Item, 'id'> & Partial<Pick<Item, Rates | 'cost_per_unit_cents'>>)[],
  serverDaily: DailyNutrition[] = [],
): DailyNutrition[] {
  const map = new Map<string, DailyNutrition>();
  const add = (day: string, user_id: number, kcal: number, protein_g: number, fat_g: number, carbs_g: number | null, value_cents = 0, unpriced = 0, no_kcal = 0) => {
    const k = `${day}:${user_id}`;
    const cur = map.get(k);
    const c = addKnown(cur?.carbs_g, carbs_g);
    const carbs = c == null ? null : Math.max(0, round1(c));
    if (cur) { cur.kcal = Math.max(0, Math.round(cur.kcal + kcal)); cur.protein_g = Math.max(0, round1(cur.protein_g + protein_g)); cur.fat_g = Math.max(0, round1(cur.fat_g + fat_g)); cur.carbs_g = carbs; cur.value_cents += value_cents; cur.unpriced += unpriced; cur.no_kcal += no_kcal; }
    else map.set(k, { day, user_id, kcal: Math.max(0, Math.round(kcal)), protein_g: Math.max(0, round1(protein_g)), fat_g: Math.max(0, round1(fat_g)), carbs_g: carbs, value_cents, unpriced, no_kcal });
  };
  if (serverDaily.length) {
    for (const d of serverDaily) add(d.day, d.user_id, d.kcal, d.protein_g, d.fat_g ?? 0, d.carbs_g ?? null, d.value_cents ?? 0, d.unpriced ?? 0, d.no_kcal ?? 0);
  } else {
    for (const ev of events) {
      const n = eventNutrition(ev, items);
      const v = eventValue(ev, items);
      if (n.kcal > 0 || n.protein_g > 0 || n.fat_g > 0 || (n.carbs_g ?? 0) > 0 || v.value_cents > 0 || v.unpriced > 0 || v.no_kcal > 0) add(isoDate(ev.at), ev.user_id, n.kcal, n.protein_g, n.fat_g, n.carbs_g, v.value_cents, v.unpriced, v.no_kcal);
    }
  }
  return [...map.values()].sort((a, b) => (a.day === b.day ? a.user_id - b.user_id : b.day.localeCompare(a.day)));
}
