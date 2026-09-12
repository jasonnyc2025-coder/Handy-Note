// 泰语卡片 service worker — caches the app shell so it works fully offline.
const CACHE = "thaicards-v70";
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
    // 只清理泰语卡片自己的旧缓存 —— caches 是整个域名共享的，删别人的会让
    // 随手记 / 名片夹 离线打不开
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith("thaicards-") && k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // never cache the sync/API endpoints — a cached /api/sync would hand the app
  // a stale snapshot forever and silently break multi-device merging.
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
