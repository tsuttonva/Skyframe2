// UI for the tower table, compare panel, detail drawer and fit map.
// Scoring lives in core.js; accounts/scenarios/sharing live in cloud.js.
import { WEIGHTS, prepare, computeFit, filterSort, overLevel, defaultSettings, sanitizeSettings } from './core.js';
import { initCloud } from './cloud.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const NA = '<span class="na">—</span>';

// Keep SkyFrame's cache-first service worker (same origin, wider scope) away from this app. See sw.js.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// 'no-cache' = always revalidate, so a weekly data refresh shows up without a hard reload.
const [DATA, MAP] = await Promise.all([
  fetch('data/facilities.json', { cache: 'no-cache' }).then(r => r.json()),
  fetch('data/map.json').then(r => r.json()),
]);
const rows = prepare(DATA.facilities);
const byCode = new Map(rows.map(r => [r.code, r]));
const KNOWN = new Set(byCode.keys());
$('snap').textContent = `123ATC data as of ${DATA.snapshot}`;

// slider element id suffix for each weight key
const WID = { pay: 'pay', afford: 'afford', safe: 'safe', close: 'close', need: 'need', outdoors: 'out', train: 'train' };
const WKEYS = WEIGHTS.map(w => w[0]);
const slider = k => $('w_' + WID[k]);
const state = { sortK: 'fit', dir: -1, q: '', sel: [], maxLevel: null, maxStaff: null, region: '' };
const view = { x: 0, y: 0, w: 960, h: 600 };
let lastList = [];
let onChange = () => {};

const gradeClass = g => !g ? '' : ({ A: 'g-a', B: 'g-b', C: 'g-c', D: 'g-d', F: 'g-f' })[g];
const fmt$ = v => v == null ? NA : '$' + Math.round(v).toLocaleString();
const fmtN = (v, d = 0) => v == null ? NA : Number(v).toLocaleString(undefined, { maximumFractionDigits: d });
const barColor = s => s >= 100 ? '#39d98a' : s >= 85 ? '#9ccf4a' : s >= 70 ? '#ffb547' : '#ff6b6b';
const leanHTML = l => !l ? NA : `<span class="${l.endsWith('D') ? 'lean-sb' : l.endsWith('R') ? 'lean-sr' : ''}">${l}</span>`;
// Honest-gap markers: a value kept from an earlier refresh, or a crime rate borrowed from a nearby city.
const staleFlag = (r, f) => r.stale && r.stale[f] ? `<span class="flag stale" title="Blank at 123ATC in the latest refresh. Showing the last good value, from ${esc(r.stale[f])}.">stale</span>` : '';
const borrowFlag = r => r.crimeFrom ? `<span class="flag borrow" title="No usable FBI figure for this airport's own town. Borrowed from ${esc(r.crimeFrom)}.">borrowed: ${esc(r.crimeFrom)}</span>` : '';

const weights = () => Object.fromEntries(WKEYS.map(k => [k, parseFloat(slider(k).value) || 0]));

