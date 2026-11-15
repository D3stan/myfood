export type FoodUnit = 'pc' | 'slice' | 'g' | 'ml' | 'level';
export type EventKind = 'buy' | 'eat' | 'adjust';

export interface PantryItem {
  id: number;
  name: string;
  emoji: string;
  category: string;
  unit: FoodUnit;
  step: number;
  packSize: number;
  stock: number;
  lowAt: number;
}

export interface EventLine {
  itemId: number;
  name: string;
  emoji: string;
  qty: number;
  unit: FoodUnit;
}

export interface PantryEvent {
  id: number;
  userName: string;
  kind: EventKind;
  source: 'manual' | 'preset' | 'ai' | 'receipt';
  note: string;
  at: string;
  lines: EventLine[];
}

export interface Preset {
  id: number;
  name: string;
  emoji: string;
  hour: number;
  lines: Array<{ itemId: number; qty: number }>;
}

export interface PantryState {
  me: { id: number; name: string; emoji: string };
  users: Array<{ id: number; name: string; emoji: string }>;
  items: PantryItem[];
  presets: Preset[];
  events: PantryEvent[];
  ai: { mode: 'demo' | 'agy'; available: boolean };
}

export interface CreateEventInput {
  cid: string;
  kind: EventKind;
  lines: Array<{ itemId: number; qty: number }>;
  presetId?: number;
  note?: string;
}

export interface AssistantInput {
  text: string;
}

export interface AssistantResult {
  reply: string;
  event?: PantryEvent;
  proposal?: Array<{ itemId: number; qty: number; name: string }>;
}
