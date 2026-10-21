# WeatherVS

A single-page weather comparison PWA. Enter two cities, hit **Compare Weather**, and get
side-by-side current conditions and a short forecast for both — so you can answer
"is it warmer there than here?" without opening two tabs.

Everything is client-side. There is no build step, no backend, and no bundler: the app is
static files served as-is.

## File inventory

| File | Purpose |
|---|---|
| `index.html` | The entire application — markup, styles (Tailwind via CDN), and all JavaScript. Single file. |
| `manifest.json` | PWA manifest: app name, `start_url`, standalone display, theme/background colors, icon entries. |
| `sw.js` | Service worker: pre-caches the app shell and CDN assets, serves navigations network-first and static assets stale-while-revalidate, and clears old cache versions on activate. Cache name is versioned (`weather-compare-v10`). |
| `icon.png` | App icon, referenced by `manifest.json`. |

No `package.json` — nothing to install.

## Run it locally

A service worker only registers in a **secure context**: `http://localhost` or `https://`.
Opening `index.html` directly via `file://` will load the UI, but **the service worker will
not register** and PWA install/offline behavior will not work. Always serve over HTTP.

Any static server works. For example:

```bash
cd WeatherVS
python3 -m http.server 8080
```

Then open <http://localhost:8080>. Equivalents: `npx serve .`, `php -S localhost:8080`,
or any static host.

> If you change `sw.js`, bump `CACHE_NAME` (e.g. `v10` → `v11`), otherwise returning visitors
> keep being served the previously cached shell. The current version is `weather-compare-v10`.

The worker does not activate itself on update. When a new version is waiting, the page is
expected to offer a reload and post `{ type: 'SKIP_WAITING' }` to the waiting worker; the
worker then calls `skipWaiting()` and the page reloads on `controllerchange`. Without that
page-side wiring, a new worker will sit in the waiting state until every tab is closed.

## Getting an OpenWeatherMap API key

The app calls the OpenWeatherMap API directly from the browser and needs a key.

1. Sign up at <https://openweathermap.org/>.
2. Open your account's **API keys** page and copy the default key (or create a new one).
3. **New keys can take up to ~2 hours to become active.** Until then requests return
   `401 Unauthorized` — this is normal, not a bug in the app.
4. The free tier allows **60 calls/minute**. Each comparison makes several calls
   (current conditions + forecast for two cities), so repeated rapid comparisons can hit it.

In the app, click the key icon in the header → paste the key → **Save Key**.

## Where the key is stored — read this

The key is stored in **`localStorage`** under the key `weather_api_key`, in **plaintext**,
**client-side**, in your browser.

That means:

- Any script running on the same origin can read it.
- Anyone with access to your browser profile / devtools can read it.
- It is sent as a query parameter (`appid=...`) on requests to `api.openweathermap.org`,
  so it also appears in network logs.
- It is never sent to any server of this project's own — there isn't one.

For a free-tier key on your own machine this is an acceptable trade-off. Do not put a paid
or otherwise privileged key here. Use a dedicated key you can rotate, and treat the browser
profile as a secret. A future hardening step would be proxying API calls through a backend
that holds the key server-side.

## Known issues / backlog

See the project backlog for tracked work (README does not enumerate it). Current known
rough edges, as found:

- No offline fallback page: a navigation that fails with nothing cached re-throws rather
  than showing a friendly offline view. The shell itself is cached, so a repeat visitor
  usually gets the app, but a first visit with no network does not.
- Third-party assets (Tailwind CDN, Lucide, weather icons) are loaded from external CDNs at
  runtime; the app is not fully self-contained offline.
- The `icon.png` artwork does not respect the maskable safe zone (content reaches the canvas
  edge), so `manifest.json` declares it `purpose: "any"` only. A padded maskable variant is
  outstanding.
- The Lucide script is requested at `@latest` in both `index.html` and `sw.js`, so the
  precached copy can drift from the one the page asks for. Pinning the version needs a
  change to both files at once.
- API key handling is client-side and plaintext (see above).

## License

MIT — see [LICENSE](LICENSE).
