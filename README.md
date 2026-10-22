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
| `sw.js` | Service worker: pre-caches the app shell and CDN assets, serves navigations network-first and static assets stale-while-revalidate, and clears old cache versions on activate. Cache name is versioned (`weather-compare-v26`). |
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
`v26` to `v27`. Without the bump, returning visitors keep being served the previous shell, and
accepting the update prompt re-loads bytes that did not change. The current version is
`weather-compare-v26`.

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

The app calls OpenWeatherMap directly from the browser and needs a key.

1. Sign up at <https://openweathermap.org/>.
2. Open your account's **API keys** page and copy the default key (or create a new one).
3. New keys can take up to about 2 hours to become active. Until then requests return
   `401 Unauthorized`. That is normal, not a bug in the app.
4. **Any working key is enough.** A key with **One Call 3.0** access gets true hourly data. A
   plain free key falls back to the 3-hourly forecast automatically, and the card says so.
5. One Call is a separate subscription (marketed as "One Call by Call") which requires a payment
   method on file even while usage stays inside its free allowance. Its free allowance is
   1,000 calls/day.
6. The general rate limit is **60 calls/minute**, so repeated rapid comparisons can hit `429`.

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

For a free-tier key on your own machine this is an acceptable trade-off. Note that a One Call
subscription requires a payment method on file, which makes this warning more pointed than it
used to be: treat the browser profile as a secret, and use a dedicated key you can rotate. A
future hardening step would be proxying API calls through a backend that holds the key
server-side.

## Data sources: primary and fallback

The app has two sources and picks one per comparison. Both produce the **same normalised
record**, so the card and the chart never need to know which one answered — except where the
note on the card says so and the chart subtitle names the resolution.

### Primary — One Call 3.0

| Block | Horizon | Step | Fields used |
|---|---|---|---|
| `current` | now | — | `temp`, `feels_like`, `humidity`, `wind_speed`, `weather[]`, `sunrise`, `sunset` |
| `hourly` | 48 h | 1 h | `dt`, `temp`, `weather[].id`, `weather[].main` |
| `daily` | 8 d | 1 d | `dt`, `temp.day`, `temp.min`, `temp.max`, `weather[].id`, `weather[].main` |
| `timezone_offset` | — | — | city UTC offset in seconds |

`minutely` and `alerts` are excluded — nothing reads them, and leaving them out keeps the
payload down. One Call is keyed by **coordinate**, so the primary path geocodes the city name
first (`/geo/1.0/direct`, `limit=1`). The geocoder answers `200` with an empty array for an
unknown name; it does not return `404`.

### Fallback — the free 2.5 pair

`/data/2.5/weather` plus `/data/2.5/forecast?cnt=40` (3-hourly, five days). This is the same
data the app used exclusively before One Call, and any working key can reach it. It takes a city
name directly, so it never pays for a geocode.

### When the fallback engages

Only when **One Call** answers `401` or `403` — the signature of "this key is not entitled to
One Call", which also covers a key that has not finished activating. Deliberately narrow:

- A rejection from the **geocoder** does not fall back. If the key cannot geocode it is broken,
  and the 2.5 endpoints would reject it too, so falling back would burn two more calls to reach
  the same error.
- A **timeout, rate limit, or malformed body** does not fall back either. Those are real
  failures, and hiding them behind a second request would double the latency and mask the cause.

The downgrade is remembered for the session, keyed by the key itself, so subsequent comparisons
go straight to the fallback instead of paying for a request known to fail. It is cleared when
the key changes — a different key may well be entitled — and by the **Retry** action on the
info note, because "not entitled yet" and "not entitled" look identical to the API and the
first resolves itself within a couple of hours.

Two consequences worth knowing: the very first comparison with a fallback-only key spends one
wasted geocode and one wasted One Call request per city before the rejection is recorded, and
because both cities are fetched concurrently, both may still probe. That is four extra calls
once, not per comparison.

## How the forecast becomes a chart

Each card's back face is a trend chart drawn as an inline SVG (`buildTempChartSVG`). There is no
chart library and no canvas. The chart has two modes, toggled by the calendar button.

### Hourly view: now to now plus six hours

The window width is `HOURLY_WINDOW_HOURS` (6). Its points are the observation at "Now" followed
by each forecast sample inside the window — that is, one dot, one clock label, one value label
and one condition icon per reading.

Under One Call the samples are hourly; under the fallback they are 3-hourly, so a six-hour
window holds at most two of them and the line between them is the interpolation. The subtitle
always names which it is — "Next 6 hrs · hourly" versus "Next 6 hrs · 3-hourly" — because a
coarser chart should be attributable to the key, not look like a bug.

