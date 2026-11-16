// Scoring behavior from HANDOFF.md section 4.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prepare, computeFit, filterSort, DEFAULT_WEIGHTS, safetyGrade, sanitizeSettings, defaultSettings } from '../site/src/core.js';

const data = JSON.parse(fs.readFileSync(new URL('../site/data/facilities.json', import.meta.url), 'utf8'));
const fresh = () => prepare(data.facilities);

test('default weights are a fixed pool of 100', () => {
  assert.deepEqual(DEFAULT_WEIGHTS, { pay: 25, afford: 25, safe: 20, close: 10, need: 10, outdoors: 10, train: 0 });
  assert.equal(Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b), 100);
});

test('safety grade thresholds', () => {
  assert.deepEqual([149, 150, 299, 300, 499, 500, 799, 800, null].map(safetyGrade), ['A', 'B', 'B', 'C', 'C', 'D', 'D', 'F', null]);
});

test('percentiles: direction and range', () => {
  const rows = fresh();
  for (const r of rows) for (const k of ['pay', 'afford', 'safe', 'close', 'need', 'outdoors', 'train']) {
    const p = r['p_' + k]; if (p != null) assert.ok(p >= 0 && p <= 100, `${r.code} ${k} ${p}`);
  }
  const withRent = rows.filter(r => r.rent2 != null);
  const cheapest = withRent.reduce((a, b) => a.rent2 <= b.rent2 ? a : b), priciest = withRent.reduce((a, b) => a.rent2 >= b.rent2 ? a : b);
  assert.equal(cheapest.p_afford, 100); assert.equal(priciest.p_afford, 0);   // lower rent is better
  const pct = rows.find(r => r.code === 'PCT');
  assert.equal(pct.p_close, 100);                                            // Warrenton's own TRACON is closest
  const leastStaffed = rows.reduce((a, b) => a.staff <= b.staff ? a : b);
  assert.equal(leastStaffed.p_need, 100);                                    // lower staffing = more need
});

test('fit shows only when at least 60% of the weight has data', () => {
  const rows = fresh();
  computeFit(rows, DEFAULT_WEIGHTS);
  for (const r of rows) assert.equal(r.fit == null, r.cover < 60, r.code);
  const ack = rows.find(r => r.code === 'ACK');       // no rent -> pay + afford (50 of 100) missing
  assert.equal(ack.rent2, null); assert.equal(ack.fit, null);
  computeFit(rows, { pay: 0, afford: 0, safe: 50, close: 50, need: 0, outdoors: 0, train: 0 });
  assert.notEqual(ack.fit, null);
});

test('fit is the weight-normalized mean of available percentiles', () => {
  const rows = fresh();
  computeFit(rows, { pay: 0, afford: 0, safe: 0, close: 100, need: 0, outdoors: 0, train: 0 });
  for (const r of rows) assert.ok(Math.abs(r.fit - r.p_close) < 1e-9, r.code);
});

test('max staffed is a hard cut; over-level rows sort to the bottom', () => {
  const rows = fresh(); computeFit(rows, DEFAULT_WEIGHTS);
  const base = { q: '', region: '', maxLevel: null, maxStaff: null, sortK: 'fit', dir: -1 };
  const cut = filterSort(rows, { ...base, maxStaff: 80 });
  assert.ok(cut.length > 0 && cut.every(r => r.staff <= 80));
  const lvl = filterSort(rows, { ...base, maxLevel: 6 });
  assert.equal(lvl.length, rows.length);
  const firstOver = lvl.findIndex(r => r.level > 6);
  assert.ok(firstOver > 0 && lvl.slice(firstOver).every(r => r.level > 6));
  assert.ok(filterSort(rows, { ...base, region: 'R:Northeast' }).every(r => ['CT', 'ME', 'MA', 'NH', 'RI', 'VT', 'NJ', 'NY', 'PA'].includes(r.st)));
});

test('scenario settings survive a round trip and reject junk', () => {
  const s = { v: 1, weights: { pay: 40, afford: 10, safe: 20, close: 0, need: 10, outdoors: 10, train: 10 },
    filters: { q: 'tower', region: 'D:South Atlantic', maxLevel: 8, maxStaff: 90 }, sort: { k: 'staff', dir: 1 }, sel: ['BNA', 'ORF'], map: { open: true, x: 500, y: 100, w: 400 } };
  assert.deepEqual(sanitizeSettings(JSON.parse(JSON.stringify(s)), new Set(['BNA', 'ORF'])), s);
  assert.deepEqual(sanitizeSettings(null), defaultSettings());
  const junk = sanitizeSettings({ weights: { pay: 900, afford: -5, safe: 'x' }, filters: { region: '<script>' }, sort: { k: 'a b' }, sel: ['BNA', 'NOPE', 1, 'A', 'B', 'C'] }, new Set(['BNA', 'A', 'B', 'C']));
  assert.equal(Object.values(junk.weights).reduce((a, b) => a + b), 100);
  assert.equal(junk.filters.region, ''); assert.equal(junk.sort.k, 'fit'); assert.deepEqual(junk.sel, ['BNA', 'A', 'B']);
});
