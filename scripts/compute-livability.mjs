#!/usr/bin/env node
/**
 * compute-livability.mjs -- Reconstructs the Livability Score for geocoded props.
 *
 * The original compute script was never committed (a one-off run). This rebuild
 * mirrors the recovered formula: livability_score = round(mean of 5 components),
 * each 0-100 (higher = better), stored in livability_detail:
 *   noise, flood, crime, subte, transport
 *
 * Sources (public/data/): ruido_diurno.geojson (dBA polygons), anegamiento.geojson
 * (flood-risk polygons), crime_barrios.json (per-barrio counts), subte_stations.json,
 * transporte_heatmap.json (transit density points).
 *
 * Usage:
 *   node scripts/compute-livability.mjs --validate [--limit N]   # dry-run vs stored values
 *   node scripts/compute-livability.mjs [--limit N]              # write active props missing a score
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'public', 'data');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ysynltkotzizayjtoujf.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const args = process.argv.slice(2);
const VALIDATE = args.includes('--validate');
const limIdx = args.indexOf('--limit');
const LIMIT = limIdx !== -1 ? parseInt(args[limIdx + 1]) : (VALIDATE ? 400 : 1000);

const load = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));

// ---------- geometry helpers ----------
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
// polygon = array of rings ([outer, holes...]); multipolygon = array of polygons
function pointInGeom(lon, lat, geom) {
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  for (const poly of polys) {
    if (pointInRing(lon, lat, poly[0])) {
      let inHole = false;
      for (let h = 1; h < poly.length; h++) if (pointInRing(lon, lat, poly[h])) { inHole = true; break; }
      if (!inHole) return true;
    }
  }
  return false;
}
function bboxOfGeom(geom) {
  let minx = 180, miny = 90, maxx = -180, maxy = -90;
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  for (const poly of polys) for (const [x, y] of poly[0]) {
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  return [minx, miny, maxx, maxy];
}
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const norm = s => (s || '').toString().toUpperCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\./g, '').replace(/\s+/g, ' ').trim();

// ---------- load datasets + precompute ----------
const ruido = load('ruido_diurno.geojson').features.map(f => ({ dba: f.properties.dba, bbox: bboxOfGeom(f.geometry), geom: f.geometry }));
const flood = load('anegamiento.geojson').features.map(f => ({ riesgo: norm(f.properties.riesgo), bbox: bboxOfGeom(f.geometry), geom: f.geometry }));
const crimeRaw = load('crime_barrios.json');
const subte = load('subte_stations.json').map(s => ({ lat: s.lat, lon: s.lon }));
const transit = load('transporte_heatmap.json'); // [[lat,lon],...]

// crime: normalize per-barrio total to 0-100 (higher=safer). Log-scale so the
// worst barrios do not crush everyone; anchored on the observed spread.
const crimeTotals = Object.entries(crimeRaw).map(([b, v]) => [norm(b), Math.log10((v.total || 0) + 1)]);
const cVals = crimeTotals.map(x => x[1]);
const cMin = Math.min(...cVals), cMax = Math.max(...cVals);
const crimeByBarrio = new Map(crimeTotals.map(([b, lv]) => [b, Math.round(100 * (1 - (lv - cMin) / (cMax - cMin || 1)))]));

// ---------- component scorers (0-100, higher=better) ----------
function scoreNoise(lat, lon) {
  // Inside a dBA polygon -> penalise by level; otherwise quiet.
  for (const r of ruido) {
    if (lon < r.bbox[0] || lon > r.bbox[2] || lat < r.bbox[1] || lat > r.bbox[3]) continue;
    if (pointInGeom(lon, lat, r.geom)) return clamp(Math.round(100 - (r.dba - 40) * 3), 0, 100);
  }
  return 100;
}
function scoreFlood(lat, lon) {
  for (const f of flood) {
    if (lon < f.bbox[0] || lon > f.bbox[2] || lat < f.bbox[1] || lat > f.bbox[3]) continue;
    if (pointInGeom(lon, lat, f.geom)) {
      return f.riesgo === 'ALTO' ? 10 : f.riesgo === 'MODERADO' ? 40 : 70;
    }
  }
  return 100;
}
function scoreCrime(barrio) {
  const v = crimeByBarrio.get(norm(barrio));
  return v == null ? null : v; // null when the barrio is outside CABA (GBA Norte)
}
function nearestM(lat, lon, pts, isLatLon) {
  let best = Infinity;
  for (const p of pts) {
    const la = isLatLon ? p[0] : p.lat, lo = isLatLon ? p[1] : p.lon;
    const d = haversineM(lat, lon, la, lo);
    if (d < best) best = d;
  }
  return best;
}
function scoreSubte(lat, lon) {
  const d = nearestM(lat, lon, subte, false);
  // 100 at the station, 0 at >=1500m (matches old: 0 for GBA Norte, far from subte).
  return clamp(Math.round(100 * (1 - d / 1500)), 0, 100);
}
function scoreTransport(lat, lon) {
  const d = nearestM(lat, lon, transit, true);
  return clamp(Math.round(100 * (1 - d / 800)), 0, 100);
}

function computeAll(lat, lon, barrio) {
  const noise = scoreNoise(lat, lon);
  const fl = scoreFlood(lat, lon);
  const crime = scoreCrime(barrio);
  const subteS = scoreSubte(lat, lon);
  const transport = scoreTransport(lat, lon);
  // crime null (barrio outside CABA, e.g. GBA Norte) -> omit it and average over the
  // remaining components instead of storing a misleading 0 (which reads as "dangerous").
  const comps = { noise, flood: fl, subte: subteS, transport };
  if (crime != null) comps.crime = crime;
  const present = [noise, fl, crime, subteS, transport].filter(v => v != null);
  const score = Math.round(present.reduce((s, v) => s + v, 0) / present.length);
  return { score, detail: comps };
}

// ---------- run ----------
async function main() {
  console.log(`Livability compute -- mode: ${VALIDATE ? 'VALIDATE' : 'WRITE'}, limit ${LIMIT}`);
  console.log(`  datasets: ruido=${ruido.length} flood=${flood.length} crime=${crimeByBarrio.size} subte=${subte.length} transit=${transit.length}`);

  let q = sb.from('properties')
    .select('id,latitude,longitude,neighborhood,livability_score,livability_detail')
    .not('latitude', 'is', null);
  // Validate against the known-good rows (they are inactive now), so no is_active filter.
  if (VALIDATE) q = q.not('livability_detail', 'is', null).limit(LIMIT);
  else q = q.eq('is_active', true).is('livability_score', null).limit(LIMIT);

  const { data: props, error } = await q;
  if (error) { console.error(error.message); process.exit(1); }
  console.log(`  ${props.length} props to process\n`);

  if (VALIDATE) {
    let n = 0, sAbs = 0; const comps = { noise: 0, flood: 0, crime: 0, subte: 0, transport: 0 };
    const cN = { noise: 0, flood: 0, crime: 0, subte: 0, transport: 0 };
    for (const p of props) {
      const { score, detail } = computeAll(Number(p.latitude), Number(p.longitude), p.neighborhood);
      sAbs += Math.abs(score - p.livability_score); n++;
      for (const k of Object.keys(comps)) {
        const old = p.livability_detail?.[k]; if (old == null) continue;
        comps[k] += Math.abs(detail[k] - old); cN[k]++;
      }
    }
    console.log(`Score MAE vs stored: ${(sAbs / n).toFixed(1)} over ${n} props`);
    for (const k of Object.keys(comps)) console.log(`  ${k} MAE: ${(comps[k] / (cN[k] || 1)).toFixed(1)}`);
    return;
  }

  let done = 0;
  for (const p of props) {
    const { score, detail } = computeAll(Number(p.latitude), Number(p.longitude), p.neighborhood);
    const { error: uerr } = await sb.from('properties')
      .update({ livability_score: score, livability_detail: detail })
      .eq('id', p.id);
    if (uerr) console.error(`  ${p.id}: ${uerr.message}`); else done++;
    if (done % 100 === 0) console.log(`  ${done}/${props.length}`);
  }
  console.log(`\nDone. Wrote livability for ${done} props.`);
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
