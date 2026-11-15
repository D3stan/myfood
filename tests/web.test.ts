import { describe, expect, test } from 'vitest';
import { ApiError } from '../src/web/api.ts';
import { html, htmlToString } from '../src/web/html.ts';
import { flush } from '../src/web/outbox.ts';
import { applyOps } from '../src/shared/stock.ts';
import type { PendingOp, State } from '../src/shared/types.ts';
import { enqueueEvent, enqueueUndo, newStore, openSheet, receive, stepQ, qOf, view } from '../src/web/store.ts';
import { appHtml, sheetHtml, toastHtml } from '../src/web/ui/render.ts';
import { groupByDay } from '../src/web/ui/screens/history.ts';
import { heroPreset } from '../src/web/ui/screens/pantry.ts';
import { fixture } from './fixture.ts';

const fresh = () => newStore(structuredClone(fixture));
const eggs = (s: ReturnType<typeof fresh>) => view(s)!.items.find(i => i.id === 1)!.stock;
const eat3 = (s: ReturnType<typeof fresh>) => enqueueEvent(s, { kind: 'eat', lines: [{ item_id: 1, qty: 3 }] });
const str = (h: ReturnType<typeof html>) => htmlToString(h);

describe('html', () => {
  test('escapes strings, attributes and quotes', () => {
    const evil = `<script>alert("x")</script> & 'q'`;
    const out = str(html`<p title="${evil}">${evil}</p>`);
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;');
    expect(out.match(/"/g)).toHaveLength(2); // only the attribute's own quotes are raw
  });
  test('leaves nested html alone, flattens arrays, drops null/undefined/false', () => {
    const inner = html`<b>${'<i>'}</b>`;
    expect(str(html`<p>${inner}</p>`)).toBe('<p><b>&lt;i&gt;</b></p>');
    expect(str(html`${[1, 2].map(n => html`<i>${n}</i>`)}${null}${undefined}${false}x`)).toBe('<i>1</i><i>2</i>x');
  });
});

describe('store', () => {
  test('an optimistic eat shows at once', () => {
    const s = fresh();
    eat3(s);
    expect(eggs(s)).toBe(4);
    expect(view(s)!.events[0]!.lines[0]!.qty).toBe(-3);
    expect(s.server!.items[0]!.stock).toBe(7);
  });

  test('a stale rev is ignored, a newer one replaces state and drops confirmed ops', () => {
    const s = fresh();
    eat3(s);
    const op = s.pending[0]!;
    expect(receive(s, { ...fixture, rev: 41, items: [] })).toBe(false);
    expect(s.server!.rev).toBe(42);
    expect(s.pending).toHaveLength(1);
    expect(receive(s, { ...applyOps(fixture, [op]), rev: 43 })).toBe(true);
    expect(s.server!.rev).toBe(43);
    expect(s.pending).toHaveLength(0);
    expect(eggs(s)).toBe(4);
  });

  test('a failed send keeps the op, a later flush sends it once', async () => {
    const s = fresh();
    eat3(s);
    expect(await flush(s, async () => { throw new ApiError(0, 'offline'); })).toBeNull();
    expect(s.pending).toHaveLength(1);
    const sent: PendingOp[] = [];
    const ok = async (op: PendingOp): Promise<State> => { sent.push(op); return { ...applyOps(s.server!, [op]), rev: s.server!.rev + 1 }; };
    await flush(s, ok);
    await flush(s, ok);
    expect(sent).toHaveLength(1);
    expect(s.pending).toHaveLength(0);
    expect(eggs(s)).toBe(4);
  });

  test('a 4xx drops the op and reports the message', async () => {
    const s = fresh();
    eat3(s);
    expect(await flush(s, async () => { throw new ApiError(400, 'No such item'); })).toBe('No such item');
    expect(s.pending).toHaveLength(0);
    expect(eggs(s)).toBe(7);
  });

  test('undo of an event that was not sent cancels both; one in flight queues an undo', () => {
    const s = fresh();
    const cid = eat3(s);
    enqueueUndo(s, cid);
    expect(s.pending).toHaveLength(0);
    expect(eggs(s)).toBe(7);
    const cid2 = eat3(s);
    s.inflight.add(cid2);
    enqueueUndo(s, cid2);
    expect(s.pending.map(o => o.type)).toEqual(['event', 'undo']);
    expect(eggs(s)).toBe(7);
  });

  test('stepper never goes below zero and accepts partial steps', () => {
    const s = fresh();
    openSheet(s, { t: 'item', id: 2, q: { main: 1 } });
    stepQ(s.ui.sheet!, 'main', -1, 0.5);
    stepQ(s.ui.sheet!, 'main', -1, 0.5);
    stepQ(s.ui.sheet!, 'main', -1, 0.5);
    expect(qOf(s.ui.sheet!, 'main')).toBe(0);
    stepQ(s.ui.sheet!, 'main', 1, 0.5);
    expect(qOf(s.ui.sheet!, 'main')).toBe(0.5);
  });
});

describe('hero preset and history days', () => {
  const at = (h: number, m = 0) => new Date(2026, 10, 15, h, m);
  test('nearest hour within 3 h, and not when already logged today', () => {
    expect(heroPreset(fixture.presets, [], at(9))?.name).toBe('Breakfast');
    expect(heroPreset(fixture.presets, [], at(18))?.name).toBe('Pasta night');
    expect(heroPreset(fixture.presets, [], at(12, 30))).toBeNull();
    const logged = [{ ...fixture.events[1]!, preset_id: 1, at: at(7).getTime() }];
    expect(heroPreset(fixture.presets, logged, at(9))).toBeNull();
    const yesterday = [{ ...fixture.events[1]!, preset_id: 1, at: at(7).getTime() - 86_400_000 }];
    expect(heroPreset(fixture.presets, yesterday, at(9))?.name).toBe('Breakfast');
  });

  test('groups by local day, newest first', () => {
    const ev = (n: number, d: number, h: number) => ({ ...fixture.events[0]!, cid: `c${n}`, at: new Date(2026, 10, d, h).getTime() });
    const g = groupByDay([ev(1, 12, 10), ev(2, 14, 9), ev(3, 15, 8), ev(4, 14, 20)], at(12));
    expect(g.map(x => x.label.length > 9 || x.label)).toEqual(['Today', 'Yesterday', true]);
    expect(g[1]!.events.map(e => e.cid)).toEqual(['c4', 'c2']);
  });
});

describe('render smoke', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const bad = (): ReturnType<typeof fresh> => {
    const f = structuredClone(fixture);
    f.items[0]!.name = evil;
    f.presets[0]!.name = evil;
    f.me.name = evil;
    f.events[1]!.note = evil;
    f.jobs[0]!.result!.reply = evil;
    f.jobs[0]!.result!.events[0]!.lines[0]!.raw = evil;
    f.jobs[0]!.result!.events[0]!.lines[2]!.new_item!.name = evil;
    f.jobs.push({ ...f.jobs[0]!, id: 10, status: 'failed', error: evil, result: null });
    const s = newStore(f);
    s.ui.f = { search: evil, meName: evil, name: evil, text: evil, code: evil };
    s.ui.standalone = false;
    s.ui.toast = { id: 1, msg: evil, cids: ['a'] };
    return s;
  };
  const check = (out: string) => {
    expect(out).not.toContain('<img src=x');
    expect(out).not.toContain('onerror=alert(1)>');
  };

  test('every screen escapes hostile text', () => {
    const s = bad();
    const seen: string[] = [];
    for (const tab of ['pantry', 'history', 'me'] as const) { s.ui.tab = tab; seen.push(appHtml(s, new Date(2026, 10, 15, 8))); }
    s.server = null; s.ui.loggedOut = true;
    seen.push(appHtml(s));
    for (const o of seen) check(o);
    expect(seen[0]).toContain('&lt;img src=x');
    expect(seen[0]).toContain('Running low');
    expect(seen[0]).toContain('Log it');
    expect(seen[3]).toContain('autocapitalize="off"');
  });

  test('every sheet and the toast escape hostile text', () => {
    const s = bad();
    const open = (t: Parameters<typeof openSheet>[1]['t'], id?: number | string, extra = {}) => {
      openSheet(s, { t, id, q: { main: 1, 1: 3 }, lines: [1], ...extra });
      return sheetHtml(s);
    };
    const events = structuredClone(s.server!.jobs[0]!.result!.events);
    const outs = [
      open('item', 1, { more: true }), open('preset', 1), open('presetEdit', 1), open('presetEdit'), open('itemForm'),
      open('event', 'ev-00000002'), open('compose'), open('review', 9, { events, orig: structuredClone(events) }), toastHtml(s),
    ];
    for (const o of outs) { expect(o.length).toBeGreaterThan(20); check(o); }
  });
});