// Compare: [label, field, 1 = higher is better / -1 = lower is better, formatter]
const CMP_ROWS = [
  ['Fit score (your weights)', 'fit', 1, v => v.toFixed(0)],
  ['Est. trainee start', 'trainee', 1, v => fmt$(v)],
  ['Take-home /mo (after tax)', 'net', 1, v => fmt$(v)],
  ['Left after 2BR rent /mo', 'afterRent', 1, v => fmt$(v)],
  ['Rent % of take-home', 'rentPct', -1, v => v.toFixed(0) + '%'],
  ['2BR avg rent', 'rent2', -1, v => fmt$(v)],
  ['Median home', 'home', -1, v => fmt$(v)],
  ['Cost vs Warrenton', 'colDelta', -1, v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%'],
  ['Price index', 'index', -1, v => fmtN(v, 1)],
  ['CPC entry pay', 'entry', 1, v => fmt$(v)],
  ['Violent crime /100k', 'crime', -1, v => fmtN(v)],
  ['Median household income (city)', 'income', 1, v => fmt$(v)],
  ['Miles from Warrenton', 'miles', -1, v => fmtN(v)],
  ['Trail miles (10 mi)', 'trail_mi', 1, v => fmtN(v)],
  ['Park acres (10 mi)', 'park_ac', 1, v => fmtN(v)],
  ['Staffed % (lower = more need)', 'staff', -1, v => v + '%'],
  ['Training success (123ATC)', 'train', 1, v => v + '%'],
];
function renderCompare() {
  const panel = $('cmp');
  const sel = state.sel.map(c => byCode.get(c)).filter(Boolean);
  if (!sel.length) { panel.style.display = 'none'; panel.innerHTML = ''; return; }
  panel.style.display = 'block';
  let html = `<div class="cmp-h"><span>Compare (${sel.length} of 3)</span><button type="button" class="cmp-clear" id="cmpClear">Clear</button></div>`;
  if (sel.length < 3) html += `<div class="cmp-note">${sel.length < 2 ? 'Select at least 2 facilities in the list to compare. ' : ''}Up to 3 can be compared.</div>`;
  else html += `<div class="cmp-note">Max 3 selected. Uncheck one to swap.</div>`;
  html += `<div class="table-scroll"><table class="cmp-t"><thead><tr><th class="l"></th>${sel.map(r => `<th>${r.code}<div class="cmp-name">${esc(r.name)}</div></th>`).join('')}</tr></thead><tbody>`;
  CMP_ROWS.forEach(([label, key, dir, f]) => {
    const vals = sel.map(r => r[key]);
    const nums = vals.filter(v => v != null);
    const distinct = new Set(nums).size;
    const best = (nums.length >= 2 && distinct > 1) ? (dir > 0 ? Math.max(...nums) : Math.min(...nums)) : null;
    html += `<tr><td class="l">${label}</td>${vals.map((v, i) => {
      const isBest = best != null && v === best;
      return `<td class="${isBest ? 'best' : ''}">${v == null ? NA : f(v)}${key === 'crime' ? borrowFlag(sel[i]) : ''}</td>`;
    }).join('')}</tr>`;
  });
  html += `</tbody></table></div>`;
  panel.innerHTML = html;
  $('cmpClear').onclick = () => { state.sel = []; changed(); };
}

const fitColor = f => f == null ? '#4b5670' : f >= 70 ? '#39d98a' : f >= 40 ? '#ffb547' : '#ff6b6b';
const mapOpen = () => $('mapbox').style.display !== 'none';
function drawMap(list) {
  lastList = list;
  if (!mapOpen()) return;
  const W = weights();
  $('mapWeights').textContent = 'Your weights: ' + WEIGHTS.map(([k, , label]) => `${label} ${W[k]}`).join(' · ');
  const k = view.w / 960; // dot and label size scales with zoom so dots spread out instead of just getting bigger
  const scored = list.filter(r => MAP.points[r.code] && !overLevel(r, state.maxLevel));
  const top = new Set(scored.filter(r => r.fit != null).sort((a, b) => b.fit - a.fit).slice(0, 20).map(r => r.code));
  let s = MAP.states.map(d => `<path class="st" d="${d}"/>`).join('');
  for (const r of scored) {
    const [x, y] = MAP.points[r.code];
    const f = r.fit == null ? '' : Math.round(r.fit);
    const fs = (9 * k).toFixed(2), ls = (11 * k).toFixed(2);
    s += `<g class="pt" data-c="${r.code}"><title>${r.code} · Level ${r.level}${r.fit == null ? '' : ' · Fit ' + Math.round(r.fit)}</title><circle cx="${x}" cy="${y}" r="${(10 * k).toFixed(2)}" fill="${fitColor(r.fit)}"></circle><text class="fv" style="font-size:${fs}px" x="${x}" y="${(y + 3 * k).toFixed(2)}">${f}</text>${top.has(r.code) ? `<text class="lb" style="font-size:${ls}px;stroke-width:${(3 * k).toFixed(2)}px" x="${x}" y="${(y - 13 * k).toFixed(2)}" text-anchor="middle">${r.code}</text>` : ''}</g>`;
  }
  $('usmap').innerHTML = s;
}
function applyView() {
  view.h = view.w * 600 / 960;
  view.x = Math.max(-200, Math.min(960 - view.w + 200, view.x));
  view.y = Math.max(-100, Math.min(600 - view.h + 100, view.y));
  $('usmap').setAttribute('viewBox', `${view.x.toFixed(1)} ${view.y.toFixed(1)} ${view.w.toFixed(1)} ${view.h.toFixed(1)}`);
  drawMap(lastList);
}
function zoomAt(factor, px, py) { // px,py = fraction of the visible map (0-1) to keep fixed
  const cx = view.x + px * view.w, cy = view.y + py * view.h;
  const nw = Math.max(120, Math.min(960, view.w * factor));
  view.x = cx - px * nw; view.y = cy - py * (nw * 600 / 960); view.w = nw;
  applyView(); onChange();
}
function zoomPreset(which) {
  const pts = Object.values(MAP.points);
  if (which === 'full') { view.x = 0; view.y = 0; view.w = 960; applyView(); onChange(); return; }
  let sel = pts;
  if (which === 'east') sel = pts.filter(([x]) => x >= 600);
  if (which === 'ne') sel = pts.filter(([x, y]) => x >= 640 && y <= 330);
  if (which === 'se') sel = pts.filter(([x, y]) => x >= 600 && y > 330);
  const xs = sel.map(p => p[0]), ys = sel.map(p => p[1]);
  const pad = 30;
  const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
  const w = Math.max(x1 - x0, (y1 - y0) * 960 / 600);
  view.w = Math.min(960, w); view.x = (x0 + x1) / 2 - view.w / 2; view.y = (y0 + y1) / 2 - view.w * 600 / 960 / 2;
  applyView(); onChange();
}
(function wireMapZoom() {
  const svg = $('usmap');
  $('zIn').onclick = () => zoomAt(0.7, 0.5, 0.5);
  $('zOut').onclick = () => zoomAt(1 / 0.7, 0.5, 0.5);
  document.querySelectorAll('.zoombar [data-z]').forEach(b => b.onclick = () => zoomPreset(b.dataset.z));
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    // scale by how far the wheel/trackpad moved, so small trackpad deltas zoom gently
    const step = Math.exp(Math.max(-0.08, Math.min(0.08, e.deltaY * 0.0025)));
    zoomAt(step, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  }, { passive: false });
  let drag = null, moved = false;
  svg.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; moved = false; });
  window.addEventListener('pointermove', e => {
    if (!drag) return;
    const r = svg.getBoundingClientRect();
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!moved && Math.hypot(dx, dy) < 5) return;
    moved = true; svg.classList.add('dragging');
    view.x = drag.vx - dx * view.w / r.width;
    view.y = drag.vy - dy * view.h / r.height;
    applyView();
  });
  window.addEventListener('pointerup', () => { if (drag && moved) onChange(); drag = null; svg.classList.remove('dragging'); });
  // a drag should not count as a dot click
  svg.addEventListener('click', e => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
})();
function showMap(show) {
  $('mapbox').style.display = show ? 'block' : 'none';
  $('mapBtn').textContent = show ? 'Hide map' : 'Show on map';
}

