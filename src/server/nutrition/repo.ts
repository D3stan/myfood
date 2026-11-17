import { isoDate } from '../../shared/dates.ts';
import { addKnown, eventLineNutrition } from '../../shared/nutrition.ts';
import type { DailyNutrition } from '../../shared/types.ts';
import { all } from '../db.ts';
import type { Db } from '../db.ts';

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function dailyNutrition(db: Db, fromMs: number, userId?: number): DailyNutrition[] {
  const dailyMap = new Map<string, DailyNutrition>();
  for (const r of all<{
    at: number;
    user_id: number;
    item_id: number;
    qty: number;
    is_set: number;
    kcal: number | null;
    protein_g: number | null;
    fat_g: number | null;
    carbs_g: number | null;
    kcal_per_unit: number | null;
    protein_per_unit: number | null;
    fat_per_unit: number | null;
    carbs_per_unit: number | null;
  }>(
    db,
    `SELECT e.at, e.user_id, l.item_id, l.qty, l.is_set, l.kcal, l.protein_g, l.fat_g, l.carbs_g, i.kcal_per_unit, i.protein_per_unit, i.fat_per_unit, i.carbs_per_unit
     FROM event_lines l
     JOIN events e ON e.cid = l.event_cid
     JOIN items i ON i.id = l.item_id
     WHERE e.undone_at IS NULL AND e.kind = 'eat' AND e.counts_nutrition = 1 AND e.at >= ?${userId !== undefined ? ' AND e.user_id = ?' : ''}`,
    ...(userId !== undefined ? [fromMs, userId] : [fromMs]),
  )) {
    if (r.is_set) continue;
    const n = eventLineNutrition(
      { item_id: r.item_id, qty: r.qty, is_set: false, kcal: r.kcal, protein_g: r.protein_g, fat_g: r.fat_g, carbs_g: r.carbs_g },
      { kcal_per_unit: r.kcal_per_unit, protein_per_unit: r.protein_per_unit, fat_per_unit: r.fat_per_unit, carbs_per_unit: r.carbs_per_unit },
    );
    if (n.kcal <= 0 && n.protein_g <= 0 && n.fat_g <= 0 && (n.carbs_g ?? 0) <= 0) continue;
    const day = isoDate(r.at);
    const key = `${day}:${r.user_id}`;
    const cur = dailyMap.get(key);
    if (cur) {
      cur.kcal = Math.round(cur.kcal + n.kcal);
      cur.protein_g = round1(cur.protein_g + n.protein_g);
      cur.fat_g = round1(cur.fat_g + n.fat_g);
      const c = addKnown(cur.carbs_g, n.carbs_g);
      cur.carbs_g = c == null ? null : round1(c);
    } else {
      dailyMap.set(key, { day, user_id: r.user_id, kcal: Math.round(n.kcal), protein_g: round1(n.protein_g), fat_g: round1(n.fat_g), carbs_g: n.carbs_g });
    }
  }
  return [...dailyMap.values()].sort((a, b) =>
    a.day === b.day ? a.user_id - b.user_id : b.day.localeCompare(a.day),
  );
}
