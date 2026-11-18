import { afterEach, describe, expect, test, vi } from 'vitest';
import { Idiomorph } from 'idiomorph';
import { isoDate, isoWeek } from '../src/shared/dates.ts';
import type { State } from '../src/shared/types.ts';
import { api, createToken, lookupBarcode, useFake } from '../src/web/api.ts';
import { buildDemoExpenseExport, createDemoApi, createDemoState } from '../src/web/demo.ts';
import { newStore, openSheet, store as singletonStore } from '../src/web/store.ts';
import { actions } from '../src/web/ui/actions.ts';
import { TOUR_STEPS, isTourVisible, tourHtml } from '../src/web/ui/components/tour.ts';
import { enterDemo, exitDemo, signedOut, sync } from '../src/web/ui/helpers.ts';
import { appHtml } from '../src/web/ui/render.ts';
import { heroPreset } from '../src/web/ui/screens/pantry.ts';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

function stubMinimalDom(): () => void {
  const morphSpy = vi.spyOn(Idiomorph, 'morph').mockImplementation(() => []);
  vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {}, scrollTo: () => {} });
  vi.stubGlobal('document', {
    getElementById: () => ({ classList: { toggle() {} }, setAttribute() {}, scrollTop: 0, querySelector: () => null, focus() {} }),
    documentElement: { classList: { toggle() {} } },
    activeElement: null,
    querySelector: () => null,
    title: '',
  });
  return () => { morphSpy.mockRestore(); };
}

