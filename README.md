# WeatherVS

A single-page weather comparison PWA. Enter two cities, hit **Compare Weather**, and get
side-by-side current conditions and a short forecast for both — so you can answer
"is it warmer there than here?" without opening two tabs.

Everything is client-side. There is no backend and no bundler: the app is static files served
as-is. The one build step is optional and offline — the Tailwind stylesheet is compiled ahead of
time, not at runtime.

## File inventory

| File | Purpose |
|---|---|
| `index.html` | The entire application — markup, inline styles, all JavaScript, and the inline SVG trend chart. |
| `tailwind.css` | Compiled Tailwind output. Generated; do not edit by hand. |
| `input.css` | Tailwind entry file (`@tailwind base; @tailwind components; @tailwind utilities;`). Only needed to rebuild `tailwind.css`. |
| `tailwind.config.js` | Build config: scans `index.html` for class names. Only needed to rebuild. |
| `manifest.json` | PWA manifest: app name, `start_url`, standalone display, theme/background colors, icon entries. |
| `sw.js` | Service worker: pre-caches the app shell and CDN assets, serves navigations network-first and static assets stale-while-revalidate, and clears old cache versions on activate. Cache name is versioned (`weather-compare-v31`). |
| `icon.png` | 512x512 app icon, referenced by `manifest.json`. |
| `icon-192.png` | 192x192 app icon — a downscale of `icon.png`. Chromium's install criteria want both a 192px and a 512px icon. |

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

### Rebuilding the stylesheet

Tailwind is compiled ahead of time and the result is committed, because the Play CDN that used
to run in the browser is not production-safe: it builds CSS on every page load and warns about
it in the console.

```bash
npm i -D tailwindcss@3
npx tailwindcss -c tailwind.config.js -i ./input.css -o ./tailwind.css --minify
```

`tailwind.config.js` scans only `index.html`. Every utility the page uses has to appear literally
in that file — the arbitrary values included (`drop-shadow-[0_0.2px_1.4px_rgba(0,0,0,1)]`,
`text-[10px]`, `max-w-[80px]`, the `bg-gradient-to-br` pairs). Nothing is assembled at runtime, so
nothing is missed, but do not generate class names by string concatenation when editing.

### Stylesheet order matters

`<link rel="stylesheet" href="tailwind.css">` must stay **after** the inline `<style>` block in
`<head>`. The inline block resets `.flip-toggle` (`color`, `font`, `padding`, `border`) and the
buttons also carry utilities that set those same properties (`text-blue-100`, `pt-3`, `border-t`).
Equal specificity means source order decides, so the stylesheet has to come last for the
utilities to win. Reversing them darkens the flip buttons and strips their padding and separator,
silently.

### Bumping the cache

If you change `sw.js` or any asset listed in `ASSETS_TO_CACHE` — in practice that means
`index.html` or `tailwind.css` — bump `CACHE_NAME`, for example `v31` to `v32`. Without the bump,
returning visitors keep being served the previous shell, and accepting the update prompt re-loads
bytes that did not change. The current version is `weather-compare-v31`.

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

### The vertical scale is fixed

The domain is **0–100 °F**, stated internally in Celsius (`-160/9` to `340/9`) so both units draw
identical geometry. It is not fitted to the data.

That is the point. A fitted domain made every slope interpretive — four degrees of overnight drift
filled the plot as dramatically as a thirty-degree front — and, worse for an app built on
comparison, each card carried its own invisible domain, so the two curves were not measured
against the same thing.

The band is a **default, not a cage**:

- Readings outside it widen the domain to include them, plus a 5 % margin, so an extreme day is
  drawn against a larger range rather than clipped off the frame.
- A series lying **entirely** outside the band is fitted to its own range instead. Holding the
  band there would squash the whole line into a sliver against one edge, at which point the band
  is no longer informative.

Because the domain is fixed, the five grid lines now sit at fixed temperatures rather than at
whatever the data happened to span, so a given height means the same thing on both cards and in
both modes.

### Temperature references

Two dashed horizontal references are drawn across the plot:

| Reference | `valueC` | Metric | Imperial | Colour |
|---|---|---|---|---|
| Freezing | `0` | 0 °C | 32 °F | `#38bdf8` (saturated blue) |
| Room temperature | `24` | 24 °C | ≈75 °F | `#fb923c` (orange) |

Both are declared in **source Celsius**, next to the domain constants, so they land at the same
physical height in either unit — `displayTemp` converts them exactly like data. 24 °C is 75.2 °F,
which is the "75 °F" reference as it rounds on screen; stating it in Celsius keeps one source of
truth rather than two values that disagree by a fifth of a degree.

