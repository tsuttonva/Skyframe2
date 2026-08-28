/*
 * SkyFrame Worker — serverless proxy between the static frontend and the
 * upstream flight-data / route / enrichment providers.
 *
 * Endpoints:
 *   GET  /flights?lat=&lon=&dist=   nearby aircraft, military-tagged, 25s cache
 *   GET  /aircraft?icao=            type/registration/description, 24h cache
 *   POST /route                     {callsign} -> origin/destination, 1h cache,
 *                                    paid API behind a hard monthly cap
 *   GET  /weather?lat=&lon=         nearest METAR (aviationweather.gov), 10m cache
 *   GET  /health                    version + usage + military DB status
 *   GET  /usage                     paid API usage/limit/status
 *   GET  /refresh-mil-db            manually rebuild the military hex range DB
 *
 * Scheduled (cron): weekly rebuild of the military hex range DB.
 */

const APP_VERSION_FALLBACK = '1.0.0';
const MIL_RANGES_URL = 'https://raw.githubusercontent.com/wiedehopf/tar1090-db/master/ranges.json';
const MIL_KV_KEY = 'mil:db';
const MIL_KV_TTL_SECONDS = 8 * 24 * 60 * 60; // ~8 days, per spec: survives a missed weekly refresh
const MIL_RECHECK_MS = 60 * 60 * 1000; // re-check KV hourly per spec
const FLIGHTS_CACHE_MS = 25 * 1000;
const FLIGHTS_KV_TTL_SECONDS = 6 * 60 * 60; // durable stale-fallback survives isolate restarts/redeploys
const FLIGHTS_KV_WRITE_INTERVAL_MS = 5 * 60 * 1000; // throttle KV writes -- see flightsKvWrittenAt below
const AIRCRAFT_CACHE_MS = 24 * 60 * 60 * 1000;
const ROUTE_CACHE_MS = 60 * 60 * 1000;
const ANALYTICS_KV_TTL = 90 * 24 * 60 * 60; // 90-day retention
const ANALYTICS_FLUSH_COUNT = 20; // flush the buffer after this many events...
const ANALYTICS_FLUSH_MS = 5 * 60 * 1000; // ...or after this long, whichever comes first
const SESSION_GAP_MS = 30 * 60 * 1000; // 30-min gap = new session
// adsb.lol asks API consumers to identify their app (contact URL) rather than
// send anonymous/generic traffic, per their fair-use policy.
const ADSB_USER_AGENT = 'SkyFrame2-Worker/1.0 (+https://tsuttonva.github.io/Skyframe2/)';
// Kept under the client's poll interval (now 30s minimum -- see
// REFRESH_OPTIONS_MS in web/index.html) on purpose: a cooldown longer than
// the poll interval means every other poll gets auto-skipped instead of
// making a real attempt, roughly doubling how long a real recovery takes
// to actually show up for the user. 25s guarantees the circuit has closed
// again by the time the next poll lands, even with some jitter.
const ADSB_COOLDOWN_MS = 25 * 1000;
// Paused Aug 27, 2026: analytics logging was a direct contributor to the
// Workers KV daily write-cap warnings (a KV read+write on every /flights
// request, even after batching). Historical data already collected is
// still readable via /analytics -- flip this back on once logging moves
// to something that doesn't compete with reliability-critical KV writes
// (e.g. Cloudflare Analytics Engine, built for high-frequency events
// without KV's tight caps). See docs/RATE_LIMITS.md.
const ANALYTICS_ENABLED = false;

// ---- module-scope in-memory caches (live for the lifetime of the isolate) ----
let milDb = { ranges: [], updated: null, loadedAt: 0 };
let milLoadPromise = null;
const flightsCache = new Map();
const aircraftCache = new Map();
const routeCache = new Map();
// Cloudflare's free Workers KV tier caps writes tightly (1,000/day) -- the
// KV stale-fallback only needs to be "pretty fresh," not literally
// per-request, so throttle writes per location to keep our footprint small.
const flightsKvWrittenAt = new Map();
// Analytics events are buffered here and flushed to KV in batches (see
// logAnalyticsEvent) instead of one KV read+write per request -- same KV
// write cap concern. A buffer lost to isolate recycling before it flushes
// is an acceptable trade for personal-scale analytics.
let analyticsBuffer = [];
let analyticsBufferKey = null;
let analyticsBufferSince = 0;
// Circuit breaker: once adsb.lol fails, stop hammering it (with retries, on
// every single poll cycle) for a cooldown window. adsb.lol rate-limits by
// source IP shared across many unrelated Cloudflare Worker tenants, and
// retrying into a sustained throttle just adds to the load keeping it from
// clearing, on top of burning a couple of wasted seconds per request.
let adsbUnhealthyUntil = 0;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders()),
  });
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function hexToInt(hex) {
  return parseInt(hex, 16);
}

