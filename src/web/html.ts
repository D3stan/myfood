// Every piece of HTML in the app goes through `html`. Interpolated values are escaped
// unless they are themselves an `html` result. Item names, notes and AI replies are hostile input.
class Html {
  s: string;
  constructor(s: string) { this.s = s; }
}
export type { Html };

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const part = (v: unknown): string =>
  v instanceof Html ? v.s
  : Array.isArray(v) ? v.map(part).join('')
  : v == null || v === false ? ''
  : String(v).replace(/[&<>"']/g, c => ESC[c]!);

export const html = (strings: TemplateStringsArray, ...vals: unknown[]): Html =>
  new Html(strings.reduce((out, s, i) => out + s + (i < vals.length ? part(vals[i]) : ''), ''));

export const htmlToString = (h: Html): string => h.s;
