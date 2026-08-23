# Backlog

## IN PROGRESS: adsb.lol rate-limiting reliability (pick up here)

Symptom that started this: `/flights` intermittently (then, under heavy
testing, *persistently*) returning `502`, cascading into every other
fallback source failing too -- browser console showed something like
`airplanesLive: Failed to fetch; direct: Failed to fetch; opensky: Failed
to fetch; worker: worker http 502`.

Root cause, confirmed live via `npx wrangler tail` (not guessed): adsb.lol
rate-limits by source IP, and Cloudflare Workers share IP ranges across
many unrelated tenants. Saw real `429`s from adsb.lol to the worker --
sometimes a brief blip, but during a heavy testing session (many rapid
location changes in one evening) saw it sustained for 2+ minutes straight
(6 consecutive 20s poll cycles for Syracuse, NY, every single one a 429,
right up until testing stopped for the night).

Fixes shipped so far, all in `worker/src/index.js` (`handleFlights` and
around), deployed to both `claude/skyframe2-session-recovery-0s85kv` and
the live deploy branch `claude/cross-platform-app-build-vtwr2l`:

1. Retry a failed adsb.lol call twice (500ms/1500ms backoff) before
   giving up on a single request.
2. Restored the worker's own upstream cache to 25s (it had been cut to
   10s in v1.0.47 to support the 10s poll-interval option, which tripled
   request volume to adsb.lol regardless of any one client's actual poll
   setting -- this was a real contributor, not just a coincidence).
3. Proper `User-Agent` identifying the app + contact URL sent to adsb.lol
   (was a bare, anonymous-looking string before).
4. Stale-data fallback on failure: serve the last known-good aircraft
   list for that location/radius instead of a hard error. Checks
   in-memory cache first, then a durable KV-backed cache
   (`flights:<lat>,<lon>,<radius>` key, 6h TTL) so a freshly
   deployed/cold-started worker isolate still has something to serve.
   Confirmed working live (`kv fallback HIT` seen in tail output).
