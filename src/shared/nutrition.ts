import { isoDate } from './dates.ts';
import type { DailyNutrition, EventLine, FoodEvent, Item } from './types.ts';

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Calories, protein and fat for one event line (explicit snapshot first, else item rate). */
export function eventLineNutrition(
  line: EventLine,
  item?: Pick<Item, 'kcal_per_unit' | 'protein_per_unit' | 'fat_per_unit'>,
): { kcal: number; protein_g: number; fat_g: number } {
  if (line.is_set) return { kcal: 0, protein_g: 0, fat_g: 0 };
  const q = Math.abs(line.qty);
  const kcal = line.kcal != null ? line.kcal : (item?.kcal_per_unit != null ? q * item.kcal_per_unit : 0);
  const protein_g = line.protein_g != null ? line.protein_g : (item?.protein_per_unit != null ? q * item.protein_per_unit : 0);
  const fat_g = line.fat_g != null ? line.fat_g : (item?.fat_per_unit != null ? q * item.fat_per_unit : 0);
  return { kcal: Math.round(kcal), protein_g: round1(protein_g), fat_g: round1(fat_g) };
}

/** Calories, protein and fat contributed by an event (only non-cook eat events count). */
export function eventNutrition(
  ev: Pick<FoodEvent, 'kind' | 'counts_nutrition' | 'lines'>,
  items: Pick<Item, 'id' | 'kcal_per_unit' | 'protein_per_unit' | 'fat_per_unit'>[],
): { kcal: number; protein_g: number; fat_g: number } {
  if (ev.kind !== 'eat' || !ev.counts_nutrition) return { kcal: 0, protein_g: 0, fat_g: 0 };
  const byId = new Map(items.map(i => [i.id, i]));
  let kcal = 0, protein_g = 0, fat_g = 0;
  for (const l of ev.lines) {
    const n = eventLineNutrition(l, byId.get(l.item_id));
    kcal += n.kcal;
    protein_g += n.protein_g;
    fat_g += n.fat_g;
  }
  return { kcal: Math.round(kcal), protein_g: round1(protein_g), fat_g: round1(fat_g) };
}

/** Merges server daily nutrition totals with pending unconfirmed eat/undo ops, or aggregates events directly. */
export function computeDailyNutrition(
  events: FoodEvent[],
  items: Pick<Item, 'id' | 'kcal_per_unit' | 'protein_per_unit' | 'fat_per_unit'>[],
  serverDaily: DailyNutrition[] = [],
): DailyNutrition[] {
  const map = new Map<string, DailyNutrition>();
  const add = (day: string, user_id: number, kcal: number, protein_g: number, fat_g: number) => {
    const k = `${day}:${user_id}`;
    const cur = map.get(k);
    if (cur) { cur.kcal = Math.max(0, Math.round(cur.kcal + kcal)); cur.protein_g = Math.max(0, round1(cur.protein_g + protein_g)); cur.fat_g = Math.max(0, round1(cur.fat_g + fat_g)); }
    else map.set(k, { day, user_id, kcal: Math.max(0, Math.round(kcal)), protein_g: Math.max(0, round1(protein_g)), fat_g: Math.max(0, round1(fat_g)) });
  };
  if (serverDaily.length) {
    for (const d of serverDaily) add(d.day, d.user_id, d.kcal, d.protein_g, d.fat_g ?? 0);
  } else {
    for (const ev of events) {
      const n = eventNutrition(ev, items);
      if (n.kcal > 0 || n.protein_g > 0 || n.fat_g > 0) add(isoDate(ev.at), ev.user_id, n.kcal, n.protein_g, n.fat_g);
    }
  }
  return [...map.values()].sort((a, b) => (a.day === b.day ? a.user_id - b.user_id : b.day.localeCompare(a.day)));
}
