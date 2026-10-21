// v10: icon.png added to the precache (#38). The asset set grew, so the cache name moves
// with it -- a worker installing into an existing name would skip assets it thinks it
// already has.
//
// Earlier versions: v9 split network-first navigations from stale-while-revalidate assets
// (#2); v8 replaced cache.addAll() with per-asset add (#1a). v7 and older served everything
// cache-first and aborted install on any failed asset.
const CACHE_NAME = 'weather-compare-v10';
const ASSETS_TO_CACHE = [
  './',
'./index.html',
'./manifest.json',
'./icon.png',
'https://cdn.tailwindcss.com',
'https://unpkg.com/lucide@latest'
];

// Cache matching for static assets. A query string on a static asset does not change which
// asset is meant, so matching on path alone avoids a pointless cache miss.
//
// Deliberately NOT used for API requests -- see isApiRequest() below. The weather API's
// query string (city, appid, units) IS the request's meaning; ignoring it would serve one
// city's weather for another.
const MATCH_OPTIONS = { ignoreSearch: true };

// The weather API is never cached or intercepted by this worker. Runtime caching of API
// responses is new product behaviour, deferred to the P5 offline-UX decision, and is not
// part of this change. Requests that reach it fall through to the network untouched.
const API_ORIGIN = 'api.openweathermap.org';
function isApiRequest(request) {
  try {
    return new URL(request.url).hostname === API_ORIGIN;
  } catch (error) {
    return false;
  }
}

// A response is worth storing if it succeeded. Cross-origin <script> tags are requested in
// no-cors mode and come back "opaque" with status 0, so response.ok alone would skip the
// CDN entries entirely.
function isCacheable(response) {
  return !!response && (response.ok || response.type === 'opaque');
}

// Install Event: Cache assets
//
// Each asset is added individually instead of via cache.addAll(). addAll() rejects the
// whole install if any single request fails, and the Cache API treats a redirected (302)
// response as a failure. The unpkg CDN entry answers with a redirect, so addAll() made
// install fail outright and no offline cache was ever created. Per-asset add with a
// per-asset catch keeps install alive and caches everything that can be cached.
//
// No skipWaiting() here. A new worker waits in the "waiting" state so the page can offer a
// reload; activating underneath a running page swaps assets mid-session and can serve a
// half-updated app. The page activates us on demand via the SKIP_WAITING message below.
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
});

// Message Event: the page asks the waiting worker to take over.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Network-first: always try the network, fall back to cache when it fails. Used for
// navigations so a returning visitor gets the current app, not last week's shell.
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request, MATCH_OPTIONS);
    if (cached) return cached;
    // A navigation URL may not match the precached shell exactly; fall back to it.
    const shell = (await cache.match('./index.html')) || (await cache.match('./'));
    if (shell) return shell;
    throw error;
  }
}

// Stale-while-revalidate: serve the cached copy immediately, refresh it in the background.
// Used for static assets so repeat visits are fast without pinning them to old bytes.
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, MATCH_OPTIONS);
  const network = fetch(request)
    .then((response) => {
      if (isCacheable(response)) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

// Fetch Event: pick a strategy per request.
self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only GET is cacheable. Cache.put() rejects non-GET requests outright, and a non-GET
  // request is a state change that must go straight to the network.
  if (request.method !== 'GET') {
    return;
  }

  // Never intercept the weather API. Not cached, not matched, not rewritten.
  if (isApiRequest(request)) {
    return;
  }

  // Navigations are the app itself: prefer fresh bytes.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  // Everything else the app loads (shell files, CDN scripts) is static: prefer fast.
  event.respondWith(staleWhileRevalidate(request));
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
