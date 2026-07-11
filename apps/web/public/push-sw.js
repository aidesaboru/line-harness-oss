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
