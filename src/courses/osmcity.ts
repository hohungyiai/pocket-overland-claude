import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fbm, lerp, mulberry32, smoothstep, valueNoise } from '../noise';
import { SURFACES, type Course, type MapData, type Surface, type XZ } from './types';
import * as D from './detail';
import { TILE, TileStreamer, type Layer, type TileKit } from '../world/stream';
import { SegIndex, inRing, resample, ringArea } from '../world/segindex';
import { inRingXZ, shapeJunctions } from '../world/junctions';
import { LIMITS } from '../limits';

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
  // A road leaving a joint alongside a bridge deck (OSM often draws a slip
  // road within a metre or two of the viaduct it joins) is pushed out to
  // the side until the two lie clear of each other: the deck soon climbs
  // away from it, and where the two overlapped one would stand across the
  // other's lanes as a ledge. (A gore, as on a real road.) Both ends stay
  // where they are.
  {
    const PUSH_IN = 10; // m from the joint to full width apart
    const PUSH_OUT = 12; // m back in before the far end
    const half = (i: number) => edges[i].w / 2;
    const deck = (i: number) => (edges[i].lv ?? 0) > 0;
    const byNode = new Map<number, number[]>();
    edges.forEach((e, i) => {
      for (const j of [e.a, e.b]) (byNode.get(j) ?? byNode.set(j, []).get(j)!).push(i);
    });
    const cumOf = (P: XZ[]) => {
      const c = [0];
      for (let k = 1; k < P.length; k++) c.push(c[k - 1] + Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]));
      return c;
    };
    // Nearest point of polyline P to (x, z): [distance, unit normal (left of P) toward it, signed side].
    const nearestOn = (P: XZ[], x: number, z: number) => {
      let best = Infinity;
      let side = 0;
      let nx = 0;
      let nz = 0;
      for (let k = 0; k + 1 < P.length; k++) {
        const [ax, az] = P[k];
        const [bx, bz] = P[k + 1];
        const dx = bx - ax, dz = bz - az;
        const L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
        const px = ax + dx * t, pz = az + dz * t;
        const d = Math.hypot(x - px, z - pz);
        if (d < best) {
          best = d;
          const L = Math.sqrt(L2);
          nx = dz / L;
          nz = -dx / L;
          side = Math.sign((x - px) * nx + (z - pz) * nz);
        }
      }
      return { d: best, nx, nz, side };
    };
    for (const [j, list] of byNode) {
      if (list.length < 2) continue;
      for (const o of list) {
        if (deck(o)) continue;
        const fromA = edges[o].a === j;
        const Po = fromA ? EP[o].map((p) => [p[0], p[1]] as XZ) : [...EP[o]].reverse().map((p) => [p[0], p[1]] as XZ);
        const co = cumOf(Po);
        const len = co[co.length - 1];
        if (len < PUSH_IN + PUSH_OUT) continue;
        // The deck at this joint that o runs along furthest (closer than
        // clear, past the joint), if any.
        let i = -1;
        let most = 0;
        // (Only a deck leaving the joint on o's side of it, within 90°: one
        // carrying on from o, as a bridge piece of the same road, is not
        // beside it.)
        const dirOut = (P: XZ[], atStart: boolean): XZ => {
          const n = P.length;
          const k = Math.min(n - 1, 3);
          const [a, b] = atStart ? [P[0], P[k]] : [P[n - 1], P[n - 1 - k]];
          const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
        };
        const od = dirOut(Po, true);
        for (const d of list) {
          if (!deck(d)) continue;
          const dd = dirOut(EP[d], edges[d].a === j);
          if (od[0] * dd[0] + od[1] * dd[1] < 0) continue;
          const need = half(d) + half(o) + 0.5;
          let over = 0;
          Po.forEach((p, k) => {
            if (k > 0 && co[k] >= 2 && co[k] <= len - 2) over += Math.max(0, need - 0.5 - nearestOn(EP[d], p[0], p[1]).d) * (co[k] - co[k - 1]);
          });
          if (over > most) {
            most = over;
            i = d;
          }
        }
        if (i < 0) continue;
        const Pi = EP[i];
        const need = half(i) + half(o) + 0.5;
        const short = Po.map((p, k) => (k === 0 ? 0 : Math.max(0, need - nearestOn(Pi, p[0], p[1]).d)));
        // o's own left normal at each point.
        const nrm = Po.map((_, k) => {
          const a = Po[Math.max(0, k - 1)];
          const b = Po[Math.min(Po.length - 1, k + 1)];
          const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          return [(b[1] - a[1]) / L, -(b[0] - a[0]) / L] as XZ;
        });
        // Away from the deck: the side o lies on where it is PUSH_IN out.
        const kp = Math.min(Po.length - 1, Math.ceil(PUSH_IN / 4));
        let side = 0;
        {
          let best = Infinity;
          for (const q of Pi) {
            const d = Math.hypot(q[0] - Po[kp][0], q[1] - Po[kp][1]);
            if (d < best) {
              best = d;
              side = -Math.sign((q[0] - Po[kp][0]) * nrm[kp][0] + (q[1] - Po[kp][1]) * nrm[kp][1]);
            }
          }
        }
        if (!side) side = 1;
        // Smoothed (a running max over 8 m either side), eased in and out,
        // then rounded off so the road bends aside without a kink.
        let f = Po.map((_, k) => {
          let m = 0;
          for (let q = 0; q < Po.length; q++) if (Math.abs(co[q] - co[k]) <= 8) m = Math.max(m, short[q]);
          return m * smoothstep(0, PUSH_IN, co[k]) * smoothstep(0, PUSH_OUT, len - co[k]);
        });
        for (let pass = 0; pass < 2; pass++)
          f = f.map((v, k) => (k === 0 || k === f.length - 1 ? v : Math.max(v, (f[k - 1] + 2 * v + f[k + 1]) / 4)));
        EP[o] = Po.map((p, k) => [p[0] + nrm[k][0] * side * f[k], p[1] + nrm[k][1] * side * f[k]] as XZ);
        if (!fromA) EP[o].reverse();
      }
    }
  }
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
  // ---------- Junction shapes ----------
  // Half width along a road: where two pieces of one road meet with different
  // widths (OSM lane counts change), both taper to the average.
  // Widths change gently: where a road meets the next piece of the same road
  // at a different width (OSM splits a way where a lane is added or dropped),
  // the wider one tapers to the narrower at no more than 1 m per 20 m
  // (WIDTH_RATE). (At a junction, the junction's own shape joins roads of
  // different widths.)
  const WIDTH_RATE = 1 / 20;
  /** The next piece of the same road at a plain joint (two roads), if any. */
  const throughOf = (j: number, me: number) => {
    const l = (jE[j] ?? []).filter((o) => edges[o].a !== edges[o].b);
    if (l.length !== 2 || !l.includes(me)) return undefined;
    return l[0] === me ? l[1] : l[0];
  };
  // A road's pieces, joined end to end where one carries straight on from
  // the next, are a run; along each run the width changes no faster than
  // WIDTH_RATE.
  const mate = (i: number, j: number) => {
    const o = throughOf(j, i);
    return o !== undefined && o !== i && throughOf(j, o) === i ? o : undefined;
  };
  /** Each edge's run, where it starts along it, and which way it runs. */
  const runOf = edges.map(() => ({ run: -1, at: 0, fwd: true }));
  const runs: { len: number; smooth: Float32Array }[] = [];
  edges.forEach((e0, i0) => {
    if (runOf[i0].run >= 0) return;
    // Walk back to the start of the run (or once round a loop).
    let i = i0;
    let j = e0.a; // the end we walk out of
    const seen = new Set([i0]);
    for (;;) {
      const o = mate(i, j);
      if (o === undefined || seen.has(o)) break;
      seen.add(o);
      j = edges[o].a === j ? edges[o].b : edges[o].a;
      i = o;
    }
    // Now walk forward from i, entering at j.
    const list: { i: number; fwd: boolean }[] = [];
    const inRun = new Set<number>();
    let at = j;
    for (let q = i; q !== undefined && !inRun.has(q) && runOf[q].run < 0; ) {
      const fwd = edges[q].a === at;
      list.push({ i: q, fwd });
      inRun.add(q);
      at = fwd ? edges[q].b : edges[q].a;
      q = mate(q, at) as number;
    }
    const r = runs.length;
    let len = 0;
    for (const { i: q, fwd } of list) {
      runOf[q] = { run: r, at: len, fwd };
      len += ELEN[q];
    }
    // The OSM widths every metre along the run.
    const n = Math.max(1, Math.ceil(len));
    const smooth = new Float32Array(n + 1);
    {
      let q = 0;
      let start = 0;
      for (let m = 0; m <= n; m++) {
        while (q < list.length - 1 && m > start + ELEN[list[q].i]) start += ELEN[list[q++].i];
        smooth[m] = EHALF[list[q].i];
      }
    }
    // Where it narrows, the wider piece tapers in to meet the narrower one
    // (as a lane is dropped), so the road is never drawn wider than OSM
    // has it: the narrowest width within reach, plus the taper. (Twice over
    // for a run round a loop.)
    const last = list[list.length - 1];
    const loop = list.length > 1 && mate(last.i, last.fwd ? edges[last.i].b : edges[last.i].a) === list[0].i;
    const rate = WIDTH_RATE / 2;
    for (let pass = 0; pass < (loop ? 2 : 1); pass++) {
      for (let m = 1; m <= n; m++) smooth[m] = Math.min(smooth[m], smooth[m - 1] + rate);
      if (loop) smooth[0] = Math.min(smooth[0], smooth[n - 1] + rate);
      for (let m = n - 1; m >= 0; m--) smooth[m] = Math.min(smooth[m], smooth[m + 1] + rate);
      if (loop) smooth[n] = Math.min(smooth[n], smooth[1] + rate);
    }
    runs.push({ len: n, smooth });
  });
  const halfAtE = (i: number, k: number) => {
    const { run, at, fwd } = runOf[i];
    const R = runs[run];
    if (!R) return EHALF[i];
    const s = Math.max(0, Math.min(R.len, at + (fwd ? ECUM[i][k] : ELEN[i] - ECUM[i][k])));
    const m = Math.floor(s);
    const u = s - m;
    return R.smooth[m] + (R.smooth[Math.min(R.len, m + 1)] - R.smooth[m]) * u;
  };
  const JX = shapeJunctions({
    junctions: M.junctions,
    edges,
    EP,
    ECUM,
    halfAt: halfAtE,
    rank: (i) => rankOf(edges[i].cls),
    // Flyover decks keep plain pads; ramps and ground roads join shaped junctions.
    shapeable: (i) => !isDeck[i],
    roads,
  });
  // Junction heights above the ground: full height at a flyover's ends, then
  // falling away along the roads that lead to it. A junction may have a cap
  // (a road there runs under a flyover), and a road between two very
  // different heights climbs more steeply than RAMP_GRADE.
  const jRel = new Float32Array(M.junctions.length);
  const jCap = new Float32Array(M.junctions.length).fill(Infinity);
  const deckEnd = new Uint8Array(M.junctions.length);
  // Extra height wanted at points along a road (a slip road raised to meet
  // a deck beside it, or a deck raised to clear a road below): each falls
  // away at RAMP_GRADE both ways.
  const needs: { s: number; rel: number }[][] = edges.map(() => []);
  // A road is level across a shaped junction (out to its mouth), so every
  // road leaves the junction at the junction's own height; it climbs or
  // falls only beyond. runA / runB: distance along the climb from each end.
  // Two roads leaving a joint at a shallow angle overlap until they have
  // drawn apart by their widths: both stay level there (at the joint's
  // height), so neither stands above the other where the car crosses
  // between them, and only climb or fall beyond. sepA / sepB: how far.
  const along = (i: number, fromA: boolean, s: number): XZ => {
    const P = EP[i];
    const cum = ECUM[i];
    const L = ELEN[i];
    const t = fromA ? s : L - s;
    let k = 0;
    while (k < P.length - 2 && cum[k + 1] <= t) k++;
    const u = Math.max(0, Math.min(1, (t - cum[k]) / (cum[k + 1] - cum[k] || 1)));
    return [lerp(P[k][0], P[k + 1][0], u), lerp(P[k][1], P[k + 1][1], u)];
  };
  const sepA = new Float32Array(edges.length);
  const sepB = new Float32Array(edges.length);
  const mates = edges.map(() => [] as { o: number; ia: boolean; oa: boolean; L: number }[]);
  jE.forEach((list, j) => {
    if (list.length < 2) return;
    for (const i of list)
      for (const o of list) {
        // (Two flyover decks climb together.)
        if (o === i || (elevated[i] && elevated[o])) continue;
        const ia = edges[i].a === j;
        const oa = edges[o].a === j;
        const far = Math.min(40, ELEN[i], ELEN[o]);
        const need = EHALF[i] + EHALF[o];
        let s = 0;
        while (s < far) {
          const [x1, z1] = along(i, ia, s + 1);
          const [x2, z2] = along(o, oa, s + 1);
          if (Math.hypot(x1 - x2, z1 - z2) >= need) break;
          s += 1;
        }
        if (s < 2) continue;
        // Two roads on the ground (or ramps) share one height where they
        // overlap (see relAlong); beside a flyover deck, a road stays level.
        if (!elevated[i] && !elevated[o]) {
          mates[i].push({ o, ia, oa, L: s });
          continue;
        }
        if (ia) sepA[i] = Math.max(sepA[i], s);
        else sepB[i] = Math.max(sepB[i], s);
      }
  });
  const trimA = (i: number) => Math.min(Math.max(elevated[i] ? 0 : JX.trimA[i] || 0, sepA[i]), ELEN[i] * 0.4);
  const trimB = (i: number) => Math.min(Math.max(elevated[i] ? 0 : JX.trimB[i] || 0, sepB[i]), ELEN[i] * 0.4);
  const runLen = (i: number) => Math.max(0, ELEN[i] - trimA(i) - trimB(i));
  const runA = (i: number, s: number) => Math.max(0, Math.min(runLen(i), s - trimA(i)));
  const runB = (i: number, s: number) => runLen(i) - runA(i, s);
  // Every road climbs no steeper than MAX_GRADE between junctions held down
  // (jCap) and anything raised: so a junction's height is capped by every
  // held one within reach (a ceiling rising at MAX_GRADE away from it), and
  // a flyover's end that can't be reached in time comes down to meet its
  // ramp (its deck slopes instead). Ramps climb at RAMP_GRADE wherever they
  // can; only where a held road and a flyover are close do they climb more
  // steeply, up to this (a little under the car's limit).
  const MAX_GRADE = 0.9 * LIMITS.grade;
  const jCeil = new Float32Array(M.junctions.length);
  const ceilings = () => {
    jCeil.set(jCap);
    const queue: number[] = [];
    jCap.forEach((c, j) => c < Infinity && queue.push(j));
    while (queue.length) {
      const j = queue.pop()!;
      for (const i of jE[j] ?? []) {
        if (elevated[i]) continue;
        const o = edges[i].a === j ? edges[i].b : edges[i].a;
        const c = jCeil[j] + MAX_GRADE * runLen(i);
        if (c < jCeil[o] - 0.01) {
          jCeil[o] = c;
          queue.push(o);
        }
      }
    }
  };
  const lift = () => {
    jRel.fill(0);
    ceilings();
    const queue: number[] = [];
    const raise = (j: number, r: number) => {
      r = Math.min(deckEnd[j] ? jCeil[j] : jCap[j], jCeil[j], r);
      if (r > jRel[j] + 0.01) {
        jRel[j] = r;
        queue.push(j);
      }
    };
    edges.forEach((e, i) => {
      if (!elevated[i]) return;
      for (const j of [e.a, e.b]) {
        deckEnd[j] = 1;
        raise(j, DECK_H * deckLevel[i]);
      }
    });
    needs.forEach((list, i) => {
      for (const n of list) {
        raise(edges[i].a, n.rel - RAMP_GRADE * runA(i, n.s));
        raise(edges[i].b, n.rel - RAMP_GRADE * runB(i, n.s));
      }
    });
    while (queue.length) {
      const j = queue.pop()!;
      for (const i of jE[j] ?? []) {
        if (elevated[i]) continue;
        raise(edges[i].a === j ? edges[i].b : edges[i].a, jRel[j] - RAMP_GRADE * runLen(i));
      }
    }
  };
  lift();
  /** Road height above the ground at distance s along edge i. */
  // (A road held down to pass under a flyover keeps its own height.)
  const held = (i: number) => jCap[edges[i].a] < Infinity || jCap[edges[i].b] < Infinity;
  /**
   * Road height above the ground at distance s along edge i. Where two
   * roads leave a joint side by side, overlapping for L m, both take the
   * average of their own heights there (one surface: neither stands above
   * the other), easing back to their own beyond, over a stretch long enough
   * to keep within MAX_GRADE.
   */
  const relAlong = (i: number, s: number) => {
    const r = relOwn(i, s);
    if (!mates[i].length || held(i)) return r;
    let sum = 0;
    let w = 0;
    for (const m of mates[i]) {
      if (held(m.o)) continue;
      const d = m.ia ? s : ELEN[i] - s; // from the joint
      if (d > m.L + 60) continue;
      const so = m.oa ? d : ELEN[m.o] - d;
      if (so < 0 || so > ELEN[m.o]) continue;
      const di = m.ia ? m.L : ELEN[i] - m.L;
      const dO = m.oa ? m.L : ELEN[m.o] - m.L;
      const gap = Math.abs(relOwn(m.o, Math.max(0, Math.min(ELEN[m.o], dO))) - relOwn(i, Math.max(0, Math.min(ELEN[i], di)))) / 2;
      const fade = Math.min(60, Math.max(8, (1.5 * gap) / (0.5 * MAX_GRADE)));
      // (Both roads are back to their own height at their far ends, where
      // other roads meet them.)
      const farI = ELEN[i] - d;
      const farO = m.oa ? ELEN[m.o] - so : so;
      const t = (1 - smoothstep(m.L, m.L + fade, d)) * smoothstep(0, 12, Math.min(farI, farO));
      if (t <= 0) continue;
      sum += t * (relOwn(m.o, so) - r) / 2;
      w += t;
    }
    return w > 1 ? r + sum / w : r + sum;
  };
  /** Road height above the ground at distance s along edge i, on its own. */
  const relOwn = (i: number, s: number) => {
    const ra = jRel[edges[i].a] ?? 0;
    const rb = jRel[edges[i].b] ?? 0;
    let r: number;
    if (elevated[i]) {
      // A flyover stands at its full height, coming down only near an end
      // held lower (at 1 in 10).
      const t = runLen(i) > 0 ? runA(i, s) / runLen(i) : 0;
      r = Math.min(Math.max(DECK_H * deckLevel[i], lerp(ra, rb, t)), ra + 0.1 * runA(i, s), rb + 0.1 * runB(i, s));
    }
    else {
      const run = runLen(i);
      const g = Math.max(RAMP_GRADE, run > 0 ? Math.abs(ra - rb) / run : 0);
      r = Math.max(0, ra - g * runA(i, s), rb - g * runB(i, s));
    }
    // Each extra height falls away at RAMP_GRADE, or more steeply where it
    // has to come down to a lower end in time.
    const sa = runA(i, s);
    for (const n of needs[i]) {
      const na = runA(i, n.s);
      const toA = sa < na;
      const end = toA ? ra : rb;
      const run = toA ? na : runLen(i) - na;
      const g = Math.min(MAX_GRADE, Math.max(RAMP_GRADE, run > 0 ? (n.rel - end) / run : 0));
      // (No higher than the road can climb to from its ends: where a road
      // must clear another too close to a lower end, the car's climb wins
      // over a little headroom.)
      const top = Math.min(n.rel, ra + MAX_GRADE * na, rb + MAX_GRADE * (runLen(i) - na));
      r = Math.max(r, top - g * Math.abs(sa - na));
    }
    return r;
  };
  // The ground a raised road's height is measured from: the hills under it,
  // except that across a shaped junction (and fading out over the next
  // 12 m) it is the junction's own, so every raised road leaves a junction
  // at the junction's one height even on a slope. (Only at a raised
  // junction: where it sits on the ground, every road follows the ground.)
  const roadBase = (i: number, s: number, x: number, z: number) => {
    const b = baseAt(x, z);
    if (elevated[i]) return b;
    const e = edges[i];
    let r = b;
    const ta = trimA(i);
    const tb = trimB(i);
    // (Gone well before the far end, however short the road.)
    const F = Math.min(12, Math.max(0.5, runLen(i) / 2));
    if (ta > 0) {
      const [jx, jz] = M.junctions[e.a];
      r += (1 - smoothstep(ta, ta + F, s)) * smoothstep(0.02, 0.5, jRel[e.a]) * (baseAt(jx, jz) - b);
    }
    if (tb > 0) {
      const [jx, jz] = M.junctions[e.b];
      r += (1 - smoothstep(tb, tb + F, ELEN[i] - s)) * smoothstep(0.02, 0.5, jRel[e.b]) * (baseAt(jx, jz) - b);
    }
    return r;
  };
  // Headroom. Wherever a raised road runs over a lower one:
  // - a slip road (or a ramp) running alongside under its edge is raised to
  //   its level, so the two merge;
  // - any other road crossing under stays down (its junctions nearby are
  //   capped), and if it can't go low enough the road above is raised.
  const HEAD = 6.0; // 4.8 m clear under a 1.2 m deck
  {
    const raised = (i: number) => elevated[i] || jRel[edges[i].a] > 0.02 || jRel[edges[i].b] > 0.02 || needs[i].length > 0;
    const dirAt = (i: number, k: number, u = 0) => {
      const P = EP[i];
      const a = P[Math.max(0, k - 1)];
      const b = P[Math.min(P.length - 1, k + 1 + (u > 0 ? 1 : 0))];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    };
    type Hit = { i: number; k: number; o: number; so: number; dot: number; yi: number; yo: number; bo: number };
    const hitsNow = () => {
      const hits: Hit[] = [];
      edges.forEach((_, i) => {
        if (!raised(i)) return;
        const P = EP[i];
        for (let k = 0; k < P.length; k++) {
          const yi = roadBase(i, ECUM[i][k], P[k][0], P[k][1]) + relAlong(i, ECUM[i][k]);
          roads.each(P[k][0], P[k][1], EHALF[i] + 12, (o, seg, u, dd) => {
            if (o === i || elevated[o] || shares(i, o) || dd > EHALF[i] + EHALF[o] - 0.3) return;
            const c = ECUM[o];
            const Q = EP[o];
            const q = Q[Math.min(Q.length - 1, seg + 1)];
            const ox = lerp(Q[seg][0], q[0], u);
            const oz = lerp(Q[seg][1], q[1], u);
            const so = c[seg] + (c[Math.min(c.length - 1, seg + 1)] - c[seg]) * u;
            const bo = roadBase(o, so, ox, oz);
            const yo = bo + relAlong(o, so);
            if (yi - yo < 0.3) return;
            const d1 = dirAt(i, k);
            const d2 = dirAt(o, seg, u);
            hits.push({ i, k, o, so, dot: Math.abs(d1[0] * d2[0] + d1[1] * d2[1]), yi, yo, bo });
          });
        }
      });
      return hits;
    };
    const isLink = (o: number) => /_link$/.test(edges[o].cls);
    const capped = new Uint8Array(edges.length);
    const merges = (h: Hit) => h.dot > 0.8 && !capped[h.o] && (isLink(h.o) || raised(h.o));
    // Can road o rise to `rel` at s, no steeper than 1 in 10 from a capped end?
    const MAXG = 0.1;
    const canRise = (o: number, s: number, rel: number) =>
      rel - MAXG * runA(o, s) <= jCap[edges[o].a] && rel - MAXG * runB(o, s) <= jCap[edges[o].b];
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      const hits = hitsNow();
      const hold = (h: Hit) => {
        if (h.yi - h.yo >= HEAD) return;
        const e = edges[h.o];
        const want = h.yi - HEAD - h.bo; // the lower road's height to clear
        const rel = h.yo - h.bo;
        if (rel > 0.05 && want > -0.5 && !deckEnd[e.a] && !deckEnd[e.b]) {
          // Hold the road below down.
          capped[h.o] = 1;
          needs[h.o] = [];
          // (Held right down unless it was well up: small rises under a deck
          // only leave steps against the roads beside it.)
          const cap = want > 1 ? want : 0;
          jCap[e.a] = Math.min(jCap[e.a], cap + RAMP_GRADE * runA(h.o, h.so));
          jCap[e.b] = Math.min(jCap[e.b], cap + RAMP_GRADE * runB(h.o, h.so));
          if (want <= 0.05) needs[h.i].push({ s: ECUM[h.i][h.k], rel: h.bo + HEAD - roadBase(h.i, ECUM[h.i][h.k], EP[h.i][h.k][0], EP[h.i][h.k][1]) });
        } else {
          // Raise the road above.
          needs[h.i].push({ s: ECUM[h.i][h.k], rel: h.yo + HEAD - roadBase(h.i, ECUM[h.i][h.k], EP[h.i][h.k][0], EP[h.i][h.k][1]) });
        }
        changed = true;
      };
      // Roads crossing under first (they set the caps), then the merges that
      // the caps still allow; a slip road that can't climb in time stays down.
      for (const h of hits) if (!merges(h)) hold(h);
      for (const h of hits) {
        if (!merges(h)) continue;
        if (canRise(h.o, h.so, h.yi - h.bo)) {
          needs[h.o].push({ s: h.so, rel: h.yi - h.bo });
          changed = true;
        } else hold(h);
      }
      // (A merge accepted before a later cap may no longer be reachable.)
      needs.forEach((list, i) => {
        if (!elevated[i] && list.length) needs[i] = list.filter((n) => canRise(i, n.s, n.rel));
      });
      lift();
      if (!changed) break;
    }
  }
  // Roads (not decks) that climb to a flyover: the ground rises under them.
  const embank = edges.map((e, i) => !isDeck[i] && ((jRel[e.a] ?? 0) > 0.02 || (jRel[e.b] ?? 0) > 0.02 || needs[i].length > 0));
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
      d[k] = roadBase(i, cum[k], pts[k][0], pts[k][1]) + relAlong(i, cum[k]) + arch;
    }
    roadDeckCache.set(i, d);
    return d;
  };
  // A raised road is level across its width, but one that is still down at
  // the ground (a ramp's foot) lies on the hillside like the roads beside
  // it: tiltAt is how far (0 level, 1 fully on the ground plus its height).
  // (A low bridge meets its road on the bank the same way at its ends.)
  // A low bridge's end lies on the ground where it meets a road on the
  // ground (or ends); where it joins the next piece of bridge it stays up.
  const footAt = (i: number, j: number) => (jE[j] ?? []).every((o) => o === i) || (jE[j] ?? []).some((o) => o !== i && !isDeck[o]);
  const foot = edges.map((e, i) => [footAt(i, e.a), footAt(i, e.b)]);
  const tiltAt = (i: number, s: number) =>
    !hasProfile[i] || elevated[i]
      ? 0
      : isDeck[i]
        ? 1 - smoothstep(0, 3, Math.min(foot[i][0] ? s : Infinity, foot[i][1] ? ELEN[i] - s : Infinity))
        : 1 - smoothstep(0.1, 1, relAlong(i, s));
  const dropAt = (x: number, z: number) => Math.max(rawHeight(x, z), WL + 0.15);
  /** Deck height at a SegIndex hit on edge i. */
  const deckAtHit = (i: number, seg: number, u: number) => {
    const d = deckY(i);
    return lerp(d[seg], d[Math.min(d.length - 1, seg + 1)], u);
  };

  // Kerbs stop where another road runs across them (a lane or drive joining
  // just beside the junction).
  const drawnAt = (line: number, seg: number, u: number) => {
    if (JX.internal[line] || isDeck[line]) return false;
    const c = ECUM[line];
    const at = c[seg] + (c[seg + 1] - c[seg]) * u;
    return at >= JX.trimA[line] && at <= ELEN[line] - JX.trimB[line];
  };
  for (const sh of JX.shapes) {
    const kept: XZ[][] = [];
    for (const F of sh.kerbs) {
      let run: XZ[] = [];
      F.forEach((p, q) => {
        const a = F[Math.max(0, q - 1)];
        const b = F[Math.min(F.length - 1, q + 1)];
        const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const x = p[0] + ((b[1] - a[1]) / tl) * 0.05;
        const z = p[1] - ((b[0] - a[0]) / tl) * 0.05;
        let hit = false;
        roads.each(x, z, 16, (line, seg, u, d) => {
          if (!hit && d < EHALF[line] - 0.3 && drawnAt(line, seg, u)) hit = true;
        });
        if (!hit) run.push(p);
        else {
          if (run.length > 1) kept.push(run);
          run = [];
        }
      });
      if (run.length > 1) kept.push(run);
    }
    sh.kerbs = kept;
  }
  // ---------- Crossings and traffic lights ----------
  // At a major junction (three or more roads, two of them secondary or
  // bigger, no expressway) each road gets a zebra crossing just outside its
  // mouth, a stop line for the traffic coming in, and a traffic light on the
  // left kerb (Singapore drives on the left). The lights take turns by
  // direction: roads lined up with the first one, then the rest.
  const CROSS_FROM = 1; // metres out from the mouth
  const CROSS_W = 3;
  const STOP_AT = CROSS_FROM + CROSS_W + 1;
  type Crossing = { line: number; end: 0 | 1; s: number; half: number; c: XZ; t: XZ; inbound: number; group: number; light: XZ | null };
  const crossings: Crossing[] = [];
  const crossCand: { cr: Crossing; lightOpts: XZ[] }[] = [];
  const crossEnd = new Map<string, Crossing>();
  for (const sh of JX.shapes) {
    const ms = sh.mouths.filter((m) => !hasProfile[m.line] && rankOf(edges[m.line].cls) >= 1 && m.half >= 2.5 && ELEN[m.line] > m.s + STOP_AT + 4);
    if (sh.mouths.length < 3 || ms.length < 3) continue;
    if (sh.mouths.some((m) => edges[m.line].cls === 'motorway')) continue;
    if (new Set(sh.mouths.filter((m) => rankOf(edges[m.line].cls) >= 3).map((m) => edges[m.line].name ?? m.line)).size < 2 && sh.mouths.filter((m) => rankOf(edges[m.line].cls) >= 3).length < 3) continue;
    const axis = Math.atan2(ms[0].t[1], ms[0].t[0]);
    for (const m of ms) {
      const e = edges[m.line];
      const P = EP[m.line];
      const cum = ECUM[m.line];
      const L = ELEN[m.line];
      const at = (d: number) => {
        const sAt = m.end === 0 ? d : L - d;
        let k = 0;
        while (k < P.length - 2 && cum[k + 1] <= sAt) k++;
        const u = (sAt - cum[k]) / (cum[k + 1] - cum[k] || 1);
        return [lerp(P[k][0], P[k + 1][0], u), lerp(P[k][1], P[k + 1][1], u)] as XZ;
      };
      const c = at(m.s + CROSS_FROM + CROSS_W / 2);
      // Coming in: one-way roads only where they flow toward the junction.
      const inbound = e.one ? (m.end === 1 ? 2 : 0) : 1; // 2 = whole width, 1 = left half, 0 = none
      const left: XZ = [-m.t[1], m.t[0]]; // left of a car heading in (along -t)
      // Where the pole may go: by the stop line, or a little further out.
      const lightOpts: XZ[] = [];
      if (inbound)
        for (const back of [0, 1.5, 3, 5])
          for (const side of [0.9, 1.6]) {
            const q = at(m.s + STOP_AT + back);
            lightOpts.push([q[0] + left[0] * (m.half + side), q[1] + left[1] * (m.half + side)]);
          }
      let da = Math.abs(Math.atan2(m.t[1], m.t[0]) - axis) % Math.PI;
      if (da > Math.PI / 2) da = Math.PI - da;
      crossCand.push({ cr: { line: m.line, end: m.end, s: m.s, half: m.half, c, t: m.t, inbound, group: da < Math.PI / 4 ? 0 : 1, light: null }, lightOpts });
    }
  }

  // Everything paved at junctions: the shapes, and islands filled in.
  const JPOLY = [...JX.shapes.map((sh) => ({ ...sh, fill: false })), ...JX.fills.map((f) => ({ ...f, mouths: [] as typeof JX.shapes[number]['mouths'], kerbs: [] as XZ[][], fill: true }))];
  const JCELL = 64;
  const jGrid = new Map<number, number[]>();
  JPOLY.forEach((sh, id) => {
    const r = sh.radius + 10;
    for (let ci = Math.floor((sh.centre[0] - r) / JCELL); ci <= Math.floor((sh.centre[0] + r) / JCELL); ci++)
      for (let cj = Math.floor((sh.centre[1] - r) / JCELL); cj <= Math.floor((sh.centre[1] + r) / JCELL); cj++) {
        const k = ci * 100003 + cj;
        const l = jGrid.get(k);
        if (l) l.push(id);
        else jGrid.set(k, [id]);
      }
  });
  // A paved island sits level with the roads round it (not down in the dip
  // between two embankments): each outline point at its nearest road's
  // height, blended across (nearest counts most), never below the ground.
  const fillRing = new Map<number, number[]>();
  const fillTop = (id: number, x: number, z: number) => {
    const sh = JPOLY[id];
    let ry = fillRing.get(id);
    if (!ry) {
      ry = sh.ring.map(([px, pz]) => {
        const r = roads.nearest(px, pz, 30, (i) => !elevated[i]);
        return r && hasProfile[r.line] ? deckAtHit(r.line, r.seg, r.u) : Math.max(rawHeight(px, pz), WL + 0.15);
      });
      fillRing.set(id, ry);
    }
    let sw = 0;
    let sy = 0;
    for (let q = 0; q < ry.length; q++) {
      const dd = Math.hypot(x - sh.ring[q][0], z - sh.ring[q][1]);
      if (dd < 1e-3) return ry[q];
      const w = 1 / (dd * dd);
      sw += w;
      sy += w * ry[q];
    }
    return Math.max(sy / sw, rawHeight(x, z), WL + 0.15);
  };
  // A shaped junction with a raised road among its mouths: its surface
  // blends between the mouths' heights (nearest mouth counts most), so it
  // meets every road at that road's own level.
  const segD = (x: number, z: number, a: XZ, b: XZ) => {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
    return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t);
  };
  const mouthRels = new Map<number, { y: number; t: number; r: number }[] | null>();
  const relsOf = (id: number) => {
    let r = mouthRels.get(id);
    if (r === undefined) {
      const sh = JPOLY[id];
      r = sh.mouths.some((m) => hasProfile[m.line])
        ? sh.mouths.map((m) => {
            if (!hasProfile[m.line]) return { y: NaN, t: 1, r: 0 };
            const c = cutOf(m.line);
            const sc = m.end === 0 ? JX.trimA[m.line] || 0 : ELEN[m.line] - (JX.trimB[m.line] || 0);
            return { y: m.end === 0 ? c.ylo : c.yhi, t: tiltAt(m.line, sc), r: relAlong(m.line, sc) };
          })
        : null;
      mouthRels.set(id, r);
    }
    return r;
  };
  /** The top of junction id's paving at (x, z) (before its small lift). */
  const jTop = (id: number, x: number, z: number) => {
    const sh = JPOLY[id];
    if (sh.fill) return fillTop(id, x, z);
    const rels = relsOf(id);
    const g = Math.max(rawHeight(x, z), WL + 0.15);
    if (!rels) return g;
    let sw = 0;
    let sr = 0;
    for (let q = 0; q < rels.length; q++) {
      const m = sh.mouths[q];
      const dd = segD(x, z, m.left, m.right);
      // (A raised road is level across its mouth; a road on the ground
      // follows the ground.)
      const { y, t, r } = rels[q];
      const h = y === y ? lerp(y, g + r, t) : g;
      if (dd < 1e-3) return h;
      const w = 1 / (dd * dd);
      sw += w;
      sr += w * h;
    }
    return sr / sw;
  };
  /** On a paved island? */
  const onIsland = (x: number, z: number) =>
    !!jGrid.get(Math.floor(x / JCELL) * 100003 + Math.floor(z / JCELL))?.some((id) => JPOLY[id].fill && inRingXZ(JPOLY[id].ring, x, z));
  /** Distance from (x, z) to a junction's outline (0 inside) and the nearest outline point. */
  const ringDist = (ring: XZ[], x: number, z: number): [number, number, number] => {
    let best = Infinity;
    let bx = x;
    let bz = z;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, az] = ring[j];
      const abx = ring[i][0] - ax;
      const abz = ring[i][1] - az;
      let u = ((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz || 1);
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const d = Math.hypot(ax + abx * u - x, az + abz * u - z);
      if (d < best) {
        best = d;
        bx = ax + abx * u;
        bz = az + abz * u;
      }
    }
    return inRingXZ(ring, x, z) ? [0, x, z] : [best, bx, bz];
  };

  /**
   * Well inside a junction's paving (or a paved island), at its level? A
   * road's kerbs and markings stop there: the paving is open asphalt. (y NaN:
   * a road on the ground.)
   */
  const inPaving = (x: number, z: number, y: number, not = -1) =>
    !!jGrid.get(Math.floor(x / JCELL) * 100003 + Math.floor(z / JCELL))?.some((id) => {
      if (id === not) return false;
      const ring = JPOLY[id].ring;
      if (!inRingXZ(ring, x, z)) return false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [ax, az] = ring[j];
        const abx = ring[i][0] - ax;
        const abz = ring[i][1] - az;
        const u = Math.max(0, Math.min(1, ((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz || 1)));
        if (Math.hypot(ax + abx * u - x, az + abz * u - z) < 0.6) return false;
      }
      const g = y === y ? y : Math.max(rawHeight(x, z), WL + 0.15);
      return Math.abs(g - jTop(id, x, z)) < 1;
    });

  // A crossing is painted only where it lies on its own road alone (not
  // across another road, nor in a junction); a pole only where it stands
  // clear of every road and junction.
  {
    const inPoly = (x: number, z: number, fills: boolean) =>
      !!jGrid.get(Math.floor(x / JCELL) * 100003 + Math.floor(z / JCELL))?.some((id) => (fills || !JPOLY[id].fill) && ringDist(JPOLY[id].ring, x, z)[0] === 0);
    const onOther = (x: number, z: number, own: number, pad: number) => {
      let hit = false;
      roads.each(x, z, 16, (i, seg, u, d) => {
        if (!hit && i !== own && !elevated[i] && drawnAt(i, seg, u) && d < EHALF[i] + pad) hit = true;
      });
      return hit;
    };
    for (const { cr, lightOpts } of crossCand) {
      const left: XZ = [-cr.t[1], cr.t[0]];
      let ok = true;
      for (const a of [-1, 0, 1])
        for (const b of [-1, -0.5, 0, 0.5, 1]) {
          const x = cr.c[0] + cr.t[0] * a * (CROSS_W / 2) + left[0] * b * (cr.half - 0.4);
          const z = cr.c[1] + cr.t[1] * a * (CROSS_W / 2) + left[1] * b * (cr.half - 0.4);
          if (onOther(x, z, cr.line, -0.3) || inPoly(x, z, false)) ok = false;
        }
      if (!ok) continue;
      cr.light = lightOpts.find(([x, z]) => !onOther(x, z, -1, 0.3) && !inPoly(x, z, true)) ?? null;
      crossings.push(cr);
      crossEnd.set(`${cr.line}:${cr.end}`, cr);
    }
  }

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
        const sa = ECUM[line][seg] + u * sl;
        const rel = relAlong(line, sa);
        // The road is level across its width: its height is the centre line's.
        const top = roadBase(line, sa, lerp(pts[seg][0], pts[seg + 1][0], u), lerp(pts[seg][1], pts[seg + 1][1], u)) + rel;
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
        const sa = ECUM[line][seg] + u * sl;
        const yr = hasProfile[line] ? roadBase(line, sa, lerp(pts[seg][0], pts[seg + 1][0], u), lerp(pts[seg][1], pts[seg + 1][1], u)) + relAlong(line, sa) : hb;
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
      if (hasProfile[line]) {
        yr = deckAtHit(line, seg, u);
        const tl = tiltAt(line, lerp(ECUM[line][seg], ECUM[line][seg + 1], u));
        if (tl > 0) {
          const t = d > half ? half / d : 1;
          const sa = lerp(ECUM[line][seg], ECUM[line][seg + 1], u);
          yr = lerp(yr, dropAt(cx + (x - cx) * t, cz + (z - cz) * t) + relAlong(line, sa), tl);
        }
      } else {
        // A draped road's surface at its edge nearest this point.
        const t = d > half ? half / d : 1;
        yr = Math.max(rawHeight(cx + (x - cx) * t, cz + (z - cz) * t), WL + 0.15);
      }
      const cap = yr - 0.12 + Math.max(0, d - half - SEAL);
      if (cap < h) h = cap;
    });
    // And under junctions, which reach past their roads at the corners.
    const near = jGrid.get(Math.floor(x / JCELL) * 100003 + Math.floor(z / JCELL));
    if (near)
      for (const id of near) {
        const sh = JPOLY[id];
        if (Math.hypot(x - sh.centre[0], z - sh.centre[1]) > sh.radius + SEAL + 2) continue;
        const [d, px, pz] = ringDist(sh.ring, x, z);
        if (d > SEAL + 2) continue;
        // (Deeper under a big island: its wide triangles cut corners off the ground.)
        const cap = (sh.fill ? fillTop(id, px, pz) : Math.max(rawHeight(px, pz), WL + 0.15)) - (d === 0 && sh.fill ? 0.5 : 0.12) + Math.max(0, d - SEAL);
        if (cap < h) h = cap;
      }
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
    if (inJunction(x, z, 0.3)) return SURFACES.asphalt;
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
    o: {
      off?: number | ((k: number) => number);
      y?: number;
      yAt?: (k: number) => number;
      keep?: (k: number) => boolean;
      /** With yAt: how far each cross-section lies on the ground instead (0..1), and its height above it. */
      tilt?: (k: number) => [number, number];
      /** Each corner of a piece must pass this too (x, surface y, z). */
      clearAt?: (x: number, y: number, z: number) => boolean;
      /** The drawn part of pts (a cut road): its ends look only inward for their direction. */
      lo?: number;
      hi?: number;
      /** A joint's direction (along pts) where two roads meet at a bend, and the mitre stretch. */
      join?: (k: number) => { d: XZ; m: number } | null;
    } = {},
  ) => {
    const base = acc.pos.length / 3;
    const lo = o.lo ?? 0;
    const hi = o.hi ?? pts.length - 1;
    for (let k = k0; k <= k1; k++) {
      const jn = o.join?.(k) ?? null;
      // At a bend the sides stand out along the mitre, so the road keeps its
      // full width round the outside of a sharp corner (more than 20°; a
      // gentle curve loses next to nothing).
      let mm = 1;
      if (jn) mm = jn.m;
      else if (k > lo && k < hi) {
        const p = pts[k - 1], q = pts[k], r = pts[k + 1];
        const l1 = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const l2 = Math.hypot(r[0] - q[0], r[1] - q[1]);
        // (A cut road repeats its mouth point: no bend there.)
        const c = l1 < 1e-3 || l2 < 1e-3 ? 1 : ((q[0] - p[0]) * (r[0] - q[0]) + (q[1] - p[1]) * (r[1] - q[1])) / (l1 * l2);
        // cos of half the turn; capped at twice the width (a turn of 120°).
        const ch = Math.sqrt(Math.max(0, (1 + c) / 2));
        if (ch < Math.cos((10 * Math.PI) / 180)) mm = 1 / Math.max(0.5, ch);
      }
      const half = (typeof halfIn === 'number' ? halfIn : halfIn(k)) * mm;
      const off = (o.off === undefined ? 0 : typeof o.off === 'number' ? o.off : o.off(k)) * mm;
      const a = pts[Math.max(lo, k - 1)];
      const b = pts[Math.min(hi, k + 1)];
      const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      let nx = (b[1] - a[1]) / tl;
      let nz = -(b[0] - a[0]) / tl;
      if (jn) {
        nx = jn.d[1];
        nz = -jn.d[0];
      }
      const [px, pz] = pts[k];
      for (const sgn of [-1, 1]) {
        const x = px + nx * (off + sgn * half);
        const z = pz + nz * (off + sgn * half);
        // Never below the water: paths out over it become boardwalks.
        let yk = o.yAt ? o.yAt(k) : NaN;
        if (yk === yk && o.tilt) {
          const [tk, rk] = o.tilt(k);
          if (tk > 0) yk = lerp(yk, Math.max(rawHeight(x, z), WL + 0.15) + rk, tk);
        }
        acc.pos.push(x, (yk === yk ? yk : (o.y ?? Math.max(rawHeight(x, z), WL + 0.15))) + lift, z);
        acc.uv.push(((sgn + 1) / 2) * ((half * 2) / 6), cum[k] / 6);
      }
    }
    const P = acc.pos;
    const clearAt = o.clearAt;
    const corner = (v: number) => clearAt!(P[v * 3], P[v * 3 + 1] - lift, P[v * 3 + 2]);
    for (let k = k0; k < k1; k++) {
      if (o.keep && !o.keep(k)) continue;
      const a = base + (k - k0) * 2;
      if (clearAt && !(corner(a) && corner(a + 1) && corner(a + 2) && corner(a + 3))) continue;
      acc.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  };
  const disc = (acc: Acc, x: number, z: number, r: number, lift: number, y?: number) => {
    const base = acc.pos.length / 3;
    const yc = (y ?? Math.max(rawHeight(x, z), WL + 0.15)) + lift;
    acc.pos.push(x, yc, z);
    acc.uv.push(0, 0);
    // (Two rings, so a pad draped on a slope follows it closely.)
    const n = 16;
    for (const f of [0.5, 1])
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const px = x + Math.cos(a) * r * f;
        const pz = z + Math.sin(a) * r * f;
        acc.pos.push(px, (y ?? Math.max(rawHeight(px, pz), WL + 0.15)) + lift, pz);
        acc.uv.push(Math.cos(a) * ((r * f) / 6), Math.sin(a) * ((r * f) / 6));
      }
    // Counter-clockwise seen from above, so the pad faces up.
    for (let i = 0; i < n; i++) {
      const i1 = (i + 1) % n;
      acc.idx.push(base, base + 1 + i1, base + 1 + i);
      acc.idx.push(base + 1 + i, base + 1 + i1, base + 1 + n + i1, base + 1 + i, base + 1 + n + i1, base + 1 + n + i);
    }
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
  // A road cut back at shaped junctions: the same points, with the first and
  // last drawn ones moved to the mouths (indices stay put).
  const cutOf = (line: number) => {
    const pts = EP[line];
    const cum = ECUM[line];
    const n = pts.length;
    const ta = JX.trimA[line];
    const tb = JX.trimB[line];
    if (!ta && !tb) return { pts, lo: 0, hi: n - 1, ylo: NaN, yhi: NaN };
    const P = pts.slice();
    const at = (s: number) => {
      let k = 0;
      while (k < n - 2 && cum[k + 1] <= s) k++;
      const u = (s - cum[k]) / (cum[k + 1] - cum[k] || 1);
      // A raised road's level at the cut.
      const y = hasProfile[line] ? lerp(deckY(line)[k], deckY(line)[k + 1], u) : NaN;
      return { k, y, p: [lerp(pts[k][0], pts[k + 1][0], u), lerp(pts[k][1], pts[k + 1][1], u)] as XZ };
    };
    let lo = 0;
    let hi = n - 1;
    let ylo = NaN;
    let yhi = NaN;
    if (ta) {
      const c = at(ta);
      lo = c.k;
      P[lo] = c.p;
      ylo = c.y;
    }
    if (tb) {
      const c = at(ELEN[line] - tb);
      hi = c.k + 1;
      P[hi] = c.p;
      yhi = c.y;
    }
    return { pts: P, lo, hi, ylo, yhi };
  };
  // Where two roads meet end to end at a bend, both ends share one mitred
  // edge across the bend instead of overlapping (or leaving a wedge).
  const unit = (x: number, z: number): XZ => {
    const l = Math.hypot(x, z) || 1;
    return [x / l, z / l];
  };
  const awayDir = (i: number, j: number): XZ => {
    const P = EP[i];
    const n = P.length;
    return edges[i].a === j ? unit(P[1][0] - P[0][0], P[1][1] - P[0][1]) : unit(P[n - 2][0] - P[n - 1][0], P[n - 2][1] - P[n - 1][1]);
  };
  const mitreAt = (i: number, j: number) => {
    if (jDegree[j] !== 2) return null;
    const o = jEdges[j][0] === i ? jEdges[j][1] : jEdges[j][0];
    if (o === undefined || o === i) return null;
    const ti = awayDir(i, j);
    const to = awayDir(o, j);
    const d = unit(ti[0] - to[0], ti[1] - to[1]);
    const c = d[0] * ti[0] + d[1] * ti[1];
    return c > 0.5 ? { d, m: 1 / c } : null;
  };
  const mitred = jEdges.map((l, j) => l.length === 2 && !!mitreAt(l[0], j));
  const joinOf = (line: number) => {
    const e = edges[line];
    const n = EP[line].length;
    const A = JX.trimA[line] ? null : mitreAt(line, e.a);
    const Bm = JX.trimB[line] ? null : mitreAt(line, e.b);
    const B = Bm ? { d: [-Bm.d[0], -Bm.d[1]] as XZ, m: Bm.m } : null;
    return (k: number) => (k === 0 ? A : k === n - 1 ? B : null);
  };
  // Stubs inside a merged junction are covered by it.
  const internalHidden = edges.map((_, i) => {
    if (!JX.internal[i]) return false;
    const sh = JX.shapes[JX.shapeOf[edges[i].a]];
    if (!sh) return false;
    const pts = EP[i];
    return pts.every((p, k) => {
      const a = pts[Math.max(0, k - 1)];
      const b = pts[Math.min(pts.length - 1, k + 1)];
      const [nx, nz] = unit(b[1] - a[1], -(b[0] - a[0]));
      const h = halfAtE(i, k) - 0.3;
      return inRingXZ(sh.ring, p[0] + nx * h, p[1] + nz * h) && inRingXZ(sh.ring, p[0] - nx * h, p[1] - nz * h);
    });
  });

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
      if (hit || i === line || d > Math.max(halfAtE(i, seg), halfAtE(i, seg + 1)) + 0.2) return;
      if (y !== y) hit = !elevated[i];
      else hit = Math.abs((hasProfile[i] ? deckAtHit(i, seg, u) : heightAt(x, z)) - y) < 3;
    });
    return hit;
  };
  // Gores. Where two roads at one level split apart or come together at a
  // small angle (a slip road leaving an expressway, a road dividing round
  // a median), the road is one surface between them until they are GORE m
  // apart: the wedge between their inner edges is paved (no strip of grass
  // or hole showing through), and their kerbs stop there. Beyond, the
  // verge between them begins.
  const GORE = 1.5;
  const gores: { ring: XZ[]; rows: { a: XZ; b: XZ; ya: number; yb: number }[] }[] = [];
  {
    /** Road i's drawn height at distance s along it, at (x, z). */
    const roadY = (i: number, k: number, u: number, s: number, x: number, z: number) => {
      if (!hasProfile[i]) return dropAt(x, z);
      const Y = deckY(i);
      let y = lerp(Y[k], Y[Math.min(Y.length - 1, k + 1)], u);
      if (!elevated[i]) {
        const t = tiltAt(i, s);
        if (t > 0) y = lerp(y, dropAt(x, z) + relAlong(i, s), t);
      }
      return y;
    };
    /** Point, direction (away from j) and segment at s out from road i's end at j. */
    const out = (i: number, j: number, s0: number) => {
      const P = EP[i];
      const cum = ECUM[i];
      const L = ELEN[i];
      const fromA = edges[i].a === j;
      const s = Math.max(0, Math.min(L, fromA ? s0 : L - s0));
      let k = 0;
      while (k < P.length - 2 && cum[k + 1] <= s) k++;
      const sl = cum[k + 1] - cum[k] || 1;
      const u = (s - cum[k]) / sl;
      const sg = fromA ? 1 : -1;
      return { x: lerp(P[k][0], P[k + 1][0], u), z: lerp(P[k][1], P[k + 1][1], u), tx: (sg * (P[k + 1][0] - P[k][0])) / sl, tz: (sg * (P[k + 1][1] - P[k][1])) / sl, k, u, s, h: halfAtE(i, u < 0.5 ? k : k + 1) };
    };
    const trimAt = (i: number, j: number) => (edges[i].a === j ? JX.trimA[i] || 0 : JX.trimB[i] || 0);
    const COS = Math.cos((35 * Math.PI) / 180);
    jE.forEach((all, j) => {
      const l = all.filter((i) => !JX.internal[i] && edges[i].a !== edges[i].b && ELEN[i] >= 20);
      if ((jE[j] ?? []).length < 3) return;
      for (let p = 0; p < l.length; p++)
        for (let q = p + 1; q < l.length; q++) {
          const A = l[p], B = l[q];
          if (elevated[A] !== elevated[B]) continue;
          const a0 = out(A, j, 0), a1 = out(A, j, 20), b1 = out(B, j, 20);
          const va = [a1.x - a0.x, a1.z - a0.z], vb = [b1.x - a0.x, b1.z - a0.z];
          if ((va[0] * vb[0] + va[1] * vb[1]) / (Math.hypot(va[0], va[1]) * Math.hypot(vb[0], vb[1]) || 1) < COS) continue;
          // (Pieces: two roads may draw apart and close in again.)
          let rows: { a: XZ; b: XZ; ya: number; yb: number }[] = [];
          const finish = () => {
            if (rows.length >= 2) gores.push({ ring: [...rows.map((r) => r.a), ...rows.map((r) => r.b).reverse()], rows });
            rows = [];
          };
          // (Up to the far junctions, whose paving takes over.)
          const farOf = (i: number) => ELEN[i] - (edges[i].a === j ? JX.trimB[i] || 0 : JX.trimA[i] || 0);
          const far = Math.min(farOf(A), farOf(B));
          const s0 = Math.max(trimAt(A, j), trimAt(B, j));
          for (let n = 0, N = Math.ceil(far - s0); n <= N; n++) {
            const s = Math.min(far, s0 + n);
            const pa = out(A, j, s), pb = out(B, j, s);
            const side = (pt: typeof pa, o: typeof pa) => Math.sign(-pt.tz * (o.x - pt.x) + pt.tx * (o.z - pt.z)) || 1;
            const sa = side(pa, pb), sb = side(pb, pa);
            // Each road's edge on the side facing the other (its kerb line).
            const ea: XZ = [pa.x - pa.tz * sa * pa.h, pa.z + pa.tx * sa * pa.h];
            const eb: XZ = [pb.x - pb.tz * sb * pb.h, pb.z + pb.tx * sb * pb.h];
            const sep = Math.hypot(pa.x - pb.x, pa.z - pb.z) - pa.h - pb.h;
            const ya = roadY(A, pa.k, pa.u, pa.s, ea[0], ea[1]);
            const yb = roadY(B, pb.k, pb.u, pb.s, eb[0], eb[1]);
            // (Two roads at different levels part as one climbs: no gore.)
            if (Math.abs(ya - yb) > 0.8) {
              finish();
              continue;
            }
            if (sep < 0.05 && !rows.length) continue;
            if (sep >= GORE + 1 && !rows.length) continue;
            rows.push({ a: ea, b: eb, ya, yb });
            if (sep >= GORE) finish();
          }
          finish();
        }
    });
  }
  const GCELL = 64;
  const goreGrid = new Map<number, number[]>();
  gores.forEach((g, id) => {
    const xs = g.ring.map((p) => p[0]), zs = g.ring.map((p) => p[1]);
    for (let a = Math.floor(Math.min(...xs) / GCELL); a <= Math.floor(Math.max(...xs) / GCELL); a++)
      for (let b = Math.floor(Math.min(...zs) / GCELL); b <= Math.floor(Math.max(...zs) / GCELL); b++) {
        const key = a * 100003 + b;
        (goreGrid.get(key) ?? goreGrid.set(key, []).get(key)!).push(id);
      }
  });
  /** In a gore (the paved wedge where two roads split or join)? */
  const inGore = (x: number, z: number) => !!goreGrid.get(Math.floor(x / GCELL) * 100003 + Math.floor(z / GCELL))?.some((id) => inRingXZ(gores[id].ring, x, z));
  {
    const byTile = new Map<string, number[]>();
    gores.forEach((g, id) => {
      const m = g.rows[Math.floor(g.rows.length / 2)].a;
      const k = tileKey(m[0], m[1]);
      (byTile.get(k) ?? byTile.set(k, []).get(k)!).push(id);
    });
    for (const [k, all] of byTile)
      inChunks('far', k, all, 30, (list, _kit, acc) => {
        const road = acc('road');
        for (const id of list) {
          const { rows } = gores[id];
          const base = road.pos.length / 3;
          // (A hair under the roads either side, which cover its edges.)
          for (const r of rows) {
            road.pos.push(r.a[0], r.ya + 0.087, r.a[1], r.b[0], r.yb + 0.087, r.b[1]);
            road.uv.push(r.a[0] / 6, r.a[1] / 6, r.b[0] / 6, r.b[1] / 6);
          }
          // Facing up: which side is which depends on the pair.
          const r0 = rows[0], r1 = rows[rows.length - 1];
          const up = (r0.b[0] - r0.a[0]) * (r1.a[1] - r0.a[1]) - (r0.b[1] - r0.a[1]) * (r1.a[0] - r0.a[0]) > 0;
          for (let q = 0; q + 1 < rows.length; q++) {
            const a = base + q * 2;
            if (up) road.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
            else road.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
          }
        }
      });
  }
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
        const rank = rankOf(e.cls);
        const len = cum[cum.length - 1];
        const halfAt = (kk: number) => halfAtE(line, kk);
        if (JX.internal[line] && internalHidden[line]) continue;
        // A road cut back at a shaped junction draws from its mouth outward.
        const cut = cutOf(line);
        const dy0 = hasProfile[line] ? deckY(line) : null;
        const dy = dy0 && (cut.ylo === cut.ylo || cut.yhi === cut.yhi) ? Float32Array.from(dy0) : dy0;
        if (dy && dy !== dy0) {
          if (cut.ylo === cut.ylo) dy[cut.lo] = cut.ylo;
          if (cut.yhi === cut.yhi) dy[cut.hi] = cut.yhi;
        }
        const yAt = dy ? (kk: number) => dy[kk] : undefined;
        const lo = Math.max(k0, cut.lo);
        const hi = Math.min(k1, cut.hi);
        if (hi <= lo) continue;
        const P = cut.pts;
        const tilt = dy && !elevated[line] ? (kk: number): [number, number] => [tiltAt(line, cum[kk]), relAlong(line, cum[kk])] : undefined;
        const opt = { yAt, tilt, lo: cut.lo, hi: cut.hi, join: joinOf(line) };
        strip(road, P, cum, lo, hi, halfAt, 0.09, opt);
        if ((rank >= 1 || dy) && !JX.internal[line])
          for (const sgn of [-1, 1]) {
            // Each side's kerb, except where it runs inside a paved island or
            // a junction (a road overlapping a junction past its mouth).
            const off = (kk: number) => sgn * (halfAt(kk) + 0.1);
            const keep = (kk: number) => {
              const a = P[kk];
              const b = P[kk + 1];
              const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
              const o = sgn * (halfAt(kk) + 0.2);
              const at = (t: number) => {
                const x = lerp(a[0], b[0], t) + ((b[1] - a[1]) / tl) * o;
                const z = lerp(a[1], b[1], t) - ((b[0] - a[0]) / tl) * o;
                const y = dy ? lerp(dy[kk], dy[kk + 1], t) : NaN;
                // (On another road's surface, where two roads merge or run
                // side by side, a kerb would stand across its lanes.)
                return onIsland(x, z) || inPaving(x, z, y) || coveredBy(line, x, z, y) || inGore(x, z);
              };
              return !at(0.5) && !at(0.2) && !at(0.8);
            };
            const clearAt = (x: number, y: number, z: number) => !inPaving(x, z, dy ? y : NaN) && !coveredBy(line, x, z, dy ? y : NaN);
            strip(kerb, P, cum, lo, hi, 0.25, 0.07, { ...opt, off, keep, clearAt });
          }
        // Where two roads at one level meet or overlap, a road's own surface is
        // covered by the other: markings and parapets stop there.
        const clear = (kk: number, off: number) => {
          const a = pts[kk];
          const b = pts[kk + 1];
          const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          const x = (a[0] + b[0]) / 2 + ((b[1] - a[1]) / tl) * off;
          const z = (a[1] + b[1]) / 2 - ((b[0] - a[0]) / tl) * off;
          const y = dy ? lerp(dy[kk], dy[kk + 1], 0.5) : NaN;
          return !coveredBy(line, x, z, y) && !onIsland(x, z) && !inPaving(x, z, y);
        };
        if (dy && !isDeck[line]) {
          // A raised road: where the ground beside it falls away (its bank
          // was cut short by a road below), a retaining wall, and a parapet
          // where the drop is more than a kerb.
          const deck = acc('deck');
          for (const sgn of [-1, 1]) {
            const off = (kk: number) => sgn * (halfAt(kk) + 0.45);
            const dr = new Float32Array(hi - lo + 1);
            for (let kk = lo; kk <= hi; kk++) {
              const a = P[Math.max(lo, kk - 1)];
              const b = P[Math.min(hi, kk + 1)];
              const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
              const o = off(kk) + sgn * 0.6;
              dr[kk - lo] = dy[kk] + 0.09 - heightAt(P[kk][0] + ((b[1] - a[1]) / tl) * o, P[kk][1] - ((b[0] - a[0]) / tl) * o);
            }
            const y = (kk: number) => dy[kk] + 0.09;
            band(deck, P, cum, lo, hi, off, y, (kk) => Math.max(0, dr[kk - lo]) + 0.3, 0.05, (kk) => Math.max(dr[kk - lo], dr[kk + 1 - lo]) > 0.15);
            band(deck, P, cum, lo, hi, off, y, 0, 0.95, (kk) => Math.min(dr[kk - lo], dr[kk + 1 - lo]) > 1.2 && clear(kk, off(kk)));
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
        if (rank < 1 || len < 12 || JX.internal[line]) continue;
        // Markings stop at a junction's edge, and run on through a bend.
        const stopAt = (j: number, trim: number) => (trim > 0 ? trim + 1 : jDegree[j] === 2 ? 0.3 : jDegree[j] > 2 ? jRadius[j] + 2 : 2);
        const ca = crossEnd.has(`${line}:0`) ? JX.trimA[line] + STOP_AT + 0.5 : stopAt(e.a, JX.trimA[line]);
        const cb = crossEnd.has(`${line}:1`) ? JX.trimB[line] + STOP_AT + 0.5 : stopAt(e.b, JX.trimB[line]);
        const ends = (kk: number) => cum[kk] > ca && cum[kk + 1] < len - cb;
        const lineClear = (x: number, y: number, z: number) => !inPaving(x, z, dy ? y : NaN) && !coveredBy(line, x, z, dy ? y : NaN);
        const solid = (off: (kk: number) => number) => (kk: number) => ends(kk) && clear(kk, off(kk));
        const dashed = (off: (kk: number) => number) => (kk: number) => kk % 3 === 0 && ends(kk) && clear(kk, off(kk));
        if (rank >= 2) {
          const l = (kk: number) => halfAt(kk) - 0.35;
          const r = (kk: number) => -(halfAt(kk) - 0.35);
          strip(yellow, pts, cum, k0, k1, 0.07, 0.11, { off: l, keep: solid(l), yAt, tilt, clearAt: lineClear });
          strip(yellow, pts, cum, k0, k1, 0.07, 0.11, { off: r, keep: solid(r), yAt, tilt, clearAt: lineClear });
        }
        const lanes = Math.max(1, Math.round((e.w - 0.7) / 3.3));
        if (e.one) {
          for (let l = 1; l < lanes; l++) {
            const off = (kk: number) => halfAt(kk) * (-1 + (2 * l) / lanes);
            strip(white, pts, cum, k0, k1, 0.07, 0.11, { off, keep: dashed(off), yAt, tilt, clearAt: lineClear });
          }
        } else if (rank >= 1 && e.w >= 6) {
          const off = () => 0;
          strip(white, pts, cum, k0, k1, 0.07, 0.11, { keep: rank >= 3 ? solid(off) : dashed(off), yAt, tilt, clearAt: lineClear });
        }
      }
    });
  // Flyover pillars, and colliders for every deck (the ground heightfield
  // can't hold a road in the air).
  const concreteMat = new THREE.MeshStandardMaterial({ color: 0xc9c6bf, roughness: 0.9 });
  const deckLines = EP.map((pts, i) => (hasProfile[i] ? pts : []));
  const deckRuns = runsOf(deckLines);
  /**
   * Can a pier stand at (x, z), rising to `top`? Not on any road it would
   * pass through (on the ground, or a lower deck), nor on a footpath.
   */
  const pierClear = (x: number, z: number, top: number, self = -1) => {
    let ok = true;
    roads.each(x, z, 24, (i, seg, u, d) => {
      if (!ok || i === self || d > EHALF[i] + 1.2) return;
      const y = hasProfile[i] ? deckAtHit(i, seg, u) : heightAt(x, z);
      if (y < top - 1) ok = false;
    });
    const pp = pathIdx.nearest(x, z, 4);
    return ok && !(pp && pp.d < PHALF[pp.line] + 0.6);
  };
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
      if (!pierClear(x, z, top, line)) continue;
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
  // Junction pads: on a deck they sit level with it.
  // (Level with the ends of the roads that meet there, as they are drawn.)
  const padY = (j: number) => {
    // (On the ground, it lies on the ground like the roads' ends.)
    // (Between two pieces of a low bridge it stays up with them.)
    const bridge = jEdges[j].every((i) => isDeck[i] && hasProfile[i]);
    if (!jEdges[j].some((i) => hasProfile[i]) || (jRel[j] < 0.05 && !bridge)) return undefined;
    const [x, z] = M.junctions[j];
    let sum = 0;
    for (const i of jEdges[j]) {
      const atA = edges[i].a === j;
      const s = atA ? 0 : ELEN[i];
      if (!hasProfile[i]) {
        sum += dropAt(x, z);
        continue;
      }
      const y = deckY(i)[atA ? 0 : EP[i].length - 1];
      const t = elevated[i] ? 0 : tiltAt(i, s);
      sum += lerp(y, dropAt(x, z) + relAlong(i, s), t);
    }
    return sum / jEdges[j].length;
  };
  // Junction pads.
  const padsByTile = new Map<string, number[]>();
  M.junctions.forEach(([x, z], j) => {
    // Every joint gets a pad (at a bend between two pieces, the narrower
    // width): it fills the wedge where two ribbons meet at an angle.
    // Shaped junctions and clean bends need no pad.
    if (!jDegree[j] || JX.shapeOf[j] >= 0) return;
    if (mitred[j] && !jEdges[j].some((i) => hasProfile[i])) return;
    const k = tileKey(x, z);
    const l = padsByTile.get(k);
    if (l) l.push(j);
    else padsByTile.set(k, [j]);
  });
  for (const [k, all] of padsByTile)
    inChunks('far', k, all, 40, (list, _kit, acc) => {
      const road = acc('road');
      for (const j of list) {
        const [x, z] = M.junctions[j];
        const r = jDegree[j] === 2 ? (EHALF[jEdges[j][0]] + EHALF[jEdges[j][1]]) / 2 : jRadius[j];
        const y = padY(j);
        // (No kerb round it: the roads' own kerbs run up to the joint, and a
        // ring would only cross the road as a lip.)
        disc(road, x, z, r, 0.09, y);
      }
    });
  // Shaped junctions: the outline filled from its centre in rings (so it
  // follows the ground), and a kerb along each kerbed corner.
  const shapesByTile = new Map<string, number[]>();
  JPOLY.forEach((sh, id) => {
    const k = tileKey(sh.centre[0], sh.centre[1]);
    const l = shapesByTile.get(k);
    if (l) l.push(id);
    else shapesByTile.set(k, [id]);
  });
  const dropY = (x: number, z: number) => Math.max(rawHeight(x, z), WL + 0.15);
  const RINGS = [1 / 3, 2 / 3, 1];
  for (const [k, all] of shapesByTile)
    inChunks('far', k, all, 20, (list, _kit, acc) => {
      const road = acc('road');
      const kerb = acc('kerb');
      for (const id of list) {
        const sh = JPOLY[id];
        // Islands sit a hair under the roads round them.
        const lift = sh.fill ? 0.085 : 0.09;
        const [cx, cz] = sh.centre;
        const ring = sh.ring;
        const n = ring.length;
        const surfY = (x: number, z: number) => jTop(id, x, z);
        const base = road.pos.length / 3;
        road.pos.push(cx, surfY(cx, cz) + lift, cz);
        road.uv.push(cx / 6, cz / 6);
        for (const t of RINGS)
          for (const p of ring) {
            const x = cx + (p[0] - cx) * t;
            const z = cz + (p[1] - cz) * t;
            road.pos.push(x, surfY(x, z) + lift, z);
            road.uv.push(x / 6, z / 6);
          }
        for (let i = 0; i < n; i++) {
          const i1 = (i + 1) % n;
          road.idx.push(base, base + 1 + i1, base + 1 + i);
          for (let r = 0; r + 1 < RINGS.length; r++) {
            const a = base + 1 + r * n;
            const b = a + n;
            road.idx.push(a + i, a + i1, b + i1, a + i, b + i1, b + i);
          }
        }
        for (const F of sh.kerbs) {
          const kb = kerb.pos.length / 3;
          for (let q = 0; q < F.length; q++) {
            const a = F[Math.max(0, q - 1)];
            const b = F[Math.min(F.length - 1, q + 1)];
            const [tx, tz] = unit(b[0] - a[0], b[1] - a[1]);
            for (const o of [-0.3, 0.35]) {
              const x = F[q][0] + tz * o;
              const z = F[q][1] - tx * o;
              kerb.pos.push(x, dropY(x, z) + 0.07, z);
              kerb.uv.push(x / 6, z / 6);
            }
          }
          for (let q = 0; q + 1 < F.length; q++) {
            // (Not where it runs inside another junction's paving.)
            const along = (t: number) => inPaving(lerp(F[q][0], F[q + 1][0], t), lerp(F[q][1], F[q + 1][1], t), NaN, id);
            if (along(0.25) || along(0.5) || along(0.75)) continue;
            const a = kb + q * 2;
            kerb.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
          }
        }
      }
    });
  // Zebra stripes and stop lines.
  const crossByTile = new Map<string, Crossing[]>();
  for (const cr of crossings) {
    const k = tileKey(cr.c[0], cr.c[1]);
    (crossByTile.get(k) ?? crossByTile.set(k, []).get(k)!).push(cr);
  }
  /** A flat quad draped on the ground: centre, along (unit), half length, half width. */
  const quad = (acc: Acc, cx: number, cz: number, t: XZ, hl: number, hw: number, lift: number) => {
    const base = acc.pos.length / 3;
    const n: XZ = [-t[1], t[0]];
    for (const [a, b] of [
      [-hl, -hw],
      [hl, -hw],
      [-hl, hw],
      [hl, hw],
    ]) {
      const x = cx + t[0] * a + n[0] * b;
      const z = cz + t[1] * a + n[1] * b;
      acc.pos.push(x, Math.max(rawHeight(x, z), WL + 0.15) + lift, z);
      acc.uv.push(0, 0);
    }
    acc.idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  };
  for (const [k, list] of crossByTile)
    onTile('far', k, (_kit, acc) => {
      const white = acc('white');
      for (const cr of list) {
        const left: XZ = [-cr.t[1], cr.t[0]];
        // Stripes 0.5 m wide, 0.5 m apart, running along the road.
        const w = cr.half - 0.4;
        for (let o = -w + 0.25; o <= w - 0.25; o += 1) quad(white, cr.c[0] + left[0] * o, cr.c[1] + left[1] * o, cr.t, CROSS_W / 2, 0.25, 0.115);
        if (!cr.inbound) continue;
        // The stop line, across the lanes coming in.
        const sx = cr.c[0] + cr.t[0] * (STOP_AT - CROSS_FROM - CROSS_W / 2);
        const sz = cr.c[1] + cr.t[1] * (STOP_AT - CROSS_FROM - CROSS_W / 2);
        const from = cr.inbound === 2 ? -w : 0.15;
        const mid = (from + w) / 2;
        quad(white, sx + left[0] * mid, sz + left[1] * mid, left, (w - from) / 2, 0.2, 0.115);
      }
    });
  // Traffic lights: a pole on the left kerb, its lamps facing the traffic
  // coming in. The lamps of each direction share three materials, switched
  // in update().
  const lamp = (hex: number) => new THREE.MeshStandardMaterial({ color: 0x1a1a1a, emissive: hex, emissiveIntensity: 0.05, roughness: 0.5 });
  const LAMPS = [0, 1].map(() => [lamp(0xff2a1a), lamp(0xffa21a), lamp(0x2aff6a)]);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3b3f44, roughness: 0.7 });
  for (const [k, list] of crossByTile)
    onTile('near', k, (kit) => {
      const poles: THREE.BufferGeometry[] = [];
      const lamps: THREE.BufferGeometry[][][] = [0, 1].map(() => [[], [], []]);
      for (const cr of list) {
        if (!cr.light) continue;
        const [x, z] = cr.light;
        const y = heightAt(x, z);
        const yaw = Math.atan2(cr.t[0], cr.t[1]);
        poles.push(new THREE.CylinderGeometry(0.07, 0.09, 4.2, 6).translate(x, y + 2.1, z));
        poles.push(new THREE.BoxGeometry(0.34, 1.05, 0.26).rotateY(yaw).translate(x, y + 3.7, z));
        for (let i = 0; i < 3; i++) {
          const ly = y + 4.05 - i * 0.33;
          lamps[cr.group][i].push(new THREE.SphereGeometry(0.11, 8, 6).scale(1, 1, 0.5).translate(x + cr.t[0] * 0.14, ly, z + cr.t[1] * 0.14));
        }
      }
      if (poles.length) {
        const m = new THREE.Mesh(kit.own(mergeGeometries(poles)), poleMat);
        m.castShadow = true;
        kit.add(m);
      }
      lamps.forEach((g, gi) =>
        g.forEach((parts, i) => {
          if (parts.length) kit.add(new THREE.Mesh(kit.own(mergeGeometries(parts)), LAMPS[gi][i]));
        }),
      );
    });
  // 30 s cycle: one direction green 12 s, amber 3 s, then the other.
  const setLights = (time: number) => {
    const t = time % 30;
    const phase = (g: number) => {
      const u = (t - g * 15 + 30) % 30;
      return u < 12 ? 2 : u < 15 ? 1 : 0;
    };
    for (let g = 0; g < 2; g++) {
      const on = phase(g);
      LAMPS[g].forEach((m, i) => (m.emissiveIntensity = i === on ? 2.2 : 0.05));
    }
  };

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
  /** On (or within pad of) a junction or a paved island? */
  const inJunction = (x: number, z: number, pad: number) =>
    !!jGrid.get(Math.floor(x / JCELL) * 100003 + Math.floor(z / JCELL))?.some((id) => ringDist(JPOLY[id].ring, x, z)[0] < pad);
  const clearOfRoads = (x: number, z: number, pad: number) => {
    const r = roads.nearest(x, z, 16);
    if (r && r.d < EHALF[r.line] + pad) return false;
    if (inJunction(x, z, pad)) return false;
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
      if (inJunction(x, z, 2)) continue;
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
  // A pier about every 30 m, shifted along (up to 12 m) to stand clear of
  // any road or path below; where none is clear, the span runs on.
  const pierCache = new Map<number, number[]>();
  const railPiers = (line: number) => {
    let l = pierCache.get(line);
    if (l) return l;
    l = [];
    const pts = viaducts[line];
    for (let q = 0; q < pts.length; q += 5)
      for (const dq of [0, 1, -1, 2, -2]) {
        const qq = q + dq;
        if (qq < 0 || qq >= pts.length) continue;
        if (pierClear(pts[qq][0], pts[qq][1], railY(line, qq) - 1.1)) {
          l.push(qq);
          break;
        }
      }
    pierCache.set(line, l);
    return l;
  };
  for (const [k, list] of runsOf(viaducts)) {
    onTile('horizon', k, (kit) => {
      const top = new Acc();
      const parts: THREE.BufferGeometry[] = [];
      for (const { line, k0, k1 } of list) {
        strip(top, viaducts[line], VCUM[line], k0, k1, 2.6, 0, { yAt: (q) => railY(line, q) });
        for (const q of railPiers(line)) {
          if (q < k0 || q > k1) continue;
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
        for (const q of railPiers(line)) {
          if (q < k0 || q > k1) continue;
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
  // The car drives on what you see: every road and junction surface is also
  // a collider (the ground under a road is sealed a little below it, so the
  // wheels would otherwise sink, and ride its 4 m grid's bumps). The surface
  // comes from the tile's far-layer build, kept for a while; a near tile
  // that finds none builds it again off-scene.
  const roadSurf = new Map<string, { pos: Float32Array; idx: Uint32Array }>();
  const keepSurf = (k: string, a: Acc | undefined) => {
    roadSurf.delete(k);
    roadSurf.set(k, { pos: new Float32Array(a?.pos ?? []), idx: new Uint32Array(a?.idx ?? []) });
    if (roadSurf.size > 300) roadSurf.delete(roadSurf.keys().next().value!);
  };
  const offScene = { add: () => {}, own: <T>(g: T) => g, body: () => null } as unknown as TileKit;
  function* surfaceOf(k: string): Generator<void, { pos: Float32Array; idx: Uint32Array }, void> {
    const got = roadSurf.get(k);
    if (got) return got;
    const accs = new Map<AccKey, Acc>();
    const acc = (key: AccKey) => {
      let a = accs.get(key);
      if (!a) accs.set(key, (a = new Acc()));
      return a;
    };
    for (const job of jobs.far.get(k) ?? []) {
      job(offScene, acc);
      yield;
    }
    keepSurf(k, accs.get('road'));
    return roadSurf.get(k)!;
  }
  const roadCollider = (surf: { pos: Float32Array; idx: Uint32Array }, kit: TileKit) => {
    if (!surf.idx.length) return;
    world.createCollider(RAPIER.ColliderDesc.trimesh(surf.pos, surf.idx).setFriction(0.9), kit.body());
  };
  const builder = (layer: Layer) =>
    function* (ti: number, tj: number, kit: TileKit) {
      const t = yield* ensurePatch(ti, tj, layer === 'horizon' ? STEP_FAR : STEP);
      if (t) {
        if (layer === 'near') terrainCollider(t, kit);
        else groundMesh(t, kit, layer === 'horizon');
      }
      yield;
      if (layer === 'near') {
        roadCollider(yield* surfaceOf(`${ti},${tj}`), kit);
        yield* plantTile(ti, tj, kit);
      }
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
      if (layer === 'far') keepSurf(`${ti},${tj}`, accs.get('road'));
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
    (globalThis as any).__osm = {
      surfaceAt: rawHeight,
      // Every pier's foot and top, rail and road.
      piers: () => {
        const out: { x: number; z: number; top: number; kind: string; self: number }[] = [];
        edges.forEach((_, line) => pillarsOf(line, 0, EP[line].length - 1, (x, z, top) => out.push({ x, z, top, kind: 'flyover', self: line })));
        viaducts.forEach((pts, line) => railPiers(line).forEach((q) => out.push({ x: pts[q][0], z: pts[q][1], top: railY(line, q) - 1.1, kind: 'rail', self: -1 })));
        return out;
      },
      crossings, CROSS_FROM, CROSS_W,
      // A far tile's road buffers, built off-scene (for the seam checks).
      farTiles: () => [...jobs.far.keys()],
      tileAccs: (k: string) => {
        const accs = new Map<AccKey, Acc>();
        const acc = (key: AccKey) => {
          let a = accs.get(key);
          if (!a) accs.set(key, (a = new Acc()));
          return a;
        };
        const kit = { add: () => {}, own: <T>(g: T) => g, body: () => null } as unknown as TileKit;
        for (const job of jobs.far.get(k) ?? []) job(kit, acc);
        return Object.fromEntries([...accs].map(([key, a]) => [key, { pos: a.pos, idx: a.idx }]));
      },
      JX,
      halfAtE,
      cutOf,
      needs, jCap, jCeil, deckEnd, sepA, sepB, relAlong, ELEN, tiltAt, LIMITS, WL, throughOf, WIDTH_RATE, runOf, runs,
      fillTop: (k: number, x: number, z: number) => fillTop(JX.shapes.length + k, x, z),
      jTop: (k: number, x: number, z: number) => jTop(k, x, z),
      edges, EP, ECUM, EHALF, elevated, isDeck, embank, hasProfile, deckY, jRel, baseAt, heightAt, paths, PHALF, roads };
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
      setLights(time);
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
