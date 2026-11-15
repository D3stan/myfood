// The contract between server, web and the AI adapter. Change it only through the orchestrator.
import { z } from 'zod';

export const UNITS = ['pc', 'slice', 'g', 'ml', 'level'] as const;
export const Unit = z.enum(UNITS);
export type Unit = z.infer<typeof Unit>;

export const KINDS = ['buy', 'eat', 'adjust'] as const;
export const Kind = z.enum(KINDS);
export type Kind = z.infer<typeof Kind>;

export const SOURCES = ['manual', 'preset', 'ai', 'receipt'] as const;
export type Source = (typeof SOURCES)[number];

export const CATEGORIES = ['dairy', 'meat', 'bakery', 'produce', 'pantry', 'spices', 'frozen', 'drinks', 'other'] as const;
export const Category = z.enum(CATEGORIES);
export type Category = z.infer<typeof Category>;

/** Stock levels for `level` items, shown as full / half / low / out. */
export const LEVELS = [1, 0.5, 0.25, 0] as const;

const qty = z.number().finite().gt(0).lte(100_000);
const amount = z.number().finite().gte(0).lte(100_000);
const name = z.string().trim().min(1).max(60);
const emoji = z.string().trim().min(1).max(16);

// ---- AI ----

export const NewItem = z.object({ name, emoji, category: Category, unit: Unit, step: qty, pack_size: qty });
export type NewItem = z.infer<typeof NewItem>;

/**
 * Exactly one of item_id / new_item is set. qty is never negative and is in the item's unit:
 * the amount bought or eaten, or for adjust (and for any `level` item) the new amount.
 */
export const AiLine = z.object({
  item_id: z.number().int().positive().nullable(),
  new_item: NewItem.nullable(),
  qty: amount,
  /** The receipt line this came from, as printed. null for text jobs. */
  raw: z.string().max(120).nullable(),
});
export type AiLine = z.infer<typeof AiLine>;

export const AiEvent = z.object({
  kind: Kind,
  preset_id: z.number().int().positive().nullable(),
  lines: z.array(AiLine).min(1).max(60),
});
export type AiEvent = z.infer<typeof AiEvent>;

export const AiResult = z.object({
  /** One short sentence for the user. */
  reply: z.string().max(300),
  /** Empty when the message asked for nothing (then reply says why). */
  events: z.array(AiEvent).max(6),
});
export type AiResult = z.infer<typeof AiResult>;

/** What the server hands the AI adapter. Built by src/server/jobs.ts, turned into a prompt by src/server/ai/prompt.ts. */
export interface AiContext {
  /** stock is given for text jobs only. */
  items: { id: number; name: string; unit: Unit; pack_size: number; stock?: number }[];
  presets: { id: number; name: string; lines: { item_id: number; qty: number }[] }[];
  /** Receipt line text (already normalised with aliasKey) -> item. Empty for text jobs. */
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
}

/** is_set: qty is the absolute amount. Otherwise qty is signed: + bought, - eaten. */
export interface EventLine { item_id: number; qty: number; is_set: boolean }

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

export interface State {
  /** Bumped by every mutation. A response with a lower rev than the one held is stale. */
  rev: number;
  /** Id of the deployed build; when it differs from the running bundle the app updates itself. */
  build: string;
  /** Server clock, unix ms. */
  now: number;
  me: User;
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
}

export interface Health { ok: true; build: string; ai: boolean | null }
export interface ApiError { error: string }

// ---- request bodies ----

export const LoginBody = z.object({ code: z.string().trim().min(8).max(40) });

export const LineIn = z.object({ item_id: z.number().int().positive(), qty: amount });
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
});
export type EventBody = z.infer<typeof EventBody>;

export const EventPatch = z.object({ lines: EventBody.shape.lines });
export type EventPatch = z.infer<typeof EventPatch>;

export const ItemBody = z.object({
  name, emoji, category: Category, unit: Unit,
  step: qty, pack_size: qty,
  low_at: amount.nullable(),
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

export const MeBody = z.object({ name: name.optional(), emoji: emoji.optional() });
export type MeBody = z.infer<typeof MeBody>;

/** The receipt-review sheet sends back the (possibly edited) events of the proposal. */
export const ApplyBody = z.object({ events: z.array(AiEvent).min(1).max(6) });
export type ApplyBody = z.infer<typeof ApplyBody>;

/** What the client may queue while offline. Both are idempotent by cid. */
export type PendingOp = { type: 'event'; body: EventBody } | { type: 'undo'; cid: string };
