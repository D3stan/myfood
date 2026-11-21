import { closeSheet, enqueueUndo, store as s } from '../../store.ts';
import { mutate, sheet, st, sync, toast } from '../helpers.ts';
import { logged, parseOptNum, pump } from '../logging.ts';

export const eventActions: Record<string, (el: HTMLElement) => void | Promise<unknown>> = {
  historyScope: el => {
    s.ui.historyScope = el.dataset.v === 'all' ? 'all' : 'me';
  },
  saveEvent: async () => {
    const sh = sheet(), e = st().events.find(x => x.cid === sh.id)!;
    if (s.pending.some(o => o.type === 'event' && o.body.cid === e.cid)) return void toast('Still sending, try again in a moment');
    if (await mutate('PATCH', `/api/events/${e.cid}`, { lines: e.lines.map(l => ({ item_id: l.item_id, qty: sh.q[l.item_id] ?? 0 })) })) { closeSheet(s); toast('Saved'); }
  },
  saveEatOut: async () => {
    const sh = sheet(), f = s.ui.f, note = (f.eoNote ?? '').trim();
    const [kcal, p, fa, c] = [f.eoKcal, f.eoP, f.eoF, f.eoC].map(parseOptNum);
    if (!note || note.length > 80) return void toast('Describe it in 80 characters or less');
    if (kcal == null || kcal === 'invalid' || kcal < 0 || kcal > 5000) return void toast('Calories must be 0 to 5000');
    if ([p, fa, c].some(m => m === 'invalid' || (m != null && (m < 0 || m > 1000)))) return void toast('Check the macros (0 to 1000 g)');
    const line = { item_id: st().jolly_id, qty: 1, kcal, protein_g: p as number | null, fat_g: fa as number | null, carbs_g: c as number | null };
    if (sh.id == null) { logged('eat', [line], 'Logged', { note }); closeSheet(s); return; }
    if (s.pending.some(o => o.type === 'event' && o.body.cid === sh.id)) return void toast('Still sending, try again in a moment');
    if (await mutate('PATCH', `/api/events/${sh.id}`, { lines: [line], note })) { closeSheet(s); toast('Saved'); }
  },
  undoEvent: () => {
    enqueueUndo(s, String(sheet().id));
    closeSheet(s); toast('Undone'); sync(); void pump();
  },
};
