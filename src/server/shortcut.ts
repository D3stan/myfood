// What the Siri Shortcuts call: find a preset or cooked meal by what was said, or guess the one for this time of day.
import { nameKey } from '../shared/text.ts';
import type { Preset } from '../shared/types.ts';
import type { Db } from './db.ts';
import { all } from './db.ts';
import { listPresets } from './presets/repo.ts';

export interface CookedRow { id: number; name: string; unit: string; step: number; portion_g: number | null }

/** Exact name first, then one that starts with it, then one that contains it (or is contained, for "my lunch please"). */
function best<T extends { name: string }>(list: T[], said: string): T | undefined {
  const k = nameKey(said);
  if (!k) return undefined;
  return list.find(x => nameKey(x.name) === k)
    ?? list.find(x => nameKey(x.name).startsWith(k))
    ?? list.find(x => nameKey(x.name).includes(k))
    ?? list.find(x => k.includes(nameKey(x.name)));
}

/** The preset whose usual hour is closest to now (wrapping around midnight). */
export function suggestPreset(presets: Preset[], nowMs: number): Preset | undefined {
  const t = new Date(nowMs), h = t.getHours() + t.getMinutes() / 60;
  const gap = (p: Preset) => { const x = Math.abs(p.hour - h); return Math.min(x, 24 - x); };
  return presets.filter(p => p.lines.length).sort((a, b) => gap(a) - gap(b))[0];
}

/** Cooked meals this person may eat: shared ones and their own. */
export const cookedMeals = (db: Db, userId: number): CookedRow[] =>
  all<CookedRow>(
    db,
    'SELECT id, name, unit, step, portion_g FROM items WHERE is_cooked = 1 AND archived_at IS NULL AND (owner_id IS NULL OR owner_id = ?) ORDER BY name',
    userId,
  );

/** One portion of a cooked meal, in the item's own unit. */
export const portionQty = (m: CookedRow, portions: number): number =>
  Math.round((m.unit === 'portion' ? portions : (m.portion_g ?? m.step) * portions) * 1000) / 1000;

/** Names for the Shortcut's "Choose from List" plus the one to preselect. */
export function mealChoices(db: Db, userId: number, nowMs: number): { meals: string[]; suggested: string | null } {
  const presets = listPresets(db, userId);
  return {
    meals: [...presets.filter(p => p.lines.length).map(p => p.name), ...cookedMeals(db, userId).map(m => m.name)],
    suggested: suggestPreset(presets, nowMs)?.name ?? null,
  };
}

export type MealMatch =
  | { kind: 'preset'; preset: Preset }
  | { kind: 'cooked'; meal: CookedRow };

/** Presets win over cooked meals. An empty `said` means "whatever fits the time of day". */
export function findMeal(db: Db, userId: number, said: string | undefined, nowMs: number): MealMatch | null {
  const presets = listPresets(db, userId);
  if (!said?.trim()) {
    const p = suggestPreset(presets, nowMs);
    return p ? { kind: 'preset', preset: p } : null;
  }
  const p = best(presets, said);
  if (p) return { kind: 'preset', preset: p };
  const m = best(cookedMeals(db, userId), said);
  return m ? { kind: 'cooked', meal: m } : null;
}
