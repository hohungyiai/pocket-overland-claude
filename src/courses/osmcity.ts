import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fbm, lerp, mulberry32, smoothstep, valueNoise } from '../noise';
import { SURFACES, type Course, type MapData, type Surface, type XZ } from './types';
import * as D from './detail';
import { TILE, TileStreamer, type Layer, type TileKit } from '../world/stream';
import { SegIndex, inRing, resample, ringArea } from '../world/segindex';
import { convexHull, inRingXZ, shapeJunctions } from '../world/junctions';
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
  paths: { k: 'foot' | 'cycle'; b?: number; pts: XZ[] }[];
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
  opts: { style?: D.ArtStyle; map?: string; name?: string; startAt?: XZ } = {},
): Promise<Course> {
  // (A trial area is the same builder on another map file: see tools/osm/redraw.mjs.)
  const res = await fetch(opts.map ?? PASIR_RIS_MAP);
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
  // Splits and merges. Where one road becomes two (or two become one) at
  // a narrow angle, OSM draws all three from the one point: drawn that way
  // the two branches start from the middle of the road they come from,
  // whose outside edges stop dead (a step in the road's width; on a
  // flyover, parapets ending in mid-air). Instead the branches start side
  // by side inside the road they come from: the left branch's left edge
  // carries on that road's left edge, the right branch's right edge its
  // right edge, and each eases back onto its own line as the two part.
  /** Joints (junction ids) where three roads on one level meet as a split, with [single road, left branch, right branch]. */
  const deckSplits = new Map<number, [number, number, number]>();
  /** At each, the single road's heading into the split. */
  const splitDir = new Map<number, XZ>();
  {
    const byNode = new Map<number, number[]>();
    edges.forEach((e, i) => {
      for (const j of [e.a, e.b]) (byNode.get(j) ?? byNode.set(j, []).get(j)!).push(i);
    });
    /** Road i's points, running away from joint j. */
    const from = (i: number, j: number) => (edges[i].a === j ? EP[i] : [...EP[i]].reverse());
    /** The point s metres along P. */
    const along = (P: XZ[], s: number): XZ => {
      let run = 0;
      for (let k = 0; k + 1 < P.length; k++) {
        const l = Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]);
        if (run + l >= s) return [lerp(P[k][0], P[k + 1][0], (s - run) / (l || 1)), lerp(P[k][1], P[k + 1][1], (s - run) / (l || 1))];
        run += l;
      }
      return P[P.length - 1];
    };
    const COS35 = Math.cos((35 * Math.PI) / 180);
    for (const [j, list] of byNode) {
      if (list.length !== 3 || new Set(list).size !== 3) continue;
      const lv = edges[list[0]].lv ?? 0;
      if (list.some((i) => (edges[i].lv ?? 0) !== lv)) continue;
      const P = list.map((i) => from(i, j));
      // (On the ground, not the short pieces inside a knot of slip roads: a junction's shape joins those.)
      if (lv <= 0 && list.every((i) => /^(motorway|trunk)|_link$/.test(edges[i].cls)) && P.some((Q) => along(Q, 30) === Q[Q.length - 1])) continue;
      const dir = P.map((Q) => {
        const q = along(Q, 12);
        const l = Math.hypot(q[0] - Q[0][0], q[1] - Q[0][1]) || 1;
        return [(q[0] - Q[0][0]) / l, (q[1] - Q[0][1]) / l] as XZ;
      });
      const dot = (a: number, b: number) => dir[a][0] * dir[b][0] + dir[a][1] * dir[b][1];
      for (let c = 0; c < 3; c++) {
        // (c the single road; a and b the branches, leaving within 35° of each other, opposite it.)
        const a = (c + 1) % 3, b = (c + 2) % 3;
        if (dot(a, b) < COS35 || -dot(c, a) < 0.8 || -dot(c, b) < 0.8) continue;
        // Which branch is on the left, looking from the single road: by where the two are 30 m on.
        const u: XZ = [-dir[c][0], -dir[c][1]];
        const qa = along(P[a], 30), qb = along(P[b], 30);
        const aLeft = (qa[0] - qb[0]) * u[1] - (qa[1] - qb[1]) * u[0] > 0;
        const [L, R] = aLeft ? [a, b] : [b, a];
        deckSplits.set(j, [list[c], list[L], list[R]]);
        splitDir.set(j, u);
        break;
      }
    }
  }
  const cumOf = (pts: XZ[]) => {
    const c = [0];
    for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    return c;
  };
  const ECUM = EP.map(cumOf);
  const EHALF = edges.map((e) => e.w / 2);
  const isDeck = edges.map((e) => (e.lv ?? 0) > 0);
  const ELEN = ECUM.map((c) => c[c.length - 1]);
  const jE = M.junctions.map(() => [] as number[]);
  edges.forEach((e, i) => {
    jE[e.a]?.push(i);
    if (e.b !== e.a) jE[e.b]?.push(i);
  });
  // (Made again once the branches of splits have moved.)
  let roads = new SegIndex(EP, 24);
  const paths = M.paths.map((p) => ({ k: p.k, b: p.b ? 1 : 0, pts: resample(p.pts, 4) }));
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
  let elevIdx = new SegIndex(EP, 24, false, (i) => !elevated[i]);
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
  // Joints within 300 m (along the roads) of a flyover's end.
  const nearDeck = new Uint8Array(M.junctions.length);
  {
    const dist = new Float32Array(M.junctions.length).fill(Infinity);
    const queue: number[] = [];
    edges.forEach((e, i) => {
      if (!elevated[i]) return;
      for (const j of [e.a, e.b]) if (dist[j] > 0) (dist[j] = 0), queue.push(j);
    });
    while (queue.length) {
      const j = queue.pop()!;
      nearDeck[j] = 1;
      for (const i of jE[j] ?? []) {
        const o = edges[i].a === j ? edges[i].b : edges[i].a;
        const d = dist[j] + ELEN[i];
        if (d < 300 && d < dist[o]) (dist[o] = d), queue.push(o);
      }
    }
  }
  // Half width along a road: where two pieces of one road meet with different
  // widths (OSM lane counts change), both taper to the average.
  // Widths change gently: where a road meets the next piece of the same road
  // at a different width (OSM splits a way where a lane is added or dropped),
  // the wider one tapers to the narrower at no more than 1 m per 20 m
  // (WIDTH_RATE). (At a junction, the junction's own shape joins roads of
  // different widths.)
  const WIDTH_RATE = 1 / 20;
  const WIDTH_RATE_FAST = 1 / 50;
  /** The next piece of the same road at a plain joint (two roads), if any. */
  const throughOf = (j: number, me: number) => {
    const l = (jE[j] ?? []).filter((o) => edges[o].a !== edges[o].b);
    if (l.length !== 2 || !l.includes(me)) return undefined;
    return l[0] === me ? l[1] : l[0];
  };
  // A road's pieces, joined end to end where one carries straight on from
  // the next, are a run; along each run the width changes no faster than
  // WIDTH_RATE.
  // Through a junction too: the piece that carries a road straight on
  // (the same name, or the same class with no name, turning under 30
  // degrees, each the other's best), so its width tapers through a merge
  // or a split instead of stepping at the junction.
  const headOut = (i: number, j: number): XZ => {
    const P = EP[i];
    const atA = edges[i].a === j;
    const p0 = atA ? P[0] : P[P.length - 1];
    let k = atA ? 1 : P.length - 2;
    const c = ECUM[i];
    while (k > 0 && k < P.length - 1 && Math.abs(c[k] - (atA ? 0 : ELEN[i])) < 12) k += atA ? 1 : -1;
    const q = P[Math.max(0, Math.min(P.length - 1, k))];
    const l = Math.hypot(q[0] - p0[0], q[1] - p0[1]) || 1;
    return [(q[0] - p0[0]) / l, (q[1] - p0[1]) / l];
  };
  const sameRoad = (i: number, o: number) => (edges[i].name ? edges[i].name === edges[o].name : !edges[o].name && edges[i].cls === edges[o].cls);
  const COS30 = Math.cos((30 * Math.PI) / 180);
  const carryOn = (j: number, i: number) => {
    let best: number | undefined;
    let bd = COS30;
    const hi = headOut(i, j);
    for (const o of jE[j] ?? []) {
      if (o === i || edges[o].a === edges[o].b || ELEN[o] < 30 || !sameRoad(i, o) || isDeck[o] !== isDeck[i]) continue;
      // (More than twice the width: a road opening into a junction's approach, not a lane more or less.)
      if (Math.max(EHALF[i], EHALF[o]) > 2 * Math.min(EHALF[i], EHALF[o])) continue;
      const ho = headOut(o, j);
      const d = -(hi[0] * ho[0] + hi[1] * ho[1]); // straight on: opposite headings
      if (d > bd) (bd = d), (best = o);
    }
    return best;
  };
  // A split or a merge: three roads at a joint, two of them leaving side by
  // side (within 35 degrees) and the third opposite. The third carries on
  // as the wider of the two (whatever their names), the other being its
  // slip road.
  const splitAt = new Map<number, [number, number]>();
  {
    const COS35 = Math.cos((35 * Math.PI) / 180);
    jE.forEach((all, j) => {
      const l = all.filter((i) => edges[i].a !== edges[i].b);
      if (l.length !== 3 || all.length !== 3 || l.some((i) => isDeck[i] || ELEN[i] < 30)) return;
      const h = l.map((i) => headOut(i, j));
      const dot = (x: number, y: number) => h[x][0] * h[y][0] + h[x][1] * h[y][1];
      for (const [x, y, w] of [[0, 1, 2], [0, 2, 1], [1, 2, 0]]) {
        if (dot(x, y) < COS35 || dot(w, x) > -COS35 || dot(w, y) > -COS35) continue;
        const A = l[x], B = l[y], W = l[w];
        const key = (i: number) => [EHALF[i], edges[i].name && edges[i].name === edges[W].name ? 1 : 0, -i];
        const ka = key(A), kb = key(B);
        let first = true;
        for (let t = 0; t < 3; t++) if (ka[t] !== kb[t]) { first = ka[t] > kb[t]; break; }
        splitAt.set(j, [W, first ? A : B]);
      }
    });
  }
  const mate1 = (i: number, j: number) => {
    const o = throughOf(j, i);
    if (o !== undefined) return o !== i && throughOf(j, o) === i ? o : undefined;
    if ((jE[j]?.length ?? 0) < 3) return undefined;
    // (Not the short pieces inside a big junction: its shape joins those.)
    // (Nor flyover decks: the roads beside a deck are set out from its full width.)
    if (ELEN[i] < 30 || isDeck[i]) return undefined;
    const c = carryOn(j, i);
    return c !== undefined && carryOn(j, c) === i ? c : undefined;
  };
  // (Not from a road into a narrower branch of it at a split: the road keeps
  // its width up to the joint, and its branches are set out from its edges.)
  const mate0 = (i: number, j: number) => {
    const o = mate1(i, j);
    const sp = deckSplits.get(j);
    if (o === undefined || !sp || nearDeck[j] || (i !== sp[0] && o !== sp[0])) return o;
    return EHALF[sp[0]] > EHALF[i === sp[0] ? o : i] + 0.05 ? undefined : o;
  };
  // (Worked out once, from the roads as OSM has them: the branches of a split move later.)
  const nextOf = edges.map((e, i) => [mate0(i, e.a), mate0(i, e.b)]);
  const mate = (i: number, j: number) => nextOf[i][edges[i].a === j ? 0 : 1];
  /** Each edge's run, where it starts along it, and which way it runs. */
  const runOf = edges.map(() => ({ run: -1, at: 0, fwd: true }));
  /** (osm: the widest each metre may be; settle() works out the tapered widths again from it.) */
  const runs: { len: number; smooth: Float32Array; rate: number; osm: Float32Array; settle: () => void }[] = [];
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
    // (Expressways and their slip roads taper over longer: 1 m per 50 m.)
    const fast = list.some(({ i: q }) => /^(motorway|trunk)/.test(edges[q].cls));
    let rate = (fast ? WIDTH_RATE_FAST : WIDTH_RATE) / 2;
    const osm = smooth.slice();
    const R = { len: n, smooth, rate: rate * 2, osm, settle: () => {} };
    const envelope = () => {
      smooth.set(osm);
      for (let pass = 0; pass < (loop ? 2 : 1); pass++) {
        for (let m = 1; m <= n; m++) smooth[m] = Math.min(smooth[m], smooth[m - 1] + rate);
        if (loop) smooth[0] = Math.min(smooth[0], smooth[n - 1] + rate);
        for (let m = n - 1; m >= 0; m--) smooth[m] = Math.min(smooth[m], smooth[m + 1] + rate);
        if (loop) smooth[n] = Math.min(smooth[n], smooth[1] + rate);
      }
    };
    R.settle = () => {
      envelope();
      // (A long taper must not swallow a short wide piece: if any piece is
      // left under three quarters of its width half way along, the run
      // falls back to the ordinary taper.)
      if (fast && rate !== WIDTH_RATE / 2) {
        let start = 0;
        for (const { i: q } of list) {
          const mid = Math.min(n, Math.round(start + ELEN[q] / 2));
          if (smooth[mid] < 0.75 * EHALF[q]) {
            rate = WIDTH_RATE / 2;
            envelope();
            break;
          }
          start += ELEN[q];
        }
      }
      R.rate = rate * 2;
    };
    R.settle();
    runs.push(R);
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
  // At each split the widths meet: on the ground, neither branch starts
  // wider than the road it comes from, and that road is no wider at the
  // joint than its two branches side by side (each tapers there, as a lane
  // is added or dropped). Then the branches move out to its edges.
  {
    const SPLIT_RATE = 20; // metres along for each metre a branch moves sideways
    const endHalf = (i: number, j: number) => halfAtE(i, edges[i].a === j ? 0 : EP[i].length - 1);
    const dirty = new Set<number>();
    for (const [j, [c, L, R]] of deckSplits) {
      if (isDeck[c]) continue;
      const hc = endHalf(c, j), hl = endHalf(L, j), hr = endHalf(R, j);
      const capL = Math.min(hl, hc), capR = Math.min(hr, hc);
      const capC = Math.min(hc, capL + capR - 0.1);
      for (const [i, cap, h] of [[c, capC, hc], [L, capL, hl], [R, capR, hr]]) {
        if (cap > h - 0.02) continue;
        const { run, at, fwd } = runOf[i];
        const Rn = runs[run];
        // (Only where the piece is long enough to be back at its own width half way along.)
        if (!Rn || (EHALF[i] - cap) / (Rn.rate / 2) > ELEN[i] / 2) continue;
        const s = at + (fwd === (edges[i].a === j) ? 0 : ELEN[i]);
        const m = s < 0.5 ? 0 : Math.min(Rn.len, Math.ceil(s));
        Rn.osm[m] = Math.min(Rn.osm[m], cap);
        dirty.add(run);
      }
    }
    for (const r of dirty) runs[r].settle();
    for (const [j, [c, L, R]] of deckSplits) {
      // (On the ground beside a flyover the roads are on ramps, their
      // heights worked out from where they lie side by side: left as drawn.)
      const hc = endHalf(c, j), hl = endHalf(L, j), hr = endHalf(R, j);
      // Each branch out to the single road's edge on its side; never so
      // far that the two would leave a gap between them at the joint.
      let sl = Math.max(0, hc - hl);
      let sr = Math.max(0, hc - hr);
      const room = hl + hr - 0.2;
      if (sl + sr > room) {
        const f = Math.max(0, room) / (sl + sr);
        sl *= f;
        sr *= f;
      }
      for (const [q, shift, side] of [[L, sl, 1], [R, sr, -1]]) {
        if (shift < 0.15) continue;
        const Q = edges[q].a === j ? EP[q] : [...EP[q]].reverse();
        let len = 0;
        const cum = Q.map((p, k) => (k ? (len += Math.hypot(p[0] - Q[k - 1][0], p[1] - Q[k - 1][1])) : 0));
        const D = Math.min(shift * SPLIT_RATE * 1.5, len * 0.5);
        // (Sideways as the single road has it. Left of travel: (tz, -tx).)
        const u = splitDir.get(j)!;
        const moved = Q.map((p, k) => {
          const f = side * shift * (1 - smoothstep(0, D, cum[k]));
          return [p[0] + u[1] * f, p[1] - u[0] * f] as XZ;
        });
        EP[q] = edges[q].a === j ? moved : moved.reverse();
        ECUM[q] = cumOf(EP[q]);
        ELEN[q] = ECUM[q][ECUM[q].length - 1];
      }
    }
  }
  roads = new SegIndex(EP, 24);
  elevIdx = new SegIndex(EP, 24, false, (i) => !elevated[i]);
  const JX = shapeJunctions({
    junctions: M.junctions,
    edges,
    EP,
    ECUM,
    halfAt: halfAtE,
    rank: (i) => rankOf(edges[i].cls),
    // Flyover decks keep plain pads; ramps and ground roads join shaped junctions.
    shapeable: (i) => !isDeck[i],
    // A split or a merge is no junction: the slip road runs into the road
    // it joins, and the wedge between them is paved (see gores).
    // (On expressways and slip roads; a side street forking is a junction.)
    // (And on the ground: near a flyover the roads are on ramps, which a
    // shaped junction holds level where they meet.)
    sideBySide: (a, ea, b, eb) => {
      const j = ea ? edges[a].b : edges[a].a;
      // (Not beside a flyover: there the junctions are left as they were.)
      const sp = (eb ? edges[b].b : edges[b].a) === j && !nearDeck[j] ? deckSplits.get(j) : undefined;
      return !!sp && ((sp[0] === a && (sp[1] === b || sp[2] === b)) || (sp[0] === b && (sp[1] === a || sp[2] === a)));
    },
    plain: (j) => splitAt.has(j) && !nearDeck[j] && (jE[j] ?? []).every((i) => /^(motorway|trunk)|_link$/.test(edges[i].cls)),
    slip: (j) => (jE[j] ?? []).length === 3 && jE[j].every((i) => /^(motorway|trunk)|_link$/.test(edges[i].cls)),
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
  // (Worked out once for every road: the ground's height is asked of these
  // tens of thousands of times for each tile built.)
  const TRIM_A = Float64Array.from(edges, (_, i) => Math.min(Math.max(elevated[i] ? 0 : JX.trimA[i] || 0, sepA[i]), ELEN[i] * 0.4));
  const TRIM_B = Float64Array.from(edges, (_, i) => Math.min(Math.max(elevated[i] ? 0 : JX.trimB[i] || 0, sepB[i]), ELEN[i] * 0.4));
  const RUN_LEN = Float64Array.from(edges, (_, i) => Math.max(0, ELEN[i] - TRIM_A[i] - TRIM_B[i]));
  const trimA = (i: number) => TRIM_A[i];
  const trimB = (i: number) => TRIM_B[i];
  const runLen = (i: number) => RUN_LEN[i];
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
  // (Both sums below spread out from their starting junctions in order,
  // lowest ceiling first and highest rise first, so each junction is
  // settled once. Taking them in any other order gives the same answer in
  // the end, but can visit the same junctions millions of times over:
  // that was most of the time the game took to start.)
  /** A heap of junctions by a key: pops the smallest (or with sign -1 the largest) first. */
  const heapOf = (sign: 1 | -1) => {
    const keys: number[] = [];
    const ids: number[] = [];
    return {
      get size() {
        return ids.length;
      },
      push(key: number, id: number) {
        key *= sign;
        let q = ids.length;
        while (q > 0) {
          const up = (q - 1) >> 1;
          if (keys[up] <= key) break;
          keys[q] = keys[up];
          ids[q] = ids[up];
          q = up;
        }
        keys[q] = key;
        ids[q] = id;
      },
      pop(): [number, number] {
        const top: [number, number] = [keys[0] * sign, ids[0]];
        const key = keys.pop()!;
        const id = ids.pop()!;
        const n = ids.length;
        if (n > 0) {
          let q = 0;
          for (;;) {
            let c = 2 * q + 1;
            if (c >= n) break;
            if (c + 1 < n && keys[c + 1] < keys[c]) c++;
            if (keys[c] >= key) break;
            keys[q] = keys[c];
            ids[q] = ids[c];
            q = c;
          }
          keys[q] = key;
          ids[q] = id;
        }
        return top;
      },
    };
  };
  const ceilings = () => {
    jCeil.set(jCap);
    const heap = heapOf(1);
    jCap.forEach((c, j) => c < Infinity && heap.push(c, j));
    while (heap.size) {
      const [c0, j] = heap.pop();
      // (Lowered again since it was queued: already dealt with.)
      if (c0 > jCeil[j]) continue;
      for (const i of jE[j] ?? []) {
        if (elevated[i]) continue;
        const o = edges[i].a === j ? edges[i].b : edges[i].a;
        const c = Math.fround(jCeil[j] + MAX_GRADE * runLen(i));
        if (c < jCeil[o]) {
          jCeil[o] = c;
          heap.push(c, o);
        }
      }
    }
  };
  const lift = () => {
    jRel.fill(0);
    ceilings();
    const heap = heapOf(-1);
    const raise = (j: number, r: number) => {
      r = Math.fround(Math.min(deckEnd[j] ? jCeil[j] : jCap[j], jCeil[j], r));
      // (A rise of a centimetre or less is none.)
      if (r > 0.01 && r > jRel[j]) {
        jRel[j] = r;
        heap.push(r, j);
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
    while (heap.size) {
      const [r0, j] = heap.pop();
      if (r0 < jRel[j]) continue;
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
  const jBase = Float64Array.from(M.junctions, ([jx, jz]) => baseAt(jx, jz));
  const roadBase = (i: number, s: number, x: number, z: number) => {
    const b = baseAt(x, z);
    if (elevated[i]) return b;
    const e = edges[i];
    let r = b;
    const ta = trimA(i);
    const tb = trimB(i);
    // (Gone well before the far end, however short the road.)
    const F = Math.min(12, Math.max(0.5, runLen(i) / 2));
    if (ta > 0) r += (1 - smoothstep(ta, ta + F, s)) * smoothstep(0.02, 0.5, jRel[e.a]) * (jBase[e.a] - b);
    if (tb > 0) r += (1 - smoothstep(tb, tb + F, ELEN[i] - s)) * smoothstep(0.02, 0.5, jRel[e.b]) * (jBase[e.b] - b);
    return r;
  };
  // Headroom. Wherever a raised road runs over a lower one:
  // - a slip road (or a ramp) running alongside under its edge is raised to
  //   its level, so the two merge;
  // - any other road crossing under stays down (its junctions nearby are
  //   capped), and if it can't go low enough the road above is raised.
  const HEAD = 6.0; // 4.8 m clear under a 1.2 m deck
  // Pairs found crossing at the same height (see the level pass below):
  // never treated as a slip road merging alongside.
  const crossing = new Set<string>();
  // Flyovers sent up a level: no road alongside is pulled up with them.
  const bumped = new Uint8Array(edges.length);
  const settle = (passes: number) => {
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
    // (A road held down under one flyover may still merge with another
    // raised road further on, if it joins it there: through a short link.)
    const joins = (i: number, o: number) => [edges[o].a, edges[o].b].some((j) => (jE[j] ?? []).some((t) => t !== o && ELEN[t] < 30 && shares(t, i)));
    const merges = (h: Hit) => h.dot > 0.8 && (!capped[h.o] || joins(h.i, h.o)) && !bumped[h.i] && !crossing.has(h.i + ',' + h.o) && (isLink(h.o) || raised(h.o));
    // Can road o rise to `rel` at s, no steeper than 1 in 10 from a capped end?
    const MAXG = 0.1;
    const canRise = (o: number, s: number, rel: number) =>
      rel - MAXG * runA(o, s) <= jCap[edges[o].a] && rel - MAXG * runB(o, s) <= jCap[edges[o].b];
    for (let pass = 0; pass < passes; pass++) {
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
  };
  settle(4);
  // Levels. Two roads that cross on the map without a junction can't both
  // be at the same height: that happens where a flyover crosses a road
  // raised on a ramp to its own flyover. The flyover on top (the higher OSM
  // layer, then a bridge over a road that isn't one, then a slip road over
  // a through road) goes up a level there, 6.5 m over the road below; then
  // every height is worked out again.
  {
    const over = (i: number, o: number) => {
      const key = (n: number) => [edges[n].lv ?? 0, isDeck[n] ? 1 : 0, /_link$/.test(edges[n].cls) ? 1 : 0, -n];
      const a = key(i), b = key(o);
      for (let t = 0; t < a.length; t++) if (a[t] !== b[t]) return a[t] > b[t];
      return false;
    };
    const yOf = (i: number, s: number, x: number, z: number) => roadBase(i, s, x, z) + relAlong(i, s);
    const up: { i: number; s: number; rel: number }[] = []; // where a flyover must rise
    // Pass 1 finds the pairs (centre lines crossing at one height); pass 2
    // asks for a level over the road below wherever the deck overlaps it.
    for (const pass of [1, 2])
    edges.forEach((_, i) => {
      if (!elevated[i]) return;
      const P = EP[i];
      for (let k = 0; k < P.length; k++) {
        const yi = yOf(i, ECUM[i][k], P[k][0], P[k][1]);
        roads.each(P[k][0], P[k][1], EHALF[i] + 12, (o, seg, u, dd) => {
          if (pass === 2) {
            if (!crossing.has(i + ',' + o) || dd > EHALF[i] + EHALF[o]) return;
          } else if (o === i || dd > 1 || shares(i, o) || (edges[o].lv ?? 0) < 0 || !over(i, o)) return;
          const c = ECUM[o];
          const Q = EP[o];
          const q = Q[Math.min(Q.length - 1, seg + 1)];
          const so = c[seg] + (c[Math.min(c.length - 1, seg + 1)] - c[seg]) * u;
          const x = lerp(Q[seg][0], q[0], u), z = lerp(Q[seg][1], q[1], u);
          const bo = roadBase(o, so, x, z);
          const yo = yOf(o, so, x, z);
          if (pass === 1) {
            if (Math.abs(yi - yo) < 0.3 && yo - bo > 2) crossing.add(i + ',' + o);
            return;
          }
          if (yi - yo >= DECK_H) return;
          // (A whole level over the road below: levels stand 6.5 m apart.)
          up.push({ i, s: ECUM[i][k], rel: yo - bo + DECK_H });
        });
      }
    });
    if (up.length) {
      // (The deck climbs to it and back down at RAMP_GRADE where it has
      // room, up to 1 in 10 where it hasn't; its ends stay at their level.)
      jCap.fill(Infinity);
      needs.forEach((l) => (l.length = 0));
      for (const u of up) {
        needs[u.i].push({ s: u.s, rel: u.rel });
        bumped[u.i] = 1;
      }
      lift();
      settle(6);
    }
  }
  // Roads (not decks) that climb to a flyover: the ground rises under them.
  const embank = edges.map((e, i) => !isDeck[i] && ((jRel[e.a] ?? 0) > 0.02 || (jRel[e.b] ?? 0) > 0.02 || needs[i].length > 0));
  const rampIdx = new SegIndex(EP, 24, false, (i) => !embank[i]);
  // The most each road stands above the ground anywhere along it (never
  // less than relAlong gives): a bank reaches 3 m out for each metre up, so
  // a point further out than that from a road needn't ask its height.
  const relTop = (() => {
    const own = edges.map((e, i) => {
      let m = Math.max(jRel[e.a] ?? 0, jRel[e.b] ?? 0, elevated[i] ? DECK_H * deckLevel[i] : 0);
      for (const n of needs[i]) m = Math.max(m, n.rel);
      return m;
    });
    return Float64Array.from(own, (m, i) => {
      for (const mt of mates[i]) m = Math.max(m, own[mt.o]);
      return m + 1e-6;
    });
  })();
  // Decks and raised roads have their own surface height (not the ground's),
  // level across their width.
  const hasProfile = edges.map((_, i) => isDeck[i] || embank[i]);
  // (The roads on the ground at its own level, apart from the raised ones
  // in rampIdx: a bank beside them is only cut back where there is one.)
  const flatIdx = new SegIndex(EP, 24, false, (i) => hasProfile[i]);
  const flatHalfMax = edges.reduce((m, _, i) => (hasProfile[i] ? m : Math.max(m, EHALF[i])), 0);
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
        if (d > inner + 2 + 3 * DECK_H * 2 || d > inner + 2 + relTop[line] * 3) return;
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
      // (A raised road first: its own height, measured from its base.)
      rampIdx.each(x, z, 30, (line, seg, u, d) => {
        const slack = Math.max(0, d - EHALF[line] - 0.6) / 2;
        const pts = EP[line];
        const sl = Math.hypot(pts[seg + 1][0] - pts[seg][0], pts[seg + 1][1] - pts[seg][1]);
        const sa = ECUM[line][seg] + u * sl;
        let yr = roadBase(line, sa, lerp(pts[seg][0], pts[seg + 1][0], u), lerp(pts[seg][1], pts[seg + 1][1], u));
        // (A road is never below its base: one whose base alone already
        // clears this point needn't work out how far above it stands.)
        if (yr + slack >= h) return;
        yr += relAlong(line, sa);
        const cap = yr + slack;
        if (cap < h) h = cap;
      });
      // (Then the roads on the ground, which lie at hb: they only matter
      // where the ground here still stands above that, and then only those
      // near enough for their 1 in 2 to come under it.)
      const over = h - hb;
      if (over > 0)
        flatIdx.each(x, z, Math.min(30, flatHalfMax + 0.6 + 2 * over + 1e-6), (line, _seg, _u, d) => {
          const cap = hb + Math.max(0, d - EHALF[line] - 0.6) / 2;
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
  type Job = ((kit: TileKit, acc: AccFor) => void) & { what?: string };
  const jobs = { near: new Map<string, Job[]>(), far: new Map<string, Job[]>(), horizon: new Map<string, Job[]>() };
  const tileKey = (x: number, z: number) => `${Math.floor(x / TILE)},${Math.floor(z / TILE)}`;
  const onTile = (layer: Layer, k: string, what: string, job: Job) => {
    job.what = what;
    const list = jobs[layer].get(k);
    if (list) list.push(job);
    else jobs[layer].set(k, [job]);
  };
  /**
   * What each kind of build slice has cost so far (count, total and longest
   * in ms), for the performance check: a slice can't be interrupted, so a
   * long one is a hitch on the road.
   */
  const sliceCost = new Map<string, { n: number; ms: number; max: number; at: string }>();
  const cost = (what: string, at: string, t0: number) => {
    const ms = performance.now() - t0;
    const c = sliceCost.get(what) ?? sliceCost.set(what, { n: 0, ms: 0, max: 0, at: '' }).get(what)!;
    c.n++;
    c.ms += ms;
    if (ms > c.max) {
      c.max = ms;
      c.at = at;
    }
  };
  /** One fixed body for all of a tile layer's own colliders, however many jobs add to it. */
  const tileBodies = new WeakMap<TileKit, ReturnType<TileKit['body']>>();
  const tileBody = (kit: TileKit) => tileBodies.get(kit) ?? tileBodies.set(kit, kit.body()).get(kit)!;
  /** One job per `size` items, so each build step stays short. */
  const inChunks = <T>(layer: Layer, k: string, what: string, items: T[], size: number, job: (part: T[], kit: TileKit, acc: AccFor) => void) => {
    for (let s = 0; s < items.length; s += size) {
      const part = items.slice(s, s + size);
      onTile(layer, k, what, (kit, acc) => job(part, kit, acc));
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
    // (Each corner is shared by the pieces either side of it: asked once.)
    const asked = clearAt ? new Int8Array((k1 - k0 + 1) * 2) : null;
    const corner = (v: number) => {
      const q = v - base;
      if (!asked![q]) asked![q] = clearAt!(P[v * 3], P[v * 3 + 1] - lift, P[v * 3 + 2]) ? 1 : 2;
      return asked![q] === 1;
    };
    for (let k = k0; k < k1; k++) {
      if (o.keep && !o.keep(k)) continue;
      const a = base + (k - k0) * 2;
      if (clearAt && !(corner(a) && corner(a + 1) && corner(a + 2) && corner(a + 3))) continue;
      // (Each half faces up: round the inside of a tight bend, or at a bend
      // right beside a junction's mouth, a side doubles back and the piece
      // folds over, half of it facing the ground.)
      faceUp(acc, a, a + 2, a + 1);
      faceUp(acc, a + 1, a + 2, a + 3);
    }
  };
  /** Adds the triangle u, v, w, wound whichever way round faces up. */
  function faceUp(acc: Acc, u: number, v: number, w: number) {
    const P = acc.pos;
    const up = (P[v * 3 + 2] - P[u * 3 + 2]) * (P[w * 3] - P[u * 3]) - (P[v * 3] - P[u * 3]) * (P[w * 3 + 2] - P[u * 3 + 2]) >= 0;
    acc.idx.push(u, up ? v : w, up ? w : v);
  }
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
  /** A flat pad over an outline that (x, z) sees all of: like disc, to the outline instead of a radius. */
  const padOver = (acc: Acc, x: number, z: number, ring: XZ[], lift: number, y?: number) => {
    const base = acc.pos.length / 3;
    const n = ring.length;
    const at = (px: number, pz: number) => (y ?? Math.max(rawHeight(px, pz), WL + 0.15)) + lift;
    acc.pos.push(x, at(x, z), z);
    acc.uv.push(0, 0);
    for (const f of [0.5, 1])
      for (const [px, pz] of ring) {
        const qx = x + (px - x) * f, qz = z + (pz - z) * f;
        acc.pos.push(qx, at(qx, qz), qz);
        acc.uv.push(((px - x) * f) / 6, ((pz - z) * f) / 6);
      }
    // (The outline runs the way disc's does: the pad faces up.)
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
      const t0 = performance.now();
      if (key !== 'wall' && key !== 'roof') {
        accMesh(acc, MAT[key], kit, key === 'deck' || key === 'rail');
        cost(`mesh: ${key}`, '', t0);
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
      cost(`mesh: ${key}`, '', t0);
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
    // (A cut landing on one of the road's own points leaves a first piece
    // of no length, and so of no direction: that end of the road was drawn
    // twisted round, or pinched to a point. The cut keeps 5 cm of the piece
    // it lies on, which is the piece its junction's mouth is square to.)
    const HAIR = 0.05;
    const dir = (k: number): XZ => {
      const l = cum[k + 1] - cum[k] || 1;
      return [(pts[k + 1][0] - pts[k][0]) / l, (pts[k + 1][1] - pts[k][1]) / l];
    };
    if (ta) {
      const c = at(ta);
      lo = c.k;
      const [dx, dz] = dir(lo);
      P[lo] = cum[lo + 1] - ta < HAIR ? [pts[lo + 1][0] - dx * HAIR, pts[lo + 1][1] - dz * HAIR] : c.p;
      ylo = c.y;
    }
    if (tb) {
      const c = at(ELEN[line] - tb);
      hi = c.k + 1;
      const [dx, dz] = dir(c.k);
      P[hi] = ELEN[line] - tb - cum[c.k] < HAIR ? [pts[c.k][0] + dx * HAIR, pts[c.k][1] + dz * HAIR] : c.p;
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
    // (The ground here is the same whichever road is asked about: worked
    // out once, and only if a draped road is near enough to need it.)
    let g = NaN;
    roads.each(x, z, 16, (i, seg, u, d) => {
      if (hit || i === line || d > Math.max(halfAtE(i, seg), halfAtE(i, seg + 1)) + 0.2) return;
      if (y !== y) hit = !elevated[i];
      else hit = Math.abs((hasProfile[i] ? deckAtHit(i, seg, u) : g === g ? g : (g = heightAt(x, z))) - y) < 3;
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
  const GCELL = 64;
  const goreGrid = new Map<number, number[]>();
  const gridGore = (id: number) => {
    const g = gores[id];
    const xs = g.ring.map((p) => p[0]), zs = g.ring.map((p) => p[1]);
    for (let a = Math.floor(Math.min(...xs) / GCELL); a <= Math.floor(Math.max(...xs) / GCELL); a++)
      for (let b = Math.floor(Math.min(...zs) / GCELL); b <= Math.floor(Math.max(...zs) / GCELL); b++) {
        const key = a * 100003 + b;
        (goreGrid.get(key) ?? goreGrid.set(key, []).get(key)!).push(id);
      }
  };
  /** In a gore (the paved wedge where two roads split or join, or the paved strip between two running side by side)? */
  const inGore = (x: number, z: number) => !!goreGrid.get(Math.floor(x / GCELL) * 100003 + Math.floor(z / GCELL))?.some((id) => inRingXZ(gores[id].ring, x, z));
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
          let last: { a: XZ; b: XZ; ya: number; yb: number } | null = null;
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
              last = null;
              continue;
            }
            // (The wedge starts from the last spot where the two still
            // overlap, so no sliver opens before its first row.)
            // (Or, where they start clear and then close in, from the last
            // spot where they were clear.)
            if ((sep < 0.05 || (sep >= GORE && sep < GORE + 1)) && !rows.length) {
              last = { a: ea, b: eb, ya, yb };
              continue;
            }
            if (sep >= GORE + 1 && !rows.length) {
              last = null;
              continue;
            }
            if (!rows.length && last) rows.push(last);
            last = null;
            rows.push({ a: ea, b: eb, ya, yb });
            if (sep >= GORE) finish();
          }
          finish();
        }
    });
    // Alongside. Two roads at one level that run side by side with less
    // than GORE m of ground between them are one surface there too, wherever
    // that is: not only out from a joint they share (a second carriageway
    // beside the first past the next junction, a median narrowing to
    // nothing before a junction). The strip between their edges is paved
    // and their kerbs stop, as in a gore; where it widens to GORE m the
    // verge begins, square-ended: never a needle of grass with a kerb on
    // each side of it. (Where one stands higher than the other they are not
    // one surface: a ramp beside the road it left. And not where a gore out
    // from a joint has paved the ground already.)
    gores.forEach((_, id) => gridGore(id));
    const COS_NEAR = Math.cos((50 * Math.PI) / 180);
    const widest = EHALF.reduce((m, h) => Math.max(m, h), 0) + 1;
    const far2 = (GORE + widest) * (GORE + widest);
    /** Walks road i: at(s) gives the point and direction there (as out() does, but from where it last stood, not searching from the start each time). */
    const walker = (i: number) => {
      const P = EP[i];
      const cum = ECUM[i];
      let k = 0;
      return (s: number) => {
        while (k > 0 && cum[k] > s) k--;
        while (k < P.length - 2 && cum[k + 1] <= s) k++;
        const sl = cum[k + 1] - cum[k] || 1;
        const u = (s - cum[k]) / sl;
        return { x: lerp(P[k][0], P[k + 1][0], u), z: lerp(P[k][1], P[k + 1][1], u), tx: (P[k + 1][0] - P[k][0]) / sl, tz: (P[k + 1][1] - P[k][1]) / sl, k, u, s };
      };
    };
    edges.forEach((eA, A) => {
      if (JX.internal[A] || eA.a === eA.b) return;
      // (Between its junctions, whose own paving has its own heights.)
      const s0 = JX.trimA[A] || 0;
      const s1 = ELEN[A] - (JX.trimB[A] || 0);
      if (s1 - s0 < 2) return;
      // The pieces of other roads that might lie beside this one, gathered
      // every 20 m along it (each pair of roads once, from the lower-numbered
      // one): most roads have none, and are done here.
      const STEP = 20;
      const reach = GORE + widest + EP[A].reduce((m, _, k) => Math.max(m, halfAtE(A, k)), 0) + STEP / 2 + 0.5;
      const near: number[][] = [];
      let any = false;
      const coarse = walker(A);
      for (let c = 0, C = Math.ceil((s1 - s0) / STEP); c <= C; c++) {
        const pc = coarse(Math.min(s1, s0 + c * STEP));
        const l: number[] = [];
        roads.each(pc.x, pc.z, reach, (B, seg) => {
          if (B <= A || JX.internal[B] || elevated[B] !== elevated[A] || edges[B].a === edges[B].b) return;
          const Q = EP[B];
          const sl = Math.hypot(Q[seg + 1][0] - Q[seg][0], Q[seg + 1][1] - Q[seg][1]) || 1;
          if (Math.abs(((Q[seg + 1][0] - Q[seg][0]) * pc.tx + (Q[seg + 1][1] - Q[seg][1]) * pc.tz) / sl) < COS_NEAR) return;
          l.push(B, seg);
        });
        near.push(l);
        if (l.length) any = true;
      }
      if (!any) return;
      // Every 2 m, and at each corner of the road's own line (none closer than half a metre).
      const stations: number[] = [];
      {
        const cum = ECUM[A];
        let k = 1;
        let last = -Infinity;
        for (let n = 0, N = Math.ceil((s1 - s0) / 2); n <= N; n++) {
          const sn = Math.min(s1, s0 + n * 2);
          for (; k < cum.length && cum[k] < sn; k++) if (cum[k] > s0 && cum[k] - last >= 0.5 && sn - cum[k] >= 0.5) stations.push((last = cum[k]));
          stations.push((last = sn));
        }
      }
      for (const sgn of [-1, 1]) {
        let rows: { a: XZ; b: XZ; ya: number; yb: number }[] = [];
        // (A row already paved by another gore: the piece after it starts from it, so no gap opens between the two.)
        let paved: { a: XZ; b: XZ; ya: number; yb: number } | null = null;
        // (The road the piece in hand runs beside: one piece, one neighbour,
        // or that neighbour's next piece. A strip that hopped between two
        // roads would be drawn as teeth.)
        let beside = -1;
        const finish = () => {
          // (Nothing shorter than 3 m: a scrap of paving at a junction's mouth only roughens the edge there.)
          if (rows.length >= 2 && Math.hypot(rows[0].a[0] - rows[rows.length - 1].a[0], rows[0].a[1] - rows[rows.length - 1].a[1]) >= 3 && rows.some((r) => Math.hypot(r.a[0] - r.b[0], r.a[1] - r.b[1]) > 0.2)) {
            gores.push({ ring: [...rows.map((r) => r.a), ...rows.map((r) => r.b).reverse()], rows });
            gridGore(gores.length - 1);
          }
          rows = [];
        };
        const fine = walker(A);
        type Beside = { B: number; seg: number; u: number; gap: number; hb: number; x: number; z: number; s: number };
        /** This side's edge at sA along the road, and the nearest road beside it there (if any). */
        const probe = (sA: number) => {
          const l = near[Math.min(near.length - 1, Math.round((sA - s0) / STEP))];
          if (!l.length) return null;
          const pa = fine(sA);
          const nx = -pa.tz * sgn, nz = pa.tx * sgn;
          // (The road's edge exactly as it is drawn, so the strip meets it with no hairline of ground between.)
          const ha = lerp(halfAtE(A, pa.k), halfAtE(A, pa.k + 1), pa.u);
          const ea: XZ = [pa.x + nx * ha, pa.z + nz * ha];
          // The nearest road beside this edge (each pair once, from the lower-numbered road).
          let best: Beside | null = null;
          for (let q = 0; q < l.length; q += 2) {
            const B = l[q], seg = l[q + 1];
            const Q = EP[B];
            const vx = Q[seg + 1][0] - Q[seg][0], vz = Q[seg + 1][1] - Q[seg][1];
            const sl2 = vx * vx + vz * vz || 1;
            const u = Math.max(0, Math.min(1, ((ea[0] - Q[seg][0]) * vx + (ea[1] - Q[seg][1]) * vz) / sl2));
            const x = Q[seg][0] + vx * u, z = Q[seg][1] + vz * u;
            const dB2 = (ea[0] - x) * (ea[0] - x) + (ea[1] - z) * (ea[1] - z);
            // (Most are nowhere near: no need to ask how wide they are.)
            if (dB2 > far2) continue;
            const hb = lerp(halfAtE(B, seg), halfAtE(B, seg + 1), u);
            const gap = Math.sqrt(dB2) - hb;
            if (gap >= GORE || (best && gap >= best.gap)) continue;
            // (On this side of A, running with it or against it, clear of B's own junctions.)
            if ((x - pa.x) * nx + (z - pa.z) * nz <= 0) continue;
            const sl = Math.sqrt(sl2);
            if (Math.abs((vx * pa.tx + vz * pa.tz) / sl) < COS) continue;
            const s = ECUM[B][seg] + u * sl;
            if (s < (JX.trimA[B] || 0) || s > ELEN[B] - (JX.trimB[B] || 0)) continue;
            best = { B, seg, u, gap, hb, x, z, s };
          }
          const m = best as Beside | null;
          return m ? { pa, ea, m } : null;
        };
        /** The next row of the strip (or its end, where there is no road beside). */
        const take = (at: ReturnType<typeof probe>) => {
          if (!at) {
            finish();
            paved = null;
            return;
          }
          const { pa, ea, m } = at;
          const ya = roadY(A, pa.k, pa.u, pa.s, ea[0], ea[1]);
          // (B's edge facing A; where A's edge is already on B, the strip has no width.)
          const dB = Math.hypot(ea[0] - m.x, ea[1] - m.z) || 1;
          const eb: XZ = m.gap <= 0 ? ea : [m.x + ((ea[0] - m.x) / dB) * m.hb, m.z + ((ea[1] - m.z) / dB) * m.hb];
          const yb = m.gap <= 0 ? ya : roadY(m.B, m.seg, m.u, m.s, eb[0], eb[1]);
          if (Math.abs(ya - yb) > 0.25) {
            finish();
            paved = null;
            return;
          }
          const prev = rows[rows.length - 1];
          if (m.B !== beside) {
            const next = beside >= 0 && [edges[beside].a, edges[beside].b].some((j) => j === edges[m.B].a || j === edges[m.B].b);
            if (!next || !prev || Math.hypot(prev.b[0] - eb[0], prev.b[1] - eb[1]) > Math.hypot(prev.a[0] - ea[0], prev.a[1] - ea[1]) + 1) {
              finish();
              paved = null;
            }
            beside = m.B;
          }
          const row = { a: ea, b: eb, ya, yb };
          if (m.gap > 0 && inGore((ea[0] + eb[0]) / 2, (ea[1] + eb[1]) / 2)) {
            if (rows.length) rows.push(row);
            finish();
            paved = row;
            return;
          }
          if (!rows.length && paved) rows.push(paved);
          paved = null;
          rows.push(row);
          // (In pieces short enough to belong to the tile they are drawn with.)
          if (rows.length >= 48) {
            finish();
            rows.push(row);
          }
        };
        // (The 2 m steps find where a road lies beside this one; there, the rows are a metre apart.)
        let prevS = NaN;
        let prevHit = false;
        for (const sA of stations) {
          const at = probe(sA);
          if ((at || prevHit) && sA - prevS > 1.2) take(probe((prevS + sA) / 2));
          take(at);
          prevS = sA;
          prevHit = !!at;
        }
        finish();
      }
    });
  }
  // Does road `line` have a parapet beside piece kk of its middle line, off
  // metres out? Not where another road at its level, a junction's paving
  // or the paved wedge of a split lies there: all of that is road, and a
  // parapet on it would stand across the lanes. (One answer for the parapet
  // that is drawn and the one the car hits.)
  const besideMid = (line: number, kk: number, off: number): XZ => {
    const a = EP[line][kk];
    const b = EP[line][kk + 1];
    const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(a[0] + b[0]) / 2 + ((b[1] - a[1]) / tl) * off, (a[1] + b[1]) / 2 - ((b[0] - a[0]) / tl) * off];
  };
  const parapetClear = (line: number, kk: number, off: number) => {
    const [x, z] = besideMid(line, kk, off);
    const y = hasProfile[line] ? (deckY(line)[kk] + deckY(line)[kk + 1]) / 2 : NaN;
    return !coveredBy(line, x, z, y) && !onIsland(x, z) && !inPaving(x, z, y) && !inGore(x, z);
  };
  {
    const byTile = new Map<string, number[]>();
    gores.forEach((g, id) => {
      const m = g.rows[Math.floor(g.rows.length / 2)].a;
      const k = tileKey(m[0], m[1]);
      (byTile.get(k) ?? byTile.set(k, []).get(k)!).push(id);
    });
    for (const [k, all] of byTile)
      inChunks('far', k, 'gores', all, 10, (list, _kit, acc) => {
        const road = acc('road');
        for (const id of list) {
          const { rows } = gores[id];
          const base = road.pos.length / 3;
          // (A hair under the roads either side, which cover its edges.)
          for (const r of rows) {
            road.pos.push(r.a[0], r.ya + 0.087, r.a[1], r.b[0], r.yb + 0.087, r.b[1]);
            road.uv.push(r.a[0] / 6, r.a[1] / 6, r.b[0] / 6, r.b[1] / 6);
          }
          // Facing up: which side is which depends on the pair, and may
          // change along it (the wedge starts where the two still overlap,
          // its sides crossed over): each half of each piece by its own lie.
          for (let q = 0; q + 1 < rows.length; q++) {
            const a = base + q * 2;
            const V = [rows[q].a, rows[q].b, rows[q + 1].a, rows[q + 1].b];
            for (const [u, v, w] of [[0, 2, 1], [1, 2, 3]]) {
              const up = (V[v][1] - V[u][1]) * (V[w][0] - V[u][0]) - (V[v][0] - V[u][0]) * (V[w][1] - V[u][1]) >= 0;
              if (up) road.idx.push(a + u, a + v, a + w);
              else road.idx.push(a + u, a + w, a + v);
            }
          }
        }
      });
  }
  // The through road wins. At a junction, the road that carries straight on
  // (two mouths of the same road, facing each other, in line) keeps its
  // lane lines and centre line across the paving, and its edge line on any
  // side where no other road joins. It wins when no road it meets there
  // outranks it; where two through roads of equal rank cross, neither does
  // (an open box, as at a real crossroads), and nor does anyone at traffic
  // lights.
  /** A line painted across a junction: its points, and the two road ends (line * 2 + end) it joins. */
  type ThroughLine = { pts: XZ[]; kind: 'white' | 'yellow'; dashed: boolean; ends: [number, number] };
  const throughLines = new Map<number, ThroughLine[]>();
  const throughPairs: { id: number; a: number; b: number }[] = [];
  /** Road ends (line * 2 + end) that are a winning through road's mouths. */
  const throughEnds = new Set<number>();
  // Where the through road wins, every other road gives way to it: a
  // broken white line across its lanes coming in, just short of the
  // junction (Singapore drives on the left, so the left half of a two-way
  // road, seen heading in).
  const GIVE_AT = 0.7; // metres out from the mouth
  type GiveWay = { id: number; line: number; end: 0 | 1; left: XZ; dashes: XZ[] };
  const giveWays: GiveWay[] = [];
  {
    const COS30 = Math.cos((30 * Math.PI) / 180);
    const lanesOf = (i: number) => Math.max(1, Math.round((edges[i].w - 0.7) / 3.3));
    JX.shapes.forEach((sh, id) => {
      const M = sh.mouths;
      if (M.length < 3) return;
      // (Where lights and crossings rule, nobody has the right of way.)
      if (M.some((m) => crossEnd.has(`${m.line}:${m.end}`))) return;
      const cand: { a: number; b: number; lat: number; dot: number }[] = [];
      for (let a = 0; a < M.length; a++)
        for (let b = a + 1; b < M.length; b++) {
          const A = M[a], B = M[b];
          const ea = edges[A.line], eb = edges[B.line];
          if (A.line === B.line || !!ea.one !== !!eb.one) continue;
          if (!(ea.name ? ea.name === eb.name : !eb.name && ea.cls === eb.cls)) continue;
          const dot = -(A.t[0] * B.t[0] + A.t[1] * B.t[1]);
          if (dot < COS30) continue;
          // (In line: neither mouth off to one side of the other's road.)
          const dx = B.q[0] - A.q[0], dz = B.q[1] - A.q[1];
          const lat = Math.max(Math.abs(dx * A.t[1] - dz * A.t[0]), Math.abs(dx * B.t[1] - dz * B.t[0]));
          if (lat > Math.max(4, Math.min(A.half, B.half))) continue;
          cand.push({ a, b, lat, dot });
        }
      cand.sort((x, y) => x.lat - y.lat || y.dot - x.dot);
      const used = new Set<number>();
      const pairs = cand.filter((c) => !used.has(c.a) && !used.has(c.b) && (used.add(c.a), used.add(c.b), true));
      if (!pairs.length) return;
      // Pairs running the same way (the carriageways of a divided road) are
      // one axis; the busiest axis wins unless something matches its rank.
      const axes: { t: XZ; rank: number; pairs: typeof pairs }[] = [];
      for (const c of pairs) {
        const t = M[c.a].t;
        let ax = axes.find((x) => Math.abs(x.t[0] * t[0] + x.t[1] * t[1]) > COS30);
        if (!ax) axes.push((ax = { t, rank: 0, pairs: [] }));
        ax.pairs.push(c);
        ax.rank = Math.max(ax.rank, rankOf(edges[M[c.a].line].cls));
      }
      axes.sort((x, y) => y.rank - x.rank);
      const top = axes[0];
      if (axes.length > 1 && axes[1].rank >= top.rank) return;
      const onAxis = new Set(top.pairs.flatMap((c) => [c.a, c.b]));
      if (M.some((m, q) => !onAxis.has(q) && rankOf(edges[m.line].cls) > top.rank)) return;
      M.forEach((m, q) => {
        if (onAxis.has(q)) return;
        const e = edges[m.line];
        const L = ELEN[m.line];
        // Coming in: one-way roads only where they flow toward the junction.
        const inbound = e.one ? (m.end === 1 ? 2 : 0) : 1; // 2 = whole width, 1 = left half, 0 = none
        // (Not service lanes and car park roads, which carry no markings at all.)
        if (!inbound || rankOf(e.cls) < 1 || hasProfile[m.line] || JX.internal[m.line] || m.half < 2 || L < m.s + GIVE_AT + 2) return;
        const P = EP[m.line];
        const cum = ECUM[m.line];
        const sAt = m.end === 0 ? m.s + GIVE_AT : L - m.s - GIVE_AT;
        let k = 0;
        while (k < P.length - 2 && cum[k + 1] <= sAt) k++;
        const u = (sAt - cum[k]) / (cum[k + 1] - cum[k] || 1);
        const c: XZ = [lerp(P[k][0], P[k + 1][0], u), lerp(P[k][1], P[k + 1][1], u)];
        const left: XZ = [-m.t[1], m.t[0]]; // left of a car heading in (along -t)
        const w = m.half - 0.4;
        // Dashes 0.6 m long, 0.3 m apart.
        const dashes: XZ[] = [];
        for (let o = (inbound === 2 ? -w : 0.15) + 0.3; o + 0.3 <= w; o += 0.9) dashes.push([c[0] + left[0] * o, c[1] + left[1] * o]);
        // (Only a whole line, on this road's own open surface.)
        if (dashes.length < 2 || dashes.some(([x, z]) => coveredBy(m.line, x, z, NaN) || onIsland(x, z) || inPaving(x, z, NaN))) return;
        giveWays.push({ id, line: m.line, end: m.end, left, dashes });
      });
      const lines: ThroughLine[] = [];
      // (A road on the ground that is no part of this junction, yet lies
      // over it: a slip road merging in alongside.)
      const own = new Set([...M.map((m) => m.line), ...sh.internal]);
      const foreign = (x: number, z: number) => {
        let hit = false;
        roads.each(x, z, 16, (i, seg, _u, d) => {
          if (!hit && !own.has(i) && !elevated[i] && d <= Math.max(halfAtE(i, seg), halfAtE(i, seg + 1)) + 0.2) hit = true;
        });
        return hit;
      };
      for (const c of top.pairs) {
        const A = M[c.a], B = M[c.b];
        const ea = edges[A.line], eb = edges[B.line];
        throughPairs.push({ id, a: c.a, b: c.b });
        throughEnds.add(A.line * 2 + A.end).add(B.line * 2 + B.end);
        // The way across: a smooth curve from mouth to mouth, a point a metre.
        const L = Math.hypot(B.q[0] - A.q[0], B.q[1] - A.q[1]);
        if (L < 2) continue;
        const N = Math.max(2, Math.ceil(L));
        const centre: XZ[] = [];
        const normal: XZ[] = [];
        for (let k = 0; k <= N; k++) {
          const u = k / N;
          const h00 = 2 * u * u * u - 3 * u * u + 1, h10 = u * u * u - 2 * u * u + u, h01 = -2 * u * u * u + 3 * u * u, h11 = u * u * u - u * u;
          centre.push([h00 * A.q[0] - h10 * L * A.t[0] + h01 * B.q[0] + h11 * L * B.t[0], h00 * A.q[1] - h10 * L * A.t[1] + h01 * B.q[1] + h11 * L * B.t[1]]);
        }
        for (let k = 0; k <= N; k++) {
          const p = centre[Math.max(0, k - 1)], q = centre[Math.min(N, k + 1)];
          const [tx, tz] = unit(q[0] - p[0], q[1] - p[1]);
          normal.push([tz, -tx]); // to the left of the way across
        }
        /** A line running from offset oa (at A) to ob (at B), leftward positive. */
        const line = (oa: number, ob: number, kind: 'white' | 'yellow', dashed: boolean) => {
          const pts = centre.map((p, k) => [p[0] + normal[k][0] * lerp(oa, ob, k / N), p[1] + normal[k][1] * lerp(oa, ob, k / N)] as XZ);
          // (Only a line that lies on this junction's paving all the way,
          // clear of any island and of any road merging in alongside: no
          // half lines, and none across another road's lane.)
          if (pts.every((p, k) => k === 0 || k === N || (inRingXZ(sh.ring, p[0], p[1]) && !onIsland(p[0], p[1]) && !foreign(p[0], p[1])))) lines.push({ kind, dashed, pts, ends: [A.line * 2 + A.end, B.line * 2 + B.end] });
        };
        // (Each road's offsets are counted along itself, a to b: turned
        // round where it runs against the way across.)
        const sa = A.end === 1 ? 1 : -1, sb = B.end === 0 ? 1 : -1;
        const rank = Math.min(rankOf(ea.cls), rankOf(eb.cls));
        if (ea.one) {
          const offs = (m: typeof A, i: number, sg: number) => {
            const n = lanesOf(i), w = (2 * EHALF[i]) / n;
            const cum = ECUM[i];
            const out: number[] = [];
            for (let l = 1; l < n; l++) {
              // (Only a lane line the road itself has there: where it
              // narrows, its nearside lane's line has already ended.)
              let ok = 2 * m.half - l * w > 0.6 * w;
              for (let k = 0; ok && k < cum.length; k++) {
                const s = m.end === 0 ? cum[k] : ELEN[i] - cum[k];
                if (s > m.s - 4 && s < m.s + 20 && 2 * halfAtE(i, k) - l * w <= 0.6 * w) ok = false;
              }
              if (ok) out.push(sg * (-m.half + l * w));
            }
            return out.sort((x, y) => x - y);
          };
          let oa = offs(A, A.line, sa), ob = offs(B, B.line, sb);
          const swap = oa.length > ob.length;
          if (swap) [oa, ob] = [ob, oa];
          // (A lane more on one side: the lines that match up best carry on.)
          let best = 0, cost = Infinity;
          for (let sh2 = 0; sh2 + oa.length <= ob.length; sh2++) {
            const t = oa.reduce((sum, o, k) => sum + Math.abs(o - ob[k + sh2]), 0);
            if (t < cost) (cost = t), (best = sh2);
          }
          if (rank >= 1) oa.forEach((o, k) => (swap ? line(ob[k + best], o, 'white', true) : line(o, ob[k + best], 'white', true)));
        } else if (rank >= 1 && ea.w >= 6 && eb.w >= 6) line(0, 0, 'white', rank < 3);
        if (rank >= 2) {
          // Edge lines, on a side no other road joins from.
          const [dx, dz] = unit(B.q[0] - A.q[0], B.q[1] - A.q[1]);
          for (const side of [1, -1]) {
            const open = M.some((m, q) => q !== c.a && q !== c.b && ((m.q[0] - A.q[0]) * dz - (m.q[1] - A.q[1]) * dx) * side > 0);
            if (!open) line(side * (A.half - 0.35), side * (B.half - 0.35), 'yellow', false);
          }
        }
      }
      if (lines.length) throughLines.set(id, lines);
    });
  }
  /** How far from each end of a road its markings stop: at a junction's edge (or a crossing's stop line); they run on through a bend. */
  const markStops = (line: number): [number, number] => {
    const e = edges[line];
    const stopAt = (j: number, trim: number) => (trim > 0 ? trim + 1 : jDegree[j] === 2 ? 0.3 : jDegree[j] > 2 ? jRadius[j] + 2 : 2);
    return [
      crossEnd.has(`${line}:0`) ? JX.trimA[line] + STOP_AT + 0.5 : stopAt(e.a, JX.trimA[line]),
      crossEnd.has(`${line}:1`) ? JX.trimB[line] + STOP_AT + 0.5 : stopAt(e.b, JX.trimB[line]),
    ];
  };
  const roadRuns = runsOf(EP);
  // A run is drawn a few pieces at a time, each its own build slice: by
  // ramps and flyovers, where working out the ground takes longest, 2 road
  // pieces (about 8 m) to a slice; elsewhere 24. (r0 to r1 is the whole
  // run in the tile, k0 to k1 the part drawn in this slice.)
  const inSlices = (all: { line: number; k0: number; k1: number }[]) => {
    const out: { line: number; r0: number; r1: number; k0: number; k1: number }[] = [];
    for (const { line, k0, k1 } of all) {
      let ramp = false;
      for (let k = k0; k <= k1 && !ramp; k++) ramp = nearRamp(EP[line][k][0], EP[line][k][1]);
      const n = ramp ? 2 : 24;
      for (let a = k0; a < k1; a += n) out.push({ line, r0: k0, r1: k1, k0: a, k1: Math.min(k1, a + n) });
    }
    return out;
  };
  for (const [k, all] of roadRuns)
    inChunks('far', k, 'roads', inSlices(all), 1, (list, _kit, acc) => {
      const road = acc('road');
      const kerb = acc('kerb');
      const white = acc('white');
      const yellow = acc('yellow');
      for (const { line, r0, r1, k0, k1 } of list) {
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
        const clearOn = (Q: XZ[]) => (kk: number, off: number) => {
          const a = Q[kk];
          const b = Q[kk + 1];
          const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          const x = (a[0] + b[0]) / 2 + ((b[1] - a[1]) / tl) * off;
          const z = (a[1] + b[1]) / 2 - ((b[0] - a[0]) / tl) * off;
          const y = dy ? lerp(dy[kk], dy[kk + 1], 0.5) : NaN;
          return !coveredBy(line, x, z, y) && !onIsland(x, z) && !inPaving(x, z, y);
        };
        const clear = clearOn(pts);
        if (dy && !isDeck[line]) {
          // A raised road: where the ground beside it falls away (its bank
          // was cut short by a road below), a retaining wall, and a parapet
          // where the drop is more than a kerb.
          const deck = acc('deck');
          for (const sgn of [-1, 1]) {
            const off = (kk: number) => sgn * (halfAt(kk) + 0.45);
            const dr = new Float32Array(hi - lo + 1);
            // (The way the road runs at each point looks along the whole
            // run in this tile, not just the part drawn in this slice.)
            const rlo = Math.max(r0, cut.lo);
            const rhi = Math.min(r1, cut.hi);
            for (let kk = lo; kk <= hi; kk++) {
              const a = P[Math.max(rlo, kk - 1)];
              const b = P[Math.min(rhi, kk + 1)];
              const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
              const o = off(kk) + sgn * 0.6;
              dr[kk - lo] = dy[kk] + 0.09 - heightAt(P[kk][0] + ((b[1] - a[1]) / tl) * o, P[kk][1] - ((b[0] - a[0]) / tl) * o);
            }
            const y = (kk: number) => dy[kk] + 0.09;
            band(deck, P, cum, lo, hi, off, y, (kk) => Math.max(0, dr[kk - lo]) + 0.3, 0.05, (kk) => Math.max(dr[kk - lo], dr[kk + 1 - lo]) > 0.15 && !inGore(...besideMid(line, kk, off(kk))) && !inGore(...besideMid(line, kk, off(kk) - sgn * 0.3)));
            band(deck, P, cum, lo, hi, off, y, 0, 0.95, (kk) => Math.min(dr[kk - lo], dr[kk + 1 - lo]) > 1.2 && parapetClear(line, kk, off(kk)));
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
            band(deck, pts, cum, k0, k1, side(sgn), y, 0, 0.95, (kk) => parapetClear(line, kk, side(sgn)(kk)));
          }
          strip(deck, pts, cum, k0, k1, (kk) => halfAt(kk) + 0.45, 0.09 - depth, { yAt });
        }
        // (The through road's lines run right up to the junction's edge,
        // where they carry on across it.)
        const thA = throughEnds.has(line * 2) && JX.trimA[line] > 0;
        const thB = throughEnds.has(line * 2 + 1) && JX.trimB[line] > 0;
        if (rank < 1 || (len < 12 && !thA && !thB) || JX.internal[line]) continue;
        const [ca, cb] = markStops(line);
        const ends = (kk: number) => (thA ? kk >= cut.lo : cum[kk] > ca) && (thB ? kk < cut.hi : cum[kk + 1] < len - cb);
        // (A line's corners on the mouth itself touch the paving: let them.)
        const onMouth = (x: number, z: number, m: number, n: number) => {
          const dx = P[n][0] - P[m][0], dz = P[n][1] - P[m][1];
          return Math.hypot(x - P[m][0], z - P[m][1]) < halfAt(m) + 0.5 && Math.abs((x - P[m][0]) * dx + (z - P[m][1]) * dz) < 0.3 * Math.hypot(dx, dz);
        };
        const atMouth = (x: number, z: number) => (thA && onMouth(x, z, cut.lo, cut.lo + 1)) || (thB && onMouth(x, z, cut.hi, cut.hi - 1));
        const lineClear = (x: number, y: number, z: number) => atMouth(x, z) || (!inPaving(x, z, dy ? y : NaN) && !coveredBy(line, x, z, dy ? y : NaN));
        const mp = thA || thB ? P : pts;
        const mo = thA || thB ? { lo: cut.lo, hi: cut.hi } : {};
        const clearM = thA || thB ? clearOn(P) : clear;
        const solid = (off: (kk: number) => number) => (kk: number) => ends(kk) && clearM(kk, off(kk));
        const dashed = (off: (kk: number) => number) => (kk: number) => kk % 3 === 0 && ends(kk) && clearM(kk, off(kk));
        if (rank >= 2) {
          const l = (kk: number) => halfAt(kk) - 0.35;
          const r = (kk: number) => -(halfAt(kk) - 0.35);
          strip(yellow, mp, cum, k0, k1, 0.07, 0.11, { ...mo, off: l, keep: solid(l), yAt, tilt, clearAt: lineClear });
          strip(yellow, mp, cum, k0, k1, 0.07, 0.11, { ...mo, off: r, keep: solid(r), yAt, tilt, clearAt: lineClear });
        }
        const lanes = Math.max(1, Math.round((e.w - 0.7) / 3.3));
        if (e.one) {
          // Lane lines follow the lanes: each a full lane's width from the
          // last, counted from the right-hand (fast) side, so where the
          // road tapers the lines run on straight and the nearside lane
          // narrows until its line ends (a lane dropped, or one added),
          // rather than every lane squeezing.
          const laneW = (2 * EHALF[line]) / lanes;
          for (let l = 1; l < lanes; l++) {
            const off = (kk: number) => -halfAt(kk) + l * laneW;
            const room = (kk: number) => halfAt(kk) - off(kk) > 0.6 * laneW && halfAt(kk + 1) - off(kk + 1) > 0.6 * laneW;
            strip(white, mp, cum, k0, k1, 0.07, 0.11, { ...mo, off, keep: (kk) => room(kk) && dashed(off)(kk), yAt, tilt, clearAt: lineClear });
          }
        } else if (rank >= 1 && e.w >= 6) {
          const off = () => 0;
          strip(white, mp, cum, k0, k1, 0.07, 0.11, { ...mo, keep: rank >= 3 ? solid(off) : dashed(off), yAt, tilt, clearAt: lineClear });
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
    onTile('far', k, 'deck sides', (kit) => {
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
    // (A run's parapets a few pieces to a slice; its piers with the first.)
    const pieces: { line: number; k0: number; k1: number; a: number; b: number }[] = [];
    for (const { line, k0, k1 } of list) for (let a = k0; a < k1; a += 6) pieces.push({ line, k0, k1, a, b: Math.min(k1, a + 6) });
    inChunks('near', k, 'deck barriers', pieces, 1, (part, kit) => {
      const body = tileBody(kit);
      for (const { line, k0, k1, a: from, b: to } of part) {
        const pts = EP[line];
        const dy = deckY(line);
        const cum = ECUM[line];
        const len = ELEN[line];
        const half = EHALF[line];
        const ha = jDegree[edges[line].a] === 2 ? (jHalf2[edges[line].a](line) - half) / 2 : 0;
        const hb = jDegree[edges[line].b] === 2 ? (jHalf2[edges[line].b](line) - half) / 2 : 0;
        const halfAt = (kk: number) => half + ha * (1 - smoothstep(0, 16, cum[kk])) + hb * (1 - smoothstep(0, 16, len - cum[kk])) + 0.45;
        // Parapets you can lean on (none where another deck joins).
        for (let kk = from; kk < to; kk++) {
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
            if (coveredBy(line, mx + dz * sgn * 0.6, mz - dx * sgn * 0.6, y) || !parapetClear(line, kk, sgn * (halfAtE(line, kk) + halfAtE(line, kk + 1)) / 2 + sgn * 0.45)) continue;
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
        if (from === k0) pillarsOf(line, k0, k1, (x, z, top, foot, yaw) => {
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
  const slipJoint = new Set(JX.why.filter((w) => w.why === 'slip').flatMap((w) => w.nodes));
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
    inChunks('far', k, 'pads', all, 10, (list, _kit, acc) => {
      const road = acc('road');
      for (const j of list) {
        const [x, z] = M.junctions[j];
        const r = jDegree[j] === 2 ? (EHALF[jEdges[j][0]] + EHALF[jEdges[j][1]]) / 2 : jRadius[j];
        const y = padY(j);
        // (No kerb round it: the roads' own kerbs run up to the joint, and a
        // ring would only cross the road as a lip.)
        // A slip road's joint left plain is paved only between its roads'
        // own ends: a disc as wide as the widest of them would stand out
        // past the edges of the others.
        if (slipJoint.has(j)) {
          const ends: XZ[] = [];
          for (const i of jEdges[j]) {
            const atA = edges[i].a === j;
            const P = EP[i];
            const k = atA ? 0 : P.length - 1;
            const q = atA ? 1 : P.length - 2;
            const l = Math.hypot(P[q][0] - P[k][0], P[q][1] - P[k][1]) || 1;
            const h = halfAtE(i, k);
            const nx = (-(P[q][1] - P[k][1]) / l) * h, nz = ((P[q][0] - P[k][0]) / l) * h;
            ends.push([x + nx, z + nz], [x - nx, z - nz]);
          }
          const ring = convexHull(ends);
          let area = 0;
          ring.forEach((a, m) => {
            const b = ring[(m + 1) % ring.length];
            area += (a[0] - x) * (b[1] - z) - (a[1] - z) * (b[0] - x);
          });
          if (ring.length >= 3 && area !== 0) {
            padOver(road, x, z, area > 0 ? ring : ring.reverse(), 0.09, y);
            continue;
          }
        }
        disc(road, x, z, r, 0.09, y);
      }
    });
  /** The height of junction id's drawn paving at (x, z): its mesh, not the smooth surface it samples. */
  const paveY = (id: number, x: number, z: number) => {
    const sh = JPOLY[id];
    const [cx, cz] = sh.centre;
    const ring = sh.ring;
    const n = ring.length;
    const at = (P: XZ, t: number) => jTop(id, cx + (P[0] - cx) * t, cz + (P[1] - cz) * t);
    for (let i = 0; i < n; i++) {
      const P = ring[i], Q = ring[(i + 1) % n];
      const px = P[0] - cx, pz = P[1] - cz, qx = Q[0] - cx, qz = Q[1] - cz;
      const det = px * qz - pz * qx;
      if (Math.abs(det) < 1e-9) continue;
      const u = ((x - cx) * qz - (z - cz) * qx) / det;
      const v = (px * (z - cz) - pz * (x - cx)) / det;
      if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
      const t = u + v;
      if (t <= 1 / 3) return (1 - 3 * t) * jTop(id, cx, cz) + 3 * u * at(P, 1 / 3) + 3 * v * at(Q, 1 / 3);
      const ta = t <= 2 / 3 ? 1 / 3 : 2 / 3, tb = ta + 1 / 3;
      // (The band's quad is cut corner to corner: inner P to outer Q.)
      // In (u, v): Pa (ta, 0), Qa (0, ta), Pb (tb, 0), Qb (0, tb).
      const w = (u + v - ta) / (tb - ta); // 0 on the inner edge, 1 on the outer
      // Triangle Pa, Qa, Qb holds the points with u <= ta * (1 - w).
      if (u <= ta * (1 - w) + 1e-9) {
        const a = u / ta, c = w, b = 1 - a - c;
        return a * at(P, ta) + b * at(Q, ta) + c * at(Q, tb);
      }
      // Triangle Pa, Qb, Pb.
      const cq = v / tb, rest = 1 - cq;
      const bpb = (u - ta * rest) / (tb - ta), apa = rest - bpb;
      return apa * at(P, ta) + cq * at(Q, tb) + bpb * at(P, tb);
    }
    return jTop(id, x, z);
  };
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
    // (Each junction in three slices: its lines, its paving, its kerbs.)
    inChunks('far', k, 'junctions', all.flatMap((id) => [0, 1, 2].map((part) => ({ id, part }))), 1, (list, _kit, acc) => {
      const road = acc('road');
      const kerb = acc('kerb');
      for (const { id, part } of list) {
        // The through road's lines, on the paving.
        if (part === 0) for (const ln of throughLines.get(id) ?? []) {
          const into = acc(ln.kind);
          const ring = JPOLY[id].ring;
          const base = into.pos.length / 3;
          const ok: boolean[] = [];
          let run = 0;
          ln.pts.forEach((p, k) => {
            const a = ln.pts[Math.max(0, k - 1)], b = ln.pts[Math.min(ln.pts.length - 1, k + 1)];
            const [tx, tz] = unit(b[0] - a[0], b[1] - a[1]);
            if (k) run += Math.hypot(p[0] - ln.pts[k - 1][0], p[1] - ln.pts[k - 1][1]);
            ok.push((k === 0 || k === ln.pts.length - 1 || inRingXZ(ring, p[0], p[1])) && (!ln.dashed || Math.floor(run / 4) % 3 === 0));
            for (const o of [-0.07, 0.07]) {
              const x = p[0] + tz * o, z = p[1] - tx * o;
              into.pos.push(x, paveY(id, x, z) + 0.11, z);
              into.uv.push(x / 6, z / 6);
            }
          });
          for (let k = 0; k + 1 < ln.pts.length; k++) {
            if (!ok[k] || !ok[k + 1]) continue;
            const q = base + k * 2;
            into.idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
          }
        }
        const sh = JPOLY[id];
        // Islands sit a hair under the roads round them.
        const lift = sh.fill ? 0.085 : 0.09;
        const [cx, cz] = sh.centre;
        const ring = sh.ring;
        const n = ring.length;
        const surfY = (x: number, z: number) => jTop(id, x, z);
        if (part === 1) {
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
        }
        if (part === 2) for (const F of sh.kerbs) {
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
            faceUp(kerb, a, a + 2, a + 1);
            faceUp(kerb, a + 1, a + 2, a + 3);
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
    onTile('far', k, 'crossings', (_kit, acc) => {
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
  // Give-way lines.
  {
    const byTile = new Map<string, GiveWay[]>();
    for (const g of giveWays) {
      const k = tileKey(g.dashes[0][0], g.dashes[0][1]);
      (byTile.get(k) ?? byTile.set(k, []).get(k)!).push(g);
    }
    for (const [k, list] of byTile)
      onTile('far', k, 'give-way lines', (_kit, acc) => {
        const white = acc('white');
        for (const g of list) for (const [x, z] of g.dashes) quad(white, x, z, g.left, 0.3, 0.15, 0.115);
      });
  }
  // Traffic lights: a pole on the left kerb, its lamps facing the traffic
  // coming in. The lamps of each direction share three materials, switched
  // in update().
  const lamp = (hex: number) => new THREE.MeshStandardMaterial({ color: 0x1a1a1a, emissive: hex, emissiveIntensity: 0.05, roughness: 0.5 });
  const LAMPS = [0, 1].map(() => [lamp(0xff2a1a), lamp(0xffa21a), lamp(0x2aff6a)]);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3b3f44, roughness: 0.7 });
  for (const [k, list] of crossByTile)
    onTile('near', k, 'traffic lights', (kit) => {
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
  // Footbridges over roads. A path OSM marks as a bridge, crossing a road on
  // the ground, is lifted FOOT_H above the highest road or ground beneath
  // it (bridge pieces joined end to end share one height), on piers that
  // stand clear of the roads, with stairs down at each open end. (Left on
  // the ground where a flyover would be in its way.)
  const FOOT_H = 5.5;
  const footTop = new Float32Array(paths.length).fill(NaN);
  const footPiers: { x: number; z: number; top: number; foot: number; line: number }[] = [];
  const footStairs: { x0: number; z0: number; x1: number; z1: number; top: number; foot: number; line: number }[] = [];
  {
    const ids: number[] = [];
    paths.forEach((p, i) => p.b && p.pts.length > 1 && ids.push(i));
    const parent = new Map<number, number>(ids.map((i) => [i, i]));
    const find = (i: number): number => (parent.get(i) === i ? i : (parent.set(i, find(parent.get(i)!)), parent.get(i)!));
    const endKey = (p: XZ) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;
    const atEnd = new Map<string, number[]>();
    for (const i of ids)
      for (const p of [paths[i].pts[0], paths[i].pts[paths[i].pts.length - 1]]) {
        const l = atEnd.get(endKey(p)) ?? atEnd.set(endKey(p), []).get(endKey(p))!;
        for (const o of l) parent.set(find(o), find(i));
        l.push(i);
      }
    const groups = new Map<number, number[]>();
    for (const i of ids) (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(i);
    /** Is a strip from (x, z), `top` high, clear of every road below it? */
    const offRoads = (x: number, z: number, top: number, margin: number) => {
      let ok = true;
      roads.each(x, z, 24, (i, seg, u, d) => {
        if (!ok || d > EHALF[i] + margin) return;
        if ((hasProfile[i] ? deckAtHit(i, seg, u) : heightAt(x, z)) < top + 1) ok = false;
      });
      return ok;
    };
    for (const list of groups.values()) {
      let base = -Infinity;
      let crosses = false;
      const above: number[] = [];
      for (const i of list)
        for (const [x, z] of paths[i].pts) {
          base = Math.max(base, heightAt(x, z));
          roads.each(x, z, 24, (r, seg, u, d) => {
            if (d > EHALF[r] + PHALF[i]) return;
            if (elevated[r]) return void above.push(deckAtHit(r, seg, u));
            crosses = true;
            if (hasProfile[r]) base = Math.max(base, deckAtHit(r, seg, u));
          });
        }
      if (!crosses) continue;
      const top = base + FOOT_H;
      // (A flyover across its way: under it with room to walk, or not at all.)
      if (above.some((y) => y < top + 3.5)) continue;
      for (const i of list) footTop[i] = top;
      for (const i of list) {
        const pts = paths[i].pts;
        const n = pts.length;
        // Piers, about 14 m apart, where the ground below is free.
        let since = Infinity;
        for (let k = 0; k < n; k++) {
          since += k ? Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]) : 0;
          if (since < 14 && k !== n - 1) continue;
          const [x, z] = pts[k];
          if (!offRoads(x, z, top, 0.9)) continue;
          if (footPiers.some((q) => Math.hypot(q.x - x, q.z - z) < 3)) continue;
          footPiers.push({ x, z, top, foot: heightAt(x, z), line: i });
          since = 0;
        }
        // Stairs at each end no other bridge piece carries on from: along
        // the roadside one way or the other, or straight on, whichever
        // comes down clear of the roads.
        for (const end of [0, 1]) {
          const p = end ? pts[n - 1] : pts[0];
          if ((atEnd.get(endKey(p)) ?? []).length > 1) continue;
          const q = end ? pts[n - 2] : pts[1];
          const l = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
          const dx = (p[0] - q[0]) / l, dz = (p[1] - q[1]) / l;
          for (const [sx, sz] of [[dx, dz], [dz, -dx], [-dz, dx]]) {
            const run = (top - heightAt(p[0], p[1])) * 1.8;
            let ok = true;
            for (let t = 0; t <= run + 1 && ok; t += 1.5) ok = offRoads(p[0] + sx * t, p[1] + sz * t, top, 1.4);
            if (!ok) continue;
            const x1 = p[0] + sx * run, z1 = p[1] + sz * run;
            footStairs.push({ x0: p[0], z0: p[1], x1, z1, top, foot: heightAt(x1, z1), line: i });
            break;
          }
        }
      }
    }
  }
  // Footbridges: where a path crosses a canal, pond or the sea, its deck runs
  // level from bank to bank (NaN = on the ground). One over a road is level at its
  // lifted height.
  const deckCache = new Map<number, Float32Array>();
  const pathDeck = (line: number) => {
    let d = deckCache.get(line);
    if (d) return d;
    const pts = paths[line].pts;
    if (footTop[line] === footTop[line]) {
      d = new Float32Array(pts.length).fill(footTop[line]);
      deckCache.set(line, d);
      return d;
    }
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
  // (A long path, like a road, is drawn 12 pieces to a slice.)
  const pathSlices = (all: { line: number; k0: number; k1: number }[]) => all.flatMap(({ line, k0, k1 }) => Array.from({ length: Math.ceil((k1 - k0) / 12) }, (_, n) => ({ line, k0: k0 + n * 12, k1: Math.min(k1, k0 + n * 12 + 12) })));
  for (const [k, all] of runsOf(paths.map((p) => p.pts)))
    inChunks('far', k, 'paths', pathSlices(all), 1, (list, _kit, acc) => {
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
        // (Seen from the road below: its underside.)
        if (footTop[line] === footTop[line]) strip(acc('deck'), pa.pts, PCUM[line], k0, k1, PHALF[line] + 0.05, lift - 0.35, { yAt });
      }
      // Footbridge piers and stairs.
      const mine = new Set(list.filter(({ k0 }) => k0 === 0).map(({ line }) => line));
      const parts: THREE.BufferGeometry[] = [];
      for (const q of footPiers) {
        if (!mine.has(q.line) || q.top - q.foot < 2) continue;
        const h = q.top - 0.3 - q.foot + 0.5;
        parts.push(new THREE.BoxGeometry(0.6, h, 0.6).translate(q.x, q.foot - 0.5 + h / 2, q.z));
      }
      for (const st of footStairs) {
        if (!mine.has(st.line)) continue;
        const run = Math.hypot(st.x1 - st.x0, st.z1 - st.z0);
        const drop = st.top - st.foot;
        const len = Math.hypot(run, drop);
        const yaw = Math.atan2(-(st.z1 - st.z0), st.x1 - st.x0);
        const place = (g: THREE.BufferGeometry) =>
          g.rotateZ(-Math.atan2(drop, run)).rotateY(yaw).translate((st.x0 + st.x1) / 2, (st.top + st.foot) / 2, (st.z0 + st.z1) / 2);
        parts.push(place(new THREE.BoxGeometry(len, 0.3, 2.2).translate(0, -0.1, 0)));
        for (const sgn of [-1, 1]) parts.push(place(new THREE.BoxGeometry(len, 0.9, 0.1).translate(0, 0.5, sgn * 1.05)));
        // A landing under the top step, on its own post.
        parts.push(new THREE.BoxGeometry(2.4, 0.3, 2.4).translate(st.x0, st.top - 0.1, st.z0));
      }
      if (parts.length) {
        const m = new THREE.Mesh(_kit.own(mergeGeometries(parts)), concreteMat);
        m.castShadow = true;
        m.receiveShadow = true;
        _kit.add(m);
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
    onTile('horizon', k, 'ponds', (kit) => {
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
    onTile('horizon', k, 'canals', (kit) => {
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
  /** (open: the clear height of a ground floor left open on columns, 0 where the walls come down to the ground; posts: its columns.) */
  interface Bld { pts: XZ[]; h: number; wall: number; roof: number; walls: boolean; base: number; ground: number; open: number; posts: XZ[] }
  const UNDER_DECK = 1; // clear space between a roof and the deck above it
  /** Surely more than a few metres from every road? (From the land-use raster: quick. Beyond the raster, never.) */
  const farFromRoads = (x: number, z: number) => {
    const i = Math.floor((x - WB.minX) / G), j = Math.floor((z - WB.minZ) / G);
    return i >= 0 && j >= 0 && i < RW && j < RH && !(code[j * RW + i] & NEAR_ROAD);
  };
  /**
   * The highest a roof may stand within this outline: a metre under the
   * lowest deck that passes over it (-Infinity under a road on a bank;
   * Infinity where no raised road passes over).
   */
  const roomUnderRoads = (pts: XZ[], cx: number, cz: number) => {
    let room = Infinity;
    const look = (x: number, z: number) =>
      !farFromRoads(x, z) &&
      roads.each(x, z, 16, (i, seg, u, d) => {
        if (!hasProfile[i] || d > Math.max(halfAtE(i, seg), halfAtE(i, seg + 1)) + 0.45 + UNDER_DECK) return;
        room = Math.min(room, isDeck[i] ? deckAtHit(i, seg, u) - (elevated[i] ? 1.2 : 0.6) - UNDER_DECK : -Infinity);
      });
    // Along the walls, and over the floor on a 4 m grid.
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    pts.forEach((p, q) => {
      const n = pts[(q + 1) % pts.length];
      const steps = Math.max(1, Math.ceil(Math.hypot(n[0] - p[0], n[1] - p[1]) / 3));
      for (let k = 0; k < steps; k++) look(lerp(p[0], n[0], k / steps), lerp(p[1], n[1], k / steps));
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      z0 = Math.min(z0, p[1]);
      z1 = Math.max(z1, p[1]);
    });
    look(cx, cz);
    for (let x = x0 + 2; x < x1; x += 4) for (let z = z0 + 2; z < z1; z += 4) if (inRingXZ(pts, x, z)) look(x, z);
    return room;
  };
  // A road on the ground has right of way too. Where one runs through a
  // building (a drive into a car park, a lane under a block), the
  // building's ground floor is left open, on columns, like an HDB void
  // deck: no wall the car can meet. Where a road only clips a building
  // (the two outlines overlapping by a metre or two), the building is cut
  // back from the road instead.
  const VOID_H = 4.5; // clear height of an open ground floor
  const ROAD_CLEAR = 0.45 + 0.3; // a road's kerb, and a little more
  /** The ground road whose surface (out to `extra` beyond its edge) reaches (x, z) deepest: how deep, the nearest point of its middle line and its direction there. */
  const roadOver = (x: number, z: number, extra: number) => {
    type Over = { dep: number; ax: number; az: number; tx: number; tz: number; end: number };
    let best: Over | null = null;
    if (farFromRoads(x, z)) return null;
    roads.each(x, z, 16, (i, seg, u, d) => {
      if (hasProfile[i]) return; // (raised roads: see roomUnderRoads)
      const dep = Math.max(halfAtE(i, seg), halfAtE(i, seg + 1)) + extra - d;
      if (dep <= 0 || (best && best.dep >= dep)) return;
      const P = EP[i];
      const l = Math.hypot(P[seg + 1][0] - P[seg][0], P[seg + 1][1] - P[seg][1]) || 1;
      // (end: beyond the road's first point (-1) or its last (1).)
      const end = seg === 0 && u <= 1e-3 ? -1 : seg === P.length - 2 && u >= 1 - 1e-3 ? 1 : 0;
      best = { dep, ax: lerp(P[seg][0], P[seg + 1][0], u), az: lerp(P[seg][1], P[seg + 1][1], u), tx: (P[seg + 1][0] - P[seg][0]) / l, tz: (P[seg + 1][1] - P[seg][1]) / l, end };
    });
    return best as Over | null;
  };
  /** Metres of ground road (its middle line) inside each building of the map. */
  const roadThrough = new Float32Array(M.buildings.length);
  {
    const C = 48;
    const grid = new Map<number, number[]>();
    const box = M.buildings.map((b, id) => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const p of b.pts) {
        x0 = Math.min(x0, p[0]);
        x1 = Math.max(x1, p[0]);
        z0 = Math.min(z0, p[1]);
        z1 = Math.max(z1, p[1]);
      }
      if (!SKIP.has(b.k) && b.k !== 'roof' && b.pts.length >= 3)
        for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++)
          for (let j = Math.floor(z0 / C); j <= Math.floor(z1 / C); j++) {
            const k = i * 100003 + j;
            (grid.get(k) ?? grid.set(k, []).get(k)!).push(id);
          }
      return [x0, x1, z0, z1];
    });
    edges.forEach((_e, i) => {
      if (hasProfile[i]) return;
      const P = EP[i];
      for (let k = 0; k + 1 < P.length; k++) {
        const l = Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]);
        const n = Math.max(1, Math.round(l));
        for (let q = 0; q < n; q++) {
          const x = lerp(P[k][0], P[k + 1][0], (q + 0.5) / n), z = lerp(P[k][1], P[k + 1][1], (q + 0.5) / n);
          const cellIds = grid.get(Math.floor(x / C) * 100003 + Math.floor(z / C));
          if (!cellIds) continue;
          for (const id of cellIds) {
            const bx = box[id];
            if (x < bx[0] || x > bx[1] || z < bx[2] || z > bx[3] || !inRingXZ(M.buildings[id].pts, x, z)) continue;
            roadThrough[id] += l / n;
          }
        }
      }
    });
  }
  /**
   * A building's outline cut back from the ground roads that clip it: the
   * same outline where none does, null where it cannot be cut clear (a
   * road still crosses it, or too little would be left).
   */
  const cutBack = (pts: XZ[], cx: number, cz: number): XZ[] | null => {
    // (Walls in pieces of 2 m or less, so a wall alongside a road moves back whole.)
    let P: XZ[] = [];
    pts.forEach((p, q) => {
      const n = pts[(q + 1) % pts.length];
      const steps = Math.max(1, Math.ceil(Math.hypot(n[0] - p[0], n[1] - p[1]) / 2));
      for (let k = 0; k < steps; k++) P.push([lerp(p[0], n[0], k / steps), lerp(p[1], n[1], k / steps)]);
    });
    if (!P.some((p) => roadOver(p[0], p[1], ROAD_CLEAR))) return pts;
    /** p moved clear of the road it is on, if any. */
    const clear = (p: XZ): XZ => {
      const r = roadOver(p[0], p[1], ROAD_CLEAR);
      if (!r) return p;
      const d = Math.hypot(p[0] - r.ax, p[1] - r.az);
      // Round the end of a road that stops at the building (a drive up
      // to its door): on past the end, the wall set back in a bay.
      if (r.end) {
        const fx = r.tx * r.end, fz = r.tz * r.end;
        const reach = r.dep + d + 0.02;
        const lat = (p[0] - r.ax) * -fz + (p[1] - r.az) * fx;
        const fwd = Math.sqrt(Math.max(0, reach * reach - lat * lat));
        return [r.ax - fz * lat + fx * fwd, r.az + fx * lat + fz * fwd];
      }
      // Out to the road's edge, on the side the building stands.
      const side = (cx - r.ax) * -r.tz + (cz - r.az) * r.tx >= 0 ? 1 : -1;
      const nx = -r.tz * side, nz = r.tx * side;
      const move = r.dep + d - ((p[0] - r.ax) * nx + (p[1] - r.az) * nz) + 0.02;
      return [p[0] + nx * move, p[1] + nz * move];
    };
    for (let pass = 0; pass < 3; pass++) P = P.map(clear);
    // (Points pushed together are one corner.)
    let out: XZ[] = [];
    for (const p of P) {
      const last = out[out.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.3) out.push(p);
    }
    while (out.length > 3 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 0.3) out.pop();
    if (out.length < 3) return null;
    // A wall between two corners may still cut across the road's edge:
    // it gets a corner more there, until none does.
    for (let round = 0; ; round++) {
      const next: XZ[] = [];
      let more = false;
      for (let q = 0; q < out.length; q++) {
        const a = out[q], b = out[(q + 1) % out.length];
        next.push(a);
        const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
        for (let k = 0; k < steps; k++) {
          const m: XZ = [lerp(a[0], b[0], (k + 0.5) / steps), lerp(a[1], b[1], (k + 0.5) / steps)];
          if (!roadOver(m[0], m[1], 0.4)) continue;
          next.push(clear(clear(m)));
          more = true;
        }
      }
      if (!more) break;
      if (round === 5) return null;
      out = next;
    }
    return ringArea(out) < 0.5 * ringArea(pts) ? null : out;
  };
  /** Where the columns of an open ground floor stand: round the outline and in rows inside, clear of every road. */
  const columnsOf = (pts: XZ[], area: number) => {
    const posts: XZ[] = [];
    const add = (x: number, z: number) => {
      if (!roadOver(x, z, 0.45 + 1.3) && !posts.some((p) => Math.hypot(p[0] - x, p[1] - z) < 2.5)) posts.push([x, z]);
    };
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    pts.forEach((p, q) => {
      const n = pts[(q + 1) % pts.length];
      const steps = Math.max(1, Math.ceil(Math.hypot(n[0] - p[0], n[1] - p[1]) / 7));
      for (let k = 0; k < steps; k++) add(lerp(p[0], n[0], k / steps), lerp(p[1], n[1], k / steps));
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      z0 = Math.min(z0, p[1]);
      z1 = Math.max(z1, p[1]);
    });
    // (Rows wider apart in a big building: about sixty columns inside at most.)
    const g = Math.max(7, Math.sqrt(area / 60));
    for (let x = x0 + g / 2; x < x1; x += g) for (let z = z0 + g / 2; z < z1; z += g) if (inRingXZ(pts, x, z)) add(x, z);
    return posts;
  };
  const blds: Bld[] = [];
  /** How many buildings met a ground road, and what became of them. */
  const bldRoads = { through: 0, cut: 0, opened: 0, roofed: 0, left: 0, ms: 0 };
  const bldT0 = performance.now();
  const bldTile = new Map<string, number[]>();
  for (let bi = 0; bi < M.buildings.length; bi++) {
    const b = M.buildings[bi];
    if (SKIP.has(b.k) || b.pts.length < 3) continue;
    let pts = ringArea(b.pts) < 0 ? [...b.pts].reverse() : b.pts;
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
    // A road always has right of way over a building. Under a raised road a
    // building may be no taller than the space beneath the deck (OSM often
    // gives no height, and a guess can stand straight through a flyover);
    // if that leaves less than a storey, or the road is on a bank of
    // earth, the building is left out.
    const room = roomUnderRoads(pts, cx, cz);
    if (room !== Infinity) {
      h = Math.min(h, room - ground);
      if (h < 3) continue;
    }
    let open = 0;
    let posts: XZ[] = [];
    if (walls) {
      const cut = roadThrough[bi] >= 3 ? null : cutBack(pts, cx, cz);
      if (roadThrough[bi] >= 3) bldRoads.through++;
      if (cut) {
        if (cut !== pts) bldRoads.cut++;
        pts = cut;
      } else if (h >= VOID_H + 3) {
        open = VOID_H;
        posts = columnsOf(pts, area);
        bldRoads.opened++;
      } else if (area < 150) {
        bldRoads.left++; // (a hut or a shed in the road's way)
        continue;
      } else {
        // (Too low for a floor above the road: a roof over it.)
        walls = false;
        h = Math.max(h, VOID_H);
        bldRoads.roofed++;
      }
    }
    const i = blds.length;
    blds.push({ pts, h, wall, roof, walls, base, ground, open, posts });
    const k = tileKey(cx, cz);
    if (!bldTile.has(k)) bldTile.set(k, []);
    bldTile.get(k)!.push(i);
  }
  bldRoads.ms = performance.now() - bldT0;
  const wc = new THREE.Color();
  const rc = new THREE.Color();
  for (const [k, ids] of bldTile) {
    // Meshes on the horizon layer (the skyline), in batches so each build step stays short.
    inChunks('horizon', k, 'buildings', ids, 12, (part, _kit, acc) => {
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
              // (Over an open ground floor the walls start above it.)
              const foot = b.open ? b.ground + b.open : b.base;
              const v0 = (foot - b.base) / 11.6;
              const v1 = (top - b.base) / 11.6;
              wp.push(ax, foot, az, bx, foot, bz, bx, top, bz, ax, foot, az, bx, top, bz, ax, top, az);
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
          if (b.open) {
            // An open ground floor: the ceiling over it, and its columns.
            const ceil = b.ground + b.open;
            for (const t of tris)
              for (const v of t) {
                rp.push(b.pts[v][0], ceil, b.pts[v][1]);
                rcl.push(0.8, 0.8, 0.78);
              }
            const w = 0.3;
            for (const [x, z] of b.posts) {
              const c: XZ[] = [[x - w, z - w], [x + w, z - w], [x + w, z + w], [x - w, z + w]];
              for (let q = 0; q < 4; q++) {
                const [ax, az] = c[q];
                const [bx, bz] = c[(q + 1) % 4];
                rp.push(ax, b.base, az, bx, b.base, bz, bx, ceil, bz, ax, b.base, az, bx, ceil, bz, ax, ceil, az);
                for (let k = 0; k < 6; k++) rcl.push(wc.r * 0.92, wc.g * 0.92, wc.b * 0.92);
              }
            }
          }
        }
      });
    // Walls you can bump into, near the car only: a thick slab inside each wall.
    inChunks('near', k, 'building walls', ids, 25, (part, kit) => {
      const body = kit.body();
      for (const id of part) {
        const b = blds[id];
        if (!b.walls) continue;
        if (b.open) {
          // (An open ground floor: only its columns.)
          for (const [x, z] of b.posts) world.createCollider(RAPIER.ColliderDesc.cuboid(0.3, b.open / 2 + 0.25, 0.3).setTranslation(x, b.ground + b.open / 2 - 0.25, z), body);
          continue;
        }
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
    onTile('horizon', k, 'viaducts', (kit) => {
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
    onTile('near', k, 'viaduct piers', (kit) => {
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
    onTile('far', k, 'rail ballast', (_kit, acc) => {
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
      const t0 = performance.now();
      job(offScene, acc);
      cost(`${job.what} (again, for the collider)`, `near:${k}`, t0);
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
      const at = `${layer}:${ti},${tj}`;
      const t = yield* ensurePatch(ti, tj, layer === 'horizon' ? STEP_FAR : STEP);
      let t0 = performance.now();
      if (t) {
        if (layer === 'near') terrainCollider(t, kit);
        else groundMesh(t, kit, layer === 'horizon');
      }
      cost(layer === 'near' ? 'ground collider' : 'ground mesh', at, t0);
      yield;
      if (layer === 'near') {
        const surf = yield* surfaceOf(`${ti},${tj}`);
        t0 = performance.now();
        roadCollider(surf, kit);
        cost('road collider', at, t0);
        yield* plantTile(ti, tj, kit);
      }
      const accs = new Map<AccKey, Acc>();
      const acc = (key: AccKey) => {
        let a = accs.get(key);
        if (!a) accs.set(key, (a = new Acc()));
        return a;
      };
      for (const job of jobs[layer].get(`${ti},${tj}`) ?? []) {
        t0 = performance.now();
        job(kit, acc);
        cost(job.what ?? '?', at, t0);
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
  const [sx, sz] = opts.startAt ?? (carparkC ? centroid(carparkC.pts) : [86, -1202]);
  const sr = roads.nearest(sx, sz, 300) ?? roads.nearest(sx, sz, 8000)!;
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
      footTop, footPiers, footStairs, pathIdx,
      blds, rankOf, deckSplits, nearDeck, WB, GORE, throughLines, throughPairs, paveY, giveWays, bldRoads,
      // May road `line` carry a marking at (x, z)? Not under another road, on an island or in a junction.
      lineOpen: (line: number, x: number, z: number, y: number) => !coveredBy(line, x, z, y) && !onIsland(x, z) && !inPaving(x, z, y),
      markStops, throughEnd: (line: number, end: number) => throughEnds.has(line * 2 + end),
      piers: () => {
        const out: { x: number; z: number; top: number; kind: string; self: number }[] = [];
        edges.forEach((_, line) => pillarsOf(line, 0, EP[line].length - 1, (x, z, top) => out.push({ x, z, top, kind: 'flyover', self: line })));
        viaducts.forEach((pts, line) => railPiers(line).forEach((q) => out.push({ x: pts[q][0], z: pts[q][1], top: railY(line, q) - 1.1, kind: 'rail', self: -1 })));
        return out;
      },
      crossings, CROSS_FROM, CROSS_W,
      // A far tile's road buffers, built off-scene (for the seam checks).
      farTiles: () => [...jobs.far.keys()],
      sliceCost,
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
      needs, jCap, jCeil, deckEnd, sepA, sepB, relAlong, ELEN, tiltAt, LIMITS, WL, throughOf, mateOf: mate, WIDTH_RATE, runOf, runs,
      fillTop: (k: number, x: number, z: number) => fillTop(JX.shapes.length + k, x, z),
      jTop: (k: number, x: number, z: number) => jTop(k, x, z),
      edges, EP, ECUM, EHALF, elevated, isDeck, embank, hasProfile, deckY, jRel, baseAt, heightAt, paths, PHALF, roads };
  return {
    name: opts.name ?? 'Pasir Ris & Tampines',
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
    solidAt: (x, z) => streamer.solidAt(x, z),
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
