// Shared helpers for the 123ATC refresh and the facilities.json build.
// Pure functions only (no network, no fs) so tests can exercise them directly.

export const SOURCE_URL = 'https://123atc.com/facilities';
export const USER_AGENT =
  'atc-explorer-bot/1.0 (+https://github.com/tsuttonva/Skyframe2/tree/HEAD/atc; personal non-commercial; one page weekly)';

// Columns of a snapshot CSV, in order. Mirrors the 123ATC table.
export const SNAP_COLS = ['ID', 'Name', 'Type', 'Level', 'State', 'CRWG Target', 'Cur Staff',
  'Proj Staff', 'Training Time', 'Training Success', 'Min CPC Salary'];

// The fields the app consumes, and which snapshot column each comes from.
export const FIELDS = { level: 'Level', target: 'CRWG Target', staff: 'Cur Staff',
  entry: 'Min CPC Salary', train: 'Training Success' };
// Must never go blank for a tracked facility (training success legitimately can).
export const REQUIRED = ['level', 'target', 'staff', 'entry'];

const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
const cellText = h => decode(h.replace(/<[^>]+>/g, ' ')).replace(/[➔→]/g, ' ').replace(/\s+/g, ' ').trim();

/** Parse the 123ATC /facilities HTML into an array of row objects keyed by SNAP_COLS. */
export function parseFacilitiesHtml(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/g) || [];
  const table = tables.find(t => /facility-row/.test(t));
  if (!table) throw new Error('facility table not found in page');
  const heads = (table.match(/<th[\s\S]*?<\/th>/g) || []).map(cellText)
    .map(h => h.replace(/\./g, '').replace(/\s+/g, ' ').trim());
  const expect = SNAP_COLS.map(c => c.toLowerCase());
  const got = heads.map(h => h.toLowerCase());
  if (got.length !== expect.length || got.some((h, i) => h !== expect[i])) {
    throw new Error('table header changed: ' + JSON.stringify(heads));
  }
  const rows = [];
  for (const tr of table.match(/<tr class="facility-row"[\s\S]*?<\/tr>/g) || []) {
    const cells = (tr.match(/<td[\s\S]*?<\/td>/g) || []).map(cellText);
    if (cells.length !== SNAP_COLS.length) throw new Error('unexpected cell count in row: ' + cells.join('|'));
    const row = {};
    SNAP_COLS.forEach((c, i) => { row[c] = cells[i]; });
    row['Min CPC Salary'] = row['Min CPC Salary'].replace(/[$,]/g, '');
    rows.push(row);
  }
  return rows;
}

