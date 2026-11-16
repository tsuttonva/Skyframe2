// Pure data + scoring logic. No DOM access, so the same file runs in the browser
// and under `node --test` (atc/tests). Derived values live here, never in the data.

export const WARR = { lat: 38.7135, lon: -77.7950, index: 108.9 };

// Weight keys, their default points (a fixed pool of 100), and labels.
export const WEIGHTS = [
  ['pay', 25, 'Pay'], ['afford', 25, 'Rent'], ['safe', 20, 'Safety'], ['close', 10, 'Near Warrenton'],
  ['need', 10, 'Staffing need'], ['outdoors', 10, 'Outdoors'], ['train', 0, 'Training'],
];
export const DEFAULT_WEIGHTS = Object.fromEntries(WEIGHTS.map(([k, v]) => [k, v]));
// Fit score is shown only when at least this share of the weight has data.
export const MIN_COVER = 60;

export const haversine = (la1, lo1, la2, lo2) => {
  const R = 3958.8, toR = x => x * Math.PI / 180;
  const dLa = toR(la2 - la1), dLo = toR(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(toR(la1)) * Math.cos(toR(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};
export const safetyGrade = c => c == null ? null : c < 150 ? 'A' : c < 300 ? 'B' : c < 500 ? 'C' : c < 800 ? 'D' : 'F';

// Approximate take-home model. Single filer, 2026 federal brackets, FICA, rough state/city rates at ~$60K.
const STATE_RATE = { VA: 5.75, NC: 3.99, SC: 6.0, GA: 5.19, TN: 0, PA: 3.07, NJ: 5.5, NY: 6.0, MD: 5.0, MA: 5.0, OH: 2.75, FL: 0, DC: 6.0 };
const LOCAL_RATE = { PHL: 3.75, PNE: 3.75, PIT: 3.0, CLE: 2.5, BWI: 3.2, JFK: 3.5, LGA: 3.5 };
const FED_BRK = [[12400, .10], [50400, .12], [105700, .22], [201775, .24]];
export function monthlyNet(gross, st, code) {
  const taxable = Math.max(0, gross - 16100);
  let fed = 0, lo = 0;
  for (const [hi, rate] of FED_BRK) { if (taxable > lo) fed += (Math.min(taxable, hi) - lo) * rate; lo = hi; }
  if (taxable > 201775) fed += (taxable - 201775) * .32;
  const fica = gross * .0765;
  const state = Math.max(0, gross - 8000) * (STATE_RATE[st] ?? 0) / 100;
  const local = gross * (LOCAL_RATE[code] ?? 0) / 100;
  return (gross - fed - fica - state - local) / 12;
}

// [percentile key, row field, higher is better]
const CATS = [['pay', 'afterRent', true], ['afford', 'rent2', false], ['safe', 'crime', false], ['close', 'miles', false],
  ['need', 'staff', false], ['trail', 'trail_mi', true], ['park', 'park_ac', true], ['train', 'train', true]];

/** facilities.json records -> rows with every derived field and percentile. */
export function prepare(facilities) {
  const rows = facilities.map(f => {
    const r = { ...f, sports: f.sports || '', trail_mi: f.trail ?? null, park_ac: f.park ?? null, income: f.income ?? null };
    r.trainee = Math.round(f.entry * 0.575);
    r.colDelta = f.index != null ? (f.index / WARR.index - 1) * 100 : null;
    r.miles = (f.lat != null && f.lon != null) ? haversine(WARR.lat, WARR.lon, f.lat, f.lon) : null;
    r.grade = safetyGrade(f.crime);
    r.net = monthlyNet(r.trainee, f.st, f.code);
    r.afterRent = f.rent2 != null ? r.net - f.rent2 : null;
    r.rentPct = f.rent2 != null ? f.rent2 / r.net * 100 : null;
    // Political lean: [2020, 2024] presidential margin for the airport's county, Dem minus Rep.
    const m = f.margins;
    if (m) { r.m2020 = m[0]; r.m2024 = m[1]; const avg = (m[0] + m[1]) / 2; r.leanAvg = avg; r.lean = avg >= 20 ? 'Hard D' : avg > 0 ? 'Soft D' : avg <= -20 ? 'Hard R' : 'Soft R'; }
    else { r.m2020 = null; r.m2024 = null; r.leanAvg = null; r.lean = null; }
    return r;
  });
  // Percentile (0-100, higher = better for you) per category, across rows with data.
  CATS.forEach(([key, field, higher]) => {
    const vals = rows.map(r => r[field]).filter(v => v != null);
    const n = Math.max(vals.length - 1, 1);
    rows.forEach(r => {
      const v = r[field];
      if (v == null) { r['p_' + key] = null; return; }
      const below = vals.filter(x => x < v).length, above = vals.filter(x => x > v).length;
      r['p_' + key] = (higher ? below : above) / n * 100;
    });
  });
  rows.forEach(r => { r.p_outdoors = (r.p_trail != null && r.p_park != null) ? (r.p_trail + r.p_park) / 2 : null; });
  return rows;
}

/** Sets r.fit and r.cover on every row for the given weights. Returns total weight. */
export function computeFit(rows, W) {
  const totalW = Object.values(W).reduce((a, b) => a + b, 0) || 1;
  rows.forEach(r => {
    let num = 0, den = 0;
    for (const k in W) { const p = r['p_' + k]; if (p != null) { num += W[k] * p; den += W[k]; } }
    r.cover = den / totalW * 100;
    r.fit = (den && r.cover >= MIN_COVER) ? num / den : null; // hide score when most of the weight has no data
  });
  return totalW;
}

export const overLevel = (r, maxLevel) => maxLevel != null && r.level > maxLevel;

/** Filter + sort. Max staffed is a hard cut; over-level rows are kept but sorted to the bottom. */
export function filterSort(rows, s) {
  const q = (s.q || '').toLowerCase();
  const list = rows.filter(r => {
    if (s.maxStaff != null && (r.staff == null || r.staff > s.maxStaff)) return false;
    if (s.region) {
      const [reg, dv] = REGION_OF[r.st] || [];
      if (s.region.startsWith('R:') ? reg !== s.region.slice(2) : dv !== s.region.slice(2)) return false;
    }
    if (q && !`${r.code} ${r.name} ${r.st}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const k = s.sortK, dir = s.dir;
  list.sort((a, b) => {
    const oa = overLevel(a, s.maxLevel), ob = overLevel(b, s.maxLevel);
    if (oa !== ob) return oa ? 1 : -1;
    const va = a[k], vb = b[k];
    if (va == null && vb == null) return 0;
    if (va == null) return 1; if (vb == null) return -1;
    if (typeof va === 'string') return va.localeCompare(vb) * dir;
    return (va - vb) * dir;
  });
  return list;
}

// ---- Scenario settings: everything needed to recompute a view exactly. Scores are
// never stored; they are recomputed from these settings against the current data.
export const SETTINGS_VERSION = 1;
export function defaultSettings() {
  return { v: SETTINGS_VERSION, weights: { ...DEFAULT_WEIGHTS },
    filters: { q: '', region: '', maxLevel: null, maxStaff: null },
    sort: { k: 'fit', dir: -1 }, sel: [], map: { open: false, x: 0, y: 0, w: 960 } };
}
const numOrNull = v => (v == null || v === '' || !isFinite(Number(v))) ? null : Number(v);
/** Coerce anything (a stored scenario, a share payload, junk) into valid settings. */
export function sanitizeSettings(raw, knownCodes) {
  const d = defaultSettings(), s = raw && typeof raw === 'object' ? raw : {};
  const w = {}; let total = 0;
  for (const [k] of WEIGHTS) {
    let v = Math.round(Number(s.weights && s.weights[k]));
    if (!isFinite(v) || v < 0) v = 0;
    v = Math.min(v, 100 - total); total += v; w[k] = v;
  }
  d.weights = s.weights ? w : d.weights;
  const f = s.filters || {};
  d.filters = { q: typeof f.q === 'string' ? f.q.slice(0, 80) : '', region: typeof f.region === 'string' && /^[RD]:[\w ]+$/.test(f.region) ? f.region : '',
    maxLevel: numOrNull(f.maxLevel), maxStaff: numOrNull(f.maxStaff) };
  if (s.sort && typeof s.sort.k === 'string' && /^[\w]+$/.test(s.sort.k)) d.sort = { k: s.sort.k, dir: s.sort.dir === 1 ? 1 : -1 };
  if (Array.isArray(s.sel)) d.sel = s.sel.filter(c => typeof c === 'string' && (!knownCodes || knownCodes.has(c))).slice(0, 3);
  const m = s.map || {};
  d.map = { open: !!m.open, x: numOrNull(m.x) ?? 0, y: numOrNull(m.y) ?? 0, w: Math.max(120, Math.min(960, numOrNull(m.w) ?? 960)) };
  return d;
}

export const REGION_OF = {"CT":["Northeast","New England"],"ME":["Northeast","New England"],"MA":["Northeast","New England"],"NH":["Northeast","New England"],"RI":["Northeast","New England"],"VT":["Northeast","New England"],"NJ":["Northeast","Middle Atlantic"],"NY":["Northeast","Middle Atlantic"],"PA":["Northeast","Middle Atlantic"],"IL":["Midwest","East North Central"],"IN":["Midwest","East North Central"],"MI":["Midwest","East North Central"],"OH":["Midwest","East North Central"],"WI":["Midwest","East North Central"],"IA":["Midwest","West North Central"],"KS":["Midwest","West North Central"],"MN":["Midwest","West North Central"],"MO":["Midwest","West North Central"],"NE":["Midwest","West North Central"],"ND":["Midwest","West North Central"],"SD":["Midwest","West North Central"],"DE":["South","South Atlantic"],"DC":["South","South Atlantic"],"FL":["South","South Atlantic"],"GA":["South","South Atlantic"],"MD":["South","South Atlantic"],"NC":["South","South Atlantic"],"SC":["South","South Atlantic"],"VA":["South","South Atlantic"],"WV":["South","South Atlantic"],"AL":["South","East South Central"],"KY":["South","East South Central"],"MS":["South","East South Central"],"TN":["South","East South Central"],"AR":["South","West South Central"],"LA":["South","West South Central"],"OK":["South","West South Central"],"TX":["South","West South Central"],"AZ":["West","Mountain"],"CO":["West","Mountain"],"ID":["West","Mountain"],"MT":["West","Mountain"],"NV":["West","Mountain"],"NM":["West","Mountain"],"UT":["West","Mountain"],"WY":["West","Mountain"],"AK":["West","Pacific"],"CA":["West","Pacific"],"HI":["West","Pacific"],"OR":["West","Pacific"],"WA":["West","Pacific"]};
