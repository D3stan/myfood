import { closeSheet, enqueueUndo, store as s } from '../../store.ts';
import { mutate, sheet, st, sync, toast } from '../helpers.ts';
import { pump } from '../logging.ts';

export const eventActions: Record<string, (el: HTMLElement) => void | Promise<unknown>> = {
  historyScope: el => {
    s.ui.historyScope = el.dataset.v === 'all' ? 'all' : 'me';
  },
  saveEvent: async () => {
    const sh = sheet(), e = st().events.find(x => x.cid === sh.id)!;
    if (s.pending.some(o => o.type === 'event' && o.body.cid === e.cid)) return void toast('Still sending, try again in a moment');
    if (await mutate('PATCH', `/api/events/${e.cid}`, { lines: e.lines.map(l => ({ item_id: l.item_id, qty: sh.q[l.item_id] ?? 0 })) })) { closeSheet(s); toast('Saved'); }
  },
  undoEvent: () => {
    enqueueUndo(s, String(sheet().id));
    closeSheet(s); toast('Undone'); sync(); void pump();
  },
};