// ---------------------------------------------------------------------------
// Military hex-range database
// ---------------------------------------------------------------------------

async function rebuildMilDb(env) {
  const resp = await fetch(MIL_RANGES_URL, { headers: { 'User-Agent': 'SkyFrame-Worker' } });
  if (!resp.ok) throw new Error('military range fetch failed: ' + resp.status);
  const data = await resp.json();
  const raw = (data && data.military) || [];
  const ranges = raw
    .map(function (pair) {
      return [hexToInt(pair[0]), hexToInt(pair[1])];
    })
    .filter(function (r) {
      return !isNaN(r[0]) && !isNaN(r[1]);
    })
    .sort(function (a, b) {
      return a[0] - b[0];
    });
  const record = { ranges: ranges, updated: new Date().toISOString() };
  await env.SKYFRAME2_KV.put(MIL_KV_KEY, JSON.stringify(record), {
    expirationTtl: MIL_KV_TTL_SECONDS,
  });
  milDb = { ranges: ranges, updated: record.updated, loadedAt: Date.now() };
  return milDb;
}

async function ensureMilDb(env) {
  const fresh = milDb.loadedAt && Date.now() - milDb.loadedAt < MIL_RECHECK_MS;
  if (fresh) return milDb;
  if (milLoadPromise) return milLoadPromise;

  milLoadPromise = (async function () {
    try {
      const stored = await env.SKYFRAME2_KV.get(MIL_KV_KEY);
      if (stored) {
        const record = JSON.parse(stored);
        milDb = { ranges: record.ranges || [], updated: record.updated, loadedAt: Date.now() };
        return milDb;
      }
      // Nothing in KV yet: rebuild now (first-ever deploy).
      return await rebuildMilDb(env);
    } catch (err) {
      // Don't let a military DB problem break flight responses; keep
      // whatever we had (possibly empty) and try again next request window.
      milDb = Object.assign({}, milDb, { loadedAt: Date.now() });
      return milDb;
    } finally {
      milLoadPromise = null;
    }
  })();

  return milLoadPromise;
}

