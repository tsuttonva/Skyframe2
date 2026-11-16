// The refresh stop rules from HANDOFF.md section 2 and 6c/6d, as executable checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseFacilitiesHtml, parseCsv, toCsv, normalize, validate, merge, changelogMd, num, parseFacilityPage, SNAP_COLS } from '../scripts/lib.mjs';

const html = fs.readFileSync(new URL('./fixture-facilities.html', import.meta.url), 'utf8');

test('parses the 123ATC table, including multi-line headers and entities', () => {
  const rows = parseFacilitiesHtml(html);
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]), SNAP_COLS);
  assert.equal(rows[0]['Cur Staff'], '60%');
  assert.equal(rows[0]['Min CPC Salary'], '139307');
  assert.equal(rows[1].Name, 'Erie Tower & TRACON');
  assert.deepEqual(normalize(rows).BNA, { level: 10, target: 52, staff: 60, entry: 139307, train: 71 });
  assert.equal(normalize(rows).ERI.train, null);
});

test('a changed table layout aborts instead of guessing', () => {
  assert.throws(() => parseFacilitiesHtml(html.replace('>Level<', '>Lvl<')), /header changed/);
  assert.throws(() => parseFacilitiesHtml('<html>blocked</html>'), /not found/);
});

test('CSV round-trips', () => {
  const rows = parseFacilitiesHtml(html);
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
  assert.deepEqual(parseCsv('a,b\n"x, ""y""",2\n'), [{ a: 'x, "y"', b: '2' }]);
});

test('num() treats blanks and junk as null, never 0', () => {
  assert.equal(num('75%'), 75); assert.equal(num('$138,508'), 138508); assert.equal(num('0%'), 0);
  for (const v of ['', ' ', '-', 'N/A', null, undefined]) assert.equal(num(v), null);
});

const prev = { A: { level: 5, target: 10, staff: 80, entry: 90000, train: 70, asOf: {} }, B: { level: 6, target: 12, staff: 90, entry: 95000, train: null, asOf: {} } };

test('row count must stay within 5% of the last run', () => {
  const now = { A: prev.A, B: prev.B };
  assert.deepEqual(validate(now, prev, ['A', 'B'], 313, 313), []);
  assert.deepEqual(validate(now, prev, ['A', 'B'], 300, 313), []);
  assert.match(validate(now, prev, ['A', 'B'], 290, 313)[0], /row count/);
  assert.match(validate(now, prev, ['A', 'B'], 340, 313)[0], /row count/);
});

test('a required field going blank blocks the refresh; training success may be blank', () => {
  const now = { A: { ...prev.A, staff: null }, B: prev.B };
  assert.match(validate(now, prev, ['A', 'B'], 313, 313).join(), /"staff" suddenly blank.*A/);
  assert.deepEqual(validate({ A: { ...prev.A, train: null }, B: prev.B }, prev, ['A', 'B'], 313, 313), []);
});

test('many tracked facilities vanishing blocks the refresh', () => {
  const tracked = Array.from({ length: 100 }, (_, i) => 'F' + i);
  const all = Object.fromEntries(tracked.map(c => [c, prev.A]));
  const some = Object.fromEntries(tracked.slice(10).map(c => [c, prev.A]));
  assert.match(validate(some, all, tracked, 300, 300).join(), /missing from the table/);
});

test('merge never overwrites a value with blank; it keeps the last good value and marks it stale', () => {
  const cur = { asOf: '2026-11-13', facilities: { A: { level: 5, target: 10, staff: 80, entry: 90000, train: 70,
    asOf: { level: '2026-11-13', target: '2026-11-13', staff: '2026-11-13', entry: '2026-11-13', train: '2026-11-13' } } } };
  const { current, changes } = merge(cur, { A: { level: 5, target: 10, staff: 85, entry: 90000, train: null } }, ['A'], '2026-11-20');
  assert.equal(current.facilities.A.train, 70);
  assert.equal(current.facilities.A.asOf.train, '2026-11-13');
  assert.equal(current.facilities.A.asOf.staff, '2026-11-20');
  assert.deepEqual(changes.filter(c => !c.stale), [{ code: 'A', field: 'staff', old: 80, new: 85 }]);
  assert.equal(changes.filter(c => c.stale)[0].field, 'train');
  // a facility missing from the table entirely keeps everything
  const gone = merge(cur, {}, ['A'], '2026-11-20').current.facilities.A;
  assert.equal(gone.staff, 80); assert.equal(gone.asOf.staff, '2026-11-13');
  const md = changelogMd('2026-11-20', changes, { rows: 313, checks: 'x' });
  assert.match(md, /\| A \| staff \| 80 \| 85 \|/); assert.match(md, /Kept/);
});

test('facility page spot-check parser', () => {
  const page = '<div>Type</div> Tower <div>Level</div><div>Level 10</div> <p>Training Success Rate (Avg) <b>71%</b></p>';
  assert.deepEqual(parseFacilityPage(page), { level: 10, train: 71 });
});
