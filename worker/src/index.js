/*
 * SkyFrame Worker — serverless proxy between the static frontend and the
 * upstream flight-data / route / enrichment providers.
 *
 * Endpoints:
 *   GET  /flights?lat=&lon=&dist=   nearby aircraft, military-tagged, 25s cache
 *   GET  /aircraft?icao=            type/registration/description, 24h cache
 *   POST /route                     {callsign} -> origin/destination, 1h cache,
 *                                    paid API behind a hard monthly cap
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
const AIRCRAFT_CACHE_MS = 24 * 60 * 60 * 1000;
const ROUTE_CACHE_MS = 60 * 60 * 1000;

// ---- module-scope in-memory caches (live for the lifetime of the isolate) ----
let milDb = { ranges: [], updated: null, loadedAt: 0 };
let milLoadPromise = null;
const flightsCache = new Map();
const aircraftCache = new Map();
const routeCache = new Map();

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
  await env.SKYFRAME_KV.put(MIL_KV_KEY, JSON.stringify(record), {
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
      const stored = await env.SKYFRAME_KV.get(MIL_KV_KEY);
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

async function handleFlights(url, env) {
  const lat = parseFloat(url.searchParams.get('lat'));
  const lon = parseFloat(url.searchParams.get('lon'));
  const dist = parseFloat(url.searchParams.get('dist')) || 50;
  if (isNaN(lat) || isNaN(lon)) return json({ error: 'lat and lon are required' }, 400);

  const cacheKey = lat.toFixed(2) + ',' + lon.toFixed(2) + ',' + Math.round(dist);
  const cached = flightsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < FLIGHTS_CACHE_MS) {
    return json({ aircraft: cached.aircraft, source: 'worker', cached: true });
  }

  const milDbNow = await ensureMilDb(env);
  const radiusNm = Math.max(1, Math.min(250, Math.round(dist)));
  const upstreamUrl = 'https://api.adsb.lol/v2/point/' + lat + '/' + lon + '/' + radiusNm;
  const resp = await fetch(upstreamUrl, { headers: { 'User-Agent': 'SkyFrame-Worker' } });
  if (!resp.ok) return json({ error: 'upstream error', status: resp.status }, 502);
  const data = await resp.json();
  const list = data && data.ac ? data.ac : [];
  const aircraft = list
    .map(function (ac) {
      return normalizeAdsbLol(ac, lat, lon, milDbNow.ranges);
    })
    .filter(Boolean);

  flightsCache.set(cacheKey, { aircraft: aircraft, at: Date.now() });
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
  const raw = await env.SKYFRAME_KV.get(monthKey());
  const count = raw ? parseInt(raw, 10) : 0;
  const percentage = cap > 0 ? Math.round((count / cap) * 1000) / 10 : 0;
  let status = 'OK';
  if (count >= cap) status = 'LIMIT_REACHED';
  else if (percentage >= 75) status = 'WARNING';
  return { count: count, limit: cap, remaining: Math.max(0, cap - count), percentage: percentage, status: status };
}

async function sendUsageEmail(env, subject, body) {
  if (!env.RESEND_API_KEY || !env.ALERT_EMAIL) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.RESEND_API_KEY,
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
  const raw = await env.SKYFRAME_KV.get(key);
  const count = (raw ? parseInt(raw, 10) : 0) + 1;
  await env.SKYFRAME_KV.put(key, String(count), { expirationTtl: 45 * 24 * 60 * 60 });

  const pct = (count / cap) * 100;
  const flagKey75 = key + ':emailed:75';
  const flagKey100 = key + ':emailed:100';

  if (pct >= 100 && !(await env.SKYFRAME_KV.get(flagKey100))) {
    await env.SKYFRAME_KV.put(flagKey100, '1', { expirationTtl: 45 * 24 * 60 * 60 });
    await sendUsageEmail(
      env,
      'SkyFrame: AeroAPI monthly cap reached',
      'SkyFrame has used ' + count + '/' + cap + ' AeroAPI calls this month and has hit the hard cap. ' +
        'Route lookups will now use the free fallback source until next month.'
    );
  } else if (pct >= 75 && !(await env.SKYFRAME_KV.get(flagKey75))) {
    await env.SKYFRAME_KV.put(flagKey75, '1', { expirationTtl: 45 * 24 * 60 * 60 });
    await sendUsageEmail(
      env,
      'SkyFrame: AeroAPI usage at 75%',
      'SkyFrame has used ' + count + '/' + cap + ' AeroAPI calls this month (75%+). ' +
        'It will automatically switch to the free fallback once the cap is reached.'
    );
  }

  return count;
}

async function paidRouteLookup(callsign, env) {
  const resp = await fetch('https://aeroapi.flightaware.com/aeroapi/flights/' + encodeURIComponent(callsign) + '?max_pages=1', {
    headers: { 'x-apikey': env.AEROAPI_KEY },
  });
  if (!resp.ok) throw new Error('aeroapi error ' + resp.status);
  const data = await resp.json();
  const flight = data && data.flights && data.flights[0];
  if (!flight) return null;
  const origin = flight.origin || {};
  const dest = flight.destination || {};
  return {
    source: 'aeroapi',
    origin: { code: origin.code || '', name: origin.name || '', city: origin.city || '' },
    destination: { code: dest.code || '', name: dest.name || '', city: dest.city || '' },
    status: flight.status || '',
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

  if (usage.status !== 'LIMIT_REACHED' && env.AEROAPI_KEY) {
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
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    const url = new URL(request.url);
    try {
      if (url.pathname === '/flights' && request.method === 'GET') return await handleFlights(url, env);
      if (url.pathname === '/aircraft' && request.method === 'GET') return await handleAircraft(url);
      if (url.pathname === '/route' && request.method === 'POST') return await handleRoute(request, env);
      if (url.pathname === '/health' && request.method === 'GET') return await handleHealth(env);
      if (url.pathname === '/usage' && request.method === 'GET') return await handleUsage(env);
      if (url.pathname === '/refresh-mil-db') return await handleRefreshMilDb(env);
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: 'internal error', message: String(err && err.message ? err.message : err) }, 500);
    }
  },

  async scheduled(event, env) {
    await rebuildMilDb(env);
  },
};
