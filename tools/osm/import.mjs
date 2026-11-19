#!/usr/bin/env node
// OSM import: turns raw OpenStreetMap data (Overpass JSON) into a compact,
// cleaned map the game builds from. OSM is used as a guide, not drawn
// directly:
//   - roads become a connected graph: ways are split at junctions, chains
//     of pieces between junctions are joined back into one edge, near-
//     duplicate junctions are merged, and each edge is simplified and
//     smoothed into an evenly spaced centreline;
//   - land use, water, the coastline and building outlines are kept as
//     simplified polygons that steer what the game generates.
//
// Usage:
//   node tools/osm/import.mjs fetch <name> <south> <west> <north> <east>
//        downloads from Overpass into tools/osm/raw/<name>.json
//   node tools/osm/import.mjs build <name> [lat0 lon0]
//        writes public/maps/<name>.json
//
// Map data © OpenStreetMap contributors, ODbL 1.0.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RAW = path.join(HERE, 'raw');
const OUT = path.join(HERE, '..', '..', 'public', 'maps');

// Road classes the car can drive, with carriageway width (m) and rank.
const ROADS = {
  motorway: [14, 6], trunk: [12, 5], primary: [10, 4], secondary: [9, 3], tertiary: [7.5, 2],
  unclassified: [6.5, 1], residential: [6.5, 1], living_street: [5.5, 1], service: [5, 0],
  motorway_link: [7, 4], trunk_link: [7, 4], primary_link: [7, 3], secondary_link: [7, 2], tertiary_link: [6, 2],
};
// Paths drawn as park connectors and footpaths (not part of the road graph).
const PATHS = new Set(['footway', 'cycleway', 'path', 'pedestrian']);

const QUERY = (s, w, n, e) => `[out:json][timeout:120];
(
  way["highway"](${s},${w},${n},${e});
  way["building"](${s},${w},${n},${e});
  way["landuse"](${s},${w},${n},${e});
  way["leisure"~"park|garden|pitch|playground|golf_course|nature_reserve"](${s},${w},${n},${e});
  way["natural"~"water|wood|wetland|beach|scrub|grassland|coastline"](${s},${w},${n},${e});
  way["waterway"~"canal|river|drain|stream"](${s},${w},${n},${e});
  way["amenity"~"parking"](${s},${w},${n},${e});
  nwr["amenity"="fuel"](${s},${w},${n},${e});
  relation["natural"="water"](${s},${w},${n},${e});
  relation["landuse"](${s},${w},${n},${e});
  relation["leisure"="park"](${s},${w},${n},${e});
);
out body;
>;
out skel qt;`;