The line and the shaded band are extended to the six-hour mark by a **tail**: a final sample
interpolated onto the window edge. It is geometry only — no dot, no value label, no clock label,
no icon. That is deliberate. A clock label there would just repeat the hour of the reading
before it (the tail almost always falls inside that same clock hour), a condition there cannot
be interpolated (there is no such thing as half-cloudy between 4 PM and 5 PM), and a value there
would be the only number on the chart that no sample backs. Keeping the tail out of the three
label rows is what makes the dot count, the clock-label count and the icon count agree.

Clock labels include minutes when the city's UTC offset is not a whole hour. Newfoundland is
−2:30 in summer, so its hourly samples land on the half hour, and printing "8 AM" for an 8:30
reading would simply be wrong.

A sample too close to "now" is dropped from the drawn points. The threshold differs by source
because the failure differs: five minutes for hourly data, where the only problem is a dot
landing on top of the observation marker, and ninety minutes for the 3-hourly fallback, where a
bucket a few pixels from the left edge produces a near-vertical spike.

### Expected conditions

Every reading carries the condition reported for that specific hour, shown as an emoji in a row
beneath the axis. This applies to both views and both sources: the hourly row shows what is
expected hour by hour, so a front arriving at 4 PM is visible rather than averaged into a single
day icon.

The "Now" point uses the condition from the current-conditions block — a real measurement from
the same response, not an interpolated one.

Icons are thinned by pixel spacing. Four daily points always fit, but up to seven hourly points
do not on a narrow card, and overlapping glyphs smear into an unreadable clump. As with the axis
and value labels, the last icon in the row is always kept so the row does not visibly stop short
of the newest hour.

### 3-day view

One Call's `daily` block already reduces each day to one object with `temp.min` / `temp.max`.
The fallback has no such block, so its 3-hourly buckets are grouped by local calendar date and
reduced, with conditions tallied so each day carries the condition that actually prevailed.

Both are labelled by **local date**, with the first shown as "Today" only when it really is
today — under the fallback it reads "Rest of today", because that envelope covers only what is
left of the day rather than the whole of it.

This view is index-spaced, one point per day, spread evenly, because a day is not an instant.

### The shaded band

The band is drawn when the data has a real envelope. One Call's hourly block has one temperature
per hour and no `temp_min` / `temp_max`, so the hourly view under One Call draws a single
measured line. The fallback's 3-hourly buckets do carry min/max, so its hourly view keeps the
band, and so does any daily view. The chart keys off the data, not off the source.

### How the curves are drawn

The lines are monotone cubic Hermite splines with Fritsch-Carlson tangents, emitted as cubic
Beziers. A straight segment between two readings asserts a constant rate of change across that
hour, which the data does not say, and the kinks at each reading are noise rather than signal.

The tangent rule matters. Catmull-Rom and natural cubic splines overshoot near local extrema, so
a drawn peak could sit above the warmest measured reading and a trough below the coldest — the
chart would state a temperature nobody observed. Fritsch-Carlson limits each tangent to three
times its adjacent secant, which keeps the curve inside the envelope of its own data, keeps it
loop-free (x is time and must never double back), and still leaves it C1 smooth.

Dots and value labels stay pinned to the real data points. Smoothing changes the shape of the
line between measurements without moving a single reading, and the band's return edge is the same
spline run backwards, which is valid because the tangent calculation is symmetric under reversal.

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
- Every label row is anchored to the readings. Clock labels, condition icons and dots are all
  derived from the same point list and all skip the tail, so the three can never disagree about
  how many hours are being shown. Do not reintroduce a sample that is half point and half
  geometry.
- Bottom padding reserves every band that will actually be drawn, and always clears the lowest
  dot. A dot is drawn around its centre, so a series whose minimum sits on the plot floor — the
  normal case, since the scale comes from the data's own min and max — needs its radius reserved
  before the next band begins. That is why the single-line series reserves a dot clearance where
  a banded series reserves the below-lane label instead: they are alternatives, not allowances
  to be stacked.
- A missing sample must never poison the axis. Unusable readings are carried forward from the
  nearest known value so the geometry stays finite; if nothing is usable, the chart says
  "Trend data unavailable" rather than drawing a wrong line.
- The two sources normalise into one shape at the fetch boundary. Nothing downstream branches on
  the source; the only places it is visible are the note on the front face, the subtitle, and the
  resolution-dependent imminent-sample threshold. Keep it that way, or the two builders will
  drift.
- Value labels live in lanes, and both the value labels and the condition icons thin by pixel
  width rather than by index parity, always keeping the last item so the row is not visibly
  truncated.
- Date keys are zero-padded. Local date buckets sort as strings, and the unpadded form puts
  `2026-9-30` after `2026-10-25` because `9` sorts above `1` — a bug that appears once a year
  and is then impossible to reproduce.
- The chart is `role="img"` with a data-carrying label. Thinning labels and icons is a visual
  compromise, so the `aria-label` enumerates each time, rounded value, and expected condition.

## Known issues / backlog

