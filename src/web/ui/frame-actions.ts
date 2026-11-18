// Frame selector actions, keyed by data-k so Me and Spend keep separate state.
import type { Frame } from '../../shared/period.ts';
import { store as s } from '../store.ts';
import { commit } from './helpers.ts';
import { frameOf } from './components/frame.ts';
import { loadStats } from './stats.ts';

export const frameActions: Record<string, (el: HTMLElement) => void> = {
  frame: el => {
    const k = el.dataset.k;
    if (k && (el.dataset.v === 'week' || el.dataset.v === 'month' || el.dataset.v === 'year')) { s.ui.frames[k] = { frame: el.dataset.v as Frame, offset: 0 }; commit(); loadStats(k, commit); }
  },
  frameStep: el => {
    const k = el.dataset.k;
    if (!k) return;
    const cur = frameOf(s.ui, k);
    s.ui.frames[k] = { frame: cur.frame, offset: Math.min(0, cur.offset + (el.dataset.d === '-1' ? -1 : 1)) };
    commit();
    loadStats(k, commit);
  },
};
