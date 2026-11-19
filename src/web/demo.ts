// Seeded relative-time state and full local fake API for interactive demo mode.
import { addDays, isoDate, isoWeek, weekRange } from '../shared/dates.ts';
import { computeDailyNutrition } from '../shared/nutrition.ts';
import { paidRows } from '../shared/spend.ts';
import { applyOps, nextStock, toLines } from '../shared/stock.ts';
import { nameKey } from '../shared/text.ts';
import { CATEGORIES } from '../shared/types.ts';
import type {
  AiCook,
  AiEvent,
  ApiTokenInfo,
  ApplyBody,
  BarcodeLinkBody,
  BarcodeLookup,
  CookBody,
  DataInfo,
  DealsInfo,
  DealsPlan,
  DealStore,
  DealsSummary,
  EventBody,
  EventLine,
  EventPatch,
  ExpenseBody,
  FoodEvent,
  Item,
  ItemBody,
  ItemDeals,
  ItemPatch,
  ItemPrice,
  Job,
  JobMode,
  PlanItem,
  PlanTrip,
  LockPeriodBody,
  MeBody,
  NutritionStats,
  Preset,
  PresetBody,
  SettingsBody,
  Settle,
  SpendStats,
  State,
  TokenBody,
} from '../shared/types.ts';
import { ApiError } from './api.ts';

