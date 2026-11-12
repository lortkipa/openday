// Service worker for OpenDay.
//
// - Offline: keeps a copy of the app shell so a phone or laptop can still open
//   the calendar without a connection. API responses are never cached.
// - Notifications: desktop notifications need a service worker to have a
//   "Snooze" button. Scheduling happens in the page (src/notifications.ts), so
//   the calendar tab must be open.

const CACHE = 'openday-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/logo.svg'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {
        /* offline during install: the next visit fills the cache */
      }),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Live data: never from a cache.
  if (url.pathname.startsWith('/api/')) return;

  // Pages: network first, cached shell when the network is down.
  if (req.mode === 'navigate') {
    e.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put('/', res.clone());
          return res;
        } catch {
          return (await caches.match('/')) || Response.error();
        }
      })(),
    );
    return;
  }

  // Static files: network first (the development server changes them often),
  // with the cached copy when the network is down.
  e.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res.ok) {
          const cache = await caches.open(CACHE);
          cache.put(req, res.clone());
        }
        return res;
      } catch {
        return (await caches.match(req)) || Response.error();
      }
    })(),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  e.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (e.action === 'snooze') {
        for (const c of list) c.postMessage({ type: 'openday-snooze', data });
        return;
      }
      // Click on the notification itself: bring the calendar to the front.
      if (list.length) await list[0].focus();
      else await self.clients.openWindow('/');
    })(),
  );
});
