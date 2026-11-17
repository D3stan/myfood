// Nutrition goals page.
import { store as s } from '../../store.ts';
import { mutate, st, toast } from '../helpers.ts';
import { GOAL_FIELDS } from './goals.ts';

export const nutritionActions: Record<string, (el: HTMLElement) => void | Promise<unknown>> = {
  saveGoals: async () => {
    const f = s.ui.f, me = st().me, goals: Record<string, number | null> = {};
    for (const [k] of GOAL_FIELDS) {
      const raw = (f[`goal_${k}`] ?? String(me.goals[k] ?? '')).trim();
      const n = raw === '' ? null : Number(raw.replace(',', '.'));
      if (n !== null && !(n > 0 && Number.isFinite(n))) return void toast('Goals must be positive numbers');
      goals[k] = n;
    }
    if (await mutate('PATCH', '/api/me', { goals })) { for (const [k] of GOAL_FIELDS) delete f[`goal_${k}`]; toast('Saved goals'); }
  },
};