async function fetchArea(name, s, w, n, e) {
  const body = new URLSearchParams({ data: QUERY(s, w, n, e) });
  const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body });
  if (!res.ok) throw new Error(`Overpass ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  json.bbox = [s, w, n, e];
  fs.mkdirSync(RAW, { recursive: true });
  fs.writeFileSync(path.join(RAW, `${name}.json`), JSON.stringify(json));
  console.log(`saved ${json.elements.length} elements`);
}

// ---------- geometry helpers ----------
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function simplify(pts, tol) {
  // Douglas-Peucker, keeping the ends.
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    const [ax, az] = pts[i0];
    const [bx, bz] = pts[i1];
    const len = Math.hypot(bx - ax, bz - az) || 1;
    let best = -1;
    let bi = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const d = Math.abs((bx - ax) * (az - pts[i][1]) - (ax - pts[i][0]) * (bz - az)) / len;
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (best > tol) {
      keep[bi] = 1;
      stack.push([i0, bi], [bi, i1]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Simplify a closed ring (first point repeated at the end). */
function simplifyRing(pts, tol) {
  if (pts.length < 5) return pts;
  let far = 1;
  for (let i = 1; i < pts.length - 1; i++) if (dist(pts[i], pts[0]) > dist(pts[far], pts[0])) far = i;
  const a = simplify(pts.slice(0, far + 1), tol);
  const b = simplify(pts.slice(far), tol);
  return a.concat(b.slice(1));
}

function chaikin(pts, rounds) {
  // Corner cutting with fixed ends: rounds off kinks between OSM nodes.
  let p = pts;
  for (let r = 0; r < rounds; r++) {
    if (p.length < 3) return p;
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i];
      const b = p[i + 1];
      // Don't cut into the very first and last segment ends much, so roads
      // still meet their junctions head on.
      if (i > 0) out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      if (i < p.length - 2) out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

function resample(pts, step) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = dist(a, b);
    let s = step - carry;
    while (s < len) {
      out.push([a[0] + ((b[0] - a[0]) * s) / len, a[1] + ((b[1] - a[1]) * s) / len]);
      s += step;
    }
    carry = len - (s - step);
  }
  const last = pts[pts.length - 1];
  if (dist(out[out.length - 1], last) < step * 0.4 && out.length > 1) out.pop();
  out.push(last);
  return out;
}

const ringArea = (pts) => {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return a / 2;
};
const q = (v) => Math.round(v * 10) / 10;
const qp = (pts) => pts.map(([x, z]) => [q(x), q(z)]);

// ---------- build ----------
export function build(raw, origin) {
  const nodes = new Map();
  const ways = [];
  const rels = [];
  const seenWay = new Set();
  const addWay = (wy) => {
    // "out geom" puts each node's position on the way itself.
    if (wy.geometry && wy.nodes) wy.nodes.forEach((id, i) => wy.geometry[i] && nodes.set(id, [wy.geometry[i].lat, wy.geometry[i].lon]));
    if (!seenWay.has(wy.id)) {
      seenWay.add(wy.id);
      ways.push(wy);
    }
  };
  for (const el of raw.elements) {
    if (el.type === 'node') nodes.set(el.id, [el.lat, el.lon]);
    else if (el.type === 'way') addWay(el);
    else if (el.type === 'relation') rels.push(el);
  }
  // Relation members may only exist inside the relation (with geometry but
  // no node ids): give them synthetic node ids from their positions.
  let synth = -1;
  const synthIds = new Map();
  for (const r of rels)
    for (const m of r.members ?? []) {
      if (m.type !== 'way' || seenWay.has(m.ref) || !m.geometry) continue;
      const ids = m.geometry.map((g) => {
        const k = `${g.lat.toFixed(7)},${g.lon.toFixed(7)}`;
        if (!synthIds.has(k)) {
          synthIds.set(k, synth);
          nodes.set(synth--, [g.lat, g.lon]);
        }
        return synthIds.get(k);
      });
      addWay({ id: m.ref, nodes: ids, tags: {} });
    }
  const [s, w, n, e] = raw.bbox ?? [0, 0, 0, 0];
  const lat0 = origin?.[0] ?? (s + n) / 2;
  const lon0 = origin?.[1] ?? (w + e) / 2;
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
  const kz = 110574;
  // x east, z south (game axes).
  const proj = (id) => {
    const ll = nodes.get(id);
    return ll ? [(ll[1] - lon0) * kx, -(ll[0] - lat0) * kz] : null;
  };
  const wayPts = (wy) => wy.nodes.map(proj).filter(Boolean);
  const byId = new Map(ways.map((wy) => [wy.id, wy]));

  // --- Road graph ---
  const roadWays = ways.filter((wy) => ROADS[wy.tags?.highway] && wy.tags?.area !== 'yes');
  const use = new Map(); // OSM node -> number of road-way visits (ends count once)
  for (const wy of roadWays)
    wy.nodes.forEach((id, i) => use.set(id, (use.get(id) ?? 0) + (i === 0 || i === wy.nodes.length - 1 ? 1 : 2)));
  // A node is a junction if it is an end, or shared by more than one way.
  const isJunction = (id, i, len) => i === 0 || i === len - 1 || use.get(id) > 2;
  const pieces = [];
  for (const wy of roadWays) {
    const [width, rank] = ROADS[wy.tags.highway];
    const lanes = +wy.tags.lanes || 0;
    const oneway = wy.tags.oneway === 'yes' || wy.tags.junction === 'roundabout';
    let cur = [wy.nodes[0]];
    for (let i = 1; i < wy.nodes.length; i++) {
      cur.push(wy.nodes[i]);
      if (isJunction(wy.nodes[i], i, wy.nodes.length)) {
        // Bridges keep their OSM layer (1 = one level up); viaducts are flagged.
        const bridge = wy.tags.bridge && wy.tags.bridge !== 'no';
        const level = bridge ? Math.max(1, Math.round(+wy.tags.layer || 1)) : wy.tags.tunnel && wy.tags.tunnel !== 'no' ? -1 : 0;
        const viaduct = wy.tags.bridge === 'viaduct' ? 1 : 0;
        pieces.push({ ids: cur, cls: wy.tags.highway, rank, width: lanes ? Math.max(width * 0.6, lanes * 3.3) : width, oneway, level, viaduct, name: wy.tags.name ?? '' });
        cur = [wy.nodes[i]];
      }
    }
  }
  // Join chains through nodes where exactly two pieces of the same class
  // meet (OSM often splits one street into many ways).
  const ends = new Map();
  pieces.forEach((p, i) => {
    for (const id of [p.ids[0], p.ids[p.ids.length - 1]]) {
      if (!ends.has(id)) ends.set(id, []);
      ends.get(id).push(i);
    }
  });
  const dead = new Set();
  for (const [id, list] of ends) {
    const live = list.filter((i) => !dead.has(i));
    if (live.length !== 2) continue;
    const [ia, ib] = live;
    if (ia === ib) continue;
    const a = pieces[ia];
    const b = pieces[ib];
    if (a.cls !== b.cls || a.oneway !== b.oneway || a.name !== b.name || a.level !== b.level || a.viaduct !== b.viaduct) continue;
    // Orient a to end at id, b to start at id.
    if (a.ids[a.ids.length - 1] !== id) a.ids.reverse();
    if (b.ids[0] !== id) {
      if (b.oneway) continue; // would flip a one-way street
      b.ids.reverse();
    }
    if (a.ids[a.ids.length - 1] !== id || b.ids[0] !== id) continue;
    a.ids = a.ids.concat(b.ids.slice(1));
    dead.add(ib);
    // b's far end now belongs to a.
    const far = b.ids[b.ids.length - 1];
    const fl = ends.get(far);
    if (fl) fl[fl.indexOf(ib)] = ia;
  }
  const edgesRaw = pieces.filter((_, i) => !dead.has(i));

  // Merge junction nodes closer than 4 m (OSM often has near-duplicates).
  const jPos = new Map();
  for (const p of edgesRaw) for (const id of [p.ids[0], p.ids[p.ids.length - 1]]) if (!jPos.has(id)) jPos.set(id, proj(id));
  const jIds = [...jPos.keys()];
  const jLevels = new Map(jIds.map((id) => [id, new Set()]));
  for (const p of edgesRaw) for (const id of [p.ids[0], p.ids[p.ids.length - 1]]) jLevels.get(id).add(p.level);
  let crossLevel = 0;
  const parent = new Map(jIds.map((id) => [id, id]));
  const find = (id) => (parent.get(id) === id ? id : (parent.set(id, find(parent.get(id))), parent.get(id)));
  const grid = new Map();
  for (const id of jIds) {
    const [x, z] = jPos.get(id);
    const k = `${Math.floor(x / 8)},${Math.floor(z / 8)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(id);
  }
  for (const id of jIds) {
    const [x, z] = jPos.get(id);
    const ci = Math.floor(x / 8);
    const cj = Math.floor(z / 8);
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++)
        for (const o of grid.get(`${ci + di},${cj + dj}`) ?? []) {
          if (o === id || dist(jPos.get(o), [x, z]) >= 4) continue;
          // (Never across levels: a junction up on a flyover and one on the
          // ground beneath it are two junctions, however close on the map.)
          if (![...jLevels.get(o)].some((lv) => jLevels.get(id).has(lv))) {
            crossLevel++;
            continue;
          }
          parent.set(find(o), find(id));
        }
  }
  if (crossLevel) console.log(`kept apart: ${crossLevel / 2} pairs of junctions at different levels`);
  const junctions = new Map(); // root -> { i, x, z, n }
  for (const id of jIds) {
    const r = find(id);
    const p = jPos.get(id);
    const j = junctions.get(r) ?? { x: 0, z: 0, n: 0 };
    j.x += p[0];
    j.z += p[1];
    j.n++;
    junctions.set(r, j);
  }
  let ji = 0;
  for (const j of junctions.values()) {
    j.x /= j.n;
    j.z /= j.n;
    j.i = ji++;
  }

  const edges = [];
  for (const p of edgesRaw) {
    const a = junctions.get(find(p.ids[0]));
    const b = junctions.get(find(p.ids[p.ids.length - 1]));
    let pts = p.ids.map(proj).filter(Boolean);
    if (pts.length < 2) continue;
    pts[0] = [a.x, a.z];
    pts[pts.length - 1] = [b.x, b.z];
    if (a === b && pts.length < 4) continue; // collapsed stub
    pts = simplify(pts, 0.8);
    pts = chaikin(pts, 2);
    // The game resamples evenly; ship only the points that shape the curve.
    pts = simplify(pts, 0.12);
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
    if (len < 3) continue;
    edges.push({ a: a.i, b: b.i, cls: p.cls, w: q(p.width), one: p.oneway ? 1 : 0, lv: p.level || undefined, vd: p.viaduct || undefined, name: p.name || undefined, pts: qp(pts) });
  }
  const jOut = [...junctions.values()].sort((u, v) => u.i - v.i).map((j) => [q(j.x), q(j.z)]);

  // --- Paths (park connectors, footpaths) ---
  const paths = ways
    .filter((wy) => PATHS.has(wy.tags?.highway) && wy.tags?.area !== 'yes')
    // (b: a bridge, which the game lifts over any road it crosses.)
    .map((wy) => ({ k: wy.tags.highway === 'cycleway' || wy.tags.bicycle === 'designated' ? 'cycle' : 'foot', ...(wy.tags.bridge === 'yes' || wy.tags.bridge === 'viaduct' ? { b: 1 } : {}), pts: qp(simplify(chaikin(simplify(wayPts(wy), 0.8), 2), 0.1)) }))
    .filter((p) => p.pts.length > 1);

  // --- Areas ---
  const kindOf = (t = {}) => {
    if (t.natural === 'water' || t.landuse === 'reservoir' || t.landuse === 'basin') return 'water';
    if (t.natural === 'wetland') return 'mangrove';
    if (t.natural === 'wood' || t.landuse === 'forest') return 'wood';
    if (t.natural === 'beach') return 'beach';
    if (t.natural === 'scrub' || t.natural === 'grassland' || t.landuse === 'grass' || t.landuse === 'meadow') return 'grass';
    if (t.leisure === 'park' || t.leisure === 'garden' || t.leisure === 'nature_reserve' || t.landuse === 'recreation_ground') return 'park';
    if (t.leisure === 'pitch' || t.leisure === 'playground' || t.leisure === 'golf_course') return 'pitch';
    if (t.amenity === 'parking') return 'parking';
    if (t.landuse === 'residential') return 'residential';
    if (t.landuse === 'commercial' || t.landuse === 'retail') return 'commercial';
    if (t.landuse === 'industrial') return 'industrial';
    if (t.landuse === 'construction' || t.landuse === 'brownfield') return 'construction';
    if (t.landuse) return 'other';
    return null;
  };
  const areas = [];
  const closed = (wy) => wy.nodes.length > 3 && wy.nodes[0] === wy.nodes[wy.nodes.length - 1];
  for (const wy of ways) {
    if (wy.tags?.building || !closed(wy)) continue;
    const kind = kindOf(wy.tags);
    if (!kind) continue;
    const pts = simplifyRing(wayPts(wy), 1);
    if (pts.length > 3) areas.push({ kind, name: wy.tags.name, pts: qp(pts.slice(0, -1)) });
  }
  // Multipolygon relations: stitch outer ways into rings.
  for (const r of rels) {
    const kind = kindOf(r.tags);
    if (!kind) continue;
    const outers = r.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => byId.get(m.ref)).filter(Boolean);
    for (const ring of stitch(outers.map((wy) => wy.nodes))) {
      const pts = simplifyRing(ring.map(proj).filter(Boolean), 1);
      if (pts.length > 3) areas.push({ kind, name: r.tags.name, pts: qp(pts.slice(0, -1)) });
    }
  }

  // --- Water lines (canals, drains) ---
  const waterways = ways
    .filter((wy) => wy.tags?.waterway)
    .map((wy) => ({ kind: wy.tags.waterway, w: +wy.tags.width || (wy.tags.waterway === 'canal' ? 18 : wy.tags.waterway === 'river' ? 25 : 4), pts: qp(simplify(wayPts(wy), 1)) }));

  // --- Railways (MRT viaducts, depots) ---
  const rail = ways
    .filter((wy) => ['rail', 'subway', 'light_rail'].includes(wy.tags?.railway))
    .map((wy) => ({ kind: wy.tags.railway, bridge: wy.tags.bridge === 'yes' || wy.tags.layer > 0 ? 1 : 0, tunnel: wy.tags.tunnel === 'yes' ? 1 : 0, pts: qp(simplify(wayPts(wy), 1)) }));
  const stations = raw.elements
    .filter((el) => el.type === 'node' && el.tags?.railway === 'station')
    .map((el) => {
      nodes.set(el.id, [el.lat, el.lon]);
      const [x, z] = proj(el.id);
      return { name: el.tags.name, x: q(x), z: q(z) };
    });

  // --- Traffic lights at junctions (signals.json.gz beside the roads' own
  // data). A light for a pedestrian crossing alone is left out: it stops
  // the road, it does not make a junction one with lights. ---
  const signals = raw.elements
    .filter((el) => el.type === 'node' && el.tags?.highway === 'traffic_signals' && !el.tags.crossing && el.tags.traffic_signals !== 'crossing')
    .map((el) => {
      nodes.set(el.id, [el.lat, el.lon]);
      const [x, z] = proj(el.id);
      return [q(x), q(z)];
    });

  // --- Petrol stations (amenity=fuel, as an outline or a point): where the
  // car refuels. Named by brand, the way people know them. Each becomes a
  // place, not a building: a paved forecourt (the station's outline, with
  // its canopy roof, rounded out 3 m and kept clear of the kerbed roads
  // beside it), on which the game puts a canopy, pumps and a sign. ---
  const fuel = [];
  const fuelWays = new Set(); // outlines and canopy roofs the forecourt replaces
  {
    const feats = [];
    for (const el of raw.elements) {
      if (el.tags?.amenity !== 'fuel') continue;
      let pts = null;
      if (el.type === 'way') pts = wayPts(el);
      else if (el.type === 'node') {
        nodes.set(el.id, [el.lat, el.lon]);
        const [x, z] = proj(el.id);
        // (A point only: a forecourt about 24 x 16 m round it.)
        pts = [[x - 12, z - 8], [x + 12, z - 8], [x + 12, z + 8], [x - 12, z + 8]];
      }
      if (!pts?.length) continue;
      if (el.type === 'way') fuelWays.add(el.id);
      const x = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const z = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      const name = el.tags.brand || el.tags.name || el.tags.operator || '';
      const same = feats.find((f) => Math.hypot(f.x - x, f.z - z) < 30); // a station drawn twice (roof and site)
      if (same) {
        same.pts.push(...pts);
        same.name ||= name;
      } else feats.push({ name, x, z, pts: [...pts] });
    }
    // Canopy roofs on the forecourt (often drawn apart from the site).
    for (const wy of ways) {
      if (wy.tags?.building !== 'roof' || !closed(wy)) continue;
      const pts = wayPts(wy);
      const x = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const z = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      const f = feats.find((f) => Math.hypot(f.x - x, f.z - z) < 25);
      if (!f) continue;
      f.pts.push(...pts);
      fuelWays.add(wy.id);
    }
    const hull = (P) => {
      const p = [...P].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      const lo = [];
      const hi = [];
      for (const v of p) {
        while (lo.length > 1 && cross(lo[lo.length - 2], lo[lo.length - 1], v) <= 0) lo.pop();
        lo.push(v);
      }
      for (const v of p.reverse()) {
        while (hi.length > 1 && cross(hi[hi.length - 2], hi[hi.length - 1], v) <= 0) hi.pop();
        hi.push(v);
      }
      return lo.slice(0, -1).concat(hi.slice(0, -1));
    };
    const inHull = (p, H) => {
      let c = false;
      for (let i = 0, j = H.length - 1; i < H.length; j = i++) {
        const [ax, az] = H[i];
        const [bx, bz] = H[j];
        if (az > p[1] !== bz > p[1] && p[0] < ((bx - ax) * (p[1] - az)) / (bz - az) + ax) c = !c;
      }
      return c;
    };
    // Kerbed roads near a station: the forecourt stops 2.5 m short of their
    // edge, clear of the road's paved verge.
    const kerbed = edges.filter((e) => e.cls !== 'service' && !e.lv);
    // (And 2 m clear of a footpath or cycle path beside it: the path stays
    // whole, on the grass, never under the forecourt.)
    const pathsBy = paths.map((p) => ({ pts: p.pts, w: 0, path: true }));
    const pushOff = (p, extra = [], mid = null) => {
      for (let round = 0; round < 3; round++)
        for (const e of [...kerbed, ...extra]) {
          for (let k = 0; k + 1 < e.pts.length; k++) {
            const [ax, az] = e.pts[k];
            const [bx, bz] = e.pts[k + 1];
            const dx = bx - ax;
            const dz = bz - az;
            const ll = dx * dx + dz * dz || 1;
            const u = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / ll));
            const cx = ax + dx * u;
            const cz = az + dz * u;
            const d = Math.hypot(p[0] - cx, p[1] - cz);
            const need = e.path ? 2 : e.w / 2 + 2.5;
            // (A path: the forecourt stays on the station's own side of it,
            // so a corner reaching across the path is drawn back, not out.)
            if (e.path && mid && u > 0 && u < 1 && d < 15) {
              const side = (q) => Math.sign(dx * (q[1] - az) - dz * (q[0] - ax));
              if (side(p) !== side(mid)) {
                const L = Math.sqrt(ll);
                const s = side(mid);
                p[0] = cx + (-dz / L) * need * s;
                p[1] = cz + (dx / L) * need * s;
                continue;
              }
            }
            if (d >= need || d < 1e-6) continue;
            p[0] = cx + ((p[0] - cx) / d) * need;
            p[1] = cz + ((p[1] - cz) / d) * need;
          }
        }
      return p;
    };
    const lanes = edges.filter((e) => e.cls === 'service' && !e.lv);
    const gapTo = (x, z, P) => {
      let c = false;
      let best = Infinity;
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
        const [ax, az] = P[i];
        const [bx, bz] = P[j];
        if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) c = !c;
        const dx = bx - ax;
        const dz = bz - az;
        const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
        best = Math.min(best, Math.hypot(ax + dx * u - x, az + dz * u - z));
      }
      return c ? 0 : best;
    };
    const nearKerbed = (x, z, more) =>
      kerbed.some((r) => {
        for (let k = 0; k + 1 < r.pts.length; k++) {
          const [ax, az] = r.pts[k];
          const [bx, bz] = r.pts[k + 1];
          if (Math.min(ax, bx) - x > 60 || x - Math.max(ax, bx) > 60 || Math.min(az, bz) - z > 60 || z - Math.max(az, bz) > 60) continue;
          const dx = bx - ax;
          const dz = bz - az;
          const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
          if (Math.hypot(ax + dx * u - x, az + dz * u - z) < r.w / 2 + more) return true;
        }
        return false;
      });
    for (const f of feats) {
      // Rounded out 3 m: the hull of the outline with a ring round each corner.
      const h = hull(f.pts);
      const round = [];
      for (const [x, z] of h) for (let a = 0; a < 8; a++) round.push([x + 3 * Math.cos((a * Math.PI) / 4), z + 3 * Math.sin((a * Math.PI) / 4)]);
      // (Every 1.5 m along its edge, not only its corners, kept off the roads.)
      const h1 = hull(round);
      const dense = [];
      for (let i = 0; i < h1.length; i++) {
        const [ax, az] = h1[i];
        const [bx, bz] = h1[(i + 1) % h1.length];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 1.5));
        for (let t = 0; t < n; t++) dense.push([ax + ((bx - ax) * t) / n, az + ((bz - az) * t) / n]);
      }
      // (A path that runs right through the station's own outline, more
      // than 3 m inside it, is left be.)
      const h0 = hull(f.pts);
      const deepIn = (p) => {
        if (!inHull(p, h0)) return false;
        for (let i = 0; i < h0.length; i++) {
          const [ax, az] = h0[i];
          const [bx, bz] = h0[(i + 1) % h0.length];
          const dx = bx - ax;
          const dz = bz - az;
          const u = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / (dx * dx + dz * dz || 1)));
          if (Math.hypot(ax + dx * u - p[0], az + dz * u - p[1]) < 3) return false;
        }
        return true;
      };
      const nearPaths = pathsBy.filter((q) => q.pts.some((p) => Math.hypot(p[0] - f.x, p[1] - f.z) < 120) && !q.pts.some(deepIn));
      let ring = dense.map((p) => pushOff(p, nearPaths, [f.x, f.z]));
      ring = simplifyRing([...ring, ring[0]], 0.4).slice(0, -1);
      if (ringArea(ring) < 0) ring.reverse();
      if (Math.abs(ringArea(ring)) < 120) continue; // squeezed out by the roads beside it
      const x = ring.reduce((s, p) => s + p[0], 0) / ring.length;
      const z = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      const r = Math.max(...ring.map((p) => Math.hypot(p[0] - x, p[1] - z)));
      const pts = qp(ring);
      fuel.push({ name: f.name || 'Petrol station', x: q(x), z: q(z), r: q(r), pts });
      // The ground under it is paved (no trees), to its edge and no further,
      // so its kerb meets the grass cleanly.
      // (The ground's own paving is drawn in 4 m cells: kept 3 m inside the
      // forecourt so no cell's corner shows as teeth past its kerb.)
      const inner = ring.map((p, i) => {
        const a = ring[(i + ring.length - 1) % ring.length];
        const b = ring[(i + 1) % ring.length];
        const n1 = [-(p[1] - a[1]), p[0] - a[0]];
        const n2 = [-(b[1] - p[1]), b[0] - p[0]];
        const l1 = Math.hypot(...n1) || 1;
        const l2 = Math.hypot(...n2) || 1;
        let nx = n1[0] / l1 + n2[0] / l2;
        let nz = n1[1] / l1 + n2[1] / l2;
        const ln = Math.hypot(nx, nz) || 1;
        nx /= ln;
        nz /= ln;
        const cos = Math.max(0.5, (nx * n1[0]) / l1 + (nz * n1[1]) / l1);
        return [p[0] + (nx * 3) / cos, p[1] + (nz * 3) / cos];
      });
      if (ringArea(inner) > 20) areas.push({ kind: 'parking', name: 'Forecourt', pts: qp(inner) });
    }
    // A footway stub wholly on a forecourt (a shop's door, a few metres
    // long) is the forecourt's own paving: it goes.
    for (let i = paths.length - 1; i >= 0; i--) {
      const P = paths[i].pts;
      let len = 0;
      for (let k = 1; k < P.length; k++) len += Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]);
      if (len < 8 && fuel.some((f) => P.every((p) => inHull(p, f.pts)))) paths.splice(i, 1);
    }
    // A lane running along a forecourt's edge, just off it or with its side
    // over its kerb, is cut out there (the forecourt keeps its own size; the
    // lane does not hug it). What is left of the lane either goes on past,
    // or stops short beside the forecourt and is turned onto it (below).
    let cutOut = 0;
    let stubs = 0;
    let emptied = 0;
    for (const f of fuel) {
      const P = f.pts;
      let edgeDir = [1, 0];
      const edgeGap = (x, z) => {
        let best = Infinity;
        for (let i = 0; i < P.length; i++) {
          const [ax, az] = P[i];
          const [bx, bz] = P[(i + 1) % P.length];
          const dx = bx - ax;
          const dz = bz - az;
          const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
          const d = Math.hypot(ax + dx * u - x, az + dz * u - z);
          if (d < best) {
            best = d;
            edgeDir = [dx, dz];
          }
        }
        return best;
      };
      for (const e of [...lanes]) {
        if (e.gone || !e.pts.some((p) => Math.hypot(p[0] - f.x, p[1] - f.z) < f.r + 40)) continue;
        // Every metre along it: hugging the edge or not.
        const samples = [];
        for (let k = 0; k + 1 < e.pts.length; k++) {
          const [ax, az] = e.pts[k];
          const [bx, bz] = e.pts[k + 1];
          const L = Math.hypot(bx - ax, bz - az) || 1;
          const n = Math.max(1, Math.ceil(L));
          const nx = -(bz - az) / L;
          const nz = (bx - ax) / L;
          for (let t = 0; t < n; t++) {
            const x = ax + ((bx - ax) * t) / n;
            const z = az + ((bz - az) * t) / n;
            const g = edgeGap(x, z);
            const ed = edgeDir;
            const cos = Math.abs(ed[0] * (bx - ax) + ed[1] * (bz - az)) / ((Math.hypot(...ed) || 1) * L);
            const inside = inHull([x, z], P);
            const hangs = [1, -1].some((sg) => {
              const sx = x + nx * sg * (e.w / 2);
              const sz = z + nz * sg * (e.w / 2);
              return !inHull([sx, sz], P) || edgeGap(sx, sz) < 0.5;
            });
            const hug = cos > 0.87 && (inside ? g < e.w / 2 + 1 && hangs : g <= e.w / 2 + 1.5) && !nearKerbed(x, z, e.w / 2 + 2);
            samples.push({ p: [x, z], hug });
          }
        }
        samples.push({ p: e.pts[e.pts.length - 1], hug: false });
        // Runs of 3 m or more that hug: cut out.
        const keepS = samples.map(() => true);
        for (let i = 0; i < samples.length; ) {
          if (!samples[i].hug) {
            i++;
            continue;
          }
          let j = i;
          while (j < samples.length && samples[j].hug) j++;
          if (j - i >= 3) for (let k = i; k < j; k++) keepS[k] = false;
          i = j;
        }
        if (keepS.every(Boolean)) continue;
        cutOut++;
        // The pieces left, each 2 m or more: the first keeps the lane's start
        // joint, the last its end joint; a cut end is a new joint.
        const pieces = [];
        for (let i = 0; i < samples.length; ) {
          if (!keepS[i]) {
            i++;
            continue;
          }
          let j = i;
          while (j < samples.length && keepS[j]) j++;
          pieces.push([i, j - 1]);
          i = j;
        }
        e.gone = true;
        const orig = { ...e };
        let slot = e; // (the first piece left keeps the lane's place in the list)
        for (const [i, j] of pieces) {
          if (j - i < 2) continue;
          const atStart = i === 0;
          const atEnd = j === samples.length - 1;
          if (!atStart && !atEnd) continue; // (adrift: joined to nothing)
          const pts = samples.slice(i, j + 1).map((s) => [q(s.p[0]), q(s.p[1])]);
          const piece = { ...orig, gone: false, pts };
          if (!atStart) {
            piece.a = jOut.length;
            jOut.push([...pts[0]]);
          }
          if (!atEnd) {
            piece.b = jOut.length;
            jOut.push([...pts[pts.length - 1]]);
          }
          piece.pts = simplify(piece.pts, 0.12);
          if (slot) {
            Object.assign(slot, piece);
            slot = null;
          } else {
            edges.push(piece);
            lanes.push(piece);
          }
        }
        if (slot) emptied++;
      }
    }
    // (A lane cut away whole: its place in the list goes to the last one, so
    // every other piece keeps its number: the checks name some by it.)
    const compact = () => {
      for (let i = 0; i < edges.length; i++) {
        if (!edges[i].gone) continue;
        while (edges.length > i + 1 && edges[edges.length - 1].gone) edges.pop();
        if (edges.length === i + 1) {
          edges.pop();
          break;
        }
        edges[i] = edges.pop();
      }
      for (let i = lanes.length - 1; i >= 0; i--) if (lanes[i].gone) lanes.splice(i, 1);
      for (const e of edges) delete e.gone;
    };
    compact();
    if (cutOut) console.log(`station lanes: ${cutOut} cut where they ran along a forecourt's edge (${emptied} wholly)`);
    // A lane that stops short beside a forecourt goes on onto it, straight,
    // and ends on it: a way in, not a stub on the grass.
    const deg = new Map();
    for (const e of edges) for (const j of [e.a, e.b]) deg.set(j, (deg.get(j) ?? 0) + 1);
    const onKerbed = (x, z) =>
      kerbed.some((e) => e.pts.some((p, k) => {
        if (k + 1 >= e.pts.length) return false;
        const [bx, bz] = e.pts[k + 1];
        const dx = bx - p[0];
        const dz = bz - p[1];
        const u = Math.max(0, Math.min(1, ((x - p[0]) * dx + (z - p[1]) * dz) / (dx * dx + dz * dz || 1)));
        return Math.hypot(p[0] + dx * u - x, p[1] + dz * u - z) < e.w / 2 + 0.5;
      }));
    for (const f of fuel) {
      const P = f.pts;
      for (const e of lanes) {
        for (const atA of [true, false]) {
          const j = atA ? e.a : e.b;
          if (deg.get(j) !== 1) continue;
          let p = atA ? e.pts[0] : e.pts[e.pts.length - 1];
          if (Math.hypot(p[0] - f.x, p[1] - f.z) > f.r + 20 || gapTo(p[0], p[1], P) > 15) continue;
          // (Ends on it, or crossed it and stops past it: either way it ends
          // on it, 3 m in from the edge it came in by.)
          const crosses = e.pts.some((pt) => gapTo(pt[0], pt[1], P) === 0);
          if (gapTo(p[0], p[1], P) === 0 || crosses) {
            // A lane that ends on the forecourt ends 3 m in from its edge
            // (the forecourt is the paving beyond; no lane's end lies under it).
            const own = atA ? [...e.pts].reverse() : [...e.pts];
            const depth = (pt) => {
              if (gapTo(pt[0], pt[1], P) > 0) return 0;
              let edge = Infinity;
              for (let i = 0; i < P.length; i++) {
                const [ax, az] = P[i];
                const [bx, bz] = P[(i + 1) % P.length];
                const dx = bx - ax;
                const dz = bz - az;
                const u = Math.max(0, Math.min(1, ((pt[0] - ax) * dx + (pt[1] - az) * dz) / (dx * dx + dz * dz || 1)));
                edge = Math.min(edge, Math.hypot(ax + dx * u - pt[0], az + dz * u - pt[1]));
              }
              return edge;
            };
            // (Walk in from the lane's other end to the first point 3 m in.)
            const line = [own[0]];
            for (let k = 0; k + 1 < own.length; k++) {
              const [ax, az] = own[k];
              const [bx, bz] = own[k + 1];
              const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) * 2));
              let stop = null;
              for (let t = 1; t <= n; t++) {
                const pt = [ax + ((bx - ax) * t) / n, az + ((bz - az) * t) / n];
                if (depth(pt) >= 3) {
                  stop = pt;
                  break;
                }
              }
              if (stop) {
                line.push([q(stop[0]), q(stop[1])]);
                break;
              }
              line.push(own[k + 1]);
            }
            const L = line.reduce((t, pt, i) => (i ? t + Math.hypot(pt[0] - line[i - 1][0], pt[1] - line[i - 1][1]) : 0), 0);
            if (line.length >= 2 && L >= 3 && line.length <= own.length && depth(line[line.length - 1]) >= 3) {
              e.pts = atA ? line.reverse() : line;
              jOut[j] = [...(atA ? e.pts[0] : e.pts[e.pts.length - 1])];
              continue;
            }
            if (gapTo(p[0], p[1], P) === 0) continue;
          }
          // (First back off any of it that runs along beside the forecourt.)
          const own = atA ? [...e.pts].reverse() : [...e.pts];
          const beside = (pt) => gapTo(pt[0], pt[1], P) > 0 && gapTo(pt[0], pt[1], P) <= e.w / 2 + 4;
          while (own.length > 2 && beside(own[own.length - 1]) && beside(own[own.length - 2])) own.pop();
          p = own[own.length - 1];
          // Onto it the shortest way to 3 m in: square across an edge near
          // by (or towards its middle), never along one.
          const edgeIn = (x, z) => {
            let edge = Infinity;
            for (let i = 0; i < P.length; i++) {
              const [ax, az] = P[i];
              const [bx, bz] = P[(i + 1) % P.length];
              const dx = bx - ax;
              const dz = bz - az;
              const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
              edge = Math.min(edge, Math.hypot(ax + dx * u - x, az + dz * u - z));
            }
            return edge;
          };
          const dirs = [];
          {
            const dl = Math.hypot(f.x - p[0], f.z - p[1]) || 1;
            dirs.push([(f.x - p[0]) / dl, (f.z - p[1]) / dl]);
          }
          for (let i = 0; i < P.length; i++) {
            const [ax, az] = P[i];
            const [bx, bz] = P[(i + 1) % P.length];
            const dx = bx - ax;
            const dz = bz - az;
            const u = ((p[0] - ax) * dx + (p[1] - az) * dz) / (dx * dx + dz * dz || 1);
            if (u < 0.05 || u > 0.95) continue;
            if (Math.hypot(ax + dx * u - p[0], az + dz * u - p[1]) > 16) continue;
            const L = Math.hypot(dx, dz) || 1;
            let [ux, uz] = [-dz / L, dx / L];
            if (ux * (ax + dx * u - p[0]) + uz * (az + dz * u - p[1]) < 0) [ux, uz] = [-ux, -uz];
            dirs.push([ux, uz]);
          }
          let more = [];
          let ok = false;
          let bestSteps = Infinity;
          // (No turn sharper than a right angle and a bit: a lane bends onto
          // the forecourt, it does not double back.)
          const hd = (() => {
            const a = own[Math.max(0, own.length - 2)];
            const b = own[own.length - 1];
            const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
            return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
          })();
          for (const [ux, uz] of dirs) {
            if (ux * hd[0] + uz * hd[1] < -0.2) continue;
            const got = [];
            for (let step = 1; step <= 25 && step < bestSteps; step++) {
              const x = p[0] + ux * step;
              const z = p[1] + uz * step;
              if (onKerbed(x, z)) break;
              if (step % 2 === 0 || gapTo(x, z, P) === 0) got.push([q(x), q(z)]);
              if (gapTo(x, z, P) === 0 && edgeIn(x, z) >= 3) {
                got.push([q(x), q(z)]);
                bestSteps = step;
                more = got;
                ok = true;
                break;
              }
            }
          }
          more = more.filter((m, i) => !i || m[0] !== more[i - 1][0] || m[1] !== more[i - 1][1]);
          if (!ok || !more.length) {
            // (No way onto it without doubling back: a short stub goes.)
            const len = e.pts.reduce((t, pt, i) => (i ? t + Math.hypot(pt[0] - e.pts[i - 1][0], pt[1] - e.pts[i - 1][1]) : 0), 0);
            if (len < 40) {
              e.gone = true;
              stubs++;
            }
            continue;
          }
          const end = more[more.length - 1];
          // (The turn onto it rounded, 4 m each way: a lane bends, it does not
          // kink.)
          const C = own[own.length - 1];
          const R = 4;
          let back = 0;
          let A = null;
          for (let k = own.length - 1; k > 0 && !A; k--) {
            const l = Math.hypot(own[k][0] - own[k - 1][0], own[k][1] - own[k - 1][1]);
            if (back + l >= R) {
              const t = (R - back) / l;
              A = [own[k][0] + (own[k - 1][0] - own[k][0]) * t, own[k][1] + (own[k - 1][1] - own[k][1]) * t];
              own.length = k;
            } else back += l;
          }
          let rest = more;
          if (A) {
            const dl = Math.hypot(more[0][0] - C[0], more[0][1] - C[1]) || 1;
            const B = [C[0] + ((more[0][0] - C[0]) / dl) * R, C[1] + ((more[0][1] - C[1]) / dl) * R];
            const curve = [];
            for (let t = 0; t <= 1.001; t += 0.125)
              curve.push([
                q((1 - t) * (1 - t) * A[0] + 2 * (1 - t) * t * C[0] + t * t * B[0]),
                q((1 - t) * (1 - t) * A[1] + 2 * (1 - t) * t * C[1] + t * t * B[1]),
              ]);
            rest = more.filter((m) => Math.hypot(m[0] - C[0], m[1] - C[1]) > R + 0.5);
            own.push(...curve);
          }
          own.push(...rest);
          e.pts = atA ? own.reverse() : own;
          jOut[j] = [...end];
        }
      }
    }
    compact();
    if (stubs) console.log(`station lanes: ${stubs} stub(s) beside a forecourt dropped`);
  }

  // --- Coastline: joined into long lines (land on the left in OSM) ---
  const coast = stitch(ways.filter((wy) => wy.tags?.natural === 'coastline').map((wy) => wy.nodes), true).map((ids) =>
    qp(simplify(ids.map(proj).filter(Boolean), 1)),
  );

  // --- Buildings ---
  const buildings = [];
  for (const wy of ways) {
    if (!wy.tags?.building || !closed(wy) || fuelWays.has(wy.id)) continue;
    let pts = simplifyRing(wayPts(wy), 0.5).slice(0, -1);
    if (pts.length < 3) continue;
    if (ringArea(pts) < 0) pts = pts.reverse(); // consistent winding
    const t = wy.tags;
    const levels = +t['building:levels'] || 0;
    const height = parseFloat(t.height) || 0;
    buildings.push({ k: t.building, l: levels || undefined, h: height || undefined, name: t.name, pts: qp(pts) });
  }

  // Buildings standing on a forecourt (the shop): the canopy keeps clear.
  // (The buildings list is filled just above.)
  for (const f of fuel) {
    const inRing = (x, z) => {
      let c = false;
      for (let i = 0, j = f.pts.length - 1; i < f.pts.length; j = i++) {
        const [ax, az] = f.pts[i];
        const [bx, bz] = f.pts[j];
        if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) c = !c;
      }
      return c;
    };
    const shops = [];
    for (let i = buildings.length - 1; i >= 0; i--) {
      const b = buildings[i];
      const x = b.pts.reduce((s, p) => s + p[0], 0) / b.pts.length;
      const z = b.pts.reduce((s, p) => s + p[1], 0) / b.pts.length;
      if (!inRing(x, z) && !b.pts.some((p) => inRing(p[0], p[1]))) continue;
      // (A big one is the station itself drawn as a building, canopy and
      // all: the game builds that. A small one is the shop.)
      if (inRing(x, z) && Math.abs(ringArea(b.pts)) > 250) {
        buildings.splice(i, 1);
        continue;
      }
      shops.push([q(x), q(z), q(Math.max(...b.pts.map((p) => Math.hypot(p[0] - x, p[1] - z))))]);
    }
    if (shops.length) f.shops = shops;
  }

  // --- Land mask: 10 m cells, sea flood-filled from the water side of
  // the coastline (OSM coastlines keep land on the left). Run-length rows.
  const mask = landMask(coast, raw.bbox ? [proj2(raw.bbox[1], raw.bbox[2]), proj2(raw.bbox[3], raw.bbox[0])] : null);
  function proj2(lon, lat) {
    return [(lon - lon0) * kx, -(lat - lat0) * kz];
  }

  return {
    attribution: 'Map data © OpenStreetMap contributors (ODbL)',
    origin: [lat0, lon0],
    bbox: raw.bbox,
    fuel,
    junctions: jOut,
    edges,
    paths,
    areas,
    waterways,
    coast,
    mask,
    ...(signals.length ? { signals } : {}),
    rail,
    stations,
    buildings,
  };
}

