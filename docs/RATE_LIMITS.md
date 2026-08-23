# External service limits

A reference for every rate limit, quota, and usage policy this app's
external dependencies publish -- built after a real incident (Aug 22-23,
2026) where guessing about limits instead of looking them up cost hours of
confused debugging. See the (resolved) "adsb.lol rate-limiting reliability"
entry in `BACKLOG.md` for the full story.

**Before changing anything that touches an external API in this repo**
(polling frequency, caching TTLs, KV usage, retry/backoff logic, adding a
new upstream), read this file first. If a service's actual behavior turns
out to differ from what's documented here, update this file in the same
commit -- that's how it stays useful instead of going stale like the
guesses it replaced.

Each entry below is **Official** (cited vendor docs) or **Unofficial /
community notes** (forum posts, GitHub issues, blog posts -- real-world
reports, not vendor-confirmed, cited so you can judge their weight
yourself). Researched Aug 23, 2026; numbers can change -- if something here
looks off during a debugging session, that's worth re-verifying and fixing
here, not just working around in code.

---

## This app's own incident history (start here)

Three things bit this app for real, in order of how much they actually
hurt:

1. **adsb.lol rate-limits the shared Cloudflare Workers IP pool** with
   HTTP 429 -- confirmed live via `wrangler tail`, sometimes a brief blip,
   sometimes sustained 2+ minutes straight. No published numeric limit
   exists for this (see below) -- it's load-based and undocumented.
2. **airplanes.live returns a hard 403 to every request from a Cloudflare
   Worker** -- confirmed live, not documented anywhere as intentional, but
   a closed GitHub issue on their API's old repo independently reports the
   same "constant 403s from multiple networks" symptom.
