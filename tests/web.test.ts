import { describe, expect, test, vi } from 'vitest';
import { Idiomorph } from 'idiomorph';
import { ApiError } from '../src/web/api.ts';
import { html, htmlToString } from '../src/web/html.ts';
import { flush } from '../src/web/outbox.ts';
import { isoDate } from '../src/shared/dates.ts';
import { applyOps } from '../src/shared/stock.ts';
import type { BarcodeLookup, PendingOp, State } from '../src/shared/types.ts';
import { enqueueEvent, enqueueUndo, newStore, openSheet, qOf, receive, setQ, stepQ, store as singletonStore, view } from '../src/web/store.ts';
import { actions, findCreatedItem, overdrawWarning, visibleLowItems } from '../src/web/ui/actions.ts';
import { barcodeToFields, bcModeOf, bcTotal, stopScanner } from '../src/web/ui/components/barcode.ts';
import { cookBatchMacros } from '../src/web/ui/components/cook.ts';
import { itemToFields, macroBasis } from '../src/web/ui/components/sheets.ts';
import { appHtml, sheetHtml, toastHtml } from '../src/web/ui/render.ts';
import { groupByDay } from '../src/web/ui/screens/history.ts';
import { heroPreset } from '../src/web/ui/screens/pantry.ts';
import { shortcutText } from '../src/web/ui/settings/shortcuts.ts';
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

