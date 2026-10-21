// v8: per-asset precache (#1a). The asset set is unchanged from v7, but an install that
// previously aborted part-way may have left the v7 cache absent or partially populated, so
// a new cache name guarantees a clean install attempt on the next visit.
const CACHE_NAME = 'weather-compare-v8';
const ASSETS_TO_CACHE = [
  './',
'./index.html',
'./manifest.json',
// Removed local icons from cache list since we use external URL
'https://cdn.tailwindcss.com',
'https://unpkg.com/lucide@latest'
];

// Install Event: Cache assets
//
// Each asset is added individually instead of via cache.addAll(). addAll() rejects the
// whole install if any single request fails, and the Cache API treats a redirected (302)
// response as a failure. The unpkg CDN entry answers with a redirect, so addAll() made
// install fail outright and no offline cache was ever created. Per-asset add with a
// per-asset catch keeps install alive and caches everything that can be cached.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Caching app shell and content');
      return Promise.all(
        ASSETS_TO_CACHE.map((asset) =>
          cache.add(asset).catch((error) => {
            // One unavailable asset must not fail the install.
            console.warn('[Service Worker] Failed to cache:', asset, error);
          })
        )
      );
    })
  );
  self.skipWaiting();
});

// Fetch Event: Serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      // Return cache hit if found
      if (response) {
        return response;
      }
      // Otherwise fetch from network
      return fetch(event.request);
    })
  );
});

// Activate Event: Cleanup old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          // Delete old cache versions (v1, v2, v3, etc)
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});
