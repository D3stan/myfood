// Settings pages' buttons: profile, notifications, household, presets, Siri tokens, sign out.
import { api, createToken, getData, revokeToken, rotateCode, saveSettings, subscribePush, testPush, unsubscribePush } from '../../api.ts';
import type { SettingsBody } from '../../../shared/types.ts';
import { receive, store as s } from '../../store.ts';
import { afterState, commit, exitDemo, fail, mutate, signedOut, st, toast } from '../helpers.ts';
import { shortcutText } from './shortcuts.ts';

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function loadData(): Promise<void> {
  try { s.ui.data = await getData(); } catch (e) { fail(e); }
  commit();
}

export const settingsActions: Record<string, (el: HTMLElement) => void | Promise<unknown>> = {
  delPreset: async el => {
    const p = st().presets.find(x => x.id === Number(el.dataset.id));
    if (p && confirm(`Delete ${p.name}?`) && await mutate('DELETE', `/api/presets/${p.id}`)) toast(`Deleted ${p.name}`);
  },
  saveMe: async () => {
    const f = s.ui.f, me = st().me;
    const body = {
      name: (f.meName ?? me.name).trim() || me.name,
      emoji: (f.meEmoji ?? me.emoji).trim() || me.emoji,
      notify_low: f.notifyLow !== undefined ? f.notifyLow === '1' : me.notify_low,
      notify_expiry: f.notifyExpiry !== undefined ? f.notifyExpiry === '1' : me.notify_expiry,
    };
    if (await mutate('PATCH', '/api/me', body)) {
      delete f.meName; delete f.meEmoji; toast('Saved');
    }
  },
  saveNotify: async () => {
    const f = s.ui.f, me = st().me;
    await mutate('PATCH', '/api/me', {
      notify_low: f.notifyLow !== undefined ? f.notifyLow === '1' : me.notify_low,
      notify_expiry: f.notifyExpiry !== undefined ? f.notifyExpiry === '1' : me.notify_expiry,
    });
  },
  saveSettings: async () => {
    const currency = (s.ui.f.currency ?? st().currency).trim();
    if (!currency) return void toast('Enter a currency');
    if (!navigator.onLine) return void toast("You're offline");
    try {
      receive(s, await saveSettings({ currency: currency as SettingsBody['currency'] }));
      delete s.ui.f.currency;
      toast('Saved currency');
      afterState();
    } catch (e) { fail(e); }
  },
  enablePush: async () => {
    if (typeof Notification === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      return void toast('Push notifications are not supported here');
    }
    // Call Notification.requestPermission() synchronously inside the tap gesture (required for iOS Safari 16.4+)
    const permPromise = Notification.requestPermission();
    const perm = await permPromise;
    s.ui.pushPermission = perm;
    if (perm !== 'granted') return void toast('Notification permission was not granted');
    const vapid = st().vapid_public_key;
    if (!vapid) return void toast('Push is not configured on the server');
    if (!navigator.onLine) return void toast("You're offline");
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid),
      });
      const json = sub.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        return void toast('Could not read push subscription');
      }
      receive(s, await subscribePush({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      }));
      toast('Push notifications enabled');
      afterState();
    } catch (e) { fail(e); }
  },
  disablePush: async () => {
    if (!navigator.onLine) return void toast("You're offline");
    try {
      const reg = await navigator.serviceWorker?.ready;
      const sub = await reg?.pushManager?.getSubscription();
      if (sub) {
        receive(s, await unsubscribePush({ endpoint: sub.endpoint }));
        await sub.unsubscribe().catch(() => {});
      }
      toast('Push notifications disabled');
      afterState();
    } catch (e) { fail(e); }
  },
  testPush: async () => {
    if (!navigator.onLine) return void toast("You're offline");
    try {
      const res = await testPush();
      toast(res.sent > 0 ? 'Test notification sent' : 'No active push subscription');
    } catch (e) { fail(e); }
  },
  createToken: async el => {
    const name = (s.ui.f.tokenName ?? '').trim();
    if (!name) return void toast('Give the token a name');
    if (!navigator.onLine) return void toast("You're offline");
    try {
      const res = await createToken({ name, scope: el.dataset.scope === 'mcp' ? 'mcp' : 'shortcut' });
      s.ui.newToken = res.token;
      s.ui.f.tokenName = '';
      receive(s, res.state);
      toast('Token created — copy it now');
      afterState();
    } catch (e) { fail(e); }
  },
  copyMcpUrl: async () => {
    if (!s.ui.newToken) return;
    try { await navigator.clipboard.writeText(`${location.origin}/mcp/${s.ui.newToken}`); toast('Connector URL copied'); }
    catch { toast('Copy failed — select and copy manually'); }
  },
  copyToken: async () => {
    if (!s.ui.newToken) return;
    try { await navigator.clipboard.writeText(s.ui.newToken); toast('Token copied'); }
    catch { toast('Copy failed — select and copy manually'); }
  },
  revokeToken: async el => {
    const id = Number(el.dataset.id);
    if (!id || !confirm('Revoke this token?')) return;
    if (!navigator.onLine) return void toast("You're offline");
    try {
      receive(s, await revokeToken(id));
      toast('Token revoked');
      afterState();
    } catch (e) { fail(e); }
  },
  copyShortcut: async el => {
    const kind = el.dataset.k === 'log' ? 'log' : 'ai';
    try {
      await navigator.clipboard.writeText(shortcutText(kind, location.origin, s.ui.newToken));
      toast(s.ui.newToken ? 'Setup text copied (with your token)' : 'Setup text copied — add your token where it says');
    } catch { toast('Copy failed — open "Show the steps" and copy manually'); }
  },
  newGuestCode: async () => {
    if (confirm('Make a new guest passcode? Current guests will be locked out.')) await mutate('POST', '/api/guest/code');
  },
  copyGuest: async () => {
    const code = st().guest_code;
    try { await navigator.clipboard.writeText(`${location.origin}/guest  passcode: ${code}`); toast('Guest link and passcode copied'); }
    catch { toast('Copy failed — select and copy manually'); }
  },
  delAlias: async el => {
    const text = el.dataset.text;
    if (text && await mutate('DELETE', `/api/aliases/${encodeURIComponent(text)}`)) { toast('Alias deleted'); await loadData(); }
  },
  restoreItem: async el => {
    if (await mutate('POST', `/api/items/${Number(el.dataset.id)}/restore`)) { toast('Item restored'); await loadData(); }
  },
  unlockWeek: async el => {
    const p = el.dataset.p;
    if (p && confirm(`Unlock ${p}? Its expenses can be added, edited or undone again.`) && await mutate('DELETE', `/api/expenses/lock/${encodeURIComponent(p)}`)) toast(`Unlocked ${p}`);
  },
  newAccessCode: async () => {
    if (!confirm('Make a new access code? Your other devices will be signed out.')) return;
    if (!navigator.onLine) return void toast("You're offline");
    try {
      const res = await rotateCode();
      s.ui.newCode = res.code;
      receive(s, res.state);
      toast('New access code — copy it now');
      afterState();
    } catch (e) { fail(e); }
  },
  copyAccessCode: async () => {
    if (!s.ui.newCode) return;
    try { await navigator.clipboard.writeText(s.ui.newCode); toast('Access code copied'); }
    catch { toast('Copy failed — select and copy manually'); }
  },
  logout: async () => {
    if (s.ui.demo) { exitDemo(); return; }
    await api('POST', '/api/logout').catch(() => {});
    signedOut();
  },
};
