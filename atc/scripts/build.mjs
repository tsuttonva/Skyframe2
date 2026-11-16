#!/usr/bin/env node
// Builds site/data/facilities.json from:
//   data/static.json           slow-changing fields (cost of living, crime, outdoors, coords...)
//   data/current-123atc.json   last-good 123ATC values, maintained by refresh-123atc.mjs
//   data/sources/city_crime.csv  for the "borrowed" crime figures on proxy towers
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, FIELDS } from './lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = p => fs.readFileSync(path.join(root, p), 'utf8');

export function build() {
  const stat = JSON.parse(rd('data/static.json'));
  const cur = JSON.parse(rd('data/current-123atc.json'));
  const crime = Object.fromEntries(parseCsv(rd('data/sources/city_crime.csv')).map(r => [r.code, r]));
  const facilities = [];
  for (const [code, s] of Object.entries(stat)) {
    const c = cur.facilities[code] || { asOf: {} };
    const f = { code, name: s.name, st: s.st, inR: s.inR };
    const stale = {};
    for (const k of Object.keys(FIELDS)) {
      f[k] = c[k] ?? null;
      if (c[k] != null && c.asOf && c.asOf[k] && c.asOf[k] < cur.asOf) stale[k] = c.asOf[k];
    }
    Object.assign(f, { index: s.index, crime: s.crime, home: s.home, rent2: s.rent2, income: s.income,
      trail: s.trail, park: s.park, margins: s.margins, sports: s.sports, lat: s.lat, lon: s.lon });
    // Proxy towers: the airport's own town has no usable FBI figure, so a nearby big
    // city's rate is borrowed. Shown and scored, but always labelled as borrowed.
    const cr = crime[code];
    if (f.crime == null && cr && cr.match_type === 'proxy' && Number(cr.violent_per_100k_2024) > 0) {
      f.crime = Number(cr.violent_per_100k_2024);
      f.crimeFrom = cr.city_used;
    }
    if (Object.keys(stale).length) f.stale = stale;
    facilities.push(f);
  }
  return { snapshot: cur.asOf, source: 'https://123atc.com/facilities', facilities };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = build();
  const txt = '{"snapshot":' + JSON.stringify(out.snapshot) + ',"source":' + JSON.stringify(out.source) +
    ',"facilities":[\n' + out.facilities.map(f => JSON.stringify(f)).join(',\n') + '\n]}\n';
  fs.writeFileSync(path.join(root, 'site/data/facilities.json'), txt);
  const borrowed = out.facilities.filter(f => f.crimeFrom).length;
  const stale = out.facilities.filter(f => f.stale).length;
  console.log(`facilities.json: ${out.facilities.length} facilities, snapshot ${out.snapshot}, ${borrowed} borrowed crime figures, ${stale} with stale fields`);
}
