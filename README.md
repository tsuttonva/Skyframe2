# SkyFrame

A live aircraft-tracking radar display centered on your location. Built as
an installable Progressive Web App (PWA) that runs on iOS, macOS, Windows,
and Android from a single static site, with an optional Cloudflare Worker
backend for military-aircraft tagging and flight-route lookups.

This repo also hosts **HoofCast**, a horse-riding-conditions PWA — see
[below](#hoofcast).

## Repo layout

- `web/` — SkyFrame's frontend: `index.html` (the app), `manifest.webmanifest`
  and `sw.js` (PWA install/offline support), `fips.json` (county lookup
  data), `icons/`.
- `worker/` — the Cloudflare Worker backend (`src/index.js`) that proxies
  flight data, tags military aircraft, and looks up flight routes behind a
  hard monthly cost cap.
- `hoofcast/` — HoofCast's frontend, a self-contained static PWA (no
  backend/Worker needed — see below).
- `scripts/check-syntax.js` — a pre-ship gate that verifies an app's
  `index.html` contains no ES2020+ syntax, to keep it working on old iOS
  Safari (12.5.x). Run against both apps in CI (`.github/workflows/ci.yml`).
- `docs/DEPLOYMENT.md` — full step-by-step setup and deployment instructions,
  written for someone with no prior deployment experience.

## CI/CD

- `.github/workflows/ci.yml` — runs the `check-syntax.js` compatibility gate
  against both `web/index.html` and `hoofcast/index.html` on every push/PR.
- `.github/workflows/pages.yml` — deploys a combined static site to GitHub
  Pages on every push: SkyFrame at `/`, HoofCast at `/hoofcast/`.
- `.github/workflows/worker-deploy.yml` — deploys the SkyFrame Cloudflare
  Worker whenever `worker/**` changes.

## HoofCast

A horse-riding-conditions forecast app: pick any location (city/state or
ZIP) and any day up to 10 days out, and get a rating —
**Excellent / Great / Questionable / Sketchy** — with a plain-language
explanation of exactly which factor (trail footing from recent rain, wind,
heat/humidity, cold, rain that day, or storms/ice) drove the rating.

- Static-only PWA, no backend: all data comes free, keyless, and
  CORS-enabled straight from the browser —
  [Open-Meteo](https://open-meteo.com) for forecast + recent-rain history
  and city/state geocoding, and [Zippopotam.us](https://zippopotam.us) for
  ZIP code lookup.
- Defaults to Warrenton, VA / today on first load.
- Versioned independently from SkyFrame via `CONFIG.VERSION` in
  `hoofcast/index.html` (kept in lockstep with `CACHE_VERSION` in
  `hoofcast/sw.js`, same convention as SkyFrame). Currently v0.0.1 — an
  early MVP; rating thresholds are expected to be tuned before a v1.0.
- Local preview: `cd hoofcast && python3 -m http.server 8766`, then open
  `http://localhost:8766/index.html`.
- Deployed alongside SkyFrame at `<pages-url>/hoofcast/`.

## Quick start (local preview)

No build step is required — `web/` is plain static files.

```
cd web
python3 -m http.server 8765
```

Then open `http://localhost:8765/index.html`. Without a configured Worker,
the app automatically uses free public ADS-B sources directly.

## Deploying for real

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the full walkthrough:
Cloudflare Worker setup, GitHub Pages hosting, and installing the app on
each platform.

## Verifying changes

After editing `web/index.html`, run:

```
node scripts/check-syntax.js
```

This must pass before shipping — it's the guardrail against accidentally
introducing modern JS syntax that old Safari can't parse.