function render() {
  const totalW = computeFit(rows, weights());
  $('wtot').textContent = `Points left: ${100 - totalW} of 100`;
  const list = filterSort(rows, state);
  const over = r => overLevel(r, state.maxLevel);
  $('count').textContent = `${list.length} of ${rows.length} facilities`;
  $('b').innerHTML = list.map(r => `
    <tr data-c="${r.code}" class="${over(r) ? 'over' : ''}">
      <td class="ck"><input type="checkbox" class="cmp" data-c="${r.code}" ${state.sel.includes(r.code) ? 'checked' : ''} aria-label="Compare"></td>
      <td class="l"><span class="code">${r.code}</span>${esc(r.name)}<span class="tag ${r.inR ? 'in' : ''}">${r.inR ? 'PA–SC' : r.st}</span></td>
      <td>${r.fit == null ? NA : `<b>${r.fit.toFixed(0)}</b> <span class="na" style="font-size:11px">(${r.cover.toFixed(0)}% scored)</span>`}</td>
      <td>${fmtN(r.miles)}</td>
      <td>${fmtN(r.trail_mi)}</td>
      <td>${fmtN(r.park_ac)}</td>
      <td>${r.staff == null ? NA : `<span class="bar"><i style="width:${Math.min(r.staff, 100)}%;background:${barColor(r.staff)}"></i></span>${r.staff}%`}${staleFlag(r, 'staff')}</td>
      <td>${r.target ?? NA}${staleFlag(r, 'target')}</td>
      <td>${r.level ?? NA}${staleFlag(r, 'level')}</td>
      <td class="${r.colDelta == null ? '' : r.colDelta < 0 ? 'neg' : r.colDelta > 0.5 ? 'pos' : ''}">${r.colDelta == null ? NA : (r.colDelta >= 0 ? '+' : '') + r.colDelta.toFixed(1) + '%'}</td>
      <td>${fmtN(r.index, 1)}</td>
      <td>${fmt$(r.trainee)}</td>
      <td>${r.train == null ? NA : r.train + '%'}${staleFlag(r, 'train')}</td>
      <td>${fmt$(r.net)}</td>
      <td class="${r.afterRent == null ? '' : r.afterRent < 0 ? 'pos' : 'neg'}">${r.afterRent == null ? NA : fmt$(r.afterRent)}</td>
      <td>${r.rentPct == null ? NA : r.rentPct.toFixed(0) + '%'}</td>
      <td>${fmt$(r.entry)}${staleFlag(r, 'entry')}</td>
      <td>${r.grade ? `<span class="pill ${gradeClass(r.grade)}">${r.grade}</span>` : NA}</td>
      <td>${fmtN(r.crime)}${borrowFlag(r)}</td>
      <td>${fmt$(r.home)}</td>
      <td>${fmt$(r.rent2)}</td>
      <td>${fmt$(r.income)}</td>
      <td class="l">${leanHTML(r.lean)}</td>
      <td class="l">${r.lat == null ? NA : `<a href="https://www.strava.com/heatmap#11/${r.lon}/${r.lat}/hot/all" target="_blank" rel="noopener" style="color:var(--accent)">open ↗</a>`}</td>
      <td class="l">${esc(r.sports)}</td>
    </tr>`).join('');
  renderCompare();
  drawMap(list);
  document.querySelectorAll('#t th').forEach(th => {
    th.classList.toggle('sorted', th.dataset.k === state.sortK);
    th.classList.toggle('desc', th.dataset.k === state.sortK && state.dir < 0);
  });
}
// A user edit: redraw, then tell cloud.js the working settings changed.
function changed() { render(); onChange(); }

