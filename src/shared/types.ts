// The contract between server, web and the AI adapter. Change it only through the orchestrator.
import { z } from 'zod';
import { ISO_DATE_RE, ISO_WEEK_RE } from './dates.ts';

export const UNITS = ['pc', 'slice', 'g', 'ml', 'level', 'portion'] as const;
export const Unit = z.enum(UNITS);
export type Unit = z.infer<typeof Unit>;

export const KINDS = ['buy', 'eat', 'adjust'] as const;
export const Kind = z.enum(KINDS);
export type Kind = z.infer<typeof Kind>;

export const SOURCES = ['manual', 'preset', 'ai', 'receipt', 'audit', 'cook', 'barcode', 'shortcut', 'expense'] as const;
export type Source = (typeof SOURCES)[number];

export const CATEGORIES = ['meals', 'dairy', 'meat', 'bakery', 'produce', 'pantry', 'spices', 'frozen', 'drinks', 'other'] as const;
export const Category = z.enum(CATEGORIES);
export type Category = z.infer<typeof Category>;

export const JOB_MODES = ['auto', 'receipt', 'audit'] as const;
export const JobMode = z.enum(JOB_MODES);
export type JobMode = z.infer<typeof JobMode>;

export const OWNER_SCOPES = ['shared', 'mine'] as const;
export type OwnerScope = (typeof OWNER_SCOPES)[number];

/** Stock levels for `level` items, shown as full / half / low / out. */
export const LEVELS = [1, 0.5, 0.25, 0] as const;

const qty = z.number().finite().gt(0).lte(100_000);
const amount = z.number().finite().gte(0).lte(100_000);
const cents = z.number().int().min(0).max(100_000_000);
const isoDateStr = z.string().regex(ISO_DATE_RE, 'Expected YYYY-MM-DD');
const isoWeekStr = z.string().regex(ISO_WEEK_RE, 'Expected YYYY-Www');
const name = z.string().trim().min(1).max(60);
const emoji = z.string().trim().min(1).max(16);

// ---- AI ----

export const NewItem = z.object({
  name,
  emoji,
  category: Category,
  unit: Unit,
  step: qty,
  pack_size: qty,
  owner: z.enum(OWNER_SCOPES).nullish(),
  kcal_per_unit: amount.nullish(),
  protein_per_unit: amount.nullish(),
  expires_in_days: z.number().int().min(0).max(3650).nullish(),
});
export type NewItem = z.infer<typeof NewItem>;

/**
 * Exactly one of item_id / new_item is set. qty is never negative and is in the item's unit
 * (or `unit` if specified, e.g. 'portion' for a cooked meal tracked in 'g').
 */
export const AiLine = z.object({
  item_id: z.number().int().positive().nullable(),
  new_item: NewItem.nullable(),
  qty: amount,
  /** The receipt line or visual observation this came from. null for text jobs. */
  raw: z.string().max(120).nullable(),
  unit: Unit.nullish(),
  price: amount.nullish(),
  expires_in_days: z.number().int().min(0).max(3650).nullish(),
});
export type AiLine = z.infer<typeof AiLine>;

export const AiEvent = z.object({
  kind: Kind,
  preset_id: z.number().int().positive().nullable(),
  total_cost: amount.nullish(),
  lines: z.array(AiLine).min(1).max(60),
});
export type AiEvent = z.infer<typeof AiEvent>;

export const AiCookIngredient = z.object({
  item_id: z.number().int().positive(),
  qty,
});
export type AiCookIngredient = z.infer<typeof AiCookIngredient>;

export const AiCook = z.object({
  meal_item_id: z.number().int().positive().nullable(),
  name: name.nullable(),
  emoji: emoji.nullable(),
  portions: qty.nullable(),
  total_g: qty.nullable(),
  expires_in_days: z.number().int().min(0).max(60).nullable(),
  owner: z.enum(OWNER_SCOPES).nullable(),
  kcal_total: amount.nullable(),
  protein_total: amount.nullable(),
  ingredients: z.array(AiCookIngredient).max(30),
});
export type AiCook = z.infer<typeof AiCook>;

