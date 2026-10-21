# WeatherVS

A single-page weather comparison PWA. Enter two cities, hit **Compare Weather**, and get
side-by-side current conditions and a short forecast for both — so you can answer
"is it warmer there than here?" without opening two tabs.

Everything is client-side. There is no build step, no backend, and no bundler: the app is
static files served as-is.

## File inventory

| File | Purpose |
|---|---|
| `index.html` | The entire application — markup, styles (Tailwind via CDN), all JavaScript, and the inline SVG trend chart. Single file. |
| `manifest.json` | PWA manifest: app name, `start_url`, standalone display, theme/background colors, icon entries. |
| `sw.js` | Service worker: pre-caches the app shell and CDN assets, serves navigations network-first and static assets stale-while-revalidate, and clears old cache versions on activate. Cache name is versioned (`weather-compare-v17`). |
| `icon.png` | 512x512 app icon, referenced by `manifest.json`. |
| `icon-192.png` | 192x192 app icon — a downscale of `icon.png`. Chromium's install criteria want both a 192px and a 512px icon. |

No `package.json` — nothing to install.

## Run it locally

A service worker only registers in a **secure context**: `http://localhost` or `https://`.
Opening `index.html` directly via `file://` will load the UI, but the service worker will
not register and PWA install/offline behavior will not work. Always serve over HTTP.

Any static server works. For example:

```bash
cd WeatherVS
python3 -m http.server 8080
```

Then open <http://localhost:8080>. Equivalents: `npx serve .`, `php -S localhost:8080`,
or any static host.

### Bumping the cache

If you change `sw.js` or any asset listed in `ASSETS_TO_CACHE` — in practice that means
`index.html`, since the chart and all app logic live there — bump `CACHE_NAME`, for example
`v17` to `v18`. Without the bump, returning visitors keep being served the previous shell, and
accepting the update prompt re-loads bytes that did not change. The current version is
`weather-compare-v17`.

## Updating the app — the worker and the page are a pair

The worker does not activate itself on update. When a new version is waiting, the page asks it
to take over. Both halves are implemented: the worker in `sw.js`, and the client in
`index.html` (the `#updateContainer` prompt).

The behaviour: a new worker installs and parks in the waiting state. The page notices, shows a
dismissible prompt offering the update, and does nothing else until the user acts. On Update,
the page posts `SKIP_WAITING`, the new worker activates, and the page reloads once. On Dismiss,
the old version keeps running and the prompt returns on the next load.

This is deliberate: activating a new worker underneath a running session can serve a
half-updated app, so the swap waits for a human. It also means "I reloaded and still see the
old code" is expected until the prompt is accepted. That is the design, not a bug.

The contract, for anyone reimplementing or auditing it:

```js
reg.addEventListener('updatefound', () => {
  const installing = reg.installing;
  installing.addEventListener('statechange', () => {
    // Only a *waiting* worker with an existing controller is a real update.
    if (installing.state === 'installed' && navigator.serviceWorker.controller) {
      showReloadPrompt();          // dismissible; must NOT auto-reload
    }
  });
});

// on user accept:
reg.waiting.postMessage({ type: 'SKIP_WAITING' });

// reload exactly once, or this loops:
let reloading = false;
navigator.serviceWorker.addEventListener('controllerchange', () => {
  if (reloading) return;
  reloading = true;
  location.reload();
});
```

On a first install there is no controller, so nothing should be shown: there is no previous
version to update from. The prompt must be dismissible and must never reload on its own; an
auto-reload mid-entry would discard a half-typed city.

## Getting an OpenWeatherMap API key

The app calls the OpenWeatherMap API directly from the browser and needs a key.

1. Sign up at <https://openweathermap.org/>.
2. Open your account's **API keys** page and copy the default key (or create a new one).
3. New keys can take up to about 2 hours to become active. Until then requests return
   `401 Unauthorized`. That is normal, not a bug in the app.
4. The free tier allows **60 calls/minute**. Each comparison makes several calls
   (current conditions + forecast for two cities), so repeated rapid comparisons can hit it.

