import { generateVAPIDKeys, sendNotification } from 'web-push';
import { daysUntil, isoDate } from '../shared/dates.ts';
import { computeStock, shown } from '../shared/stock.ts';
import type { PushSubscribeBody } from '../shared/types.ts';
import type { Db } from './db.ts';
import { all, bumpRev, get, getMeta, run, setMeta, transaction } from './db.ts';

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

export type PushSender = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: PushPayload,
  vapid: VapidConfig,
) => Promise<void>;

interface SubscriptionRow {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

const DEFAULT_VAPID_SUBJECT = 'mailto:admin@food.0xpuddu.com';

/** Reads VAPID keys from meta, auto-generating and persisting them on first boot if absent. */
export function ensureVapidKeys(db: Db): VapidConfig {
  let publicKey = getMeta(db, 'vapid_public_key');
  let privateKey = getMeta(db, 'vapid_private_key');
  let subject = getMeta(db, 'vapid_subject');
  if (!subject) {
    subject = process.env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT;
    setMeta(db, 'vapid_subject', subject);
  }
  if (!publicKey || !privateKey) {
    const keys = generateVAPIDKeys();
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;
    setMeta(db, 'vapid_public_key', publicKey);
    setMeta(db, 'vapid_private_key', privateKey);
  }
  return { publicKey, privateKey, subject };
}

export const defaultSendPush: PushSender = async (sub, payload, vapid) => {
  await sendNotification(sub, JSON.stringify(payload), {
    vapidDetails: {
      subject: vapid.subject,
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
    },
  });
};

function isGoneError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { statusCode?: number; status?: number }).statusCode ?? (err as { status?: number }).status;
  return code === 404 || code === 410;
}

function loadStockMap(db: Db): Map<number, number> {
  const lines = all<{ item_id: number; qty: number; is_set: number }>(
    db,
    `SELECT l.item_id, l.qty, l.is_set FROM event_lines l JOIN events e ON e.cid = l.event_cid
     WHERE e.undone_at IS NULL ORDER BY e.at, e.seq, l.rowid`,
  ).map(l => ({ item_id: l.item_id, qty: l.qty, is_set: !!l.is_set }));
  return computeStock(lines);
}

async function deliverToSubs(
  db: Db,
  subs: SubscriptionRow[],
  payload: PushPayload,
  vapid: VapidConfig,
  sendPush: PushSender,
  now: number,
): Promise<{ sent: number; pruned: number }> {
  let sent = 0;
  let pruned = 0;
  for (const s of subs) {
    try {
      await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, vapid);
      run(db, 'UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?', now, s.id);
      sent++;
    } catch (err) {
      if (isGoneError(err)) {
        run(db, 'DELETE FROM push_subscriptions WHERE id = ?', s.id);
        pruned++;
      } else {
        console.warn('[push] delivery failed', s.id, err instanceof Error ? err.message : err);
      }
    }
  }
  return { sent, pruned };
}

function claimDedupeKey(db: Db, key: string, now: number): boolean {
  const res = run(db, 'INSERT OR IGNORE INTO push_log(dedupe_key, sent_at) VALUES (?, ?)', key, now);
  return Number(res.changes) > 0;
}

export function subscribePush(db: Db, userId: number, body: PushSubscribeBody, userAgent: string | null, now: number): void {
  transaction(db, () => {
    run(
      db,
      `INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         user_agent = excluded.user_agent`,
      userId,
      body.endpoint,
      body.keys.p256dh,
      body.keys.auth,
      userAgent,
      now,
    );
    bumpRev(db);
  });
}

export function unsubscribePush(db: Db, userId: number, endpoint: string): void {
  transaction(db, () => {
    const res = run(db, 'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', endpoint, userId);
    if (Number(res.changes) > 0) bumpRev(db);
  });
}

export async function sendTestPush(
  db: Db,
  userId: number,
  sendPush: PushSender = defaultSendPush,
  now = Date.now(),
): Promise<{ sent: number; pruned: number }> {
  const subs = all<SubscriptionRow>(db, 'SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', userId);
  if (!subs.length) return { sent: 0, pruned: 0 };
  const vapid = ensureVapidKeys(db);
  return deliverToSubs(
    db,
    subs,
    { title: 'MyFood', body: 'Push notifications are working!', tag: 'myfood-test', url: '/?tab=me' },
    vapid,
    sendPush,
    now,
  );
}

/**
 * Notifies subscribed users (notify_low = 1) when an item's stock crosses from > low_at to <= low_at.
 * Personal items notify only their owner; shared items notify all eligible users. Deduped per item per day.
 */