function isMilitaryHex(hexInt, ranges) {
  if (isNaN(hexInt)) return false;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid];
    if (hexInt < range[0]) hi = mid - 1;
    else if (hexInt > range[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// /flights
// ---------------------------------------------------------------------------

function normalizeAdsbLol(ac, myLat, myLon, ranges) {
  const lat = ac.lat;
  const lon = ac.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  const altBaro = typeof ac.alt_baro === 'number' ? ac.alt_baro : 0;
  const vertRate = typeof ac.baro_rate === 'number' ? ac.baro_rate : (typeof ac.geom_rate === 'number' ? ac.geom_rate : 0);
  const hex = (ac.hex || '').toLowerCase();
  return {
    icao24: hex,
    callsign: (ac.flight || '').trim(),
    lat: lat,
    lon: lon,
    baro_alt: altBaro,
    velocity: typeof ac.gs === 'number' ? ac.gs : 0,
    true_track: typeof ac.track === 'number' ? ac.track : 0,
    vert_rate: vertRate,
    squawk: ac.squawk || '',
    aircraft_type: ac.t || '',
    is_military: isMilitaryHex(hexToInt(hex), ranges),
    dist_km: haversineKm(myLat, myLon, lat, lon),
  };
}

async function fetchWithRetry(upstreamUrl, backoffsMs) {
  let resp = await fetch(upstreamUrl, { headers: { 'User-Agent': ADSB_USER_AGENT } });
  for (let i = 0; !resp.ok && i < backoffsMs.length; i++) {
    await new Promise(function (resolve) { setTimeout(resolve, backoffsMs[i]); });
    resp = await fetch(upstreamUrl, { headers: { 'User-Agent': ADSB_USER_AGENT } });
  }
  return resp;
}

async function handleFlights(url, env, ctx) {
  const lat = parseFloat(url.searchParams.get('lat'));
  const lon = parseFloat(url.searchParams.get('lon'));
  const dist = parseFloat(url.searchParams.get('dist')) || 50;
  if (isNaN(lat) || isNaN(lon)) return json({ error: 'lat and lon are required' }, 400);

  const cacheKey = lat.toFixed(2) + ',' + lon.toFixed(2) + ',' + Math.round(dist);
  const kvKey = 'flights:' + cacheKey;
  const cached = flightsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < FLIGHTS_CACHE_MS) {
    return json({ aircraft: cached.aircraft, source: 'worker', cached: true });
  }

  const milDbNow = await ensureMilDb(env);
  const radiusNm = Math.max(1, Math.min(250, Math.round(dist)));
  let resp;
  if (Date.now() < adsbUnhealthyUntil) {
    // adsb.lol failed recently enough that we're in a cooldown window --
    // don't add to its load with more retries, just fall straight through to
    // cache/KV below.
    console.log('[flights] adsb.lol circuit open (until ' + new Date(adsbUnhealthyUntil).toISOString() + '), skipping key=' + cacheKey);
    resp = { ok: false, status: 429 };
  } else {
    // adsb.lol rate-limits by source IP, and Cloudflare Workers share IP
    // ranges across many unrelated tenants -- a failure here (429, or a
    // transient 5xx) is usually a brief, bursty window rather than a real
    // outage, so a couple of short retries often succeed instead of forcing
    // the client through its whole fallback cascade for a blip.
    const adsbUrl = 'https://api.adsb.lol/v2/point/' + lat + '/' + lon + '/' + radiusNm;
    resp = await fetchWithRetry(adsbUrl, [500, 1500]);
    console.log('[flights] adsb.lol status=' + resp.status + ' key=' + cacheKey);
    if (!resp.ok && !cached) {
      // No stale in-memory data to fall back to for this location -- most
      // often a first load or a just-changed location, which is the one
      // moment reliability matters most. The alternative to trying harder
      // here is a guaranteed empty/error result, so it's worth spending a
      // few more seconds (well under the client's 20s timeout) rather than
      // giving up at the same budget used for routine steady-state polling.
      console.log('[flights] no in-memory fallback, extending retry key=' + cacheKey);
      resp = await fetchWithRetry(adsbUrl, [2000, 3000]);
      console.log('[flights] adsb.lol extended-retry status=' + resp.status + ' key=' + cacheKey);
    }
    adsbUnhealthyUntil = resp.ok ? 0 : Date.now() + ADSB_COOLDOWN_MS;
  }
  if (!resp.ok) {
    // adsb.lol is still down after retries -- serve the last known-good list
    // for this location/radius rather than erroring the client into its whole
    // other-source fallback cascade for what's usually a transient rate
    // limit. Check the in-memory cache first (fastest), then fall back to
    // KV -- which survives isolate restarts/redeploys, so a freshly deployed
    // or cold-started worker still has something to serve during an outage
    // instead of hard-failing on its very first request.
    //
    // (airplanes.live was tried here too as a second upstream, but it
    // returns a hard 403 to every Cloudflare Worker request -- consistent,
    // not transient, likely their own Cloudflare bot-protection blocking
    // Workers' IP ranges outright. Retrying it never helps, so it's not
    // worth the extra round-trip.)
    console.log('[flights] adsb.lol failed key=' + cacheKey + ' memCache=' + !!cached);
    if (cached) return json({ aircraft: cached.aircraft, source: 'worker', cached: true, stale: true });
    let kvCached = null;
    try {
      kvCached = await env.SKYFRAME2_KV.get(kvKey, 'json');
    } catch (e) {
      // KV itself can fail (e.g. account hit its own daily op cap) -- treat
      // that the same as a miss rather than crashing the request into a 500.
      console.log('[flights] kv fallback read error key=' + kvKey + ' err=' + e);
    }
    console.log('[flights] kv fallback ' + (kvCached ? 'HIT' : 'MISS') + ' key=' + kvKey);
    if (kvCached) return json({ aircraft: kvCached.aircraft, source: 'worker', cached: true, stale: true });
    return json({ error: 'upstream error', status: resp.status }, 502);
  }
  const data = await resp.json();
  const list = data && data.ac ? data.ac : [];
  const aircraft = list
    .map(function (ac) {
      return normalizeAdsbLol(ac, lat, lon, milDbNow.ranges);
    })
    .filter(Boolean);

  console.log('[flights] success key=' + cacheKey + ' n=' + aircraft.length);
  flightsCache.set(cacheKey, { aircraft: aircraft, at: Date.now() });
  const lastKvWriteLocal = flightsKvWrittenAt.get(cacheKey) || 0;
  if (ctx && Date.now() - lastKvWriteLocal >= FLIGHTS_KV_WRITE_INTERVAL_MS) {
    // Local memory alone isn't enough to throttle this globally -- Cloudflare
    // Workers scale across many concurrent isolates that don't share memory,
    // so each one would otherwise "forget" that some other isolate just
    // wrote this same key seconds ago. Read the durable record first (reads
    // are capped at 100,000/day vs. 1,000 writes/day, so this trade is
    // cheap) and only write if it's actually stale too.
    flightsKvWrittenAt.set(cacheKey, Date.now());
    let shouldWrite = true;
    try {
      const existingKv = await env.SKYFRAME2_KV.get(kvKey, 'json');
      if (existingKv && existingKv.at && Date.now() - existingKv.at < FLIGHTS_KV_WRITE_INTERVAL_MS) {
        shouldWrite = false;
      }
    } catch (e) {
      // if the durable check fails, fall back to writing -- worst case is
      // one extra write, not a crash.
    }
    if (shouldWrite) {
      ctx.waitUntil(env.SKYFRAME2_KV.put(kvKey, JSON.stringify({ aircraft: aircraft, at: Date.now() }), {
        expirationTtl: FLIGHTS_KV_TTL_SECONDS,
      }));
    }
  }
  return json({ aircraft: aircraft, source: 'worker', cached: false });
}

// ---------------------------------------------------------------------------
// /aircraft (enrichment via hexdb.io — free, no key required)
// ---------------------------------------------------------------------------

async function handleAircraft(url) {
  const icao = (url.searchParams.get('icao') || '').toLowerCase().trim();
  if (!icao) return json({ error: 'icao is required' }, 400);

  const cached = aircraftCache.get(icao);
  if (cached && Date.now() - cached.at < AIRCRAFT_CACHE_MS) {
    return json(Object.assign({ cached: true }, cached.data));
  }

  try {
    const resp = await fetch('https://hexdb.io/api/v1/aircraft/' + icao, {
      headers: { 'User-Agent': 'SkyFrame-Worker' },
    });
    if (!resp.ok) return json({ icao24: icao, found: false });
    const data = await resp.json();
    const out = {
      icao24: icao,
      found: true,
      registration: data.Registration || data.registration || '',
      type: data.ICAOTypeCode || data.Type || '',
      type_name: data.Type || data.Manufacturer || '',
      manufacturer: data.Manufacturer || '',
      owner: data.RegisteredOwners || '',
    };
    aircraftCache.set(icao, { data: out, at: Date.now() });
    return json(Object.assign({ cached: false }, out));
  } catch (err) {
    return json({ icao24: icao, found: false });
  }
}

// ---------------------------------------------------------------------------
// /route (paid AeroAPI behind a hard monthly cap, with free fallback)
// ---------------------------------------------------------------------------

function monthKey() {
  const d = new Date();
  return 'usage:' + d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

async function getUsage(env) {
  const cap = parseInt(env.AEROAPI_MONTHLY_CAP || '800', 10);
  const raw = await env.SKYFRAME2_KV.get(monthKey());
  const count = raw ? parseInt(raw, 10) : 0;
  const percentage = cap > 0 ? Math.round((count / cap) * 1000) / 10 : 0;
  let status = 'OK';
  if (count >= cap) status = 'LIMIT_REACHED';
  else if (percentage >= 75) status = 'WARNING';
  return { count: count, limit: cap, remaining: Math.max(0, cap - count), percentage: percentage, status: status };
}

async function sendUsageEmail(env, subject, body) {
  if (!env.RESEND_KEY || !env.ALERT_EMAIL) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.RESEND_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'SkyFrame Alerts <onboarding@resend.dev>',
        to: [env.ALERT_EMAIL],
        subject: subject,
        text: body,
      }),
    });
  } catch (err) {
    // Email is best-effort; never let it break the request it's attached to.
  }
}

