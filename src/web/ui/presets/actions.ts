import { closeSheet, openSheet, store as s } from '../../store.ts';
import { hourToTime, timeToHour } from '../components/bits.ts';
import { mutate, sheet, st, toast } from '../helpers.ts';
import { confirmOverdraw, item, logged, presetLines } from '../logging.ts';

export const presetActions: Record<string, (el: HTMLElement) => void | Promise<unknown>> = {
  heroLog: el => {
    const p = st().presets.find(x => x.id === Number(el.dataset.id))!;
    const lines = p.lines.map(l => ({ item_id: l.item_id, qty: l.qty }));
    if (!confirmOverdraw(st(), lines)) return;
    logged('eat', lines, `Logged ${p.name}`, { preset_id: p.id, note: p.name });
  },
  logPreset: () => {
    const sh = sheet(), p = st().presets.find(x => x.id === sh.id)!;
    const lines = presetLines(p.lines.map(l => l.item_id), sh.q);
    if (!lines.length) return void toast('Pick an amount first');
    if (!confirmOverdraw(st(), lines)) return;
    logged('eat', lines, `Logged ${p.name}`, { preset_id: p.id, note: p.name }); closeSheet(s);
  },
  presetAdd: el => {
    const sh = sheet(), it = item((el as HTMLSelectElement).value);
    if (it) { sh.lines?.push(it.id); sh.q[it.id] = it.step; }
  },
  savePreset: async () => {
    const sh = sheet(), f = s.ui.f, name = (f.name ?? '').trim();
    const lines = presetLines(sh.lines ?? [], sh.q);
    if (!name || !lines.length) return void toast('Give it a name and at least one item');
    const body = { name, emoji: (f.emoji ?? '').trim() || '🍽️', hour: timeToHour(f.time || '08:00'), lines };
    if (await mutate(sh.id == null ? 'POST' : 'PATCH', sh.id == null ? '/api/presets' : `/api/presets/${sh.id}`, body)) { closeSheet(s); toast(`Saved ${name}`); }
  },
  saveAsPreset: () => {
    const e = st().events.find(x => x.cid === sheet().id)!, d = new Date(e.at);
    openSheet(s, { t: 'presetEdit', q: Object.fromEntries(e.lines.map(l => [l.item_id, Math.abs(l.qty)])), lines: e.lines.map(l => l.item_id) },
      { name: e.note ?? '', emoji: '🍽️', time: hourToTime(d.getHours() + d.getMinutes() / 60) });
  },
};
