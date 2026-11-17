import { api, startJob } from '../../api.ts';
import { closeSheet, openSheet, receive, store as s } from '../../store.ts';
import { afterState, commit, fail, mutate, sheet, toast } from '../helpers.ts';
import { parseOptNum } from '../logging.ts';

function shrink(file: File): Promise<Blob> {
  return createImageBitmap(file).then(bmp => {
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return new Promise<Blob>((ok, no) => c.toBlob(b => (b ? ok(b) : no(new Error('encode'))), 'image/jpeg', 0.8));
  }).catch(() => file);
}

export const jobActions: Record<string, (el: HTMLElement) => void | Promise<unknown>> = {
  dismissJob: el => mutate('DELETE', `/api/jobs/${el.dataset.id}`),
  openAudit: () => {
    s.ui.jobMode = 'audit';
    openSheet(s, { t: 'compose', q: {}, mode: 'audit' });
  },
  jobMode: el => {
    const mode = el.dataset.v === 'audit' ? 'audit' : 'auto';
    s.ui.jobMode = mode;
    if (s.ui.sheet?.t === 'compose') s.ui.sheet.mode = mode;
  },
  photos: el => {
    const input = el as HTMLInputElement;
    for (const file of [...(input.files ?? [])]) {
      if (s.ui.files.length >= 4) { toast('Four photos at most'); break; }
      s.ui.files.push({ file, url: URL.createObjectURL(file) });
    }
    input.value = '';
  },
  rmPhoto: el => { const [f] = s.ui.files.splice(Number(el.dataset.k), 1); if (f) URL.revokeObjectURL(f.url); },
  send: async () => {
    const sh = sheet(), text = (s.ui.f.text ?? '').trim();
    if (sh.busy) return;
    if (!text && !s.ui.files.length) return void toast('Write something or add a photo');
    if (!navigator.onLine) return void toast("You're offline");
    sh.busy = true; commit();
    try {
      const blobs: Blob[] = [];
      for (const { file } of s.ui.files) blobs.push(await shrink(file));
      receive(s, await startJob(text, blobs, sh.mode ?? s.ui.jobMode));
      s.ui.files.forEach(f => URL.revokeObjectURL(f.url));
      s.ui.files = []; s.ui.f.text = '';
      closeSheet(s); toast("Sent. I'll tell you when it's done.");
      afterState();
    } catch (e) { fail(e); } finally { sh.busy = false; }
  },
  rematch: el => {
    const sh = sheet(), [e, l] = el.dataset.k!.split('.').map(Number), v = (el as HTMLSelectElement).value;
    const line = sh.events?.[e!]?.lines[l!], orig = sh.orig?.[e!]?.lines[l!];
    if (!line) return;
    if (v === 'new' && orig?.new_item) { line.item_id = null; line.new_item = { ...orig.new_item }; }
    else { line.item_id = Number(v); line.new_item = null; }
  },
  rmCook: el => {
    const sh = sheet();
    sh.cook?.splice(Number(el.dataset.k), 1);
  },
  apply: async () => {
    const sh = sheet();
    if (sh.busy) return;
    const events = structuredClone((sh.events ?? []).filter(e => e.lines.length));
    const cook = sh.cook ?? [];
    if (!events.length && !cook.length) return void toast('Nothing left to add');
    if (events.length && s.ui.f.reviewTotalCost !== undefined) {
      const tc = parseOptNum(s.ui.f.reviewTotalCost);
      if (tc === 'invalid' || (tc != null && tc < 0)) return void toast('Check the total cost');
      const target = events.find(e => e.kind === 'buy') ?? events[0];
      if (target) target.total_cost = tc;
    }
    sh.busy = true; commit();
    try {
      receive(s, await api('POST', `/api/jobs/${sh.id}/apply`, { events, ...(cook.length ? { cook } : {}) }));
      s.ui.f.reviewTotalCost = '';
      toast('Applied to pantry');
      afterState();
    } catch (e) { fail(e); } finally { sh.busy = false; }
  },
  discard: () => mutate('DELETE', `/api/jobs/${sheet().id}`),
};
