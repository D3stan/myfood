import { clientsClaim, setCacheNameDetails } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

interface PushPayload {
  title?: string;
  body?: string;
  tag?: string;
  url?: string;
}

interface SwWindowClient {
  url: string;
  focus?: () => Promise<SwWindowClient>;
  navigate?: (url: string) => Promise<SwWindowClient | null>;
}

interface SwScope {
  skipWaiting(): Promise<void>;
  clients: {
    matchAll(opts?: { type?: 'window'; includeUncontrolled?: boolean }): Promise<SwWindowClient[]>;
    openWindow(url: string): Promise<SwWindowClient | null>;
  };
  registration: ServiceWorkerRegistration;
  addEventListener(type: 'message', listener: (ev: { data?: { type?: string } }) => void): void;
  addEventListener(type: 'push', listener: (ev: { data?: { json(): PushPayload; text(): string }; waitUntil(p: Promise<unknown>): void }) => void): void;
  addEventListener(type: 'notificationclick', listener: (ev: { notification: Notification; waitUntil(p: Promise<unknown>): void }) => void): void;
}

const sw = self as unknown as SwScope;

setCacheNameDetails({ prefix: 'myfood', suffix: 'v2-level-containers' });

// @ts-expect-error -- injected by workbox-build during injectManifest
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

void sw.skipWaiting();
clientsClaim();

registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//] }));

sw.addEventListener('message', ev => {
  if (ev.data?.type === 'SKIP_WAITING') void sw.skipWaiting();
});

sw.addEventListener('push', ev => {
  let payload: PushPayload = {};
  if (ev.data) {
    try { payload = ev.data.json(); }
    catch { payload = { body: ev.data.text() }; }
  }
  const title = payload.title || 'MyFood';
  const body = payload.body || '';
  const url = payload.url || '/';
  ev.waitUntil(
    sw.registration.showNotification(title, {
      body,
      tag: payload.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url },
    }),
  );
});

sw.addEventListener('notificationclick', ev => {
  ev.notification.close();
  const data = ev.notification.data as { url?: string } | null;
  const targetUrl = new URL(data?.url || '/', location.origin).href;
  ev.waitUntil((async () => {
    const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) {
      if (new URL(c.url).origin === location.origin) {
        if (c.url !== targetUrl && c.navigate) await c.navigate(targetUrl);
        if (c.focus) return c.focus();
      }
    }
    return sw.clients.openWindow(targetUrl);
  })());
});