5. Tried adding airplanes.live as a second server-side upstream --
   confirmed via `wrangler tail` it returns a hard `403` to *every single*
   request from a Cloudflare Worker (their own bot-protection blocking
   Workers' IP ranges outright, not transient/rate-limit-shaped), so this
   was removed again as pure dead weight.
6. Circuit breaker: after one live adsb.lol failure, the worker stops
   attempting/retrying against it for 60s (`ADSB_COOLDOWN_MS`) and goes
   straight to cache/KV/502 instead, so it isn't piling more requests onto
   an already-throttled window every 20s.
7. Diagnostic `console.log` lines left in `handleFlights` on purpose
   (visible via `npx wrangler tail`) -- logs adsb.lol status,
   circuit-breaker state, and cache/KV hit-or-miss. Useful for next time,
   don't remove without a reason.

**Side effect discovered the next morning:** Cloudflare emailed a "50% of
daily Workers KV op cap" warning about 30 minutes before testing stopped
that night. Cause: analytics logging (pre-existing, unrelated to this
investigation) *and* the new stale-fallback cache (fix #4) both did a KV
read+write on every single `/flights` request -- easily enough combined
volume, especially under heavy testing, to approach the free tier's
1,000-writes/day cap. Fixed the same session:
8. Analytics events are now buffered in memory and flushed to KV in
   batches (every 20 events or 5 minutes) instead of one KV op pair per
   request.
9. The stale-fallback KV write (fix #4) is now throttled to once per 5
   minutes per location instead of every successful fetch.
10. The KV read in the fallback path is now wrapped in try/catch, so if
    KV itself ever rejects requests (cap fully hit, not just 50%), it
    degrades to a plain 502 instead of an uncaught exception turning it
    into a confusing 500.

Quota resets daily at 00:00 UTC. Worth glancing at the Cloudflare
dashboard ("View usage" link in that email) to confirm the new write
volume stays comfortably under the cap during normal use, not just during
another testing burst.

**Not yet confirmed:** whether the circuit breaker (fix #6, the last one
shipped) actually let the sustained Syracuse throttle clear -- testing
stopped for the night with it still failing every cycle. Next session,
start here:

- Check cold (no heavy testing beforehand) whether a brand-new location's
  first request now succeeds normally, or is still hitting 429.
- If still bad after a quiet period: consider whether `ADSB_COOLDOWN_MS`
  (currently 60s) needs to be longer, or whether last night's testing got
  this Worker's IP a longer-than-60s penalty from adsb.lol that needs more
  time (hours, not minutes) to clear on its own.
- If it's healthy: consider this resolved, but keep an eye out since nothing
  here can fully control adsb.lol's own rate limiting -- it's shared
  infrastructure outside this app's control.

Lower priority, not blocking: the client-side `direct` (adsb.lol) and
`opensky` fallback sources in `web/index.html` are both structurally
broken when called from a browser (missing/mismatched CORS headers on
their end) and always fail -- confirmed via DevTools, not something we
changed, not urgent since the worker + stale-cache path now carries
reliability. Worth considering removing the dead client-side fallback
attempts for cleanliness at some point.

## ~~Remove "fail into demo mode" fallback~~ (done in v1.0.9)

When all data sources fail repeatedly with no aircraft yet loaded,
`handleFetchFailure()` (`web/index.html`) calls `DemoEngine.enterFallback()`,
which populates the radar with synthetic ambient aircraft and shows a
"DEMO MODE — Reconnecting..." banner instead of an empty/stale screen.

Reported issue: the banner can appear/linger even after real live data has
already loaded (status shows LIVE with real callsigns on screen, but the
"DEMO MODE — Reconnecting..." overlay is still up) — confusing and not
trustworthy. Decision: scrap the whole fallback-into-demo-mode feature
rather than patch the banner timing.

Relevant code (as of v1.0.8):
- `handleFetchFailure()` — the `DemoEngine.enterFallback()` call at the end.
- `attemptRefresh()` — the `DemoEngine.exitFallback(true)` call on success.
- `DemoEngine.enterFallback` / `exitFallback` (~line 1796-1822).
- `STATE.demoMode === 'fallback'` checks scattered through
  `handleFetchFailure`, `attemptRefresh`, render code.

To do: remove the fallback-mode entry point and banner; when all sources
fail, the existing STALE indicator + new last-error message (added in
v1.0.8) should be the only failure UI. Showcase demo mode (the unrelated
"DEMO" button feature) stays as-is.

## Interpolate aircraft positions between polls

Right now each aircraft icon jumps to its new lat/lon only when a refresh
lands (every `CONFIG.REFRESH_MS`, currently 30s). Idea: dead-reckon each
icon's screen position between polls using its last known `true_track`
(heading, degrees) and `velocity` (knots), so a fast aircraft (e.g. an
Airbus at 450kt) visibly glides further between refreshes than a slow one
(e.g. a Cessna at 110kt) — same physics `DemoEngine`'s tick handler
already uses internally to animate synthetic aircraft (see `destPoint(ac.lat,
ac.lon, ac.true_track, stepKm)` around line 1871), just driven by a
render-loop tick instead of by new poll data.

Open questions:
- Needs its own animation loop (`requestAnimationFrame` or a faster
  `setInterval`) independent of the data-refresh timer, recomputing each
  icon's interpolated position every frame and resetting to the real
  reported position whenever a fresh poll lands (don't let drift compound
  across refreshes).
- Aircraft with no recent `velocity`/`true_track` (e.g. stale/0kt ground
  traffic) should just sit still rather than drift on bad data.
- Decide whether the side list's distance/bearing numbers update live with
  the interpolation or only on actual poll refresh (live is more correct
  but churns the list more).

## Bluetooth-triggered physical alert lamp

Idea: build a miniature replica of the taxiway-light lamp (yellow round
base, yellow pole, blue light — pictured) using a small LED instead of a
real taxiway bulb, and have it light up whenever any aircraft is inside
the alert zone (mirrors the in-app alert state) and turn off when the zone
is clear.

**Key constraint to settle before designing further: Web Bluetooth is not
supported in Safari, on iOS or macOS, at all** — and iOS is the stated
primary use case. That rules out the browser talking directly to a BLE
peripheral from this PWA on the platform that matters most. Realistic
architectures instead:
- **WiFi instead of Bluetooth**: a microcontroller (e.g. ESP32) joins the
  same WiFi network and polls a small HTTP endpoint (or holds an
  MQTT/WebSocket connection) for an "alert active" boolean, switching an
  LED/relay accordingly. Works identically from iOS, macOS, or PC since
  the browser isn't the thing connecting to the lamp — the lamp polls (or
  subscribes to) a backend. Could piggyback on the existing
  `skyframe2-worker` Cloudflare Worker (add a tiny status endpoint the app
  PUTs to on every alert-state change, and the ESP32 GETs/polls or
  subscribes to) or a lightweight MQTT broker.
- **Bluetooth Classic / a companion app**: would sidestep the Web
  Bluetooth gap but means writing a native iOS app or shortcut, which is a
  much bigger lift than a WiFi microcontroller.
- Recommendation once we pick this up: go WiFi-based; it's simpler, works
  on every platform without browser API limitations, and the lamp doesn't
  need to be physically near the phone.

Component ideas for the miniature build: ESP32 dev board (has WiFi
built-in, cheap, well-documented), a single blue LED (or a small
WS2812/NeoPixel if we want brightness/color control later) driven directly
from a GPIO (with resistor) or through a small MOSFET if using a brighter
bulb, a small AC-to-5V or USB power supply, and a 3D-printed or
hand-built miniature base/pole to match the reference lamp's look.

**Scope for now: the miniature model only.** Controlling the real 120V
taxiway lamp (mains relay/switching, safety enclosure, etc.) is a
separate, later project and is intentionally out of scope here — noted
below only so the architecture doesn't accidentally paint us into a
corner if we ever do pick it up.

### Architecture: why "same WiFi network" isn't actually needed

The ESP32 and the phone running SkyFrame never need to talk to each other
directly, and don't need to be on the same network. Both sides talk
through a small cloud relay instead (e.g. a couple of new endpoints on the
existing `skyframe2-worker` Cloudflare Worker, or a separate tiny worker):

- The ESP32 just needs *any* WiFi network with internet access. One-time
  setup: flash it with that network's SSID/password, or have it run a
  "first boot" captive portal (broadcast its own temporary WiFi so it can
  be configured from a phone, the way smart plugs do) if it'll ever move
  networks.
- It polls a tiny cloud endpoint every 1-2 seconds: "what state should I
  be in?" (or holds a persistent connection for push, see below).
- SkyFrame writes to that same endpoint whenever `STATE.alertedSet`
  becomes non-empty / goes back to empty: "set device `alert-lamp` to
  ON/OFF."

Recommend starting with simple HTTP polling (1-2s interval) rather than
MQTT/WebSockets — far simpler to build and debug, and that latency is
invisible for a zone-entry indicator. Only move to push (MQTT) later if
polling ever feels too slow.

### Building it as a reusable "named lamp" component, not a one-off

If the cloud relay is built generically — a named device/topic
(`device_id -> state`) rather than one hardcoded "alert lamp" — the exact
same ESP32 firmware and relay design extends to unrelated personal uses
later (e.g. a separate physical lamp somewhere else that a different
controller toggles on/off) for free, since nothing in the design assumes
the controller and the device share a network or even talk to each other
directly. Worth keeping the endpoint/device-ID generic from the start for
that reason, even though right now SkyFrame is the only controller and
the model lamp is the only device.

## ~~Make the detail card interactive~~ (done in v1.0.28)

Detail card now has: a clickable aircraft type name that opens a Wikipedia
search for that type in a new tab; a thumbnail photo (via planespotters.net's
public API keyed by ICAO24 hex, clickable through to the full photo page,
silently hidden if no photo exists); and a "FlightAware ↗" button that opens
that flight's live tracking page using its callsign.

Not done: the side list rows themselves are still not clickable for
FlightAware/thumbnail (only the detail card) — pick back up if wanted.

## ~~Show airport locations on the radar~~ (done in v1.0.22)

Plots an icon at every US large/medium/small airport within the radar's
current radius (`web/airports.json`, sourced from OurAirports, 16,190
entries) — covers GA fields and private strips, not just towered/airline
airports. Bundled as a static, service-worker-cached file (same pattern as
`fips.json`) rather than a live API call; filtered/projected at render time
via `airportCache`, only recomputed when location/radius/canvas size change.
Idents are labeled when zoomed in to 50nm or less (`CONFIG.AIRPORT_LABEL_ZOOM_NM`).

Currently US-only and excludes heliports/seaplane bases/balloonports/closed
strips — could expand scope later if wanted.

## Indicate when route data is degraded (free fallback / cap reached)

`/route` (`worker/src/index.js`) silently falls back from paid AeroAPI to the
free adsb.lol routeset source once the monthly cap is reached (or a paid call
errors). The free source never returns flight `status` or `diverted` info, so
status notes and diversion detection (flashing icon, DIV badge, announcement)
just stop appearing with no explanation. The frontend already receives a
`source` field (`'aeroapi'` / `'free'` / `'none'`) on every route response but
currently discards it. Low priority — not expected to be noticeable in
practice — but if a user ever asks "why did diversion alerts stop working,"
the fix is to surface `source` somewhere (e.g. a small note in the detail
card) when it's `'free'` or `'none'`.
