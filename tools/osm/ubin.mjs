#!/usr/bin/env node
// Pulau Ubin map for the first off-road trail (src/courses/ubintrail.ts).
// Reads the raw Overpass extract in data/osm/ubin/raw.json.gz and writes a
// small, cleaned map in local metres (x east, z south) to
// public/maps/ubin.json: the island outlines, quarries and ponds, wetland
// and beaches, every lane, track and path with its name and surface, the
// building outlines, and the named places (camp sites, viewpoints, jetty).
//
// This is separate from tools/osm/import.mjs on purpose: Ubin has no road
// network to redraw (narrow lanes and dirt tracks, no markings, no
// junction shapes), so none of the mainland road builder is used.
//
// Map data © OpenStreetMap contributors, ODbL 1.0.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(HERE, '..', '..', 'data', 'osm', 'ubin', 'raw.json.gz');
const OUT = path.join(HERE, '..', '..', 'public', 'maps', 'ubin.json');

// Local origin: the middle of the west half of Pulau Ubin.
const LAT0 = 1.4095;
const LON0 = 103.9555;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const KZ = 110574;
// The part of the world that is built (metres). Everything outside is sea
// or far scenery.
const BOUNDS = { minX: -1800, maxX: 2400, minZ: -1400, maxZ: 1400 };

const xy = (p) => [+((p.lon - LON0) * KX).toFixed(1), +(-(p.lat - LAT0) * KZ).toFixed(1)];

const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(SRC)).toString());
const els = raw.elements;

const inBox = (pts, pad = 0) =>
  pts.some(([x, z]) => x > BOUNDS.minX - pad && x < BOUNDS.maxX + pad && z > BOUNDS.minZ - pad && z < BOUNDS.maxZ + pad);

/** Douglas-Peucker. */
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, az] = pts[a];
    const [bx, bz] = pts[b];
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    let best = -1;
    let bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / len;
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (best > tol) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Douglas-Peucker on a closed ring (first point repeated or not): split at the far point. */
function simplifyRing(pts, tol) {
  const r = ringOf(pts);
  if (r.length < 4) return r;
  let far = 0;
  let best = -1;
  for (let i = 1; i < r.length; i++) {
    const d = Math.hypot(r[i][0] - r[0][0], r[i][1] - r[0][1]);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = simplify(r.slice(0, far + 1), tol);
  const b = simplify(r.slice(far).concat([r[0]]), tol);
  return a.concat(b.slice(1, -1));
}

/** Join way pieces end to end into rings (or long lines where they don't close). */
function joinPieces(pieces) {
  const left = pieces.map((p) => p.slice());
  const out = [];
  const key = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  while (left.length) {
    let line = left.pop();
    let grew = true;
    while (grew && key(line[0]) !== key(line[line.length - 1])) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const p = left[i];
        const end = key(line[line.length - 1]);
        const start = key(line[0]);
        if (key(p[0]) === end) line = line.concat(p.slice(1));
        else if (key(p[p.length - 1]) === end) line = line.concat(p.slice().reverse().slice(1));
        else if (key(p[p.length - 1]) === start) line = p.concat(line.slice(1));
        else if (key(p[0]) === start) line = p.slice().reverse().concat(line.slice(1));
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    out.push(line);
  }
  return out;
}

const area = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % pts.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
};
const ringOf = (pts) => {
  const r = pts.slice();
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
  return r;
};
const centre = (pts) => [
  +(pts.reduce((s, p) => s + p[0], 0) / pts.length).toFixed(1),
  +(pts.reduce((s, p) => s + p[1], 0) / pts.length).toFixed(1),
];

// ---- Islands: the outer members of each island relation, joined ----
const land = [];
for (const e of els) {
  const t = e.tags ?? {};
  if (e.type !== 'relation' || !['island', 'islet'].includes(t.place)) continue;
  const pieces = e.members.filter((m) => m.role === 'outer' && m.geometry).map((m) => m.geometry.filter(Boolean).map(xy));
  for (const ring of joinPieces(pieces)) {
    const r = simplifyRing(ring, 1.5);
    if (r.length < 4 || !inBox(r, 400)) continue;
    land.push({ name: t.name ?? '', pts: r });
  }
}
// Islets drawn as a single closed way.
for (const e of els) {
  const t = e.tags ?? {};
  if (e.type !== 'way' || !(['island', 'islet'].includes(t.place) || (t.natural === 'coastline' && e.geometry?.length > 3))) continue;
  const g = e.geometry.filter(Boolean).map(xy);
  const closed = g.length > 3 && g[0][0] === g[g.length - 1][0] && g[0][1] === g[g.length - 1][1];
  if (!closed || !inBox(g, 400)) continue;
  const r = simplifyRing(g, 1);
  if (Math.abs(area(r)) < 30) continue;
  if (land.some((l) => Math.abs(area(l.pts) - area(r)) < 1)) continue;
  land.push({ name: t.name ?? '', pts: r });
}