export async function notifyLowCrossings(
  db: Db,
  prevStocks: Map<number, number>,
  sendPush: PushSender = defaultSendPush,
  now = Date.now(),
): Promise<{ sent: number; pruned: number }> {
  const currStocks = loadStockMap(db);
  const items = all<{ id: number; name: string; emoji: string; unit: string; low_at: number | null; owner_id: number | null }>(
    db,
    'SELECT id, name, emoji, unit, low_at, owner_id FROM items WHERE archived_at IS NULL',
  );
  const subs = all<SubscriptionRow & { notify_low: number }>(
    db,
    `SELECT ps.id, ps.user_id, ps.endpoint, ps.p256dh, ps.auth, u.notify_low
     FROM push_subscriptions ps JOIN users u ON u.id = ps.user_id
     WHERE u.notify_low = 1`,
  );
  if (!subs.length) return { sent: 0, pruned: 0 };

  const today = isoDate(now);
  const vapid = ensureVapidKeys(db);
  let sent = 0;
  let pruned = 0;

  for (const item of items) {
    const threshold = item.low_at ?? 0;
    const prev = shown(prevStocks.get(item.id) ?? 0);
    const curr = shown(currStocks.get(item.id) ?? 0);
    if (!(prev > threshold && curr <= threshold)) continue;

    const targetSubs = item.owner_id != null ? subs.filter(s => s.user_id === item.owner_id) : subs;
    if (!targetSubs.length) continue;
    if (!claimDedupeKey(db, `low:${item.id}:${today}`, now)) continue;

    const body = curr <= 0
      ? `${item.emoji} ${item.name} is out of stock`
      : `${item.emoji} ${item.name} is running low (${curr} ${item.unit} left)`;
    const res = await deliverToSubs(
      db,
      targetSubs,
      { title: 'Running low', body, tag: `low-${item.id}`, url: '/' },
      vapid,
      sendPush,
      now,
    );
    sent += res.sent;
    pruned += res.pruned;
  }
  return { sent, pruned };
}

/**
 * Notifies subscribed users (notify_expiry = 1) once per day when in-stock items expire within 2 days.
 */
export async function checkExpiryPushes(
  db: Db,
  sendPush: PushSender = defaultSendPush,
  now = Date.now(),
): Promise<{ sent: number; pruned: number }> {
  const subs = all<SubscriptionRow>(
    db,
    `SELECT ps.id, ps.user_id, ps.endpoint, ps.p256dh, ps.auth
     FROM push_subscriptions ps JOIN users u ON u.id = ps.user_id
     WHERE u.notify_expiry = 1`,
  );
  if (!subs.length) return { sent: 0, pruned: 0 };

  const currStocks = loadStockMap(db);
  const items = all<{ id: number; name: string; emoji: string; owner_id: number | null; expires_at: string }>(
    db,
    'SELECT id, name, emoji, owner_id, expires_at FROM items WHERE archived_at IS NULL AND expires_at IS NOT NULL',
  );
  const soon = items
    .map(i => ({ ...i, days: daysUntil(i.expires_at, now) }))
    .filter(i => shown(currStocks.get(i.id) ?? 0) > 0 && i.days <= 2)
    .sort((a, b) => a.days - b.days || a.name.localeCompare(b.name));
  if (!soon.length) return { sent: 0, pruned: 0 };

  const subsByUser = new Map<number, SubscriptionRow[]>();
  for (const s of subs) {
    const list = subsByUser.get(s.user_id);
    if (list) list.push(s);
    else subsByUser.set(s.user_id, [s]);
  }

  const today = isoDate(now);
  const vapid = ensureVapidKeys(db);
  let sent = 0;
  let pruned = 0;

  for (const [uid, userSubs] of subsByUser) {
    const mine = soon.filter(i => i.owner_id === null || i.owner_id === uid);
    if (!mine.length) continue;
    if (!claimDedupeKey(db, `expiry:${uid}:${today}`, now)) continue;

    const whenLabel = (d: number) => (d < 0 ? 'expired' : d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d}d`);
    const body = mine.length === 1
      ? `${mine[0]!.emoji} ${mine[0]!.name} expires ${whenLabel(mine[0]!.days)}`
      : `${mine.length} items expiring soon: ${mine.slice(0, 3).map(i => `${i.emoji} ${i.name} (${whenLabel(i.days)})`).join(', ')}${mine.length > 3 ? '…' : ''}`;

    const res = await deliverToSubs(
      db,
      userSubs,
      { title: 'Expiring soon', body, tag: `expiry-${today}`, url: '/' },
      vapid,
      sendPush,
      now,
    );
    sent += res.sent;
    pruned += res.pruned;
  }
  return { sent, pruned };
}

export function hasPushSubscriptions(db: Db, userId: number): boolean {
  return !!get(db, 'SELECT 1 FROM push_subscriptions WHERE user_id = ? LIMIT 1', userId);
}
