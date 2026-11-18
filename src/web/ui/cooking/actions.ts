import { cookMeal } from '../../api.ts';
import { closeSheet, qOf, receive, store as s } from '../../store.ts';
import { ISO_DATE_RE, addDays, isoDate } from '../../../shared/dates.ts';
import type { Item } from '../../../shared/types.ts';
import { cookBatchMacros } from '../components/cook.ts';
import { afterState, commit, fail, sheet, st, toast } from '../helpers.ts';
import { confirmOverdraw, item, parseOptNum } from '../logging.ts';

export function cookStateFor(it: Item | undefined, nowMs: number): {
  lines: number[];
  q: Record<string, number>;
  fields: Record<string, string>;
} {
  const exp = addDays(isoDate(nowMs), it?.shelf_life_days ?? 4);
  if (!it) {
    return {
      lines: [], q: {},
      fields: { cookName: '', cookEmoji: '🍲', cookOwner: 'shared', cookExpiry: exp, cookPortions: '', cookGrams: '', cookKcal: '', cookProtein: '' },
    };
  }
  const recipe = it.recipe ?? [];
  return {
    lines: recipe.map(r => r.item_id),
    q: Object.fromEntries(recipe.map(r => [String(r.item_id), r.qty])),
    fields: {
      cookName: it.name, cookEmoji: it.emoji,
      cookOwner: it.owner_id == null ? 'shared' : 'mine',
      cookExpiry: exp, cookPortions: '', cookGrams: '', cookKcal: '', cookProtein: '',
    },
  };
}

export const cookingActions: Record<string, (el: HTMLElement) => void | Promise<unknown>> = {
  cookMealPick: el => {
    const sh = sheet(), picked = item((el as HTMLSelectElement).value);
    const ck = cookStateFor(picked, st().now);
    sh.id = picked?.id;
    sh.lines = ck.lines;
    sh.q = ck.q;
    Object.assign(s.ui.f, ck.fields);
  },
  cookAddIng: el => {
    const sh = sheet(), it = item((el as HTMLSelectElement).value);
    if (!it) return;
    sh.lines ??= [];
    if (!sh.lines.includes(it.id)) sh.lines.push(it.id);
    sh.q[String(it.id)] ??= it.unit === 'g' || it.unit === 'ml' ? Math.min(it.pack_size, 500) : it.step;
  },
  saveCook: async () => {
    const sh = sheet(), f = s.ui.f;
    if (sh.busy) return;
    if (!navigator.onLine) return void toast("You're offline");
    const mealId = typeof sh.id === 'number' ? sh.id : null;
    const name = (f.cookName ?? '').trim();
    if (!mealId && !name) return void toast('Give the cooked meal a name');
    const portions = parseOptNum(f.cookPortions), total_g = parseOptNum(f.cookGrams);
    if (portions === 'invalid' || total_g === 'invalid' || (portions != null && !(portions > 0)) || (total_g != null && !(total_g > 0))) {
      return void toast('Check portions and grams');
    }
    if (portions == null && total_g == null) return void toast('Enter portions, total grams, or both');
    const exp = (f.cookExpiry ?? '').trim();
    if (exp && !ISO_DATE_RE.test(exp)) return void toast('Check expiry date');
    const kcalIn = parseOptNum(f.cookKcal), proteinIn = parseOptNum(f.cookProtein), fatIn = parseOptNum(f.cookFat), carbsIn = parseOptNum(f.cookCarbs);
    if (kcalIn === 'invalid' || proteinIn === 'invalid' || fatIn === 'invalid' || carbsIn === 'invalid') return void toast('Check calories, protein, fat and carbs');
    const ids = sh.lines ?? [];
    const auto = cookBatchMacros(st().items, ids, sh.q);
    const ingredients = ids.map(id => ({ item_id: id, qty: qOf(sh, String(id)) })).filter(l => l.qty > 0);
    if (!confirmOverdraw(st(), ingredients)) return;
    sh.busy = true; commit();
    try {
      const next = await cookMeal({
        cid: crypto.randomUUID(),
        at: Date.now(),
        meal_item_id: mealId,
        name: name || null,
        emoji: (f.cookEmoji ?? '').trim() || '🍲',
        owner_id: f.cookOwner === 'mine' ? st().me.id : null,
        portions,
        total_g,
        expires_at: exp || null,
        kcal_total: kcalIn != null ? kcalIn : (auto.hasKcal ? auto.kcal : null),
        protein_total: proteinIn != null ? proteinIn : (auto.hasProtein ? auto.protein : null),
        fat_total: fatIn != null ? fatIn : (auto.hasFat ? auto.fat : null),
        carbs_total: carbsIn != null ? carbsIn : (auto.hasCarbs ? auto.carbs : null),
        ingredients,
      });
      receive(s, next);
      closeSheet(s);
      toast(`Cooked ${name || 'meal'}`);
      afterState();
    } catch (e) { fail(e); } finally { sh.busy = false; }
  },
};
