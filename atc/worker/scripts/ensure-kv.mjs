#!/usr/bin/env node
// Deploy-time helper: find (or create) the KV namespace for ATC Explorer and write its
// id into wrangler.toml. Uses the same CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
// secrets the SkyFrame worker deploy already uses.
import fs from 'node:fs';
const TITLE = 'atc-explorer-kv';
const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } = process.env;
if (!token || !account) { console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required'); process.exit(1); }
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces`;
const api = async (url, init = {}) => {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) {
    console.error(`Cloudflare API ${res.status}: ${JSON.stringify(body.errors || body)}`);
    console.error('If this is a permissions error, the API token needs "Workers KV Storage: Edit".');
    process.exit(1);
  }
  return body;
};
let id = null;
for (let page = 1; page <= 10 && !id; page++) {
  const body = await api(`${base}?per_page=100&page=${page}`);
  const hit = body.result.find(n => n.title === TITLE);
  if (hit) id = hit.id;
  if (body.result.length < 100) break;
}
if (!id) {
  id = (await api(base, { method: 'POST', body: JSON.stringify({ title: TITLE }) })).result.id;
  console.log(`created KV namespace ${TITLE}`);
} else console.log(`using existing KV namespace ${TITLE}`);
const file = new URL('../wrangler.toml', import.meta.url);
const toml = fs.readFileSync(file, 'utf8');
if (!toml.includes('REPLACED_AT_DEPLOY')) { console.error('wrangler.toml placeholder not found'); process.exit(1); }
fs.writeFileSync(file, toml.replace('REPLACED_AT_DEPLOY', id));
