# Backlog

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

## Make the flight list and detail card interactive

Two related ideas:
- Clicking a row in the side list (or a dedicated link/icon within it)
  opens that aircraft's FlightAware tracking page in a new tab
  (`https://flightaware.com/live/flight/<callsign>` style URL) so the user
  can jump to real-time third-party tracking for a specific flight.
- Show a small thumbnail photo of the aircraft (by ICAO24 hex or
  registration) in both the side list row and the detail card, clickable
  to view a larger version. Needs a photo source/API (e.g.
  planespotters.net's public API keyed by ICAO24, or airport-data.com) —
  need to check rate limits/licensing before wiring it in, and decide on a
  placeholder for aircraft with no available photo.

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