async function incrementUsageAndMaybeAlert(env) {
  const cap = parseInt(env.AEROAPI_MONTHLY_CAP || '800', 10);
  const key = monthKey();
  const raw = await env.SKYFRAME2_KV.get(key);
  const count = (raw ? parseInt(raw, 10) : 0) + 1;
  await env.SKYFRAME2_KV.put(key, String(count), { expirationTtl: 45 * 24 * 60 * 60 });

  const pct = (count / cap) * 100;
  const flagKey75 = key + ':emailed:75';
  const flagKey100 = key + ':emailed:100';

  if (pct >= 100 && !(await env.SKYFRAME2_KV.get(flagKey100))) {
    await env.SKYFRAME2_KV.put(flagKey100, '1', { expirationTtl: 45 * 24 * 60 * 60 });
    await sendUsageEmail(
      env,
      'SkyFrame: AeroAPI monthly cap reached',
      'SkyFrame has used ' + count + '/' + cap + ' AeroAPI calls this month and has hit the hard cap. ' +
        'Route lookups will now use the free fallback source until next month.'
    );
  } else if (pct >= 75 && !(await env.SKYFRAME2_KV.get(flagKey75))) {
    await env.SKYFRAME2_KV.put(flagKey75, '1', { expirationTtl: 45 * 24 * 60 * 60 });
    await sendUsageEmail(
      env,
      'SkyFrame: AeroAPI usage at 75%',
      'SkyFrame has used ' + count + '/' + cap + ' AeroAPI calls this month (75%+). ' +
        'It will automatically switch to the free fallback once the cap is reached.'
    );
  }

  return count;
}