function landMask(coastLines, box) {
  if (!box) return null;
  const C = 10;
  const [[x0, z0], [x1, z1]] = box; // north-west, south-east corners
  const W = Math.ceil((x1 - x0) / C);
  const H = Math.ceil((z1 - z0) / C);
  // Open coast lines (cut off by the download box) are carried on straight
  // past the box. Each cell then takes the side of its nearest coast
  // segment: OSM keeps land on the left of a coastline.
  const ext = (a, b) => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [b[0] + ((b[0] - a[0]) / l) * 20000, b[1] + ((b[1] - a[1]) / l) * 20000];
  };
  const segs = [];
  // Pieces wholly outside the box (other islands' shores) would only
  // mislead the side test once extended, so they are left out.
  const inBox = ([x, z]) => x >= x0 && x <= x1 && z >= z0 && z <= z1;
  for (const l of coastLines) {
    if (l.length < 2 || !l.some(inBox)) continue;
    const ring = l[0][0] === l.at(-1)[0] && l[0][1] === l.at(-1)[1];
    const pts = ring ? l : [ext(l[1], l[0]), ...l, ext(l.at(-2), l.at(-1))];
    for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]]);
  }
  if (!segs.length) return null;
  const g = new Uint8Array(W * H); // 0 land, 1 sea
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const x = x0 + (i + 0.5) * C;
      const z = z0 + (j + 0.5) * C;
      let best = Infinity;
      let sea = 0;
      for (const [ax, az, bx, bz] of segs) {
        const dx = bx - ax;
        const dz = bz - az;
        const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
        const px = ax + dx * u - x;
        const pz = az + dz * u - z;
        const d2 = px * px + pz * pz;
        // At a shared corner, prefer the segment seen side-on.
        if (d2 < best - 1e-6 || (Math.abs(d2 - best) <= 1e-6 && u > 0 && u < 1)) {
          best = d2;
          // Left of travel (x east, z south): cross product negative.
          sea = dx * (z - az) - dz * (x - ax) < 0 ? 0 : 1;
        }
      }
      g[j * W + i] = sea;
    }
  // Rows as run lengths, starting with land: [land, sea, land, ...].
  const rows = [];
  for (let j = 0; j < H; j++) {
    const runs = [];
    let cur = 0;
    let n = 0;
    for (let i = 0; i < W; i++) {
      const v = g[j * W + i];
      if (v === cur) n++;
      else {
        runs.push(n);
        cur = v;
        n = 1;
      }
    }
    runs.push(n);
    rows.push(runs);
  }
  return { cell: C, x0: q(x0), z0: q(z0), w: W, h: H, rows };
}