function computeDemoSettle(
  users: { id: number }[],
  events: FoodEvent[],
  since: number | null,
): Settle {
  const from = since ?? 0;
  let unpriced = 0;
  const paidBy = new Map<number, number>();
  const ateBy = new Map<number, number>();
  for (const e of events) {
    if (e.at <= from) continue;
    if (e.cost_cents != null) paidBy.set(e.user_id, (paidBy.get(e.user_id) ?? 0) + e.cost_cents);
    if (e.kind === 'eat' && e.counts_nutrition) {
      for (const l of e.lines) {
        if (l.is_set) continue;
        if (l.value_cents == null) unpriced += 1;
        else ateBy.set(e.user_id, (ateBy.get(e.user_id) ?? 0) + l.value_cents);
      }
    }
  }
  return {
    since,
    unpriced,
    balances: users.map(u => {
      const paid_cents = paidBy.get(u.id) ?? 0;
      const ate_cents = ateBy.get(u.id) ?? 0;
      return { user_id: u.id, paid_cents, ate_cents, balance_cents: paid_cents - ate_cents };
    }),
  };
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
const round1 = (n: number): number => Math.round(n * 10) / 10;

const ID = {
  bolognese: 1,
  eggs: 2,
  gouda: 3,
  bacon: 4,
  beef: 5,
  bread: 6,
  spinach: 7,
  fusilli: 8,
  oliveOil: 9,
  salt: 10,
  oatMilk: 11,
} as const;

/** The demo's deals: a Netto trip today (eggs, bacon, toast) and an oat milk offer at Lidl later this week. */
function demoDeals(now: number) {
  const today = isoDate(new Date(now));
  const mk = (item_id: number, name: string, emoji: string, qty_per_pack: number, price_cents: number, normal: number, offer_title: string, reason: string) => {
    const unit_cents = price_cents / qty_per_pack;
    return { item_id, name, emoji, packs: 1, unit_cents, saving_cents: Math.round((normal - unit_cents) * qty_per_pack), reason, offer_title, qty_per_pack, price_cents, normal, pct_off: Math.round((1 - unit_cents / normal) * 100) };
  };
  const netto = { store_id: 'netto-dk', store_name: 'Netto', store_emoji: '🟡' };
  const lidl = { store_id: 'lidl-dk', store_name: 'Lidl', store_emoji: '🔵' };
  const tripItems = [
    mk(ID.eggs, 'Eggs', '🥚', 10, 2500, 290, 'Eggs 10 pack', 'Running low, and this is cheaper than usual'),
    mk(ID.bacon, 'Bacon', '🥓', 8, 1200, 200, 'Bacon, 8 slices', 'Down to the last pack, 25% off'),
    mk(ID.bread, 'Toast bread', '🍞', 14, 1400, 140, 'Toast bread 14 slices', 'You get through a loaf a week'),
  ];
  const oat = { ...mk(ID.oatMilk, 'Oat milk', '🥛', 1000, 1600, 2.2, 'Oat drink 1 L', 'Stocked up for now, so it can wait for the offer'), ...lidl, valid_from: addDays(today, 2), valid_to: addDays(today, 8) };
  const trip: PlanTrip = {
    date: today, ...netto, saving_cents: tripItems.reduce((n, i) => n + i.saving_cents, 0),
    items: tripItems.map(({ normal: _n, pct_off: _p, ...i }) => i),
  };
  const items: PlanItem[] = [
    ...tripItems.map(i => ({ ...i, normal_cents: i.normal, rate: null, ...netto, on_trip: true, valid_from: today, valid_to: addDays(today, 5) })),
    { ...oat, normal_cents: 2.2, rate: null, on_trip: false },
  ];
  const plan: DealsPlan = { generated_at: now, today, trips: [trip], items, total_saving_cents: trip.saving_cents };
  const summary: DealsSummary = { date: today, store_name: 'Netto', store_emoji: '🟡', saving_cents: trip.saving_cents, deal_count: trip.items.length };
  const catalogs = [
    { id: 1, store_id: 'netto-dk', title: 'Netto weekly offers', valid_from: today, valid_to: addDays(today, 5), offer_count: 3 },
    { id: 2, store_id: 'lidl-dk', title: 'Lidl weekly offers', valid_from: addDays(today, 2), valid_to: addDays(today, 8), offer_count: 1 },
  ];
  const forItem = (id: number): ItemDeals => {
    const i = [...tripItems.map(t => ({ ...t, ...netto, valid_from: today, valid_to: addDays(today, 5) })), oat].find(x => x.item_id === id);
    if (!i) return { normal: null, offers: [] };
    return { normal: { cents_per_unit: i.normal, basis: 'buys' }, offers: [{ id: i.item_id, store_id: i.store_id, store_name: i.store_name, store_emoji: i.store_emoji, title: i.offer_title, price_cents: i.price_cents, unit_cents: i.unit_cents, valid_from: i.valid_from, valid_to: i.valid_to, pct_off: i.pct_off }] };
  };
  return { plan, summary, catalogs, forItem };
}

function sortItems(items: Item[]): Item[] {
  return [...items].sort(
    (a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.name.localeCompare(b.name),
  );
}

function itemBase(
  id: number,
  name: string,
  emoji: string,
  category: Item['category'],
  unit: Item['unit'],
  step: number,
  pack_size: number,
  low_at: number | null,
  stock: number,
  extra: Partial<Item> = {},
): Item {
  return {
    id,
    name,
    emoji,
    category,
    unit,
    step,
    pack_size,
    low_at,
    stock,
    owner_id: null,
    is_cooked: false,
    portion_g: null,
    expires_at: null,
    shelf_life_days: null,
    kcal_per_unit: null,
    protein_per_unit: null,
    fat_per_unit: null,
    carbs_per_unit: null,
    cost_per_unit_cents: null,
    ...extra,
  };
}

function snapshotLines(lines: EventLine[], items: Item[], countsNutrition: boolean): EventLine[] {
  const byId = new Map(items.map(i => [i.id, i]));
  return lines.map(l => {
    const it = byId.get(l.item_id);
    if (!it || l.is_set || !countsNutrition) return { ...l };
    const q = Math.abs(l.qty);
    return {
      ...l,
      ...(it.kcal_per_unit != null ? { kcal: Math.round(q * it.kcal_per_unit) } : {}),
      ...(it.protein_per_unit != null ? { protein_g: round1(q * it.protein_per_unit) } : {}),
      ...(it.fat_per_unit != null ? { fat_g: round1(q * it.fat_per_unit) } : {}),
      ...(it.carbs_per_unit != null ? { carbs_g: round1(q * it.carbs_per_unit) } : {}),
      ...(it.cost_per_unit_cents != null ? { value_cents: Math.round(q * it.cost_per_unit_cents) } : {}),
    };
  });
}

function heroPresetMeta(hour: number): { name: string; emoji: string; lines: { item_id: number; qty: number }[] } {
  if (hour >= 5 && hour < 11) {
    return {
      name: 'Morning eggs',
      emoji: '🍳',
      lines: [
        { item_id: ID.eggs, qty: 3 },
        { item_id: ID.bread, qty: 2 },
        { item_id: ID.gouda, qty: 1.5 },
        { item_id: ID.oatMilk, qty: 200 },
      ],
    };
  }
  if (hour >= 11 && hour < 15) {
    return {
      name: 'Quick lunch',
      emoji: '🥗',
      lines: [
        { item_id: ID.bolognese, qty: 300 },
        { item_id: ID.spinach, qty: 50 },
      ],
    };
  }
  if (hour >= 15 && hour < 22) {
    return {
      name: 'Bolognese bowl',
      emoji: '🍲',
      lines: [
        { item_id: ID.bolognese, qty: 300 },
        { item_id: ID.spinach, qty: 50 },
        { item_id: ID.gouda, qty: 1 },
      ],
    };
  }
  return {
    name: 'Late snack',
    emoji: '🧀',
    lines: [
      { item_id: ID.bread, qty: 2 },
      { item_id: ID.gouda, qty: 2 },
    ],
  };
}

/** Builds a realistic, relative-time demo State so every screen looks populated at any date/time. */
export function createDemoState(now = Date.now()): State {
  const nowDate = new Date(now);
  const today = isoDate(nowDate);
  const todayMid = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
  const todayAt = (hoursAgo: number) => Math.max(todayMid, now - Math.round(hoursAgo * 3_600_000));
  const localDayAt = (dayOffset: number, hour: number, minute = 0) =>
    new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + dayOffset, hour, minute).getTime();

  const items: Item[] = sortItems([
    itemBase(ID.bolognese, 'Bolognese', '🍲', 'meals', 'g', 50, 1200, null, 900, {
      is_cooked: true,
      portion_g: 300,
      expires_at: addDays(today, 2),
      shelf_life_days: 4,
      kcal_per_unit: 1.4,
      protein_per_unit: 0.09,
      fat_per_unit: 0.05,
      carbs_per_unit: 0.14,
      cost_per_unit_cents: 1.2,
      recipe: [{ item_id: ID.beef, qty: 500 }, { item_id: ID.fusilli, qty: 400 }],
    }),
    itemBase(ID.eggs, 'Eggs', '🥚', 'dairy', 'pc', 1, 10, 3, 7, {
      expires_at: addDays(today, 10),
      shelf_life_days: 21,
      kcal_per_unit: 78,
      protein_per_unit: 6.3,
      fat_per_unit: 5.3,
      carbs_per_unit: 0.6,
      cost_per_unit_cents: 290,
    }),
    itemBase(ID.gouda, 'Gouda slices', '🧀', 'dairy', 'slice', 0.5, 12, 2, 9, {
      expires_at: addDays(today, 6),
      shelf_life_days: 14,
      kcal_per_unit: 72,
      protein_per_unit: 5,
      fat_per_unit: 5.8,
      carbs_per_unit: 0.4,
      cost_per_unit_cents: 250,
    }),
    itemBase(ID.bacon, 'Bacon', '🥓', 'meat', 'slice', 0.5, 8, 2, 2, {
      expires_at: addDays(today, 1),
      shelf_life_days: 7,
      kcal_per_unit: 45,
      protein_per_unit: 3,
      fat_per_unit: 3.5,
      carbs_per_unit: 0,
      cost_per_unit_cents: 200,
    }),
    itemBase(ID.beef, 'Minced beef', '🥩', 'meat', 'g', 50, 500, null, 0, {
      shelf_life_days: 3,
      kcal_per_unit: 2.1,
      protein_per_unit: 0.2,
      fat_per_unit: 0.14,
      carbs_per_unit: 0,
      cost_per_unit_cents: 9.8,
    }),
    itemBase(ID.bread, 'Toast bread', '🍞', 'bakery', 'slice', 0.5, 14, 3, 10, {
      expires_at: addDays(today, 4),
      shelf_life_days: 7,
      kcal_per_unit: 75,
      protein_per_unit: 2.6,
      fat_per_unit: 1,
      carbs_per_unit: 14,
      cost_per_unit_cents: 140,
    }),
    itemBase(ID.spinach, 'Baby spinach', '🥬', 'produce', 'g', 25, 150, 50, 75, {
      expires_at: addDays(today, 2),
      shelf_life_days: 5,
      kcal_per_unit: 0.23,
      protein_per_unit: 0.029,
      fat_per_unit: 0.004,
      carbs_per_unit: 0.036,
      cost_per_unit_cents: 12,
    }),
    itemBase(ID.fusilli, 'Fusilli', '🍝', 'pantry', 'g', 50, 1000, 200, 750, {
      kcal_per_unit: 3.5,
      protein_per_unit: 0.12,
      fat_per_unit: 0.015,
      carbs_per_unit: 0.71,
      cost_per_unit_cents: 1.8,
    }),
    itemBase(ID.oliveOil, 'Olive oil', '🫒', 'pantry', 'level', 1, 1, 0.25, 0.5, {
      cost_per_unit_cents: 4500,
    }),
    itemBase(ID.salt, 'Salt', '🧂', 'spices', 'level', 1, 1, 0.25, 0.25, {
      cost_per_unit_cents: 1200,
    }),
    itemBase(ID.oatMilk, 'Oat milk', '🥛', 'drinks', 'ml', 100, 1000, 250, 600, {
      owner_id: 1,
      expires_at: addDays(today, 5),
      shelf_life_days: 10,
      kcal_per_unit: 0.46,
      protein_per_unit: 0.01,
      fat_per_unit: 0.015,
      carbs_per_unit: 0.067,
      cost_per_unit_cents: 2.2,
    }),
  ]);

  const curHour = nowDate.getHours() + nowDate.getMinutes() / 60;
  const heroHour = Math.min(23.75, Math.floor(curHour * 4) / 4);
  const hero = heroPresetMeta(curHour);

  const presets: Preset[] = [
    { id: 1, user_id: 1, name: hero.name, emoji: hero.emoji, hour: heroHour, lines: hero.lines },
    {
      id: 2,
      user_id: 1,
      name: 'Pasta night',
      emoji: '🍝',
      hour: (heroHour + 10) % 24,
      lines: [
        { item_id: ID.fusilli, qty: 150 },
        { item_id: ID.gouda, qty: 1.5 },
        { item_id: ID.spinach, qty: 50 },
      ],
    },
  ];

  const makeEat = (
    cid: string,
    user_id: number,
    at: number,
    lines: { item_id: number; qty: number }[],
    extra: Partial<FoodEvent> = {},
  ): FoodEvent => ({
    cid,
    user_id,
    at,
    kind: 'eat',
    source: 'manual',
    note: null,
    preset_id: null,
    cost_cents: null,
    counts_nutrition: true,
    ...extra,
    lines: snapshotLines(
      lines.map(l => ({ item_id: l.item_id, qty: -l.qty, is_set: false })),
      items,
      extra.counts_nutrition ?? true,
    ),
  });

  const dow = (nowDate.getDay() + 6) % 7; // 0 = Monday .. 6 = Sunday
  const events: FoodEvent[] = [
    {
      cid: 'demo-ev-today-exp',
      user_id: 2,
      at: todayAt(1),
      kind: 'buy',
      source: 'expense',
      note: 'Bakery & coffee',
      preset_id: null,
      cost_cents: 6400,
      counts_nutrition: false,
      lines: [],
    },
    makeEat(
      'demo-ev-today-eat',
      1,
      todayAt(2),
      [
        { item_id: ID.eggs, qty: 2 },
        { item_id: ID.bread, qty: 2 },
        { item_id: ID.gouda, qty: 1.5 },
        { item_id: ID.oatMilk, qty: 200 },
      ],
    ),
    {
      cid: 'demo-ev-today-buy',
      user_id: 1,
      at: todayAt(3),
      kind: 'buy',
      source: 'receipt',
      note: 'REMA 1000',
      preset_id: null,
      cost_cents: 13850,
      counts_nutrition: true,
      lines: [
        { item_id: ID.eggs, qty: 10, is_set: false, cost_cents: 2900 },
        { item_id: ID.bread, qty: 14, is_set: false, cost_cents: 1960 },
        { item_id: ID.oatMilk, qty: 1000, is_set: false, cost_cents: 2200 },
      ],
    },
    makeEat(
      'demo-ev-yest-robin',
      2,
      localDayAt(-1, 19, 30),
      [
        { item_id: ID.fusilli, qty: 200 },
        { item_id: ID.gouda, qty: 2 },
        { item_id: ID.spinach, qty: 50 },
      ],
    ),
    makeEat(
      'demo-ev-yest-sam',
      1,
      localDayAt(-1, 8, 15),
      [
        { item_id: ID.eggs, qty: 3 },
        { item_id: ID.bacon, qty: 2 },
        { item_id: ID.bread, qty: 3 },
      ],
      { source: 'preset', preset_id: 1, note: hero.name },
    ),
  ];

  // Fill earlier days in the current ISO week when today isn't Monday/Tuesday.
  for (let offset = 2; offset <= dow; offset++) {
    events.push(
      makeEat(
        `demo-ev-week-${offset}`,
        1,
        localDayAt(-offset, 18, 30),
        offset % 2 === 0
          ? [{ item_id: ID.bolognese, qty: 300 }, { item_id: ID.spinach, qty: 50 }]
          : [{ item_id: ID.fusilli, qty: 180 }, { item_id: ID.gouda, qty: 2 }, { item_id: ID.eggs, qty: 2 }],
      ),
    );
  }

  // A cooked meal batch 2 days ago (always inside the 90-day window).
  events.push({
    cid: 'demo-ev-cook-1',
    user_id: 1,
    at: localDayAt(-2, 17, 45),
    kind: 'buy',
    source: 'cook',
    note: 'Bolognese',
    preset_id: null,
    cost_cents: null,
    counts_nutrition: false,
    lines: [{ item_id: ID.bolognese, qty: 1200, is_set: false }],
  });

  // Last week's settled expenses + meals so < Prev week in Spend & Me are populated.
  const lastWeekAt1 = localDayAt(-7, 17, 20);
  const lastWeekAt2 = localDayAt(-8, 13, 10);
  const lastWeekPeriod = isoWeek(lastWeekAt1);
  events.push(
    {
      cid: 'demo-ev-prev-buy-1',
      user_id: 1,
      at: lastWeekAt1,
      kind: 'buy',
      source: 'receipt',
      note: 'Netto',
      preset_id: null,
      cost_cents: 28500,
      counts_nutrition: true,
      lines: [
        { item_id: ID.beef, qty: 1000, is_set: false, cost_cents: 9800 },
        { item_id: ID.fusilli, qty: 1000, is_set: false, cost_cents: 1800 },
      ],
    },
    {
      cid: 'demo-ev-prev-buy-2',
      user_id: 2,
      at: lastWeekAt2,
      kind: 'buy',
      source: 'expense',
      note: 'Farmers market',
      preset_id: null,
      cost_cents: 16500,
      counts_nutrition: false,
      lines: [],
    },
    makeEat(
      'demo-ev-prev-eat-1',
      1,
      localDayAt(-7, 19, 0),
      [{ item_id: ID.bolognese, qty: 300 }, { item_id: ID.gouda, qty: 2 }],
    ),
    makeEat(
      'demo-ev-prev-eat-2',
      1,
      localDayAt(-8, 19, 30),
      [{ item_id: ID.fusilli, qty: 200 }, { item_id: ID.eggs, qty: 2 }],
    ),
  );

  events.sort((a, b) => b.at - a.at);

  const expenses = events.filter(e => e.cost_cents != null);
  const daily_nutrition = computeDailyNutrition(events, items, []);

  const jobs: Job[] = [
    {
      id: 1,
      mode: 'receipt',
      status: 'review',
      text: '',
      has_images: true,
      error: null,
      event_cids: [],
      created_at: todayAt(0.1),
      result: {
        reply: 'Found 3 things on the REMA 1000 receipt.',
        events: [
          {
            kind: 'buy',
            preset_id: null,
            total_cost: 89.5,
            lines: [
              { item_id: ID.eggs, new_item: null, qty: 10, raw: 'ØKO ÆG M/L 10 STK', price: 29, expires_in_days: 21 },
              { item_id: ID.bacon, new_item: null, qty: 8, raw: 'BACON I SKIVER 150G', price: 29, expires_in_days: 7 },
              {
                item_id: null,
                new_item: {
                  name: 'Butter',
                  emoji: '🧈',
                  category: 'dairy',
                  unit: 'g',
                  step: 10,
                  pack_size: 250,
                  kcal_per_unit: 7.17,
                  protein_per_unit: 0.008,
                  fat_per_unit: 0.81,
                  carbs_per_unit: 0.006,
                  expires_in_days: 30,
                },
                qty: 250,
                raw: 'LURPAK SMØR 250G',
                price: 31.5,
                expires_in_days: 30,
              },
            ],
          },
        ],
      },
    },
  ];

  const build = typeof __BUILD__ !== 'undefined' ? __BUILD__ : 'dev';

  const users = [
    { id: 1, name: 'Sam', emoji: '🦊' },
    { id: 2, name: 'Robin', emoji: '🐻' },
  ];

  return {
    rev: 1,
    build,
    now,
    me: {
      id: 1,
      name: 'Sam',
      emoji: '🦊',
      notify_low: true,
      notify_expiry: true,
      notify_deals: true,
      goals: { kcal: 2200, protein_g: 140, fat_g: 70, carbs_g: 240 },
    },
    users,
    items,
    presets,
    usual: {
      [ID.eggs]: 3,
      [ID.gouda]: 1.5,
      [ID.bacon]: 2,
      [ID.bread]: 2,
      [ID.spinach]: 50,
      [ID.fusilli]: 150,
      [ID.oatMilk]: 200,
      [ID.bolognese]: 300,
    },
    events,
    jobs,
    ai: { ready: true },
    currency: 'DKK',
    country: '',
    vapid_public_key: null,
    push_subscribed: false,
    tokens: [
      {
        id: 1,
        name: 'iPhone Siri',
        prefix: 'mf_demo01',
        scopes: 'shortcut',
        created_at: localDayAt(-5, 10, 0),
        last_used_at: localDayAt(-1, 8, 15),
      },
    ],
    expense_locks: [
      {
        period: lastWeekPeriod,
        locked_by: 1,
        locked_at: localDayAt(-6, 9, 0),
        total_cents: 45000,
        event_count: 2,
        note: null,
      },
    ],
    settle: computeDemoSettle(users, events, null),
    expenses,
    daily_nutrition,
    guest_code: 'demo-2026',
    deals_summary: demoDeals(now).summary,
  };
}

const SAMPLE_BARCODES: Record<string, BarcodeLookup> = {
  '7394376616013': {
    found: true,
    code: '7394376616013',
    item_id: ID.oatMilk,
    product: {
      code: '7394376616013',
      product_name: 'Oat Drink Barista',
      brand: 'Oatly',
      unit: 'ml',
      pack_size: 1000,
      kcal_per_unit: 0.61,
      protein_per_unit: 0.011,
      fat_per_unit: 0.03,
      carbs_per_unit: 0.068,
      category: 'drinks',
      source: 'openfoodfacts',
    },
  },
};

function parseFormBody(body: unknown): { text: string; mode: JobMode; imageCount: number } {
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const rawText = body.get('text');
    const rawMode = body.get('mode');
    const images = body.getAll('images');
    const mode: JobMode = rawMode === 'audit' ? 'audit' : rawMode === 'receipt' ? 'receipt' : 'auto';
    return { text: typeof rawText === 'string' ? rawText.trim() : '', mode, imageCount: images.length };
  }
  const obj = (body ?? {}) as { text?: string; mode?: JobMode; images?: unknown[] };
  return {
    text: (obj.text ?? '').trim(),
    mode: obj.mode === 'audit' ? 'audit' : obj.mode === 'receipt' ? 'receipt' : 'auto',
    imageCount: Array.isArray(obj.images) ? obj.images.length : 0,
  };
}