describe('v2 sheets and helpers', () => {
  test('macroBasis and itemToFields scale g/ml by 100 and pc/slice/portion by 1', () => {
    expect(macroBasis('g')).toEqual({ mult: 100, label: '100g' });
    expect(macroBasis('ml')).toEqual({ mult: 100, label: '100ml' });
    expect(macroBasis('pc')).toEqual({ mult: 1, label: '1 pc' });
    expect(macroBasis('portion')).toEqual({ mult: 1, label: '1 portion' });

    const beefFields = itemToFields(fixture.items.find(i => i.id === 4)!);
    expect(beefFields.itemKcal).toBe('210');
    expect(beefFields.itemProtein).toBe('20');
    expect(beefFields.itemOwner).toBe('shared');

    const eggFields = itemToFields(fixture.items.find(i => i.id === 1)!);
    expect(eggFields.itemKcal).toBe('78');
    expect(eggFields.itemProtein).toBe('6.3');

    const bologneseFields = itemToFields(fixture.items.find(i => i.id === 9)!);
    expect(bologneseFields.itemOwner).toBe('mine');
    expect(bologneseFields.itemKcal).toBe('140');
    expect(bologneseFields.itemProtein).toBe('9');
  });

  test('cooked meal item sheet shows Portions/Grams toggle and converts portions', () => {
    const s = fresh();
    openSheet(s, { t: 'item', id: 9, q: { main: 1 }, portionMode: true }, itemToFields(fixture.items.find(i => i.id === 9)!));
    const out = sheetHtml(s);
    expect(out).toContain('3 port · 900 g');
    expect(out).toContain('data-a="portionMode"');
    expect(out).toContain('Portions (300g)');
    expect(out).toContain('data-f="buyCost"');
    expect(out).toContain('data-s="cook"');
  });

  test('cookBatchMacros and cookSheet compute macros and g/portion live', () => {
    const s = fresh();
    const m = cookBatchMacros(fixture.items, [4, 6], { 4: 500, 6: 400 });
    expect(m).toEqual({ kcal: 2450, protein: 148, fat: 0, hasKcal: true, hasProtein: true, hasFat: false, carbs: 0, hasCarbs: false });

    openSheet(s, { t: 'cook', id: 9, q: { 4: 500, 6: 400 }, lines: [4, 6] }, {
      cookName: 'Bolognese', cookEmoji: '🍲', cookOwner: 'mine',
      cookPortions: '4', cookGrams: '1200', cookExpiry: '2026-11-19',
    });
    const out = sheetHtml(s);
    expect(out).toContain('300 g / portion');
    expect(out).toContain('Auto from ingredients: 2450 kcal · 148g protein');
    expect(out).toContain('data-f="cookPortions"');
    expect(out).toContain('data-f="cookGrams"');
    expect(out).toContain('data-f="cookKcal"');
    expect(out).toContain('data-f="cookProtein"');
  });

  test('composeSheet mode switch and reviewSheet audit diff + cook batch summary', () => {
    const s = fresh();
    s.ui.jobMode = 'audit';
    openSheet(s, { t: 'compose', q: {}, mode: 'audit' });
    const cmp = sheetHtml(s);
    expect(cmp).toContain('Fridge audit');
    expect(cmp).toContain('data-a="jobMode"');

    // Review sheet for audit job + cook batch
    s.server!.jobs.push({
      id: 11, mode: 'audit', status: 'review', text: '', has_images: true, error: null, event_cids: [], created_at: fixture.now,
      result: {
        reply: 'Checked fridge.',
        events: [{ kind: 'adjust', preset_id: null, lines: [{ item_id: 1, new_item: null, qty: 4, raw: '4 eggs visible' }] }],
        cook: [{ meal_item_id: null, name: 'Chili', emoji: '🌶️', portions: 4, total_g: 1200, expires_in_days: 4, owner: 'shared', kcal_total: 1800, protein_total: 120, ingredients: [{ item_id: 4, qty: 500 }] }],
      },
    });
    openSheet(s, {
      t: 'review', id: 11, q: {},
      events: structuredClone(s.server!.jobs[1]!.result!.events),
      orig: structuredClone(s.server!.jobs[1]!.result!.events),
      cook: structuredClone(s.server!.jobs[1]!.result!.cook),
    });
    const rev = sheetHtml(s);
    expect(rev).toContain('Fridge audit — review adjustments');
    expect(rev).toContain('was 7 → 4 pc');
    expect(rev).toContain('Chili');
    expect(rev).toContain('4 port · 1200 g');
    expect(rev).toContain('Apply adjustments');
  });

  test('barcodeSheet fallback, matched/unmatched states, and stopScanner cleanup', () => {
    const s = fresh();
    const lkUnmatched: BarcodeLookup = {
      found: true, code: '5701234567890', item_id: null,
      product: { code: '5701234567890', product_name: 'Oat Milk', brand: 'Oatly', unit: 'ml', pack_size: 1000, kcal_per_unit: 0.46, protein_per_unit: 0.01, category: 'drinks', source: 'openfoodfacts' },
    };
    const fields = barcodeToFields(lkUnmatched);
    expect(fields.bcKcal).toBe('46');
    expect(fields.bcProtein).toBe('1');
    s.ui.barcodeLookup = lkUnmatched;
    s.ui.f = { ...s.ui.f, ...fields, barcodeCode: '5701234567890' };
    openSheet(s, { t: 'barcode', q: { bc: 1 } }); // the app opens with 1
    const outUnmatched = sheetHtml(s);
    expect(outUnmatched).toContain('Photo of the barcode');
    expect(outUnmatched).toContain('data-c="barcodePhoto"');
    expect(outUnmatched).toContain('Ask the AI instead');
    expect(outUnmatched).toContain('Create &amp; Add');
    expect(outUnmatched).toContain('Or link to existing item');

    s.ui.barcodeLookup = { ...lkUnmatched, item_id: 1 };
    const outMatched = sheetHtml(s);
    expect(outMatched).toContain('Add 10 pc'); // default: 1 pack of 10
    expect(outMatched).toContain('Packs (10 pc)');

    s.ui.scannerActive = true;
    stopScanner(s);
    expect(s.ui.scannerActive).toBe(false);
  });

  test('expenseSheet and spend screen render weekly expenses and locks', () => {
    const s = fresh();
    openSheet(s, { t: 'expense', q: {} }, { expCost: '95.50', expNote: 'Takeout', expDate: '2026-11-15' });
    const expOut = sheetHtml(s);
    expect(expOut).toContain('data-f="expCost"');
    expect(expOut).toContain('data-f="expNote"');
    expect(expOut).toContain('data-f="expDate"');

    s.ui.tab = 'spend';
    const spendOut = appHtml(s, new Date(fixture.now));
    expect(spendOut).toContain('REMA 1000');
    expect(spendOut).toContain('124.50 kr');
    expect(spendOut).toContain('Locked');
    expect(spendOut).toContain('data-a="lockWeek"');
    expect(spendOut).toContain('data-a="exportExpenses"');
  });

  test('visibleLowItems excludes other users personal items and findCreatedItem matches owner_id + nameKey', () => {
    const f = structuredClone(fixture);
    f.items.push(
      { ...fixture.items[0]!, id: 99, name: 'Robins snack', owner_id: 2, stock: 0, low_at: 2 },
      { ...fixture.items[0]!, id: 100, name: 'Sams snack', owner_id: 1, stock: 0, low_at: 2 },
      { ...fixture.items[0]!, id: 101, name: '  eggs  ', owner_id: 1, stock: 0, low_at: null },
    );
    const lowIds = visibleLowItems(f).map(i => i.id);
    expect(lowIds).not.toContain(99);
    expect(lowIds).toContain(100);
    expect(findCreatedItem(f.items, 'Eggs', 1)?.id).toBe(101);
    expect(findCreatedItem(f.items, 'Eggs', null)?.id).toBe(1);
  });

  test('overdrawWarning detects negative stock transitions and ignores >= 0 or level items', () => {
    const f = structuredClone(fixture);
    f.items[0]!.stock = 2; // Eggs (pc)
    f.items[1]!.stock = -1; // Milk (l) already 1 owed
    const levelItem = f.items.find(i => i.unit === 'level')!;

    expect(overdrawWarning(f, [{ item_id: 1, qty: 2 }])).toBeNull();
    expect(overdrawWarning(f, [{ item_id: levelItem.id, qty: 5 }])).toBeNull();

    const single = overdrawWarning(f, [{ item_id: 1, qty: 3 }]);
    expect(single).toBe('Eggs only has 2 pc left (taking 3 pc will leave 1 pc owed). Proceed anyway?');

    const multi = overdrawWarning(f, [{ item_id: 1, qty: 3 }, { item_id: 2, qty: 2 }]);
    expect(multi).toContain('This will overdraw:');
    expect(multi).toContain('Eggs only has 2 pc left');
    expect(multi).toContain('1 slice owed; taking 2 slice will leave 3 slice owed');
  });

  test('pantry and itemSheet render owed debt badge and inline overdraw warning', () => {
    const s = fresh();
    s.server!.items[0]!.stock = -3; // Eggs: 3 owed
    s.server!.items[3]!.stock = 200; // Beef: 200g left
    const pantryOut = appHtml(s, new Date(fixture.now));
    expect(pantryOut).toContain('debt-badge');
    expect(pantryOut).toContain('3 owed');

    openSheet(s, { t: 'item', id: 1, q: { main: 2 } }, itemToFields(s.server!.items[0]!));
    const itemOut = sheetHtml(s);
    expect(itemOut).toContain('debt-badge');
    expect(itemOut).toContain('3 owed');
    expect(itemOut).toContain('3 pc owed from earlier eats — Set exact amount to clear');
    expect(itemOut).toContain('overdraw-warn');

    openSheet(s, { t: 'cook', q: { 4: 500 }, lines: [4] }, {
      cookName: 'Stew', cookEmoji: '🍲', cookOwner: 'shared', cookPortions: '4', cookGrams: '1000', cookExpiry: '2026-11-19',
    });
    const cookOut = sheetHtml(s);
    expect(cookOut).toContain('overdraw-warn compact');
    expect(cookOut).toContain('Only 200 g in stock');
  });

  test('barcode quantity: packs, own unit, level containers; switching keeps the amount', async () => {
    expect(bcTotal(3, 'pack', 'pc', 10)).toBe(30);
    expect(bcTotal(450, 'unit', 'g', 500)).toBe(450);
    expect(bcTotal(0.5, 'pack', 'ml', 1000)).toBe(500);
    expect(bcTotal(2, 'pack', 'level', 7)).toBe(2); // level: always containers
    expect(bcModeOf({ bcMode: 'unit' }, 'level', 7)).toBe('pack');
    expect(bcModeOf({ bcMode: 'unit' }, 'pc', 1)).toBe('pack'); // pack of 1: no toggle

    const prevServer = singletonStore.server, prevPending = singletonStore.pending, prevSheet = singletonStore.ui.sheet;
    const morphSpy = vi.spyOn(Idiomorph, 'morph').mockImplementation(() => []);
    try {
      vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });
      vi.stubGlobal('document', {
        getElementById: () => ({ classList: { toggle() {} }, setAttribute() {}, scrollTop: 0, querySelector: () => null, focus() {} }),
        documentElement: { classList: { toggle() {} } }, activeElement: null, querySelector: () => null, title: '',
      });
      singletonStore.server = structuredClone(fixture);
      singletonStore.pending = [];
      singletonStore.ui.f = { ...singletonStore.ui.f, bcMode: 'pack', buyCost: '' };
      singletonStore.ui.barcodeLookup = { found: true, code: '5701234567890', item_id: 1, product: null };
      openSheet(singletonStore, { t: 'barcode', q: { bc: 3 } });
      const el = (dataset: Record<string, string>) => ({ dataset }) as unknown as HTMLElement;
      expect(sheetHtml(singletonStore)).toContain('= 30 pc');
      await actions.bcMode!(el({ v: 'unit', p: '10' }));
      expect(qOf(singletonStore.ui.sheet!, 'bc')).toBe(30);
      setQ(singletonStore.ui.sheet!, 'bc', 7); // e.g. typed 7 loose eggs
      await actions.barcodeAddPack!(el({ id: '1' }));
      const op = singletonStore.pending[0] as Extract<PendingOp, { type: 'event' }>;
      expect(op.body).toMatchObject({ kind: 'buy', lines: [{ item_id: 1, qty: 7 }] });
      singletonStore.pending = [];
      await new Promise(r => setTimeout(r, 0));
    } finally {
      morphSpy.mockRestore();
      vi.unstubAllGlobals();
      singletonStore.server = prevServer; singletonStore.pending = prevPending; singletonStore.ui.sheet = prevSheet;
    }
  });

  test('item sheet: Eat and Add match, exact amount is typed (level items count containers)', async () => {
    const out = sheetHtml((() => { const s = fresh(); openSheet(s, { t: 'item', id: 1, q: { main: 1 } }); return s; })());
    expect(out).toContain('<button class="btn grow" data-a="eat">Eat</button><button class="btn grow" data-a="add">Add</button>');
    expect(out).toContain('data-a="exactOpen"');

    const prevServer = singletonStore.server, prevPending = singletonStore.pending, prevSheet = singletonStore.ui.sheet;
    const morphSpy = vi.spyOn(Idiomorph, 'morph').mockImplementation(() => []);
    try {
      vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });
      vi.stubGlobal('document', {
        getElementById: () => ({ classList: { toggle() {} }, setAttribute() {}, scrollTop: 0, querySelector: () => null, focus() {} }),
        documentElement: { classList: { toggle() {} } }, activeElement: null, querySelector: () => null, title: '',
      });
      singletonStore.server = structuredClone(fixture);
      singletonStore.pending = [];
      openSheet(singletonStore, { t: 'item', id: 8, q: {} }); // Salt, level
      expect(sheetHtml(singletonStore)).toContain('Set exact count');
      await actions.exactOpen!({ dataset: {} } as unknown as HTMLElement);
      expect(sheetHtml(singletonStore)).toContain('data-submit="setExact"');
      singletonStore.ui.f.exact = '2,5';
      await actions.setExact!({ dataset: {} } as unknown as HTMLElement);
      const op = singletonStore.pending[0] as Extract<PendingOp, { type: 'event' }>;
      expect(op.body).toMatchObject({ kind: 'adjust', lines: [{ item_id: 8, qty: 2.5 }] });
      expect(view(singletonStore)!.items.find(i => i.id === 8)!.stock).toBe(2.5);
      singletonStore.pending = []; // nothing left for the background flush to send
      await new Promise(r => setTimeout(r, 0));
    } finally {
      morphSpy.mockRestore();
      vi.unstubAllGlobals();
      singletonStore.server = prevServer; singletonStore.pending = prevPending; singletonStore.ui.sheet = prevSheet;
    }
  });

  test('eat paths abort when confirm returns false and proceed into negative stock when true', async () => {
    const prevServer = singletonStore.server;
    const prevPending = singletonStore.pending;
    const prevSheet = singletonStore.ui.sheet;
    const prevConfirm = globalThis.confirm;
    const prevWindow = globalThis.window;
    const prevDoc = globalThis.document;
    const morphSpy = vi.spyOn(Idiomorph, 'morph').mockImplementation(() => []);

    try {
      const f = structuredClone(fixture);
      f.items[0]!.stock = 2; // Eggs
      singletonStore.server = f;
      singletonStore.pending = [];

      const fakeEl = (dataset: Record<string, string>) => ({ dataset }) as unknown as HTMLElement;

      // 1. Cancel on take, eat, logPreset, saveCook
      globalThis.confirm = vi.fn(() => false);
      await actions.take!(fakeEl({ id: '1' }));
      expect(singletonStore.pending).toHaveLength(0);
      expect(view(singletonStore)!.items[0]!.stock).toBe(2);

      openSheet(singletonStore, { t: 'item', id: 1, q: { main: 5 } });
      await actions.eat!(fakeEl({}));
      expect(singletonStore.pending).toHaveLength(0);
      expect(singletonStore.ui.sheet?.t).toBe('item');

      openSheet(singletonStore, { t: 'preset', id: 1, q: { 1: 4 } });
      await actions.logPreset!(fakeEl({}));
      expect(singletonStore.pending).toHaveLength(0);
      expect(singletonStore.ui.sheet?.t).toBe('preset');

      vi.stubGlobal('navigator', { onLine: true });
      openSheet(singletonStore, { t: 'cook', q: { 1: 4 }, lines: [1] }, {
        cookName: 'Omelette', cookPortions: '2', cookGrams: '300', cookExpiry: '2026-11-19',
      });
      await actions.saveCook!(fakeEl({}));
      expect(singletonStore.ui.sheet?.t).toBe('cook');
      expect((globalThis.confirm as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);

      // 2. Proceed on eat when confirm returns true -> creates negative stock
      globalThis.confirm = vi.fn(() => true);
      vi.stubGlobal('window', { setTimeout: () => 0 });
      vi.stubGlobal('document', {
        getElementById: () => ({ classList: { toggle() {} }, setAttribute() {}, scrollTop: 0, querySelector: () => null, focus() {} }),
        documentElement: { classList: { toggle() {} } },
        activeElement: null,
        querySelector: () => null,
        title: '',
      });
      openSheet(singletonStore, { t: 'item', id: 1, q: { main: 5 } });
      await actions.eat!(fakeEl({}));
      expect(singletonStore.pending).toHaveLength(1);
      expect(view(singletonStore)!.items[0]!.stock).toBe(-3);
      expect(singletonStore.ui.sheet).toBeNull();
      await new Promise(r => setTimeout(r, 0));
    } finally {
      morphSpy.mockRestore();
      vi.unstubAllGlobals();
      globalThis.confirm = prevConfirm;
      globalThis.window = prevWindow;
      globalThis.document = prevDoc;
      singletonStore.server = prevServer;
      singletonStore.pending = prevPending;
      singletonStore.ui.sheet = prevSheet;
    }
  });
});

