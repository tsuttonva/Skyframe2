# Backlog

## Remove "fail into demo mode" fallback

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