afterEach(() => {
  useFake(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  singletonStore.server = null;
  singletonStore.pending = [];
  singletonStore.inflight.clear();
  singletonStore.flushing = false;
  singletonStore.ui.demo = false;
  singletonStore.ui.tour = null;
  singletonStore.ui.sheet = null;
  singletonStore.ui.page = [];
  singletonStore.ui.tab = 'pantry';
  singletonStore.ui.loggedOut = false;
  singletonStore.ui.toast = null;
  singletonStore.ui.f = {};
});

describe('createDemoState', () => {
  test('populates every screen across different days and times including Monday 00:05', () => {
    const times = [
      new Date(2026, 10, 16, 0, 5).getTime(),   // Monday 00:05
      new Date(2026, 10, 18, 13, 15).getTime(), // Wednesday afternoon
      new Date(2026, 10, 20, 19, 30).getTime(), // Friday evening
      new Date(2026, 10, 22, 23, 55).getTime(), // Sunday late night
    ];

    for (const now of times) {
      const st = createDemoState(now);
      const s = newStore(st);
      s.ui.demo = true;

      expect(heroPreset(st.presets, st.events, new Date(now))).not.toBeNull();

      s.ui.tab = 'pantry';
      const pantryOut = appHtml(s, new Date(now));
      expect(pantryOut).toContain('id="demo-bar"');
      expect(pantryOut).toContain('id="hero"');
      expect(pantryOut).toContain('id="eat-soon"');
      expect(pantryOut).toContain('id="low"');
      expect(pantryOut).toContain('Have a look');
      expect(pantryOut).toContain('Oat milk');

      s.ui.tab = 'spend';
      const spendOut = appHtml(s, new Date(now));
      expect(spendOut).toContain('REMA 1000');
      expect(spendOut).toContain('Bakery &amp; coffee');
      expect(spendOut).not.toContain('No expenses logged yet');
      s.ui.frames.spend = { frame: 'week', offset: -1 };
      expect(appHtml(s, new Date(now))).toContain('Locked');

      s.ui.tab = 'history';
      const historyOut = appHtml(s, new Date(now));
      expect(historyOut).toContain('Today');
      expect(historyOut).toContain('Yesterday');
      expect(historyOut).toContain('macro-pill');

      s.ui.tab = 'me';
      const meOut = appHtml(s, new Date(now));
      expect(meOut).toContain('/ 2,200 kcal');
      expect(meOut).toContain('Daily average');
      expect(meOut).not.toContain('0 of');
    }
  });
});

describe('createDemoApi', () => {
  test('handles events, items, cook, presets, jobs, expenses, settings, barcodes, and tokens locally', async () => {
    const fixedNow = new Date(2026, 10, 18, 12, 0).getTime();
    const initial = createDemoState(fixedNow);
    const handler = createDemoApi(initial);

    // GET /api/state does not bump rev
    const s0 = (await handler('GET', '/api/state')) as State;
    expect(s0.rev).toBe(initial.rev);

    // POST /api/events + PATCH + DELETE
    const eggs = s0.items.find(i => i.name === 'Eggs')!;
    const cid = 'demo-test-ev-1';
    const s1 = (await handler('POST', '/api/events', {
      cid,
      at: fixedNow,
      kind: 'eat',
      lines: [{ item_id: eggs.id, qty: 2 }],
    })) as State;
    expect(s1.rev).toBe(s0.rev + 1);
    expect(s1.items.find(i => i.id === eggs.id)!.stock).toBe(eggs.stock - 2);

    const s2 = (await handler('PATCH', `/api/events/${cid}`, {
      lines: [{ item_id: eggs.id, qty: 4 }],
    })) as State;
    expect(s2.items.find(i => i.id === eggs.id)!.stock).toBe(eggs.stock - 4);

    const s3 = (await handler('DELETE', `/api/events/${cid}`)) as State;
    expect(s3.items.find(i => i.id === eggs.id)!.stock).toBe(eggs.stock);
    expect(s3.events.some(e => e.cid === cid)).toBe(false);

    // Level item undo restores prior stock
    const salt = s3.items.find(i => i.name === 'Salt')!;
    const lvlCid = 'demo-test-lvl-1';
    const sLvl = (await handler('POST', '/api/events', {
      cid: lvlCid,
      at: fixedNow,
      kind: 'eat',
      lines: [{ item_id: salt.id, qty: 0 }],
    })) as State;
    expect(sLvl.items.find(i => i.id === salt.id)!.stock).toBe(0);
    const sLvlUndone = (await handler('DELETE', `/api/events/${lvlCid}`)) as State;
    expect(sLvlUndone.items.find(i => i.id === salt.id)!.stock).toBe(salt.stock);

    // Items CRUD + duplicate guard
    const sItem = (await handler('POST', '/api/items', {
      name: 'Skyr',
      emoji: '🥣',
      category: 'dairy',
      unit: 'g',
      step: 100,
      pack_size: 500,
      low_at: 100,
    })) as State;
    const skyr = sItem.items.find(i => i.name === 'Skyr')!;
    expect(skyr).toBeDefined();
    await expect(handler('POST', '/api/items', {
      name: 'skyr',
      emoji: '🥣',
      category: 'dairy',
      unit: 'g',
      step: 100,
      pack_size: 500,
      low_at: null,
    })).rejects.toThrow(/already in the pantry/);
    const sItemPatched = (await handler('PATCH', `/api/items/${skyr.id}`, { name: 'Skyr 0%' })) as State;
    expect(sItemPatched.items.find(i => i.id === skyr.id)!.name).toBe('Skyr 0%');
    const sItemDel = (await handler('DELETE', `/api/items/${skyr.id}`)) as State;
    expect(sItemDel.items.some(i => i.id === skyr.id)).toBe(false);

    // Cook meal
    const fusilli = sItemDel.items.find(i => i.name === 'Fusilli')!;
    const sCook = (await handler('POST', '/api/meals/cook', {
      cid: 'demo-cook-test',
      at: fixedNow,
      name: 'Pasta salad',
      emoji: '🥗',
      portions: 3,
      total_g: 900,
      expires_at: isoDate(fixedNow + 3 * 86_400_000),
      kcal_total: 1200,
      protein_total: 45,
      ingredients: [{ item_id: fusilli.id, qty: 200 }],
    })) as State;
    expect(sCook.items.find(i => i.name === 'Pasta salad')?.portion_g).toBe(300);
    expect(sCook.items.find(i => i.id === fusilli.id)!.stock).toBe(fusilli.stock - 200);

    // Presets CRUD
    const sPreset = (await handler('POST', '/api/presets', {
      name: 'Snack',
      emoji: '🍎',
      hour: 15,
      lines: [{ item_id: eggs.id, qty: 1 }],
    })) as State;
    const snack = sPreset.presets.find(p => p.name === 'Snack')!;
    expect(snack).toBeDefined();
    const sPreset2 = (await handler('PATCH', `/api/presets/${snack.id}`, {
      name: 'Afternoon snack',
      emoji: '🍏',
      hour: 16,
      lines: [{ item_id: eggs.id, qty: 2 }],
    })) as State;
    expect(sPreset2.presets.find(p => p.id === snack.id)?.name).toBe('Afternoon snack');
    const sPreset3 = (await handler('DELETE', `/api/presets/${snack.id}`)) as State;
    expect(sPreset3.presets.some(p => p.id === snack.id)).toBe(false);

    // Jobs: submit + apply (seeded job #1 with new_item Butter) + delete
    const fd = new FormData();
    fd.append('text', 'Bought 6 eggs');
    fd.append('mode', 'auto');
    const sJob = (await handler('POST', '/api/jobs', fd)) as State;
    expect(sJob.jobs[0]!.status).toBe('review');
    expect(sJob.jobs[0]!.result!.events[0]!.lines[0]!.item_id).toBe(eggs.id);
    const createdJobId = sJob.jobs[0]!.id;
    const sJobDel = (await handler('DELETE', `/api/jobs/${createdJobId}`)) as State;
    expect(sJobDel.jobs.some(j => j.id === createdJobId)).toBe(false);

    const seededJob = sJobDel.jobs.find(j => j.id === 1)!;
    const sApplied = (await handler('POST', '/api/jobs/1/apply', {
      events: seededJob.result!.events,
    })) as State;
    expect(sApplied.jobs.some(j => j.id === 1)).toBe(false);
    expect(sApplied.items.some(i => i.name === 'Butter')).toBe(true);

    // Expenses + lock + export
    const sExp = (await handler('POST', '/api/expenses', {
      cid: 'demo-exp-1',
      at: fixedNow,
      cost_cents: 5500,
      note: 'Coffee beans',
    })) as State;
    expect(sExp.expenses.some(e => e.cid === 'demo-exp-1')).toBe(true);

    const curWeek = isoWeek(fixedNow);
    const sLocked = (await handler('POST', '/api/expenses/lock', { period: curWeek })) as State;
    expect(sLocked.expense_locks.some(l => l.period === curWeek)).toBe(true);
    await expect(handler('POST', '/api/expenses', {
      cid: 'demo-exp-2',
      at: fixedNow,
      cost_cents: 1000,
      note: 'Blocked',
    })).rejects.toThrow(/locked/);

    const csvOut = buildDemoExpenseExport(sLocked, curWeek, 'csv');
    expect(csvOut.body).toContain('Coffee beans');
    expect(csvOut.body).toContain('55.00');
    const jsonOut = buildDemoExpenseExport(sLocked, curWeek, 'json');
    expect(JSON.parse(jsonOut.body).expenses.some((e: { note: string | null }) => e.note === 'Coffee beans')).toBe(true);

    // Me, settings, guest code, barcodes, tokens
    const sMe = (await handler('PATCH', '/api/me', { name: 'Sammy', goals: { kcal: 2400 } })) as State;
    expect(sMe.me.name).toBe('Sammy');
    expect(sMe.me.goals.kcal).toBe(2400);

    const sSet = (await handler('PATCH', '/api/settings', { currency: 'EUR' })) as State;
    expect(sSet.currency).toBe('EUR');

    const sGuest = (await handler('POST', '/api/guest/code')) as State;
    expect(sGuest.guest_code).toMatch(/^demo-\d{4}$/);

    useFake(handler);
    const lk = await lookupBarcode('12345678');
    expect(lk.found).toBe(true);
    expect(lk.item_id).toBeNull();
    await api('POST', '/api/barcodes/link', { code: '12345678', item_id: eggs.id });
    const lk2 = await lookupBarcode('12345678');
    expect(lk2.item_id).toBe(eggs.id);

    const tokRes = await createToken({ name: 'Demo MCP', scope: 'mcp' });
    expect(tokRes.token).toMatch(/^mf_demo_/);
    expect(tokRes.state.tokens.some(t => t.name === 'Demo MCP')).toBe(true);
    const sRevoked = await api('DELETE', `/api/tokens/${tokRes.info.id}`);
    expect(sRevoked.tokens.some(t => t.id === tokRes.info.id)).toBe(false);
  });
});

describe('login button, demo banner, and tour navigation', () => {
  test('login screen renders Try the demo button and demo banner renders Tour and Exit', () => {
    const s = newStore();
    s.ui.loggedOut = true;
    const loginOut = appHtml(s);
    expect(loginOut).toContain('id="demo-start"');
    expect(loginOut).toContain('data-a="startDemo"');
    expect(loginOut).toContain('Try the demo');

    const demoStore = newStore(createDemoState());
    demoStore.ui.demo = true;
    const demoOut = appHtml(demoStore);
    expect(demoOut).toContain('id="demo-bar"');
    expect(demoOut).toContain('Demo mode');
    expect(demoOut).toContain('data-a="tourStart"');
    expect(demoOut).toContain('data-a="exitDemo"');
  });

  test('tourHtml hides when inactive, when a sheet is open, or on a subpage', () => {
    const s = newStore(createDemoState());
    s.ui.demo = true;
    expect(tourHtml(s)).toBe('');

    s.ui.tour = { step: 0 };
    expect(isTourVisible(s)).toBe(true);
    const step0 = tourHtml(s);
    expect(step0).toContain('1 / 6');
    expect(step0).not.toContain('data-a="tourPrev"');
    expect(step0).toContain('data-a="tourNext"');
    expect(step0).toContain('Next');

    s.ui.tour = { step: TOUR_STEPS.length - 1 };
    const last = tourHtml(s);
    expect(last).toContain('6 / 6');
    expect(last).toContain('data-a="tourPrev"');
    expect(last).toContain('Done');

    openSheet(s, { t: 'compose', q: {} });
    expect(isTourVisible(s)).toBe(false);
    expect(tourHtml(s)).toBe('');

    s.ui.sheet = null;
    s.ui.page = ['settings'];
    expect(isTourVisible(s)).toBe(false);
    expect(tourHtml(s)).toBe('');
  });

  test('tour actions advance tabs cleanly and finish or skip', async () => {
    const cleanup = stubMinimalDom();
    try {
      const storage = fakeStorage();
      vi.stubGlobal('localStorage', storage);
      enterDemo({ tour: true });
      expect(singletonStore.ui.tab).toBe('pantry');
      expect(singletonStore.ui.tour?.step).toBe(0);

      const el = {} as HTMLElement;
      await actions.tourNext!(el);
      expect(singletonStore.ui.tour?.step).toBe(1);
      expect(singletonStore.ui.tab).toBe('pantry');

      await actions.tourNext!(el);
      expect(singletonStore.ui.tour?.step).toBe(2);
      expect(singletonStore.ui.tab).toBe('pantry');

      await actions.tourNext!(el);
      expect(singletonStore.ui.tour?.step).toBe(3);
      expect(singletonStore.ui.tab).toBe('spend');

      await actions.tourNext!(el);
      expect(singletonStore.ui.tour?.step).toBe(4);
      expect(singletonStore.ui.tab).toBe('history');

      await actions.tourNext!(el);
      expect(singletonStore.ui.tour?.step).toBe(5);
      expect(singletonStore.ui.tab).toBe('me');

      await actions.tourPrev!(el);
      expect(singletonStore.ui.tour?.step).toBe(4);
      expect(singletonStore.ui.tab).toBe('history');

      await actions.tourNext!(el);
      await actions.tourNext!(el);
      expect(singletonStore.ui.tour).toBeNull();

      await actions.tourStart!(el);
      expect(singletonStore.ui.tour?.step).toBe(0);
      expect(singletonStore.ui.tab).toBe('pantry');

      await actions.tourSkip!(el);
      expect(singletonStore.ui.tour).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe('demo isolation from localStorage and clean exit', () => {
  test('demo mutations never overwrite real myfood:v1 and exitDemo strips ?demo and restores saved state', async () => {
    const cleanup = stubMinimalDom();
    try {
      const realState: State = { ...createDemoState(new Date(2026, 10, 10, 9, 0).getTime()), rev: 99, currency: 'DKK' };
      const realPending = [{ type: 'undo' as const, cid: 'real-pending-1' }];
      const savedPayload = JSON.stringify({ server: realState, pending: realPending });
      const storage = fakeStorage({ 'myfood:v1': savedPayload });
      vi.stubGlobal('localStorage', storage);
      vi.stubGlobal('navigator', { onLine: true });

      let currentUrl = 'https://myfood.test/?demo=1&keep=yes';
      const replaceState = vi.fn((_state: unknown, _unused: string, url: string) => { currentUrl = url; });
      vi.stubGlobal('location', { href: currentUrl, search: '?demo=1&keep=yes' });
      vi.stubGlobal('history', { replaceState });

      enterDemo({ tour: true });
      expect(singletonStore.ui.demo).toBe(true);
      expect(singletonStore.server?.rev).toBe(1);

      // Mutate inside demo: sync, take, saveSettings, signedOut
      const eggId = singletonStore.server!.items.find(i => i.name === 'Eggs')!.id;
      await actions.take!({ dataset: { id: String(eggId) } } as unknown as HTMLElement);
      singletonStore.ui.f.currency = 'USD';
      await actions.saveSettings!({ dataset: {} } as unknown as HTMLElement);
      sync();
      expect(storage.getItem('myfood:v1')).toBe(savedPayload);

      // Exit demo restores real saved state and strips ?demo without wiping localStorage
      exitDemo();
      expect(singletonStore.ui.demo).toBe(false);
      expect(singletonStore.ui.tour).toBeNull();
      expect(singletonStore.ui.loggedOut).toBe(false);
      expect(singletonStore.server?.rev).toBe(99);
      expect(singletonStore.server?.currency).toBe('DKK');
      expect(singletonStore.pending).toEqual(realPending);
      expect(replaceState).toHaveBeenCalledTimes(1);
      expect(currentUrl).toBe('/?keep=yes');
      expect(storage.getItem('myfood:v1')).toBe(savedPayload);

      // Calling signedOut in demo mode also exits cleanly without clearing localStorage
      enterDemo({ tour: false });
      signedOut();
      expect(singletonStore.ui.demo).toBe(false);
      expect(storage.getItem('myfood:v1')).toBe(savedPayload);
    } finally {
      cleanup();
    }
  });

  test('exitDemo shows login screen when no real session is saved in localStorage', () => {
    const cleanup = stubMinimalDom();
    try {
      const storage = fakeStorage();
      vi.stubGlobal('localStorage', storage);
      enterDemo({ tour: true });
      expect(singletonStore.ui.demo).toBe(true);

      exitDemo();
      expect(singletonStore.ui.demo).toBe(false);
      expect(singletonStore.server).toBeNull();
      expect(singletonStore.ui.loggedOut).toBe(true);
    } finally {
      cleanup();
    }
  });
});
