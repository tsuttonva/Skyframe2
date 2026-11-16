// Checks on the committed data: the app must match 123ATC for every tracked facility.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCsv, normalize, FIELDS } from '../scripts/lib.mjs';
import { build } from '../scripts/build.mjs';

const rd = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const site = JSON.parse(rd('site/data/facilities.json'));
const snaps = fs.readdirSync(new URL('../data/snapshots/', import.meta.url)).filter(f => f.endsWith('.csv')).sort();
const latest = snaps.at(-1);

test('facilities.json is up to date with its inputs (run `node atc/scripts/build.mjs`)', () => {
  assert.deepEqual(site, JSON.parse(JSON.stringify(build())));
});

test('snapshot date matches the newest dated snapshot file', () => {
  assert.equal(`123atc-${site.snapshot}.csv`, latest);
});

test('level, target, staffing, entry pay and training match 123ATC for all facilities', () => {
  const norm = normalize(parseCsv(rd('data/snapshots/' + latest)));
  assert.equal(site.facilities.length, 209);
  const bad = [];
  for (const f of site.facilities) {
    for (const k of Object.keys(FIELDS)) {
      const src = norm[f.code] ? norm[f.code][k] : null;
      if (src == null) { if (f[k] != null && !(f.stale && f.stale[k])) bad.push(`${f.code}.${k} kept without a stale flag`); }
      else if (f[k] !== src) bad.push(`${f.code}.${k}: app ${f[k]} vs 123ATC ${src}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('no required field is blank and every snapshot keeps its 11 columns', () => {
  for (const f of site.facilities) for (const k of ['level', 'target', 'staff', 'entry', 'lat', 'lon']) assert.notEqual(f[k], null, `${f.code}.${k}`);
  for (const s of snaps) assert.equal(Object.keys(parseCsv(rd('data/snapshots/' + s))[0]).length, 11, s);
});

test('known gaps stay honest: borrowed crime is labelled, unusable crime stays blank', () => {
  const by = Object.fromEntries(site.facilities.map(f => [f.code, f]));
  assert.equal(by.TEB.crimeFrom, 'New York'); assert.equal(by.BED.crimeFrom, 'Boston');
  for (const c of ['GPT', 'JAN', 'NEW', 'ORL', 'ITO', 'OGG', 'SJU', 'STT']) assert.equal(by[c].crime, null, c);
  assert.equal(by.SAV.crime, 355);
  for (const f of site.facilities) if (f.crimeFrom) assert.ok(f.crime > 0, f.code);
});
