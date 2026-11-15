import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';
import { get, run } from './db.ts';

export const DAY = 86_400_000;
const YEAR = 365 * DAY;

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Equal-length hex strings only (hashes). */
const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Failed logins per client in a sliding window, kept in memory. */
export function createThrottle(limit = 5, windowMs = 60_000) {
  const hits = new Map<string, number[]>();
  const recent = (key: string, now: number): number[] => {
    const list = (hits.get(key) ?? []).filter(t => now - t < windowMs);
    if (list.length) hits.set(key, list); else hits.delete(key);
    return list;
  };
  return {
    blocked: (key: string, now: number): boolean => recent(key, now).length >= limit,
    fail(key: string, now: number): void {
      const list = recent(key, now);
      list.push(now);
      hits.set(key, list);
      if (hits.size > 1000) for (const k of [...hits.keys()]) recent(k, now);
    },
  };
}
export type Throttle = ReturnType<typeof createThrottle>;

/** Returns the new session token (raw, for the cookie) or null when the code is wrong. */
export function createSession(db: Db, code: string, now: number): { token: string; userId: number } | null {
  const hash = sha256(code.trim().toLowerCase());
  const user = get<{ id: number; code_hash: string }>(db, 'SELECT id, code_hash FROM users WHERE code_hash = ?', hash);
  if (!user || !same(user.code_hash, hash)) return null;
  run(db, 'DELETE FROM sessions WHERE last_seen_at < ?', now - YEAR);
  const token = randomBytes(32).toString('base64url');
  run(db, 'INSERT INTO sessions(token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)', sha256(token), user.id, now, now);
  return { token, userId: user.id };
}

/** Looks the cookie up. `renew` is true at most once a day, and then last_seen_at has already been refreshed. */
export function findSession(db: Db, token: string | undefined, now: number): { userId: number; renew: boolean } | null {
  if (!token || token.length > 100) return null;
  const hash = sha256(token);
  const s = get<{ user_id: number; last_seen_at: number }>(db, 'SELECT user_id, last_seen_at FROM sessions WHERE token_hash = ?', hash);
  if (!s || now - s.last_seen_at > YEAR) return null;
  const renew = now - s.last_seen_at > DAY;
  if (renew) run(db, 'UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', now, hash);
  return { userId: s.user_id, renew };
}

export const deleteSession = (db: Db, token: string): void => void run(db, 'DELETE FROM sessions WHERE token_hash = ?', sha256(token));
export const deleteUserSessions = (db: Db, userId: number): void => void run(db, 'DELETE FROM sessions WHERE user_id = ?', userId);

/** xxxx-xxxx-xxxx, about 60 bits. Used by the seed script. */
export function newCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 12; i++) out += (i && i % 4 === 0 ? '-' : '') + alphabet[randomInt(alphabet.length)];
  return out;
}