function buildMockProposal(st: State, text: string, mode: JobMode, imageCount: number): Job['result'] {
  const lower = text.toLowerCase();
  const matched = st.items.filter(i => lower.includes(i.name.toLowerCase()));
  if (mode === 'audit') {
    const picked = matched.length ? matched : [st.items.find(i => i.id === ID.eggs) ?? st.items[0]].filter((x): x is Item => !!x);
    return {
      reply: `Prepared fridge audit for ${picked.length} ${picked.length === 1 ? 'item' : 'items'}.`,
      events: picked.length
        ? [{ kind: 'adjust', preset_id: null, lines: picked.map(it => ({ item_id: it.id, new_item: null, qty: Math.max(0, round(it.stock)), raw: text || 'Fridge photo' })) }]
        : [],
    };
  }
  const isEat = /\b(ate|eat|had|drank|lunch|breakfast|dinner|snack)\b/i.test(text);
  const kind = isEat ? 'eat' : 'buy';
  if (matched.length) {
    return {
      reply: `Matched ${matched.map(i => i.name).join(', ')} from your demo note.`,
      events: [{
        kind,
        preset_id: null,
        lines: matched.map(it => {
          const m = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(?:x\\s*)?${it.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').exec(text);
          const parsed = m ? Number(m[1]!.replace(',', '.')) : null;
          const qty = parsed && parsed > 0 ? parsed : (kind === 'buy' ? it.pack_size : it.step);
          return { item_id: it.id, new_item: null, qty, raw: text || null };
        }),
      }],
    };
  }
  if (!text && imageCount > 0) {
    const eggs = st.items.find(i => i.id === ID.eggs) ?? st.items[0];
    return {
      reply: 'Sample photo parsed in demo mode.',
      events: eggs ? [{ kind: 'buy', preset_id: null, lines: [{ item_id: eggs.id, new_item: null, qty: eggs.pack_size, raw: 'Demo photo' }] }] : [],
    };
  }
  const cleanName = text.replace(/^(ate|bought|buy|had)\s+/i, '').trim().slice(0, 40) || 'Greek yogurt';
  return {
    reply: `Prepared "${cleanName}" for your review.`,
    events: [{
      kind,
      preset_id: null,
      lines: [{
        item_id: null,
        new_item: {
          name: cleanName.charAt(0).toUpperCase() + cleanName.slice(1),
          emoji: kind === 'eat' ? '🍽️' : '🛒',
          category: 'other',
          unit: 'pc',
          step: 1,
          pack_size: 1,
          expires_in_days: 7,
        },
        qty: 1,
        raw: text || null,
      }],
    }],
  };
}

/**
 * Creates a self-contained local API handler matching `useFake()` for demo mode.
 * Supports all pantry, meal cooking, spend, jobs, settings, barcode, and token routes.
 */
export function createDemoApi(initial: State = createDemoState()): (method: string, path: string, body?: unknown) => Promise<unknown> {
  let st = structuredClone(initial);
  let nextItemId = Math.max(0, ...st.items.map(i => i.id)) + 1;
  let nextPresetId = Math.max(0, ...st.presets.map(p => p.id)) + 1;
  let nextJobId = Math.max(0, ...st.jobs.map(j => j.id)) + 1;
  let nextTokenId = Math.max(0, ...st.tokens.map(t => t.id)) + 1;
  const barcodeMap = new Map<string, number>();
  const setBefore = new Map<string, Map<number, number>>();
  const archivedItems = new Map<number, { item: Item; archived_at: number }>();
  let settleSince: number | null = st.settle.since;

  // A trip already logged today (the "Bought these" buy) drops off the plan, and the Pantry strip follows it.
  const livePlan = (): DealsPlan => {
    const d = demoDeals(st.now).plan;
    const trips = d.trips.filter(t => !st.events.some(e => e.kind === 'buy' && e.note === t.store_name && isoDate(new Date(e.at)) === d.today));
    return { ...d, trips, items: d.items.filter(i => !i.on_trip || trips.some(t => t.store_id === i.store_id)), total_saving_cents: trips.reduce((n, t) => n + t.saving_cents, 0) };
  };
  const syncDerived = () => {
    const t = livePlan().trips[0];
    st.deals_summary = t ? { date: t.date, store_name: t.store_name, store_emoji: t.store_emoji, saving_cents: t.saving_cents, deal_count: t.items.length } : null;
    st.items = sortItems(st.items);
    st.events.sort((a, b) => b.at - a.at);
    st.expenses = st.events.filter(e => e.cost_cents != null);
    st.daily_nutrition = computeDailyNutrition(st.events, st.items, []);
    st.settle = computeDemoSettle(st.users, st.events, settleSince);
  };
  const dealStores: DealStore[] = [['netto-dk', 'Netto', '🟡'], ['lidl-dk', 'Lidl', '🔵']].map(([id, name, emoji]) => ({ id: id!, name: name!, emoji: emoji!, enabled: true, last_synced_at: st.now - 3 * 3_600_000, last_error: null }));
  let dealLoc = { lat: 55.6761, lng: 12.5683, radius_m: 5000 };
  const bump = () => { st.rev += 1; st.now = Date.now(); syncDerived(); return structuredClone(st); };
  const assertUnlocked = (at: number) => {
    const period = isoWeek(at);
    if (st.expense_locks.some(l => l.period === period)) {
      throw new ApiError(409, `Week ${period} is locked`);
    }
  };

  const applyCook = (b: CookBody, at: number) => {
    const ingLines = toLines({ kind: 'eat', lines: b.ingredients }, id => st.items.find(i => i.id === id)?.unit);
    if (ingLines.length) {
      const prev = new Map<number, number>();
      for (const l of ingLines) {
        const it = st.items.find(i => i.id === l.item_id);
        if (it) { prev.set(it.id, it.stock); it.stock = nextStock(it.stock, l, 'eat'); }
      }
      const cid = `${b.cid}-ing`;
      setBefore.set(cid, prev);
      st.events.unshift({
        cid,
        user_id: st.me.id,
        at,
        kind: 'eat',
        source: 'cook',
        note: b.name ? `Cooked ${b.name}` : 'Cooked meal',
        preset_id: null,
        cost_cents: null,
        counts_nutrition: false,
        lines: ingLines,
      });
    }

    const totalG = b.total_g ?? null;
    const portions = b.portions ?? null;
    const unit = totalG != null ? 'g' : 'portion';
    const batchQty = totalG ?? portions ?? 1;
    const portionG = totalG != null && portions != null ? round(totalG / portions) : null;
    const perUnit = (v: number | null | undefined) => (v != null && batchQty > 0 ? round(v / batchQty) : null);

    let meal = b.meal_item_id != null ? st.items.find(i => i.id === b.meal_item_id) : undefined;
    if (!meal && b.name) {
      meal = st.items.find(i => nameKey(i.name) === nameKey(b.name!) && i.owner_id === (b.owner_id ?? null));
    }
    if (meal) {
      meal.is_cooked = true;
      if (portionG != null) meal.portion_g = portionG;
      if (b.expires_at !== undefined) meal.expires_at = b.expires_at ?? null;
      if (b.kcal_total != null) meal.kcal_per_unit = perUnit(b.kcal_total);
      if (b.protein_total != null) meal.protein_per_unit = perUnit(b.protein_total);
      if (b.fat_total != null) meal.fat_per_unit = perUnit(b.fat_total);
      if (b.carbs_total != null) meal.carbs_per_unit = perUnit(b.carbs_total);
      meal.recipe = b.ingredients.map(i => ({ ...i }));
    } else {
      meal = itemBase(
        nextItemId++,
        b.name ?? 'Cooked meal',
        b.emoji ?? '🍲',
        'meals',
        unit,
        unit === 'g' ? 50 : 1,
        batchQty,
        null,
        0,
        {
          owner_id: b.owner_id ?? null,
          is_cooked: true,
          portion_g: portionG,
          expires_at: b.expires_at ?? null,
          shelf_life_days: 4,
          kcal_per_unit: perUnit(b.kcal_total),
          protein_per_unit: perUnit(b.protein_total),
          fat_per_unit: perUnit(b.fat_total),
          carbs_per_unit: perUnit(b.carbs_total),
          recipe: b.ingredients.map(i => ({ ...i })),
        },
      );
      st.items.push(meal);
    }
    meal.stock = round(meal.stock + batchQty);
    st.events.unshift({
      cid: b.cid,
      user_id: st.me.id,
      at,
      kind: 'buy',
      source: 'cook',
      note: meal.name,
      preset_id: null,
      cost_cents: null,
      counts_nutrition: false,
      lines: [{ item_id: meal.id, qty: batchQty, is_set: false }],
    });
  };

  return async (method, path, body) => {
    if (method === 'GET' && path === '/api/state') {
      return structuredClone(st);
    }

    if (method === 'POST' && path === '/api/events') {
      const b = body as EventBody;
      if (b.cost_cents != null) assertUnlocked(b.at);
      if (!st.events.some(e => e.cid === b.cid)) {
        const prev = new Map<number, number>();
        for (const l of b.lines) {
          const it = st.items.find(i => i.id === l.item_id);
          if (it) prev.set(it.id, it.stock);
        }
        setBefore.set(b.cid, prev);
        st = applyOps(st, [{ type: 'event', body: b }]);
        // applyOps snapshots macros/usual; also update expires_at & cost_per_unit_cents on buys
        const ev = st.events.find(e => e.cid === b.cid);
        if (ev) {
          ev.lines = snapshotLines(ev.lines, st.items, ev.counts_nutrition);
          if (b.kind === 'buy') {
            for (const l of b.lines) {
              const it = st.items.find(i => i.id === l.item_id);
              if (!it) continue;
              if (l.expires_at) it.expires_at = l.expires_at;
              else if (it.shelf_life_days != null) it.expires_at = addDays(isoDate(b.at), it.shelf_life_days);
              if (l.cost_cents != null && l.qty > 0) it.cost_per_unit_cents = round(l.cost_cents / l.qty);
            }
          }
        }
      }
      return bump();
    }

    if (method === 'PATCH' && path.startsWith('/api/events/')) {
      const cid = decodeURIComponent(path.slice('/api/events/'.length));
      const ev = st.events.find(e => e.cid === cid);
      if (!ev) throw new ApiError(404, 'Event not found');
      if (ev.cost_cents != null) assertUnlocked(ev.at);
      const patch = body as EventPatch;
      // Reverse previous non-set stock effects
      for (const l of ev.lines) {
        const it = st.items.find(i => i.id === l.item_id);
        if (it && !l.is_set) it.stock = round(it.stock - l.qty);
      }
      const nextLines = toLines({ kind: ev.kind, lines: patch.lines }, id => st.items.find(i => i.id === id)?.unit);
      for (const l of nextLines) {
        const it = st.items.find(i => i.id === l.item_id);
        if (it) it.stock = nextStock(it.stock, l, ev.kind);
      }
      ev.lines = snapshotLines(nextLines, st.items, ev.counts_nutrition);
      if (patch.cost_cents !== undefined) ev.cost_cents = patch.cost_cents ?? null;
      if (patch.note !== undefined) ev.note = patch.note ?? null;
      return bump();
    }

    if (method === 'DELETE' && path.startsWith('/api/events/')) {
      const cid = decodeURIComponent(path.slice('/api/events/'.length));
      const ev = st.events.find(e => e.cid === cid);
      if (ev) {
        if (ev.cost_cents != null) assertUnlocked(ev.at);
        const prev = setBefore.get(cid);
        for (const l of ev.lines) {
          const it = st.items.find(i => i.id === l.item_id);
          if (!it) continue;
          if (!l.is_set) it.stock = round(it.stock - l.qty);
          else if (prev?.has(it.id)) it.stock = prev.get(it.id)!;
        }
        st.events = st.events.filter(e => e.cid !== cid);
      }
      return bump();
    }

    if (method === 'POST' && path === '/api/items') {
      const b = body as ItemBody;
      const ownerId = b.owner_id ?? null;
      if (st.items.some(i => nameKey(i.name) === nameKey(b.name) && i.owner_id === ownerId)) {
        throw new ApiError(409, `${b.name} is already in the pantry`);
      }
      const item = itemBase(
        nextItemId++,
        b.name.trim(),
        b.emoji.trim(),
        b.category,
        b.unit,
        b.step,
        b.pack_size,
        b.low_at ?? null,
        0,
        {
          owner_id: ownerId,
          is_cooked: !!b.is_cooked,
          portion_g: b.portion_g ?? null,
          expires_at: b.expires_at ?? null,
          shelf_life_days: b.shelf_life_days ?? null,
          kcal_per_unit: b.kcal_per_unit ?? null,
          protein_per_unit: b.protein_per_unit ?? null,
          fat_per_unit: b.fat_per_unit ?? null,
          carbs_per_unit: b.carbs_per_unit ?? null,
          cost_per_unit_cents: b.cost_per_unit_cents ?? null,
        },
      );
      st.items.push(item);
      if (b.barcode) barcodeMap.set(b.barcode, item.id);
      return bump();
    }

    if (method === 'PATCH' && path.startsWith('/api/items/')) {
      const id = Number(path.slice('/api/items/'.length));
      const it = st.items.find(i => i.id === id);
      if (!it) throw new ApiError(404, 'Item not found');
      const b = body as ItemPatch;
      if (b.name !== undefined) it.name = b.name.trim();
      if (b.emoji !== undefined) it.emoji = b.emoji.trim();
      if (b.category !== undefined) it.category = b.category;
      if (b.unit !== undefined) it.unit = b.unit;
      if (b.step !== undefined) it.step = b.step;
      if (b.pack_size !== undefined) it.pack_size = b.pack_size;
      if (b.low_at !== undefined) it.low_at = b.low_at;
      if (b.owner_id !== undefined) it.owner_id = b.owner_id ?? null;
      if (b.is_cooked !== undefined) it.is_cooked = b.is_cooked;
      if (b.portion_g !== undefined) it.portion_g = b.portion_g ?? null;
      if (b.expires_at !== undefined) it.expires_at = b.expires_at ?? null;
      if (b.shelf_life_days !== undefined) it.shelf_life_days = b.shelf_life_days ?? null;
      if (b.kcal_per_unit !== undefined) it.kcal_per_unit = b.kcal_per_unit ?? null;
      if (b.protein_per_unit !== undefined) it.protein_per_unit = b.protein_per_unit ?? null;
      if (b.fat_per_unit !== undefined) it.fat_per_unit = b.fat_per_unit ?? null;
      if (b.carbs_per_unit !== undefined) it.carbs_per_unit = b.carbs_per_unit ?? null;
      if (b.cost_per_unit_cents !== undefined) it.cost_per_unit_cents = b.cost_per_unit_cents ?? null;
      return bump();
    }

    if (method === 'DELETE' && path.startsWith('/api/items/')) {
      const id = Number(path.slice('/api/items/'.length));
      const archived = st.items.find(i => i.id === id);
      if (archived) archivedItems.set(id, { item: archived, archived_at: Date.now() });
      st.items = st.items.filter(i => i.id !== id);
      st.presets = st.presets
        .map(p => ({ ...p, lines: p.lines.filter(l => l.item_id !== id) }))
        .filter(p => p.lines.length > 0);
      return bump();
    }

    if (method === 'POST' && path === '/api/meals/cook') {
      const b = body as CookBody;
      if (!st.events.some(e => e.cid === b.cid)) applyCook(b, Math.min(b.at, Date.now()));
      return bump();
    }

    if (method === 'POST' && path === '/api/presets') {
      const b = body as PresetBody;
      st.presets.push({ id: nextPresetId++, user_id: st.me.id, name: b.name, emoji: b.emoji, hour: b.hour, lines: b.lines });
      return bump();
    }

    if (method === 'PATCH' && path.startsWith('/api/presets/')) {
      const id = Number(path.slice('/api/presets/'.length));
      const p = st.presets.find(x => x.id === id);
      if (!p) throw new ApiError(404, 'Preset not found');
      const b = body as PresetBody;
      p.name = b.name;
      p.emoji = b.emoji;
      p.hour = b.hour;
      p.lines = b.lines;
      return bump();
    }

    if (method === 'DELETE' && path.startsWith('/api/presets/')) {
      const id = Number(path.slice('/api/presets/'.length));
      st.presets = st.presets.filter(p => p.id !== id);
      return bump();
    }

    if (method === 'POST' && path === '/api/jobs') {
      const { text, mode, imageCount } = parseFormBody(body);
      const job: Job = {
        id: nextJobId++,
        mode,
        status: 'review',
        text,
        has_images: imageCount > 0,
        result: buildMockProposal(st, text, mode, imageCount),
        error: null,
        event_cids: [],
        created_at: Date.now(),
      };
      st.jobs.unshift(job);
      return bump();
    }

    if (method === 'POST' && path.startsWith('/api/jobs/') && path.endsWith('/apply')) {
      const id = Number(path.slice('/api/jobs/'.length, -'/apply'.length));
      const job = st.jobs.find(j => j.id === id);
      if (!job) throw new ApiError(404, 'Job not found');
      const b = body as ApplyBody;
      const nowMs = Date.now();
      const today = isoDate(nowMs);
      const source: FoodEvent['source'] = job.mode === 'audit' ? 'audit' : job.mode === 'receipt' ? 'receipt' : 'ai';

      for (const ev of b.events ?? []) {
        const mappedLines: EventLine[] = [];
        for (const l of ev.lines) {
          let targetId = l.item_id;
          if (targetId == null && l.new_item) {
            const ownerId = l.new_item.owner === 'mine' ? st.me.id : null;
            const existing = st.items.find(i => nameKey(i.name) === nameKey(l.new_item!.name) && i.owner_id === ownerId);
            if (existing) {
              targetId = existing.id;
            } else {
              const ni = l.new_item;
              const created = itemBase(
                nextItemId++,
                ni.name,
                ni.emoji,
                ni.category,
                ni.unit,
                ni.step,
                ni.pack_size,
                null,
                0,
                {
                  owner_id: ownerId,
                  expires_at: ni.expires_in_days != null ? addDays(today, ni.expires_in_days) : null,
                  shelf_life_days: ni.expires_in_days ?? null,
                  kcal_per_unit: ni.kcal_per_unit ?? null,
                  protein_per_unit: ni.protein_per_unit ?? null,
                  fat_per_unit: ni.fat_per_unit ?? null,
                  carbs_per_unit: ni.carbs_per_unit ?? null,
                },
              );
              st.items.push(created);
              targetId = created.id;
            }
          }
          if (targetId == null) continue;
          const it = st.items.find(i => i.id === targetId);
          if (!it) continue;
          let qty = l.qty;
          if (l.unit === 'portion' && it.is_cooked && it.portion_g) qty = round(qty * it.portion_g);
          const expires_at = l.expires_in_days != null ? addDays(today, l.expires_in_days) : undefined;
          const cost_cents = l.price != null ? Math.round(l.price * 100) : undefined;
          const [line] = toLines({ kind: ev.kind, lines: [{ item_id: it.id, qty, expires_at, cost_cents }] }, () => it.unit);
          if (!line) continue;
          it.stock = nextStock(it.stock, line, ev.kind);
          if (ev.kind === 'buy') {
            if (expires_at) it.expires_at = expires_at;
            if (cost_cents != null && qty > 0) it.cost_per_unit_cents = round(cost_cents / qty);
          }
          mappedLines.push(line);
        }
        if (!mappedLines.length) continue;
        const cost_cents = ev.total_cost != null ? Math.round(ev.total_cost * 100) : null;
        if (cost_cents != null) assertUnlocked(nowMs);
        st.events.unshift({
          cid: `demo-job-${id}-${crypto.randomUUID().slice(0, 8)}`,
          user_id: st.me.id,
          at: nowMs,
          kind: ev.kind,
          source: ev.kind === 'buy' && source === 'ai' ? 'receipt' : source,
          note: null,
          preset_id: ev.preset_id,
          cost_cents,
          counts_nutrition: true,
          lines: snapshotLines(mappedLines, st.items, true),
        });
      }

      for (const c of (b.cook ?? []) as AiCook[]) {
        applyCook({
          cid: `demo-cook-${crypto.randomUUID().slice(0, 8)}`,
          at: nowMs,
          meal_item_id: c.meal_item_id,
          name: c.name,
          emoji: c.emoji,
          owner_id: c.owner === 'mine' ? st.me.id : null,
          portions: c.portions,
          total_g: c.total_g,
          expires_at: c.expires_in_days != null ? addDays(today, c.expires_in_days) : null,
          kcal_total: c.kcal_total,
          protein_total: c.protein_total,
          fat_total: c.fat_total,
          carbs_total: c.carbs_total,
          ingredients: c.ingredients,
        }, nowMs);
      }

      st.jobs = st.jobs.filter(j => j.id !== id);
      return bump();
    }

    if (method === 'DELETE' && path.startsWith('/api/jobs/')) {
      const id = Number(path.slice('/api/jobs/'.length));
      st.jobs = st.jobs.filter(j => j.id !== id);
      return bump();
    }

    if (method === 'POST' && path === '/api/expenses') {
      const b = body as ExpenseBody;
      assertUnlocked(b.at);
      if (!st.events.some(e => e.cid === b.cid)) {
        st.events.unshift({
          cid: b.cid,
          user_id: st.me.id,
          at: Math.min(b.at, Date.now()),
          kind: 'buy',
          source: 'expense',
          note: b.note ?? null,
          preset_id: null,
          cost_cents: b.cost_cents,
          counts_nutrition: false,
          lines: [],
        });
      }
      return bump();
    }

    if (method === 'POST' && path === '/api/expenses/lock') {
      const b = body as LockPeriodBody;
      const range = weekRange(b.period);
      if (!range) throw new ApiError(400, 'Invalid ISO week');
      if (st.expense_locks.some(l => l.period === b.period)) {
        throw new ApiError(409, `Week ${b.period} is already locked`);
      }
      const matching = st.events.filter(e => e.cost_cents != null && e.at >= range.start && e.at < range.end);
      const total_cents = matching.reduce((acc, e) => acc + (e.cost_cents ?? 0), 0);
      st.expense_locks.unshift({
        period: b.period,
        locked_by: st.me.id,
        locked_at: Date.now(),
        total_cents,
        event_count: matching.length,
        note: b.note ?? null,
      });
      return bump();
    }

    if (method === 'PATCH' && path === '/api/me') {
      const b = body as MeBody;
      if (b.name !== undefined) st.me.name = b.name;
      if (b.emoji !== undefined) st.me.emoji = b.emoji;
      if (b.notify_low !== undefined) st.me.notify_low = b.notify_low;
      if (b.notify_expiry !== undefined) st.me.notify_expiry = b.notify_expiry;
      if (b.notify_deals !== undefined) st.me.notify_deals = b.notify_deals;
      if (b.goals) {
        st.me.goals = {
          kcal: b.goals.kcal === undefined ? st.me.goals.kcal : b.goals.kcal,
          protein_g: b.goals.protein_g === undefined ? st.me.goals.protein_g : b.goals.protein_g,
          fat_g: b.goals.fat_g === undefined ? st.me.goals.fat_g : b.goals.fat_g,
          carbs_g: b.goals.carbs_g === undefined ? st.me.goals.carbs_g : b.goals.carbs_g,
        };
      }
      const meUser = st.users.find(u => u.id === st.me.id);
      if (meUser) { meUser.name = st.me.name; meUser.emoji = st.me.emoji; }
      return bump();
    }

    if (method === 'PATCH' && path === '/api/settings') {
      const b = body as SettingsBody;
      if (b.currency !== undefined) st.currency = b.currency;
      if (b.country !== undefined) st.country = b.country.trim().toLowerCase();
      return bump();
    }

    if (method === 'POST' && path === '/api/settle') {
      settleSince = Date.now();
      return bump();
    }

    if (method === 'DELETE' && path.startsWith('/api/expenses/lock/')) {
      const period = decodeURIComponent(path.slice('/api/expenses/lock/'.length));
      st.expense_locks = st.expense_locks.filter(l => l.period !== period);
      return bump();
    }

    if (method === 'GET' && path === '/api/data') {
      return {
        aliases: [],
        archived: [...archivedItems.values()].map(({ item, archived_at }) => ({
          id: item.id,
          name: item.name,
          emoji: item.emoji,
          archived_at,
        })),
      } satisfies DataInfo;
    }

    if (method === 'POST' && path.startsWith('/api/items/') && path.endsWith('/restore')) {
      const id = Number(path.slice('/api/items/'.length, -'/restore'.length));
      const entry = archivedItems.get(id);
      if (entry) {
        archivedItems.delete(id);
        st.items.push(entry.item);
      }
      return bump();
    }

    if (method === 'GET' && path.startsWith('/api/items/') && path.endsWith('/deals')) return demoDeals(st.now).forItem(Number(path.slice('/api/items/'.length, -'/deals'.length)));

    if (path.startsWith('/api/deals/')) {
      if (method === 'GET' && path === '/api/deals/plan') {
        return livePlan();
      }
      if (method === 'GET' && path === '/api/deals/catalogs') return { stores: dealStores, catalogs: demoDeals(st.now).catalogs, lat: dealLoc.lat, lng: dealLoc.lng, radius_m: dealLoc.radius_m } satisfies DealsInfo;
      if (method === 'POST' && path === '/api/deals/sync') return { stores: dealStores.map(x => ({ id: x.id, offers: 0 })), newOffers: 0 };
      if (method === 'PUT' && path.startsWith('/api/deals/stores/')) {
        const store = dealStores.find(x => x.id === path.slice('/api/deals/stores/'.length));
        if (!store) throw new ApiError(404, 'No such store');
        store.enabled = (body as { enabled: boolean }).enabled;
        return bump();
      }
      if (method === 'PUT' && path === '/api/deals/location') { dealLoc = body as typeof dealLoc; return bump(); }
    }

    if (method === 'GET' && path.startsWith('/api/items/') && path.endsWith('/prices')) {
      const id = Number(path.slice('/api/items/'.length, -'/prices'.length));
      const prices: ItemPrice[] = [];
      for (const e of st.events) {
        if (e.kind !== 'buy') continue;
        for (const l of e.lines) {
          if (l.item_id === id && l.cost_cents != null && l.qty > 0) {
            prices.push({ at: e.at, unit_cents: Math.round((l.cost_cents / l.qty) * 100) / 100 });
          }
        }
      }
      return prices;
    }

    if (method === 'DELETE' && path.startsWith('/api/aliases/')) {
      return bump();
    }

    if (method === 'GET' && path.startsWith('/api/stats/')) {
      const url = new URL(path, 'http://demo.local');
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';
      if (url.pathname === '/api/stats/spend') {
        const paidEvents = st.expenses.filter(e => (e.cost_cents ?? 0) > 0 && isoDate(e.at) >= from && isoDate(e.at) <= to);
        return {
          from,
          to,
          paid: paidRows(paidEvents),
          ate: st.daily_nutrition
            .filter(d => d.day >= from && d.day <= to && (d.value_cents > 0 || d.unpriced > 0))
            .map(({ day, user_id, value_cents, unpriced }) => ({ day, user_id, value_cents, unpriced })),
        } satisfies SpendStats;
      }
      if (url.pathname === '/api/stats/nutrition') {
        return {
          from,
          to,
          rows: st.daily_nutrition.filter(d => d.user_id === st.me.id && d.day >= from && d.day <= to),
        } satisfies NutritionStats;
      }
    }

    if (method === 'POST' && path === '/api/me/code') {
      return { code: 'demo-code-2026', state: bump() };
    }

    if (method === 'POST' && path === '/api/guest/code') {
      st.guest_code = `demo-${Math.floor(1000 + Math.random() * 9000)}`;
      return bump();
    }

    if (method === 'POST' && path === '/api/tokens') {
      const b = body as TokenBody;
      const suffix = Math.random().toString(36).slice(2, 10);
      const token = `mf_demo_${suffix}`;
      const info: ApiTokenInfo = {
        id: nextTokenId++,
        name: b.name,
        prefix: token.slice(0, 9),
        scopes: b.scope,
        created_at: Date.now(),
        last_used_at: null,
      };
      st.tokens.unshift(info);
      const state = bump();
      return { token, info, state };
    }

    if (method === 'DELETE' && path.startsWith('/api/tokens/')) {
      const id = Number(path.slice('/api/tokens/'.length));
      st.tokens = st.tokens.filter(t => t.id !== id);
      return bump();
    }

    if (method === 'GET' && path.startsWith('/api/barcodes/')) {
      const codePart = path.slice('/api/barcodes/'.length).split('?')[0] ?? '';
      const code = decodeURIComponent(codePart);
      const linkedId = barcodeMap.get(code);
      if (linkedId != null && st.items.some(i => i.id === linkedId)) {
        return { found: true, code, item_id: linkedId, product: null } satisfies BarcodeLookup;
      }
      const sample = SAMPLE_BARCODES[code];
      if (sample) return structuredClone(sample);
      return {
        found: true,
        code,
        item_id: null,
        product: {
          code,
          product_name: 'Greek Yogurt 10%',
          brand: 'Sample Dairy',
          unit: 'g',
          pack_size: 500,
          kcal_per_unit: 1.33,
          protein_per_unit: 0.04,
          fat_per_unit: 0.1,
          carbs_per_unit: 0.05,
          category: 'dairy',
          source: 'openfoodfacts',
        },
      } satisfies BarcodeLookup;
    }

    if (method === 'POST' && path === '/api/barcodes/link') {
      const b = body as BarcodeLinkBody;
      barcodeMap.set(b.code, b.item_id);
      return bump();
    }

    if (method === 'POST' && path === '/api/push/subscribe') {
      st.push_subscribed = true;
      return bump();
    }
    if (method === 'DELETE' && path === '/api/push/subscribe') {
      st.push_subscribed = false;
      return bump();
    }
    if (method === 'POST' && path === '/api/push/test') {
      return { ok: true, sent: 0, pruned: 0 };
    }

    if (method === 'POST' && path === '/api/logout') {
      return { ok: true };
    }

    throw new ApiError(404, `Demo route not found: ${method} ${path}`);
  };
}

/** Generates CSV or JSON export text for demo mode without hitting the server. */
export function buildDemoExpenseExport(
  st: State,
  period: string,
  format: 'csv' | 'json',
): { filename: string; contentType: string; body: string } {
  const range = period ? weekRange(period) : null;
  const users = new Map(st.users.map(u => [u.id, u.name]));
  const items = new Map(st.items.map(i => [i.id, i.name]));
  const rows = st.expenses
    .filter(e => e.cost_cents != null && (!range || (e.at >= range.start && e.at < range.end)))
    .sort((a, b) => b.at - a.at)
    .map(e => ({
      cid: e.cid,
      date: isoDate(e.at),
      week: isoWeek(e.at),
      at: e.at,
      user_id: e.user_id,
      user: users.get(e.user_id) ?? 'Unknown',
      source: e.source,
      note: e.note,
      items: e.lines.map(l => items.get(l.item_id) ?? `#${l.item_id}`),
      cost_cents: e.cost_cents!,
      amount: (e.cost_cents! / 100).toFixed(2),
      currency: st.currency,
    }));

  const tag = period || 'all';
  if (format === 'json') {
    return {
      filename: `myfood-expenses-${tag}.json`,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ period: tag, currency: st.currency, expenses: rows }, null, 2),
    };
  }
  const csvCell = (v: string | number | null | undefined): string => {
    const s = v == null ? '' : String(v);
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
  };
  const header = 'date,week,user,source,note,items,cost_cents,amount,currency';
  const lines = rows.map(r =>
    [r.date, r.week, r.user, r.source, r.note ?? '', r.items.join('; '), r.cost_cents, r.amount, r.currency]
      .map(csvCell)
      .join(','),
  );
  return {
    filename: `myfood-expenses-${tag}.csv`,
    contentType: 'text/csv; charset=utf-8',
    body: [header, ...lines].join('\n'),
  };
}