Tracked work lives in the project backlog. This is the state of the rough edges as found.

- The top of the plot has no equivalent clearance. The highest reading's value label is drawn
  above its dot inside the top padding, which is ample today, but nothing reserves that space
  explicitly the way the bottom now does.
- The tail is drawn but not described. The accessible name stops at the last reading, so a
  screen-reader user is not told that the line continues to the six-hour mark.
- The fallback is announced but not explained in place. A user whose key is merely not yet active
  sees an info note and a Retry button; nothing tells them the usual cause is a two-hour
  activation delay unless they read this file.
- The entitlement probe costs two wasted calls the first time a fallback-only key is used, per
  city, and both cities may probe because they are fetched concurrently. Recording the rejection
  before the second request would require serialising the pair, which is worse for the common
  case.
- One Call returns current conditions and both forecast blocks in one payload, so a hard failure
  on the primary path costs the whole card. There is no partial degradation within a source —
  the fallback is all-or-nothing, not per-block.
- Icon rendering is not failure-tolerant. `lucide.createIcons()` is called unguarded on several
  paths, one of which runs during startup from `updateKeyStatus()`. The update-prompt code uses
  the guarded `if (window.lucide)` form; the other call sites do not, so a blocked or failed CDN
  takes the whole app down before first paint.
- Conditions are conveyed by emoji only, with no visible text and no legend. The accessible name
  carries the full condition list, so screen readers are covered, but a sighted user has to
  recognise the glyph. Emoji rendering also varies by platform for the same code point.
- The hourly view shows 6 of the 48 hours One Call returns. The window is a product decision, not
  a data limit; widening it is a one-constant change (`HOURLY_WINDOW_HOURS`), though the
  time-proportional axis starts thinning its clock labels well before 48.
- The app updates only when the user accepts the prompt. A new service worker waits rather than
  activating on its own, so a visitor who never accepts keeps running the version they already
  had. That is intentional, but it does mean updates are not automatic.
- There are no automated tests. The chart math is pure functions (`buildHourlyTemps`,
  `buildHourlyTempsFromBuckets`, `buildDailyTemps`, `buildDailyTempsFromBuckets`,
  `buildTempChartSVG`, `monotoneTangents`) over plain objects, so a static harness that stubs
  `fetch` with captured One Call **and** 2.5 responses could assert that both paths yield the
  same record shape, that dots, clock labels and icons each number one per reading, that the
  spline never leaves its data envelope, and that no element is drawn outside the viewBox.
  Nothing like that exists yet.
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
- API key handling is client-side and plaintext, and the key may back a subscription that has a
  payment method attached. See above.

## Service worker version history

The cache name tracks the shell. Each entry records why the name moved. Keep the pattern when
you bump it, and never reuse a name.

| Version | Change |
|---|---|
| `v26` | The plot floor clears the lowest dot. Bottom padding now reserves the dot's radius when a series has no band, where before only the below-lane value label reserved that space — and the hourly One Call view has no band, so the lowest dot printed over the clock label beneath it. |
| `v25` | The window-edge sample is geometry only — it stretches the line and the band to the six-hour mark with no dot, value label, clock label or icon, so dots, labels and icons are one-per-reading. Clock labels now include minutes for cities whose UTC offset is not a whole hour. |
| `v24` | X-axis ticks anchored to the data points instead of an independent hourly grid, so a label and its icon are the same point. |
| `v23` | One Call gained a fallback. A key One Call refuses with 401/403 drops to the free 2.5 pair — `/weather` plus 3-hourly `/forecast` — instead of failing the comparison. Both sources normalise to one record; the downgrade is announced on the card with a Retry action and remembered per key so it is not re-probed every comparison. |
| `v22` | Expected weather per hour. Hourly points now carry their condition id, so the icon row renders in both views; it thins by pixel spacing because seven hourly icons do not fit where four daily ones did. |
| `v21` | Data source moved to One Call 3.0. Hourly view is real hourly readings; the shaded band is now daily-view only, because the hourly block carries no min/max. Cities are geocoded first, since One Call is keyed by coordinate. |
| `v20` | Daily view: forecast request raised to the endpoint maximum so four local calendar dates are available at any hour in any timezone, and the first point is labelled by its real local date instead of by position. Local date keys zero-padded so they sort across a single-digit month. |
| `v19` | Trend lines drawn as monotone cubic splines with Fritsch-Carlson tangents, so peaks and troughs cannot overshoot the measured values. Dots and labels stay on the real data points. |
| `v18` | A leading forecast bucket under 90 minutes away is no longer plotted, removing the near-vertical spike at the left edge. It still feeds interpolation. |
| `v17` | Chart: the observation band collapsed back onto the current reading, so the shaded region starts from a single point at "Now". Bottom padding reserves the below-lane label height on top of the tick row, so the right-most low label clears the hour mark. |
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
