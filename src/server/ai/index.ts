import { AiResult } from '../../shared/types.ts';
import type { AiInput } from '../../shared/types.ts';
import { runAiAgy } from './agy.ts';
import { runAiOpenai } from './openai.ts';

export const E = {
  slow: 'The AI took too long. Try again.',
  login: 'The AI is not signed in on the server yet.',
  photo: 'The AI could not read the photo.',
  nonsense: 'The AI gave an answer I could not understand.',
  failed: 'The AI failed. Try again.',
  missing: 'The AI is not installed on the server.',
};

/** A provider returns the model's raw JSON, or throws an Error whose message is one of E. */
export type Provider = (input: AiInput, env: NodeJS.ProcessEnv) => Promise<unknown>;

export async function runAi(input: AiInput): Promise<AiResult> {
  const name = process.env.AI_PROVIDER || 'agy';
  // Built per call: agy.ts and openai.ts import E from here, so these bindings are not ready at load time.
  const provider = ({ agy: runAiAgy, openai: runAiOpenai } as Record<string, Provider>)[name];
  if (!provider) { console.error(`[ai] unknown AI_PROVIDER ${name}`); throw new Error(E.missing); }
  const structured = await provider(input, process.env);
  const res = AiResult.safeParse(structured);
  // The contract says exactly one of item_id / new_item per line, and cook needs portions or total_g plus a name if new.
  if (
    !res.success ||
    res.data.events.some((e) => e.lines.some((l) => (l.item_id === null) === (l.new_item === null))) ||
    res.data.cook?.some((c) => (c.portions === null && c.total_g === null) || (c.meal_item_id === null && !c.name))
  ) {
    console.error(`[ai] ${E.nonsense}`);
    throw new Error(E.nonsense);
  }
  return res.data;
}
