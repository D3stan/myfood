import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AiResult } from '../../shared/types.ts';
import type { AiInput } from '../../shared/types.ts';
import { E } from './index.ts';
import { data, rules } from './prompt.ts';

// The server only saves jpg|png|webp (routes.ts).
const MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const SCHEMA = z.toJSONSchema(AiResult);
const BAD_KEY = 'The AI key on the server is missing or wrong.';

/** Provider "openai": any OpenAI-compatible POST {AI_BASE_URL}/chat/completions. Returns the model's raw JSON (unvalidated). */
export async function runAiOpenai(input: AiInput, env: NodeJS.ProcessEnv): Promise<unknown> {
  const fail = (msg: string, why: string): never => { console.error(`[ai] ${msg} ${why}`); throw new Error(msg); };
  const { AI_BASE_URL: base, AI_MODEL: model, AI_API_KEY: key } = env;
  if (!base || !model) return fail(E.missing, 'AI_BASE_URL and AI_MODEL are required');
  if (!key) return fail(BAD_KEY, 'AI_API_KEY is not set');

  const schemaMode = env.AI_JSON_MODE === 'schema';
  const system = schemaMode ? rules() : `${rules()}\n\nReply with one JSON object matching this JSON schema:\n${JSON.stringify(SCHEMA)}`;
  const images = await Promise.all(input.images.map(async (p) => ({
    type: 'image_url',
    image_url: { url: `data:${MIME[path.extname(p).slice(1).toLowerCase()] ?? 'image/jpeg'};base64,${(await readFile(p)).toString('base64')}` },
  })));
  const body = {
    model, temperature: 0,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: [{ type: 'text', text: data(input, { imageRefs: false }) }, ...images] },
    ],
    response_format: schemaMode
      ? { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: SCHEMA } }
      : { type: 'json_object' },
  };

  // Network, timeout and body-read errors are caught here; our own fail() calls stay outside this try.
  let res: Response; let json: { choices?: { message?: { content?: unknown } }[] } = {};
  try {
    res = await fetch(`${base.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(env.AI_TIMEOUT_MS) || 180_000),
    });
    if (res.ok) json = await res.json().catch(() => ({}));
  } catch (e) {
    const name = (e as Error).name;
    return name === 'TimeoutError' || name === 'AbortError' ? fail(E.slow, 'timed out') : fail(E.failed, String(e));
  }
  if (res.status === 401 || res.status === 403) return fail(BAD_KEY, `HTTP ${res.status}`);
  if (!res.ok) return fail(E.failed, `HTTP ${res.status}`);
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return fail(E.nonsense, 'no message content');
  try { return JSON.parse(content); } catch { return fail(E.nonsense, 'content is not JSON'); }
}
