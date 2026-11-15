// A realistic State for tests and for building screens without a server.
import type { State } from '../src/shared/types.ts';

const now = Date.UTC(2026, 10, 15, 7, 10);
export const fixture: State = {
  rev: 42, build: 'dev', now,
  me: { id: 1, name: 'Sam', emoji: '🦊' },
  users: [{ id: 1, name: 'Sam', emoji: '🦊' }, { id: 2, name: 'Robin', emoji: '🐻' }],
  items: [
    { id: 1, name: 'Eggs', emoji: '🥚', category: 'dairy', unit: 'pc', step: 1, pack_size: 10, low_at: 3, stock: 7 },
    { id: 2, name: 'Gouda slices', emoji: '🧀', category: 'dairy', unit: 'slice', step: 0.5, pack_size: 12, low_at: 2, stock: 10.5 },
    { id: 3, name: 'Bacon', emoji: '🥓', category: 'meat', unit: 'slice', step: 0.5, pack_size: 8, low_at: 2, stock: 2 },
    { id: 4, name: 'Minced beef', emoji: '🥩', category: 'meat', unit: 'g', step: 50, pack_size: 500, low_at: null, stock: 0 },
    { id: 5, name: 'Toast bread', emoji: '🍞', category: 'bakery', unit: 'slice', step: 0.5, pack_size: 14, low_at: 3, stock: 11 },
    { id: 6, name: 'Fusilli', emoji: '🍝', category: 'pantry', unit: 'g', step: 50, pack_size: 1000, low_at: 200, stock: 750 },
    { id: 7, name: 'Oregano', emoji: '🌿', category: 'spices', unit: 'level', step: 1, pack_size: 1, low_at: 0.25, stock: 0.5 },
    { id: 8, name: 'Salt', emoji: '🧂', category: 'spices', unit: 'level', step: 1, pack_size: 1, low_at: 0.25, stock: 0.25 },
  ],
  presets: [
    { id: 1, user_id: 1, name: 'Breakfast', emoji: '🍳', hour: 8, lines: [{ item_id: 3, qty: 2 }, { item_id: 2, qty: 1.5 }, { item_id: 1, qty: 3 }, { item_id: 5, qty: 3 }] },
    { id: 2, user_id: 1, name: 'Pasta night', emoji: '🍝', hour: 19.5, lines: [{ item_id: 6, qty: 150 }, { item_id: 4, qty: 250 }] },
  ],
  usual: { 1: 3, 2: 1.5, 3: 2, 5: 3, 6: 150 },
  events: [
    { cid: 'ev-00000003', user_id: 2, at: now - 3_600_000 * 11, kind: 'eat', source: 'manual', note: null, preset_id: null, lines: [{ item_id: 6, qty: -250, is_set: false }] },
    { cid: 'ev-00000002', user_id: 1, at: now - 3_600_000 * 24, kind: 'eat', source: 'preset', note: 'Breakfast', preset_id: 1, lines: [{ item_id: 3, qty: -2, is_set: false }, { item_id: 2, qty: -1.5, is_set: false }, { item_id: 1, qty: -3, is_set: false }, { item_id: 5, qty: -3, is_set: false }] },
    { cid: 'ev-00000001', user_id: 1, at: now - 3_600_000 * 40, kind: 'buy', source: 'receipt', note: 'REMA 1000', preset_id: null, lines: [{ item_id: 1, qty: 10, is_set: false }, { item_id: 3, qty: 16, is_set: false }, { item_id: 7, qty: 1, is_set: true }] },
  ],
  jobs: [
    { id: 9, status: 'review', text: '', has_images: true, error: null, event_cids: [], created_at: now - 60_000,
      result: { reply: 'Found 3 things on the receipt.', events: [{ kind: 'buy', preset_id: null, lines: [
        { item_id: 1, new_item: null, qty: 10, raw: 'ØKO ÆG M/L 10 STK' },
        { item_id: 3, new_item: null, qty: 16, raw: 'BACON I SKIVER 150G' },
        { item_id: null, new_item: { name: 'Butter', emoji: '🧈', category: 'dairy', unit: 'g', step: 10, pack_size: 250 }, qty: 250, raw: 'LURPAK SMØR 250G' },
      ] }] } },
  ],
  ai: { ready: true },
};
