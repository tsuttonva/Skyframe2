# SkyFrame

A live aircraft-tracking radar display centered on your location. Built as
an installable Progressive Web App (PWA) that runs on iOS, macOS, Windows,
and Android from a single static site, with an optional Cloudflare Worker
backend for military-aircraft tagging and flight-route lookups.

## Repo layout

- `web/` — the entire frontend: `index.html` (the app), `manifest.webmanifest`
  and `sw.js` (PWA install/offline support), `fips.json` (county lookup
  data), `icons/`.
- `worker/` — the Cloudflare Worker backend (`src/index.js`) that proxies
  flight data, tags military aircraft, and looks up flight routes behind a
  hard monthly cost cap.
- `scripts/check-syntax.js` — a pre-ship gate that verifies `web/index.html`
  contains no ES2020+ syntax, to keep it working on old iOS Safari (12.5.x).
- `docs/DEPLOYMENT.md` — full step-by-step setup and deployment instructions,
  written for someone with no prior deployment experience.

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
