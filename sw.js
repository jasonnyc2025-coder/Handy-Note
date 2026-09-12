// 随手记 Service Worker —— 离线缓存
const CACHE = 'quicknotes-v195';
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
    // 只清理随手记自己的旧缓存。caches 是整个域名共享的，以前这里会把
    // 泰语卡片（thaicards-*）和名片夹（namecards-*）的离线缓存一并删掉，
    // 导致「后打开哪个 App，另外两个就离线打不开」
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith('quicknotes-') && k !== CACHE).map(k => caches.delete(k)))
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
      data: { url: data.url || './quick-notes.html', id: data.id || data.tag || '' },
      requireInteraction: false,
      // 通知上的两个按钮：完成 / 再过5分钟（部分平台会显示）
      actions: [
        { action: 'snooze', title: '⏰ 再过5分钟' },
        { action: 'done', title: '✅ 完成' }
      ]
    })
  );
});

// read the sync server URL that the app stashed for us (so we can snooze even
// when no page is open)
async function _readServerUrl() {
  try {
    const c = await caches.open('pushcfg');
    const r = await c.match('server-url');
    return r ? (await r.text()) : '';
  } catch (_) { return ''; }
}

// ask the server to re-fire this reminder a few minutes later
async function _snoozeOnServer(id, minutes) {
  const url = await _readServerUrl();
  const sub = await self.registration.pushManager.getSubscription();
  if (!url || !sub) return;
  try {
    await fetch(url + '/api/push/snooze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint, id: id, minutes: minutes })
    });
  } catch (_) {}
}

// 点击通知 / 点按钮
self.addEventListener('notificationclick', e => {
  const id = (e.notification.data && e.notification.data.id) || '';
  const url = (e.notification.data && e.notification.data.url) || './quick-notes.html';
  e.notification.close();
  if (e.action === 'snooze') {
    e.waitUntil(_snoozeOnServer(id, 5).then(() =>
      self.registration.showNotification('⏰ 已推迟', { body: '5 分钟后再提醒你', tag: 'snoozed-' + id, icon: 'icon-192.png', requireInteraction: false })
    ));
    return;
  }
  if (e.action === 'done') return;   // just dismiss
  // 通知主体：聚焦已开的窗口，或打开 App
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
  // 同步 / 接口请求一律直连，绝不进缓存（缓存过的 /api/sync 会让某台设备一直
  // 读到旧快照，多设备合并就永远对不上）
  try { if (new URL(e.request.url).pathname.startsWith('/api/')) return; } catch (_) {}
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => _offlineFallback(e.request))
  );
});

// 离线回退。务必保证任何分支都返回一个 Response —— 返回 undefined 会让这次
// 导航永远卡在 loading（页面白屏打不开）
async function _offlineFallback(req) {
  const cache = await caches.open(CACHE);
  // 带 ?参数 的地址（?from=、?v= 之类）也要能命中缓存，否则离线就打不开
  let hit = await cache.match(req) || await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;

  let sub = false;
  try { sub = /\/(thai|cards)\//.test(new URL(req.url).pathname); } catch (_) {}
  // 子应用（泰语卡片 / 名片夹）没缓存过就别拿随手记顶包 —— 以前离线点进去
  // 会在 thai/ 的地址上显示随手记，看着像是跳错了
  if (sub) return _notCachedPage(req.url);

  if (req.mode === 'navigate') {
    hit = await cache.match('quick-notes.html');
    if (hit) return hit;
    return _notCachedPage(req.url);
  }
  return Response.error();
}

// 离线时打开一个还没缓存过的子应用，给一句人话而不是浏览器的报错页
function _notCachedPage(url) {
  const name = /\/thai\//.test(url) ? '泰语卡片' : /\/cards\//.test(url) ? '名片夹' : '这个页面';
  return new Response(
    `<!doctype html><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${name} · 还没离线缓存</title>
     <style>
       :root{color-scheme:dark}
       body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
            background:#0f1720;color:#e7eef6;font:16px/1.7 system-ui,-apple-system,sans-serif;padding:28px}
       .box{max-width:340px;text-align:center}
       h1{font-size:19px;margin:0 0 12px}
       p{color:#9fb0c0;margin:0 0 20px}
       a{display:inline-block;padding:12px 22px;border-radius:12px;background:#2dd4bf;color:#06231f;
         font-weight:700;text-decoration:none}
     </style>
     <div class="box">
       <h1>✈️ ${name}还没离线缓存</h1>
       <p>这台手机还没在联网状态下打开过${name}，所以现在离线打不开它。<br><br>
          联网时打开一次，之后飞行模式也能用。</p>
       <a href="../quick-notes.html">← 返回随手记</a>
     </div>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
