// Privacy and sharing rules for the scenarios Worker, run against an in-memory KV.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';

function fakeKV() {
  const m = new Map(); const stats = { puts: 0 };
  return { m, stats,
    async get(k, type) { const v = m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { stats.puts++; m.set(k, String(v)); },
    async delete(k) { m.delete(k); } };
}
const ORIGIN = 'https://tsuttonva.github.io';
function client() {
  const env = { ATC_KV: fakeKV(), ALLOWED_ORIGINS: ORIGIN };
  const call = async (method, path, body, token, origin = ORIGIN) => {
    const res = await worker.fetch(new Request('https://api.test' + path, { method,
      headers: { Origin: origin, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined }), env);
    return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
  };
  return { env, call };
}
const settings = { v: 1, weights: { pay: 100 } };

test('accounts: signup, duplicate, wrong password, login', async () => {
  const { call } = client();
  assert.equal((await call('POST', '/signup', { username: 'ab', password: 'longenough' })).status, 400);
  assert.equal((await call('POST', '/signup', { username: 'tom', password: 'short' })).status, 400);
  const up = await call('POST', '/signup', { username: 'Tom', password: 'correct horse' });
  assert.equal(up.status, 200); assert.equal(up.data.username, 'tom');
  assert.equal((await call('POST', '/signup', { username: 'tom', password: 'another pass' })).status, 409);
  assert.equal((await call('POST', '/login', { username: 'tom', password: 'wrong horse' })).status, 401);
  assert.equal((await call('POST', '/login', { username: 'nobody', password: 'wrong horse' })).status, 401);
  assert.equal((await call('POST', '/login', { username: 'tom', password: 'correct horse' })).status, 200);
});

test('passwords are never stored in the clear', async () => {
  const { call, env } = client();
  await call('POST', '/signup', { username: 'tom', password: 'correct horse' });
  assert.ok(![...env.ATC_KV.m.values()].some(v => v.includes('correct horse')));
});

test('scenarios are private by default: no token, a bad token, or another user cannot read them', async () => {
  const { call } = client();
  const tom = (await call('POST', '/signup', { username: 'tom', password: 'correct horse' })).data.token;
  const jos = (await call('POST', '/signup', { username: 'joslyn', password: 'battery staple' })).data.token;
  const made = await call('POST', '/scenarios', { name: 'Close to home', settings }, tom);
  assert.equal(made.status, 200);
  const id = made.data.id;
  assert.equal((await call('GET', '/scenarios')).status, 401);
  assert.equal((await call('GET', '/scenarios', null, tom + 'x')).status, 401);
  const forged = tom.split('.')[0].replace(/^./, 'f') + '.' + tom.split('.')[1];
  assert.equal((await call('GET', '/scenarios', null, forged)).status, 401);
  assert.deepEqual((await call('GET', '/scenarios', null, jos)).data.scenarios, []);
  assert.equal((await call('PUT', `/scenarios/${id}`, { name: 'x', settings }, jos)).status, 404);
  assert.equal((await call('DELETE', `/scenarios/${id}`, null, jos)).status, 404);
  assert.equal((await call('POST', `/scenarios/${id}/share`, {}, jos)).status, 404);
  assert.equal((await call('GET', '/scenarios', null, tom)).data.scenarios.length, 1);
});

test('share links: read-only, show the latest saved settings, revocable', async () => {
  const { call } = client();
  const tom = (await call('POST', '/signup', { username: 'tom', password: 'correct horse' })).data.token;
  const id = (await call('POST', '/scenarios', { name: 'Close to home', settings }, tom)).data.id;
  await call('POST', '/scenarios', { name: 'Secret other', settings }, tom);
  const sh = await call('POST', `/scenarios/${id}/share`, { snapshot: '2026-11-16' }, tom);
  const token = sh.data.share.token;
  assert.ok(token.length >= 20);
  assert.equal((await call('POST', `/scenarios/${id}/share`, {}, tom)).data.share.token, token); // idempotent
  const view = await call('GET', '/s/' + token);
  assert.equal(view.status, 200);
  assert.deepEqual(Object.keys(view.data).sort(), ['name', 'owner', 'settings', 'shared', 'snapshot', 'updated']);
  assert.equal(view.data.name, 'Close to home'); assert.equal(view.data.snapshot, '2026-11-16');
  assert.ok(!JSON.stringify(view.data).includes('Secret other'));
  // no write verbs on a share
  for (const method of ['PUT', 'POST', 'DELETE']) assert.equal((await call(method, '/s/' + token, { name: 'x', settings })).status, 404);
  await call('PUT', `/scenarios/${id}`, { name: 'Renamed', settings: { v: 1, weights: { safe: 100 } } }, tom);
  assert.equal((await call('GET', '/s/' + token)).data.name, 'Renamed');
  assert.equal((await call('DELETE', `/scenarios/${id}/share`, null, tom)).status, 200);
  assert.equal((await call('GET', '/s/' + token)).status, 404);
  const again = (await call('POST', `/scenarios/${id}/share`, {}, tom)).data.share.token;
  assert.notEqual(again, token);
  await call('DELETE', `/scenarios/${id}`, null, tom);
  assert.equal((await call('GET', '/s/' + again)).status, 404);
  assert.equal((await call('GET', '/s/' + 'a'.repeat(24))).status, 404);
});

test('changing the password signs out older sessions', async () => {
  const { call } = client();
  const t1 = (await call('POST', '/signup', { username: 'tom', password: 'correct horse' })).data.token;
  assert.equal((await call('POST', '/password', { current: 'nope', password: 'new password 1' }, t1)).status, 401);
  const t2 = (await call('POST', '/password', { current: 'correct horse', password: 'new password 1' }, t1)).data.token;
  assert.equal((await call('GET', '/scenarios', null, t1)).status, 401);
  assert.equal((await call('GET', '/scenarios', null, t2)).status, 200);
});

test('KV budget: reads and sign-ins never write; limits are enforced', async () => {
  const { call, env } = client();
  const tom = (await call('POST', '/signup', { username: 'tom', password: 'correct horse' })).data.token;
  const id = (await call('POST', '/scenarios', { name: 'a', settings }, tom)).data.id;
  const token = (await call('POST', `/scenarios/${id}/share`, {}, tom)).data.share.token;
  const before = env.ATC_KV.stats.puts;
  await call('POST', '/login', { username: 'tom', password: 'correct horse' });
  await call('GET', '/scenarios', null, tom); await call('GET', '/s/' + token); await call('GET', '/health');
  assert.equal(env.ATC_KV.stats.puts, before);
  await call('PUT', `/scenarios/${id}`, { name: 'a', settings }, tom);
  assert.equal(env.ATC_KV.stats.puts, before + 1);
  assert.equal((await call('POST', '/scenarios', { name: 'big', settings: { blob: 'x'.repeat(9000) } }, tom)).status, 413);
  assert.equal((await call('POST', '/scenarios', { name: '', settings }, tom)).status, 400);
  for (let i = 0; i < 24; i++) assert.equal((await call('POST', '/signup', { username: 'user' + i, password: 'password' + i })).status, 200);
  assert.equal((await call('POST', '/signup', { username: 'onemore', password: 'password99' })).status, 429);
});

test('CORS only admits the configured origins', async () => {
  const { call } = client();
  assert.equal((await call('GET', '/health')).headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal((await call('GET', '/health', null, null, 'https://evil.example')).headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await call('OPTIONS', '/scenarios')).status, 204);
});
