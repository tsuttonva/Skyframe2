import fs from 'fs';
import * as topojson from 'topojson-client';
import * as d3 from 'd3-geo';
const us = JSON.parse(fs.readFileSync('node_modules/us-atlas/states-10m.json','utf8'));
const states = topojson.feature(us, us.objects.states);
const W=960, H=600;
const proj = d3.geoAlbersUsa().fitSize([W,H], states);
const path = d3.geoPath(proj);
const statePaths = states.features.map(f => path(f)).filter(Boolean).map(d => d.length? d : '');
const pts = JSON.parse(fs.readFileSync('coords.json','utf8'));
const points = {};
for (const [code, lat, lon] of pts) {
  if (lat==null || lon==null) continue;
  const p = proj([lon, lat]);
  if (p) points[code] = [Math.round(p[0]*10)/10, Math.round(p[1]*10)/10];
}
const wp = proj([-77.7950, 38.7135]);
const out = { W, H, statePaths: statePaths.map(d => d.replace(/(\d+\.\d)\d+/g,'$1')), points, warrenton: [Math.round(wp[0]*10)/10, Math.round(wp[1]*10)/10] };
fs.writeFileSync('map.json', JSON.stringify(out));
console.log('states', statePaths.length, 'points', Object.keys(points).length, 'size', fs.statSync('map.json').size);