/** Join way node lists that share end nodes into the longest chains / rings. */
function stitch(lists, keepOpen = false) {
  const rest = lists.map((l) => l.slice());
  const out = [];
  while (rest.length) {
    let cur = rest.pop();
    let grown = true;
    while (grown && cur[0] !== cur[cur.length - 1]) {
      grown = false;
      for (let i = 0; i < rest.length; i++) {
        const l = rest[i];
        if (l[0] === cur[cur.length - 1]) cur = cur.concat(l.slice(1));
        else if (!keepOpen && l[l.length - 1] === cur[cur.length - 1]) cur = cur.concat(l.slice(0, -1).reverse());
        else if (l[l.length - 1] === cur[0]) cur = l.concat(cur.slice(1));
        else if (!keepOpen && l[0] === cur[0]) cur = l.slice(1).reverse().concat(cur);
        else continue;
        rest.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (keepOpen || cur[0] === cur[cur.length - 1]) out.push(cur);
  }
  return out;
}

// ---------- CLI ----------
const [cmd, name, ...args] = process.argv.slice(2);
if (cmd === 'fetch') {
  await fetchArea(name, ...args.map(Number));
} else if (cmd === 'build') {
  // Either one raw dump (tools/osm/raw/<name>.json) or a folder of themed
  // dumps (data/osm/<name>/*.json) merged together.
  const dir = path.join(HERE, '..', '..', 'data', 'osm', name);
  let raw;
  if (fs.existsSync(dir)) {
    raw = { elements: [] };
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json') || f.endsWith('.json.gz'))) {
      const buf = fs.readFileSync(path.join(dir, f));
      const part = JSON.parse((f.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8'));
      raw.elements.push(...part.elements);
      raw.bbox ??= part.bbox;
    }
    if (!raw.bbox) {
      const qf = path.join(HERE, `${name}.overpassql`);
      const m = fs.existsSync(qf) && fs.readFileSync(qf, 'utf8').match(/bbox:\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
      if (m) raw.bbox = m.slice(1, 5).map(Number);
    }
    if (!raw.bbox) {
      const readme = fs.existsSync(path.join(dir, 'README.md')) ? fs.readFileSync(path.join(dir, 'README.md'), 'utf8') : '';
      const m = readme.match(/(1\.\d+)\s*,\s*(103\.\d+)\s*,\s*(1\.\d+)\s*,\s*(103\.\d+)/);
      if (m) raw.bbox = m.slice(1, 5).map(Number);
    }
  } else raw = JSON.parse(fs.readFileSync(path.join(RAW, `${name}.json`), 'utf8'));
  const map = build(raw, args.length === 2 ? args.map(Number) : undefined);
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(map));
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  console.log(`${file}: ${map.junctions.length} junctions, ${map.edges.length} road edges, ${map.paths.length} paths, ${map.areas.length} areas, ${map.buildings.length} buildings, ${kb} KB`);
} else if (cmd) {
  console.log('usage: import.mjs fetch <name> <s> <w> <n> <e> | build <name> [lat0 lon0]');
}
