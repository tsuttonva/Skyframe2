# SkyFrame — Setup & Deployment Guide

This guide assumes **zero prior experience** with app development, command
lines, or deployment. Follow it top to bottom, in order. It will take about
30–45 minutes the first time.

SkyFrame has two parts that get deployed separately:

1. **The Worker** — a small backend program that lives on Cloudflare's
   network. It talks to the live flight-data APIs on your behalf, looks up
   military aircraft, and (optionally) looks up flight routes. This step is
   optional — the app still works without it, using free public data sources
   directly — but the Worker is recommended because it adds military-aircraft
   tagging and the route lookup feature.
2. **The website** — the actual app you load on your phone/computer. It's a
   single folder of static files (no server needed) that you host for free
   on GitHub Pages.

---

## Part 0 — What you'll need

- A computer (macOS, Windows, or Linux) you can install software on.
- A free [GitHub](https://github.com) account (you already have the
  `tsuttonva/skyframe2` repository, so you're set).
- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account (only
  needed if you want the Worker — recommended).
- About 30 minutes.

---

## Part 1 — Install Node.js

Node.js is the program that lets you run the deployment tools from your
computer's command line.

1. Go to [nodejs.org](https://nodejs.org).
2. Download the **LTS** version for your operating system and run the
   installer, clicking "Next"/"Continue" through the defaults.
3. Open a terminal:
   - **macOS**: open the **Terminal** app (search for it with Spotlight, ⌘+Space).
   - **Windows**: open **PowerShell** (search for it in the Start menu).
4. Type the following and press Enter to confirm it installed correctly:

   ```
   node --version
   ```

   You should see something like `v20.11.0` printed back. If you see an
   error instead, restart your terminal and try again; if it still fails,
   redo the installer step.

---

## Part 2 — Get the project onto your computer

1. In your terminal, navigate to wherever you keep projects, e.g.:

   ```
   cd ~/Documents
   ```

2. Clone the repository (this downloads it):

   ```
   git clone https://github.com/tsuttonva/skyframe2.git
   cd skyframe2
   ```

   If you don't have `git` installed, macOS will prompt you to install the
   "Command Line Tools" the first time you run a `git` command — accept
   that prompt. On Windows, install [Git for Windows](https://git-scm.com/download/win)
   first, then retry.

Everything below assumes your terminal's current folder is this
`skyframe2` folder, unless a step says to `cd` somewhere else.

---

## Part 3 — Deploy the Worker (backend)

This part is optional but recommended. Skip to Part 4 if you'd rather run
without it for now — you can always come back and do this later, since the
app gracefully uses free public data directly when no Worker is configured
correctly.

### 3.1 Install the Worker's tools

```
cd worker
npm install
```

This downloads `wrangler`, Cloudflare's command-line deployment tool, into
a `node_modules` folder. This is normal and may take a minute.

### 3.2 Log in to Cloudflare

```
npx wrangler login
```

This opens your web browser and asks you to log in to Cloudflare (or create
a free account if you don't have one) and click **Allow** to authorize the
CLI. Once it says "Successfully logged in", return to the terminal.

### 3.3 Create the KV namespace (a small key-value database)

The Worker needs a tiny database to cache things like the military
aircraft list and the monthly API usage counter. Create it with:

```
npx wrangler kv namespace create SKYFRAME_KV
```

This prints something like:

```
[[kv_namespaces]]
binding = "SKYFRAME_KV"
id = "a1b2c3d4e5f6..."
```

Copy that `id` value (the long string of letters/numbers).

### 3.4 Paste the namespace ID into the config file

1. Open `worker/wrangler.toml` in any text editor (Notepad, TextEdit, VS
   Code — whatever you have).
2. Find this line near the bottom:

   ```
   id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"
   ```

3. Replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with the `id` you copied in
   step 3.3, keeping the quotes. Save the file.

### 3.5 Set your alert email (optional but recommended)

The Worker can email you a warning if the paid route-lookup API usage hits
75% or 100% of its monthly cap, so you're never surprised by a bill.

In `worker/wrangler.toml`, find:

```
ALERT_EMAIL = "you@example.com"
```

Replace `you@example.com` with your real email address, and save.

### 3.6 Set your secret API keys

**Important: never type real API keys into a chat with an AI assistant, and
never commit them to a file in the repository.** Secrets are set directly
on Cloudflare's servers using the commands below — they never touch git or
this codebase.

These two are both optional — the app works without either, just with
reduced features (no military tagging without the hex database lookup
still works fine without a key; no route lookups without the route key).

**FlightAware AeroAPI key** (powers the origin/destination route lookup on
the detail card). Sign up at [flightaware.com/commercial/aeroapi](https://flightaware.com/commercial/aeroapi/),
get an API key, then run:

```
npx wrangler secret put AEROAPI_KEY
```

It will prompt you to paste the key and press Enter. The key is now stored
securely on Cloudflare, not in any file.

**Resend API key** (powers the 75%/100% usage-cap warning emails). Sign up
for free at [resend.com](https://resend.com), get an API key, then run:

```
npx wrangler secret put RESEND_API_KEY
```

Paste the key when prompted.

If you skip either of these, that feature is simply disabled — the app
itself will not crash or break.

### 3.7 Deploy the Worker

```
npm run deploy
```

When it finishes, it prints a URL that looks like:

```
https://skyframe-worker.YOUR_SUBDOMAIN.workers.dev
```

**Copy this URL** — you'll need it in the next part.

### 3.8 Verify it's running

Visit `https://skyframe-worker.YOUR_SUBDOMAIN.workers.dev/health` in your
browser (using your actual URL). You should see a small JSON response
reporting the version and status. If you see an error page instead,
double check Part 3.4 (the KV namespace ID) and re-run `npm run deploy`.

---

## Part 4 — Point the app at your Worker

1. Open `web/index.html` in a text editor.
2. Search for this line near the top (in the `CONFIG` section):

   ```js
   WORKER_URL: 'https://skyframe-worker.YOUR_SUBDOMAIN.workers.dev',
   ```

3. Replace the URL with the **real Worker URL** you copied in step 3.7.
   Save the file.

   If you skipped Part 3 entirely, leave this as-is — the app will fail
   over to free public data sources automatically and still work, just
   without military tagging or route lookups.

---

## Part 5 — Publish the website with GitHub Pages

1. Commit and push your changes (replace the URL edit you just made):

   ```
   cd ..
   git add web/index.html worker/wrangler.toml
   git commit -m "Configure deployment URLs"
   git push
   ```

   (If you're not comfortable with git commands, you can also edit the file
   directly on github.com: open the file, click the pencil/edit icon, make
   the change, and commit — no terminal required.)

2. On GitHub, go to your repository: `github.com/tsuttonva/skyframe2`.
3. Click **Settings** (top menu bar of the repo).
4. In the left sidebar, click **Pages**.
5. Under **Build and deployment** → **Source**, choose **Deploy from a
   branch**.
6. Under **Branch**, choose your branch (e.g. `main`) and set the folder to
   **`/web`** (use the folder dropdown next to the branch selector — it's
   the second dropdown, defaulting to `/ (root)`; change it to `/web` if
   that exact option is available, or use the **GitHub Actions** flow below
   if `/web` isn't offered as a folder choice on your plan).
7. Click **Save**.
8. Wait 1–2 minutes, then refresh the Pages settings page. It will show a
   green box with your live URL, something like:

   ```
   https://tsuttonva.github.io/skyframe2/
   ```

   Open that URL — append `/index.html` if it doesn't load the page
   automatically.

### If your repo doesn't offer a `/web` folder option

Some GitHub plans only let "Deploy from a branch" serve `/` or `/docs`.
If that happens, use this tiny GitHub Actions workflow instead, which
publishes only the `web` folder:

1. In Settings → Pages, set **Source** to **GitHub Actions**.
2. Create a file at `.github/workflows/pages.yml` in the repo with:

   ```yaml
   name: Deploy Pages
   on:
     push:
       branches: [main]
   permissions:
     contents: read
     pages: write
     id-token: write
   jobs:
     deploy:
       runs-on: ubuntu-latest
       environment:
         name: github-pages
         url: ${{ steps.deployment.outputs.page_url }}
       steps:
         - uses: actions/checkout@v4
         - uses: actions/upload-pages-artifact@v3
           with:
             path: web
         - id: deployment
           uses: actions/deploy-pages@v4
   ```

3. Commit and push this file. GitHub will build and publish automatically
   on every push to `main`.

---

## Part 6 — Install SkyFrame on your devices

Once your GitHub Pages URL is live, you can "install" SkyFrame like a real
app (it's a Progressive Web App — no app store needed).

### iPhone / iPad (Safari)

1. Open your GitHub Pages URL in **Safari** (must be Safari, not Chrome).
2. Tap the **Share** icon (square with an arrow).
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add**. SkyFrame now appears as an icon on your home screen and
   launches full-screen, like a native app.

### Android (Chrome)

1. Open your GitHub Pages URL in **Chrome**.
2. Tap the **⋮** menu (top right).
3. Tap **Add to Home screen** (or **Install app** if Chrome offers it
   directly).
4. Confirm. SkyFrame is now installed.

### macOS (Safari or Chrome)

- **Safari**: open the URL, then File menu → **Add to Dock**.
- **Chrome**: open the URL, click the **⋮** menu → **Cast, save, and
  share** → **Install page as app** (wording varies by Chrome version;
  look for an install icon in the address bar).

### Windows (Edge or Chrome)

1. Open the URL in **Edge** or **Chrome**.
2. Click the **install icon** in the address bar (a small monitor-with-arrow
   icon), or open the **⋯**/**⋮** menu and choose **Apps → Install this
   site as an app**.
3. Confirm. SkyFrame now has a taskbar/Start Menu shortcut and opens in its
   own window.

---

## Part 7 — Updating the app later

Whenever you (or an assistant) make changes to the code:

- **Worker changes** (`worker/src/index.js` or `worker/wrangler.toml`):
  re-run `npm run deploy` from inside the `worker` folder.
- **Website changes** (`web/index.html` or anything else in `web/`): just
  `git push` — GitHub Pages redeploys automatically within a minute or two.
- If you bump the version number (`CONFIG.VERSION` in `web/index.html`),
  also bump `CACHE_VERSION` at the top of `web/sw.js` to the same value, so
  installed devices pick up the update instead of serving a stale cached
  copy.

---

## Troubleshooting

- **"This site can't be reached" on the Pages URL** — wait a few more
  minutes after enabling Pages; first deploys can take up to 5 minutes.
- **App loads but never shows real aircraft, banner says "DEMO MODE —
  Reconnecting…"** — this is expected/by-design behavior when no data
  source is reachable (e.g. you're offline, or every public API is briefly
  down). It will silently switch to live data the moment a source responds.
  If it never recovers, double-check `CONFIG.WORKER_URL` in `web/index.html`
  is correct and that `/health` on that URL works (Part 3.8).
- **`npx wrangler login` opens a browser but nothing happens after I click
  Allow** — close the browser tab and check the terminal; it usually
  completes a few seconds later regardless.
- **I lost my AeroAPI or Resend key** — you can't view secrets you've
  already set with `wrangler secret put`; just generate a new key from
  the provider's dashboard and run `wrangler secret put` again to overwrite
  it.