export function parseCsv(text) {
  const out = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = ''; if (row.length > 1 || row[0] !== '') out.push(row); row = [];
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); out.push(row); }
  const head = out.shift() || [];
  return out.map(r => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const q = v => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
export function toCsv(rows, cols = SNAP_COLS) {
  return cols.join(',') + '\n' + rows.map(r => cols.map(c => q(String(r[c] ?? ''))).join(',')).join('\n') + '\n';
}

/** "75%" -> 75, "$138,508" -> 138508, "" / "-" / "N/A" -> null. */
export function num(v) {
  if (v == null) return null;
  const s = String(v).replace(/[$,%\s]/g, '');
  if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** Snapshot rows -> { CODE: {level,target,staff,entry,train} } with nulls for blanks. */
export function normalize(rows) {
  const out = {};
  for (const r of rows) {
    const code = (r.ID || '').trim();
    if (!code) continue;
    out[code] = {};
    for (const [f, col] of Object.entries(FIELDS)) out[code][f] = num(r[col]);
  }
  return out;
}

/**
 * Stop rules. Returns a list of problems (empty = OK to publish).
 * - row count within +-5% of the previous snapshot
 * - no required field newly blank for a tracked facility
 * - no tracked facility missing from the table (reported, tolerated up to 2% as closures/renames)
 */
export function validate(newNorm, prevNorm, trackedCodes, newRowCount, prevRowCount) {
  const problems = [];
  if (prevRowCount) {
    const drift = Math.abs(newRowCount - prevRowCount) / prevRowCount;
    if (drift > 0.05) problems.push(`row count ${newRowCount} is ${(drift * 100).toFixed(1)}% off the last run (${prevRowCount}); limit is 5%`);
  }
  if (newRowCount < 50) problems.push(`only ${newRowCount} rows parsed`);
  const missing = trackedCodes.filter(c => !newNorm[c]);
  if (missing.length > Math.max(2, trackedCodes.length * 0.02)) problems.push(`${missing.length} tracked facilities missing from the table: ${missing.slice(0, 12).join(', ')}`);
  for (const f of REQUIRED) {
    const blank = trackedCodes.filter(c => newNorm[c] && newNorm[c][f] == null && prevNorm[c] && prevNorm[c][f] != null);
    if (blank.length) problems.push(`required field "${f}" suddenly blank for ${blank.length} facilities: ${blank.slice(0, 12).join(', ')}`);
  }
  return problems;
}

/**
 * Merge a normalized snapshot into the last-good store.
 * Never overwrites a value with blank: the old value stays and its asOf date is left
 * behind, which is what marks it stale. Returns {current, changes}.
 */
export function merge(current, newNorm, trackedCodes, date) {
  const next = { asOf: date, facilities: {} };
  const changes = [];
  for (const code of trackedCodes) {
    const old = (current.facilities || {})[code] || { asOf: {} };
    const neu = newNorm[code] || {};
    const rec = { asOf: { ...(old.asOf || {}) } };
    for (const f of Object.keys(FIELDS)) {
      const nv = neu[f] ?? null, ov = old[f] ?? null;
      if (nv != null) {
        rec[f] = nv; rec.asOf[f] = date;
        if (nv !== ov) changes.push({ code, field: f, old: ov, new: nv });
      } else {
        rec[f] = ov; // keep last good value; asOf stays at the date it was last seen
        if (ov != null) changes.push({ code, field: f, old: ov, new: ov, stale: true, since: rec.asOf[f] || null });
      }
    }
    next.facilities[code] = rec;
  }
  return { current: next, changes };
}

export function changelogMd(date, changes, meta = {}) {
  const real = changes.filter(c => !c.stale), stale = changes.filter(c => c.stale);
  const fmt = v => v == null ? '(blank)' : String(v);
  const towers = new Set(real.map(c => c.code));
  let md = `# 123ATC refresh ${date}\n\n`;
  md += `- Source: ${meta.source || SOURCE_URL}\n- Rows in table: ${meta.rows ?? '?'}\n`;
  md += `- Checks: ${meta.checks || 'n/a'}\n`;
  md += `- ${real.length} value changes across ${towers.size} tracked facilities; ${stale.length} values kept from an earlier run (blank at source, flagged stale)\n\n`;
  if (real.length) {
    md += '| Facility | Field | Old | New |\n|---|---|---|---|\n';
    for (const c of real) md += `| ${c.code} | ${c.field} | ${fmt(c.old)} | ${fmt(c.new)} |\n`;
  } else md += 'No values changed.\n';
  if (stale.length) {
    md += '\n## Kept (blank or missing at source)\n\n| Facility | Field | Kept value | Last seen |\n|---|---|---|---|\n';
    for (const c of stale) md += `| ${c.code} | ${c.field} | ${fmt(c.old)} | ${c.since || 'unknown'} |\n`;
  }
  return md;
}

/** Pull level and average training success from a /facility/<CODE> page, for spot checks. */
export function parseFacilityPage(html) {
  const txt = decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  const lvl = txt.match(/Level Level (\d+)/);
  const tr = txt.match(/Training Success Rate \(Avg\) (\d+)%/);
  return { level: lvl ? Number(lvl[1]) : null, train: tr ? Number(tr[1]) : null };
}