3. **Cloudflare Workers KV's free-tier daily write cap (1,000/day) was
   nearly exhausted** because two code paths (analytics logging, and this
   app's own stale-fallback cache) each did a KV read+write on every
   single `/flights` request. This one *is* precisely documented (see
   below) -- it was avoidable by reading the docs first, which is the
   entire reason this file exists now.

---

## Cloudflare Workers

**Official**
- Free plan: 100,000 requests/day (resets 00:00 UTC), 10ms CPU time per
  request, 6 simultaneous outgoing connections per request, up to 50
  external subrequests per invocation (1,000 to Cloudflare's own
  services), 3 MB compressed script size.
  [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/),
  [Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- Paid plan: CPU time configurable up to 5 minutes (30s default);
  subrequest limit raised to 10,000 by default (Feb 2026), adjustable up
  to 10,000,000 via Wrangler config; no daily request cap (usage-based
  billing beyond included volume).
  [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/),
  [Subrequests changelog](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/)
- The 6-simultaneous-outgoing-connections limit is the same on both tiers.

**Unofficial / community notes**
- Cloudflare Community reports Workers occasionally hitting an edge-level
  429 *before the Worker's own code even runs*, distinct from anything
  your own code or bindings generate -- worth ruling out if a 429 shows up
  that the app's own logic can't explain.
  [Cloudflare Community thread](https://community.cloudflare.com/t/workers-blocked-by-edge-firewall-429-too-many-requests-before-runtime-execution/856364)

---

## Cloudflare Workers KV

**Official**
- Free tier: **100,000 reads/day, 1,000 writes/day, 1,000 deletes/day,
  1,000 list ops/day**, 1 GB stored data. All daily counters reset
  00:00 UTC; exceeding one counter fails further ops of that type for the
  rest of the day. This is the exact cap this app's own incident hit.
  [KV Limits](https://developers.cloudflare.com/kv/platform/limits/)
- Paid tier: unlimited reads and writes to *different* keys/day;
  effectively unlimited storage (billed per GB).
- Applies on **both** tiers regardless of plan: max key size 512 bytes,
  max value size 25 MiB, max metadata size 1,024 bytes, **writes to the
  same key are capped at 1/second**, 1,000 namespaces/account, up to 1,000
  KV ops per single Worker invocation, minimum `cacheTtl` 30s.
  [KV Limits](https://developers.cloudflare.com/kv/platform/limits/)

**Unofficial / community notes**
- None found beyond restatements of the official numbers. Worth
  remembering: KV is only *eventually consistent*, and the same-key
  1/second write cap applies on the paid tier too -- don't assume paying
  removes that specific constraint.

---

## adsb.lol

**Official**
- Informal, community/volunteer-run project (adsb.lol / adsb.fi lineage,
  successor to ADS-B Exchange's original open data). **No formal, numeric
  published rate limit exists.** Their own docs say rate limiting is
  "dynamic based on the environment load" and "if you get 4xx errors, you
  are doing something wrong" -- there is no requests-per-second/day figure
  to cite, by design.
  [adsb.lol API docs](https://www.adsb.lol/docs/open-data/api/),
  [github.com/adsblol/api](https://github.com/adsblol/api)
- Their README says an API key will become mandatory in future, obtained
  by contributing ADS-B feed data ("feeding adsb.lol") -- not yet
  enforced, and carries no documented quota even once it is.

**Unofficial / community notes**
- No GitHub issues or forum threads found describing specific numeric
  429/throttling thresholds. The lack of published policy is itself the
  finding -- **any assumption about adsb.lol's rate limit is unverified**.
  This app's own 429s (sometimes sustained 2+ minutes) are consistent
  with an undocumented, load-based throttle and cannot be predicted from
  a published number. Treat retries/backoff/circuit-breaking around this
  API as defensive engineering against an unknown, not a known quantity.

---

## airplanes.live

**Official**
- API guide at [airplanes.live/api-guide](https://airplanes.live/api-guide/),
  landing page at [airplanes.live/api](https://airplanes.live/api/). Free,
  unauthenticated by default; an API key can be requested for "production
  use." No exact requests/second or /day figure found on the current
  pages.
- A related archived project in the same community
  (`github.com/airplanes-live/api-archive`, formerly documenting the
  "adsb.one" API, same ADSBExchange-compatible response shape) documents
  one citable number: **1 request/second**.
  [airplanes-live/api-archive README](https://github.com/airplanes-live/api-archive/blob/main/README.md)
- airplanes.live, adsb.one, and adsb.fi all trace back to the same
  community split from ADS-B Exchange.
  [Our History and Moving Forward](https://airplanes.live/history-and-moving-forward/)

**Unofficial / community notes -- most relevant to this app's incident**
- A closed GitHub issue, **"Constant 403 errors"** (opened Jan 22 2026) on
  the archived airplanes-live API repo: *"API not returning any responses.
  All methods of request from different machines on different networks
  results in same 403 error."* No public resolution found, but it
  independently corroborates a history of blanket 403s on this API family
  unrelated to simple per-IP rate limiting -- consistent with what this
  app observed live from Cloudflare Workers.
  [Issue #5](https://github.com/airplanes-live/api-archive/issues/5)
- No official doc or thread confirms "we block Cloudflare Workers/AWS
  Lambda/datacenter IP ranges" in so many words -- that conclusion in this
  app's own investigation was inferred from live logs (100% consistent
  403 from a Worker, 0% from this app's own tests), not from any
  published policy. **Treat as unverified/inferred, not vendor-confirmed**
  -- but the code in this repo no longer relies on it either way (removed
  as a server-side fallback after confirming it never succeeds from a
  Worker).

---

## OpenSky Network REST API

**Official**
- Uses OAuth2 client-credentials auth (Basic Auth deprecated). Rate
  limiting is a **credit system**, three independent buckets for
  `/states/*`, `/tracks/*`, `/flights/*`:
  - Anonymous (no auth): 400 credits/day
  - Authenticated: 4,000 credits/day
  - Active feeder (ADS-B receiver, ≥30% monthly uptime): 8,000 credits/day
  - Licensed users: 14,400 credits/hour
- Anonymous requests only get the most recent state vectors (the `time`
  param is ignored); authenticated requests can look back up to 1 hour
  (older → HTTP 400). State-vector cost is 1-4 credits by bounding-box
  area; flight/track queries cost more depending on date range.
- Exceeding your allotment returns 429 with an
  `X-Rate-Limit-Retry-After-Seconds` header. OAuth2 bearer tokens expire
  after 30 minutes.
  [OpenSky REST API docs](https://openskynetwork.github.io/opensky-api/rest.html),
  [rest.rst source](https://github.com/openskynetwork/opensky-api/blob/master/docs/free/rest.rst)

**Unofficial / community notes**
- This credit/OAuth2 model is *newer* than the older "400 anonymous /
  4,000 authenticated requests-per-day, 10s/5s minimum interval" figures
  widely quoted in older blog posts. If any note anywhere (including old
  commit messages in this repo) cites those older numbers, they're
  likely stale -- verify against the docs link above.
  [Related integration discussion](https://github.com/TwinFan/LiveTraffic/issues/237)
- This app's client-side `opensky` fallback (`web/index.html`) fails
  every time from a browser regardless -- OpenSky's CORS header is set to
  their own domain, not the caller's, so it was never actually usable
  from a web page in the first place. Confirmed via DevTools, unrelated
  to the credit system above.

---

## FlightAware AeroAPI

**Official**
- AeroAPI v4, tiered, per-second/minute cap per tier (result set = up to
  15 records/call):
  - **Personal**: 10 result-sets/minute, no monthly minimum (up to
    $5/mo free usage, $10 for ADS-B feeders)
  - **Standard**: 5 result-sets/second, $100/mo minimum
  - **Premium**: 100 result-sets/second, $1,000/mo minimum
  [AeroAPI v4](https://www.flightaware.com/commercial/aeroapi/v4/),
  [AeroAPI v3 pricing](https://www.flightaware.com/commercial/aeroapi/v3/pricing.rvt)

**Unofficial / community notes**
- Multiple threads on FlightAware's own community forum report the
  Personal tier throttling in bursts *even when believed to be within the
  per-minute allotment* -- a dozen calls within a few seconds triggered
  429s that only cleared once spaced out, and `max_pages` above ~8 can
  trigger a mid-pagination 429. Even Premium-tier users report the same
  symptom.
  [Rate limit when within bounds](https://discussions.flightaware.com/t/rate-limit-error-when-i-should-be-within-my-bounds/86412),
  [429 instead of 400 for quota overuse](https://discussions.flightaware.com/t/http-429-instead-of-http-400-for-quota-overuse/40837),
  [Intermittent 429s](https://discussions.flightaware.com/t/experiencing-intermittent-429-errors-when-querying-aeroapi-endpoints/93288),
  [429 on Premium](https://discussions.flightaware.com/t/keep-getting-status-429-even-when-using-premium-account/80564)
- Takeaway: the published per-second/minute number is a ceiling, not a
  guarantee -- burst traffic under the nominal cap can still draw 429s,
  likely from minute/second boundary rollover timing on their side. This
  app already guards AeroAPI behind its own hard monthly cap
  (`AEROAPI_MONTHLY_CAP` in `worker/wrangler.toml`) and a free-source
  fallback -- worth remembering that cap protects against *volume*, not
  against *bursts* within volume.

---

## Nominatim / OpenStreetMap (reverse geocoding)

**Official**
- Canonical policy: **absolute max 1 request/second**, from a single
  IP/thread, "no heavy uses." A valid, application-identifying
  `User-Agent` (or `Referer`) is required -- the default User-Agent set by
  common HTTP libraries is explicitly called out as unacceptable.
- Explicitly prohibited: client-side autocomplete built on the API,
  systematic/bulk queries (e.g. reverse-geocoding a grid), downloading
  full datasets via the API.
- Best-effort service on donated infrastructure, not a commercial SLA.
  [Nominatim Usage Policy](https://operations.osmfoundation.org/policies/nominatim/)

**Unofficial / community notes**
- Real-world 403s are commonly caused specifically by a missing/generic
  User-Agent header. For usage beyond the 1 req/sec baseline, the answer
  from OSM's own community is "run your own Nominatim instance" -- there
  is no paid tier from OSMF itself.
  [User-Agent 403 discussion](https://help.openstreetmap.org/questions/74205/nominatim-usage-policy-http-referers-and-user-agents),
  [403 troubleshooting](https://help.openstreetmap.org/questions/62083/server-returned-http-response-code-403-for-url-httpnominatimopenstreetmaporgreverseformatjsonlat287041lon771025),
  [Policy compliance discussion](https://community.openstreetmap.org/t/understanding-and-complying-with-nominatim-usage-policy/129212),
  [Heavy-usage / custom instance thread](https://help.openstreetmap.org/questions/60524/rate-limits-for-heavy-usage-nominatim-custom-instance)

---

## GitHub raw content (`raw.githubusercontent.com`) and GitHub Pages

**Official**
- Unauthenticated REST API: **60 requests/hour**, keyed to the source IP
  (vs. 5,000/hour authenticated).
  [REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- May 2025 changelog: rate limits for unauthenticated access (HTTPS
  clone, anonymous REST calls, `raw.githubusercontent.com` downloads)
  were tightened; no exact numeric ceiling published for raw-content CDN
  specifically.
  [Changelog: updated unauthenticated rate limits](https://github.blog/changelog/2025-05-08-updated-rate-limits-for-unauthenticated-requests/)
- GitHub Pages soft limits: **100 GB/month bandwidth**, **10 builds/hour**
  (the build limit doesn't apply if publishing via a custom GitHub
  Actions workflow instead of the default Pages build -- which is what
  this repo does, per `.github/workflows/pages.yml`).
  [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)

**Unofficial / community notes**
- A GitHub staff member stated in a community discussion that
  unauthenticated `raw.githubusercontent.com` access is roughly **5,000
  requests/hour per IP** in practice, while cautioning the number "isn't
  going to be exact" due to internal routing/caching. Not in the written
  docs -- a forum statement from GitHub staff, directionally useful but
  not contractual.
  [Community discussion](https://github.com/orgs/community/discussions/160828)
- Multiple community threads report 429s on `*.githubusercontent.com`
  well below any self-diagnosable number, in some cases apparently tied
  to specific request headers (one thread implicates
  `Accept-Language: zh-CN`); the githubusercontent.com CDN domains seem
  to be throttled more aggressively than github.com's main API.
  [Accept-Language-triggered 429s](https://github.com/orgs/community/discussions/157887),
  [Static resource rate limiting #157940](https://github.com/orgs/community/discussions/157940),
  [Static resource rate limiting #157851](https://github.com/orgs/community/discussions/157851)
- Relevant to this repo: the weekly military-hex-range DB rebuild
  (`worker/src/index.js`, `rebuildMilDb`) fetches from
  `raw.githubusercontent.com` on a cron trigger, well within any of the
  above figures at once-a-week frequency.

---

## hexdb.io (aircraft registration/type lookup)

**Official**
- Documented cap on their own site: **no more than 1,000 requests every
  5 minutes**; contact them directly for a higher limit or to be
  unblocked. No formal SLA or written acceptable-use doc beyond this.
  [hexdb.io](https://hexdb.io/)

**Unofficial / community notes**
- No community reports found. Small/single-maintainer footprint -- budget
  conservatively against the one published number, since there's no
  fallback signal if it changes silently.

---

## Resend (transactional email, used only for usage-cap alerts)

**Official**
- Default rate limit: **10 requests/second per team**, across all API
  keys on the team; higher limits available on request.
  [Resend rate-limit docs](https://resend.com/docs/api-reference/rate-limit)
- Free plan: **3,000 emails/month, capped at 100/day**, single verified
  domain.
  [Resend free tier announcement](https://resend.com/blog/new-free-tier)

**Unofficial / community notes**
- No specific reports of stricter real-world enforcement found; this
  app's usage (occasional cap-warning emails) is nowhere near either
  limit.

---

## aviationweather.gov (NOAA/NWS Aviation Weather Center Data API)

**Official**
- Documented guidance: don't exceed **100 requests/minute** overall, and
  don't poll a single endpoint faster than **1 request/minute per
  thread**. Exceeding limits can result in being blocked. Most METAR data
  updates hourly, so faster polling is discouraged; use their cache files
  for bulk/large queries; set a distinct custom `User-Agent`.
  [aviationweather.gov Data API](https://aviationweather.gov/data/api/)

**Unofficial / community notes**
- No specific incident reports found; the above is official guidance
  rather than a hard enforced number reported by users.

---

## api.planespotters.net (aircraft photo lookup)

**Official**
- **No official public API documentation found.** The endpoint pattern
  used by this app and others (e.g. ADS-B Exchange's own web client) is
  observable in the wild, but Planespotters.net doesn't appear to publish
  a formal API reference, rate limit, or terms of use for it.

**Unofficial / community notes**
- Effectively undocumented/reverse-engineered. **Any rate-limit
  assumption here is entirely unverified** -- no numeric figures, official
  or unofficial, were found anywhere. This app already degrades
  gracefully (hides the thumbnail silently if no photo exists) -- keep it
  that way rather than assuming any particular request budget.

---

## Open-Meteo (used by HoofCast)

**Official**
- Free/non-commercial tier: **10,000 calls/day, 5,000/hour, 600/minute**,
  no API key required, **non-commercial use only**, attribution required
  (CC BY 4.0). Paid tiers exist for higher volume/commercial use.
  [Open-Meteo Pricing](https://open-meteo.com/en/pricing),
  [Open-Meteo Terms](https://open-meteo.com/en/terms)

**Unofficial / community notes**
- Same figures independently confirmed by Open-Meteo's creator in a
  public Hacker News comment -- included here as corroboration, but the
  pricing page above is the authoritative source.
  [Creator comment, Hacker News](https://news.ycombinator.com/item?id=46591888)

---

## Zippopotam.us (used by HoofCast, ZIP code lookup)

**Official**
- No published/hard rate limit and no API key required, per their own
  docs. Data under the Open Database License / Database Contents
  License.
  [Zippopotam.us docs](https://docs.zippopotam.us/docs/getting-started/)

**Unofficial / community notes**
- Small best-effort community service with no formal SLA -- "no published
  limit" isn't a guarantee. No specific incident reports found; keep
  basic error handling regardless of the lack of a stated cap.
