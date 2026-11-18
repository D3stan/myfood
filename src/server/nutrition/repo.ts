import { isoDate } from '../../shared/dates.ts';
import { addKnown, eventLineNutrition } from '../../shared/nutrition.ts';
import type { DailyNutrition } from '../../shared/types.ts';
import { all } from '../db.ts';
import type { Db } from '../db.ts';

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Counted eat lines per day and user from `fromMs` (inclusive) to `toMs` (exclusive, default now and later). */
export function dailyNutrition(db: Db, fromMs: number, userId?: number, toMs?: number): DailyNutrition[] {
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
    value_cents: number | null;
    kcal_per_unit: number | null;
    protein_per_unit: number | null;
    fat_per_unit: number | null;
    carbs_per_unit: number | null;
  }>(
    db,
    `SELECT e.at, e.user_id, l.item_id, l.qty, l.is_set, l.kcal, l.protein_g, l.fat_g, l.carbs_g, l.value_cents, i.kcal_per_unit, i.protein_per_unit, i.fat_per_unit, i.carbs_per_unit
     FROM event_lines l
     JOIN events e ON e.cid = l.event_cid
     JOIN items i ON i.id = l.item_id
     WHERE e.undone_at IS NULL AND e.kind = 'eat' AND e.counts_nutrition = 1 AND e.at >= ?${userId !== undefined ? ' AND e.user_id = ?' : ''}${toMs !== undefined ? ' AND e.at < ?' : ''}`,
    fromMs,
    ...(userId !== undefined ? [userId] : []),
    ...(toMs !== undefined ? [toMs] : []),
  )) {
    if (r.is_set) continue;
    const n = eventLineNutrition(
      { item_id: r.item_id, qty: r.qty, is_set: false, kcal: r.kcal, protein_g: r.protein_g, fat_g: r.fat_g, carbs_g: r.carbs_g },
      { kcal_per_unit: r.kcal_per_unit, protein_per_unit: r.protein_per_unit, fat_per_unit: r.fat_per_unit, carbs_per_unit: r.carbs_per_unit },
    );
    const hasMacros = n.kcal > 0 || n.protein_g > 0 || n.fat_g > 0 || (n.carbs_g ?? 0) > 0;
    const day = isoDate(r.at);
    const key = `${day}:${r.user_id}`;
    let cur = dailyMap.get(key);
    if (!cur) dailyMap.set(key, cur = { day, user_id: r.user_id, kcal: 0, protein_g: 0, fat_g: 0, carbs_g: null, value_cents: 0, unpriced: 0, no_kcal: 0 });
    // Value counts even for a line with no macros; macros keep the old skip.
    if (r.kcal == null && r.kcal_per_unit == null) cur.no_kcal++;
    if (r.value_cents == null) cur.unpriced++; else cur.value_cents += r.value_cents;
    if (!hasMacros) continue;
    cur.kcal = Math.round(cur.kcal + n.kcal);
    cur.protein_g = round1(cur.protein_g + n.protein_g);
    cur.fat_g = round1(cur.fat_g + n.fat_g);
    const c = addKnown(cur.carbs_g, n.carbs_g);
    cur.carbs_g = c == null ? null : round1(c);
  }
  return [...dailyMap.values()].sort((a, b) =>
    a.day === b.day ? a.user_id - b.user_id : b.day.localeCompare(a.day),
  );
}
