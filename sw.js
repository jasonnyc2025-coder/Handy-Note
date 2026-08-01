// 随手记 Service Worker —— 离线缓存
const CACHE = 'quicknotes-v178';
const ASSETS = [
  'index.html',
  'quick-notes.html',
  'manifest.json',
  'icon-192.png',
  'icon-512.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' })
        .then(clients => clients.forEach(c => c.postMessage({ type: 'SW_UPDATED' }))))
  );
});

// 后台推送提醒：服务器在到点时发来推送，即使 App 已关闭也能弹通知
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { body: e.data && e.data.text() }; }
  const title = data.title || '⏰ 提醒';
  const body = data.body || '你有一条提醒';
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: data.tag || ('remind-' + Date.now()),
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      data: { url: data.url || './quick-notes.html' },
      requireInteraction: false
    })
  );
});

// 点击通知：聚焦已开的窗口，或打开 App
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './quick-notes.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cls => {
      for (const c of cls) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

// 网络优先，失败回退缓存；同时把成功的响应写入缓存
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('quick-notes.html')))
  );
});
