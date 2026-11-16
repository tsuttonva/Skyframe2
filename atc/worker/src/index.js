// ATC Explorer back end: accounts, private saved scenarios, and read-only share links.
//
// Storage (Cloudflare KV, binding ATC_KV). Read docs/RATE_LIMITS.md before changing
// anything here: KV's free tier allows 1,000 writes/day per ACCOUNT, shared with
// SkyFrame. The design rule is therefore: reads never write, and each user action
// costs at most 2 writes.
//
//   cfg:secret            HMAC key for session tokens (generated once, on first use)
//   cfg:signups:<date>    count of accounts created that UTC day (caps signup abuse)
//   user:<name>           { salt, hash, iter, created }
//   scn:<name>            { day, writes, items: [scenario...] }   all of one user's scenarios in ONE key
//   share:<token>         { u, id, created, snapshot }
//
// Sessions are stateless signed tokens, so signing in costs zero KV writes.

const PBKDF2_ITER = 100000;          // Workers' WebCrypto maximum
const SESSION_DAYS = 30;
const MAX_SIGNUPS_PER_DAY = 25;      // across everyone
const MAX_SCENARIOS = 50;            // per user
const MAX_WRITES_PER_USER_DAY = 150; // scenario saves/shares per user per UTC day
const MAX_SETTINGS_BYTES = 8000;
const MAX_NAME = 80;

const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const rand = n => b64u(crypto.getRandomValues(new Uint8Array(n)));
const today = () => new Date().toISOString().slice(0, 10);

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (status, msg) => { throw new HttpError(status, msg); };

function cors(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const h = { 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' };
  if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
const json = (data, status, headers) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

async function pbkdf2(password, saltBytes, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return b64u(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: iter }, key, 256));
}
// Constant-time string compare.
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

let secretCache = null; // per-isolate
async function hmacKey(env) {
  if (!secretCache) {
    let s = await env.ATC_KV.get('cfg:secret');
    if (!s) { s = rand(32); await env.ATC_KV.put('cfg:secret', s); s = (await env.ATC_KV.get('cfg:secret')) || s; }
    secretCache = await crypto.subtle.importKey('raw', enc.encode(s), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  }
  return secretCache;
}
async function sign(env, payload) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  return body + '.' + b64u(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body)));
}
async function verify(env, token) {
  const [body, sig] = (token || '').split('.');
  if (!body || !sig) return null;
  const expect = b64u(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body)));
  if (!same(sig, expect)) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(unb64u(body)));
    return (p && p.u && p.exp > Date.now()) ? p : null;
  } catch { return null; }
}
const newSession = (env, u, pw) => sign(env, { u, pw, exp: Date.now() + SESSION_DAYS * 864e5 });

const normUser = name => {
  const u = String(name || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,23}$/.test(u)) bad(400, 'Username must be 3-24 characters: letters, numbers, dot, dash or underscore.');
  return u;
};
const checkPassword = p => { if (typeof p !== 'string' || p.length < 8 || p.length > 200) bad(400, 'Password must be at least 8 characters.'); return p; };

async function body(request) {
  const text = await request.text();
  if (text.length > 20000) bad(413, 'Request too large.');
  try { return JSON.parse(text || '{}'); } catch { bad(400, 'Invalid JSON.'); }
}

/** Resolve the signed-in user or throw 401. `pw` ties a token to the password it was issued under. */
async function auth(request, env) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer (.+)$/);
  const p = m && await verify(env, m[1]);
  if (!p) bad(401, 'Please sign in again.');
  const user = await env.ATC_KV.get('user:' + p.u, 'json');
  if (!user || user.salt.slice(0, 8) !== p.pw) bad(401, 'Please sign in again.');
  return p.u;
}

const loadDoc = async (env, u) => (await env.ATC_KV.get('scn:' + u, 'json')) || { day: today(), writes: 0, items: [] };
async function saveDoc(env, u, doc) {
  if (doc.day !== today()) { doc.day = today(); doc.writes = 0; }
  if (doc.writes >= MAX_WRITES_PER_USER_DAY) bad(429, 'Daily save limit reached. Try again tomorrow.');
  doc.writes++;
  await env.ATC_KV.put('scn:' + u, JSON.stringify(doc));
}
const publicItems = doc => doc.items.map(({ id, name, settings, created, updated, share }) => ({ id, name, settings, created, updated, share: share || null }));