They are drawn **after the grid and before the band and curves**. The fill is only 25 % opaque, so
a dashed reference beneath it still reads, while the data stays the most prominent thing on the
card. A reference outside the visible domain is **skipped, not clamped** — a line pinned to the
frame edge would read as an axis rather than as a temperature.

Colours are picked to be distinguishable from the series themselves: the low curve is pale sky
(`#7dd3fc`) and the high curve is amber (`#fcd34d`), so freezing uses a more saturated blue and
the room reference uses orange rather than yellow.

### Hourly view: the current hour plus the next six

The window is `HOURLY_WINDOW_HOURS` (6) hours wide and is **anchored to the top of the current
hour**, not to the exact instant of the request. That anchoring is what makes the chart stable:

- Slot 0 is "Now", slot 6 is the sixth hour ahead. Every slot is a fixed fraction of the width,
  so nothing moves between refreshes and the clock labels never crowd.
- Buckets occupy their own slots. Because positions no longer depend on elapsed minutes, a
  bucket that is five minutes away is drawn one slot out rather than five pixels out.
- The window advances one hour at a time. At the top of the hour the leftmost forecast bucket
  drops off and a new one appears on the right — the only movement the chart ever makes.
- Each point is one dot, one clock label, one value label and one condition icon, so the three
  rows beneath the plot always count the same. The window-edge `tail`, where one is still
  needed, is geometry only and appears in none of them.

The observation is plotted at slot 0 with its measured temperature, even though it was taken
part-way through the hour. Pinning it there is deliberate: anchored to its true offset, it sat a
few pixels left of the first bucket late in the hour and the line between them went
near-vertical. That is why every segment now spans at least one slot, and why the older
"imminent bucket" filters could be deleted rather than tuned — no forecast hour is dropped for
being too close.

Both sources sample once per hour, so the axis has seven evenly spaced slots either way. One
Call supplies those hourly readings directly; the 3-hourly fallback interpolates its buckets onto
the same slots, because plotting only the real buckets put two points at 2/6 and 5/6 of the width
and left the rest of the axis empty. A slot that coincides with a bucket keeps that bucket's own
values and condition; interpolated slots carry no condition, since a weather condition does not
average.

Clock labels include minutes when the city's UTC offset is not a whole hour. Newfoundland is
−2:30 in summer, so its hourly samples land on the half hour, and printing "8 AM" for an 8:30
reading would simply be wrong.

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

- The vertical domain is fixed at 0–100 °F, expressed in source Celsius so both units draw
  identical geometry. It widens only to include readings outside the band, plus a margin; a
  series lying entirely outside the band is fitted instead, because the fixed band would crush
  it. Do not go back to fitting the domain to the data — that is what made small changes look
  significant and made two side-by-side cards incomparable.
- Temperature references are declared in source Celsius alongside the domain constants, never in
  Fahrenheit. They are annotations, not data: they must not influence the domain, and a reference
  outside it is skipped rather than clamped to the frame.
- The window is anchored to a clock boundary, never to `now`. Anchoring to `now` made every
  position a function of elapsed minutes: labels crowded as the hour advanced and the right-hand
  gap widened until the next hour reset everything. If the window ever needs to slide again, it
  must slide in whole hours.
- Every reading owns exactly one slot, and the observation owns slot 0. Dots, clock labels,
  condition icons and value labels are all derived from the same point list; a point marked
  `tail` is skipped by all four. Do not reintroduce a sample that is half point and half
  geometry.
- Collapse is decided in source units. A point counts as degenerate, and prints one value with
  no low label, only when its high and low are genuinely equal, not when they merely round
  together on screen.
- Bottom padding reserves every band that will actually be drawn, and always clears the lowest
  dot. A dot is drawn around its centre, so a series that reaches the bottom of the scale needs
  its radius reserved before the next band begins. That is why a single-line series reserves a
  dot clearance where a banded series reserves the below-lane label instead: they are
  alternatives, not allowances to be stacked.
- A missing sample must never poison the axis. Unusable readings are carried forward from the
  nearest known value so the geometry stays finite; if nothing is usable, the chart says
  "Trend data unavailable" rather than drawing a wrong line.
- The two sources normalise into one shape at the fetch boundary. Nothing downstream branches on
  the source; the only places it is visible are the note on the front face, the subtitle, and
  the window anchoring shared by both builders.
- Value labels live in lanes, and both the value labels and the condition icons thin by pixel
  width rather than by index parity, always keeping the last item so the row is not visibly
  truncated.
- Date keys are zero-padded. Local date buckets sort as strings, and the unpadded form puts
  `2026-9-30` after `2026-10-25` because `9` sorts above `1` — a bug that appears once a year
  and is then impossible to reproduce.
- The chart is `role="img"` with a data-carrying label. Thinning labels and icons is a visual
  compromise, so the `aria-label` enumerates each time, rounded value, and expected condition.
