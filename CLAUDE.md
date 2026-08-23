# Instructions for Claude working in this repo

## Before touching anything that calls an external API

Read `docs/RATE_LIMITS.md` first -- rate limits, quotas, and usage
policies for every external service this app depends on (Cloudflare
Workers, Cloudflare Workers KV, adsb.lol, airplanes.live, OpenSky,
FlightAware AeroAPI, Nominatim, GitHub raw content/Pages, hexdb.io,
Resend, aviationweather.gov, planespotters.net, and Open-Meteo/
Zippopotam.us for HoofCast).

This applies to: polling frequency or interval options, cache TTLs,
retry/backoff logic, anything reading or writing Cloudflare KV, adding a
new upstream/fallback source, or changing how often any endpoint in
`worker/src/index.js` gets called. Guessing about a limit instead of
checking that file is exactly what caused a real multi-hour debugging
session (Aug 22-23, 2026) -- see the resolved "adsb.lol rate-limiting
reliability" entry in `BACKLOG.md` for the full story.

If you discover a service actually behaves differently than
`docs/RATE_LIMITS.md` says (a published number is wrong, a limit is
tighter/looser in practice, a new undocumented behavior shows up), update
that file in the same commit as the code change. It's only useful if it
stays current.
