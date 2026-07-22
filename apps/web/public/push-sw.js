self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open('l-link-static-v1');
    await cache.addAll([
      '/offline.html',
      '/manifest.webmanifest',
      '/brand/l-link-icon.png',
      '/icons/l-link-192.png',
      '/icons/l-link-512.png',
      '/icons/l-link-maskable-192.png',
      '/icons/l-link-maskable-512.png',
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((cacheName) => cacheName.startsWith('l-link-static-') && cacheName !== 'l-link-static-v1')
        .map((cacheName) => caches.delete(cacheName)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        return (await caches.match('/offline.html')) || Response.error();
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin || !isCacheableStaticAsset(url.pathname)) return;

  event.respondWith((async () => {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) return cachedResponse;

    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open('l-link-static-v1');
      await cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  })());
});

function isCacheableStaticAsset(pathname) {
  return pathname === '/offline.html'
    || pathname === '/manifest.webmanifest'
    || pathname === '/brand/l-link-icon.png'
    || pathname.startsWith('/icons/')
    || pathname.startsWith('/_next/static/');
}

self.addEventListener('push', (event) => {
  let payload = {
    id: 'line-harness-notification',
    kind: 'notification',
    title: 'Lリンク',
    body: '新しい通知があります。',
    href: '/notification-settings',
  };

  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      payload.body = event.data.text() || payload.body;
    }
  }

  const options = {
    body: payload.body,
    tag: payload.id,
    renotify: payload.kind === 'urgent_case',
    requireInteraction: payload.kind === 'urgent_case',
    data: {
      url: payload.href || '/notification-settings',
    },
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl = event.notification.data?.url || '/notification-settings';
  const targetUrl = new URL(rawUrl, self.location.origin).href;

  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('navigate' in client && 'focus' in client) {
        await client.navigate(targetUrl);
        return client.focus();
      }
    }
    return clients.openWindow(targetUrl);
  })());
});
