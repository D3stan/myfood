import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from './db.ts';
import type { AssistantResult, CreateEventInput, EventKind, PantryEvent, PantryState } from '../shared/types.ts';

type ItemRow = { id: number; name: string; emoji: string; category: string; unit: PantryState['items'][number]['unit']; step: number; pack_size: number; low_at: number; stock: number };

function number(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

export function getState(userId = 1): PantryState {
  const users = db.prepare('SELECT id, name, emoji FROM users ORDER BY id').all() as PantryState['users'];
  const me = users.find((user) => user.id === userId) ?? users[0]!;
  const rows = db.prepare(`SELECT i.*, COALESCE(SUM(CASE WHEN e.undone_at IS NULL THEN el.delta ELSE 0 END), 0) AS stock
    FROM items i LEFT JOIN event_lines el ON el.item_id = i.id
    LEFT JOIN events e ON e.id = el.event_id AND e.undone_at IS NULL
    GROUP BY i.id ORDER BY i.category, i.name`).all() as ItemRow[];
  const items = rows.map((row) => ({
    id: row.id, name: row.name, emoji: row.emoji, category: row.category,
    unit: row.unit, step: row.step, packSize: row.pack_size, lowAt: row.low_at,
    stock: row.unit === 'level' ? Math.max(0, Math.min(1, row.stock)) : Math.max(0, row.stock),
  }));
  const presets = db.prepare('SELECT id, name, emoji, hour FROM presets ORDER BY hour').all() as Array<{ id: number; name: string; emoji: string; hour: number }>;
  const presetLines = db.prepare('SELECT preset_id, item_id, qty FROM preset_lines').all() as Array<{ preset_id: number; item_id: number; qty: number }>;
  const hydratedPresets = presets.map((preset) => ({
    ...preset,
    lines: presetLines.filter((line) => line.preset_id === preset.id).map((line) => ({ itemId: line.item_id, qty: line.qty })),
  }));

  const eventRows = db.prepare(`SELECT e.id, u.name AS userName, e.kind, e.source, e.note, e.at
    FROM events e JOIN users u ON u.id = e.user_id
    WHERE e.undone_at IS NULL ORDER BY e.id DESC LIMIT 30`).all() as Array<Omit<PantryEvent, 'lines'>>;
  const eventLines = db.prepare(`SELECT el.event_id AS eventId, i.id AS itemId, i.name, i.emoji, i.unit,
      ABS(el.delta) AS qty
    FROM event_lines el JOIN items i ON i.id = el.item_id
    WHERE el.event_id IN (SELECT id FROM events WHERE undone_at IS NULL ORDER BY id DESC LIMIT 30)
    ORDER BY el.id`).all() as Array<{ eventId: number; itemId: number; name: string; emoji: string; unit: PantryEvent['lines'][number]['unit']; qty: number }>;
  const events = eventRows.map((event) => ({
    ...event,
    kind: event.kind as EventKind,
    source: event.source as PantryEvent['source'],
    lines: eventLines.filter((line) => line.eventId === event.id).map(({ eventId: _eventId, ...line }) => ({ ...line, qty: number(line.qty) })),
  }));

  return { me, users, items, presets: hydratedPresets, events, ai: { mode: 'demo', available: true } };
}

export function createEvent(userId: number, input: CreateEventInput, source: PantryEvent['source'] = 'manual'): PantryState {
  const existing = db.prepare('SELECT id FROM events WHERE cid = ?').get(input.cid) as { id: number } | undefined;
  if (existing) return getState(userId);
  if (!input.lines.length || input.lines.length > 60) throw new Error('Add between 1 and 60 food items.');
  const insert = db.prepare('INSERT INTO events (cid, user_id, kind, source, note) VALUES (?, ?, ?, ?, ?)');
  const lineInsert = db.prepare('INSERT INTO event_lines (event_id, item_id, delta) VALUES (?, ?, ?)');
  const stockFor = db.prepare(`SELECT COALESCE(SUM(el.delta), 0) AS stock FROM event_lines el
    JOIN events e ON e.id = el.event_id WHERE el.item_id = ? AND e.undone_at IS NULL`);
  const itemFor = db.prepare('SELECT id, unit FROM items WHERE id = ?');
  const transaction = () => {
    db.exec('BEGIN');
    try {
    const result = insert.run(input.cid, userId, input.kind, source, input.note ?? '');
    const eventId = Number(result.lastInsertRowid);
    for (const line of input.lines) {
      const item = itemFor.get(line.itemId) as { id: number; unit: string } | undefined;
      const qty = number(line.qty);
      if (!item || !Number.isFinite(qty) || qty <= 0 || qty > 100000) throw new Error('One of those quantities is invalid.');
      if (input.kind === 'eat') {
        const stock = number((stockFor.get(line.itemId) as { stock: number }).stock);
        lineInsert.run(eventId, line.itemId, -Math.min(qty, Math.max(0, stock)));
      } else if (input.kind === 'adjust') {
        const stock = number((stockFor.get(line.itemId) as { stock: number }).stock);
        lineInsert.run(eventId, line.itemId, qty - stock);
      } else {
        lineInsert.run(eventId, line.itemId, qty);
      }
    }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  transaction();
  return getState(userId);
}

export function undoEvent(userId: number, eventId: number): PantryState {
  db.prepare('UPDATE events SET undone_at = datetime(\'now\') WHERE id = ?').run(eventId);
  return getState(userId);
}

export function createItem(input: { name: string; emoji: string; category: string; unit: string; step: number; packSize: number; lowAt: number }): PantryState {
  const result = db.prepare(`INSERT INTO items (name, emoji, category, unit, step, pack_size, low_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.name.trim(), input.emoji, input.category.trim(), input.unit, input.step, input.packSize, input.lowAt);
  const itemId = Number(result.lastInsertRowid);
  if (input.unit === 'level') {
    const eventId = Number(db.prepare(`INSERT INTO events (cid, user_id, kind, source, note)
      VALUES (?, 1, 'adjust', 'manual', 'Added spice')`).run(randomUUID()).lastInsertRowid);
    db.prepare('INSERT INTO event_lines (event_id, item_id, delta) VALUES (?, ?, ?)').run(eventId, itemId, 0);
  }
  return getState();
}

const aliases: Record<string, string[]> = {
  Eggs: ['eggs', 'egg', 'æg', 'ægge', 'ægget'],
  Bacon: ['bacon', 'bacon skiver', 'bacon i skiver'],
  Cheese: ['cheese', 'ost', 'osteskiver'],
  Bread: ['bread', 'toast', 'brød', 'brødskiver'],
  Pasta: ['pasta', 'spaghetti'],
  'Minced meat': ['minced meat', 'mince', 'ground beef', 'hakket oksekød', 'hakket kød'],
  Oregano: ['oregano'],
};

function parseQuantity(text: string): number {
  const numeric = text.match(/\b(\d+(?:[.,]\d+)?)\b/);
  if (numeric) return Number(numeric[1]!.replace(',', '.'));
  if (/\b(?:half|halv|halvt)\b/.test(text)) return 0.5;
  return 1;
}

export function interpretText(userId: number, text: string): AssistantResult {
  const normalized = text.toLocaleLowerCase('da').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const state = getState(userId);
  const breakfast = state.presets.find((preset) => /breakfast|morgenmad/i.test(preset.name));
  if (/breakfast|morgenmad|lavede morgen|spiste morgen/i.test(normalized) && breakfast) {
    const stateAfter = createEvent(userId, { cid: randomUUID(), kind: 'eat', presetId: breakfast.id, lines: breakfast.lines, note: breakfast.name }, 'ai');
    return { reply: 'Breakfast logged — just like your usual 🍳', event: stateAfter.events[0] };
  }

  const direction: EventKind | undefined = /bought|buy|købte|koebte|tilføjede|added|add/i.test(normalized)
    ? 'buy'
    : /ate|eat|eaten|spiste|tog|used|made|lavede/i.test(normalized) ? 'eat' : undefined;
  if (!direction) return { reply: 'Try “ate 2 eggs”, “bought bacon”, or “made breakfast”.' };
  const found = state.items
    .flatMap((item) => (aliases[item.name] ?? [item.name.toLowerCase()]).map((alias) => ({ item, alias })))
    .filter(({ alias }) => normalized.includes(alias.normalize('NFD').replace(/[\u0300-\u036f]/g, '')))
    .sort((a, b) => b.alias.length - a.alias.length)[0];
  if (!found) return { reply: 'I couldn’t match that food yet. Pick an item from your pantry to log it.' };

  let qty = parseQuantity(normalized);
  if (direction === 'buy' && /pack|pakke/i.test(normalized)) qty *= found.item.packSize;
  const next = createEvent(userId, {
    cid: randomUUID(), kind: direction, lines: [{ itemId: found.item.id, qty }], note: text,
  }, 'ai');
  return {
    reply: `${direction === 'buy' ? 'Added' : 'Logged'} ${qty} ${found.item.unit === 'pc' ? 'eggs' : found.item.unit === 'slice' ? 'slices' : found.item.unit} of ${found.item.name}.`,
    event: next.events[0],
  };
}

function findUserByPin(pin: string): { id: number; name: string; emoji: string } | undefined {
  const rows = db.prepare('SELECT id, name, emoji, pin_hash FROM users').all() as Array<{ id: number; name: string; emoji: string; pin_hash: string }>;
  const user = rows.find((row) => {
    const [salt, stored] = row.pin_hash.split(':');
    if (!salt || !stored) return false;
    const actual = scryptSync(pin, salt, 64);
    const expected = Buffer.from(stored, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  });
  return user ? { id: user.id, name: user.name, emoji: user.emoji } : undefined;
}

export function login(pin: string): { token: string; user: { id: number; name: string; emoji: string } } | undefined {
  const user = findUserByPin(pin);
  if (!user) return undefined;
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash, user.id, expiresAt);
  return { token, user };
}

export function updateMe(userId: number, input: { name?: string; emoji?: string; pin?: string }): PantryState {
  if (input.pin !== undefined) {
    const pin = input.pin.trim();
    const minLen = process.env.NODE_ENV === 'production' ? 6 : 4;
    if (pin.length < minLen || pin.length > 32) {
      throw new Error(`PIN must be at least ${minLen} digits.`);
    }
    const existing = findUserByPin(pin);
    if (existing && existing.id !== userId) {
      throw new Error('Choose a PIN that is different from your kitchen pal.');
    }
    const salt = randomBytes(16).toString('hex');
    const pinHash = `${salt}:${scryptSync(pin, salt, 64).toString('hex')}`;
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(pinHash, userId);
  }
  if (input.name !== undefined) {
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(input.name.trim(), userId);
  }
  if (input.emoji !== undefined) {
    db.prepare('UPDATE users SET emoji = ? WHERE id = ?').run(input.emoji.trim(), userId);
  }
  return getState(userId);
}

export function userForSession(token: string | undefined): number | undefined {
  if (!token) return undefined;
  const hash = createHash('sha256').update(token).digest('hex');
  const row = db.prepare(`SELECT user_id AS id FROM sessions WHERE token_hash = ? AND expires_at > ?`).get(hash, new Date().toISOString()) as { id: number } | undefined;
  return row?.id;
}