// AeroAPI's /flights/{ident} returns every flight under that ident -- past,
// scheduled, and future -- not just the one currently in the air. Idents are
// frequently reused (e.g. a charter doing the same round-trip repeatedly), so
// flights[0] can easily be the wrong leg. Prefer whichever flight is actually
// airborne right now, falling back to one whose scheduled window contains
// the current time, and only defaulting to flights[0] if nothing matches.
function pickCurrentFlight(flights) {
  if (!flights || !flights.length) return null;
  var airborne = flights.find(function (f) { return f.actual_off && !f.actual_on; });
  if (airborne) return airborne;
  var now = Date.now();
  var inWindow = flights.find(function (f) {
    var off = f.actual_off || f.scheduled_off || f.estimated_off;
    var on = f.actual_on || f.estimated_on || f.scheduled_on;
    if (!off || !on) return false;
    var offTime = new Date(off).getTime();
    var onTime = new Date(on).getTime();
    return offTime <= now && now <= onTime;
  });
  if (inWindow) return inWindow;
  return flights[0];
}

// When a flight diverts, AeroAPI represents it as two legs sharing the same
// fa_flight_id -- the originally-filed leg (destination = filed plan) and a
// second leg whose destination is wherever it actually headed instead. Both
// legs come back in the same /flights/{ident} response we already fetched,
// so finding the diverted-to airport costs zero extra AeroAPI calls (each
// of which eats into the hard monthly cap).
function findDivertedDestination(flights, flight) {
  if (!flight.fa_flight_id) return null;
  const sibling = flights.find(function (f) {
    return f !== flight && f.fa_flight_id === flight.fa_flight_id &&
      f.destination && f.destination.code &&
      f.destination.code !== (flight.destination && flight.destination.code);
  });
  if (!sibling) return null;
  const d = sibling.destination;
  return { code: d.code || '', name: d.name || '', city: d.city || '' };
}

async function paidRouteLookup(callsign, env) {
  const resp = await fetch('https://aeroapi.flightaware.com/aeroapi/flights/' + encodeURIComponent(callsign) + '?max_pages=1', {
    headers: { 'x-apikey': env.FLIGHTAWARE_KEY },
  });
  if (!resp.ok) throw new Error('aeroapi error ' + resp.status);
  const data = await resp.json();
  const flights = (data && data.flights) || [];
  const flight = pickCurrentFlight(flights);
  if (!flight) return null;
  const origin = flight.origin || {};
  const dest = flight.destination || {};
  const diverted = !!flight.diverted;
  return {
    source: 'aeroapi',
    origin: { code: origin.code || '', name: origin.name || '', city: origin.city || '' },
    destination: { code: dest.code || '', name: dest.name || '', city: dest.city || '' },
    status: flight.status || '',
    departedAt: flight.actual_off || flight.scheduled_off || null,
    diverted: diverted,
    divertedTo: diverted ? findDivertedDestination(flights, flight) : null,
  };
}

async function freeRouteLookup(callsign, lat, lon) {
  const resp = await fetch('https://api.adsb.lol/api/0/routeset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planes: [{ callsign: callsign, lat: lat || 0, lng: lon || 0 }] }),
  });
  if (!resp.ok) throw new Error('routeset error ' + resp.status);
  const data = await resp.json();
  const entry = data && data[0];
  if (!entry || !entry._airport_codes_iata) return null;
  const airports = entry._airports || [];
  const origin = airports[0] || {};
  const dest = airports[airports.length - 1] || {};
  return {
    source: 'free',
    origin: { code: origin.icao || origin.iata || '', name: origin.name || '', city: origin.location || '' },
    destination: { code: dest.icao || dest.iata || '', name: dest.name || '', city: dest.location || '' },
    status: '',
  };
}