In the app, click the key icon in the header, paste the key, then **Save Key**.

## Where the key is stored — read this

The key is stored in `localStorage` under the key `weather_api_key`, in plaintext,
client-side, in your browser.

That means:

- Any script running on the same origin can read it.
- Anyone with access to your browser profile or devtools can read it.
- It is sent as a query parameter (`appid=...`) on requests to `api.openweathermap.org`, so it
  also appears in network logs.
- It is never sent to any server of this project's own, because there isn't one.

For a free-tier key on your own machine this is an acceptable trade-off. Do not put a paid or
otherwise privileged key here. Use a dedicated key on a browser profile you treat as a secret.
A future hardening step would be proxying API calls through a backend that holds the key
server-side.

## How the forecast becomes a chart

Each card's back face is a trend chart drawn as an inline SVG (`buildTempChartSVG`). There is no
chart library and no canvas. The data comes from OpenWeatherMap's 3-hourly forecast endpoint
(`/data/2.5/forecast?cnt=24`), and the chart has two modes, toggled by the calendar button on
the back face.

### Hourly view: now to now plus six hours

The window width is `HOURLY_WINDOW_HOURS` (6). Its points are:

1. The observation at "Now", taken from the current-conditions endpoint. This is a single
   measured temperature, not a window, so its high and low are collapsed onto that value. The
   shaded band therefore starts on the reading itself and fans out to the first forecast bucket.
   It is drawn as one white dot with one value, never an H/L pair.
2. Every real forecast bucket inside the window, carrying that bucket's own `temp_max` and
   `temp_min` as its band edges.
3. One closing sample on the window edge, linearly interpolated from the two buckets that
   bracket it. It is flagged `interpolated` and drawn with a hollow dot, but it prints a normal
   H/L pair. Interpolated numbers are shown and marked, not withheld.

Because the source is 3-hourly, a 6-hour window holds at most two real buckets. Those straight
segments between real measurements are the interpolation; no synthetic hourly points are
created. The view is time-proportional, with a real clock axis labelled Now, 5 PM, and so on,
so a bucket that lands 90 minutes out sits where it actually is.

### 3-day view

The forecast list is bucketed by local calendar date and reduced to four points: today (labelled
"Rest of today") plus the next three days, each with its day high, day low, and prevailing
condition icon. This view is index-spaced, one point per day, spread evenly, because a day is not
an instant and evening-to-midnight buckets would otherwise bunch up at one end.

### Rules the chart code depends on

These are load-bearing. Simplify them and the picture silently goes wrong.

- Unit changes must not change the picture. Both the plot scale and the label decisions are made
  in source Celsius. The minimum vertical span is stated as 5 °C in metric and 9 °F in imperial,
  which is the same span, so toggling units redraws an identical curve at an identical height.
  A 0.5 degree tolerance applied to converted values previously made the same band print one
  label in Celsius and two in Fahrenheit.
- Collapse is decided in source units. A point counts as degenerate, and prints one value with
  no low label, only when its high and low are genuinely equal, not when they merely round
  together on screen.
- A missing sample must never poison the axis. Unusable readings are carried forward from the
  nearest known value so the geometry stays finite; if nothing is usable, the chart says
  "Trend data unavailable" rather than drawing a wrong line.
- Value labels live in two lanes. Every label above the curve shares one lane and every label
  below shares another, thinned by available pixel width. The bottom padding reserves the
  x-axis tick row and the below-lane label height, so a low label on a flat series is not
  overprinted by the hour mark.
- The chart is `role="img"` with a data-carrying label. Label thinning is a visual compromise,
  so the `aria-label` enumerates each time and rounded value, and notes that hollow marks are
  interpolated.

## Known issues / backlog

Tracked work lives in the project backlog. This is the state of the rough edges as found.

- The daily view can promise a fourth day it does not have. The forecast request uses `cnt=24`,
  which is 72 hours, while four day-buckets can span up to 96. The trailing day may therefore
  hold only a partial morning, understating its high and low. Raising `cnt` to 32 or 40 is the
  fix; it has not been done.