export const AiResult = z.object({
  /** One short sentence for the user. */
  reply: z.string().max(300),
  /** Empty when the message asked for nothing (then reply says why). */
  events: z.array(AiEvent).max(6),
  /** Optional cooked-meal batches parsed from the message. */
  cook: z.array(AiCook).max(3).optional(),
});
export type AiResult = z.infer<typeof AiResult>;

export interface AiContextItem {
  id: number;
  name: string;
  unit: Unit;
  pack_size: number;
  /** stock is given for text and fridge-audit jobs, omitted for receipt jobs. */
  stock?: number;
  /** Omitted when shared. */
  owner?: 'mine' | 'other';
  /** Omitted when false. */
  is_cooked?: boolean;
  /** Grams per 1 portion when cooked meal tracks both portions & grams. */
  portion_g?: number;
  /** YYYY-MM-DD when known. */
  expires_at?: string;
}

/** What the server hands the AI adapter. Built by src/server/jobs.ts, turned into a prompt by src/server/ai/prompt.ts. */
export interface AiContext {
  mode?: JobMode;
  items: AiContextItem[];
  presets: { id: number; name: string; lines: { item_id: number; qty: number }[] }[];
  /** Receipt line text (already normalised with aliasKey) -> item. Empty for text and audit jobs. */
  aliases: { text: string; item_id: number }[];
  /** Local date and time, e.g. "2026-11-15 08:10 Sunday". */
  now: string;
}

export interface AiInput {
  text: string;
  /** Absolute paths inside dir. */
  images: string[];
  /** The job folder; the only place the model may read. */
  dir: string;
  context: AiContext;
}

// ---- entities as the API returns them ----

export interface User { id: number; name: string; emoji: string }
export interface Me extends User { notify_low: boolean; notify_expiry: boolean }

export interface Item {
  id: number;
  name: string;
  emoji: string;
  category: Category;
  unit: Unit;
  /** What one stepper tap changes. */
  step: number;
  /** Units in one bought pack. */
  pack_size: number;
  /** At or below this the item is "running low". null = only when it is out. */
  low_at: number | null;
  /** Raw result of computeStock: can be negative. Always display it through shown(). */
  stock: number;
  /** null = shared household item; user id = personal item. */
  owner_id: number | null;
  is_cooked: boolean;
  /** Grams per 1 portion when cooked meal tracks both portions and grams. */
  portion_g: number | null;
  /** YYYY-MM-DD earliest/active expiry date, or null. */
  expires_at: string | null;
  shelf_life_days: number | null;
  /** Nutrition per 1 item.unit (for g/ml, per 1 g/ml; UI edits per 100). */
  kcal_per_unit: number | null;
  protein_per_unit: number | null;
  /** Last saved ingredients for a cooked meal item. */
  recipe?: { item_id: number; qty: number }[];
}

/** is_set: qty is the absolute amount. Otherwise qty is signed: + bought, - eaten. */
export interface EventLine {
  item_id: number;
  qty: number;
  is_set: boolean;
  cost_cents?: number | null;
  expires_at?: string | null;
  kcal?: number | null;
  protein_g?: number | null;
}

export interface FoodEvent {
  /** Client-generated id; the event's key everywhere. */
  cid: string;
  user_id: number;
  /** Unix milliseconds. */
  at: number;
  kind: Kind;
  source: Source;
  note: string | null;
  preset_id: number | null;
  cost_cents: number | null;
  /** false for cook raw-ingredient consumption so cooking doesn't double-count daily eaten macros. */
  counts_nutrition: boolean;
  lines: EventLine[];
}

export interface Preset {
  id: number;
  user_id: number;
  name: string;
  emoji: string;
  /** Typical local hour (0-23.99) this preset is used. */
  hour: number;
  lines: { item_id: number; qty: number }[];
}