async function handleRoute(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const callsign = (body.callsign || '').trim();
  if (!callsign) return json({ error: 'callsign is required' }, 400);

  const cached = routeCache.get(callsign);
  if (cached && Date.now() - cached.at < ROUTE_CACHE_MS) {
    return json(Object.assign({ cached: true }, cached.data));
  }

  const usage = await getUsage(env);
  let result = null;
  let usedPaid = false;

  if (usage.status !== 'LIMIT_REACHED' && env.FLIGHTAWARE_KEY) {
    try {
      result = await paidRouteLookup(callsign, env);
      usedPaid = true;
    } catch (err) {
      result = null;
    }
  }

  if (!result) {
    try {
      result = await freeRouteLookup(callsign, body.lat, body.lon);
    } catch (err) {
      result = null;
    }
  }

  if (usedPaid && result) {
    await incrementUsageAndMaybeAlert(env);
  }

  if (!result) {
    result = { source: 'none', origin: null, destination: null, status: '' };
  }

  routeCache.set(callsign, { data: result, at: Date.now() });
  return json(Object.assign({ cached: false }, result));
}

// ---------------------------------------------------------------------------
// /weather (nearest METAR via aviationweather.gov -- free, unlimited, no key)
// ---------------------------------------------------------------------------

const WEATHER_CACHE_MS = 10 * 60 * 1000;
const weatherCache = new Map();

// AviationWeather.gov's classic ADDS-style METAR XML schema has been stable
// for well over a decade and is far more predictable than the newer JSON
// endpoint (whose field names have shifted between releases), so we parse
// the flat <tag>value</tag> structure directly rather than adding an XML
// parser dependency.
function parseMetarXml(xml) {
  const out = [];
  const blocks = xml.split('<METAR>').slice(1);
  for (let i = 0; i < blocks.length; i++) {
    const body = blocks[i].split('</METAR>')[0];
    const tag = function (name) {
      const m = body.match(new RegExp('<' + name + '>([^<]*)</' + name + '>'));
      return m ? m[1] : null;
    };
    const lat = parseFloat(tag('latitude'));
    const lon = parseFloat(tag('longitude'));
    if (isNaN(lat) || isNaN(lon)) continue;
    const clouds = [];
    const skyRe = /<sky_condition sky_cover="([^"]*)"(?:\s+cloud_base_ft_agl="([^"]*)")?/g;
    let m;
    while ((m = skyRe.exec(body))) {
      clouds.push({ cover: m[1], base: m[2] ? parseInt(m[2], 10) : null });
    }
    const temp = parseFloat(tag('temp_c'));
    const dewp = parseFloat(tag('dewpoint_c'));
    const wdir = parseInt(tag('wind_dir_degrees'), 10);
    const wspd = parseInt(tag('wind_speed_kt'), 10);
    const wgst = parseInt(tag('wind_gust_kt'), 10);
    const altim = parseFloat(tag('altim_in_hg'));
    out.push({
      stationId: tag('station_id'),
      rawText: tag('raw_text'),
      observationTime: tag('observation_time'),
      lat: lat,
      lon: lon,
      tempC: isNaN(temp) ? null : temp,
      dewpointC: isNaN(dewp) ? null : dewp,
      windDirDeg: isNaN(wdir) ? null : wdir,
      windSpeedKt: isNaN(wspd) ? null : wspd,
      windGustKt: isNaN(wgst) ? null : wgst,
      visibilityMi: tag('visibility_statute_mi'),
      altimIn: isNaN(altim) ? null : altim,
      flightCategory: tag('flight_category'),
      wxString: tag('wx_string'),
      clouds: clouds,
    });
  }
  return out;
}