function cleanScenario(b) {
  const name = String(b.name || '').trim().slice(0, MAX_NAME);
  if (!name) bad(400, 'Give the scenario a name.');
  if (!b.settings || typeof b.settings !== 'object' || Array.isArray(b.settings)) bad(400, 'Missing settings.');
  if (JSON.stringify(b.settings).length > MAX_SETTINGS_BYTES) bad(413, 'Scenario settings are too large.');
  return { name, settings: b.settings };
}
const snapshotDate = v => (typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v)) ? v : null;

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;
  const kv = env.ATC_KV;

  if (path === '/health' && method === 'GET') return { ok: true, service: 'atc-explorer' };

  if (path === '/signup' && method === 'POST') {
    const b = await body(request);
    const u = normUser(b.username), password = checkPassword(b.password);
    if (await kv.get('user:' + u)) bad(409, 'That username is taken.');
    const dayKey = 'cfg:signups:' + today();
    const n = Number(await kv.get(dayKey)) || 0;
    if (n >= MAX_SIGNUPS_PER_DAY) bad(429, 'Too many new accounts today. Try again tomorrow.');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const user = { salt: b64u(salt), hash: await pbkdf2(password, salt, PBKDF2_ITER), iter: PBKDF2_ITER, created: new Date().toISOString() };
    await kv.put('user:' + u, JSON.stringify(user));
    await kv.put(dayKey, String(n + 1), { expirationTtl: 3 * 86400 });
    return { username: u, token: await newSession(env, u, user.salt.slice(0, 8)), scenarios: [] };
  }

  if (path === '/login' && method === 'POST') {
    const b = await body(request);
    const u = normUser(b.username);
    const user = await kv.get('user:' + u, 'json');
    // Always run the KDF so a missing user and a wrong password take the same time.
    const salt = user ? unb64u(user.salt) : new Uint8Array(16);
    const hash = await pbkdf2(String(b.password || ''), salt, user ? user.iter : PBKDF2_ITER);
    if (!user || !same(hash, user.hash)) bad(401, 'Wrong username or password.');
    return { username: u, token: await newSession(env, u, user.salt.slice(0, 8)), scenarios: publicItems(await loadDoc(env, u)) };
  }

  if (path === '/password' && method === 'POST') {
    const u = await auth(request, env);
    const b = await body(request);
    const user = await kv.get('user:' + u, 'json');
    if (!same(await pbkdf2(String(b.current || ''), unb64u(user.salt), user.iter), user.hash)) bad(401, 'Current password is wrong.');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const next = { ...user, salt: b64u(salt), hash: await pbkdf2(checkPassword(b.password), salt, PBKDF2_ITER), iter: PBKDF2_ITER };
    await kv.put('user:' + u, JSON.stringify(next)); // new salt invalidates every older session
    return { username: u, token: await newSession(env, u, next.salt.slice(0, 8)) };
  }

  if (path === '/scenarios' && method === 'GET') {
    const u = await auth(request, env);
    return { username: u, scenarios: publicItems(await loadDoc(env, u)) };
  }

  if (path === '/scenarios' && method === 'POST') {
    const u = await auth(request, env);
    const s = cleanScenario(await body(request));
    const doc = await loadDoc(env, u);
    if (doc.items.length >= MAX_SCENARIOS) bad(400, `You can keep up to ${MAX_SCENARIOS} scenarios. Delete one first.`);
    const now = new Date().toISOString();
    const item = { id: rand(9), ...s, created: now, updated: now };
    doc.items.push(item);
    await saveDoc(env, u, doc);
    return { id: item.id, scenarios: publicItems(doc) };
  }

  const m = path.match(/^\/scenarios\/([\w-]{6,40})(\/share)?$/);
  if (m) {
    const u = await auth(request, env);
    const doc = await loadDoc(env, u);
    const item = doc.items.find(i => i.id === m[1]);
    if (!item) bad(404, 'Scenario not found.');
    if (!m[2] && method === 'PUT') {
      Object.assign(item, cleanScenario(await body(request)), { updated: new Date().toISOString() });
      await saveDoc(env, u, doc);
      return { id: item.id, scenarios: publicItems(doc) };
    }
    if (!m[2] && method === 'DELETE') {
      doc.items = doc.items.filter(i => i !== item);
      await saveDoc(env, u, doc);
      if (item.share) await kv.delete('share:' + item.share.token);
      return { scenarios: publicItems(doc) };
    }
    if (m[2] && method === 'POST') { // create (or return the existing) share link
      if (!item.share) {
        const b = await body(request);
        item.share = { token: rand(18), created: new Date().toISOString(), snapshot: snapshotDate(b.snapshot) };
        await saveDoc(env, u, doc);
        await kv.put('share:' + item.share.token, JSON.stringify({ u, id: item.id, created: item.share.created, snapshot: item.share.snapshot }));
      }
      return { id: item.id, share: item.share, scenarios: publicItems(doc) };
    }
    if (m[2] && method === 'DELETE') { // revoke
      if (item.share) {
        const token = item.share.token;
        delete item.share;
        await saveDoc(env, u, doc);
        await kv.delete('share:' + token);
      }
      return { id: item.id, scenarios: publicItems(doc) };
    }
  }

  // Public, read-only view of a shared scenario. The token is the only credential.
  const sm = path.match(/^\/s\/([\w-]{16,40})$/);
  if (sm && method === 'GET') {
    const share = await kv.get('share:' + sm[1], 'json');
    const item = share && (await loadDoc(env, share.u)).items.find(i => i.id === share.id);
    // Compare tokens too: a revoked-then-reshared scenario must not honor the old link
    // while KV's eventually-consistent delete is still propagating.
    if (!item || !item.share || item.share.token !== sm[1]) bad(404, 'This share link does not exist or was revoked.');
    return { name: item.name, owner: share.u, settings: item.settings, updated: item.updated, shared: share.created, snapshot: share.snapshot };
  }

  bad(404, 'Not found.');
}

export default {
  async fetch(request, env) {
    const headers = cors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    try {
      return json(await route(request, env), 200, headers);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, headers);
      console.error(e && e.stack || e);
      return json({ error: 'Server error.' }, 500, headers);
    }
  },
};