document.querySelectorAll('#t th').forEach(th => th.addEventListener('click', () => {
  const k = th.dataset.k; if (!k) return;
  if (state.sortK === k) state.dir *= -1; else { state.sortK = k; state.dir = 1; }
  changed();
}));
$('q').addEventListener('input', e => { state.q = e.target.value; changed(); });
const syncWeightLabels = () => WKEYS.forEach(k => { $('v_' + WID[k]).textContent = slider(k).value; });
// Fixed pool of 100 points: a slider can't take more than what the others leave.
WKEYS.forEach(k => slider(k).addEventListener('input', e => {
  const others = WKEYS.filter(x => x !== k).reduce((a, x) => a + parseFloat(slider(x).value), 0);
  if (parseFloat(e.target.value) > 100 - others) e.target.value = 100 - others;
  syncWeightLabels();
  changed();
}));
// -/+ buttons nudge a slider by 5 points, same 100-point pool rule.
document.querySelectorAll('.nudge').forEach(btn => btn.addEventListener('click', () => {
  const el = $(btn.dataset.for);
  const others = WKEYS.map(slider).filter(x => x !== el).reduce((a, x) => a + parseFloat(x.value), 0);
  el.value = Math.max(0, Math.min(parseFloat(el.value) + parseFloat(btn.dataset.d), 100 - others));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}));