async function handleWeather(url) {
  const lat = parseFloat(url.searchParams.get('lat'));
  const lon = parseFloat(url.searchParams.get('lon'));
  if (isNaN(lat) || isNaN(lon)) return json({ error: 'lat and lon are required' }, 400);

  const cacheKey = lat.toFixed(2) + ',' + lon.toFixed(2);
  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.at < WEATHER_CACHE_MS) {
    return json(Object.assign({ cached: true }, cached.data));
  }

  // ~1 degree of latitude is ~60nm; widen the box generously since stations
  // (especially towered/ASOS fields) can be sparse in rural areas, and we
  // re-rank by actual distance below rather than trusting bbox proximity.
  const margin = 1.0;
  const bbox = (lat - margin) + ',' + (lon - margin) + ',' + (lat + margin) + ',' + (lon + margin);
  const resp = await fetch('https://aviationweather.gov/api/data/metar?format=xml&bbox=' + bbox, {
    headers: { 'User-Agent': 'SkyFrame-Worker' },
  });
  if (!resp.ok) return json({ error: 'upstream error', status: resp.status }, 502);
  const xml = await resp.text();
  const stations = parseMetarXml(xml);

  let result;
  if (!stations.length) {
    result = { station: null, distanceNm: null };
  } else {
    let nearest = stations[0];
    let nearestKm = haversineKm(lat, lon, nearest.lat, nearest.lon);
    for (let i = 1; i < stations.length; i++) {
      const d = haversineKm(lat, lon, stations[i].lat, stations[i].lon);
      if (d < nearestKm) { nearest = stations[i]; nearestKm = d; }
    }
    result = { station: nearest, distanceNm: Math.round((nearestKm / 1.852) * 10) / 10 };
  }

  weatherCache.set(cacheKey, { data: result, at: Date.now() });
  return json(Object.assign({ cached: false }, result));
}

// ---------------------------------------------------------------------------
// /health, /usage, /refresh-mil-db
// ---------------------------------------------------------------------------

async function handleHealth(env) {
  const usage = await getUsage(env);
  const milDbNow = await ensureMilDb(env);
  return json({
    version: env.APP_VERSION || APP_VERSION_FALLBACK,
    timestamp: new Date().toISOString(),
    usage: usage,
    military: { size: milDbNow.ranges.length, updated: milDbNow.updated },
  });
}

async function handleUsage(env) {
  return json(await getUsage(env));
}

