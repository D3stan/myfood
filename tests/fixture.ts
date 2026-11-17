// A realistic State for tests and for building screens without a server.
import { isoDate, isoWeek } from '../src/shared/dates.ts';
import type { Item, State } from '../src/shared/types.ts';

const now = Date.UTC(2026, 10, 15, 7, 10);
const inDays = (d: number) => isoDate(now + d * 86_400_000);

const base = (
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
): Item => ({
  id, name, emoji, category, unit, step, pack_size, low_at, stock,
  owner_id: null, is_cooked: false, portion_g: null, expires_at: null,
  shelf_life_days: null, kcal_per_unit: null, protein_per_unit: null, fat_per_unit: null, carbs_per_unit: null,
  ...extra,
});

const buyEv = {
  cid: 'ev-00000001', user_id: 1, at: now - 3_600_000 * 40, kind: 'buy' as const,
  source: 'receipt' as const, note: 'REMA 1000', preset_id: null, cost_cents: 12450, counts_nutrition: true,
  lines: [
    { item_id: 1, qty: 10, is_set: false, cost_cents: 2900 },
    { item_id: 3, qty: 16, is_set: false, cost_cents: 3200 },
    { item_id: 7, qty: 1, is_set: true, cost_cents: 1800 },
  ],
};

export const fixture: State = {
  rev: 42, build: 'dev', now,
  me: { id: 1, name: 'Sam', emoji: '🦊', notify_low: true, notify_expiry: true, goals: { kcal: null, protein_g: null, fat_g: null, carbs_g: null } },
  users: [{ id: 1, name: 'Sam', emoji: '🦊' }, { id: 2, name: 'Robin', emoji: '🐻' }],
  items: [
    base(1, 'Eggs', '🥚', 'dairy', 'pc', 1, 10, 3, 7, { expires_at: inDays(10), shelf_life_days: 21, kcal_per_unit: 78, protein_per_unit: 6.3 }),
    base(2, 'Gouda slices', '🧀', 'dairy', 'slice', 0.5, 12, 2, 10.5, { expires_at: inDays(7), kcal_per_unit: 72, protein_per_unit: 5 }),
    base(3, 'Bacon', '🥓', 'meat', 'slice', 0.5, 8, 2, 2, { expires_at: inDays(2), shelf_life_days: 7, kcal_per_unit: 45, protein_per_unit: 3 }),
    base(4, 'Minced beef', '🥩', 'meat', 'g', 50, 500, null, 0, { shelf_life_days: 3, kcal_per_unit: 2.1, protein_per_unit: 0.2 }),
    base(5, 'Toast bread', '🍞', 'bakery', 'slice', 0.5, 14, 3, 11, { expires_at: inDays(4), kcal_per_unit: 75, protein_per_unit: 2.6 }),
    base(6, 'Fusilli', '🍝', 'pantry', 'g', 50, 1000, 200, 750, { kcal_per_unit: 3.5, protein_per_unit: 0.12 }),
    base(7, 'Oregano', '🌿', 'spices', 'level', 1, 1, 0.25, 0.5),
    base(8, 'Salt', '🧂', 'spices', 'level', 1, 1, 0.25, 0.25),
    base(9, 'Bolognese', '🍲', 'meals', 'g', 50, 1200, null, 900, {
      owner_id: 1, is_cooked: true, portion_g: 300, expires_at: inDays(2), shelf_life_days: 4,
      kcal_per_unit: 1.4, protein_per_unit: 0.09,
      recipe: [{ item_id: 4, qty: 500 }, { item_id: 6, qty: 400 }],
    }),
  ],
  presets: [
    { id: 1, user_id: 1, name: 'Breakfast', emoji: '🍳', hour: 8, lines: [{ item_id: 3, qty: 2 }, { item_id: 2, qty: 1.5 }, { item_id: 1, qty: 3 }, { item_id: 5, qty: 3 }] },
    { id: 2, user_id: 1, name: 'Pasta night', emoji: '🍝', hour: 19.5, lines: [{ item_id: 6, qty: 150 }, { item_id: 4, qty: 250 }] },
  ],
  usual: { 1: 3, 2: 1.5, 3: 2, 5: 3, 6: 150, 9: 300 },
  events: [
    { cid: 'ev-00000003', user_id: 2, at: now - 3_600_000 * 11, kind: 'eat', source: 'manual', note: null, preset_id: null, cost_cents: null, counts_nutrition: true,
      lines: [{ item_id: 6, qty: -250, is_set: false, kcal: 875, protein_g: 30 }] },
    { cid: 'ev-00000002', user_id: 1, at: now - 3_600_000 * 24, kind: 'eat', source: 'preset', note: 'Breakfast', preset_id: 1, cost_cents: null, counts_nutrition: true,
      lines: [
        { item_id: 3, qty: -2, is_set: false, kcal: 90, protein_g: 6 },
        { item_id: 2, qty: -1.5, is_set: false, kcal: 108, protein_g: 7.5 },
        { item_id: 1, qty: -3, is_set: false, kcal: 234, protein_g: 18.9 },
        { item_id: 5, qty: -3, is_set: false, kcal: 225, protein_g: 7.8 },
      ] },
    buyEv,
  ],
  jobs: [
    { id: 9, mode: 'receipt', status: 'review', text: '', has_images: true, error: null, event_cids: [], created_at: now - 60_000,
      result: { reply: 'Found 3 things on the receipt.', events: [{ kind: 'buy', preset_id: null, total_cost: 92.5, lines: [
        { item_id: 1, new_item: null, qty: 10, raw: 'ØKO ÆG M/L 10 STK', price: 29, expires_in_days: 21 },
        { item_id: 3, new_item: null, qty: 16, raw: 'BACON I SKIVER 150G', price: 32, expires_in_days: 7 },
        { item_id: null, new_item: { name: 'Butter', emoji: '🧈', category: 'dairy', unit: 'g', step: 10, pack_size: 250, kcal_per_unit: 7.17, protein_per_unit: 0.008, expires_in_days: 30 }, qty: 250, raw: 'LURPAK SMØR 250G', price: 31.5, expires_in_days: 30 },
      ] }] } },
  ],
  ai: { ready: true },
  currency: 'kr',
  vapid_public_key: 'BTestVapidPublicKey000000000000000000000000000000000000000000000000000000000000000000000',
  push_subscribed: false,
  tokens: [{ id: 1, name: 'iPhone Siri', prefix: 'mf_test01', scopes: 'shortcut', created_at: now - 86_400_000, last_used_at: null }],
  expense_locks: [{ period: isoWeek(now - 7 * 86_400_000), locked_by: 1, locked_at: now - 86_400_000, total_cents: 45000, event_count: 3, note: null }],
  expenses: [buyEv],
  daily_nutrition: [
    { day: isoDate(now - 3_600_000 * 11), user_id: 2, kcal: 875, protein_g: 30, fat_g: 0, carbs_g: null },
    { day: isoDate(now - 3_600_000 * 24), user_id: 1, kcal: 657, protein_g: 40.2, fat_g: 0, carbs_g: null },
  ],
  guest_code: 'abcd-2345',
};
