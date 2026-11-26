// Offline support. Heavy, never-changing files (OCR engine + model, ~13 MB) are cache-first, so
// repeat visits start instantly and keep working offline; the app's own files are network-first
// (always fresh when online, cached copy when offline).
const VERSION = "v1";
const CACHE = `fc-tracker-${VERSION}`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())));

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  const heavy = url.pathname.includes("/vendor/");
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (heavy && hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      if (hit) return hit;
      throw err;
    }
  })());
});