export type JobStatus = 'queued' | 'running' | 'review' | 'done' | 'failed';

export interface Job {
  id: number;
  mode: JobMode;
  status: JobStatus;
  text: string;
  has_images: boolean;
  /** Set from `review` on. */
  result: AiResult | null;
  /** A sentence the user can read. */
  error: string | null;
  /** Events this job created; lets the client offer Undo. */
  event_cids: string[];
  created_at: number;
}

export interface ApiTokenInfo {
  id: number;
  name: string;
  prefix: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
}

export interface ExpenseLock {
  period: string;
  locked_by: number;
  locked_at: number;
  total_cents: number;
  event_count: number;
  note: string | null;
}

export interface DailyNutrition {
  /** Local YYYY-MM-DD */
  day: string;
  user_id: number;
  kcal: number;
  protein_g: number;
}

export interface BarcodeProduct {
  code: string;
  product_name: string | null;
  brand: string | null;
  unit: Unit;
  pack_size: number;
  kcal_per_unit: number | null;
  protein_per_unit: number | null;
  category: Category;
  source: 'manual' | 'openfoodfacts';
}

export interface BarcodeLookup {
  found: boolean;
  code: string;
  item_id: number | null;
  product: BarcodeProduct | null;
}

export interface State {
  /** Bumped by every mutation. A response with a lower rev than the one held is stale. */
  rev: number;
  /** Id of the deployed build; when it differs from the running bundle the app updates itself. */
  build: string;
  /** Server clock, unix ms. */
  now: number;
  me: Me;
  users: User[];
  /** Not archived, sorted by category then name. */
  items: Item[];
  /** The signed-in user's presets. */
  presets: Preset[];
  /** item id -> the amount this user took last time. Missing = use item.step. */
  usual: Record<number, number>;
  /** Newest first, at most 100, undone events left out. */
  events: FoodEvent[];
  /** The signed-in user's jobs that are not dismissed, newest first. */
  jobs: Job[];
  /** Outcome of the most recent AI job. null = no job has run since start-up. */
  ai: { ready: boolean | null };
  currency: string;
  vapid_public_key: string | null;
  push_subscribed: boolean;
  tokens: ApiTokenInfo[];
  expense_locks: ExpenseLock[];
  /** Last 90 days of purchase/expense events (cost_cents != null), newest first. */
  expenses: FoodEvent[];
  /** Last 30 days of daily nutrition totals per user. */
  daily_nutrition: DailyNutrition[];
}

export interface Health { ok: true; build: string; ai: boolean | null }
export interface ApiError { error: string }

// ---- request bodies ----

export const LoginBody = z.object({ code: z.string().trim().min(8).max(40) });

export const LineIn = z.object({
  item_id: z.number().int().positive(),
  qty: amount,
  cost_cents: cents.nullish(),
  expires_at: isoDateStr.nullish(),
});
export type LineIn = z.infer<typeof LineIn>;

/**
 * qty is never negative. What it means depends on kind and unit (see toLines in stock.ts):
 * buy adds, eat removes, adjust sets the stock to qty. On a `level` item qty is always the new level.
 */
export const EventBody = z.object({
  cid: z.string().min(8).max(64),
  /** Client clock, unix ms. The server caps it at its own clock. */
  at: z.number().int().positive(),
  kind: Kind,
  lines: z.array(LineIn).min(1).max(60),
  preset_id: z.number().int().positive().nullish(),
  note: z.string().trim().max(200).nullish(),
  cost_cents: cents.nullish(),
});
export type EventBody = z.infer<typeof EventBody>;

export const EventPatch = z.object({
  lines: EventBody.shape.lines,
  cost_cents: cents.nullish(),
  note: z.string().trim().max(200).nullish(),
});
export type EventPatch = z.infer<typeof EventPatch>;

