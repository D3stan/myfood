import { spawn } from 'node:child_process';
import { z } from 'zod';
import { AiResult } from '../../shared/types.ts';
import type { AiInput } from '../../shared/types.ts';
import { buildPrompt } from './prompt.ts';

// Measured on agy 1.5.9: receipt ~12 s, text ~8 s with this model and effort.
const DEFAULT_MODEL = 'gemini-3.8-flash-low';
const MAX_OUT = 2_000_000;
// Images are inlined with @file in the prompt, so no tool is needed. Anything else is denied; headless mode
// cannot ask, so unlisted tools are soft-denied as well.
const SETTINGS = JSON.stringify({ permissions: { deny: ['command(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'] } });
const SCHEMA = JSON.stringify(z.toJSONSchema(AiResult));

const E = {
  slow: 'The AI took too long. Try again.',
  login: 'The AI is not signed in on the server yet.',
  photo: 'The AI could not read the photo.',
  nonsense: 'The AI gave an answer I could not understand.',
  failed: 'The AI failed. Try again.',
  missing: 'The AI is not installed on the server.',
};

/** Best effort: agy has no documented exit code for "not signed in", so this matches its words. */
const NOT_SIGNED_IN = /not (logged|signed) in|log ?in required|sign ?in required|please (log|sign) ?in|unauthenticated|unauthorized|authentication (failed|required)|no (valid )?credentials|oauth|invalid_grant|\b401\b/i;

export function buildArgv(input: AiInput, timeoutMs: number, env = process.env): string[] {
  return argv(buildPrompt(input), SCHEMA, timeoutMs, env);
}

function argv(prompt: string, schema: string, timeoutMs: number, env = process.env): string[] {
  return ['-p', prompt, '--output-format', 'json', '--json-schema', schema,
    '--print-timeout', `${Math.max(1, Math.floor(timeoutMs / 1000) - 2)}s`,
    '--model', env.AI_MODEL || DEFAULT_MODEL, '--effort', env.AI_EFFORT || 'low',
    '--settings', SETTINGS, '--disable-slash-commands'];
}

interface Run { code: number | null; stdout: string; stderr: string; timedOut: boolean; tooBig: boolean; spawnError?: NodeJS.ErrnoException }

function run(cmd: string[], args: string[], cwd: string, timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    const out: Buffer[] = []; let size = 0; let stderr = ''; let timedOut = false; let tooBig = false;
    const child = spawn(cmd[0]!, [...cmd.slice(1), ...args], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const killGroup = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => { size += b.length; if (size > MAX_OUT) { tooBig = true; killGroup(); } else out.push(b); });
    child.stderr.on('data', (b: Buffer) => { if (stderr.length < 20_000) stderr += b; });
    const end = (r: Partial<Run>) => { clearTimeout(timer); killGroup(); resolve({ code: null, stdout: Buffer.concat(out).toString('utf8'), stderr, timedOut, tooBig, ...r }); };
    child.on('error', (spawnError) => end({ spawnError }));
    child.on('close', (code) => end({ code }));
  });
}

const parse = (s: unknown): unknown => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return undefined; } };

/** Runs agy once with `prompt` and a JSON schema; returns the structured output (unvalidated). `deniedMsg` is the error when agy was refused a tool. */
export async function runAgy(prompt: string, schema: object, dir: string, deniedMsg = E.failed): Promise<unknown> {
  const cmd = (process.env.AI_CMD || 'agy').trim().split(/\s+/);
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS) || 180_000;
  const r = await run(cmd, argv(prompt, JSON.stringify(schema), timeoutMs), dir, timeoutMs);
  const fail = (msg: string): never => {
    console.error(`[ai] ${msg} exit=${r.code} stderr=${r.stderr.trim().slice(-1500)}`);
    throw new Error(msg);
  };

  if (r.timedOut) return fail(E.slow);
  if (r.spawnError) return fail(r.spawnError.code === 'ENOENT' ? E.missing : E.failed);
  if (r.tooBig) return fail(E.nonsense);

  const o = parse(r.stdout.trim()) as { status?: string; structured_output?: unknown; response?: unknown; denied_actions?: unknown[] } | undefined;
  const structured = o && typeof o === 'object' ? (o.structured_output ?? parse(o.response)) : undefined;
  if (!structured) {
    // 127 is the shell's "command not found": the wrapper ran but there is no agy binary behind it.
    if (r.code === 127) return fail(E.missing);
    if (NOT_SIGNED_IN.test(r.stderr) || NOT_SIGNED_IN.test(r.stdout)) return fail(E.login);
    if (o?.denied_actions?.length) return fail(deniedMsg);
    if (r.code !== 0 || (o && o.status && o.status !== 'SUCCESS')) return fail(E.failed);
    return fail(E.nonsense);
  }
  return structured;
}

export async function runAi(input: AiInput): Promise<AiResult> {
  const structured = await runAgy(buildPrompt(input), z.toJSONSchema(AiResult), input.dir, input.images.length ? E.photo : E.failed);
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