// ---- Areas: water, wetland, beach, wood ----
const areas = [];
const addArea = (kind, pts, name) => {
  const r = simplifyRing(pts, 0.8);
  if (r.length < 3 || !inBox(r) || Math.abs(area(r)) < 20) return;
  areas.push({ kind, name: name ?? '', pts: r });
};
const areaKind = (t) => {
  if (t.natural === 'water' || t.water || t.landuse === 'reservoir' || t.landuse === 'basin') return 'water';
  if (t.natural === 'wetland') return 'wetland';
  if (t.natural === 'beach' || t.natural === 'sand') return 'beach';
  if (t.natural === 'wood' || t.landuse === 'forest') return 'wood';
  if (t.natural === 'rock' || t.natural === 'bare_rock') return 'rock';
  if (t.landuse === 'grass' || t.leisure === 'park' || t.leisure === 'pitch') return 'grass';
  return null;
};
for (const e of els) {
  const t = e.tags ?? {};
  const kind = areaKind(t);
  if (!kind) continue;
  if (e.type === 'way' && e.geometry) {
    const g = e.geometry.filter(Boolean).map(xy);
    if (g.length > 3 && g[0][0] === g[g.length - 1][0] && g[0][1] === g[g.length - 1][1]) addArea(kind, g, t.name);
  } else if (e.type === 'relation') {
    const pieces = (e.members ?? []).filter((m) => m.role === 'outer' && m.geometry).map((m) => m.geometry.filter(Boolean).map(xy));
    for (const ring of joinPieces(pieces)) {
      if (ring.length > 3 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) addArea(kind, ring, t.name);
    }
  }
}

// ---- Lanes, tracks and paths ----
// [width m, kind]. Ubin's lanes are narrow single-track concrete or
// asphalt; tracks are dirt; paths are footpaths and bike trails.
const WAYS = {
  primary: [6, 'lane'], secondary: [6, 'lane'], tertiary: [5, 'lane'], unclassified: [4.5, 'lane'],
  residential: [4.2, 'lane'], service: [3.6, 'lane'], track: [3.4, 'track'],
  cycleway: [2.2, 'path'], footway: [1.8, 'path'], path: [1.6, 'path'], bridleway: [2, 'path'],
};
const roads = [];
for (const e of els) {
  const t = e.tags ?? {};
  if (e.type !== 'way' || !WAYS[t.highway] || !e.geometry) continue;
  if (t.area === 'yes') continue;
  const g = e.geometry.filter(Boolean).map(xy);
  if (g.length < 2 || !inBox(g)) continue;
  const [width, kind] = WAYS[t.highway];
  const surface = t.surface ?? (kind === 'lane' ? 'asphalt' : kind === 'track' ? 'dirt' : 'ground');
  roads.push({
    id: e.id,
    name: t.name ?? '',
    kind,
    hw: t.highway,
    surface,
    bridge: t.bridge === 'yes' || undefined,
    width: +(t.width && !isNaN(+t.width) ? Math.min(+t.width, 7) : width).toFixed(1),
    // (Every node kept, so nodes[i] is pts[i]: the route is found on them.)
    nodes: e.nodes,
    pts: g,
  });
}

// ---- Buildings ----
const buildings = [];
for (const e of els) {
  const t = e.tags ?? {};
  if (!t.building || e.type !== 'way' || !e.geometry) continue;
  const g = simplifyRing(e.geometry.filter(Boolean).map(xy), 0.3);
  if (g.length < 3 || !inBox(g)) continue;
  buildings.push({ pts: g, levels: +(t['building:levels'] ?? 1) || 1, kind: t.building });
}

// ---- Piers ----
const piers = [];
for (const e of els) {
  const t = e.tags ?? {};
  if (t.man_made !== 'pier' || e.type !== 'way' || !e.geometry) continue;
  const g = e.geometry.filter(Boolean).map(xy);
  if (!inBox(g)) continue;
  piers.push({ name: t.name ?? '', pts: g });
}

// ---- Named places ----
const pois = [];
for (const e of els) {
  const t = e.tags ?? {};
  let kind = null;
  if (t.tourism === 'camp_site') kind = 'camp';
  else if (t.tourism === 'viewpoint') kind = 'view';
  else if (t.natural === 'peak') kind = 'peak';
  else if (t.amenity === 'shelter' && t.name) kind = 'hut';
  else if (t.place === 'village' || t.place === 'quarter' || t.place === 'locality') kind = 'place';
  else if (t.natural === 'water' && t.name && /quar/i.test(t.name)) kind = 'quarry';
  else if (t.amenity === 'place_of_worship' && t.name) kind = 'temple';
  if (!kind) continue;
  let c = null;
  if (e.lat != null) c = xy(e);
  else if (e.geometry) c = centre(e.geometry.filter(Boolean).map(xy));
  else if (e.bounds) c = xy({ lat: (e.bounds.minlat + e.bounds.maxlat) / 2, lon: (e.bounds.minlon + e.bounds.maxlon) / 2 });
  if (!c || !inBox([c])) continue;
  pois.push({ kind, name: t.name ?? '', x: c[0], z: c[1] });
}

const out = {
  origin: [LAT0, LON0],
  bounds: BOUNDS,
  attribution: 'Map data © OpenStreetMap contributors',
  land,
  areas,
  roads,
  buildings,
  piers,
  pois,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
if (!process.argv.includes('--quiet'))
  console.log(
    `ubin.json: ${land.length} land rings, ${areas.length} areas, ${roads.length} ways, ${buildings.length} buildings, ${pois.length} places, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`,
  );