async function handleRefreshMilDb(env) {
  const result = await rebuildMilDb(env);
  return json({ ok: true, size: result.ranges.length, updated: result.updated });
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

async function hashIP(ip) {
  const data = new TextEncoder().encode(ip + ':sf2salt');
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).slice(0, 4)
    .map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

function classifyUA(ua) {
  if (/iPhone|iPad|watchOS/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'windows';
  return 'other';
}

function analyticsHourKey() {
  const now = new Date();
  return 'analytics:' + now.toISOString().slice(0, 10) + ':' +
    String(now.getUTCHours()).padStart(2, '0');
}

async function flushAnalyticsBuffer(env) {
  if (!analyticsBuffer.length || !analyticsBufferKey) return;
  const key = analyticsBufferKey;
  const toWrite = analyticsBuffer;
  analyticsBuffer = [];
  analyticsBufferSince = Date.now();
  const existing = (await env.SKYFRAME2_KV.get(key, 'json')) || [];
  existing.push.apply(existing, toWrite);
  await env.SKYFRAME2_KV.put(key, JSON.stringify(existing), {
    expirationTtl: ANALYTICS_KV_TTL,
  });
}

async function logAnalyticsEvent(request, env, opts) {
  try {
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const cf = request.cf || {};
    const ipHash = await hashIP(ip);
    const event = {
      ts: Date.now(),
      h: ipHash,
      country: cf.country || null,
      region: cf.region || null,
      city: cf.city || null,
      ua: classifyUA(request.headers.get('User-Agent') || ''),
      radius: opts && opts.radius ? Math.round(opts.radius) : null,
    };
    const key = analyticsHourKey();
    if (key !== analyticsBufferKey) {
      // Hour rolled over -- flush whatever's buffered under the old key
      // first so it doesn't get merged into the wrong hour's bucket.
      await flushAnalyticsBuffer(env);
      analyticsBufferKey = key;
      analyticsBufferSince = Date.now();
    }
    analyticsBuffer.push(event);
    const dueForFlush = analyticsBuffer.length >= ANALYTICS_FLUSH_COUNT ||
      Date.now() - analyticsBufferSince >= ANALYTICS_FLUSH_MS;
    if (dueForFlush) await flushAnalyticsBuffer(env);
  } catch (e) {
    // never break the main request path
  }
}

function buildDateHourKeys(days) {
  const keys = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const day = d.toISOString().slice(0, 10);
    for (let h = 0; h < 24; h++) {
      keys.push('analytics:' + day + ':' + String(h).padStart(2, '0'));
    }
  }
  return keys;
}

async function handleAnalytics(url, env) {
  const reqKey = url.searchParams.get('key') || '';
  if (!env.ANALYTICS_KEY || reqKey !== env.ANALYTICS_KEY) {
    return json({ error: 'unauthorized' }, 401);
  }

  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') || '7', 10)));
  const hourKeys = buildDateHourKeys(days);

  // Fetch in batches of 24 (one day) to avoid hammering KV
  const allEvents = [];
  for (let i = 0; i < hourKeys.length; i += 24) {
    const batch = hourKeys.slice(i, i + 24);
    const results = await Promise.all(batch.map(function (k) {
      return env.SKYFRAME2_KV.get(k, 'json').then(function (v) { return v || []; });
    }));
    results.forEach(function (arr) { allEvents.push.apply(allEvents, arr); });
  }

  if (!allEvents.length) {
    return json({ days: days, totalRequests: 0, uniqueUsers: 0, message: 'No analytics data yet — start making /flights requests to populate.' });
  }

  allEvents.sort(function (a, b) { return a.ts - b.ts; });

  // Unique users by hashed IP
  const uniqueHashes = new Set(allEvents.map(function (e) { return e.h; }));

  // Session analysis: group timestamps by hash, split on SESSION_GAP_MS
  const byHash = {};
  allEvents.forEach(function (e) {
    if (!byHash[e.h]) byHash[e.h] = [];
    byHash[e.h].push(e.ts);
  });

  const sessions = [];
  Object.keys(byHash).forEach(function (hash) {
    const tss = byHash[hash].sort(function (a, b) { return a - b; });
    let start = tss[0];
    let last = tss[0];
    let count = 1;
    for (let i = 1; i < tss.length; i++) {
      if (tss[i] - last > SESSION_GAP_MS) {
        sessions.push({ durationMin: Math.round((last - start) / 60000), requests: count });
        start = tss[i];
        count = 0;
      }
      last = tss[i];
      count++;
    }
    sessions.push({ durationMin: Math.round((last - start) / 60000), requests: count });
  });

  const avgSessionMin = sessions.length
    ? Math.round(sessions.reduce(function (s, x) { return s + x.durationMin; }, 0) / sessions.length * 10) / 10
    : 0;

  // Per-day breakdown
  const byDay = {};
  const byDayUsers = {};
  allEvents.forEach(function (e) {
    const day = new Date(e.ts).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
    if (!byDayUsers[day]) byDayUsers[day] = new Set();
    byDayUsers[day].add(e.h);
  });
  const dailyStats = Object.keys(byDay).sort().reverse().map(function (day) {
    return { date: day, requests: byDay[day], uniqueUsers: byDayUsers[day].size };
  });

  // Top locations (city, state)
  const locationCounts = {};
  allEvents.forEach(function (e) {
    const parts = [e.city, e.region, e.country].filter(Boolean);
    if (!parts.length) return;
    const loc = parts.join(', ');
    locationCounts[loc] = (locationCounts[loc] || 0) + 1;
  });
  const topLocations = Object.entries(locationCounts)
    .sort(function (a, b) { return b[1] - a[1]; })
    .slice(0, 15)
    .map(function (pair) { return { location: pair[0], requests: pair[1] }; });

  // Device breakdown
  const devices = {};
  allEvents.forEach(function (e) {
    const ua = e.ua || 'other';
    devices[ua] = (devices[ua] || 0) + 1;
  });

  return json({
    days: days,
    totalRequests: allEvents.length,
    uniqueUsers: uniqueHashes.size,
    totalSessions: sessions.length,
    avgSessionDurationMin: avgSessionMin,
    dailyStats: dailyStats,
    topLocations: topLocations,
    devices: devices,
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    const url = new URL(request.url);
    try {
      if (url.pathname === '/flights' && request.method === 'GET') {
        const resp = await handleFlights(url, env, ctx);
        if (ANALYTICS_ENABLED) {
          const radius = parseFloat(url.searchParams.get('dist')) || 50;
          ctx.waitUntil(logAnalyticsEvent(request, env, { radius: radius }));
        }
        return resp;
      }
      if (url.pathname === '/aircraft' && request.method === 'GET') return await handleAircraft(url);
      if (url.pathname === '/route' && request.method === 'POST') return await handleRoute(request, env);
      if (url.pathname === '/weather' && request.method === 'GET') return await handleWeather(url);
      if (url.pathname === '/health' && request.method === 'GET') return await handleHealth(env);
      if (url.pathname === '/usage' && request.method === 'GET') return await handleUsage(env);
      if (url.pathname === '/refresh-mil-db') return await handleRefreshMilDb(env);
      if (url.pathname === '/analytics' && request.method === 'GET') return await handleAnalytics(url, env);
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: 'internal error', message: String(err && err.message ? err.message : err) }, 500);
    }
  },

  async scheduled(event, env) {
    await rebuildMilDb(env);
  },
};