$('b').addEventListener('click', e => {
  if (e.target.closest('a')) return;
  const cb = e.target.closest('input.cmp');
  if (cb) {
    const code = cb.dataset.c;
    if (cb.checked) {
      if (state.sel.length >= 3) { cb.checked = false; return; }
      if (!state.sel.includes(code)) state.sel.push(code);
    } else state.sel = state.sel.filter(c => c !== code);
    changed(); return;
  }
  const tr = e.target.closest('tr'); if (tr) openDetail(tr.dataset.c);
});
function openDetail(code) {
  const r = byCode.get(code); if (!r) return;
  const staleNote = r.stale ? `<div class="note"><b>Stale:</b> ${Object.entries(r.stale).map(([f, d]) => `${esc(f)} last seen ${esc(d)}`).join(', ')}. These were blank at 123ATC in the latest refresh, so the last good values are shown.</div>` : '';
  const borrowNote = r.crimeFrom ? `<div class="note"><b>Borrowed crime figure:</b> the rate shown is ${esc(r.crimeFrom)}'s, not this airport's own town, which has no usable FBI figure.</div>` : '';
  $('dbody').innerHTML = `
    <h2>${r.code} — ${esc(r.name)}</h2>
    <div class="sub">${r.st} · Level ${r.level} · ${r.inR ? 'in your PA–SC range' : 'outside PA–SC range'}</div>
    <div class="kv">
      <div>Straight-line miles from Warrenton</div><div>${fmtN(r.miles)} mi</div>
      <div>Trail miles within 10 mi (OSM)</div><div>${fmtN(r.trail_mi)}</div>
      <div>Park acres within 10 mi (OSM)</div><div>${fmtN(r.park_ac)}</div>
      <div>CPC target / staffed</div><div>${r.target} · ${r.staff}%</div>
      <div>Training success (123ATC)</div><div>${r.train == null ? '—' : r.train + '%'}</div>
      <div>Cost vs Warrenton</div><div>${r.colDelta == null ? '—' : (r.colDelta >= 0 ? '+' : '') + r.colDelta.toFixed(1) + '%'}</div>
      <div>Price index</div><div>${r.index ?? '—'}</div>
      <div>CPC entry pay</div><div>${fmt$(r.entry)}</div>
      <div>Est. trainee start</div><div>${fmt$(r.trainee)}</div>
      <div>Take-home per month (after tax, est.)</div><div>${fmt$(r.net)}</div>
      <div>Left after 2BR rent per month</div><div class="${r.afterRent != null && r.afterRent < 0 ? 'pos' : 'neg'}">${fmt$(r.afterRent)}</div>
      <div>Safety grade (derived)</div><div>${r.grade || '—'}</div>
      <div>Violent crime /100k (2024)${r.crimeFrom ? ' (borrowed)' : ''}</div><div>${fmtN(r.crime)}</div>
      <div>Median home (latest)</div><div>${fmt$(r.home)}</div>
      <div>2BR avg rent (Sep 2026)</div><div>${fmt$(r.rent2)}</div>
      <div>Median household income, city (2020–24)</div><div>${fmt$(r.income)}</div>
      <div>Political lean (county avg, 2020+2024)</div><div>${r.lean || '—'}</div>
      <div>2020 margin (county)</div><div>${r.m2020 == null ? '—' : (r.m2020 > 0 ? 'D+' : 'R+') + Math.abs(r.m2020).toFixed(1)}</div>
      <div>2024 margin (county)</div><div>${r.m2024 == null ? '—' : (r.m2024 > 0 ? 'D+' : 'R+') + Math.abs(r.m2024).toFixed(1)}</div>
      <div>Fit score (your weights)</div><div>${r.fit == null ? '—' : r.fit.toFixed(0) + ' / 100'}</div>
      <div>Strava heatmap</div><div><a href="https://www.strava.com/heatmap#11/${r.lon}/${r.lat}/hot/all" target="_blank" rel="noopener" style="color:var(--accent)">open at this airport ↗</a></div>
    </div>
    ${r.sports ? `<div class="note"><b>Sports:</b> ${esc(r.sports)}</div>` : ''}
    ${borrowNote}${staleNote}
    <div class="note">Trainee pay is an estimate (57.5% of CPC entry). Crime, home, and rent are from the sources in the footer. Lean and sports are first-pass estimates, not verified against election results.</div>`;
  $('drawer').classList.add('open');
}
$('dx').addEventListener('click', () => $('drawer').classList.remove('open'));

