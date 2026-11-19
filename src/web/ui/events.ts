// Delegated listeners: data-a = action on click, data-c = action on change, data-f = a text field, data-submit = a form.
import { actions, commit, toast } from './actions.ts';
import { closeSheet, store as s } from '../store.ts';

async function run(name: string | undefined, el: HTMLElement): Promise<void> {
  try { await actions[name ?? '']?.(el); } catch { toast('Something went wrong'); }
  commit();
}

export function wire(): void {
  const hit = (e: Event, sel: string) => (e.target as Element).closest<HTMLElement>(sel);

  document.addEventListener('click', e => {
    const el = hit(e, '[data-a]');
    if (el && !(el as HTMLButtonElement).disabled) void run(el.dataset.a, el);
    else if ((e.target as Element).id === 'overlay') void run('close', document.body);
  });

  const store = (e: Event): void => {
    const el = hit(e, '[data-f]') as HTMLInputElement | null;
    if (!el) return;
    s.ui.f[el.dataset.f!] = el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value;
    if (el.dataset.f === 'search' || el.dataset.f === 'cookPortions' || el.dataset.f === 'cookGrams') commit();
  };
  document.addEventListener('input', store);
  document.addEventListener('change', e => {
    store(e);
    const fEl = hit(e, '[data-f]') as HTMLInputElement | null;
    if (fEl?.dataset.f === 'notifyLow' || fEl?.dataset.f === 'notifyExpiry' || fEl?.dataset.f === 'notifyDeals') {
      void run('saveNotify', fEl);
    }
    const el = hit(e, '[data-c]');
    if (el) void run(el.dataset.c, el);
  });
  document.addEventListener('focusout', e => {
    const el = hit(e, '[data-c=num]');
    if (el && s.ui.editing) void run('numend', el);
  });
  document.addEventListener('submit', e => {
    const form = hit(e, '[data-submit]');
    if (!form) return;
    e.preventDefault();
    void run(form.dataset.submit, form);
  });
  document.addEventListener('keydown', e => {
    const el = e.target as HTMLElement;
    if (e.key === 'Escape') {
      if (s.ui.sheet) { closeSheet(s); commit(); }
      else if (s.ui.tour) { s.ui.tour = null; commit(); }
    }
    else if (e.key === 'Enter' && el.dataset?.c === 'num') (el as HTMLInputElement).blur();
    else if ((e.key === 'Enter' || e.key === ' ') && el.getAttribute?.('role') === 'button' && el.tagName !== 'LABEL') { e.preventDefault(); el.click(); }
  });
}
