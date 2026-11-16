#!/usr/bin/env node
// Weekly 123ATC refresh. See atc/README.md ("Data refresh") for the policy.
//
//   node scripts/refresh-123atc.mjs                 fetch live, validate, snapshot, merge, changelog
//   node scripts/refresh-123atc.mjs --file x.csv    ingest a manual export (CSV with the table's columns, or saved HTML)
//   --date YYYY-MM-DD   snapshot date (default: today, UTC)
//   --spot N            spot-check N facility pages against the table (default 6 live, 0 with --file)
//   --dry-run           validate and report only; write nothing
//
// Stop rules: any validation problem exits non-zero and writes nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_URL, USER_AGENT, SNAP_COLS, parseFacilitiesHtml, parseCsv, toCsv, normalize,
  validate, merge, changelogMd, parseFacilityPage } from './lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const flag = k => args.includes(k);
const date = opt('--date', new Date().toISOString().slice(0, 10));
const file = opt('--file', null);
const spotN = Number(opt('--spot', file ? 0 : 6));
const dry = flag('--dry-run');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Low request rate: this many ms between any two requests to 123atc.com.
const GAP_MS = 5000;

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}
const fail = msg => { console.error('REFRESH ABORTED: ' + msg); process.exit(1); };

let rows, checks = [];
if (file) {
  const text = fs.readFileSync(file, 'utf8');
  rows = /<table/i.test(text) ? parseFacilitiesHtml(text) : parseCsv(text);
  if (!rows.length || !SNAP_COLS.every(c => c in rows[0])) fail(`${file} lacks the expected columns: ${SNAP_COLS.join(', ')}`);
  checks.push('manual file ingest (no double read)');
} else {
  // Two independent reads of the full table must agree before anything is published.
  let a, b;
  try {
    a = parseFacilitiesHtml(await get(SOURCE_URL));
    await sleep(GAP_MS);
    b = parseFacilitiesHtml(await get(SOURCE_URL + '?r=2'));
  } catch (e) { fail(e.message); }
  if (JSON.stringify(a) !== JSON.stringify(b)) fail('two reads of the table disagree');
  rows = a;
  checks.push('two reads agree');
}

const stat = JSON.parse(fs.readFileSync(path.join(root, 'data/static.json'), 'utf8'));
const tracked = Object.keys(stat);
const curPath = path.join(root, 'data/current-123atc.json');
const current = fs.existsSync(curPath) ? JSON.parse(fs.readFileSync(curPath, 'utf8')) : { asOf: null, facilities: {} };
const snapDir = path.join(root, 'data/snapshots');
const prevSnaps = fs.readdirSync(snapDir).filter(f => /^123atc-\d{4}-\d\d-\d\d\.csv$/.test(f) && f < `123atc-${date}.csv`).sort();
const prevRows = prevSnaps.length ? parseCsv(fs.readFileSync(path.join(snapDir, prevSnaps.at(-1)), 'utf8')).length : 0;

const norm = normalize(rows);
const problems = validate(norm, current.facilities || {}, tracked, rows.length, prevRows);
if (problems.length) fail(problems.join('; '));
checks.push(`row count ${rows.length} vs ${prevRows || 'n/a'} last run`, 'no required field newly blank');

if (spotN > 0) {
  const pool = tracked.filter(c => norm[c]);
  const picks = [];
  while (picks.length < Math.min(spotN, pool.length)) {
    const c = pool[Math.floor(Math.random() * pool.length)];
    if (!picks.includes(c)) picks.push(c);
  }
  const bad = [];
  for (const code of picks) {
    await sleep(GAP_MS);
    let page;
    try { page = parseFacilityPage(await get(`https://123atc.com/facility/${code}`)); }
    catch (e) { fail(`spot check ${code}: ${e.message}`); }
    if (page.level == null) fail(`spot check ${code}: could not read the facility page layout`);
    if (page.level !== norm[code].level) bad.push(`${code} level table=${norm[code].level} page=${page.level}`);
    if (page.train != null && norm[code].train != null && page.train !== norm[code].train) bad.push(`${code} training table=${norm[code].train} page=${page.train}`);
  }
  if (bad.length) fail('spot check mismatch: ' + bad.join('; '));
  checks.push(`spot-checked ${picks.length} facility pages (${picks.join(', ')})`);
}

const { current: next, changes } = merge(current, norm, tracked, date);
const md = changelogMd(date, changes, { rows: rows.length, checks: checks.join('; '), source: file ? `manual file ${path.basename(file)}` : SOURCE_URL });
const real = changes.filter(c => !c.stale);
console.log(`${rows.length} rows; ${real.length} changes across ${new Set(real.map(c => c.code)).size} facilities; ${changes.length - real.length} stale values kept`);
if (dry) { console.log(md); process.exit(0); }

fs.writeFileSync(path.join(snapDir, `123atc-${date}.csv`), toCsv(rows));
fs.writeFileSync(curPath, '{"asOf":' + JSON.stringify(next.asOf) + ',"facilities":{\n' +
  Object.entries(next.facilities).map(([k, v]) => JSON.stringify(k) + ':' + JSON.stringify(v)).join(',\n') + '\n}}\n');
fs.writeFileSync(path.join(root, 'data/changelog', `${date}.md`), md);
console.log(`wrote snapshot, current-123atc.json and changelog for ${date}`);
