// Guided tour overlay for interactive demo mode.
import { html, htmlToString } from '../../html.ts';
import type { Store, Tab } from '../../store.ts';

export interface TourStep {
  tab: Tab;
  selectors: readonly string[];
  fallbackSelectors?: readonly string[];
  combine?: boolean;
  title: string;
  body: string;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    tab: 'pantry',
    selectors: ['#hero'],
    fallbackSelectors: ['.quick-actions'],
    title: 'One-tap meal logging',
    body: 'Tap "Log it" for a meal that fits this time of day, or tap the round badge on any item to log one usual serving.',
  },
  {
    tab: 'pantry',
    selectors: ['#eat-soon', '#low'],
    fallbackSelectors: ['.items'],
    combine: true,
    title: 'Spot what needs attention',
    body: 'See expiring food and low-stock items at a glance, filter by Mine or Shared, and share your shopping list.',
  },
  {
    tab: 'pantry',
    selectors: ['.composer'],
    fallbackSelectors: ['#composer'],
    title: 'Type or snap a receipt',
    body: 'Tell the bar what you ate or bought, run a fridge audit, or tap "Have a look" on the sample receipt ready above.',
  },
  {
    tab: 'spend',
    selectors: ['#spend-summary'],
    title: 'Track household spend',
    body: 'Compare who paid vs. who ate, browse weekly charts, and lock or export settled weeks as CSV or JSON.',
  },
  {
    tab: 'history',
    selectors: ['.ev'],
    fallbackSelectors: ['.top'],
    title: 'Day-by-day food log',
    body: 'Review every meal and grocery run with daily macro pills. Tap any entry to adjust amounts, save a preset, or undo.',
  },
  {
    tab: 'me',
    selectors: ['#today'],
    fallbackSelectors: ['.top'],
    title: 'Nutrition goals & trends',
    body: 'Track daily calories and macros against your goals, inspect weekly trends, and customize your household in Settings.',
  },
];

export const isTourVisible = (s: Store): boolean =>
  Boolean(s.server && s.ui.demo && s.ui.tour && s.ui.sheet == null && s.ui.page.length === 0);

/** Pure HTML string for the tour layer (safe in Vitest without a DOM). */
export function tourHtml(s: Store): string {
  if (!isTourVisible(s)) return '';
  const idx = Math.max(0, Math.min(TOUR_STEPS.length - 1, s.ui.tour!.step));
  const step = TOUR_STEPS[idx]!;
  const isLast = idx === TOUR_STEPS.length - 1;
  return htmlToString(html`
    <div class="tour-layer" role="dialog" aria-modal="false" aria-labelledby="tour-title">
      <div class="tour-spot" id="tour-spot" aria-hidden="true"></div>
      <div class="tour-card" id="tour-card">
        <div class="tour-head">
          <span class="tour-count">${idx + 1} / ${TOUR_STEPS.length}</span>
          <button type="button" class="tour-x" data-a="tourSkip" aria-label="Close tour">×</button>
        </div>
        <h3 id="tour-title">${step.title}</h3>
        <p class="tour-body">${step.body}</p>
        <div class="tour-actions">
          <button type="button" class="tour-skip" data-a="tourSkip">Skip</button>
          <div class="tour-nav">
            ${idx > 0 ? html`<button type="button" id="tour-prev" class="btn alt" data-a="tourPrev">Back</button>` : ''}
            <button type="button" id="tour-next" class="btn" data-a="tourNext">${isLast ? 'Done' : 'Next'}</button>
          </div>
        </div>
      </div>
    </div>
  `);
}

interface BoxRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function isFixedElement(el: HTMLElement): boolean {
  if (typeof window.getComputedStyle !== 'function') return false;
  let cur: HTMLElement | null = el;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    if (window.getComputedStyle(cur).position === 'fixed') return true;
    cur = cur.parentElement;
  }
  return false;
}

function visibleRect(el: HTMLElement | null): BoxRect | null {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 && r.height <= 0) return null;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}

function findTargetBox(step: TourStep): { rect: BoxRect; fixed: boolean } | null {
  const matched: { el: HTMLElement; rect: BoxRect }[] = [];
  for (const sel of step.selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    const r = visibleRect(el);
    if (el && r) {
      matched.push({ el, rect: r });
      if (!step.combine) break;
    }
  }
  if (!matched.length && step.fallbackSelectors) {
    for (const sel of step.fallbackSelectors) {
      const el = document.querySelector<HTMLElement>(sel);
      const r = visibleRect(el);
      if (el && r) {
        matched.push({ el, rect: r });
        break;
      }
    }
  }
  if (!matched.length) return null;
  const fixed = matched.some(m => isFixedElement(m.el));
  if (matched.length === 1) return { rect: matched[0]!.rect, fixed };
  const left = Math.min(...matched.map(m => m.rect.left));
  const top = Math.min(...matched.map(m => m.rect.top));
  const right = Math.max(...matched.map(m => m.rect.right));
  const bottom = Math.max(...matched.map(m => m.rect.bottom));
  return { rect: { left, top, right, bottom, width: right - left, height: bottom - top }, fixed };
}

function bottomSafeLimit(vh: number, margin: number): number {
  const comp = visibleRect(document.querySelector<HTMLElement>('.composer'));
  const bar = visibleRect(document.querySelector<HTMLElement>('.tabbar'));
  const chromeTop = Math.min(comp ? comp.top : vh, bar ? bar.top : vh);
  return Math.max(220, Math.min(vh - margin, chromeTop - 10));
}

let listenersWired = false;
let rafId = 0;
let lastAutoScrollKey = '';
let activeStore: Store | null = null;

