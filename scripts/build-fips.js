#!/usr/bin/env node
/*
 * Regenerates web/fips.json from the vendored authoritative county dataset.
 *
 * Source: USFWS "fips-county-codes" package (data/fips-counties.csv, public
 * domain / SAX-PD license), vendored here as scripts/data/fips-counties.csv.
 * That dataset is sourced from Census Bureau county legal names, so it
 * carries the correct suffix per state (County / Parish / Borough / etc.)
 * and resolves edge cases like FIPS 51137 -> "Orange County" correctly.
 *
 * Output shape: { "<5-digit FIPS>": "<County Name>, <ST>" }
 *
 * Re-run with: node scripts/build-fips.js
 */
const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, 'data', 'fips-counties.csv');
const outPath = path.join(__dirname, '..', 'web', 'fips.json');

const lines = fs.readFileSync(csvPath, 'utf8').split('\n').filter(Boolean);
const header = lines[0].split(',');
const out = {};

for (let i = 1; i < lines.length; i++) {
  const row = lines[i].split(',');
  if (row.length < 4) continue;
  const state = row[0].trim();
  const statefp = row[1].trim();
  const countyfp = row[2].trim();
  const countyname = row[3].trim();
  if (!state || !statefp || !countyfp || !countyname) continue;
  const fips = statefp.padStart(2, '0') + countyfp.padStart(3, '0');
  out[fips] = countyname + ', ' + state;
}

fs.writeFileSync(outPath, JSON.stringify(out));
console.log('Wrote ' + Object.keys(out).length + ' counties to ' + outPath);
