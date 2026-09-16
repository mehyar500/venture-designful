/* Designful service worker — cache-first for static assets. */
const CACHE = "designful-v6";
const STATIC = [
  "index.html",
  "feature.html",
  "work.html",
  "success.html",
  "deliverable.html",
  "privacy.html",
  "terms.html",
  "styles.css",
  "app.js",
  "catalog.js",
  "samples.js",
  "compositor.js",
  "manifest.json",
  "sitemap.xml",
  "robots.txt",
  "llms.txt",
  "demo.mp4",
  "demo-poster.jpg",
  "samples/ad-4.jpg",
  "samples/ad-5.jpg",
  "samples/social-4.jpg",
  "samples/social-5.jpg",
  "samples/social-6.jpg",
  "samples/social-7.jpg",
  "samples/ba-ad-before.jpg",
  "samples/ba-ad-after.jpg",
  "samples/ba-logo-before.jpg",
  "samples/ba-logo-after.jpg"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) { return cache.addAll(STATIC); })
      .then(function () { return self.skipWaiting(); })
      .catch(function () {})
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  const url = new URL(event.request.url);
  /* Only handle same-origin GETs; never cache API or checkout traffic. */
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.indexOf("/api/") === 0) return;

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) return cached;
      return fetch(event.request).then(function (res) {
        const copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(event.request, copy); });
        return res;
      });
    })
  );
});