const LVLS = [...new Set(rows.map(r => r.level).filter(x => x != null))].sort((a, b) => a - b);
$('fLevel').insertAdjacentHTML('beforeend', LVLS.map(l => `<option value="${l}">${l}</option>`).join(''));
$('fLevel').addEventListener('change', e => { state.maxLevel = e.target.value === '' ? null : parseFloat(e.target.value); changed(); });
$('fRegion').addEventListener('change', e => { state.region = e.target.value; changed(); });
$('fStaff').addEventListener('change', e => { state.maxStaff = e.target.value === '' ? null : parseFloat(e.target.value); changed(); });
$('mapBtn').addEventListener('click', () => { showMap(!mapOpen()); changed(); });
$('mapClose').addEventListener('click', () => { showMap(false); changed(); });
$('usmap').addEventListener('click', e => { const g = e.target.closest('g[data-c]'); if (g) openDetail(g.dataset.c); });

// ---- settings <-> UI. This object is exactly what a saved scenario stores.
export function getSettings() {
  return { v: 1, weights: weights(),
    filters: { q: state.q, region: state.region, maxLevel: state.maxLevel, maxStaff: state.maxStaff },
    sort: { k: state.sortK, dir: state.dir }, sel: [...state.sel],
    map: { open: mapOpen(), x: Math.round(view.x * 10) / 10, y: Math.round(view.y * 10) / 10, w: Math.round(view.w * 10) / 10 } };
}
const setSelect = (el, v) => { el.value = v == null ? '' : String(v); if (el.value !== (v == null ? '' : String(v))) el.value = ''; };
export function applySettings(raw) {
  const s = sanitizeSettings(raw, KNOWN);
  WKEYS.forEach(k => { slider(k).value = 0; });
  WKEYS.forEach(k => { slider(k).value = s.weights[k]; });
  syncWeightLabels();
  Object.assign(state, { q: s.filters.q, region: s.filters.region, maxLevel: s.filters.maxLevel, maxStaff: s.filters.maxStaff,
    sortK: s.sort.k, dir: s.sort.dir, sel: [...s.sel] });
  $('q').value = state.q;
  setSelect($('fRegion'), state.region); state.region = $('fRegion').value;
  setSelect($('fLevel'), state.maxLevel); if ($('fLevel').value === '') state.maxLevel = null;
  setSelect($('fStaff'), state.maxStaff); if ($('fStaff').value === '') state.maxStaff = null;
  Object.assign(view, { x: s.map.x, y: s.map.y, w: s.map.w });
  showMap(s.map.open);
  render();
  applyView();
}

applySettings(defaultSettings());
initCloud({ getSettings, applySettings, snapshot: DATA.snapshot, setOnChange: fn => { onChange = fn; } });
