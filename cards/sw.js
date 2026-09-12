// 名片夹 service worker — caches the app shell so it works fully offline.
const CACHE = "namecards-v22";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    // 只清理名片夹自己的旧缓存 —— caches 是整个域名共享的，删别人的会让
    // 随手记 / 泰语卡片 离线打不开
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith("namecards-") && k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // never cache the photo/API endpoints — always hit the network
  if (url.pathname.startsWith("/api/")) return;

  // network-first for the HTML so updates land; cache-first for the rest.
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put("./index.html", copy)).catch(() => {});
        return res;
      }).catch(() => caches.match("./index.html"))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(hit => {
      if (hit) return hit;
      return fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      });
    })
  );
});
