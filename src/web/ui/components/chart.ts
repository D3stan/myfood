// Inline-SVG stacked bar chart. No dependency; colours are CSS tokens.
import { html } from '../../html.ts';

const W = 300, PLOT = 100, TOP = 6, H = TOP + PLOT + 16;
export const COLORS = ['var(--green)', 'var(--blue)', 'var(--gold)', 'var(--red)'];

export interface Bar { label: string; values: number[] }

/** Values stack bottom-up; the y-scale is max(tallest stack, goal). Over-goal is drawn, not clamped. */
export function barChart({ bars, colors = COLORS, goal = null, fmt = n => String(Math.round(n)) }: {
  bars: Bar[]; colors?: string[]; goal?: number | null; fmt?: (n: number) => string;
}) {
  const totals = bars.map(b => b.values.reduce((a, v) => a + v, 0));
  const max = Math.max(...totals, goal ?? 0) || 1;
  const y = (v: number) => (v / max) * PLOT;
  const slot = W / Math.max(bars.length, 1), bw = slot * 0.7;
  const every = Math.ceil(bars.length / 8) || 1; // month: show about 8 labels
  const peak = Math.max(0, ...totals);
  const summary = bars.length
    ? `Bar chart, ${bars.length} bars, highest ${fmt(peak)}${goal != null ? `, goal ${fmt(goal)}` : ''}`
    : 'Bar chart, no data';
  return html`<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${summary}" style="display:block;height:auto">
    <line x1="0" x2="${W}" y1="${TOP + PLOT}" y2="${TOP + PLOT}" stroke="var(--ink)" stroke-width="1"/>
    ${bars.map((b, i) => {
      let base = TOP + PLOT;
      const x = i * slot + (slot - bw) / 2;
      return html`<g>
        <title>${b.label}: ${fmt(totals[i]!)}</title>
        ${b.values.map((v, k) => { if (v <= 0) return ''; base -= y(v); return html`<rect x="${x.toFixed(1)}" y="${base.toFixed(1)}" width="${bw.toFixed(1)}" height="${y(v).toFixed(1)}" fill="${colors[k % colors.length]}" stroke="var(--ink)" stroke-width="1"/>`; })}
        ${i % every === 0 ? html`<text x="${(x + bw / 2).toFixed(1)}" y="${H - 3}" text-anchor="middle" font-size="9" fill="var(--muted)">${b.label}</text>` : ''}
      </g>`;
    })}
    ${goal != null ? html`<line class="goal" x1="0" x2="${W}" y1="${(TOP + PLOT - y(goal)).toFixed(1)}" y2="${(TOP + PLOT - y(goal)).toFixed(1)}" stroke="var(--red)" stroke-width="1.5" stroke-dasharray="4 3"/>` : ''}
  </svg>`;
}
