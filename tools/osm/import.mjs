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

  // --- Coastline: joined into long lines (land on the left in OSM) ---
  const coast = stitch(ways.filter((wy) => wy.tags?.natural === 'coastline').map((wy) => wy.nodes), true).map((ids) =>
    qp(simplify(ids.map(proj).filter(Boolean), 1)),
  );

  // --- Buildings ---
  const buildings = [];
  for (const wy of ways) {
    if (!wy.tags?.building || !closed(wy)) continue;
    let pts = simplifyRing(wayPts(wy), 0.5).slice(0, -1);
    if (pts.length < 3) continue;
    if (ringArea(pts) < 0) pts = pts.reverse(); // consistent winding
    const t = wy.tags;
    const levels = +t['building:levels'] || 0;
    const height = parseFloat(t.height) || 0;
    buildings.push({ k: t.building, l: levels || undefined, h: height || undefined, name: t.name, pts: qp(pts) });
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