- The first daily label is chosen by position, not by date. `buildDailyTemps` labels the first
  surviving bucket "Rest of today" on the assumption that it is today. Late in the evening the
  first bucket with samples can already be tomorrow, and tomorrow gets labelled as today. It
  should compare against today's local date key instead of testing the index.
- Icon rendering is not failure-tolerant. `lucide.createIcons()` is called unguarded on several
  paths, one of which runs during startup from `updateKeyStatus()`. The update-prompt code uses
  the guarded `if (window.lucide)` form; the other call sites do not, so a blocked or failed CDN
  takes the whole app down before first paint.
- The app updates only when the user accepts the prompt. A new service worker waits rather than
  activating on its own, so a visitor who never accepts keeps running the version they already
  had. That is intentional, but it does mean updates are not automatic.
- There are no automated tests. The chart math is pure functions (`buildHourlyTemps`,
  `buildDailyTemps`, `buildTempChartSVG`) over plain objects, so a static harness that stubs
  `fetch` with a captured API response could assert point counts, which points are interpolated,
  and that labels exist for every point without needing a live key. Nothing like that exists yet.
- Installability is unverified in a real browser. `manifest.json` declares both a 192px and a
  512px icon, which is what Chromium asks for, but nobody has confirmed in Chrome that the
  install affordance appears and that DevTools shows the app as installable. Treat install
  support as unproven until someone does.
- There is no offline fallback page. A navigation that fails with nothing cached re-throws rather
  than showing a friendly offline view. The shell itself is cached, so a repeat visitor usually
  gets the app, but a first visit with no network does not.
- Third-party assets are still third-party. Tailwind (CDN), Lucide, and the weather icons are
  fetched at runtime, so the app is not fully self-contained offline.
- The `icon.png` artwork does not respect the maskable safe zone. Content reaches the canvas
  edge, and roughly 24% of its structured detail falls outside the central 80% circle, so
  `manifest.json` declares both icons `purpose: "any"` only. A padded maskable variant is
  outstanding; `icon-192.png` inherits the same limitation.
- API key handling is client-side and plaintext, as described above.

## Service worker version history

The cache name tracks the shell. Each entry records why the name moved. Keep the pattern when
you bump it, and never reuse a name.

| Version | Change |
|---|---|
| `v17` | Chart: the observation band collapsed back onto the current reading, so the shaded region starts from a single point at "Now". Bottom padding now reserves the below-lane label height on top of the tick row, so the right-most low label clears the hour mark. |
| `v16` | Chart: attempt at an extrapolated band at the observation plus a reserved below-lane offset. Superseded by v17; the borrowed envelope drew a flat left segment that kinked at the first bucket. |
| `v15` | Chart: collapse detection and minimum plot span computed in source Celsius, so unit toggles no longer change labels or plot height. Interpolated points print a full H/L pair. |
| `v14` | Fixed the hourly chart rendering nothing. An interpolation helper read fields off numbers and returned undefined, making the chart domain NaN and mapping every point outside the viewBox. |
| `v13` | Hourly trend rebuilt around real forecast timestamps: time-proportional axis, real buckets, one interpolated closing sample, instead of seven synthetic hourly points whose labels were suppressed. |
| `v12` | Lucide pinned to an exact version and a full file path. The short package URL still answers with a redirect, and the Cache API treats a redirected response as a failed request, so only the deep `/dist/umd/lucide.min.js` path returns a clean 200. |
| `v11` | Added `icon-192.png`. |
| `v10` | Added `icon.png`. |
| `v9` | Split network-first navigations from stale-while-revalidate assets. |
| `v8` | Replaced `cache.addAll()` with per-asset `cache.add()` plus a per-asset catch, so one unavailable asset cannot abort the install. |
| `v7` and older | Served everything cache-first and aborted install on any failed asset. |

## License

MIT. See [LICENSE](LICENSE).