- The compiled stylesheet is linked after the inline `<style>` block. See above.

## Known issues / backlog

Tracked work lives in the project backlog. This is the state of the rough edges as found.

- **The temperature references are unlabelled.** Colour and position carry the meaning: blue
  below is freezing, orange above is comfortable. A sighted user has to know that, and a
  screen-reader user is not told the references exist at all — the `aria-label` lists readings
  only. Adding a small edge label per line would fix both, at the cost of collision risk with
  the value labels that already live near the curve.
- **A fixed band flattens mild weather, deliberately.** A day that moves between 48 °F and 55 °F
  now draws a short, low line, because 7 degrees of 100 is 7 % of the plot. That is the trade the
  fixed scale makes: a small change stays small. If a particular city needs a tighter view, the
  domain constants are the place to change it, but changing them breaks comparability with the
  other card.
- The observation is drawn at slot 0 even when it was measured part-way through the hour, so the
  first interval represents somewhere between zero and sixty minutes of real time. This is the
  price of a stable axis; the alternative crowds the label row.
- The chart is drawn from data fetched at comparison time and never redraws itself, so a tab left
  open for an hour keeps showing the hour it was loaded in. The window advances only on the next
  comparison or unit toggle.
- The top of the plot has no equivalent clearance to the bottom. The highest reading's value
  label is drawn above its dot inside the top padding, which is ample today, but nothing reserves
  that space explicitly.
- The tail is drawn but not described. The accessible name stops at the last reading, so a
  screen-reader user is not told that the line continues to the horizon.
- The fallback is announced but not explained in place. A user whose key is merely not yet active
  sees an info note and a Retry button; nothing tells them the usual cause is a two-hour
  activation delay unless they read this file.
- The entitlement probe costs two wasted calls the first time a fallback-only key is used, per
  city, and both cities may probe because they are fetched concurrently.
- One Call returns current conditions and both forecast blocks in one payload, so a hard failure
  on the primary path costs the whole card. There is no partial degradation within a source.
- Icon rendering is not failure-tolerant. `lucide.createIcons()` is called unguarded on several
  paths, one of which runs during startup from `updateKeyStatus()`. The update-prompt code uses
  the guarded `if (window.lucide)` form; the other call sites do not, so a blocked or failed CDN
  takes the whole app down before first paint.
- Conditions are conveyed by emoji only, with no visible text and no legend. The accessible name
  carries the full condition list, so screen readers are covered, but a sighted user has to
  recognise the glyph. Emoji rendering also varies by platform for the same code point.
- The hourly view shows 6 of the 48 hours One Call returns. The window is a product decision, not
  a data limit; widening it is a one-constant change (`HOURLY_WINDOW_HOURS`).
- The app updates only when the user accepts the prompt. A new service worker waits rather than
  activating on its own, so a visitor who never accepts keeps running the version they already
  had. That is intentional, but it does mean updates are not automatic.
- There are no automated tests. The chart math is pure functions (`buildHourlyTemps`,
  `buildHourlyTempsFromBuckets`, `buildDailyTemps`, `buildDailyTempsFromBuckets`,
  `buildTempChartSVG`, `monotoneTangents`) over plain objects, so a static harness that stubs
  `fetch` with captured One Call **and** 2.5 responses could assert that both paths yield the
  same record shape, that dots, clock labels and icons each number one per reading, that slot
  positions are fixed for a given hour, that the domain is the fixed band unless data escapes it,
  that a reference outside the domain is omitted rather than clamped, that the spline never
  leaves its data envelope, and that no element is drawn outside the viewBox. Nothing like that
  exists yet.
- Installability is unverified in a real browser. `manifest.json` declares both a 192px and a
  512px icon, but nobody has confirmed in Chrome that the install affordance appears and that
  DevTools shows the app as installable.
- There is no offline fallback page. A navigation that fails with nothing cached re-throws rather
  than showing a friendly offline view.
- Third-party assets are still third-party. Lucide and the weather icons are fetched at runtime,
  so the app is not fully self-contained offline.
- The `icon.png` artwork does not respect the maskable safe zone. Roughly 24% of its structured
  detail falls outside the central 80% circle, so `manifest.json` declares both icons
  `purpose: "any"` only.
- API key handling is client-side and plaintext, and the key may back a subscription that has a
  payment method attached. See above.

## Service worker version history

The cache name tracks the shell. Each entry records why the name moved. Keep the pattern when
you bump it, and never reuse a name.

