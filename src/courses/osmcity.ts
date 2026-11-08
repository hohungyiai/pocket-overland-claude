import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fbm, lerp, mulberry32, smoothstep, valueNoise } from '../noise';
import { SURFACES, type Course, type MapData, type Surface, type XZ } from './types';
import * as D from './detail';
import { TILE, TileStreamer, type Layer, type TileKit } from '../world/stream';
import { SegIndex, inRing, resample, ringArea } from '../world/segindex';

// Pasir Ris and Tampines, built from OpenStreetMap at true scale.
//
// OSM is the guide, not the mesh: the importer (tools/osm/import.mjs) turns
// it into a clean road graph, land-use areas, building footprints, canals
// and a coastline. Here we lay our own smooth ground over that plan (gentle
// made-up hills, a sloping beach, canals and ponds cut in), drape road ribbons on
// it with junction pads and lane markings, extrude the buildings from their
// real footprints, and grow trees along the streets and through the parks.
// Everything is built per tile as the streamer loads it.
//
// Map data © OpenStreetMap contributors, under the ODbL.

type Rapier = typeof RAPIER_NS;

interface OsmEdge { a: number; b: number; cls: string; w: number; one: number; lv?: number; vd?: number; name?: string; pts: XZ[] }
interface OsmMap {
  attribution: string;
  junctions: XZ[];
  edges: OsmEdge[];
  paths: { k: 'foot' | 'cycle'; pts: XZ[] }[];
  areas: { kind: string; name?: string; pts: XZ[] }[];
  waterways: { kind: string; w: number; pts: XZ[] }[];
  coast: XZ[][];
  mask: { cell: number; x0: number; z0: number; w: number; h: number; rows: number[][] } | null;
  rail: { kind: string; bridge: number; tunnel: number; pts: XZ[] }[];
  stations: { name: string; x: number; z: number }[];
  buildings: { k: string; l?: number; h?: number; name?: string; pts: XZ[] }[];
}

const SEED = 1729;
const LAND = 2; // estate ground level above the sea, metres
const WL = 1.3; // canal and pond water level
const BEACH = 26; // beach width, waterline to the top of the sand
const STEP = 4;
const STEP_FAR = 20;
const G = 4; // raster cell for land use, metres
const WB = { minX: -3600, maxX: 3600, minZ: -3600, maxZ: 3600 };
const RW = (WB.maxX - WB.minX) / G;
const RH = (WB.maxZ - WB.minZ) / G;

// Land-use codes (low 4 bits) and flags in the raster.
const KINDS = ['none', 'residential', 'commercial', 'industrial', 'construction', 'other', 'parking', 'park', 'grass', 'pitch', 'wood', 'mangrove', 'beach', 'water'] as const;
type Kind = (typeof KINDS)[number];
const KI = Object.fromEntries(KINDS.map((k, i) => [k, i])) as Record<Kind, number>;
const BLD = 16; // under a building
const NEAR_ROAD = 32; // on or beside a road
const NEAR_PATH = 64; // on or beside a footpath
const NEAR_WET = 128; // in or beside a canal or pond

const TREE_LINED = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'motorway']);
const RANK: Record<string, number> = { motorway: 6, trunk: 5, primary: 4, secondary: 3, tertiary: 2, unclassified: 1, residential: 1, living_street: 1, service: 0 };
const rankOf = (cls: string) => RANK[cls] ?? (cls.endsWith('_link') ? 2 : 0);

export const PASIR_RIS_MAP = 'maps/east-sg.json';