function positionTour(s: Store, allowScroll: boolean): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (typeof window.innerWidth !== 'number' || typeof document.querySelector !== 'function') return;
  if (!isTourVisible(s)) {
    lastAutoScrollKey = '';
    return;
  }

  const card = document.getElementById('tour-card');
  const spot = document.getElementById('tour-spot');
  if (!card || !spot || typeof card.getBoundingClientRect !== 'function') return;

  const idx = Math.max(0, Math.min(TOUR_STEPS.length - 1, s.ui.tour!.step));
  const step = TOUR_STEPS[idx]!;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 12;
  const gap = 12;
  const pad = 6;
  const bottomLimit = bottomSafeLimit(vh, margin);

  const cardRect = card.getBoundingClientRect();
  const cardW = cardRect.width > 0 ? cardRect.width : Math.min(340, vw - margin * 2);
  const cardH = cardRect.height > 0 ? cardRect.height : 190;

  let target = findTargetBox(step);
  const scrollKey = `${idx}:${s.ui.tab}`;

  if (target && allowScroll && scrollKey !== lastAutoScrollKey && !target.fixed) {
    lastAutoScrollKey = scrollKey;
    const r0 = target.rect;
    const spotTop0 = r0.top - pad;
    const spotBottom0 = r0.bottom + pad;
    const fitsAbove0 = spotTop0 - gap - margin >= cardH;
    const fitsBelow0 = bottomLimit - spotBottom0 - gap >= cardH;
    const demoRect = visibleRect(document.getElementById('demo-bar'));
    const topPref = demoRect && demoRect.bottom > 0 ? Math.min(72, demoRect.bottom + 10) : 16;

    if (r0.top < 16 || r0.bottom > bottomLimit || (!fitsAbove0 && !fitsBelow0)) {
      if (typeof window.scrollBy === 'function') {
        const neededH = r0.height + pad * 2 + gap + cardH;
        let desiredTop: number;
        if (neededH <= bottomLimit - topPref) {
          desiredTop = topPref;
        } else if (neededH <= bottomLimit - 16) {
          desiredTop = 16;
        } else {
          desiredTop = Math.max(16, topPref);
        }
        const dy = r0.top - desiredTop;
        if (Math.abs(dy) > 4) {
          window.scrollBy({ top: dy, behavior: 'instant' as ScrollBehavior });
          target = findTargetBox(step);
        }
      }
    }
  } else if (allowScroll) {
    lastAutoScrollKey = scrollKey;
  }

  if (!target) {
    spot.style.display = 'none';
    const left = Math.max(margin, Math.min(vw - cardW - margin, (vw - cardW) / 2));
    const top = Math.max(margin, Math.min(bottomLimit - cardH, (bottomLimit - cardH) / 2));
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
    return;
  }

  const rect = target.rect;
  const spotLeft = Math.max(4, rect.left - pad);
  const spotTop = Math.max(4, rect.top - pad);
  const spotRight = Math.min(vw - 4, rect.right + pad);
  const spotBottom = Math.min(vh - 4, rect.bottom + pad);
  const spotW = Math.max(24, spotRight - spotLeft);
  const spotH = Math.max(24, spotBottom - spotTop);

  spot.style.display = 'block';
  spot.style.left = `${Math.round(spotLeft)}px`;
  spot.style.top = `${Math.round(spotTop)}px`;
  spot.style.width = `${Math.round(spotW)}px`;
  spot.style.height = `${Math.round(spotH)}px`;

  const spaceBelow = bottomLimit - spotBottom - gap;
  const spaceAbove = spotTop - gap - margin;
  const spaceRight = vw - spotRight - gap - margin;
  const spaceLeft = spotLeft - gap - margin;
  const preferAbove = target.fixed && spotTop > vh * 0.45;

  let left: number;
  let top: number;

  if (preferAbove && spaceAbove >= cardH) {
    top = spotTop - gap - cardH;
    left = Math.max(margin, Math.min(vw - cardW - margin, spotLeft + spotW / 2 - cardW / 2));
  } else if (!preferAbove && spaceBelow >= cardH) {
    top = spotBottom + gap;
    left = Math.max(margin, Math.min(vw - cardW - margin, spotLeft + spotW / 2 - cardW / 2));
  } else if (spaceAbove >= cardH) {
    top = spotTop - gap - cardH;
    left = Math.max(margin, Math.min(vw - cardW - margin, spotLeft + spotW / 2 - cardW / 2));
  } else if (spaceRight >= cardW) {
    left = spotRight + gap;
    top = Math.max(margin, Math.min(bottomLimit - cardH, spotTop));
  } else if (spaceLeft >= cardW) {
    left = spotLeft - gap - cardW;
    top = Math.max(margin, Math.min(bottomLimit - cardH, spotTop));
  } else if (spaceBelow >= spaceAbove) {
    top = Math.min(bottomLimit - cardH, spotBottom + gap);
    left = Math.max(margin, Math.min(vw - cardW - margin, spotLeft + spotW / 2 - cardW / 2));
  } else {
    top = Math.max(margin, spotTop - gap - cardH);
    left = Math.max(margin, Math.min(vw - cardW - margin, spotLeft + spotW / 2 - cardW / 2));
  }

  top = Math.max(margin, Math.min(bottomLimit - cardH, top));
  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(top)}px`;
}

function ensureTourListeners(): void {
  if (listenersWired || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  listenersWired = true;
  const schedule = () => {
    if (!activeStore || !isTourVisible(activeStore)) return;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (activeStore) positionTour(activeStore, false);
    });
  };
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, { passive: true });
}

/** Updates tour spotlight and card coordinates after `#tour` has been morphed into the DOM. */
export function syncTour(s: Store): void {
  activeStore = s;
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (!isTourVisible(s)) {
    lastAutoScrollKey = '';
    return;
  }
  ensureTourListeners();
  positionTour(s, true);
}