describe('item price field', () => {
  test('per-unit price shows per macro basis, empty = unknown, and saves back as per-unit cents', async () => {
    const beef = { ...fixture.items.find(i => i.id === 4)!, cost_per_unit_cents: 0.8 }; // g item: 0.8 cents/g
    expect(itemToFields(beef).itemPrice).toBe('0.80');
    expect(itemToFields({ ...beef, unit: 'pc', cost_per_unit_cents: 2495 }).itemPrice).toBe('24.95');
    expect(itemToFields({ ...beef, cost_per_unit_cents: null }).itemPrice).toBe('');

    let sent: Record<string, unknown> | undefined;
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });
    vi.stubGlobal('document', { getElementById: () => null, documentElement: { classList: { toggle() {} } }, activeElement: null, querySelector: () => null, title: '' });
    vi.stubGlobal('fetch', async (_p: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response(JSON.stringify(fixture)); });
    const morph = vi.spyOn(Idiomorph, 'morph').mockImplementation(() => []);
    const prevServer = singletonStore.server, prevSheet = singletonStore.ui.sheet;
    try {
      singletonStore.server = structuredClone(fixture);
      openSheet(singletonStore, { t: 'item', id: 4, q: { main: 1 } }, itemToFields(beef));
      await actions.saveItem!({ dataset: {} } as unknown as HTMLElement);
      expect(sent!.cost_per_unit_cents).toBe(0.8);
      openSheet(singletonStore, { t: 'item', id: 4, q: { main: 1 } }, { ...itemToFields(beef), itemPrice: '' });
      await actions.saveItem!({ dataset: {} } as unknown as HTMLElement);
      expect(sent!.cost_per_unit_cents).toBeNull();
    } finally {
      morph.mockRestore();
      vi.unstubAllGlobals();
      singletonStore.server = prevServer;
      singletonStore.ui.sheet = prevSheet;
    }
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
    f.expenses[0]!.note = evil;
    f.jobs[0]!.result!.reply = evil;
    f.jobs[0]!.result!.events[0]!.lines[0]!.raw = evil;
    f.jobs[0]!.result!.events[0]!.lines[2]!.new_item!.name = evil;
    f.jobs[0]!.result!.cook = [{
      meal_item_id: null, name: evil, emoji: '🍲', portions: 2, total_g: 600,
      expires_in_days: 4, owner: 'shared', kcal_total: 900, protein_total: 60,
      ingredients: [{ item_id: 1, qty: 2 }],
    }];
    f.jobs.push({ ...f.jobs[0]!, id: 10, status: 'failed', error: evil, result: null });
    const s = newStore(f);
    s.ui.f = {
      search: evil, meName: evil, name: evil, text: evil, code: evil,
      cookName: evil, expNote: evil, bcName: evil, currency: evil, tokenName: evil,
    };
    s.ui.newToken = evil;
    s.ui.barcodeLookup = {
      found: true, code: '12345678', item_id: null,
      product: { code: '12345678', product_name: evil, brand: evil, unit: 'g', pack_size: 100, kcal_per_unit: 1, protein_per_unit: 0.1, category: 'pantry', source: 'openfoodfacts' },
    };
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
    for (const tab of ['pantry', 'spend', 'history', 'me'] as const) {
      s.ui.tab = tab;
      seen.push(appHtml(s, new Date(2026, 10, 15, 8)));
    }
    s.server = null; s.ui.loggedOut = true;
    seen.push(appHtml(s));
    for (const o of seen) check(o);
    expect(seen[0]).toContain('&lt;img src=x');
    expect(seen[0]).toContain('Running low');
    expect(seen[0]).toContain('Eat soon');
    expect(seen[0]).toContain('Log it');
    expect(seen[4]).toContain('autocapitalize="off"');
  });

  test('every sheet and the toast escape hostile text', () => {
    const s = bad();
    const open = (t: Parameters<typeof openSheet>[1]['t'], id?: number | string, extra = {}) => {
      openSheet(s, { t, id, q: { main: 1, 1: 3 }, lines: [1], ...extra });
      return sheetHtml(s);
    };
    const events = structuredClone(s.server!.jobs[0]!.result!.events);
    const cook = structuredClone(s.server!.jobs[0]!.result!.cook);
    const outs = [
      open('item', 1, { more: true }), open('item', 9, { portionMode: true }),
      open('preset', 1), open('presetEdit', 1), open('presetEdit'), open('itemForm'),
      open('event', 'ev-00000002'), open('compose'),
      open('review', 9, { events, orig: structuredClone(events), cook }),
      open('cook', 9), open('barcode'), open('expense'),
      toastHtml(s),
    ];
    for (const o of outs) { expect(o.length).toBeGreaterThan(20); check(o); }
  });
});

