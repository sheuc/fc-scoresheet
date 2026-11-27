// Offline support. The app shell and the two small libraries are cached when the service worker installs, so even a first
// visit keeps working offline. The heavy OCR engine + model (~13 MB, never-changing) are cached the first time a scan
// runs, then served cache-first. The app's own files are network-first (fresh when online, cached copy when offline).
const VERSION = "v2";
const CACHE = `fc-tracker-${VERSION}`;
const SHELL = ["./", "index.html", "styles.css", "manifest.webmanifest", "icon.svg", "apple-touch-icon.png",
  "fonts/inter-latin-500.woff2", "fonts/inter-latin-700.woff2", "fonts/inter-latin-800.woff2",
  "vendor/tesseract/tesseract.min.js", "vendor/exceljs/exceljs.min.js",
  ...["app", "browser-ocr", "community", "excel", "goal-log", "logo-template", "matchstats", "ocr", "pipeline", "report", "save",
      "sharecard-ui", "sharecard", "stats", "statsread", "text", "ui", "versions", "vision"].map(n => `js/${n}.js`)];

self.addEventListener("install", e => {
  self.skipWaiting();
  // allSettled: one missing file must not stop the worker from installing
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))));
});
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())));

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  const heavy = url.pathname.includes("/vendor/");
  const nav = req.mode === "navigate";
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: nav });          // ?resetcommunity and friends still find the page offline
    if (heavy && hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      if (hit) return hit;
      if (nav) { const page = await cache.match("index.html"); if (page) return page; }
      throw err;
    }
  })());
});