export const ItemBody = z.object({
  name, emoji, category: Category, unit: Unit,
  step: qty, pack_size: qty,
  low_at: amount.nullable(),
  owner_id: z.number().int().positive().nullish(),
  is_cooked: z.boolean().optional(),
  portion_g: qty.nullish(),
  expires_at: isoDateStr.nullish(),
  shelf_life_days: z.number().int().min(1).max(3650).nullish(),
  kcal_per_unit: amount.nullish(),
  protein_per_unit: amount.nullish(),
  barcode: z.string().trim().regex(/^\d{6,14}$/).nullish(),
});
export type ItemBody = z.infer<typeof ItemBody>;
export const ItemPatch = ItemBody.partial();
export type ItemPatch = z.infer<typeof ItemPatch>;

export const PresetBody = z.object({
  name, emoji,
  hour: z.number().gte(0).lt(24),
  lines: z.array(LineIn).min(1).max(30),
});
export type PresetBody = z.infer<typeof PresetBody>;

export const MeBody = z.object({
  name: name.optional(),
  emoji: emoji.optional(),
  notify_low: z.boolean().optional(),
  notify_expiry: z.boolean().optional(),
});
export type MeBody = z.infer<typeof MeBody>;

export const SettingsBody = z.object({
  currency: z.string().trim().min(1).max(8),
});
export type SettingsBody = z.infer<typeof SettingsBody>;

/** The review sheet sends back the (possibly edited) events/cooked meals of the proposal. */
export const ApplyBody = z.object({
  events: z.array(AiEvent).max(6),
  cook: z.array(AiCook).max(3).optional(),
});
export type ApplyBody = z.infer<typeof ApplyBody>;

export const CookIngredientIn = z.object({ item_id: z.number().int().positive(), qty });
export type CookIngredientIn = z.infer<typeof CookIngredientIn>;

export const CookBody = z.object({
  cid: z.string().min(8).max(64),
  at: z.number().int().positive(),
  meal_item_id: z.number().int().positive().nullish(),
  name: name.nullish(),
  emoji: emoji.nullish(),
  owner_id: z.number().int().positive().nullish(),
  portions: qty.nullish(),
  total_g: qty.nullish(),
  expires_at: isoDateStr.nullish(),
  kcal_total: amount.nullish(),
  protein_total: amount.nullish(),
  ingredients: z.array(CookIngredientIn).max(30),
});
export type CookBody = z.infer<typeof CookBody>;

export const ExpenseBody = z.object({
  cid: z.string().min(8).max(64),
  at: z.number().int().positive(),
  cost_cents: z.number().int().positive().max(100_000_000),
  note: z.string().trim().max(200).nullish(),
});
export type ExpenseBody = z.infer<typeof ExpenseBody>;

export const LockPeriodBody = z.object({
  period: isoWeekStr,
  note: z.string().trim().max(200).nullish(),
});
export type LockPeriodBody = z.infer<typeof LockPeriodBody>;

export const TokenBody = z.object({ name });
export type TokenBody = z.infer<typeof TokenBody>;

export const ShortcutBody = z.object({
  text: z.string().trim().min(1).max(500).optional(),
  preset: name.optional(),
  preset_id: z.number().int().positive().optional(),
  async: z.boolean().optional(),
});
export type ShortcutBody = z.infer<typeof ShortcutBody>;

export const PushSubscribeBody = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(10).max(500),
    auth: z.string().min(6).max(200),
  }),
});
export type PushSubscribeBody = z.infer<typeof PushSubscribeBody>;

export const PushUnsubscribeBody = z.object({
  endpoint: z.string().url().max(2000),
});
export type PushUnsubscribeBody = z.infer<typeof PushUnsubscribeBody>;

export const BarcodeLinkBody = z.object({
  code: z.string().trim().regex(/^\d{6,14}$/),
  item_id: z.number().int().positive(),
});
export type BarcodeLinkBody = z.infer<typeof BarcodeLinkBody>;

/** What the client may queue while offline. Both are idempotent by cid. */
export type PendingOp = { type: 'event'; body: EventBody } | { type: 'undo'; cid: string };