| Version | Change |
|---|---|
| `v34` | The 3-hourly fallback reads only the three buckets that bracket the window, and folds the observation in as the first interpolation sample — so the hours before the first bucket ramp out of the measured reading instead of stepping flat to it. The third bucket is an interpolation endpoint only and is never plotted. |
| `v33` | The 3-hourly fallback samples its curve once per hour instead of plotting only the real buckets, so both sources produce the same seven evenly spaced axis slots. |
| `v32` | Spacing beneath the current-conditions stats grid, so the fallback note no longer sits flush against it. |
| `v31` | Two temperature references on the chart: freezing (0 °C / 32 °F, saturated blue) and room temperature (24 °C / ≈75 °F, orange). Declared in source Celsius like the domain, so they sit at the same height in either unit; drawn under the band, skipped rather than clamped when off-scale. |
| `v30` | The vertical scale is fixed at 0–100 °F (stated in source Celsius so both units draw identical geometry) instead of fitted to the data. It widens to include readings outside the band plus a margin, and fits a series lying entirely outside it. A fitted domain made small changes look significant and gave each card its own invisible scale, so side-by-side slopes were not comparable. |
| `v29` | The hourly window is anchored to the top of the current hour and the observation is pinned to slot 0, so positions are fixed for the whole hour: no label drift, no crowding, no lost hour. The imminent-bucket filters are gone, because slot spacing prevents the spike they existed to hide. |
| `v28` | The compiled `tailwind.css` is precached and linked **after** the inline `<style>` block. Loading it earlier let the `.flip-toggle` reset win on equal specificity, darkening the flip buttons and stripping their padding and separator. |
| `v27` | `tailwind.css` added to the shell; the Play CDN script removed. It is not production-safe and warns on every load. Superseded by v28, which fixed the stylesheet's position. |
| `v26` | The plot floor clears the lowest dot. Bottom padding reserves the dot's radius when a series has no band, where before only the below-lane value label did — and the hourly One Call view has no band, so the lowest dot printed over the clock label. |
| `v25` | The window-edge sample is geometry only: no dot, value label, clock label or icon, so dots, labels and icons are one-per-reading. Clock labels print minutes for zones whose UTC offset is not a whole hour. |
| `v24` | X-axis ticks anchored to the data points instead of an independent hourly grid, so a label and its icon are the same point. |
| `v23` | One Call gained a fallback. A key One Call refuses with 401/403 drops to the free 2.5 pair — `/weather` plus 3-hourly `/forecast` — instead of failing the comparison. Both sources normalise to one record; the downgrade is announced on the card with a Retry action and remembered per key. |
| `v22` | Expected weather per hour. Hourly points now carry their condition id, so the icon row renders in both views; it thins by pixel spacing because seven hourly icons do not fit where four daily ones did. |
| `v21` | Data source moved to One Call 3.0. Hourly view is real hourly readings; the shaded band is now daily-view only, because the hourly block carries no min/max. Cities are geocoded first, since One Call is keyed by coordinate. |
| `v20` | Daily view: forecast request raised to the endpoint maximum so four local calendar dates are available in any timezone, and the first point is labelled by its real local date instead of by position. Local date keys zero-padded so they sort across a single-digit month. |
| `v19` | Trend lines drawn as monotone cubic splines with Fritsch-Carlson tangents, so peaks and troughs cannot overshoot the measured values. Dots and labels stay on the real data points. |
| `v18` | A leading forecast bucket under 90 minutes away is no longer plotted, removing the near-vertical spike at the left edge. Obsolete as of v29. |
| `v17` | Chart: the observation band collapsed back onto the current reading, so the shaded region starts from a single point at "Now". Bottom padding reserves the below-lane label height on top of the tick row. |
| `v16` | Chart: attempt at an extrapolated band at the observation plus a reserved below-lane offset. Superseded by v17; the borrowed envelope drew a flat left segment that kinked at the first bucket. |
| `v15` | Chart: collapse detection and plot span computed in source Celsius, so unit toggles no longer change labels or plot height. |
| `v14` | Fixed the hourly chart rendering nothing. An interpolation helper read fields off numbers and returned undefined, making the chart domain NaN. |
| `v13` | Hourly trend rebuilt around real forecast timestamps: time-proportional axis, real buckets, one interpolated closing sample, instead of seven synthetic hourly points whose labels were suppressed. |
| `v12` | Lucide pinned to an exact version and a full file path. The short package URL still answers with a redirect, and the Cache API treats a redirected response as a failed request, so only the deep `/dist/umd/lucide.min.js` path returns a clean 200. |
| `v11` | Added `icon-192.png`. |
| `v10` | Added `icon.png`. |
| `v9` | Split network-first navigations from stale-while-revalidate assets. |
| `v8` | Replaced `cache.addAll()` with per-asset `cache.add()` plus a per-asset catch, so one unavailable asset cannot abort the install. |
| `v7` and older | Served everything cache-first and aborted install on any failed asset. |

## License

MIT. See [LICENSE](LICENSE).