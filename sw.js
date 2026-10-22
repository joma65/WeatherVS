// v25: the window-edge sample is geometry only. It used to be an ordinary point flagged
// `interpolated`, so the hourly view drew seven dots and seven value labels but only six clock
// labels -- the seventh tick had no icon to sit above, and the label it would have carried
// just repeats the hour of the reading before it. It now stretches the line and the band to
// the six-hour mark and gets no dot, value label, tick or icon, so dots, labels and icons are
// one-per-reading by construction. formatHourLabel also prints minutes when the city's UTC
// offset is not a whole hour (Newfoundland is -2:30 in summer), where "8 AM" was labelling an
// 8:30 sample. index.html changed, so the cache moves.
//
// v24: x-axis ticks are anchored to the data points instead of an independent hourly grid.
// Generating them from `t0 + n * 3600` put every label a few pixels away from the icon beneath
// it and put the right-most tick on a sample that carries no condition.
//
// v23: One Call gained a fallback. A key One Call refuses with 401/403 drops to the free 2.5
// pair -- /weather plus 3-hourly /forecast -- instead of failing the comparison. Both sources
// normalise to one record; the downgrade is announced on the card with a Retry action and
// remembered per key so it is not re-probed every comparison.
//
// v22: expected weather per hour. One Call's hourly entries carry a weather[] array, which
// buildHourlyTemps was dropping. Each hourly point now carries its condition id, so the chart's
// existing icon row renders in the hourly view as well as the daily one. The icon row is thinned
// by pixel spacing, because four daily points always fit but seven hourly ones do not on a
// narrow card.
//
// v21: data source moved from the free 3-hourly /data/2.5/forecast endpoint to One Call 3.0.
// The hourly view became real hourly readings instead of interpolation between 3-hourly
// buckets. One Call reports one temp per hour with no min/max, so the hourly view drops the
// shaded band and draws a single measured line; the band remains in the 3-day view, where the
// daily block carries a real per-day envelope. Cities are geocoded first, since One Call is
// keyed by coordinate.
//
// v20: two daily-view defects. The forecast request now asks for the endpoint's maximum of 40
// buckets (5 days) instead of 24 (72 hours): a late-evening request leaves too few hours for
// four LOCAL calendar dates, and how many fit depends on the city's UTC offset, so two cities
// side by side could show a different number of days. The first daily point is also labelled by
// its actual local date rather than by position. Local date keys are zero-padded so they still
// sort across a single-digit month.
//
// v19: the trend lines are drawn as monotone cubic splines instead of straight segments.
// Fritsch-Carlson tangents are used rather than Catmull-Rom or a natural cubic, because both
// of those overshoot at local extrema and would draw a peak warmer than any measured high.
// Dots and labels stay pinned to the real data points, so smoothing changes the shape of the
// line without moving a single reading.
//
// v18: an imminent leading forecast bucket (under 90 minutes out) is no longer plotted. It
// still feeds interpolation, so the visible line runs from "Now" to the bucket after it
// instead of spiking near-vertically at the left edge.
//
// v17: two chart corrections. The observation point is collapsed onto the current reading
// again (high == low == temp) so the band starts from a single place at "Now" -- the v16
// borrowed envelope drew a flat segment across the left edge and then kinked. The bottom
// padding now reserves the below-lane value label's full height on top of the x-axis tick
// block, instead of only its offset, so the right-most L: label clears the hour mark.
//
// v16: chart geometry fixes. The observation now carries an extrapolated band so the shaded
// region no longer pinches to zero width at the left edge and snaps open at the first bucket
// (the vertical spike), and the observation is drawn as one measured marker instead of an
// H:/L: pair. The plot's bottom padding now reserves the below-lane label band as well as the
// x-axis ticks, so the right-most L: label is no longer overprinted by the hour mark.
//
// v15: unit-toggle defects in the trend chart. Collapse detection and the minimum plot span
// were both computed from converted values, so the same data printed one label in °C and two
// in °F, and the card's plot grew ~1.8x taller in °F. Both are now expressed in source °C.
// Interpolated points also print a full H:/L: pair -- withholding them dropped the closing
// point's low entirely.
//
// v14: fixes the hourly trend rendering nothing. buildHourlyTemps() read .dt/.v off numbers
// produced by a value-only selector, so its interpolation returned undefined, the chart
// domain became NaN, and every point was mapped outside the viewBox.
//
// v13: hourly trend rebuilt around real forecast timestamps. The chart used to synthesize 7
// hourly points, match them against the 3-hourly forecast grid by exact timestamp equality,
// fail to match, and suppress the value labels -- so only "Now" ever printed a temperature.
//
// v12: lucide pinned to an exact version AND a full file path (#1b). The precached URL
// changed, so the cache name moves with it -- a worker installing into the existing name
// would treat the old lucide entry as present and skip fetching the new one.
//
// Why a deep path and not just a pinned version: unpkg answers a bare package URL with a
// redirect, and the Cache API treats a redirected response as a failed request.
//   https://unpkg.com/lucide@latest                        -> 302
//   https://unpkg.com/lucide@1.61.0                        -> 301 (still redirects)
//   https://unpkg.com/lucide@1.61.0/dist/umd/lucide.min.js -> 200 (clean)
// Pinning the version alone would leave the precache still failing, while looking fixed.
// Do not "tidy" this back to a short URL.
//
// Earlier versions: v11 added icon-192.png (#10a); v10 added icon.png (#38); v9 split
// network-first navigations from stale-while-revalidate assets (#2); v8 replaced
// cache.addAll() with per-asset add (#1a). v7 and older served everything cache-first and
// aborted install on any failed asset.
const CACHE_NAME = 'weather-compare-v25';
const ASSETS_TO_CACHE = [
  './',
'./index.html',
'./manifest.json',
'./icon.png',
'./icon-192.png',
'https://cdn.tailwindcss.com',
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
