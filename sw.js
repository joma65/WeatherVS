// v31: two temperature references drawn on the chart -- freezing (0 °C / 32 °F, saturated blue)
// and a warm-room reference (24 °C / 75 °F, orange). Both are stated in source Celsius, like the
// domain, so they sit at the same physical height in either unit. They are drawn after the grid
// and before the band and curves, so the data stays primary, and a reference outside the visible
// domain is skipped rather than clamped to the frame edge.
//
// v30: the chart's vertical scale is fixed at 0-100 °F (stated in source Celsius, so both units
// draw identical geometry) instead of being fitted to the data. A fitted domain made small
// changes look significant and, worse, gave each card its own invisible scale, so two cards
// side by side could not actually be compared. The band widens to include readings outside it
// plus a margin, and a series lying entirely outside the band is fitted instead.
//
// v29: the hourly window is anchored to the top of the current hour and the observation is
// pinned to slot 0, so positions are fixed for the whole hour: no label drift, no crowding, no
// lost hour. The imminent-bucket filters are gone, because slot spacing prevents the spike they
// existed to hide.
//
// v28: the compiled tailwind.css is precached, and index.html loads it LAST in <head>. Loading it
// before the inline <style> let the .flip-toggle reset win on equal specificity, darkening every
// flip button and stripping its padding and separator.
//
// v27: tailwind.css added to the shell; the CDN script removed (it is not production-safe and
// warns on every load). Superseded by v28, which fixed the stylesheet's position.
//
// v26: the plot floor clears the lowest dot. Bottom padding reserves the dot's radius when a
// series has no band, where before only the below-lane value label reserved that space -- and
// the hourly One Call view has no band, so the lowest dot printed over the clock label.
//
// v25: the window-edge sample is geometry only. It stretches the line and the band with no dot,
// value label, clock label or icon, so dots, labels and icons are one-per-reading. Clock labels
// also print minutes when the city's UTC offset is not a whole hour.
//
// v24: x-axis ticks anchored to the data points instead of an independent hourly grid.
//
// v23: One Call gained a fallback. A key One Call refuses with 401/403 drops to the free 2.5
// pair -- /weather plus 3-hourly /forecast -- instead of failing the comparison.
//
// v22: expected weather per hour. Hourly points carry their condition id, so the icon row
// renders in both views; it thins by pixel spacing on narrow cards.
//
// v21: data source moved to One Call 3.0. Hourly view is real hourly readings; the shaded band
// is daily-view only, because the hourly block carries no min/max. Cities are geocoded first.
//
// v20: daily view fix. The forecast request asks for the endpoint maximum so four local calendar
// dates are available in any timezone, and the first point is labelled by its real local date.
//
// v19: trend lines drawn as monotone cubic splines with Fritsch-Carlson tangents, so peaks and
// troughs cannot overshoot the measured values.
//
// v18: an imminent leading forecast bucket is no longer plotted, which removed the near-vertical
// spike at the left edge. Obsolete as of v29, where slot spacing prevents the spike structurally.
//
// v17: chart corrections. The observation band collapses onto the current reading, and the
// bottom padding reserves the below-lane label height so the right-most low label clears the
// hour mark.
//
// v16: chart geometry fixes. Superseded by v17; the borrowed envelope drew a flat left segment.
//
// v15: collapse detection and plot span computed in source Celsius, so unit toggles no longer
// change labels or plot height.
//
// v14: fixed the hourly chart rendering nothing. An interpolation helper read fields off numbers
// and returned undefined, making the chart domain NaN.
//
// v13: hourly trend rebuilt around real forecast timestamps.
//
// v12: lucide pinned to an exact version AND a full file path. The short package URL still
// answers with a redirect, and the Cache API treats a redirected response as a failed request,
// so only the deep /dist/umd/lucide.min.js path returns a clean 200.
//
// Earlier versions: v11 added icon-192.png (#10a); v10 added icon.png (#38); v9 split
// network-first navigations from stale-while-revalidate assets (#2); v8 replaced
// cache.addAll() with per-asset add (#1a). v7 and older served everything cache-first and
// aborted install on any failed asset.
const CACHE_NAME = 'weather-compare-v31';
const ASSETS_TO_CACHE = [
  './',
'./index.html',
'./tailwind.css',
'./manifest.json',
'./icon.png',
'./icon-192.png',
'https://unpkg.com/lucide@1.61.0/dist/umd/lucide.min.js'
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
//
// This matches on hostname, so it already covers every endpoint the app calls -- the One Call
// API, the geocoder, and both 2.5 fallback routes all live on api.openweathermap.org.
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
          // Delete only superseded caches belonging to this app. The prefix check
          // matters: without it this deletes EVERY cache on the origin, not just old
          // weather-compare-* ones, and activate runs on every worker update -- so any
          // other app or future runtime cache sharing this origin would be wiped
          // repeatedly, and cache deletion is not undoable by the user.
          if (key !== CACHE_NAME && key.startsWith('weather-compare-')) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});