export async function buildPasirRisCourse(
  scene: THREE.Scene,
  world: RAPIER_NS.World,
  RAPIER: Rapier,
  opts: { style?: D.ArtStyle } = {},
): Promise<Course> {
  const res = await fetch(PASIR_RIS_MAP);
  if (!res.ok) throw new Error(`map data missing (${res.status})`);
  const M = (await res.json()) as OsmMap;
  const detailed = opts.style === 'detailed';

  // ---------- Roads and paths, resampled every 4 m ----------
  // Tunnels stay underground. One carriageway of a dual road is narrower
  // than the importer's two-way width for its class.
  const ONE_WAY_W: Record<string, number> = { motorway: 11, trunk: 10, primary: 8, secondary: 7.5, tertiary: 7 };
  const edges = M.edges
    .filter((e) => e.lv !== -1)
    .map((e) => (e.one && ONE_WAY_W[e.cls] ? { ...e, w: Math.min(e.w, ONE_WAY_W[e.cls]) } : e));
  const EP = edges.map((e) => resample(e.pts, 4));
  const ECUM = EP.map((pts) => {
    const c = [0];
    for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    return c;
  });
  const EHALF = edges.map((e) => e.w / 2);
  const roads = new SegIndex(EP, 24);
  const paths = M.paths.map((p) => ({ k: p.k, pts: resample(p.pts, 4) }));
  const PHALF = paths.map((p) => (p.k === 'cycle' ? 1.4 : 1.1));
  const pathIdx = new SegIndex(paths.map((p) => p.pts), 24);

  // ---------- Flyovers and bridges ----------
  // OSM tags the deck of a bridge (with its layer) but not the ramps up to
  // it. A bridge that crosses another road, a railway, or is long is a
  // flyover: its deck stands DECK_H per layer above the ground, and the
  // roads leading to it climb on embankments at RAMP_GRADE. Other bridges
  // (over canals and drains) are low decks just above the banks.
  const DECK_H = 6.5;
  const RAMP_GRADE = 0.05;
  const isDeck = edges.map((e) => (e.lv ?? 0) > 0);
  const ELEN = ECUM.map((c) => c[c.length - 1]);
  const jE = M.junctions.map(() => [] as number[]);
  edges.forEach((e, i) => {
    jE[e.a]?.push(i);
    if (e.b !== e.a) jE[e.b]?.push(i);
  });
  const shares = (i: number, o: number) => edges[i].a === edges[o].a || edges[i].a === edges[o].b || edges[i].b === edges[o].a || edges[i].b === edges[o].b;
  const groundRail = M.rail.filter((r) => !r.tunnel && !r.bridge);
  const railIdx = new SegIndex(groundRail.map((r) => r.pts), 32);
  /** Does line i pass over (not join) a line accepted by `hit`, away from its ends? */
  const crosses = (i: number, idx: SegIndex, hit: (o: number) => boolean) => {
    const pts = EP[i];
    const cum = ECUM[i];
    const pad = EHALF[i] + 4;
    for (let k = 0; k < pts.length; k++) {
      if (cum[k] < pad || cum[k] > ELEN[i] - pad) continue;
      if (idx.nearest(pts[k][0], pts[k][1], 2.5, hit)) return true;
    }
    return false;
  };
  const elevated = edges.map((e, i) => {
    if (!isDeck[i]) return false;
    if (e.vd || (e.lv ?? 0) >= 2 || ELEN[i] > 250) return true;
    return crosses(i, roads, (o) => o !== i && !isDeck[o] && !shares(i, o)) || crosses(i, railIdx, () => true);
  });
  // A flyover split into several bridge pieces in OSM is all one flyover.
  for (let changed = true; changed; ) {
    changed = false;
    edges.forEach((e, i) => {
      if (!isDeck[i] || elevated[i]) return;
      if ([...(jE[e.a] ?? []), ...(jE[e.b] ?? [])].some((o) => elevated[o])) {
        elevated[i] = true;
        changed = true;
      }
    });
  }
  // Where two flyovers cross, the slip road (or the higher OSM layer) goes over.
  const deckLevel = edges.map((e, i) => (elevated[i] ? Math.max(1, e.lv ?? 1) : 0));
  const elevIdx = new SegIndex(EP, 24, false, (i) => !elevated[i]);
  edges.forEach((e, i) => {
    if (!elevated[i]) return;
    const pts = EP[i];
    for (let k = 0; k < pts.length; k += 2) {
      const r = elevIdx.nearest(pts[k][0], pts[k][1], 2.5, (o) => o !== i && !shares(i, o));
      if (!r) continue;
      const o = r.line;
      const mine = [e.lv ?? 1, -rankOf(e.cls), i];
      const theirs = [edges[o].lv ?? 1, -rankOf(edges[o].cls), o];
      const up = mine[0] !== theirs[0] ? mine[0] > theirs[0] : mine[1] !== theirs[1] ? mine[1] > theirs[1] : i > o;
      if (up) deckLevel[i] = Math.max(deckLevel[i], deckLevel[o] + 1);
    }
  });
  // Junction heights above the ground: full height at a flyover's ends, then
  // falling away along the roads that lead to it.
  const jRel = new Float32Array(M.junctions.length);
  const queue: number[] = [];
  edges.forEach((e, i) => {
    if (!elevated[i]) return;
    for (const j of [e.a, e.b]) {
      if (DECK_H * deckLevel[i] > jRel[j]) {
        jRel[j] = DECK_H * deckLevel[i];
        queue.push(j);
      }
    }
  });
  while (queue.length) {
    const j = queue.pop()!;
    for (const i of jE[j] ?? []) {
      if (elevated[i]) continue;
      const n = edges[i].a === j ? edges[i].b : edges[i].a;
      const r = jRel[j] - RAMP_GRADE * ELEN[i];
      if (r > jRel[n] + 0.01) {
        jRel[n] = r;
        queue.push(n);
      }
    }
  }
  /** Road height above the ground at distance s along edge i. */
  const relAlong = (i: number, s: number) => {
    const ra = jRel[edges[i].a] ?? 0;
    const rb = jRel[edges[i].b] ?? 0;
    const len = ELEN[i];
    if (elevated[i]) return lerp(ra, rb, len > 0 ? s / len : 0);
    return Math.max(0, ra - RAMP_GRADE * s, rb - RAMP_GRADE * (len - s));
  };
  // Roads (not decks) that climb to a flyover: the ground rises under them.
  const embank = edges.map((e, i) => !isDeck[i] && ((jRel[e.a] ?? 0) > 0.02 || (jRel[e.b] ?? 0) > 0.02));
  const rampIdx = new SegIndex(EP, 24, false, (i) => !embank[i]);
  // Decks and raised roads have their own surface height (not the ground's),
  // level across their width.
  const hasProfile = edges.map((_, i) => isDeck[i] || embank[i]);
  const levelIdx = new SegIndex(EP, 24, false, (i) => isDeck[i]);
  // Coarse 16 m grid of where an embankment might be, so heightAt can skip the search.
  const RG = 16;
  const rampNear = new Uint8Array(Math.ceil((WB.maxX - WB.minX) / RG) * Math.ceil((WB.maxZ - WB.minZ) / RG));
  const RGW = Math.ceil((WB.maxX - WB.minX) / RG);
  const RGH = Math.ceil((WB.maxZ - WB.minZ) / RG);
  edges.forEach((_, i) => {
    if (!embank[i]) return;
    const reach = EHALF[i] + 4 + 3 * Math.max(jRel[edges[i].a], jRel[edges[i].b]) + RG;
    for (const [x, z] of EP[i]) {
      const i0 = Math.floor((x - reach - WB.minX) / RG);
      const i1 = Math.floor((x + reach - WB.minX) / RG);
      const j0 = Math.floor((z - reach - WB.minZ) / RG);
      const j1 = Math.floor((z + reach - WB.minZ) / RG);
      for (let jj = Math.max(0, j0); jj <= Math.min(RGH - 1, j1); jj++) for (let ii = Math.max(0, i0); ii <= Math.min(RGW - 1, i1); ii++) rampNear[jj * RGW + ii] = 1;
    }
  });
  const nearRamp = (x: number, z: number) => {
    const i = Math.floor((x - WB.minX) / RG);
    const j = Math.floor((z - WB.minZ) / RG);
    return i >= 0 && i < RGW && j >= 0 && j < RGH && rampNear[j * RGW + i] === 1;
  };

  // ---------- Coast and inland water ----------
  const coast = new SegIndex(M.coast, 32);
  const mask = M.mask;
  const maskGrid = (() => {
    if (!mask) return null;
    const g = new Uint8Array(mask.w * mask.h);
    mask.rows.forEach((runs, j) => {
      let i = 0;
      runs.forEach((n, r) => {
        if (r % 2) g.fill(1, j * mask.w + i, j * mask.w + i + n);
        i += n;
      });
    });
    return g;
  })();
  const isSea = (x: number, z: number) => {
    if (!mask || !maskGrid) return false;
    const i = Math.min(mask.w - 1, Math.max(0, Math.floor((x - mask.x0) / mask.cell)));
    const j = Math.min(mask.h - 1, Math.max(0, Math.floor((z - mask.z0) / mask.cell)));
    return maskGrid[j * mask.w + i] === 1;
  };
  /** Signed distance to the coast, positive on land, capped at +-60 m. */
  const coastSD = (x: number, z: number) => {
    const h = coast.nearest(x, z, 60);
    if (h) return h.sd;
    return isSea(x, z) ? -60 : 60;
  };

  const waterAreas = M.areas.filter((a) => a.kind === 'water').map((a) => (ringArea(a.pts) < 0 ? [...a.pts].reverse() : a.pts));
  const ponds = new SegIndex(waterAreas, 32, true);
  const canals = M.waterways.filter((w) => ['canal', 'river', 'stream'].includes(w.kind)).map((w) => ({ w: Math.max(6, w.w), pts: resample(w.pts, 6) }));
  const canalIdx = new SegIndex(canals.map((c) => c.pts), 32);
  /** Signed distance to inland water, positive on dry land, capped at 30 m. */
  const wetSD = (x: number, z: number) => {
    let d = 30;
    const p = ponds.nearest(x, z, 30);
    if (p) d = p.sd;
    const c = canalIdx.nearest(x, z, 30 + 20);
    if (c) d = Math.min(d, c.d - canals[c.line].w / 2);
    return d;
  };

  // ---------- Land-use raster ----------
  const code = new Uint8Array(RW * RH);
  const fillPoly = (pts: XZ[], f: (k: number) => void) => {
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const p of pts) {
      z0 = Math.min(z0, p[1]);
      z1 = Math.max(z1, p[1]);
    }
    const j0 = Math.max(0, Math.ceil((z0 - WB.minZ) / G - 0.5));
    const j1 = Math.min(RH - 1, Math.floor((z1 - WB.minZ) / G - 0.5));
    const xs: number[] = [];
    for (let j = j0; j <= j1; j++) {
      const zc = WB.minZ + (j + 0.5) * G;
      xs.length = 0;
      for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
        const [ax, az] = pts[a];
        const [bx, bz] = pts[b];
        if (az <= zc !== bz <= zc) xs.push(ax + ((zc - az) / (bz - az)) * (bx - ax));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - WB.minX) / G - 0.5));
        const i1 = Math.min(RW - 1, Math.floor((xs[k + 1] - WB.minX) / G - 0.5));
        for (let i = i0; i <= i1; i++) f(j * RW + i);
      }
    }
  };
  const strokeLine = (pts: XZ[], r: number, f: (k: number) => void) => {
    for (let s = 0; s < pts.length - 1; s++) {
      const [ax, az] = pts[s];
      const [bx, bz] = pts[s + 1];
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - WB.minX) / G));
      const i1 = Math.min(RW - 1, Math.floor((Math.max(ax, bx) + r - WB.minX) / G));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - r - WB.minZ) / G));
      const j1 = Math.min(RH - 1, Math.floor((Math.max(az, bz) + r - WB.minZ) / G));
      const abx = bx - ax;
      const abz = bz - az;
      const ll = abx * abx + abz * abz || 1;
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const x = WB.minX + (i + 0.5) * G;
          const z = WB.minZ + (j + 0.5) * G;
          const u = Math.max(0, Math.min(1, ((x - ax) * abx + (z - az) * abz) / ll));
          if (Math.hypot(ax + abx * u - x, az + abz * u - z) <= r) f(j * RW + i);
        }
    }
  };
  {
    // Broad land use first, then parks and greens, then the small details.
    const order: Kind[] = ['residential', 'commercial', 'industrial', 'other', 'construction', 'park', 'grass', 'wood', 'mangrove', 'pitch', 'parking', 'beach', 'water'];
    const list = M.areas
      .filter((a) => order.includes(a.kind as Kind))
      .map((a) => ({ a, o: order.indexOf(a.kind as Kind), area: Math.abs(ringArea(a.pts)) }))
      .sort((p, q) => p.o - q.o || q.area - p.area);
    for (const { a } of list) {
      const v = KI[a.kind as Kind];
      fillPoly(a.pts, (k) => (code[k] = (code[k] & 0xf0) | v));
    }
    for (const b of M.buildings) fillPoly(b.pts, (k) => (code[k] |= BLD));
    edges.forEach((e, i) => strokeLine(EP[i], e.w / 2 + 9, (k) => (code[k] |= NEAR_ROAD)));
    for (const p of paths) strokeLine(p.pts, 5, (k) => (code[k] |= NEAR_PATH));
    for (const c of canals) strokeLine(c.pts, c.w / 2 + 7, (k) => (code[k] |= NEAR_WET));
    for (const w of waterAreas) {
      fillPoly(w, (k) => (code[k] |= NEAR_WET));
      strokeLine([...w, w[0]], 7, (k) => (code[k] |= NEAR_WET));
    }
  }
  const cell = (x: number, z: number) => {
    const i = Math.floor((x - WB.minX) / G);
    const j = Math.floor((z - WB.minZ) / G);
    if (i < 0 || j < 0 || i >= RW || j >= RH) return 0;
    return code[j * RW + i];
  };
  const SOFT = new Set([KI.park, KI.grass, KI.wood, KI.none, KI.residential, KI.other]);
  const softAt = (i: number, j: number) => {
    if (i < 0 || j < 0 || i >= RW || j >= RH) return 0;
    const c = code[j * RW + i];
    return (c & (BLD | NEAR_ROAD | NEAR_PATH | NEAR_WET)) === 0 && SOFT.has(c & 15) ? 1 : 0;
  };
  /** 0..1: how far into open parkland (away from roads, paths, water) a point is. */
  const openness = (x: number, z: number) => {
    const fx = (x - WB.minX) / G - 0.5;
    const fz = (z - WB.minZ) / G - 0.5;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    return lerp(lerp(softAt(i, j), softAt(i + 1, j), tx), lerp(softAt(i, j + 1), softAt(i + 1, j + 1), tx), tz);
  };

  // ---------- Gentle hills ----------
  // Made-up rolling ground, a few metres high over hundreds of metres. It
  // fades out towards the sea, canals and ponds, so water stays level and
  // the banks stay low.
  const HILL = 10;
  const DG = 8;
  const DW = (WB.maxX - WB.minX) / DG;
  const DH = (WB.maxZ - WB.minZ) / DG;
  const hillW = (() => {
    const d = new Float32Array(DW * DH);
    for (let j = 0; j < DH; j++)
      for (let i = 0; i < DW; i++) {
        const x = WB.minX + (i + 0.5) * DG;
        const z = WB.minZ + (j + 0.5) * DG;
        const c = cell(x, z);
        const k = c & 15;
        d[j * DW + i] = isSea(x, z) || c & NEAR_WET || k === KI.water || k === KI.beach || k === KI.mangrove ? 0 : 1e9;
      }
    // Two-pass chamfer distance, in metres.
    const a = DG;
    const b = DG * Math.SQRT2;
    for (let j = 0; j < DH; j++)
      for (let i = 0; i < DW; i++) {
        const q = j * DW + i;
        let v = d[q];
        if (i > 0) v = Math.min(v, d[q - 1] + a);
        if (j > 0) {
          v = Math.min(v, d[q - DW] + a);
          if (i > 0) v = Math.min(v, d[q - DW - 1] + b);
          if (i < DW - 1) v = Math.min(v, d[q - DW + 1] + b);
        }
        d[q] = v;
      }
    for (let j = DH - 1; j >= 0; j--)
      for (let i = DW - 1; i >= 0; i--) {
        const q = j * DW + i;
        let v = d[q];
        if (i < DW - 1) v = Math.min(v, d[q + 1] + a);
        if (j < DH - 1) {
          v = Math.min(v, d[q + DW] + a);
          if (i < DW - 1) v = Math.min(v, d[q + DW + 1] + b);
          if (i > 0) v = Math.min(v, d[q + DW - 1] + b);
        }
        d[q] = v;
      }
    for (let q = 0; q < d.length; q++) d[q] = smoothstep(40, 260, d[q]);
    return d;
  })();
  /** Hill height above the estate level at (x, z), metres. */
  const hill = (x: number, z: number) => {
    const fx = Math.min(DW - 1.001, Math.max(0, (x - WB.minX) / DG - 0.5));
    const fz = Math.min(DH - 1.001, Math.max(0, (z - WB.minZ) / DG - 0.5));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const q = j * DW + i;
    const w = lerp(lerp(hillW[q], hillW[q + 1], tx), lerp(hillW[q + DW], hillW[q + DW + 1], tx), tz);
    if (w <= 0) return 0;
    return HILL * w * smoothstep(-0.45, 0.6, fbm(x / 520, z / 520, SEED + 21, 3));
  };
  /** The dry ground level (estate level plus hills), ignoring water and ramps. */
  const baseAt = (x: number, z: number) => LAND + hill(x, z);
  // Bridge deck heights along each deck edge (centre line), made on demand.
  const roadDeckCache = new Map<number, Float32Array>();
  const deckY = (i: number) => {
    let d = roadDeckCache.get(i);
    if (d) return d;
    const pts = EP[i];
    const cum = ECUM[i];
    const len = ELEN[i];
    d = new Float32Array(pts.length);
    for (let k = 0; k < pts.length; k++) {
      // Low bridges arch a little over the water.
      const arch = !isDeck[i] || elevated[i] ? 0 : 0.4 * smoothstep(0, 10, cum[k]) * smoothstep(0, 10, len - cum[k]);
      d[k] = baseAt(pts[k][0], pts[k][1]) + relAlong(i, cum[k]) + arch;
    }
    roadDeckCache.set(i, d);
    return d;
  };
  /** Deck height at a SegIndex hit on edge i. */
  const deckAtHit = (i: number, seg: number, u: number) => {
    const d = deckY(i);
    return lerp(d[seg], d[Math.min(d.length - 1, seg + 1)], u);
  };

  // ---------- Ground height ----------
  const probe = { s: 60, w: 30 };
  /** The smooth ground, before it is sealed under the roads (roads drape on this). */
  function rawHeight(x: number, z: number): number {
    const s = coastSD(x, z);
    probe.s = s;
    probe.w = 30;
    const hb = baseAt(x, z);
    let h = hb;
    if (s < BEACH) {
      h = s >= 0 ? lerp(0.3, hb, smoothstep(0, BEACH, s)) : 0.3 - 1.5 * smoothstep(0, 22, -s) - 3 * smoothstep(22, 70, -s);
      h += 0.1 * (valueNoise(x / 9, z / 9, SEED + 4) - 0.5);
    }
    if (s > -4) {
      const w = wetSD(x, z);
      probe.w = w;
      if (w < 6) {
        const cut = w > 0 ? lerp(WL + 0.15, h, smoothstep(0, 5, w)) : lerp(WL + 0.15, WL - 1.1, smoothstep(0, 3, -w));
        h = Math.min(h, cut);
      }
    }
    // Roads always stay on level ground: over canals, tidal river mouths and
    // beaches they run on an embankment (bridges and culverts in real life).
    // (Bridge decks span the water instead.)
    if (h < hb - 0.02) {
      const r = roads.nearest(x, z, 24, (i) => !isDeck[i]);
      if (r) h = lerp(h, hb, smoothstep(EHALF[r.line] + 8, EHALF[r.line] + 1.5, r.d));
    }
    // Embankments carry the roads up to the flyovers.
    // Where several meet or run side by side, the highest wins.
    if (nearRamp(x, z)) {
      const h0 = h;
      rampIdx.each(x, z, 48, (line, seg, u, d) => {
        const inner = EHALF[line] + 1.5;
        if (d > inner + 2 + 3 * DECK_H * 2) return;
        const pts = EP[line];
        const sl = Math.hypot(pts[seg + 1][0] - pts[seg][0], pts[seg + 1][1] - pts[seg][1]);
        const rel = relAlong(line, ECUM[line][seg] + u * sl);
        // The road is level across its width: its height is the centre line's.
        const top = baseAt(lerp(pts[seg][0], pts[seg + 1][0], u), lerp(pts[seg][1], pts[seg + 1][1], u)) + rel;
        if (rel <= 0.02 || top <= h0) return;
        h = Math.max(h, lerp(h0, top, smoothstep(inner + 2 + rel * 3, inner, d)));
      });
      // ...but a bank never climbs onto a road beside it: every road keeps
      // its own level across its width, and ground can rise from its edge no
      // steeper than 1 in 2. (Where that cuts a bank short, the raised road
      // gets a retaining wall.)
      levelIdx.each(x, z, 30, (line, seg, u, d) => {
        const pts = EP[line];
        const sl = Math.hypot(pts[seg + 1][0] - pts[seg][0], pts[seg + 1][1] - pts[seg][1]);
        const rel = relAlong(line, ECUM[line][seg] + u * sl);
        const yr = hasProfile[line] ? baseAt(lerp(pts[seg][0], pts[seg + 1][0], u), lerp(pts[seg][1], pts[seg + 1][1], u)) + rel : hb;
        const cap = yr + Math.max(0, d - EHALF[line] - 0.6) / 2;
        if (cap < h) h = cap;
      });
    }
    if (s > BEACH) {
      const o = openness(x, z);
      if (o > 0) h += 0.7 * o * Math.max(0, fbm(x / 50, z / 50, SEED + 9) + 0.25);
    }
    return h;
  }
  /**
   * The ground as built (mesh, collider, trees): the smooth ground, sealed
   * under every road. The mesh is a 4 m grid of straight-edged triangles, so
   * any bump within one cell of a road can show through it once interpolated.
   * Within SEAL m of a road's kerb the ground is held just below that road's
   * surface, and only rises again beyond that.
   */
  const SEAL = 6;
  function heightAt(x: number, z: number): number {
    let h = rawHeight(x, z);
    if (!(cell(x, z) & NEAR_ROAD)) return h;
    const ps = probe.s;
    const pw = probe.w;
    roads.each(x, z, 14 + SEAL, (line, seg, u, d) => {
      if (elevated[line]) return;
      const half = EHALF[line] + 0.35;
      if (d > half + SEAL + 2) return;
      const pts = EP[line];
      const cx = lerp(pts[seg][0], pts[seg + 1][0], u);
      const cz = lerp(pts[seg][1], pts[seg + 1][1], u);
      let yr: number;
      if (hasProfile[line]) yr = deckAtHit(line, seg, u);
      else {
        // A draped road's surface at its edge nearest this point.
        const t = d > half ? half / d : 1;
        yr = Math.max(rawHeight(cx + (x - cx) * t, cz + (z - cz) * t), WL + 0.15);
      }
      const cap = yr - 0.12 + Math.max(0, d - half - SEAL);
      if (cap < h) h = cap;
    });
    probe.s = ps;
    probe.w = pw;
    return h;
  }

  // ---------- Ground colour ----------
  const C = (r: number, g: number, b: number) => new THREE.Color(r, g, b);
  const KIND_COLOR: THREE.Color[] = [
    C(0.33, 0.47, 0.24), // none: lawns and verges
    C(0.31, 0.48, 0.22), // residential
    C(0.6, 0.59, 0.55), // commercial
    C(0.58, 0.58, 0.56), // industrial
    C(0.58, 0.48, 0.34), // construction
    C(0.38, 0.49, 0.28), // other
    C(0.4, 0.41, 0.42), // parking
    C(0.25, 0.47, 0.17), // park
    C(0.3, 0.5, 0.2), // grass
    C(0.24, 0.55, 0.2), // pitch
    C(0.18, 0.34, 0.13), // wood
    C(0.24, 0.31, 0.18), // mangrove
    C(0.93, 0.86, 0.68), // beach
    C(0.36, 0.42, 0.34), // water (bed)
  ];
  const SAND = C(0.93, 0.86, 0.68);
  const WET_SAND = C(0.72, 0.64, 0.48);
  const SEABED = C(0.55, 0.6, 0.5);
  const PAVING = C(0.62, 0.62, 0.6);
  const BANK = C(0.5, 0.52, 0.46);
  const DRY = C(0.42, 0.5, 0.24);
  function colorAt(x: number, z: number, y: number, out: THREE.Color) {
    const c = cell(x, z);
    out.copy(c & BLD ? PAVING : KIND_COLOR[c & 15]);
    if (SOFT.has(c & 15) && !(c & BLD)) out.lerp(DRY, valueNoise(x / 25, z / 25, SEED + 2) * 0.5);
    const s = probe.s;
    if (s < BEACH) {
      out.lerp(SAND, smoothstep(BEACH, BEACH - 5, s));
      if (s < 6) out.lerp(WET_SAND, smoothstep(6, 0, s));
      if (y < -0.1) out.lerp(SEABED, smoothstep(-0.1, -1.5, y));
    }
    if (probe.w < 3) out.lerp(BANK, smoothstep(3, 0, probe.w));
    return out;
  }

  function surfaceAt(x: number, z: number, y: number): Surface {
    const r = roads.nearest(x, z, 12, (i) => !elevated[i]);
    if (r && r.d < EHALF[r.line] + 0.3) return SURFACES.asphalt;
    const up = elevIdx.nearest(x, z, 12);
    if (up && up.d < EHALF[up.line] + 0.6 && y > deckAtHit(up.line, up.seg, up.u) - 1.5) return SURFACES.asphalt;
    const s = coastSD(x, z);
    if (s < 0 && y < 0.05) return SURFACES.water;
    if (y < WL - 0.05 && wetSD(x, z) < 0) return SURFACES.water;
    const p = pathIdx.nearest(x, z, 4);
    if (p && p.d < PHALF[p.line] + 0.2) return SURFACES.asphalt;
    if (s < BEACH - 2) {
      const drag = 10 + 22 * smoothstep(BEACH - 2, 4, s);
      return { name: drag > 26 ? 'Soft sand' : 'Sand', grip: 0.62, drag };
    }
    const c = cell(x, z) & 15;
    if (c === KI.parking || c === KI.commercial || c === KI.industrial) return SURFACES.asphalt;
    if (c === KI.construction) return SURFACES.dirt;
    if (c === KI.mangrove) return SURFACES.mud;
    if (c === KI.beach) return SURFACES.sand;
    if (c === KI.wood) return SURFACES.dirt;
    return SURFACES.grass;
  }

  // ---------- Tile jobs ----------
  // Jobs add meshes to the tile, or fill the tile's shared buffers (one
  // mesh per material per tile, made once all jobs are done: fewer draws).
  type AccFor = (key: AccKey) => Acc;
  type Job = (kit: TileKit, acc: AccFor) => void;
  const jobs = { near: new Map<string, Job[]>(), far: new Map<string, Job[]>(), horizon: new Map<string, Job[]>() };
  const tileKey = (x: number, z: number) => `${Math.floor(x / TILE)},${Math.floor(z / TILE)}`;
  const onTile = (layer: Layer, k: string, job: Job) => {
    const list = jobs[layer].get(k);
    if (list) list.push(job);
    else jobs[layer].set(k, [job]);
  };
  /** One job per `size` items, so each build step stays short. */
  const inChunks = <T>(layer: Layer, k: string, items: T[], size: number, job: (part: T[], kit: TileKit, acc: AccFor) => void) => {
    for (let s = 0; s < items.length; s += size) {
      const part = items.slice(s, s + size);
      onTile(layer, k, (kit, acc) => job(part, kit, acc));
    }
  };

  // ---------- Terrain patches (shared lattice, as on the East Coast) ----------
  const groundMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  const DETAIL_M = 2.5;
  if (detailed) {
    const tex = D.groundDetailTexture();
    groundMat.map = tex;
    groundMat.bumpMap = tex;
    groundMat.bumpScale = 1.6;
    groundMat.color.setScalar(0.82);
    D.patchGroundMaterial(groundMat);
  }
  const lattice = (step: number, v0: number, hi: number, t0: number, t1: number) => {
    const k0 = Math.max(0, Math.floor((t0 - v0) / step));
    const k1 = Math.min(Math.round((hi - v0) / step), Math.floor((t1 - v0) / step));
    return k1 > k0 ? [k0, k1] : null;
  };
  type Patch = { w: number; h: number; pos: Float32Array; clr: Float32Array; uvs: Float32Array; idx: Uint32Array } | null;
  const patchCache = new Map<string, Patch>();
  const gridIndex = new Map<string, Uint32Array>();
  const gridIdx = (w: number, h: number) => {
    const k = `${w}x${h}`;
    let idx = gridIndex.get(k);
    if (!idx) {
      idx = new Uint32Array((w - 1) * (h - 1) * 6);
      let q = 0;
      for (let j = 0; j < h - 1; j++)
        for (let i = 0; i < w - 1; i++) {
          const a = j * w + i;
          idx.set([a, a + w, a + 1, a + 1, a + w, a + w + 1], q);
          q += 6;
        }
      gridIndex.set(k, idx);
    }
    return idx;
  };
  const col = new THREE.Color();
  function* ensurePatch(ti: number, tj: number, step: number): Generator<void, Patch, void> {
    const k = `${ti},${tj},${step}`;
    if (patchCache.has(k)) return patchCache.get(k)!;
    const cx = lattice(step, WB.minX, WB.maxX, ti * TILE, (ti + 1) * TILE);
    const cz = lattice(step, WB.minZ, WB.maxZ, tj * TILE, (tj + 1) * TILE);
    let t: Patch = null;
    if (cx && cz) {
      const w = cx[1] - cx[0] + 1;
      const h = cz[1] - cz[0] + 1;
      const pos = new Float32Array(w * h * 3);
      const clr = new Float32Array(w * h * 3);
      const uvs = new Float32Array(w * h * 2);
      let top = -Infinity;
      let slice = performance.now();
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const x = WB.minX + (cx[0] + i) * step;
          const z = WB.minZ + (cz[0] + j) * step;
          const y = heightAt(x, z);
          top = Math.max(top, y);
          const q = j * w + i;
          pos.set([x, y, z], q * 3);
          uvs.set([x / DETAIL_M, z / DETAIL_M], q * 2);
          colorAt(x, z, y, col);
          const v = 0.9 + 0.2 * valueNoise(x / 3.3, z / 3.3, SEED + 11);
          clr.set([col.r * v, col.g * v, col.b * v], q * 3);
        }
        if (performance.now() - slice > 1.5) {
          yield;
          slice = performance.now();
        }
      }
      if (top > -2.6) t = { w, h, pos, clr, uvs, idx: gridIdx(w, h) };
    }
    patchCache.set(k, t);
    if (patchCache.size > 96) patchCache.delete(patchCache.keys().next().value!);
    return t;
  }
  const groundMesh = (t: NonNullable<Patch>, kit: TileKit, skirt: boolean) => {
    const geo = kit.own(new THREE.BufferGeometry());
    let { pos, clr, uvs, idx } = t;
    if (skirt) {
      const { w, h } = t;
      const ring: number[] = [];
      for (let i = 0; i < w; i++) ring.push(i);
      for (let j = 1; j < h; j++) ring.push(j * w + w - 1);
      for (let i = w - 2; i >= 0; i--) ring.push((h - 1) * w + i);
      for (let j = h - 2; j >= 0; j--) ring.push(j * w);
      const n0 = w * h;
      const P = new Float32Array((n0 + ring.length) * 3);
      const Cc = new Float32Array((n0 + ring.length) * 3);
      const U = new Float32Array((n0 + ring.length) * 2);
      P.set(pos);
      Cc.set(clr);
      U.set(uvs);
      ring.forEach((v, r) => {
        P.set([pos[v * 3], pos[v * 3 + 1] - 3, pos[v * 3 + 2]], (n0 + r) * 3);
        Cc.set(clr.subarray(v * 3, v * 3 + 3), (n0 + r) * 3);
        U.set(uvs.subarray(v * 2, v * 2 + 2), (n0 + r) * 2);
      });
      const I = new Uint32Array(idx.length + ring.length * 6);
      I.set(idx);
      let q = idx.length;
      for (let r = 0; r < ring.length; r++) {
        const a = ring[r];
        const b = ring[(r + 1) % ring.length];
        I.set([a, n0 + r, b, b, n0 + r, n0 + ((r + 1) % ring.length)], q);
        q += 6;
      }
      pos = P;
      clr = Cc;
      uvs = U;
      idx = I;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(clr, 3));
    if (detailed) geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, groundMat);
    mesh.receiveShadow = !skirt;
    kit.add(mesh, skirt);
  };
  const terrainCollider = (t: NonNullable<Patch>, kit: TileKit) => {
    const { w, h, pos } = t;
    const hts = new Float32Array(w * h);
    for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) hts[i * h + j] = pos[(j * w + i) * 3 + 1];
    const sx = (w - 1) * STEP;
    const sz = (h - 1) * STEP;
    world.createCollider(
      RAPIER.ColliderDesc.heightfield(h - 1, w - 1, hts, { x: sx, y: 1, z: sz }).setTranslation(pos[0] + sx / 2, 0, pos[2] + sz / 2).setFriction(0.9),
      kit.body(),
    );
  };

  // ---------- Ribbons: roads, markings, paths, canals ----------
  class Acc {
    pos: number[] = [];
    uv: number[] = [];
    col: number[] = [];
    idx: number[] = [];
  }
  /**
   * A strip along pts[k0..k1], draped on the ground (or at a fixed height).
   * `off` shifts it sideways (positive = left of travel). `keep` can drop
   * segments (dashes, gaps at junctions).
   */
  const strip = (
    acc: Acc,
    pts: XZ[],
    cum: number[],
    k0: number,
    k1: number,
    halfIn: number | ((k: number) => number),
    lift: number,
    o: { off?: number | ((k: number) => number); y?: number; yAt?: (k: number) => number; keep?: (k: number) => boolean } = {},
  ) => {
    const base = acc.pos.length / 3;
    for (let k = k0; k <= k1; k++) {
      const half = typeof halfIn === 'number' ? halfIn : halfIn(k);
      const off = o.off === undefined ? 0 : typeof o.off === 'number' ? o.off : o.off(k);
      const a = pts[Math.max(0, k - 1)];
      const b = pts[Math.min(pts.length - 1, k + 1)];
      const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nx = (b[1] - a[1]) / tl;
      const nz = -(b[0] - a[0]) / tl;
      const [px, pz] = pts[k];
      for (const sgn of [-1, 1]) {
        const x = px + nx * (off + sgn * half);
        const z = pz + nz * (off + sgn * half);
        // Never below the water: paths out over it become boardwalks.
        const yk = o.yAt ? o.yAt(k) : NaN;
        acc.pos.push(x, (yk === yk ? yk : (o.y ?? Math.max(rawHeight(x, z), WL + 0.15))) + lift, z);
        acc.uv.push(((sgn + 1) / 2) * ((half * 2) / 6), cum[k] / 6);
      }
    }
    for (let k = k0; k < k1; k++) {
      if (o.keep && !o.keep(k)) continue;
      const a = base + (k - k0) * 2;
      acc.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  };
  const disc = (acc: Acc, x: number, z: number, r: number, lift: number, y?: number) => {
    const base = acc.pos.length / 3;
    const yc = (y ?? Math.max(rawHeight(x, z), WL + 0.15)) + lift;
    acc.pos.push(x, yc, z);
    acc.uv.push(0, 0);
    const n = 16;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      acc.pos.push(px, (y ?? Math.max(rawHeight(px, pz), WL + 0.15)) + lift, pz);
      acc.uv.push(Math.cos(a) * (r / 6), Math.sin(a) * (r / 6));
    }
    // Counter-clockwise seen from above, so the pad faces up.
    for (let i = 0; i < n; i++) acc.idx.push(base, base + 1 + ((i + 1) % n), base + 1 + i);
  };
  const accMesh = (acc: Acc, mat: THREE.Material, kit: TileKit, upright = false) => {
    if (!acc.idx.length) return;
    const g = kit.own(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(acc.uv, 2));
    g.setIndex(acc.idx);
    if (upright) g.computeVertexNormals(); // walls and railings: light them as walls
    else {
      const nrm = new Float32Array(acc.pos.length);
      for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    }
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    kit.add(m);
  };
  const flatMat = (color: number, offset: number, tex: THREE.Texture | null = null) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset });
    if (tex) {
      m.map = m.bumpMap = tex;
      m.bumpScale = 0.8;
      m.color.multiplyScalar(1.35);
    }
    return m;
  };
  const asphaltTex = detailed ? D.asphaltTexture() : null;
  const tartanTex = detailed ? D.tartanTexture() : null;
  const MAT = {
    road: flatMat(0x4a4c50, -3, asphaltTex),
    kerb: flatMat(0xb9b5aa, -2),
    white: flatMat(0xf2efe4, -5),
    yellow: flatMat(0xe0b52a, -5),
    foot: flatMat(0xbdb7aa, -1),
    cycle: flatMat(0xa45b49, -2, tartanTex),
    rail: flatMat(0xd9d6cf, -1),
    ballast: flatMat(0x7d7872, -1),
    deck: flatMat(0xc4c0b8, 0),
  };
  type AccKey = keyof typeof MAT | 'wall' | 'roof';
  /** Turn a tile's filled buffers into meshes. */
  function* flush(accs: Map<AccKey, Acc>, kit: TileKit): Generator<void, void, void> {
    for (const [key, acc] of accs) {
      yield;
      if (key !== 'wall' && key !== 'roof') {
        accMesh(acc, MAT[key], kit, key === 'deck' || key === 'rail');
        continue;
      }
      if (!acc.pos.length) continue;
      const g = kit.own(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
      if (key === 'wall') g.setAttribute('uv', new THREE.Float32BufferAttribute(acc.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(acc.col, 3));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, key === 'wall' ? wallMat : roofMat);
      m.castShadow = true;
      m.receiveShadow = key === 'wall';
      kit.add(m);
    }
  }

  // Junctions: which edges meet where, for pads and for clipping markings.
  const jEdges = M.junctions.map(() => [] as number[]);
  edges.forEach((e, i) => {
    jEdges[e.a]?.push(i);
    if (e.b !== e.a) jEdges[e.b]?.push(i);
  });
  const jRadius = jEdges.map((list) => Math.max(0, ...list.map((i) => EHALF[i])));
  // At a two-way joint, the half width of the other piece.
  const other = (j: number, me: number) => {
    const l = jEdges[j];
    const o = l[0] === me ? l[1] : l[0];
    return o === undefined ? EHALF[me] : EHALF[o];
  };
  const jHalf2 = jEdges.map((_, j) => (me: number) => other(j, me));
  const jDegree = jEdges.map((l) => l.length);

  // Each edge's segments go to the tile holding their midpoint, in runs.
  const runsOf = (lines: XZ[][]) => {
    const out = new Map<string, { line: number; k0: number; k1: number }[]>();
    lines.forEach((pts, line) => {
      let cur = '';
      let run: { line: number; k0: number; k1: number } | null = null;
      for (let k = 0; k < pts.length - 1; k++) {
        const key = tileKey((pts[k][0] + pts[k + 1][0]) / 2, (pts[k][1] + pts[k + 1][1]) / 2);
        if (key !== cur || !run) {
          run = { line, k0: k, k1: k + 1 };
          cur = key;
          const l = out.get(key);
          if (l) l.push(run);
          else out.set(key, [run]);
        } else run.k1 = k + 1;
      }
    });
    return out;
  };
  /**
   * Is (x, z) on another road's surface at about the same level? For a deck
   * (y = its height) any road within a few metres of that height counts;
   * on the ground, any other ground road.
   */
  const coveredBy = (line: number, x: number, z: number, y: number) => {
    let hit = false;
    roads.each(x, z, 16, (i, seg, u, d) => {
      if (hit || i === line || d > EHALF[i] + 0.2) return;
      if (y !== y) hit = !elevated[i];
      else hit = Math.abs((hasProfile[i] ? deckAtHit(i, seg, u) : heightAt(x, z)) - y) < 3;
    });
    return hit;
  };
  const roadRuns = runsOf(EP);
  for (const [k, all] of roadRuns)
    inChunks('far', k, all, 30, (list, _kit, acc) => {
      const road = acc('road');
      const kerb = acc('kerb');
      const white = acc('white');
      const yellow = acc('yellow');
      for (const { line, k0, k1 } of list) {
        const e = edges[line];
        const pts = EP[line];
        const cum = ECUM[line];
        const half = EHALF[line];
        const rank = rankOf(e.cls);
        const len = cum[cum.length - 1];
        // Where two pieces of one road meet with different widths (OSM lane
        // counts change), taper both to the average so the edge doesn't step.
        const ha = jDegree[e.a] === 2 ? (jHalf2[e.a](line) - half) / 2 : 0;
        const hb = jDegree[e.b] === 2 ? (jHalf2[e.b](line) - half) / 2 : 0;
        const halfAt = (kk: number) => half + ha * (1 - smoothstep(0, 16, cum[kk])) + hb * (1 - smoothstep(0, 16, len - cum[kk]));
        const dy = hasProfile[line] ? deckY(line) : null;
        const yAt = dy ? (kk: number) => dy[kk] : undefined;
        strip(road, pts, cum, k0, k1, halfAt, 0.09, { yAt });
        if (rank >= 1 || dy) strip(kerb, pts, cum, k0, k1, (kk) => halfAt(kk) + 0.35, 0.07, { yAt });
        // Where two roads at one level meet or overlap, a road's own surface is
        // covered by the other: markings and parapets stop there.
        const clear = (kk: number, off: number) => {
          const a = pts[kk];
          const b = pts[kk + 1];
          const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          const x = (a[0] + b[0]) / 2 + ((b[1] - a[1]) / tl) * off;
          const z = (a[1] + b[1]) / 2 - ((b[0] - a[0]) / tl) * off;
          return !coveredBy(line, x, z, dy ? lerp(dy[kk], dy[kk + 1], 0.5) : NaN);
        };
        if (dy && !isDeck[line]) {
          // A raised road: where the ground beside it falls away (its bank
          // was cut short by a road below), a retaining wall, and a parapet
          // where the drop is more than a kerb.
          const deck = acc('deck');
          for (const sgn of [-1, 1]) {
            const off = (kk: number) => sgn * (halfAt(kk) + 0.45);
            const dr = new Float32Array(k1 - k0 + 1);
            for (let kk = k0; kk <= k1; kk++) {
              const a = pts[Math.max(0, kk - 1)];
              const b = pts[Math.min(pts.length - 1, kk + 1)];
              const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
              const o = off(kk) + sgn * 0.6;
              dr[kk - k0] = dy[kk] + 0.09 - heightAt(pts[kk][0] + ((b[1] - a[1]) / tl) * o, pts[kk][1] - ((b[0] - a[0]) / tl) * o);
            }
            const y = (kk: number) => dy[kk] + 0.09;
            band(deck, pts, cum, k0, k1, off, y, (kk) => Math.max(0, dr[kk - k0]) + 0.3, 0.05, (kk) => Math.max(dr[kk - k0], dr[kk + 1 - k0]) > 0.15);
            band(deck, pts, cum, k0, k1, off, y, 0, 0.95, (kk) => Math.min(dr[kk - k0], dr[kk + 1 - k0]) > 1.2 && clear(kk, off(kk)));
          }
        }
        if (dy && isDeck[line]) {
          // Deck sides: a concrete edge beam, an underside and parapets.
          const deck = acc('deck');
          const depth = elevated[line] ? 1.2 : 0.6;
          const side = (sgn: number) => (kk: number) => sgn * (halfAt(kk) + 0.45);
          const y = (kk: number) => dy[kk] + 0.09;
          for (const sgn of [-1, 1]) {
            band(deck, pts, cum, k0, k1, side(sgn), y, depth, 0.05, () => true);
            band(deck, pts, cum, k0, k1, side(sgn), y, 0, 0.95, (kk) => clear(kk, side(sgn)(kk)));
          }
          strip(deck, pts, cum, k0, k1, (kk) => halfAt(kk) + 0.45, 0.09 - depth, { yAt });
        }
        if (rank < 1 || len < 12) continue;
        // Markings stop short of the junction pads.
        const ca = (jDegree[e.a] > 2 ? jRadius[e.a] : 0) + 2;
        const cb = (jDegree[e.b] > 2 ? jRadius[e.b] : 0) + 2;
        const ends = (kk: number) => cum[kk] > ca && cum[kk + 1] < len - cb;
        const solid = (off: (kk: number) => number) => (kk: number) => ends(kk) && clear(kk, off(kk));
        const dashed = (off: (kk: number) => number) => (kk: number) => kk % 3 === 0 && ends(kk) && clear(kk, off(kk));
        if (rank >= 2) {
          const l = (kk: number) => halfAt(kk) - 0.35;
          const r = (kk: number) => -(halfAt(kk) - 0.35);
          strip(yellow, pts, cum, k0, k1, 0.07, 0.11, { off: l, keep: solid(l), yAt });
          strip(yellow, pts, cum, k0, k1, 0.07, 0.11, { off: r, keep: solid(r), yAt });
        }
        const lanes = Math.max(1, Math.round((e.w - 0.7) / 3.3));
        if (e.one) {
          for (let l = 1; l < lanes; l++) {
            const off = () => -half + (l * e.w) / lanes;
            strip(white, pts, cum, k0, k1, 0.07, 0.11, { off: off(), keep: dashed(off), yAt });
          }
        } else if (rank >= 1 && e.w >= 6) {
          const off = () => 0;
          strip(white, pts, cum, k0, k1, 0.07, 0.11, { keep: rank >= 3 ? solid(off) : dashed(off), yAt });
        }
      }
    });
  // Flyover pillars, and colliders for every deck (the ground heightfield
  // can't hold a road in the air).
  const concreteMat = new THREE.MeshStandardMaterial({ color: 0xc9c6bf, roughness: 0.9 });
  const deckLines = EP.map((pts, i) => (hasProfile[i] ? pts : []));
  const deckRuns = runsOf(deckLines);
  const pillarsOf = (line: number, k0: number, k1: number, f: (x: number, z: number, top: number, foot: number, yaw: number, w: number) => void) => {
    if (!elevated[line]) return;
    const pts = EP[line];
    const cum = ECUM[line];
    const dy = deckY(line);
    for (let k = Math.max(1, k0); k <= Math.min(k1, pts.length - 2); k++) {
      // One pier every ~32 m, clear of the ends and of anything below.
      if (Math.floor(cum[k] / 32) === Math.floor(cum[k - 1] / 32)) continue;
      if (cum[k] < 10 || cum[k] > ELEN[line] - 10) continue;
      const [x, z] = pts[k];
      const foot = heightAt(x, z);
      const top = dy[k] - 1.1;
      if (top - foot < 2.5) continue;
      const below = roads.nearest(x, z, 24, (i) => !elevated[i]);
      if (below && below.d < EHALF[below.line] + 1.2) continue;
      const pp = pathIdx.nearest(x, z, 4);
      if (pp && pp.d < PHALF[pp.line] + 0.6) continue;
      const a = pts[k - 1];
      const b = pts[k + 1];
      f(x, z, top, foot, Math.atan2(-(b[1] - a[1]), b[0] - a[0]), EHALF[line]);
    }
  };
  for (const [k, list] of deckRuns) {
    onTile('far', k, (kit) => {
      const parts: THREE.BufferGeometry[] = [];
      for (const { line, k0, k1 } of list)
        pillarsOf(line, k0, k1, (x, z, top, foot, yaw, w) => {
          const hgt = top - foot + 0.5;
          parts.push(new THREE.BoxGeometry(1.5, hgt, 1.5).translate(0, foot - 0.5 + hgt / 2, 0).rotateY(yaw).translate(x, 0, z));
          // A cross-head under the deck.
          parts.push(new THREE.BoxGeometry(1.6, 1.0, Math.max(3, w * 1.6)).translate(0, top - 0.5, 0).rotateY(yaw).translate(x, 0, z));
        });
      if (!parts.length) return;
      const m = new THREE.Mesh(kit.own(mergeGeometries(parts)), concreteMat);
      m.castShadow = true;
      m.receiveShadow = true;
      kit.add(m);
    });
    onTile('near', k, (kit) => {
      const body = kit.body();
      for (const { line, k0, k1 } of list) {
        const pts = EP[line];
        const dy = deckY(line);
        const cum = ECUM[line];
        const len = ELEN[line];
        const half = EHALF[line];
        const ha = jDegree[edges[line].a] === 2 ? (jHalf2[edges[line].a](line) - half) / 2 : 0;
        const hb = jDegree[edges[line].b] === 2 ? (jHalf2[edges[line].b](line) - half) / 2 : 0;
        const halfAt = (kk: number) => half + ha * (1 - smoothstep(0, 16, cum[kk])) + hb * (1 - smoothstep(0, 16, len - cum[kk])) + 0.45;
        // The deck top as a strip of triangles.
        const v: number[] = [];
        const ix: number[] = [];
        for (let kk = k0; kk <= k1; kk++) {
          const a = pts[Math.max(0, kk - 1)];
          const b = pts[Math.min(pts.length - 1, kk + 1)];
          const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          const nx = (b[1] - a[1]) / tl;
          const nz = -(b[0] - a[0]) / tl;
          const h = halfAt(kk);
          const y = dy[kk] + 0.09;
          v.push(pts[kk][0] - nx * h, y, pts[kk][1] - nz * h, pts[kk][0] + nx * h, y, pts[kk][1] + nz * h);
          if (kk < k1) {
            const q = (kk - k0) * 2;
            ix.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
          }
        }
        if (ix.length) world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(v), new Uint32Array(ix)).setFriction(0.9), body);
        // Parapets you can lean on (none where another deck joins).
        for (let kk = k0; kk < k1; kk++) {
          const a = pts[kk];
          const b = pts[kk + 1];
          const sl = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (sl < 0.3) continue;
          const dx = (b[0] - a[0]) / sl;
          const dz = (b[1] - a[1]) / sl;
          const yaw = Math.atan2(-dz, dx);
          const y = (dy[kk] + dy[kk + 1]) / 2 + 0.09;
          for (const sgn of [-1, 1]) {
            const off = sgn * ((halfAt(kk) + halfAt(kk + 1)) / 2 + 0.1);
            const mx = (a[0] + b[0]) / 2 + dz * off;
            const mz = (a[1] + b[1]) / 2 - dx * off;
            if (coveredBy(line, mx + dz * sgn * 0.6, mz - dx * sgn * 0.6, y)) continue;
            // A raised road only needs one where its side drops away.
            if (!isDeck[line] && heightAt(mx + dz * sgn * 0.6, mz - dx * sgn * 0.6) > y - 1.2) continue;
            world.createCollider(
              RAPIER.ColliderDesc.cuboid(sl / 2 + 0.15, 0.6, 0.25)
                .setTranslation(mx, y + 0.5, mz)
                .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }),
              body,
            );
          }
        }
        pillarsOf(line, k0, k1, (x, z, top, foot, yaw) => {
          world.createCollider(
            RAPIER.ColliderDesc.cuboid(0.75, (top - foot) / 2, 0.75)
              .setTranslation(x, (top + foot) / 2, z)
              .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }),
            body,
          );
        });
      }
    });
  }
  // Level pads where decks meet, so no wheel drops through a gap.
  const deckPads = new Map<string, number[]>();
  M.junctions.forEach(([x, z], j) => {
    if (!jEdges[j].some((i) => hasProfile[i])) return;
    const k = tileKey(x, z);
    if (!deckPads.has(k)) deckPads.set(k, []);
    deckPads.get(k)!.push(j);
  });
  for (const [k, list] of deckPads)
    onTile('near', k, (kit) => {
      const body = kit.body();
      for (const j of list) {
        const [x, z] = M.junctions[j];
        const r = (jDegree[j] === 2 ? (EHALF[jEdges[j][0]] + EHALF[jEdges[j][1]]) / 2 : jRadius[j]) + 0.4;
        world.createCollider(RAPIER.ColliderDesc.cylinder(0.25, r).setTranslation(x, padY(j)! + 0.09 - 0.25, z).setFriction(0.9), body);
      }
    });
  // Junction pads: on a deck they sit level with it.
  const padY = (j: number) => {
    const [x, z] = M.junctions[j];
    return jEdges[j].some((i) => hasProfile[i]) ? baseAt(x, z) + jRel[j] : undefined;
  };
  // Junction pads.
  const padsByTile = new Map<string, number[]>();
  M.junctions.forEach(([x, z], j) => {
    // Every joint gets a pad (at a bend between two pieces, the narrower
    // width): it fills the wedge where two ribbons meet at an angle.
    if (!jDegree[j]) return;
    const k = tileKey(x, z);
    const l = padsByTile.get(k);
    if (l) l.push(j);
    else padsByTile.set(k, [j]);
  });
  for (const [k, all] of padsByTile)
    inChunks('far', k, all, 40, (list, _kit, acc) => {
      const road = acc('road');
      const kerb = acc('kerb');
      for (const j of list) {
        const [x, z] = M.junctions[j];
        const r = jDegree[j] === 2 ? (EHALF[jEdges[j][0]] + EHALF[jEdges[j][1]]) / 2 : jRadius[j];
        const y = padY(j);
        disc(road, x, z, r, 0.09, y);
        if (jEdges[j].some((i) => rankOf(edges[i].cls) >= 1)) disc(kerb, x, z, r + 0.35, 0.07, y);
      }
    });
  // Footpaths and park connectors.
  const PCUM = paths.map((p) => {
    const c = [0];
    for (let i = 1; i < p.pts.length; i++) c.push(c[i - 1] + Math.hypot(p.pts[i][0] - p.pts[i - 1][0], p.pts[i][1] - p.pts[i - 1][1]));
    return c;
  });
  // Footbridges: where a path crosses a canal, pond or the sea, its deck runs
  // level from bank to bank (NaN = on the ground).
  const deckCache = new Map<number, Float32Array>();
  const pathDeck = (line: number) => {
    let d = deckCache.get(line);
    if (d) return d;
    const pts = paths[line].pts;
    const cum = PCUM[line];
    const n = pts.length;
    const g = new Float32Array(n);
    const wet = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      g[k] = heightAt(pts[k][0], pts[k][1]);
      wet[k] = probe.s < 0 || probe.w < 0.5 ? 1 : 0;
    }
    d = new Float32Array(n).fill(NaN);
    for (let k = 0; k < n; ) {
      if (!wet[k]) {
        k++;
        continue;
      }
      let e = k;
      while (e < n && wet[e]) e++;
      const a = k - 1; // dry ground either side (or the path's end)
      const b = e;
      const ya = a >= 0 ? g[a] : b < n ? g[b] : LAND;
      const yb = b < n ? g[b] : ya;
      const sa = cum[Math.max(0, a)];
      const sb = cum[Math.min(n - 1, b)];
      for (let q = Math.max(0, a); q <= Math.min(n - 1, b); q++) {
        const t = sb > sa ? (cum[q] - sa) / (sb - sa) : 0;
        d[q] = Math.max(lerp(ya, yb, t), WL + 0.6) + 0.15;
      }
      k = e;
    }
    deckCache.set(line, d);
    return d;
  };
  /** A vertical band along pts at sideways offset `off`, from y(k) - below to y(k) + above. */
  const band = (acc: Acc, pts: XZ[], cum: number[], k0: number, k1: number, offIn: number | ((k: number) => number), y: (k: number) => number, belowIn: number | ((k: number) => number), above: number, keep: (k: number) => boolean) => {
    const base = acc.pos.length / 3;
    for (let k = k0; k <= k1; k++) {
      const a = pts[Math.max(0, k - 1)];
      const b = pts[Math.min(pts.length - 1, k + 1)];
      const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const off = typeof offIn === 'number' ? offIn : offIn(k);
      const x = pts[k][0] + ((b[1] - a[1]) / tl) * off;
      const z = pts[k][1] - ((b[0] - a[0]) / tl) * off;
      const yk = y(k);
      const below = typeof belowIn === 'number' ? belowIn : belowIn(k);
      acc.pos.push(x, yk - below, z, x, yk + above, z);
      acc.uv.push(0, cum[k] / 6, 1, cum[k] / 6);
    }
    for (let k = k0; k < k1; k++) {
      if (!keep(k)) continue;
      const q = base + (k - k0) * 2;
      acc.idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
    }
  };
  // Footpaths sit just under cycle paths, so where they overlap the cycle
  // path shows cleanly instead of the two flickering.
  for (const [k, all] of runsOf(paths.map((p) => p.pts)))
    inChunks('far', k, all, 40, (list, _kit, acc) => {
      const foot = acc('foot');
      const cyc = acc('cycle');
      const rail = acc('rail');
      for (const { line, k0, k1 } of list) {
        const pa = paths[line];
        const cycle = pa.k === 'cycle';
        const into = cycle ? cyc : foot;
        const lift = cycle ? 0.075 : 0.05;
        const deck = pathDeck(line);
        const yAt = (kk: number) => deck[kk];
        strip(into, pa.pts, PCUM[line], k0, k1, PHALF[line], lift, { yAt });
        // Round ends, so paths that meet or branch join without a notch.
        if (k0 === 0 && deck[0] !== deck[0]) disc(into, pa.pts[0][0], pa.pts[0][1], PHALF[line], lift);
        if (k1 === pa.pts.length - 1 && deck[k1] !== deck[k1]) disc(into, pa.pts[k1][0], pa.pts[k1][1], PHALF[line], lift);
        // Bridge sides: a deck edge and railings.
        const onBridge = (kk: number) => deck[kk] === deck[kk] && deck[kk + 1] === deck[kk + 1];
        let any = false;
        for (let kk = k0; kk < k1; kk++) if (onBridge(kk)) any = true;
        if (!any) continue;
        const y = (kk: number) => (deck[kk] === deck[kk] ? deck[kk] : heightAt(pa.pts[kk][0], pa.pts[kk][1])) + lift;
        for (const side of [-1, 1]) {
          band(rail, pa.pts, PCUM[line], k0, k1, side * (PHALF[line] + 0.05), y, 0.35, 0, onBridge);
          band(rail, pa.pts, PCUM[line], k0, k1, side * (PHALF[line] - 0.05), y, 0, 0.9, onBridge);
        }
      }
    });

  // ---------- Water ----------
  const wind = { value: 0 };
  const SEA = { w: 13000, d: 13000 };
  const seaGeo = new THREE.PlaneGeometry(SEA.w, SEA.d, 260, 260);
  seaGeo.rotateX(-Math.PI / 2);
  const seaMat = new THREE.MeshStandardMaterial({ color: 0x2f7c86, roughness: 0.22, metalness: 0.15, transparent: true, opacity: 0.88 });
  seaMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = wind;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;').replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       transformed.y += sin(position.x * 0.045 + uTime * 0.9) * 0.12 + sin(position.z * 0.07 - uTime * 1.3 + position.x * 0.01) * 0.1;`,
    );
  };
  const pondMat = new THREE.MeshStandardMaterial({ color: 0x3f7f78, roughness: 0.15, metalness: 0.1, side: THREE.DoubleSide });
  if (detailed) {
    const wn = D.waterNormalTexture();
    wn.repeat.set(SEA.w / 22, SEA.d / 22);
    Object.assign(seaMat, { normalMap: wn, roughness: 0.06, metalness: 0, opacity: 0.92 });
    seaMat.color.set(0x1d6874);
    seaMat.normalScale.set(0.55, 0.55);
    D.patchWaterMaterial(seaMat, wind);
    const pn = D.waterNormalTexture();
    Object.assign(pondMat, { normalMap: pn, roughness: 0.05, metalness: 0 });
    pondMat.normalScale.set(0.25, 0.25);
    pondMat.color.set(0x2f6a66);
  }
  const sea = new THREE.Mesh(seaGeo, seaMat);
  sea.receiveShadow = true;
  scene.add(sea);
  // Ponds and reservoirs: flat polygons at the canal level, on the horizon layer.
  const pondsByTile = new Map<string, XZ[][]>();
  for (const w of waterAreas) {
    let x = 0;
    let z = 0;
    for (const p of w) {
      x += p[0];
      z += p[1];
    }
    const k = tileKey(x / w.length, z / w.length);
    if (!pondsByTile.has(k)) pondsByTile.set(k, []);
    pondsByTile.get(k)!.push(w);
  }
  const waterUV = (g: THREE.BufferGeometry) => {
    const p = g.attributes.position;
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) uv.set([p.getX(i) / 14, p.getZ(i) / 14], i * 2);
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  };
  for (const [k, list] of pondsByTile)
    onTile('horizon', k, (kit) => {
      const pos: number[] = [];
      for (const ring of list) {
        const tris = THREE.ShapeUtils.triangulateShape(ring.map(([x, z]) => new THREE.Vector2(x, z)), []);
        for (const t of tris) for (const v of t) pos.push(ring[v][0], WL, ring[v][1]);
      }
      const g = kit.own(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      waterUV(g);
      kit.add(new THREE.Mesh(g, pondMat));
    });
  const CCUM = canals.map((c) => {
    const s = [0];
    for (let i = 1; i < c.pts.length; i++) s.push(s[i - 1] + Math.hypot(c.pts[i][0] - c.pts[i - 1][0], c.pts[i][1] - c.pts[i - 1][1]));
    return s;
  });
  for (const [k, list] of runsOf(canals.map((c) => c.pts)))
    onTile('horizon', k, (kit) => {
      const acc = new Acc();
      for (const { line, k0, k1 } of list) strip(acc, canals[line].pts, CCUM[line], k0, k1, canals[line].w / 2 + 0.6, -0.02, { y: WL });
      if (!acc.idx.length) return;
      const g = kit.own(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
      g.setIndex(acc.idx);
      g.computeVertexNormals();
      waterUV(g);
      kit.add(new THREE.Mesh(g, pondMat));
    });

  // ---------- Vegetation kinds ----------
  const tint = (g: THREE.BufferGeometry, c: number) => {
    const color = new THREE.Color(c);
    const arr = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < arr.length; i += 3) color.toArray(arr, i);
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  };
  const merge = (parts: THREE.BufferGeometry[]) => {
    const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
    g.computeVertexNormals();
    return g;
  };
  const swayMat = (strength: number, o: THREE.MeshStandardMaterialParameters = {}) => {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true, ...o });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = wind;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;').replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         #ifdef USE_INSTANCING
           vec3 ip = instanceMatrix[3].xyz;
         #else
           vec3 ip = vec3(0.0);
         #endif
         float hgt = max(position.y, 0.0);
         float gust = 0.6 + 0.4 * sin(uTime * 0.37 + ip.x * 0.01);
         transformed.x += sin(uTime * 1.6 + ip.x * 0.11 + ip.z * 0.07) * ${strength.toFixed(4)} * hgt * gust;
         transformed.z += cos(uTime * 1.2 + ip.x * 0.05) * ${(strength * 0.6).toFixed(4)} * hgt * gust;`,
      );
    };
    return m;
  };
  const plainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  interface VegKind { geo: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[]; shadow: boolean; collide?: number; hues: [number, number, number, number] }
  const frond = (a: number) => tint(new THREE.BoxGeometry(3.4, 0.08, 0.7).translate(1.7, 0, 0).rotateZ(-0.45).rotateY(a).translate(0, 8, 0), 0xffffff);
  const kinds: Record<string, VegKind> = {
    rain: {
      geo: merge([
        tint(new THREE.CylinderGeometry(0.28, 0.45, 5, 6).translate(0, 2.5, 0), 0x5b4636),
        tint(new THREE.IcosahedronGeometry(1, 1).scale(4.6, 1.5, 4.6).translate(0, 6, 0), 0xffffff),
        tint(new THREE.IcosahedronGeometry(1, 1).scale(3.2, 1.2, 3.2).translate(1.6, 6.9, 0.8), 0xffffff),
      ]),
      mat: swayMat(0.012),
      shadow: true,
      collide: 0.45,
      hues: [0.27, 0.42, 0.34, 0.05],
    },
    palm: {
      geo: merge([
        tint(new THREE.CylinderGeometry(0.18, 0.28, 8, 6).translate(0, 4, 0), 0x8a7356),
        ...Array.from({ length: 8 }, (_, i) => frond((i / 8) * Math.PI * 2 + 0.2)),
        tint(new THREE.IcosahedronGeometry(0.45, 0).translate(0, 7.8, 0), 0x6b5a2e),
      ]),
      mat: swayMat(0.02),
      shadow: true,
      collide: 0.3,
      hues: [0.22, 0.5, 0.38, 0.04],
    },
    casuarina: {
      geo: merge([
        tint(new THREE.CylinderGeometry(0.15, 0.3, 3, 5).translate(0, 1.5, 0), 0x5b4636),
        tint(new THREE.ConeGeometry(1.8, 9, 7).translate(0, 7, 0), 0xffffff),
      ]),
      mat: swayMat(0.015),
      shadow: true,
      collide: 0.3,
      hues: [0.3, 0.35, 0.3, 0.03],
    },
    almond: {
      geo: merge([
        tint(new THREE.CylinderGeometry(0.22, 0.35, 6, 6).translate(0, 3, 0), 0x5b4636),
        tint(new THREE.CylinderGeometry(3.6, 3.8, 0.6, 8).translate(0, 4.2, 0), 0xffffff),
        tint(new THREE.CylinderGeometry(2.6, 2.8, 0.6, 8).translate(0, 5.4, 0), 0xffffff),
        tint(new THREE.CylinderGeometry(1.5, 1.7, 0.6, 8).translate(0, 6.5, 0), 0xffffff),
      ]),
      mat: swayMat(0.01),
      shadow: true,
      collide: 0.35,
      hues: [0.25, 0.45, 0.36, 0.06],
    },
    shrub: { geo: tint(new THREE.IcosahedronGeometry(1, 1), 0xffffff), mat: swayMat(0.02), shadow: false, hues: [0.27, 0.45, 0.3, 0.05] },
    mangrove: {
      geo: merge([
        ...[0, 2.1, 4.2].map((a) => tint(new THREE.CylinderGeometry(0.06, 0.1, 1.6, 4).rotateZ(0.5).rotateY(a).translate(Math.cos(a) * 0.5, 0.6, -Math.sin(a) * 0.5), 0x5b4a3a)),
        tint(new THREE.IcosahedronGeometry(1, 1).scale(2.4, 1.3, 2.4).translate(0, 2.4, 0), 0xffffff),
      ]),
      mat: swayMat(0.01),
      shadow: true,
      collide: 0.6,
      hues: [0.26, 0.4, 0.24, 0.04],
    },
    grass: { geo: tint(new THREE.ConeGeometry(0.16, 0.6, 4), 0x7a9a40), mat: plainMat, shadow: false, hues: [0.23, 0.32, 0.6, 0.04] },
  };
  if (detailed && D.DETAILED_FOLIAGE) {
    const atlas = D.foliageAtlas();
    const leafOpts = { map: atlas, alphaTest: 0.45, side: THREE.DoubleSide, flatShading: false, roughness: 0.8 };
    const foliage = (s: number) => [swayMat(s, { map: atlas, flatShading: false, roughness: 0.85 }), swayMat(s, leafOpts)];
    Object.assign(kinds.rain, { geo: D.rainTreeGeo(1), mat: foliage(0.012), hues: [0.27, 0.45, 0.62, 0.05] });
    Object.assign(kinds.palm, { geo: D.palmGeo(2), mat: foliage(0.02), hues: [0.2, 0.5, 0.66, 0.04] });
    Object.assign(kinds.casuarina, { geo: D.casuarinaGeo(3), mat: foliage(0.015), hues: [0.28, 0.35, 0.6, 0.03] });
    Object.assign(kinds.almond, { geo: D.almondGeo(4), mat: foliage(0.01), hues: [0.25, 0.48, 0.62, 0.06] });
    const shrubD = D.shrubGeo(5);
    Object.assign(kinds.shrub, { geo: shrubD, mat: foliage(0.02), hues: [0.27, 0.45, 0.55, 0.05] });
    Object.assign(kinds.mangrove, { geo: D.shrubGeo(6).clone().scale(2.2, 1.6, 2.2), mat: foliage(0.01), hues: [0.26, 0.42, 0.45, 0.04] });
    Object.assign(kinds.grass, { geo: D.grassTuftGeo(), mat: swayMat(0.04, leafOpts) });
  }

  // ---------- Trees, planted per tile ----------
  const tileRand = (i: number, j: number, salt: number) => mulberry32((SEED * 7919) ^ (i * 73856093) ^ (j * 19349663) ^ salt);
  const clearOfRoads = (x: number, z: number, pad: number) => {
    const r = roads.nearest(x, z, 16);
    if (r && r.d < EHALF[r.line] + pad) return false;
    // Nothing grows up through a flyover.
    const up = elevIdx.nearest(x, z, 24);
    if (up && up.d < EHALF[up.line] + 7) return false;
    const p = pathIdx.nearest(x, z, 4);
    return !(p && p.d < PHALF[p.line] + 0.8);
  };
  type Plant = { kind: string; x: number; z: number; s: number };
  const nearOnly = new Set<{ mesh: THREE.InstancedMesh; x: number; z: number }>();
  const dummy = new THREE.Object3D();
  const vcol = new THREE.Color();
  function* plantTile(ti: number, tj: number, kit: TileKit): Generator<void, void, void> {
    const rand = tileRand(ti, tj, 1);
    const plants: Plant[] = [];
    const x0 = ti * TILE;
    const z0 = tj * TILE;
    // Street trees: rain trees and sea almonds every ~12 m on both verges.
    for (const { line, k0, k1 } of roadRuns.get(`${ti},${tj}`) ?? []) {
      const e = edges[line];
      if (!TREE_LINED.has(e.cls) || elevated[line]) continue;
      const pts = EP[line];
      for (let k = k0; k < k1; k++) {
        if (k % 3 !== 1) continue;
        const [ax, az] = pts[k];
        const [bx, bz] = pts[k + 1];
        const tl = Math.hypot(bx - ax, bz - az) || 1;
        for (const side of [-1, 1]) {
          if (rand() < 0.25) continue;
          const off = (EHALF[line] + 2.4 + rand() * 0.8) * side;
          const x = ax + ((bz - az) / tl) * off;
          const z = az - ((bx - ax) / tl) * off;
          const c = cell(x, z);
          if (c & BLD || (c & 15) === KI.parking || (c & 15) === KI.water) continue;
          if (coastSD(x, z) < 6 || wetSD(x, z) < 2 || !clearOfRoads(x, z, 1.6)) continue;
          plants.push({ kind: rand() < 0.65 ? 'rain' : 'almond', x, z, s: 0.8 + rand() * 0.35 });
        }
      }
    }
    yield;
    // Parks, woods, mangroves and the lawns between blocks.
    for (let n = 0; n < 900; n++) {
      if (n % 300 === 299) yield;
      const x = x0 + rand() * TILE;
      const z = z0 + rand() * TILE;
      const c = cell(x, z);
      if (c & (BLD | NEAR_ROAD | NEAR_PATH | NEAR_WET)) continue;
      const k = c & 15;
      const s = coastSD(x, z);
      if (s < 2) continue;
      const grove = valueNoise(x / 60, z / 60, SEED + 21);
      const r = rand();
      let kind: string | null = null;
      if (s < BEACH + 6) {
        if (s > 9 && r < 0.12) kind = rand() < 0.6 ? 'casuarina' : 'palm';
      } else if (k === KI.wood) {
        if (r < 0.55) kind = rand() < 0.6 ? 'rain' : rand() < 0.5 ? 'almond' : 'shrub';
      } else if (k === KI.mangrove) {
        if (r < 0.6) kind = 'mangrove';
      } else if (k === KI.park) {
        if (r < 0.4 * smoothstep(0.35, 0.7, grove)) kind = rand() < 0.5 ? 'rain' : rand() < 0.5 ? 'almond' : 'palm';
        else if (r > 0.96) kind = 'shrub';
      } else if (k === KI.residential || k === KI.none || k === KI.other) {
        if (r < 0.1) kind = rand() < 0.45 ? 'rain' : rand() < 0.5 ? 'palm' : 'almond';
        else if (r > 0.95) kind = 'shrub';
      } else if (k === KI.grass) {
        if (r < 0.05) kind = rand() < 0.5 ? 'rain' : 'shrub';
      }
      if (!kind) continue;
      plants.push({ kind, x, z, s: kind === 'shrub' ? 0.6 + rand() * 0.7 : 0.8 + rand() * 0.45 });
    }
    if (detailed && D.DETAILED_FOLIAGE) {
      const rd = tileRand(ti, tj, 2);
      for (let n = 0; n < 2400; n++) {
        const x = x0 + rd() * TILE;
        const z = z0 + rd() * TILE;
        const c = cell(x, z);
        if (c & (BLD | NEAR_ROAD | NEAR_PATH | NEAR_WET) || !SOFT.has(c & 15)) continue;
        plants.push({ kind: 'grass', x, z, s: 0.7 + rd() * 0.8 });
      }
    }
    yield;
    const byKind = new Map<string, Plant[]>();
    for (const p of plants) {
      if (!byKind.has(p.kind)) byKind.set(p.kind, []);
      byKind.get(p.kind)!.push(p);
    }
    for (const [name, list] of byKind) {
      yield;
      const kind = kinds[name];
      const im = new THREE.InstancedMesh(kind.geo, kind.mat, list.length);
      const [hh, ss, ll, jit] = kind.hues;
      const b = kind.collide ? kit.body() : null;
      list.forEach((p, i) => {
        const y = heightAt(p.x, p.z);
        dummy.position.set(p.x, y - 0.05, p.z);
        dummy.rotation.set(0, rand() * Math.PI * 2, 0);
        if (name === 'shrub') dummy.scale.set(p.s * 1.3, p.s * 0.8, p.s * 1.3);
        else dummy.scale.setScalar(p.s);
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
        im.setColorAt(i, vcol.setHSL(hh + (rand() - 0.5) * jit, ss + (rand() - 0.5) * 0.1, ll + (rand() - 0.5) * 0.1));
        if (b) world.createCollider(RAPIER.ColliderDesc.cylinder(1.5, kind.collide! * p.s).setTranslation(p.x, y + 1.5, p.z), b);
      });
      im.castShadow = kind.shadow;
      im.receiveShadow = !kind.shadow;
      im.computeBoundingSphere();
      kit.add(im);
      if (name === 'grass') nearOnly.add({ mesh: im, x: (ti + 0.5) * TILE, z: (tj + 0.5) * TILE });
    }
  }

  // ---------- Buildings from their footprints ----------
  const facade = detailed ? D.facadeTexture() : (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#9aa7b0';
    for (let y = 0; y < 64; y += 16) {
      g.fillRect(6, y + 5, 20, 7);
      g.fillRect(38, y + 5, 20, 7);
    }
    g.fillStyle = '#d8d8d8';
    for (let y = 0; y < 64; y += 16) g.fillRect(0, y + 14, 64, 2);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  })();
  const wallMat = new THREE.MeshStandardMaterial({ map: facade, vertexColors: true, roughness: 0.85, side: THREE.DoubleSide, ...(detailed ? { bumpMap: facade, bumpScale: 1.2 } : {}) });
  const roofMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
  const HDB_COLORS = [0xf3e9d2, 0xf6d8c4, 0xd8e6ef, 0xdcebd7, 0xe9e2f2, 0xf1f1ee, 0xf2e0b8, 0xcfe0e8];
  const LANDED = new Set(['house', 'terrace', 'semidetached_house', 'detached', 'bungalow']);
  const SMALL = new Set(['hut', 'shed', 'toilets', 'kiosk', 'gatehouse', 'guardhouse', 'container', 'pavilion', 'utility', 'service', 'garage']);
  const SKIP = new Set(['bridge', 'no', 'construction']);
  const hash = (x: number, z: number) => {
    const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
    return s - Math.floor(s);
  };
  interface Bld { pts: XZ[]; h: number; wall: number; roof: number; walls: boolean; base: number; ground: number }
  const blds: Bld[] = [];
  const bldTile = new Map<string, number[]>();
  for (const b of M.buildings) {
    if (SKIP.has(b.k) || b.pts.length < 3) continue;
    const pts = ringArea(b.pts) < 0 ? [...b.pts].reverse() : b.pts;
    const area = Math.abs(ringArea(pts));
    let cx = 0;
    let cz = 0;
    for (const p of pts) {
      cx += p[0];
      cz += p[1];
    }
    cx /= pts.length;
    cz /= pts.length;
    const r = hash(cx, cz);
    const landuse = cell(cx, cz) & 15;
    let floors: number;
    let fh = 3;
    let wall = 0xe9e4da;
    let roof = 0x9a9c9e;
    let walls = true;
    if (b.k === 'roof') {
      floors = 0;
      walls = false;
    } else if (b.k === 'apartments' || b.k === 'residential' || b.k === 'dormitory' || (b.k === 'yes' && area > 450 && (landuse === KI.residential || landuse === KI.none))) {
      floors = 10 + Math.floor(r * 7); // HDB slab and point blocks
      fh = 2.9;
      wall = HDB_COLORS[Math.floor(r * 97) % HDB_COLORS.length];
      roof = r > 0.5 ? 0xb7563c : 0x8d8f91;
    } else if (LANDED.has(b.k)) {
      floors = 2 + (r > 0.6 ? 1 : 0);
      fh = 3.2;
      wall = [0xf2ead8, 0xe8dcc4, 0xf6efe6, 0xdfe3e0][Math.floor(r * 4)];
      roof = r > 0.3 ? 0xa4553b : 0x6f6a66;
    } else if (b.k === 'parking') {
      floors = 5 + Math.floor(r * 3);
      fh = 2.8;
      wall = 0xd7d5cf;
    } else if (['industrial', 'warehouse', 'data_center', 'hangar'].includes(b.k) || landuse === KI.industrial) {
      floors = 3 + Math.floor(r * 3);
      fh = 4.5;
      wall = [0xd8dde2, 0xc9d3dc, 0xe2e2dc][Math.floor(r * 3)];
      roof = 0x8f98a0;
    } else if (['commercial', 'retail', 'office', 'hotel', 'supermarket'].includes(b.k) || landuse === KI.commercial) {
      floors = 4 + Math.floor(r * 5);
      fh = 4;
      wall = [0xe6e1d6, 0xd6e2ea, 0xeadfcf][Math.floor(r * 3)];
    } else if (b.k === 'train_station' || b.k === 'transportation') {
      floors = 3;
      fh = 5;
      wall = 0xdedbd2;
    } else if (SMALL.has(b.k) || area < 120) {
      floors = 1;
      fh = 3;
    } else if (b.k === 'yes' && area < 450) {
      floors = 1 + Math.floor(r * 2);
      fh = 3.4;
    } else {
      floors = 3 + Math.floor(r * 3); // schools, community clubs, temples...
      fh = 3.6;
      wall = [0xefe6d6, 0xe3eadf, 0xf1e2d8][Math.floor(r * 3)];
      roof = 0xa65a40;
    }
    let h = b.h ?? (b.l ? b.l * fh : floors * fh);
    if (!walls) h = 3.4;
    // On a slope the building stands on its lowest corner; its foot sinks into the high side.
    let low = Infinity;
    for (const [px, pz] of pts) low = Math.min(low, baseAt(px, pz));
    const ground = low === Infinity ? LAND : low;
    const base = ground - 0.5;
    const i = blds.length;
    blds.push({ pts, h, wall, roof, walls, base, ground });
    const k = tileKey(cx, cz);
    if (!bldTile.has(k)) bldTile.set(k, []);
    bldTile.get(k)!.push(i);
  }
  const wc = new THREE.Color();
  const rc = new THREE.Color();
  for (const [k, ids] of bldTile) {
    // Meshes on the horizon layer (the skyline), in batches so each build step stays short.
    inChunks('horizon', k, ids, 12, (part, _kit, acc) => {
        const { pos: wp, uv: wu, col: wcl } = acc('wall');
        const { pos: rp, col: rcl } = acc('roof');
        for (const id of part) {
          const b = blds[id];
          const top = b.ground + b.h;
          wc.set(b.wall);
          rc.set(b.roof);
          const n = b.pts.length;
          if (b.walls) {
            let along = 0;
            for (let q = 0; q < n; q++) {
              const [ax, az] = b.pts[q];
              const [bx, bz] = b.pts[(q + 1) % n];
              const len = Math.hypot(bx - ax, bz - az);
              const u0 = along / 12;
              const u1 = (along + len) / 12;
              along += len;
              const v0 = 0;
              const v1 = (top - b.base) / 11.6;
              wp.push(ax, b.base, az, bx, b.base, bz, bx, top, bz, ax, b.base, az, bx, top, bz, ax, top, az);
              wu.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
              for (let c = 0; c < 6; c++) wcl.push(wc.r, wc.g, wc.b);
            }
          }
          const roofY = top;
          const tris = THREE.ShapeUtils.triangulateShape(b.pts.map(([x, z]) => new THREE.Vector2(x, z)), []);
          for (const t of tris)
            for (const v of t) {
              rp.push(b.pts[v][0], roofY, b.pts[v][1]);
              rcl.push(rc.r, rc.g, rc.b);
            }
          if (!b.walls) {
            // Covered walkways and canopies: a slab on thin posts (no collider).
            for (const t of tris)
              for (const v of t) {
                rp.push(b.pts[v][0], roofY - 0.3, b.pts[v][1]);
                rcl.push(rc.r, rc.g, rc.b);
              }
          }
        }
      });
    // Walls you can bump into, near the car only: a thick slab inside each wall.
    inChunks('near', k, ids, 25, (part, kit) => {
      const body = kit.body();
      for (const id of part) {
        const b = blds[id];
        if (!b.walls) continue;
        const n = b.pts.length;
        for (let q = 0; q < n; q++) {
          const [ax, az] = b.pts[q];
          const [bx, bz] = b.pts[(q + 1) % n];
          const len = Math.hypot(bx - ax, bz - az);
          if (len < 0.5) continue;
          const dx = (bx - ax) / len;
          const dz = (bz - az) / len;
          // Counter-clockwise rings (positive area) have the inside on the right of travel: (-dz, dx).
          const t = Math.min(0.8, len / 2);
          const mx = (ax + bx) / 2 - dz * t;
          const mz = (az + bz) / 2 + dx * t;
          const a = Math.atan2(-dz, dx);
          world.createCollider(
            RAPIER.ColliderDesc.cuboid(len / 2 + 0.2, Math.min(4, b.h / 2), t)
              .setTranslation(mx, b.ground + Math.min(4, b.h / 2) - 0.4, mz)
              .setRotation({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) }),
            body,
          );
        }
      }
    });
  }

  // ---------- MRT viaducts ----------
  const concrete = new THREE.MeshStandardMaterial({ color: 0xc9c6bf, roughness: 0.9 });
  const viaducts = M.rail.filter((r) => r.bridge && !r.tunnel).map((r) => resample(r.pts, 6));
  const VCUM = viaducts.map((pts) => {
    const c = [0];
    for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    return c;
  });
  // The track runs 9 m above the (hilly) ground.
  const railY = (line: number, q: number) => baseAt(viaducts[line][q][0], viaducts[line][q][1]) + 9;
  for (const [k, list] of runsOf(viaducts)) {
    onTile('horizon', k, (kit) => {
      const top = new Acc();
      const parts: THREE.BufferGeometry[] = [];
      for (const { line, k0, k1 } of list) {
        strip(top, viaducts[line], VCUM[line], k0, k1, 2.6, 0, { yAt: (q) => railY(line, q) });
        for (let q = k0; q <= k1; q++) {
          if (q % 5) continue;
          const [x, z] = viaducts[line][q];
          const foot = heightAt(x, z) - 0.5;
          const top = railY(line, q) - 1.1;
          parts.push(new THREE.BoxGeometry(1.4, top - foot, 1.4).translate(x, (top + foot) / 2, z));
        }
      }
      const g = kit.own(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(top.pos, 3));
      g.setIndex(top.idx);
      g.computeVertexNormals();
      // A deck with some depth: draw the strip, then a thicker underside copy.
      const deck = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xc9c6bf, roughness: 0.9, side: THREE.DoubleSide }));
      deck.castShadow = true;
      kit.add(deck);
      const under = deck.clone();
      under.position.y = -1.1;
      kit.add(under);
      if (parts.length) {
        const pm = new THREE.Mesh(kit.own(mergeGeometries(parts)), concrete);
        pm.castShadow = true;
        kit.add(pm);
      }
    });
    onTile('near', k, (kit) => {
      const body = kit.body();
      for (const { line, k0, k1 } of list)
        for (let q = k0; q <= k1; q++) {
          if (q % 5) continue;
          const [x, z] = viaducts[line][q];
          world.createCollider(RAPIER.ColliderDesc.cuboid(0.7, 4, 0.7).setTranslation(x, heightAt(x, z) + 3.5, z), body);
        }
    });
  }
  const ground = M.rail.filter((r) => !r.bridge && !r.tunnel).map((r) => resample(r.pts, 6));
  const GCUM = ground.map((pts) => {
    const c = [0];
    for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    return c;
  });
  for (const [k, list] of runsOf(ground))
    onTile('far', k, (_kit, acc) => {
      for (const { line, k0, k1 } of list) strip(acc('ballast'), ground[line], GCUM[line], k0, k1, 1.8, 0.04);
    });

  // ---------- Play boundary ----------
  {
    const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const cx = (WB.minX + WB.maxX) / 2;
    const cz = (WB.minZ + WB.maxZ) / 2;
    const hx = (WB.maxX - WB.minX) / 2;
    const hz = (WB.maxZ - WB.minZ) / 2;
    for (const [x, z, sx, sz] of [
      [cx, WB.minZ + 2, hx, 0.5],
      [cx, WB.maxZ - 2, hx, 0.5],
      [WB.minX + 2, cz, 0.5, hz],
      [WB.maxX - 2, cz, 0.5, hz],
    ])
      world.createCollider(RAPIER.ColliderDesc.cuboid(sx, 6, sz).setTranslation(x, 3, z), fixed);
  }

  // ---------- Streaming ----------
  const builder = (layer: Layer) =>
    function* (ti: number, tj: number, kit: TileKit) {
      const t = yield* ensurePatch(ti, tj, layer === 'horizon' ? STEP_FAR : STEP);
      if (t) {
        if (layer === 'near') terrainCollider(t, kit);
        else groundMesh(t, kit, layer === 'horizon');
      }
      yield;
      if (layer === 'near') yield* plantTile(ti, tj, kit);
      const accs = new Map<AccKey, Acc>();
      const acc = (key: AccKey) => {
        let a = accs.get(key);
        if (!a) accs.set(key, (a = new Acc()));
        return a;
      };
      for (const job of jobs[layer].get(`${ti},${tj}`) ?? []) {
        job(kit, acc);
        yield;
      }
      yield* flush(accs, kit);
    };
  const streamer = new TileStreamer(scene, world, RAPIER, { near: builder('near'), far: builder('far'), horizon: builder('horizon') }, WB);

  // ---------- Names: parks and estates, then the road you're on ----------
  const named = M.areas
    .filter((a) => a.name && ['park', 'wood', 'beach', 'mangrove', 'pitch', 'residential', 'commercial', 'other', 'industrial', 'water'].includes(a.kind))
    .map((a) => {
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (const [x, z] of a.pts) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        z0 = Math.min(z0, z);
        z1 = Math.max(z1, z);
      }
      return { name: a.name!, kind: a.kind, pts: a.pts, x0, x1, z0, z1, area: Math.abs(ringArea(a.pts)) };
    });
  const namedGrid = new Map<string, number[]>();
  named.forEach((a, i) => {
    for (let gi = Math.floor(a.x0 / 200); gi <= Math.floor(a.x1 / 200); gi++)
      for (let gj = Math.floor(a.z0 / 200); gj <= Math.floor(a.z1 / 200); gj++) {
        const k = `${gi},${gj}`;
        if (!namedGrid.has(k)) namedGrid.set(k, []);
        namedGrid.get(k)!.push(i);
      }
  });
  const areaAt = (x: number, z: number, parksOnly: boolean) => {
    let best: (typeof named)[number] | null = null;
    for (const i of namedGrid.get(`${Math.floor(x / 200)},${Math.floor(z / 200)}`) ?? []) {
      const a = named[i];
      const park = ['park', 'wood', 'beach', 'mangrove', 'water'].includes(a.kind);
      if (parksOnly !== park) continue;
      if (x < a.x0 || x > a.x1 || z < a.z0 || z > a.z1 || !inRing(a.pts, x, z)) continue;
      if (!best || a.area < best.area) best = a;
    }
    return best?.name ?? null;
  };
  function zoneAt(x: number, z: number): string | null {
    for (const c of camps) if (Math.hypot(x - c.x, z - c.z) < c.radius + 20) return c.label;
    const park = areaAt(x, z, true);
    if (park) return park;
    const r = roads.nearest(x, z, 14, (i) => !!edges[i].name);
    if (r) return edges[r.line].name!;
    if (coastSD(x, z) < BEACH) return 'Beach';
    return areaAt(x, z, false);
  }

  // ---------- Start, camps ----------
  const findArea = (re: RegExp) => M.areas.find((a) => a.name && re.test(a.name));
  const centroid = (pts: XZ[]): XZ => {
    let x = 0;
    let z = 0;
    for (const p of pts) {
      x += p[0];
      z += p[1];
    }
    return [x / pts.length, z / pts.length];
  };
  const carparkC = findArea(/^Carpark C Pasir Ris Park/);
  const [sx, sz] = carparkC ? centroid(carparkC.pts) : [86, -1202];
  const sr = roads.nearest(sx, sz, 300)!;
  const spts = EP[sr.line];
  const sa = spts[sr.seg];
  const sb = spts[sr.seg + 1];
  const startX = sa[0] + (sb[0] - sa[0]) * sr.u;
  const startZ = sa[1] + (sb[1] - sa[1]) * sr.u;
  const startYaw = Math.atan2(-(sb[1] - sa[1]), sb[0] - sa[0]);
  // Camp on the grass behind the beach, inland of a carpark.
  const campNear = (x: number, z: number) => {
    const c = coast.nearest(x, z, 1500);
    if (!c) return null;
    const pts = M.coast[c.line];
    const a = pts[c.seg];
    const b = pts[c.seg + 1];
    const px = a[0] + (b[0] - a[0]) * c.u;
    const pz = a[1] + (b[1] - a[1]) * c.u;
    const d = Math.hypot(x - px, z - pz) || 1;
    return { x: px + ((x - px) / d) * (BEACH + 12), z: pz + ((z - pz) / d) * (BEACH + 12) };
  };
  const carparkD = findArea(/^Car Park D$/);
  const campSpot = carparkD ? campNear(...centroid(carparkD.pts)) : campNear(sx, sz);
  const camps = campSpot ? [{ id: 'pasir-ris', label: 'Pasir Ris Park camp', x: campSpot.x, z: campSpot.z, radius: 26 }] : [];

  // ---------- Map ----------
  const MAP_COLOR: Record<string, string> = {
    residential: '#cddcb6', commercial: '#ddd3c6', industrial: '#d5d0d8', construction: '#d9cba9', other: '#d3d6c4',
    parking: '#bfbfbf', park: '#a2d083', grass: '#b1d793', pitch: '#92d38d', wood: '#80b26a', mangrove: '#79a37c', beach: '#efe1b0', water: '#7fb6d4',
  };
  const mapAreas: MapData['areas'] = [];
  if (mask) {
    // Sea, from the land mask's runs.
    mask.rows.forEach((runs, j) => {
      let i = 0;
      runs.forEach((n, r) => {
        if (r % 2 && n) {
          const x0 = mask.x0 + i * mask.cell;
          const z0 = mask.z0 + j * mask.cell;
          mapAreas.push({ pts: [[x0, z0], [x0 + n * mask.cell, z0], [x0 + n * mask.cell, z0 + mask.cell + 0.5], [x0, z0 + mask.cell + 0.5]], color: '#7fb6d4' });
        }
        i += n;
      });
    });
  }
  const order = ['residential', 'commercial', 'industrial', 'other', 'construction', 'park', 'grass', 'wood', 'mangrove', 'pitch', 'parking', 'beach', 'water'];
  [...M.areas]
    .filter((a) => MAP_COLOR[a.kind])
    .sort((p, q) => order.indexOf(p.kind) - order.indexOf(q.kind) || Math.abs(ringArea(q.pts)) - Math.abs(ringArea(p.pts)))
    .forEach((a) => mapAreas.push({ pts: a.pts, color: MAP_COLOR[a.kind] }));
  for (const b of blds) mapAreas.push({ pts: b.pts, color: b.walls ? '#b9b1a7' : '#cfc9c0' });
  const mapLines: MapData['lines'] = [
    ...canals.map((c) => ({ pts: c.pts, width: c.w, color: '#7fb6d4' })),
    ...paths.map((p) => ({ pts: p.pts, width: 1.6, color: p.k === 'cycle' ? '#c98a73' : '#e2dccd' })),
    ...viaducts.map((pts) => ({ pts, width: 5, color: '#8d8d96' })),
    ...edges
      .map((e, i) => ({ e, i }))
      .sort((p, q) => rankOf(p.e.cls) - rankOf(q.e.cls))
      .map(({ e, i }) => ({ pts: EP[i], width: e.w, color: rankOf(e.cls) >= 5 ? '#f3c46b' : rankOf(e.cls) >= 3 ? '#f8e29a' : '#ffffff' })),
  ];
  const pois: MapData['pois'] = [];
  const seen = new Set<string>();
  for (const a of [...named].sort((p, q) => q.area - p.area)) {
    // Labels for the big parks, woods and waters only, so the map stays readable.
    if (seen.has(a.name) || !['park', 'wood', 'water', 'mangrove', 'beach'].includes(a.kind) || a.area < 60000 || a.name === 'Neighbourhood Park') continue;
    const [x, z] = centroid(a.pts);
    if (x < WB.minX + 100 || x > WB.maxX - 100 || z < WB.minZ + 100 || z > WB.maxZ - 100) continue;
    seen.add(a.name);
    pois.push({ x, z, label: a.name });
  }
  for (const a of M.areas)
    if (a.kind === 'parking' && a.name && /Pasir Ris Park|^Car ?[Pp]ark [A-H]$/.test(a.name)) {
      const [x, z] = centroid(a.pts);
      pois.push({ x, z, label: 'P' });
    }
  for (const c of camps) pois.push({ x: c.x, z: c.z, label: c.label });
  const map: MapData = { bounds: { ...WB }, background: '#d6d8cc', areas: mapAreas, lines: mapLines, pois, pxPerM: 0.5, attribution: M.attribution };

  // Test hook: ?debug exposes the road plan to the map checks (tools/check).
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug'))
    (globalThis as any).__osm = { surfaceAt: rawHeight, edges, EP, ECUM, EHALF, elevated, isDeck, embank, hasProfile, deckY, jRel, baseAt, heightAt, paths, PHALF, roads };
  return {
    name: 'Pasir Ris & Tampines',
    styles: true,
    camps,
    start: new THREE.Vector3(startX, heightAt(startX, startZ) + 1.4, startZ),
    startYaw,
    heightAt,
    surfaceAt,
    zoneAt,
    poseAt: () => ({ pos: new THREE.Vector3(startX, heightAt(startX, startZ), startZ), yaw: startYaw }),
    trackT: () => 0,
    map,
    sky: { background: 0xc9dbe6, fog: 0xd6dfe2, fogNear: 150, fogFar: 1700 },
    prepareAt(x, z) {
      streamer.prepare(x, z);
    },
    safeSpot(x, z) {
      // The nearest point on a proper road (not a service lane), on dry ground.
      for (const R of [60, 200, 600, 2000]) {
        const r = roads.nearest(x, z, R, (i) => rankOf(edges[i].cls) >= 1 && !isDeck[i] && !embank[i]);
        if (!r) continue;
        const pts = EP[r.line];
        const a = pts[r.seg];
        const b = pts[r.seg + 1];
        const px = a[0] + (b[0] - a[0]) * r.u;
        const pz = a[1] + (b[1] - a[1]) * r.u;
        if (heightAt(px, pz) < baseAt(px, pz) - 0.1) continue;
        return { x: px, z: pz, yaw: Math.atan2(-(b[1] - a[1]), b[0] - a[0]) };
      }
      return null;
    },
    surfaceY(x, z, y) {
      const g = heightAt(x, z);
      const r = roads.nearest(x, z, 12, (i) => hasProfile[i]);
      if (r && r.d < EHALF[r.line] + 0.6) {
        const d = deckAtHit(r.line, r.seg, r.u) + 0.09;
        if (y > d - 2.5) return Math.max(g, d);
      }
      return g;
    },
    streamStats: () => streamer.stats,
    update(time, _dt, cam, player) {
      wind.value = time;
      const focus = player ?? cam;
      if (focus) {
        streamer.update(focus.x, focus.z);
      }
      if (cam)
        for (const g of nearOnly) {
          if (!g.mesh.parent) nearOnly.delete(g);
          else g.mesh.visible = Math.hypot(g.x - cam.x, g.z - cam.z) < 260;
        }
    },
  };
}