describe('siri shortcuts and guest card', () => {
  test('Siri page offers both shortcuts with copyable setup text; household page has the guest passcode', () => {
    const s = fresh();
    s.ui.page = ['siri'];
    const out = appHtml(s);
    expect(out).toContain('MyFood AI');
    expect(out).toContain('Log meal');
    expect(out).toContain('data-a="copyShortcut" data-k="ai"');
    expect(out).toContain('data-a="copyShortcut" data-k="log"');
    expect(out).toContain('data-a="createToken"');
    // no token yet: the text says where to paste it
    expect(out).toContain('&lt;PASTE YOUR TOKEN HERE&gt;');
    s.ui.newToken = 'mf_secret123';
    expect(appHtml(s)).toContain('Bearer mf_secret123');
    s.ui.page = ['household'];
    const hh = appHtml(s);
    expect(hh).toContain('abcd-2345');
    expect(hh).toContain('data-a="newGuestCode"');
    expect(hh).toContain('data-a="saveSettings"');
  });
  test('Me shows the settings gear; settings pages render their controls with a Back button', () => {
    const s = fresh();
    s.ui.tab = 'me';
    expect(appHtml(s)).toContain('data-a="go" data-p="settings"');
    s.ui.page = ['settings'];
    const root = appHtml(s);
    for (const p of ['profile', 'household', 'presets', 'siri']) expect(root).toContain(`data-p="${p}"`);
    expect(root).toContain('data-a="logout"');
    expect(root).toContain('data-a="back"');
    expect(root).toContain('data-a="tab"'); // tab bar stays
    const key: Record<string, string> = { profile: 'data-a="saveMe"', presets: 'data-s="presetEdit"' };
    for (const [p, needle] of Object.entries(key)) { s.ui.page = ['settings', p]; expect(appHtml(s)).toContain(needle); }
  });
  test('goals page renders four inputs prefilled from me.goals; Nutrition goals row is in settings', () => {
    const s = fresh();
    s.server!.me.goals = { kcal: 2000, protein_g: 120, fat_g: null, carbs_g: 250.5 };
    s.ui.page = ['settings'];
    expect(appHtml(s)).toContain('data-p="goals"');
    s.ui.page = ['settings', 'goals'];
    const out = appHtml(s);
    expect(out).toContain('data-a="saveGoals"');
    for (const [k, v] of [['kcal', '2000'], ['protein_g', '120'], ['fat_g', ''], ['carbs_g', '250.5']]) expect(out).toMatch(new RegExp(`data-f="goal_${k}" value="${v}"`));
  });
  test('saveGoals rejects non-positive input without sending a request', async () => {
    const s = singletonStore;
    s.server = structuredClone(fixture);
    s.ui.f.goal_kcal = '0';
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await actions.saveGoals!({ dataset: {} } as unknown as HTMLElement);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(s.ui.toast?.msg).toContain('positive');
    } finally { fetchSpy.mockRestore(); vi.unstubAllGlobals(); delete s.ui.f.goal_kcal; }
  });
  describe('Today card on Me', () => {
    const day = (user_id: number, kcal: number, carbs_g: number | null = 100) => ({ day: isoDate(Date.now()), user_id, kcal, protein_g: 50, fat_g: 30, carbs_g });
    const meHtml = (goals: Partial<State['me']['goals']>, daily: State['daily_nutrition']) => {
      const s = fresh();
      s.server!.me.goals = { kcal: null, protein_g: null, fat_g: null, carbs_g: null, ...goals };
      s.server!.daily_nutrition = daily;
      s.ui.tab = 'me';
      return appHtml(s);
    };
    test('no goals: bare numbers, no bars, Set goals link', () => {
      const out = meHtml({}, [day(1, 1240)]);
      expect(out).toContain('1,240 kcal');
      expect(out).not.toContain('class="bar');
      expect(out).toContain('data-a="go" data-p="goals"');
    });
    test('with goals: value / goal, bars, no Set goals link', () => {
      const out = meHtml({ kcal: 2000, protein_g: 100 }, [day(1, 1240)]);
      expect(out).toContain('1,240 / 2,000 kcal');
      expect(out).toContain('50 / 100 g');
      expect(out).toContain('width:62%');
      expect(out).not.toContain('data-p="goals"');
    });
    test('over goal: full bar with over style, number not clamped', () => {
      const out = meHtml({ kcal: 2000 }, [day(1, 2500)]);
      expect(out).toContain('2,500 / 2,000 kcal');
      expect(out).toContain('class="bar over"');
      expect(out).toContain('width:100%');
    });
    test('carbs null shows a dash', () => {
      expect(meHtml({ carbs_g: 200 }, [day(1, 500, null)])).toContain('—');
    });
    test('only the signed-in user counts', () => {
      const out = meHtml({}, [day(1, 700), day(2, 900)]);
      expect(out).toContain('700 kcal');
      expect(out).not.toContain('1,600');
      expect(out).not.toContain('900');
    });
  });
  test('shortcutText names the endpoints and the mode of each shortcut', () => {
    const ai = shortcutText('ai', 'https://x.test', 'tok');
    expect(ai).toContain('"https://x.test/api/shortcut"');
    expect(ai).toContain('"mode" = "ai"');
    expect(ai).not.toContain('/meals');
    const log = shortcutText('log', 'https://x.test', 'tok');
    expect(log).toContain('"https://x.test/api/shortcut/meals"');
    expect(log).toContain('"mode" = "log"');
  });
});
