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
import { Clipper, FillRule, Path64, Paths64, Point64 } from 'clipper2-js';

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

/** (ws: the widths along a line the redraw step joined from pieces of different width: [fraction of its length where a width starts, width]; w is then the widest.) */
interface OsmEdge { a: number; b: number; cls: string; w: number; one: number; lv?: number; vd?: number; name?: string; pts: XZ[]; ws?: [number, number][]; dual?: number; mo?: number; med?: number; ta?: number; tb?: number; ms?: [number, number, number][] }
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
  /** Where OSM has a junction's traffic lights (a pedestrian crossing's alone left out). */
  signals?: XZ[];
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
/**
 * Has the road kerbs? Every street ranked 1 or above, and a service road with
 * a street's name (OSM files some real streets, Simei Rise among them, as
 * service roads). Not driveways, car park aisles, or the lanes of a bus
 * interchange, depot or campus: those stay plain.
 */
const STREET = /\b(road|street|rise|lane|drive|avenue|way|walk|crescent|close|farmway|link|central|place|grove|view|terrace|loop|lorong|jalan)\b/i;
const kerbedRoad = (e: { cls: string; name?: string }) => rankOf(e.cls) >= 1 || (e.cls === 'service' && STREET.test(e.name ?? ''));
/** The two sides of a dual carriageway drawn as one road (two lanes or more each way: a narrower one is marked as any two-way street). */
const paired = (e: { dual?: number; w: number }) => !!e.dual && e.w >= 12;

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
    .map((e) => {
      const cap = e.one ? ONE_WAY_W[e.cls] : undefined;
      return cap ? { ...e, w: Math.min(e.w, cap), ...(e.ws ? { ws: e.ws.map(([f, w]) => [f, Math.min(w, cap)] as [number, number]) } : {}) } : e;
    });
  // (Where a road runs on through a joint as one line, its points are 2 m
  // apart over the 8 m either side: at 4 m, the corner at the joint's own
  // point could hold more of the curve's turn than those either side, and
  // the line kinked there.)
  const fineEnds = (e: (typeof edges)[number]) => {
    const pts = e.pts as XZ[];
    let L = 0;
    for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    /** The line cut d along it: [before, after], both holding the cut point. */
    const cut = (P: XZ[], d: number): [XZ[], XZ[]] | null => {
      let run = 0;
      for (let k = 1; k < P.length; k++) {
        const l = Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]);
        if (run + l >= d) {
          const u = (d - run) / (l || 1);
          const x: XZ = [P[k - 1][0] + (P[k][0] - P[k - 1][0]) * u, P[k - 1][1] + (P[k][1] - P[k - 1][1]) * u];
          return [[...P.slice(0, k), x], [x, ...P.slice(k)]];
        }
        run += l;
      }
      return null;
    };
    if (e.ta && e.tb && L <= 16) return resample(pts, 2);
    const ra = e.ta ? Math.min(8, L / 2) : 0, rb = e.tb ? Math.min(8, L / 2) : 0;
    let head: XZ[] = [], mid = pts, tail: XZ[] = [];
    const c0 = ra > 0 ? cut(mid, ra) : null;
    if (c0) (head = resample(c0[0], 2)), (mid = c0[1]);
    let Lm = 0;
    for (let k = 1; k < mid.length; k++) Lm += Math.hypot(mid[k][0] - mid[k - 1][0], mid[k][1] - mid[k - 1][1]);
    const c1 = rb > 0 && Lm - rb > 0.01 ? cut(mid, Lm - rb) : null;
    if (c1) (tail = resample(c1[1], 2)), (mid = c1[0]);
    const M = resample(mid, 4);
    return [...head.slice(0, -1), ...M, ...tail.slice(1)];
  };
  const EP = edges.map((e) => (e.ta || e.tb ? fineEnds(e) : resample(e.pts, 4)));
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
      // (Not where the map marks one road as carrying straight on: that road is one strip, and the third meets its edge.)
      if (list.some((i) => (edges[i].a === j ? edges[i].ta : edges[i].tb))) continue;
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
  // One road carrying straight on through a joint where a side road meets it
  // (marked in the map data by the redraw's `roads` step): the two pieces
  // are built as one strip, and the side road ends at its edge.
  const thruEnd = (i: number, j: number) => !!(edges[i].a === j ? edges[i].ta : edges[i].tb) && edges[i].a !== edges[i].b;
  const thruMate = (i: number, j: number) => {
    if (!thruEnd(i, j)) return undefined;
    const l = (jE[j] ?? []).filter((o) => o !== i && thruEnd(o, j));
    return l.length === 1 ? l[0] : undefined;
  };
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
      if (l.some((i) => thruEnd(i, j))) return;
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
  /** An opening in a divider: a few metres of road between two roads that each run through their joint as one strip, paved from the two joints with no strip of its own. */
  const openingLink = (i: number) => !!JX.internal[i] && !!JX.tee[edges[i].a] && !!JX.tee[edges[i].b] && !thruEnd(i, edges[i].a) && !thruEnd(i, edges[i].b);
  /** The next piece of the same strip at joint j, where the builder lays the two as one (a tee, or a joint of just the two). */
  const thruJoint = (i: number, j: number) => (JX.tee[j] || (jE[j]?.length ?? 0) === 2 ? thruMate(i, j) : undefined);
  const mate1 = (i: number, j: number) => {
    const t = thruMate(i, j);
    if (t !== undefined) return t;
    // (Never a piece that is marked as carrying on into another here: a
    // marked joint the shaper could not build as one strip still has its
    // own idea of which road runs through.)
    const free = (c: number) => thruMate(c, j) === undefined;
    const o = throughOf(j, i);
    if (o !== undefined) return o !== i && throughOf(j, o) === i && free(o) ? o : undefined;
    if ((jE[j]?.length ?? 0) < 3) return undefined;
    // (Not the short pieces inside a big junction: its shape joins those.)
    // (Nor flyover decks: the roads beside a deck are set out from its full width.)
    if (ELEN[i] < 30 || isDeck[i]) return undefined;
    const c = carryOn(j, i);
    return c !== undefined && carryOn(j, c) === i && free(c) ? c : undefined;
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
        const e = edges[list[q].i];
        smooth[m] = EHALF[list[q].i];
        // (A joined line carries its own widths along it.)
        if (e.ws) {
          const f = Math.min(1, Math.max(0, (m - start) / (ELEN[list[q].i] || 1)));
          const at = list[q].fwd ? f : 1 - f;
          let w = e.ws[0][1];
          for (const [from, v] of e.ws) if (at >= from) w = v;
          smooth[m] = w / 2;
        }
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
          if (smooth[mid] < 0.75 * osm[mid]) {
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
  // A map redrawn as whole roads (its through roads are marked): markings
  // are then a property of the road, not of each piece, so they do not jog
  // where two pieces meet. A one-way road's lanes keep one width along its
  // whole run (the narrowest any piece would give them).
  const oneLine = edges.some((e) => e.ta || e.tb);
  /** 0 to 1 as t goes 0 to 1, starting and ending with no slope and no bend. */
  const ease5 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (6 * t - 15) + 10));
  const lanesOfW = (w: number) => Math.max(1, Math.round((w - 0.7) / 3.3));
  const runLane = runs.map(() => Infinity);
  edges.forEach((e, i) => {
    const r = runOf[i].run;
    if (r >= 0 && e.one) runLane[r] = Math.min(runLane[r], (2 * EHALF[i]) / lanesOfW(e.w));
  });
  const laneWOf = (i: number) => {
    const own = (2 * EHALF[i]) / lanesOfW(edges[i].w);
    const r = runOf[i].run;
    return oneLine && r >= 0 && runLane[r] < Infinity ? Math.max(2.8, runLane[r]) : own;
  };
  const halfAtS = (i: number, along: number) => {
    const { run, at, fwd } = runOf[i];
    const R = runs[run];
    if (!R) return EHALF[i];
    const s = Math.max(0, Math.min(R.len, at + (fwd ? along : ELEN[i] - along)));
    const m = Math.floor(s);
    const u = s - m;
    return R.smooth[m] + (R.smooth[Math.min(R.len, m + 1)] - R.smooth[m]) * u;
  };
  const halfAtE = (i: number, k: number) => halfAtS(i, ECUM[i][k]);
  // A joined line (a redrawn map) carries its widths along it, and its one
  // width is its widest: a slip road that fans out to six lanes at its
  // lights is a third of that beside the expressway it left. Wherever what
  // lies under, beside or on a road is worked out, such a line counts as
  // wide as it is drawn at that place. (Any other road: its one width.)
  const halfK = (i: number, k: number) => (edges[i].ws ? halfAtE(i, k) : EHALF[i]);
  const halfNear = (i: number, seg: number, u = 0) =>
    edges[i].ws ? halfAtS(i, lerp(ECUM[i][seg], ECUM[i][Math.min(ECUM[i].length - 1, seg + 1)], u)) : EHALF[i];
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
    kerbed: (i) => kerbedRoad(edges[i]),
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
    thru: (i, end) => thruMate(i, end ? edges[i].b : edges[i].a) !== undefined,
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
        // (Two flyover decks climb together. Two pieces of one strip are
        // not side by side: one carries on where the other ends.)
        if (o === i || (elevated[i] && elevated[o]) || thruJoint(i, j) === o) continue;
        const ia = edges[i].a === j;
        const oa = edges[o].a === j;
        const far = Math.min(40, ELEN[i], ELEN[o]);
        const wide = (q: number, qa: boolean, t: number) => (edges[q].ws ? halfAtS(q, qa ? t : ELEN[q] - t) : EHALF[q]);
        let s = 0;
        while (s < far) {
          const [x1, z1] = along(i, ia, s + 1);
          const [x2, z2] = along(o, oa, s + 1);
          if (Math.hypot(x1 - x2, z1 - z2) >= wide(i, ia, s + 1) + wide(o, oa, s + 1)) break;
          s += 1;
        }
        if (s < 2) continue;
        // Two roads on the ground (or ramps) share one height where they
        // overlap (see relAlong); beside a flyover deck, a road stays level.
        if (!elevated[i] && !elevated[o]) {
          mates[i].push({ o, ia, oa, L: s });
          // (A road running through the joint as one strip stays level
          // beside a road that leaves it there, for as far as that road is
          // level: out to its mouth. The two are one surface until then.)
          if (thruJoint(i, j) !== undefined && thruJoint(o, j) === undefined) {
            const level = Math.min((oa ? JX.trimA[o] : JX.trimB[o]) || 0, ELEN[o] * 0.4);
            if (ia) sepA[i] = Math.max(sepA[i], level);
            else sepB[i] = Math.max(sepB[i], level);
          }
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
  const thruSlopeCache = new Map<number, number | undefined>();
  const stripShapes = new Map<number, 0 | 1 | 2>();
  const landCache = new Map<number, number>();
  const holdLen = new Float32Array(edges.length * 2); // see baseHold
  const lift = () => {
    thruSlopeCache.clear();
    stripShapes.clear();
    landCache.clear();
    holdLen.fill(0);
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
      // (Beside a road running through the joint as one strip, the strip
      // keeps its own height and the road beside it takes the strip's.)
      const j = m.ia ? edges[i].a : edges[i].b;
      const iThru = thruJoint(i, j) !== undefined, oThru = thruJoint(m.o, j) !== undefined;
      if (iThru && !oThru) continue;
      sum += (t * (relOwn(m.o, so) - r)) / (oThru && !iThru ? 1 : 2);
      w += t;
    }
    return w > 1 ? r + sum / w : r + sum;
  };
  /** Road height above the ground at distance s along edge i, on its own: straight ramps. */
  const relRamps = (i: number, s: number, shaped?: number) => {
    const ra = jRel[edges[i].a] ?? 0;
    const rb = jRel[edges[i].b] ?? 0;
    let r: number;
    if (shaped !== undefined) r = shaped;
    else if (elevated[i]) {
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
  // A road built as one strip through a joint (the map's marks) is one
  // strip in height too. Straight ramps meet at a joint in a corner: a
  // crest where the road climbs to the joint and falls away beyond it, a
  // dip between two raised joints, a sharp start where a ramp meets a level
  // bridge deck. A piece of a strip takes a smooth shape instead:
  // 1. short (its two ramps would meet above the ground): one curve from
  //    one end's height to the other's, where no other road runs into its
  //    far end beside it (that road expects the ramp);
  // 2. long: from each of the strip's joints it comes down to the ground
  //    in an eased curve, half as long again as the ramp;
  // 0. otherwise its ramps, eased over EASE m from each of the strip's joints.
  // At the strip's joint the two pieces share one slope: half way between
  // the slopes each would take (a bridge deck's own, since a deck does not
  // bend). The joint keeps its height; an end that is not the strip's
  // stays as it was (level into a junction, or the ramp).
  const EASE = 30;
  const stripShape = (i: number): 0 | 1 | 2 => {
    let v = stripShapes.get(i);
    if (v !== undefined) return v;
    v = 0;
    const e = edges[i];
    const run = runLen(i);
    const ra = jRel[e.a] ?? 0, rb = jRel[e.b] ?? 0;
    const thruA = thruJoint(i, e.a) !== undefined, thruB = thruJoint(i, e.b) !== undefined;
    if (!elevated[i] && run > 0 && e.a !== e.b && (ra > 0.02 || rb > 0.02) && (thruA || thruB)) {
      if (run >= (1.5 * (ra + rb)) / RAMP_GRADE) v = 2;
      else if (!mates[i].some((m) => !(m.ia ? thruA : thruB)) && (1.5 * Math.abs(rb - ra)) / run <= MAX_GRADE) v = 1;
    }
    stripShapes.set(i, v);
    return v;
  };
  /** The slope piece q would take climbing away from joint j, left to itself. */
  const awayOwn = (q: number, j: number) => {
    const sh = stripShape(q);
    const rj = jRel[j] ?? 0;
    if (sh === 1) return ((jRel[edges[q].a === j ? edges[q].b : edges[q].a] ?? 0) - rj) / runLen(q);
    if (sh === 2) return rj > 0.02 ? -RAMP_GRADE / 1.5 : 0;
    if (ELEN[q] <= 2) return 0;
    return (edges[q].a === j ? relRamps(q, 2) - relRamps(q, 0) : relRamps(q, ELEN[q] - 2) - relRamps(q, ELEN[q])) / 2;
  };
  /** The slope piece i takes climbing away from the strip's joint j, shared with the next piece (undefined: not a strip's joint, or nothing raised). */
  const awayAt = (i: number, j: number) => {
    const key = i * 2 + (edges[i].a === j ? 0 : 1);
    if (thruSlopeCache.has(key)) return thruSlopeCache.get(key);
    let v: number | undefined;
    const o = thruJoint(i, j);
    if (o !== undefined && !elevated[i] && ((jRel[j] ?? 0) > 0.02 || elevated[o])) {
      // (Carrying straight on, the road climbs away on one side as it falls on the other.)
      const aI = awayOwn(i, j), aO = awayOwn(o, j);
      // (Level where either piece is: beside a slip road, out to its mouth.)
      const levelAt = (q: number) => (edges[q].a === j ? trimA(q) : trimB(q)) > 0;
      v = levelAt(i) || levelAt(o) ? 0 : Math.max(-MAX_GRADE, Math.min(MAX_GRADE, elevated[o] ? -aO : (aI - aO) / 2));
    }
    thruSlopeCache.set(key, v);
    return v;
  };
  /** Road height above the ground at distance s along edge i, on its own. */
  // (Most roads are part of no strip: their straight ramps, as ever. Asked
  // for every point of every bank, so that answer is kept per road.)
  const stripEnds = new Int8Array(edges.length); // 0 not yet known, 1 no strip joint at either end, 2 a strip
  const inStrip = (i: number) => {
    if (!stripEnds[i]) stripEnds[i] = thruJoint(i, edges[i].a) === undefined && thruJoint(i, edges[i].b) === undefined ? 1 : 2;
    return stripEnds[i] === 2;
  };
  // A road is level across a junction, at the junction's own height. On a
  // redrawn map it can be level for a long way out of a joint (a strip
  // beside its slip road, out to the slip's mouth), and on a slope the
  // hills where that level stretch ends are not the hills under the joint.
  // stepAt: how far the junction's ground stands above the hills there (or
  // below them, negative).
  const stepCache = new Float32Array(edges.length * 2).fill(NaN);
  const stepAt = (i: number, fromA: boolean) => {
    const key = i * 2 + (fromA ? 0 : 1);
    let v = stepCache[key];
    if (v !== v) {
      const j = fromA ? edges[i].a : edges[i].b;
      const [x, z] = along(i, fromA, fromA ? trimA(i) : trimB(i));
      v = stepCache[key] = baseAt(M.junctions[j][0], M.junctions[j][1]) - baseAt(x, z);
    }
    return v;
  };
  /**
   * How far a long piece of a strip takes to come down to the ground from
   * its raised joint j, beyond the stretch it stays level there: half as
   * long again as the ramp down from its height above the ground, which is
   * the ground where the level stretch ends, not the joint's own.
   */
  const landOver = (i: number, j: number) => {
    const fromA = edges[i].a === j;
    const key = i * 2 + (fromA ? 0 : 1);
    let D = landCache.get(key);
    if (D !== undefined) return D;
    const rj = jRel[j] ?? 0;
    D = (1.5 * rj) / RAMP_GRADE;
    // (Not a road held down to pass under a flyover: the headroom is worked
    // out for a road that comes down as fast as it can.)
    if ((fromA ? trimA(i) : trimB(i)) > 0 && !held(i)) {
      const room = runLen(i) - (1.5 * (jRel[fromA ? edges[i].b : edges[i].a] ?? 0)) / RAMP_GRADE;
      D = Math.max(D, Math.min(room, (1.5 * Math.abs(rj + stepAt(i, fromA))) / RAMP_GRADE));
    }
    landCache.set(key, D);
    return D;
  };
  /** The height above the ground a long piece of a strip (stripShape 2) still has d m down from its raised joint j. */
  const stripDown = (i: number, j: number, d: number) => {
    const rj = jRel[j] ?? 0;
    if (rj <= 0.02) return 0;
    const m = awayAt(i, j);
    if (m === undefined) return Math.max(0, rj - RAMP_GRADE * d);
    const D = landOver(i, j);
    if (d >= D) return 0;
    const t = d / D, t2 = t * t, t3 = t2 * t;
    return Math.max(0, (2 * t3 - 3 * t2 + 1) * rj + (t3 - 2 * t2 + t) * D * m);
  };
  const relOwn = (i: number, s: number) => {
    if (elevated[i]) return relRamps(i, s);
    const e = edges[i];
    if (!inStrip(i)) return relRamps(i, s);
    const sh = stripShape(i);
    if (sh === 1) {
      const run = runLen(i);
      const t = runA(i, s) / run, t2 = t * t, t3 = t2 * t;
      const ma = awayAt(i, e.a) ?? 0, mb = awayAt(i, e.b) ?? 0;
      return relRamps(i, s, Math.max(0, (2 * t3 - 3 * t2 + 1) * jRel[e.a] + (t3 - 2 * t2 + t) * run * ma + (-2 * t3 + 3 * t2) * jRel[e.b] - (t3 - t2) * run * mb));
    }
    if (sh === 2) return relRamps(i, s, Math.max(stripDown(i, e.a, runA(i, s)), stripDown(i, e.b, runB(i, s))));
    let r = relRamps(i, s);
    const D = Math.min(EASE, ELEN[i]);
    for (let end = 0; end < 2; end++) {
      const j = end ? e.b : e.a;
      const d = end ? ELEN[i] - s : s;
      if (d >= D || (e.a === e.b && end)) continue;
      const m = awayAt(i, j);
      if (m === undefined) continue;
      // (The eased ramp is at its steepest a third again of the change beyond the ramp's own slope.)
      const own = awayOwn(i, j);
      const spare = Math.max(0, MAX_GRADE - Math.abs(own)) * 3;
      const t = d / D;
      r += Math.max(-spare, Math.min(spare, m - own)) * D * t * (1 - t) * (1 - t);
    }
    return Math.max(0, r);
  };
  // The ground a raised road's height is measured from: the hills under it,
  // except that across a shaped junction (and fading out over the next
  // 12 m) it is the junction's own, so every raised road leaves a junction
  // at the junction's one height even on a slope. (Only at a raised
  // junction: where it sits on the ground, every road follows the ground.)
  const jBase = Float64Array.from(M.junctions, ([jx, jz]) => baseAt(jx, jz));
  // (groundUnder: the hills at the point roadBase was last asked about, for
  // a caller that needs both without working the hills out twice.)
  let groundUnder = 0;
  // How much of that step (stepAt) a road still stands on, d m from its
  // end, beyond its level stretch. Coming back to the hills in 12 m, as on
  // today's map where the step is small, made a hump on a road falling to
  // the ground, or a drop too steep to climb. The step eases out as the
  // road's own height above the ground does, so the two never work against
  // each other:
  // - a long piece of a strip coming down to the ground: with its curve;
  // - a short piece of a strip: with its one curve to the other end;
  // - any other road: as far as the step needs at RAMP_GRADE, never less
  //   than the 12 m.
  // (Only the step is carried: beyond the level stretch every road still
  // stands on the hills under it, so two roads side by side agree.)
  const baseHold = (i: number, fromA: boolean, d: number, F: number) => {
    const j = fromA ? edges[i].a : edges[i].b;
    const t = fromA ? trimA(i) : trimB(i);
    const run = runLen(i);
    if (inStrip(i)) {
      const sh = stripShape(i);
      if (sh === 2 && awayAt(i, j) !== undefined) return Math.min(1, stripDown(i, j, Math.max(0, Math.min(run, d - t))) / jRel[j]);
      if (sh === 1) return 1 - smoothstep(t, t + run, d);
    }
    const key = i * 2 + (fromA ? 0 : 1);
    let L = holdLen[key];
    if (!L) {
      const room = (fromA ? trimB(i) : trimA(i)) > 0 && (jRel[fromA ? edges[i].b : edges[i].a] ?? 0) > 0.02 ? run / 2 : run;
      L = holdLen[key] = Math.max(F, Math.min(room, (1.5 * Math.abs(stepAt(i, fromA))) / RAMP_GRADE));
    }
    return 1 - smoothstep(t, t + L, d);
  };
  const roadBase = (i: number, s: number, x: number, z: number) => {
    const b = baseAt(x, z);
    groundUnder = b;
    if (elevated[i]) return b;
    const e = edges[i];
    let r = b;
    const ta = trimA(i);
    const tb = trimB(i);
    // (Gone well before the far end, however short the road.)
    const F = Math.min(12, Math.max(0.5, runLen(i) / 2));
    // (Today's map; and on a redrawn map a road held down to pass under a
    // flyover, whose headroom is worked out for the quick way down.)
    if (!oneLine || held(i)) {
      if (ta > 0) r += (1 - smoothstep(ta, ta + F, s)) * smoothstep(0.02, 0.5, jRel[e.a]) * (jBase[e.a] - b);
      if (tb > 0) r += (1 - smoothstep(tb, tb + F, ELEN[i] - s)) * smoothstep(0.02, 0.5, jRel[e.b]) * (jBase[e.b] - b);
      return r;
    }
    if (ta > 0 && jRel[e.a] > 0.02) r += smoothstep(0.02, 0.5, jRel[e.a]) * (s <= ta ? jBase[e.a] - b : baseHold(i, true, s, F) * stepAt(i, true));
    if (tb > 0 && jRel[e.b] > 0.02) r += smoothstep(0.02, 0.5, jRel[e.b]) * (ELEN[i] - s <= tb ? jBase[e.b] - b : baseHold(i, false, ELEN[i] - s, F) * stepAt(i, false));
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
            if (o === i || elevated[o] || shares(i, o) || dd > halfK(i, k) + halfNear(o, seg, u) - 0.3) return;
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
            if (!crossing.has(i + ',' + o) || dd > halfK(i, k) + halfNear(o, seg, u)) return;
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
      // (On a redrawn map the bridge is part of a strip that carries on at
      // both ends: the arch begins and ends with no bend in the road's
      // slope, over 20 m from each end, not as a corner at its joint. A
      // bridge shorter than 40 m arches less.)
      const arch = !isDeck[i] || elevated[i] ? 0 : oneLine ? 0.4 * ease5(cum[k] / 20) * ease5((len - cum[k]) / 20) : 0.4 * smoothstep(0, 10, cum[k]) * smoothstep(0, 10, len - cum[k]);
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
  /**
   * Road i's drawn height at (x, z), beside the point (cx, cz) of its line at
   * s, where its own height is y. A road still down at the ground (tiltAt)
   * lies on it. On a redrawn map it keeps its own height along its line and
   * follows the ground's shape across from its middle: the ground under a
   * ramp is already its bank, and adding the road's height above the ground
   * on top of that stood a ramp up to 25 cm above its own line where it
   * leaves the ground (a hump in every ramp, and a bend in its slope at any
   * joint on it). Today's map as it was.
   */
  const tiltY = (i: number, s: number, y: number, x: number, z: number, cx: number, cz: number) => {
    const t = tiltAt(i, s);
    if (t <= 0) return y;
    return oneLine ? y + t * (dropAt(x, z) - dropAt(cx, cz)) : lerp(y, dropAt(x, z) + relAlong(i, s), t);
  };
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
    for (const F0 of sh.kerbs) {
      // (Tested a metre at a time: a long straight side has only its two
      // ends as points, and one end touching a road would take the whole
      // side's kerb with it.)
      const F: XZ[] = [F0[0]];
      for (let q = 1; q < F0.length; q++) {
        const a = F0[q - 1], b = F0[q];
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
        for (let t = 1; t <= n; t++) F.push([a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n]);
      }
      let run: XZ[] = [];
      F.forEach((p, q) => {
        const a = F[Math.max(0, q - 1)];
        const b = F[Math.min(F.length - 1, q + 1)];
        const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const x = p[0] + ((b[1] - a[1]) / tl) * 0.05;
        const z = p[1] - ((b[0] - a[0]) / tl) * 0.05;
        let hit = false;
        roads.each(x, z, 16, (line, seg, u, d) => {
          if (!hit && d < halfNear(line, seg, u) - 0.3 && drawnAt(line, seg, u)) hit = true;
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
  // At a junction with traffic lights each road gets a zebra crossing just
  // outside its mouth, a stop line for the traffic coming in, and a traffic
  // light on the left kerb (Singapore drives on the left); between the stop
  // lines, a yellow box with an X across it. A junction has lights where
  // the map has them (OSM's own, from Singapore's real junctions); where it
  // has none nearby, at a crossroads of four streets or more, and at any
  // junction of three or more roads where two of them are secondary or
  // bigger (none an expressway). The lights take turns by direction: roads
  // lined up with the first one, then the rest.
  const CROSS_FROM = 1; // metres out from the mouth
  const CROSS_W = 3;
  const STOP_AT = CROSS_FROM + CROSS_W + 1;
  type Crossing = { line: number; end: 0 | 1; s: number; half: number; c: XZ; t: XZ; inbound: number; group: number; light: XZ | null };
  const crossings: Crossing[] = [];
  const crossCand: { cr: Crossing; lightOpts: XZ[] }[] = [];
  const crossEnd = new Map<string, Crossing>();
  type Arm = { line: number; end: 0 | 1; s: number; half: number; t: XZ };
  const armsOf: Arm[][] = JX.shapes.map((sh) => sh.mouths);
  /** Each junction's middle (as armsOf), and the roads that run through it as one strip. */
  const armsAt: { c: XZ; strips: number[]; rings: XZ[][] }[] = JX.shapes.map((sh) => ({ c: sh.centre, strips: [], rings: [sh.ring] }));
  /** A yellow box: its corners in turn, and the two lines of its X. */
  type YBox = { ring: XZ[]; x: [XZ, XZ][] };
  const yBoxes: YBox[] = [];
  /** Junctions with lights but no yellow box, and why (for the checks). */
  const boxWhy: { x: number; z: number; why: string }[] = [];
  // (The map's traffic lights, on a 32 m grid.)
  const SIG = 32;
  const sigGrid = new Map<number, XZ[]>();
  for (const p of M.signals ?? []) {
    const k = Math.floor(p[0] / SIG) * 100003 + Math.floor(p[1] / SIG);
    (sigGrid.get(k) ?? sigGrid.set(k, []).get(k)!).push(p);
  }
  /** Is there a traffic light of the map's within r of (x, z)? */
  const signalNear = (x: number, z: number, r: number) => {
    for (let a = Math.floor((x - r) / SIG); a <= Math.floor((x + r) / SIG); a++)
      for (let b = Math.floor((z - r) / SIG); b <= Math.floor((z + r) / SIG); b++)
        for (const p of sigGrid.get(a * 100003 + b) ?? []) if (Math.hypot(p[0] - x, p[1] - z) < r) return true;
    return false;
  };
  // A road that runs through its junction as one strip has no mouth there:
  // its crossing lies across it just clear of the side roads' mouths, on
  // each side. (Strips either side of a divider, joined across an opening,
  // are one junction: the crossings on both line up.)
  {
    const seen = new Set<number>();
    JX.tee.forEach((isTee, j0) => {
      if (!isTee || seen.has(j0)) return;
      const group = [j0];
      seen.add(j0);
      for (let q = 0; q < group.length; q++)
        for (const i of jE[group[q]]) {
          if (!JX.internal[i] || thruEnd(i, group[q])) continue;
          const o = edges[i].a === group[q] ? edges[i].b : edges[i].a;
          if (JX.tee[o] && !seen.has(o) && !thruEnd(i, o)) (seen.add(o), group.push(o));
        }
      const arms: Arm[] = [];
      const rings: XZ[][] = [];
      for (const sh of JX.shapes)
        if (sh.nodes.length === 1 && group.includes(sh.nodes[0])) {
          rings.push(sh.ring);
          arms.push(...sh.mouths);
        }
      for (const f of JX.fills) if (f.tee !== undefined && group.includes(f.tee)) rings.push(f.ring);
      for (const j of group)
        for (const i of jE[j]) {
          if (!thruEnd(i, j)) continue;
          const atA = edges[i].a === j;
          const P = EP[i];
          const k = atA ? 0 : P.length - 1;
          const q = P[atA ? 1 : P.length - 2];
          const tl = Math.hypot(q[0] - P[k][0], q[1] - P[k][1]) || 1;
          const t: XZ = [(q[0] - P[k][0]) / tl, (q[1] - P[k][1]) / tl];
          let far = 0;
          for (const ring of rings) for (const [x, z] of ring) far = Math.max(far, (x - P[k][0]) * t[0] + (z - P[k][1]) * t[1]);
          arms.push({ line: i, end: atA ? 0 : 1, s: far, half: halfAtE(i, k), t });
        }
      armsOf.push(arms);
      let cx = 0, cz = 0;
      for (const j of group) (cx += M.junctions[j][0]), (cz += M.junctions[j][1]);
      armsAt.push({ c: [cx / group.length, cz / group.length], strips: [...new Set(group.flatMap((j) => jE[j].filter((i) => thruEnd(i, j))))], rings });
    });
  }
  /** The point d along road line from its end (0 at a, 1 at b). */
  const fromEnd = (line: number, end: 0 | 1, d: number): XZ => {
    const P = EP[line];
    const cum = ECUM[line];
    const L = ELEN[line];
    const sAt = end === 0 ? d : L - d;
    let k = 0;
    while (k < P.length - 2 && cum[k + 1] <= sAt) k++;
    const u = (sAt - cum[k]) / (cum[k + 1] - cum[k] || 1);
    return [lerp(P[k][0], P[k + 1][0], u), lerp(P[k][1], P[k + 1][1], u)];
  };
  const lit: { mouths: Arm[]; at: (typeof armsAt)[number]; cands: (typeof crossCand)[number][] }[] = [];
  armsOf.forEach((mouths, g) => {
    const ms = mouths.filter((m) => !hasProfile[m.line] && rankOf(edges[m.line].cls) >= 1 && m.half >= 2.5 && ELEN[m.line] > m.s + STOP_AT + 4);
    if (mouths.length < 3 || ms.length < 3) return;
    if (mouths.some((m) => edges[m.line].cls === 'motorway')) return;
    // (Lights of the map's own: on the junction, or on a road just before it.)
    const at = armsAt[g];
    const reach = Math.max(...mouths.map((m) => ((p) => Math.hypot(p[0] - at.c[0], p[1] - at.c[1]))(fromEnd(m.line, m.end, m.s)))) + 12;
    const big = new Set(mouths.filter((m) => rankOf(edges[m.line].cls) >= 3).map((m) => edges[m.line].name ?? m.line)).size >= 2 || mouths.filter((m) => rankOf(edges[m.line].cls) >= 3).length >= 3;
    if (!signalNear(at.c[0], at.c[1], reach) && ms.length < 4 && !big) return;
    const axis = Math.atan2(ms[0].t[1], ms[0].t[0]);
    const cands: (typeof crossCand)[number][] = [];
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
      const cand = { cr: { line: m.line, end: m.end, s: m.s, half: m.half, c, t: m.t, inbound, group: da < Math.PI / 4 ? 0 : 1, light: null }, lightOpts };
      crossCand.push(cand);
      cands.push(cand);
    }
    lit.push({ mouths, at, cands });
  });

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
  const mouthRels = new Map<number, { y: number; t: number; r: number; g: number }[] | null>();
  const relsOf = (id: number) => {
    let r = mouthRels.get(id);
    if (r === undefined) {
      const sh = JPOLY[id];
      r = sh.mouths.some((m) => hasProfile[m.line])
        ? sh.mouths.map((m) => {
            if (!hasProfile[m.line]) return { y: NaN, t: 1, r: 0, g: 0 };
            const c = cutOf(m.line);
            const sc = m.end === 0 ? JX.trimA[m.line] || 0 : ELEN[m.line] - (JX.trimB[m.line] || 0);
            // (g: the ground at the middle of its mouth, worked out once: see tiltY.)
            return { y: m.end === 0 ? c.ylo : c.yhi, t: tiltAt(m.line, sc), r: relAlong(m.line, sc), g: oneLine ? dropAt(m.q[0], m.q[1]) : 0 };
          })
        : null;
      mouthRels.set(id, r);
    }
    return r;
  };
  /** A road's drawn surface at a point of its line (piece seg, u along it), under (x, z). */
  const topAt = (i: number, seg: number, u: number, x: number, z: number) => {
    if (!hasProfile[i]) return dropAt(x, z);
    const Y = deckY(i);
    let y = lerp(Y[seg], Y[Math.min(Y.length - 1, seg + 1)], u);
    if (!elevated[i]) {
      const sAt = ECUM[i][seg] + u * (ECUM[i][Math.min(ECUM[i].length - 1, seg + 1)] - ECUM[i][seg]);
      const P = EP[i][seg], Q = EP[i][Math.min(EP[i].length - 1, seg + 1)];
      y = tiltY(i, sAt, y, x, z, lerp(P[0], Q[0], u), lerp(P[1], Q[1], u));
    }
    return y;
  };
  // A tee's paving lies between the road running through and the side
  // road's mouth: it meets each at that road's own height (the through
  // road's along its edge, the side road's across its mouth and along its
  // edges), and between the two it blends, the nearer counting most. (Roads
  // on the ground follow the ground, and so does the paving between them.)
  const teeRoads = new Map<number, { thru: number[]; side: number[] } | null>();
  const teeTop = (id: number, x: number, z: number): number | undefined => {
    let t = teeRoads.get(id);
    if (t === undefined) {
      // (The junction's own outline, or a further part of its paving.)
      const nodes = id < JX.shapes.length ? JX.shapes[id].nodes : [];
      const j = id < JX.shapes.length ? (nodes.length === 1 ? nodes[0] : -1) : JX.fills[id - JX.shapes.length].tee ?? -1;
      const side = j >= 0 && JX.tee[j] ? jE[j].filter((i) => !thruEnd(i, j)) : [];
      t = side.length ? { thru: jE[j].filter((i) => thruEnd(i, j)), side } : null;
      if (t && ![...t.thru, ...t.side].some((i) => hasProfile[i])) t = null;
      teeRoads.set(id, t);
    }
    if (!t) return undefined;
    const { thru, side } = t;
    const hT = roads.nearest(x, z, 60, (i) => thru.includes(i));
    const hS = roads.nearest(x, z, 60, (i) => side.includes(i));
    if (!hT || !hS) return undefined;
    const outside = (h: NonNullable<typeof hT>) => Math.max(0, h.d - lerp(halfAtE(h.line, h.seg), halfAtE(h.line, h.seg + 1), h.u));
    const dT = outside(hT), dS = outside(hS);
    const yT = topAt(hT.line, hT.seg, hT.u, x, z), yS = topAt(hS.line, hS.seg, hS.u, x, z);
    const wT = 1 / (dT + 0.05) ** 2, wS = 1 / (dS + 0.05) ** 2;
    return (wT * yT + wS * yS) / (wT + wS);
  };
  /** For each road built as one strip through a junction: the paving (the junction's outline and any further parts) that opens off its edge there. */
  /** For each road that runs through joints as one strip: the paving along it where a slip road leaves or joins (its long wedge). */
  let teePavingMap: Map<number, number[]> | undefined;
  /** The same for every joint a road runs through as one strip, a square side road's bell mouth as much as a slip road's wedge. */
  let teeMouthMap: Map<number, number[]> | undefined;
  const teePaving = () => {
    if (!teePavingMap) {
      teePavingMap = new Map();
      teeMouthMap = new Map();
      for (let id = 0; id < JPOLY.length; id++) {
        const fill = id < JX.shapes.length ? undefined : JX.fills[id - JX.shapes.length];
        const j = fill ? fill.tee ?? -1 : JX.shapes[id].nodes.length === 1 ? JX.shapes[id].nodes[0] : -1;
        if (j < 0 || !JX.tee[j]) continue;
        const slip = fill ? fill.slip : JX.shapes[id].slip;
        for (const i of jE[j])
          if (thruEnd(i, j)) {
            (teeMouthMap.get(i) ?? teeMouthMap.set(i, []).get(i)!).push(id);
            if (slip) (teePavingMap.get(i) ?? teePavingMap.set(i, []).get(i)!).push(id);
          }
      }
    }
    return teePavingMap;
  };
  /**
   * Is (x, z) on the paving of a joint that road `line` runs through as one
   * strip? The road's own kerb, wall and parapet stop along that paving: it
   * opens off the road's edge there, and its outline carries them on round
   * the joint. (Asked a little way out from the road's edge: the paving's
   * outline lies along that edge, never exactly on it.)
   */
  const onTeeOf = (line: number, x: number, z: number) => {
    teePaving();
    const l = teeMouthMap!.get(line);
    return !!l && l.some((id) => inRingXZ(JPOLY[id].ring, x, z));
  };
  /** The top of junction id's paving at (x, z) (before its small lift). */
  const jTop = (id: number, x: number, z: number) => {
    const sh = JPOLY[id];
    const tee = teeTop(id, x, z);
    if (tee !== undefined) return tee;
    // (A further part of a junction's paving lies on the ground as the junction's own outline does.)
    if (sh.fill && JX.fills[id - JX.shapes.length].tee !== undefined) return Math.max(rawHeight(x, z), WL + 0.15);
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
      const { y, t, r, g: gm } = rels[q];
      const h = y === y ? (oneLine ? y + t * (g - gm) : lerp(y, g + r, t)) : g;
      if (dd < 1e-3) return h;
      const w = 1 / (dd * dd);
      sw += w;
      sr += w * h;
    }
    return sr / sw;
  };
  /** On a paved island? (y: at that height, for a raised road. An island on the ground is nothing to a deck that passes over it.) */
  const onIsland = (x: number, z: number, y = NaN) =>
    !!jGrid.get(Math.floor(x / JCELL) * 100003 + Math.floor(z / JCELL))?.some((id) => JPOLY[id].fill && inRingXZ(JPOLY[id].ring, x, z) && (y !== y || Math.abs(jTop(id, x, z) - y) < 3));
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
    /** On a road drawn there, other than own (one road, or a set of them), pad beyond its edge? */
    const onOther = (x: number, z: number, own: number | Set<number>, pad: number) => {
      let hit = false;
      roads.each(x, z, 16, (i, seg, u, d) => {
        if (!hit && (typeof own === 'number' ? i !== own : !own.has(i)) && !elevated[i] && drawnAt(i, seg, u) && d < halfNear(i, seg, u) + pad) hit = true;
      });
      return hit;
    };
    /** On crossing cr's stripes or its stop line, pad around them? */
    const onCross = (cr: Crossing, x: number, z: number, pad: number) => {
      const dx = x - cr.c[0], dz = z - cr.c[1];
      if (dx * dx + dz * dz > 900) return false;
      const along = dx * cr.t[0] + dz * cr.t[1];
      return along > -CROSS_W / 2 - pad && along < STOP_AT - CROSS_FROM - CROSS_W / 2 + 0.2 + pad && Math.abs(-dx * cr.t[1] + dz * cr.t[0]) < cr.half + pad;
    };
    for (const { cr, lightOpts } of crossCand) {
      const left: XZ = [-cr.t[1], cr.t[0]];
      let ok = true;
      for (const a of [-1, 0, 1, 2.6])
        for (const b of [-1, -0.5, 0, 0.5, 1]) {
          const x = cr.c[0] + cr.t[0] * a * (CROSS_W / 2) + left[0] * b * (cr.half - 0.4);
          const z = cr.c[1] + cr.t[1] * a * (CROSS_W / 2) + left[1] * b * (cr.half - 0.4);
          if (a <= 1 && (onOther(x, z, cr.line, -0.3) || inPoly(x, z, false))) ok = false;
          // (Nor over another junction's crossing, on a short road between two.)
          if (crossings.some((o) => onCross(o, x, z, 0.3))) ok = false;
        }
      if (!ok) continue;
      cr.light = lightOpts.find(([x, z]) => !onOther(x, z, -1, 0.3) && !inPoly(x, z, true)) ?? null;
      crossings.push(cr);
      crossEnd.set(`${cr.line}:${cr.end}`, cr);
    }
    // The yellow box, from corner to corner of the junction just inside its
    // kerbs, and an X across it. (Each corner where two roads' kerbs would
    // meet, brought in onto the paving; across a road that runs straight
    // on past the junction, its far kerb.)
    /** Asphalt of this junction at (x, z): its paving, one of its own roads out from its mouth, or a road running through it as one strip. */
    const pavedOf = (own: Arm[], strips: number[], rings: XZ[][]) => (x: number, z: number) =>
      rings.some((r) => inRingXZ(r, x, z)) ||
      [...own.map((m) => [m.line, m.end, m.s] as const), ...strips.map((i) => [i, 0, -1] as const)].some(([i, end, s0]) => {
        const h = roads.nearest(x, z, 30, (o) => o === i);
        if (!h || h.d >= lerp(halfAtE(i, h.seg), halfAtE(i, h.seg + 1), h.u) - 0.05) return false;
        if (s0 < 0) return true;
        const c = ECUM[i];
        const sAt = c[h.seg] + h.u * (c[Math.min(c.length - 1, h.seg + 1)] - c[h.seg]);
        return (end === 0 ? sAt : ELEN[i] - sAt) >= s0 - 0.05;
      });
    const meet = (p: XZ, t: XZ, q: XZ, w: XZ): XZ | null => {
      const det = t[0] * -w[1] - t[1] * -w[0];
      if (Math.abs(det) < 0.05) return null;
      const dx = q[0] - p[0], dz = q[1] - p[1];
      const u = (dx * -w[1] - dz * -w[0]) / det;
      return [p[0] + t[0] * u, p[1] + t[1] * u];
    };
    const STRAIGHT = (150 * Math.PI) / 180;
    for (const { mouths, at, cands } of lit) {
      const why = (w: string) => boxWhy.push({ x: +at.c[0].toFixed(1), z: +at.c[1].toFixed(1), why: w });
      if (cands.filter((c) => crossings.includes(c.cr)).length < 2) {
        why('fewer than two crossings');
        continue;
      }
      if (mouths.some((m) => hasProfile[m.line] || elevated[m.line])) {
        why('a raised road');
        continue;
      }
      const paved = pavedOf(mouths.filter((m) => !at.strips.includes(m.line)), at.strips, at.rings);
      const own = new Set([...mouths.map((m) => m.line), ...at.strips]);
      /** Out on an arm's own drawn road, near its edge lines? */
      const nearEdgeLine = (x: number, z: number) =>
        mouths.some((m) => {
          if (at.strips.includes(m.line)) return false;
          const h = roads.nearest(x, z, 30, (o) => o === m.line);
          if (!h) return false;
          const c = ECUM[m.line];
          const sAt = c[h.seg] + h.u * (c[Math.min(c.length - 1, h.seg + 1)] - c[h.seg]);
          // (Its lines may start where the road itself does: where it was cut back for the junction.)
          const out = (m.end === 0 ? sAt : ELEN[m.line] - sAt) - Math.min(m.s, (m.end === 0 ? JX.trimA[m.line] : JX.trimB[m.line]) || 0);
          const half = lerp(halfAtE(m.line, h.seg), halfAtE(m.line, h.seg + 1), h.u);
          return out > -1 && h.d < half + 0.2 && h.d > half - 0.9;
        });
      /** Paved there, and pad all round it? */
      const clear = (x: number, z: number, pad: number) => {
        if (!paved(x, z)) return false;
        for (let k = 0; k < 8; k++) if (!paved(x + Math.cos((k * Math.PI) / 4) * pad, z + Math.sin((k * Math.PI) / 4) * pad)) return false;
        return true;
      };
      // The arms in turn round the junction (the two sides of a divided road as one).
      type BArm = { p: XZ; t: XZ; h: number; a: number };
      let arms: BArm[] = mouths
        .map((m) => ({ p: fromEnd(m.line, m.end, m.s), t: m.t, h: m.half, a: Math.atan2(m.t[1], m.t[0]) }))
        .sort((u, v) => u.a - v.a);
      for (let q = 0; arms.length > 2 && q < arms.length; ) {
        const A = arms[q], B = arms[(q + 1) % arms.length];
        let da = B.a - A.a;
        if (da < 0) da += 2 * Math.PI;
        if (da > (25 * Math.PI) / 180) {
          q++;
          continue;
        }
        const tl = Math.hypot(A.t[0] + B.t[0], A.t[1] + B.t[1]) || 1;
        const t: XZ = [(A.t[0] + B.t[0]) / tl, (A.t[1] + B.t[1]) / tl];
        const n: XZ = [-t[1], t[0]];
        const oa = (A.p[0] - at.c[0]) * n[0] + (A.p[1] - at.c[1]) * n[1], ob = (B.p[0] - at.c[0]) * n[0] + (B.p[1] - at.c[1]) * n[1];
        const lo = Math.min(oa - A.h, ob - B.h), hi = Math.max(oa + A.h, ob + B.h);
        const da0 = (A.p[0] - at.c[0]) * t[0] + (A.p[1] - at.c[1]) * t[1], db0 = (B.p[0] - at.c[0]) * t[0] + (B.p[1] - at.c[1]) * t[1];
        const along = Math.min(da0, db0), mid = (lo + hi) / 2;
        const merged = { p: [at.c[0] + t[0] * along + n[0] * mid, at.c[1] + t[1] * along + n[1] * mid] as XZ, t, h: (hi - lo) / 2, a: Math.atan2(t[1], t[0]) };
        const other = (q + 1) % arms.length;
        arms = arms.filter((_, k) => k !== q && k !== other);
        arms.push(merged);
        arms.sort((u, v) => u.a - v.a);
        q = 0;
      }
      if (arms.length < 3) {
        why(`fewer than three arms: ${mouths.map((m) => `${m.line}:${m.end} t ${m.t.map((v) => v.toFixed(2))} s ${m.s.toFixed(1)}`).join('; ')}`);
        continue;
      }
      // Each gap between one arm and the next: a corner, or (wider than 150°) a road's far kerb.
      const N = arms.length;
      const gap = arms.map((A, q) => {
        const B = arms[(q + 1) % N];
        let da = B.a - A.a;
        if (da <= 0) da += 2 * Math.PI;
        return da;
      });
      if (gap.filter((g) => g > STRAIGHT).length > 1) {
        why('two straight sides');
        continue;
      }
      const corner: (XZ | null)[] = arms.map((A, q) => {
        if (gap[q] > STRAIGHT) return null;
        const B = arms[(q + 1) % N];
        const nA: XZ = [-A.t[1], A.t[0]], nB: XZ = [B.t[1], -B.t[0]];
        const K = meet([A.p[0] + nA[0] * A.h, A.p[1] + nA[1] * A.h], A.t, [B.p[0] + nB[0] * B.h, B.p[1] + nB[1] * B.h], B.t);
        if (!K) return null;
        // (In from where the kerbs would meet, toward the middle, until a metre onto the paving: clear of the kerb and the lines along it.)
        // (From 3 m further out: a mouth's width is not always the road's own there.)
        const D0 = Math.hypot(at.c[0] - K[0], at.c[1] - K[1]);
        if (D0 > 40) return null;
        const v: XZ = [(at.c[0] - K[0]) / (D0 || 1), (at.c[1] - K[1]) / (D0 || 1)];
        (K[0] -= v[0] * 3), (K[1] -= v[1] * 3);
        const D = D0 + 3;
        for (let r = 0; r < D * 0.8; r += 0.2) {
          const x = K[0] + v[0] * r, z = K[1] + v[1] * r;
          if (clear(x, z, 1)) return [x, z];
        }
        return null;
      });
      const ring: XZ[] = [];
      let ok = true;
      for (let q = 0; q < N && ok; q++) {
        if (gap[q] <= STRAIGHT) {
          if (!corner[q]) {
            why(`no corner between arms ${q} and ${(q + 1) % N}`);
            ok = false;
          } else ring.push(corner[q]!);
          continue;
        }
        // (Straight on past the junction: the corners on either side, carried across to its far kerb.)
        const A = arms[q], B = arms[(q + 1) % N];
        const Kp = corner[(q - 1 + N) % N], Kn = corner[(q + 1) % N];
        if (!Kp || !Kn) {
          why('no corner beside the straight side');
          ok = false;
          continue;
        }
        for (const [K, R] of [[Kp, A], [Kn, B]] as [XZ, BArm][]) {
          const n: XZ = R === A ? [-R.t[1], R.t[0]] : [R.t[1], -R.t[0]];
          const e: XZ = [R.p[0] + n[0] * (R.h - 0.5), R.p[1] + n[1] * (R.h - 0.5)];
          const u = (K[0] - e[0]) * R.t[0] + (K[1] - e[1]) * R.t[1];
          ring.push([e[0] + R.t[0] * u, e[1] + R.t[1] * u]);
        }
      }
      if (!ok) continue;
      if (ring.length < 4) {
        why('fewer than four corners');
        continue;
      }
      const xs: [XZ, XZ][] = [];
      const R = ring.length;
      for (let q = 0; q < Math.floor(R / 2); q++) xs.push([ring[q], ring[q + Math.floor(R / 2)]]);
      // (Only a whole box, every line of it on the paving.)
      const lines: [XZ, XZ][] = [...ring.map((p, q) => [p, ring[(q + 1) % R]] as [XZ, XZ]), ...xs];
      const off = lines.find(([p, q]) => {
        const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (L > 60) return true;
        for (let s = 0; s <= L; s += 0.5) {
          const f = L ? s / L : 0;
          const x = lerp(p[0], q[0], f), z = lerp(p[1], q[1], f);
          // (Clear of the kerbs: a line 0.2 m wide, a kerb 0.25 m.)
          if (!clear(x, z, 0.4) || onOther(x, z, own, 0.3) || crossings.some((o) => onCross(o, x, z, 0.3))) return true;
          // (Out on a road past its mouth, well clear of its edge lines.)
          if (!at.rings.some((r) => inRingXZ(r, x, z)) && nearEdgeLine(x, z)) return true;
        }
        return false;
      });
      // (Not under a flyover: there the roads below weave between its piers and slip roads, no plain crossing.)
      let under = false;
      for (const [p, q] of lines)
        for (let t = 0; t <= 1 && !under; t += 0.25)
          roads.each(lerp(p[0], q[0], t), lerp(p[1], q[1], t), 16, (i, seg, u, dd) => void (!under && elevated[i] && dd < halfNear(i, seg, u) + 1 && (under = true)));
      if (under) {
        why('under a flyover');
        continue;
      }
      if (off) {
        why(`a line off the paving from ${off[0].map((v) => v.toFixed(1))} to ${off[1].map((v) => v.toFixed(1))}`);
        continue;
      }
      yBoxes.push({ ring, x: xs });
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
        const inner = halfNear(line, seg, u) + 1.5;
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
        const slack = Math.max(0, d - halfNear(line, seg, u) - 0.6) / 2;
        const pts = EP[line];
        const sl = Math.hypot(pts[seg + 1][0] - pts[seg][0], pts[seg + 1][1] - pts[seg][1]);
        const sa = ECUM[line][seg] + u * sl;
        let yr = roadBase(line, sa, lerp(pts[seg][0], pts[seg + 1][0], u), lerp(pts[seg][1], pts[seg + 1][1], u));
        // (A road is never below its base: one whose base alone already
        // clears this point needn't work out how far above it stands.)
        if (yr + slack >= h) return;
        const under = groundUnder;
        const rel = relAlong(line, sa);
        yr += rel;
        // (A road still down on the ground lies on it, along and across,
        // as tiltAt has it: there the ground is held to its own shape, not
        // to the height of the road's middle. On a slope that height is a
        // step down for the road that carries on from its end. Only the
        // ground's shape across the road counts, measured from the hills
        // under its middle: a road held below the hills, as beside a
        // junction on a slope, keeps the ground down with it. A road that
        // stays level across its width, tiltAt 0, keeps the ground at its
        // own height. Redrawn maps only: today's map keeps its ground to
        // the centimetre.)
        const tl = oneLine && rel < 1 ? tiltAt(line, sa) : 0;
        if (tl > 0) yr += tl * Math.max(0, hb - under - rel);
        const cap = yr + slack;
        if (cap < h) h = cap;
      });
      // (Then the roads on the ground, which lie at hb: they only matter
      // where the ground here still stands above that, and then only those
      // near enough for their 1 in 2 to come under it.)
      const over = h - hb;
      if (over > 0)
        flatIdx.each(x, z, Math.min(30, flatHalfMax + 0.6 + 2 * over + 1e-6), (line, seg, u, d) => {
          const cap = hb + Math.max(0, d - halfNear(line, seg, u) - 0.6) / 2;
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
  /** How far the sealed ground lies below a road's own height (its drawn surface is ROAD_LIFT above that). */
  const UNDER = 0.12;
  const ROAD_LIFT = 0.09;
  const sealHits: { line: number; seg: number; u: number; d: number; half: number; s: number; used?: boolean }[] = [];
  function heightAt(x: number, z: number): number {
    let h = rawHeight(x, z);
    if (!(cell(x, z) & NEAR_ROAD)) return h;
    const ps = probe.s;
    const pw = probe.w;
    // (Against each road at its point nearest here, not every piece of it
    // in reach: on a climbing road the pieces a few metres back down the
    // slope are lower, and held the bank beside it down to their height, a
    // retaining wall where the bank should be. A road that comes back past
    // here further along its line, another limb of it, counts again.)
    sealHits.length = 0;
    roads.each(x, z, 14 + SEAL, (line, seg, u, d) => {
      if (elevated[line]) return;
      const half = halfNear(line, seg, u) + 0.35;
      if (d > half + SEAL + 2) return;
      sealHits.push({ line, seg, u, d, half, s: lerp(ECUM[line][seg], ECUM[line][seg + 1], u) });
    });
    sealHits.sort((p, q) => p.d - q.d);
    for (let q = 0; q < sealHits.length; q++) {
      const { line, seg, u, d, half, s } = sealHits[q];
      let other = false;
      for (let r = 0; r < q && !other; r++) other = sealHits[r].line === line && !!sealHits[r].used && Math.abs(sealHits[r].s - s) < 2 * (half + SEAL + 2);
      if (other) continue;
      sealHits[q].used = true;
      const pts = EP[line];
      const cx = lerp(pts[seg][0], pts[seg + 1][0], u);
      const cz = lerp(pts[seg][1], pts[seg + 1][1], u);
      let yr: number;
      if (hasProfile[line]) {
        yr = deckAtHit(line, seg, u);
        const tl = tiltAt(line, lerp(ECUM[line][seg], ECUM[line][seg + 1], u));
        if (tl > 0) {
          // (As the road is drawn: its edge worked out at each of its own
          // points, straight between them. Worked out here at this point
          // instead, on a steep ramp over uneven ground it came out up to
          // 20 cm off the drawn edge, and the ground with it.)
          const t = d > half ? half / d : 1;
          const ox = (x - cx) * t, oz = (z - cz) * t;
          const Y = deckY(line);
          const edgeAt = (k: number) => tiltY(line, ECUM[line][k], Y[k], pts[k][0] + ox, pts[k][1] + oz, pts[k][0], pts[k][1]);
          yr = lerp(edgeAt(seg), edgeAt(seg + 1), u);
        }
      } else {
        // A draped road's surface at its edge nearest this point.
        const t = d > half ? half / d : 1;
        yr = Math.max(rawHeight(cx + (x - cx) * t, cz + (z - cz) * t), WL + 0.15);
      }
      const cap = yr - UNDER + Math.max(0, d - half - SEAL);
      if (cap < h) h = cap;
    }
    // And under junctions, which reach past their roads at the corners.
    const near = jGrid.get(Math.floor(x / JCELL) * 100003 + Math.floor(z / JCELL));
    if (near)
      for (const id of near) {
        const sh = JPOLY[id];
        if (Math.hypot(x - sh.centre[0], z - sh.centre[1]) > sh.radius + SEAL + 2) continue;
        const [d, px, pz] = ringDist(sh.ring, x, z);
        if (d > SEAL + 2) continue;
        // (Deeper under a big island: its wide triangles cut corners off the ground.)
        // (A further part of a junction's paving is treated as the junction's own outline is.)
        const island = sh.fill && JX.fills[id - JX.shapes.length].tee === undefined;
        const cap = (island ? fillTop(id, px, pz) : Math.max(rawHeight(px, pz), WL + 0.15)) - (d === 0 && island ? 0.5 : UNDER) + Math.max(0, d - SEAL);
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
    if (r && r.d < halfNear(r.line, r.seg, r.u) + 0.3) return SURFACES.asphalt;
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
   * A strip's cross-section at pts[k] (drawn part lo..hi): the unit vector
   * across it (left of travel), and how far its sides stand out along the
   * mitre at a bend.
   */
  const section = (pts: XZ[], k: number, lo: number, hi: number, join?: (k: number) => { d: XZ; m: number } | null, bisect?: boolean) => {
    const jn = join?.(k) ?? null;
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
    const a = pts[Math.max(lo, k - 1)];
    const b = pts[Math.min(hi, k + 1)];
    const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let nx = (b[1] - a[1]) / tl;
    let nz = -(b[0] - a[0]) / tl;
    if (bisect && k > lo && k < hi) {
      const p = pts[k - 1], q = pts[k], r = pts[k + 1];
      const l1 = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, l2 = Math.hypot(r[0] - q[0], r[1] - q[1]) || 1;
      const dx = (q[0] - p[0]) / l1 + (r[0] - q[0]) / l2, dz = (q[1] - p[1]) / l1 + (r[1] - q[1]) / l2;
      const dl = Math.hypot(dx, dz);
      if (dl > 1e-6) (nx = dz / dl), (nz = -dx / dl);
    }
    if (jn) {
      nx = jn.d[1];
      nz = -jn.d[0];
    }
    return { nx, nz, mm };
  };
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
      /**
       * Cut to fit. A piece that is clear at some of its corners and not at
       * others is not dropped whole: it is cut into lengths of at most `sub`
       * metres and each is kept or dropped by itself, so a kerb or a line
       * ends where the thing it meets begins, not at the last of the road's
       * own points before it (which may be 20 m short).
       */
      sub?: number;
      /** With sub: the stretch along the road (in cum's metres) to be drawn at all. */
      span?: [number, number];
      /** With sub: must hold on the strip's middle line too (x, surface y, z, and the unit vector across the strip). */
      clearMid?: (x: number, y: number, z: number, cx: number, cz: number) => boolean;
      /** With sub: clearAt for the cut points between the road's own points (where clearAt allows something only at those). */
      clearInner?: (x: number, y: number, z: number) => boolean;
      /** The ground it lies on where it has no height of its own (the smooth ground if not given). */
      ground?: (x: number, z: number) => number;
      /** Square across the bisector of its two pieces at each bend (not across the line between the points either side, which leans towards the shorter piece). */
      bisect?: boolean;
      /**
       * With sub: dashes, `on` metres of every `period`, counted along `from`
       * (cum's metres to wherever the dashes are counted from: a run's start,
       * so they keep their rhythm from one road of it to the next).
       */
      dash?: { from: (s: number) => number; period: number; on: number };
    } = {},
  ) => {
    const base = acc.pos.length / 3;
    const lo = o.lo ?? 0;
    const hi = o.hi ?? pts.length - 1;
    for (let k = k0; k <= k1; k++) {
      const { nx, nz, mm } = section(pts, k, lo, hi, o.join, o.bisect);
      const half = (typeof halfIn === 'number' ? halfIn : halfIn(k)) * mm;
      const off = (o.off === undefined ? 0 : typeof o.off === 'number' ? o.off : o.off(k)) * mm;
      const [px, pz] = pts[k];
      // (Laid on the ground's mesh: raised by as much as the mesh rises
      // above the straight line from edge to edge, across its middle.)
      let rise = 0;
      if (o.ground && o.y === undefined && !(o.yAt && o.yAt(k) === o.yAt(k))) {
        const gAt = (f: number) => o.ground!(px + nx * (off + f * half), pz + nz * (off + f * half));
        const gl = gAt(-1), gr = gAt(1);
        for (const f of [-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75]) rise = Math.max(rise, gAt(f) - lerp(gl, gr, (f + 1) / 2));
      }
      // (The ground at the middle of the road's line, for a road at the ground: see tiltY.)
      const gMid = oneLine && o.tilt && o.yAt && o.tilt(k)[0] > 0 ? dropAt(px, pz) : 0;
      for (const sgn of [-1, 1]) {
        const x = px + nx * (off + sgn * half);
        const z = pz + nz * (off + sgn * half);
        // Never below the water: paths out over it become boardwalks.
        let yk = o.yAt ? o.yAt(k) : NaN;
        if (yk === yk && o.tilt) {
          const [tk, rk] = o.tilt(k);
          // (As tiltY: from the middle of the road's line.)
          if (tk > 0) yk = oneLine ? yk + tk * (dropAt(x, z) - gMid) : lerp(yk, Math.max(rawHeight(x, z), WL + 0.15) + rk, tk);
        }
        acc.pos.push(x, (yk === yk ? yk : (o.y ?? Math.max((o.ground ?? rawHeight)(x, z) + rise, WL + 0.15))) + lift, z);
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
    const sub = o.sub;
    const midOk = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
      if (!o.clearMid) return true;
      const w = Math.hypot(x1 - x0, z1 - z0) || 1;
      return o.clearMid((x0 + x1) / 2, (y0 + y1) / 2 - lift, (z0 + z1) / 2, (x1 - x0) / w, (z1 - z0) / w);
    };
    for (let k = k0; k < k1; k++) {
      if (o.keep && !o.keep(k)) continue;
      const a = base + (k - k0) * 2;
      if (sub) {
        const s0 = cum[k], s1 = cum[k + 1];
        const lo_s = o.span ? o.span[0] : -Infinity, hi_s = o.span ? o.span[1] : Infinity;
        if (s1 <= lo_s || s0 >= hi_s) continue;
        const at = (t: number) => {
          const v = [0, 0, 0, 0, 0, 0];
          for (let c = 0; c < 3; c++) {
            v[c] = lerp(P[a * 3 + c], P[(a + 2) * 3 + c], t);
            v[3 + c] = lerp(P[(a + 1) * 3 + c], P[(a + 3) * 3 + c], t);
          }
          return v;
        };
        const okAt = (v: number[], t: number) => {
          const ca = t > 1e-6 && t < 1 - 1e-6 ? o.clearInner ?? clearAt : clearAt;
          return (!ca || (ca(v[0], v[1] - lift, v[2]) && ca(v[3], v[4] - lift, v[5]))) && midOk(v[0], v[1], v[2], v[3], v[4], v[5]);
        };
        // (A dash's ends within this piece, and whether it is all one dash.)
        const dash = o.dash;
        const dashOn = (sAt: number) => {
          const r = dash!.from(sAt);
          return r - Math.floor(r / dash!.period) * dash!.period < dash!.on;
        };
        const dashCuts: number[] = [];
        if (dash) {
          const r0 = dash.from(s0), r1 = dash.from(s1);
          const lo = Math.min(r0, r1), hi = Math.max(r0, r1);
          for (let m = Math.floor(lo / dash.period) * dash.period; m < hi; m += dash.period)
            for (const e of [m, m + dash.on]) if (e > lo && e < hi) dashCuts.push((e - r0) / (r1 - r0));
        }
        const whole = !dashCuts.length && (!dash || dashOn((s0 + s1) / 2)) && s0 >= lo_s && s1 <= hi_s && (!clearAt || (corner(a) && corner(a + 1) && corner(a + 2) && corner(a + 3))) && okAt(at(0), 0) && okAt(at(0.5), 0.5) && okAt(at(1), 1);
        if (!whole) {
          if (dash && !dashCuts.length && !dashOn((s0 + s1) / 2)) continue;
          const n = Math.max(2, Math.ceil((s1 - s0) / sub));
          const ts: number[] = [];
          for (let q = 0; q <= n; q++) ts.push(q / n);
          for (const e of [lo_s, hi_s]) if (e > s0 && e < s1) ts.push((e - s0) / (s1 - s0));
          ts.push(...dashCuts);
          ts.sort((p, q) => p - q);
          let prev = -1;
          let tPrev = 0;
          for (const t of ts) {
            const sAt = lerp(s0, s1, t);
            const v = at(t);
            // (Between dashes: the last point ends one, this one may start the next.)
            if (dash && prev >= 0 && !dashOn(lerp(s0, s1, (tPrev + t) / 2))) prev = -1;
            tPrev = t;
            if (sAt < lo_s - 1e-6 || sAt > hi_s + 1e-6 || !okAt(v, t)) {
              prev = -1;
              continue;
            }
            const q = acc.pos.length / 3;
            acc.pos.push(v[0], v[1], v[2], v[3], v[4], v[5]);
            const ua = (a - 0) * 2, ub = (a + 2) * 2;
            acc.uv.push(lerp(acc.uv[ua], acc.uv[ub], t), lerp(acc.uv[ua + 1], acc.uv[ub + 1], t), lerp(acc.uv[ua + 2], acc.uv[ub + 2], t), lerp(acc.uv[ua + 3], acc.uv[ub + 3], t));
            if (prev >= 0) {
              faceUp(acc, prev, q, prev + 1);
              faceUp(acc, prev + 1, q, q + 1);
            }
            prev = q;
          }
          continue;
        }
      } else if (clearAt && !(corner(a) && corner(a + 1) && corner(a + 2) && corner(a + 3))) continue;
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
  const disc = (acc: Acc, x: number, z: number, r: number, lift: number, y?: number, ground: (x: number, z: number) => number = rawHeight) => {
    const base = acc.pos.length / 3;
    const yc = (y ?? Math.max(ground(x, z), WL + 0.15)) + lift;
    acc.pos.push(x, yc, z);
    acc.uv.push(0, 0);
    // (Two rings, so a pad draped on a slope follows it closely.)
    const n = 16;
    for (const f of [0.5, 1])
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const px = x + Math.cos(a) * r * f;
        const pz = z + Math.sin(a) * r * f;
        acc.pos.push(px, (y ?? Math.max(ground(px, pz), WL + 0.15)) + lift, pz);
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
    box: flatMat(0xe0b52a, -5),
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
  // (A joined line is as wide at a joint as it is drawn there: see halfNear.)
  const halfEnd = (i: number, j: number) => (edges[i].ws ? halfAtE(i, edges[i].a === j ? 0 : EP[i].length - 1) : EHALF[i]);
  const jRadius = jEdges.map((list, j) => Math.max(0, ...list.map((i) => halfEnd(i, j))));
  // At a two-way joint, the half width of the other piece.
  const other = (j: number, me: number) => {
    const l = jEdges[j];
    const o = l[0] === me ? l[1] : l[0];
    return o === undefined ? EHALF[me] : halfEnd(o, j);
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
    // (A road running through a tee meets its next piece the same way.)
    const o = JX.tee[j] ? thruMate(i, j) : jDegree[j] !== 2 ? undefined : jEdges[j][0] === i ? jEdges[j][1] : jEdges[j][0];
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
    // (An opening in a divider: paved from both sides, each road's joint its half.)
    if (openingLink(i)) return true;
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
      // (At a tee: the next piece of the same through road is no other road,
      // and the side road is not drawn inside the through road, only from
      // its mouth.)
      if (thruMate(line, edges[line].a) === i || thruMate(line, edges[line].b) === i) return;
      // (Nor is an opening in a divider a road of its own: it is paved from
      // the two roads' joints. Unless nothing is paved there, the road's two
      // sides overlapping across it: then the crossing road runs over the
      // marks just the same.)
      if (openingLink(i)) {
        if (!JX.bare[i]) return;
        // (Over it, only this road's side towards the other: its lane lines
        // carry on past the opening as past any side road's mouth.)
        const ea = edges[i].a, eb = edges[i].b;
        const own = edges[line].a === ea || edges[line].b === ea ? ea : edges[line].a === eb || edges[line].b === eb ? eb : -1;
        if (own < 0) return;
        // (Where the side road carries on across both sides, a crossing, it
        // runs over all of them.)
        const sideBeyond = (j: number) => jE[j].some((k) => k !== i && !thruEnd(k, j));
        if (!(sideBeyond(ea) && sideBeyond(eb))) {
          const far = M.junctions[own === ea ? eb : ea], o = M.junctions[own];
          if (Math.hypot(x - far[0], z - far[1]) > Math.hypot(o[0] - far[0], o[1] - far[1]) - 0.5 * halfAtE(line, 0)) return;
        }
      }
      if (JX.tee[edges[i].a] || JX.tee[edges[i].b]) {
        const at = ECUM[i][seg] + u * (ECUM[i][seg + 1] - ECUM[i][seg]);
        if ((JX.tee[edges[i].a] && at < JX.trimA[i]) || (JX.tee[edges[i].b] && at > ELEN[i] - JX.trimB[i])) return;
      }
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
  /** (deck: how deep the deck is where both roads are decks, 0 between raised roads on the ground, -1 between roads lying on the ground.) */
  const gores: { ring: XZ[]; rows: { a: XZ; b: XZ; ya: number; yb: number }[]; deck: number }[] = [];
  const goreDeck = (A: number, B: number) => (isDeck[A] && isDeck[B] ? (elevated[A] || elevated[B] ? 1.2 : 0.6) : hasProfile[A] || hasProfile[B] ? 0 : -1);
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
        const P = EP[i][k], Q = EP[i][Math.min(EP[i].length - 1, k + 1)];
        y = tiltY(i, s, y, x, z, lerp(P[0], Q[0], u), lerp(P[1], Q[1], u));
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
            if (rows.length >= 2) gores.push({ ring: [...rows.map((r) => r.a), ...rows.map((r) => r.b).reverse()], rows, deck: goreDeck(A, B) });
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
            gores.push({ ring: [...rows.map((r) => r.a), ...rows.map((r) => r.b).reverse()], rows, deck: beside >= 0 ? goreDeck(A, beside) : -1 });
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
  // A raised road's wall and parapet, by how far the ground beside it lies
  // below the road: the wall's top stands a kerb's lip above the road once
  // the drop is that of a kerb, the parapet rises from nothing at
  // PARAPET_FROM to its full height at PARAPET_FULL.
  const PARAPET_FROM = 0.6;
  const PARAPET_FULL = 1.2;
  const PARAPET_H = 0.95;
  // (Drops are from the road's drawn surface. Beside every road the ground
  // is sealed UNDER below the road's own height, ROAD_LIFT + UNDER below
  // its surface: that is no drop at all. A wall begins a kerb's lip, 10 cm,
  // past it. From a plain 10 cm, every raised road stood on a low wall
  // along its whole length, a kerb raised well above the road.)
  const WALL_FROM = ROAD_LIFT + UNDER + 0.1;
  const wallTop = (drop: number) => 0.05 * smoothstep(WALL_FROM, WALL_FROM + 0.15, drop);
  const parapetTop = (drop: number) => Math.max(wallTop(drop), PARAPET_H * smoothstep(PARAPET_FROM, PARAPET_FULL, drop));
  const besideMid = (line: number, kk: number, off: number): XZ => {
    const a = EP[line][kk];
    const b = EP[line][kk + 1];
    const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(a[0] + b[0]) / 2 + ((b[1] - a[1]) / tl) * off, (a[1] + b[1]) / 2 - ((b[0] - a[0]) / tl) * off];
  };
  const parapetClear = (line: number, kk: number, off: number) => {
    const [x, z] = besideMid(line, kk, off);
    const y = hasProfile[line] ? (deckY(line)[kk] + deckY(line)[kk + 1]) / 2 : NaN;
    if (coveredBy(line, x, z, y) || onIsland(x, z, y) || inPaving(x, z, y) || inGore(x, z)) return false;
    const [x2, z2] = besideMid(line, kk, off + Math.sign(off) * 0.45);
    return !onTeeOf(line, x2, z2);
  };
  // Walls round a joint. Where roads meet, the joint's own outline carries
  // on what the roads' edges have: along every kerbed stretch of it, a deck's
  // edge beam and parapet, or a raised road's retaining wall and (where the
  // ground falls away) its parapet. So a wall runs through a joint unbroken,
  // and no deck's edge is left open where its branches part.
  /** A parapet the car can lean on: from (x0, z0) to (x1, z1), h tall from y up. */
  const barrierBox = (body: ReturnType<TileKit['body']>, x0: number, z0: number, x1: number, z1: number, y: number, h: number) => {
    const sl = Math.hypot(x1 - x0, z1 - z0);
    if (sl < 0.3) return;
    const yaw = Math.atan2(-(z1 - z0) / sl, (x1 - x0) / sl);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(sl / 2 + 0.15, h / 2 + 0.125, 0.25)
        .setTranslation((x0 + x1) / 2, y + h / 2 + 0.025, (z0 + z1) / 2)
        .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }),
      body,
    );
  };
  interface JointWall { W: XZ[]; cum: number[]; y: number[]; drop: number[]; keep: boolean[] }
  /** How deep the deck is at joint `id` (0: not on a deck), or -1 where no road at it is raised at all. */
  const jointDeck = (id: number) => {
    const fill = id < JX.shapes.length ? undefined : JX.fills[id - JX.shapes.length];
    const es = (fill ? (fill.tee !== undefined ? [fill.tee] : []) : JX.shapes[id].nodes).flatMap((j) => jE[j]);
    if (!es.some((i) => hasProfile[i])) return -1;
    return es.every((i) => isDeck[i]) ? (es.some((i) => elevated[i]) ? 1.2 : 0.6) : 0;
  };
  /** Is a road's own surface (the part of it that is drawn) at (x, z), near height y? */
  const drawnRoadAt = (x: number, z: number, y: number) => {
    let hit = false;
    roads.each(x, z, 16, (i, seg, u, d) => {
      if (hit || JX.internal[i] || d > halfNear(i, seg, u) + 0.2) return;
      const at = ECUM[i][seg] + u * (ECUM[i][seg + 1] - ECUM[i][seg]);
      if (at < (JX.trimA[i] || 0) - 0.05 || at > ELEN[i] - (JX.trimB[i] || 0) + 0.05) return;
      hit = Math.abs((hasProfile[i] ? deckAtHit(i, seg, u) : heightAt(x, z)) - y) < 3;
    });
    return hit;
  };
  const jointWallCache = new Map<number, JointWall[]>();
  /** How far above the ground a deck joint's edge must stand to be drawn as a deck's (edge beam, full parapet). */
  const JOINT_DECK_FROM = 2;
  /** Is piece q of a joint's wall a deck's edge? */
  const deckPiece = (w: JointWall, q: number) => Math.min(w.drop[q], w.drop[q + 1]) >= 99;
  const jointWalls = (id: number) => {
    let out = jointWallCache.get(id);
    if (out) return out;
    out = [];
    jointWallCache.set(id, out);
    const sh = JPOLY[id];
    const deck = jointDeck(id);
    if (deck < 0) return out;
    for (const F of sh.kerbs) {
      if (F.length < 2) continue;
      const nrm = (q: number): XZ => {
        const a = F[Math.max(0, q - 1)];
        const b = F[Math.min(F.length - 1, q + 1)];
        const [tx, tz] = unit(b[0] - a[0], b[1] - a[1]);
        return [tz, -tx];
      };
      // (Which side of the kerb is out of the joint.)
      const m = F.length >> 1;
      const mid: XZ = F.length === 2 ? [(F[0][0] + F[1][0]) / 2, (F[0][1] + F[1][1]) / 2] : F[m];
      const [mx, mz] = nrm(m);
      const sgn = inRingXZ(sh.ring, mid[0] + mx * 0.5, mid[1] + mz * 0.5) && !inRingXZ(sh.ring, mid[0] - mx * 0.5, mid[1] - mz * 0.5) ? -1 : 1;
      const W: XZ[] = [];
      const cum: number[] = [];
      const y: number[] = [];
      const drop: number[] = [];
      F.forEach((p, q) => {
        const [nx, nz] = nrm(q);
        W.push([p[0] + nx * sgn * 0.45, p[1] + nz * sgn * 0.45]);
        cum.push(q ? cum[q - 1] + Math.hypot(p[0] - F[q - 1][0], p[1] - F[q - 1][1]) : 0);
        y.push(jTop(id, p[0], p[1]) + 0.09);
        // (On a deck, a deck's edge where it stands well up; where a deck
        // road comes down to the ground at the joint, its edge is the
        // ground's, as on any raised road.)
        const real = y[q] - heightAt(p[0] + nx * sgn * 1.05, p[1] + nz * sgn * 1.05);
        drop.push(deck && real >= JOINT_DECK_FROM ? 99 : real);
      });
      const keep: boolean[] = [];
      for (let q = 0; q + 1 < F.length; q++) {
        const [nx, nz] = nrm(q);
        const x = (W[q][0] + W[q + 1][0]) / 2, z = (W[q][1] + W[q + 1][1]) / 2, ym = (y[q] + y[q + 1]) / 2;
        const along = (t: number) => inPaving(lerp(F[q][0], F[q + 1][0], t), lerp(F[q][1], F[q + 1][1], t), NaN, id);
        keep.push(!(along(0.25) || along(0.5) || along(0.75)) && !drawnRoadAt(x, z, ym) && !drawnRoadAt(x + nx * sgn * 0.6, z + nz * sgn * 0.6, ym) && !inPaving(x, z, ym, id) && !onIsland(x, z) && !inGore(x, z));
      }
      if (keep.some(Boolean)) out.push({ W, cum, y, drop, keep });
    }
    return out;
  };
  // The nose of a split. Where the paved wedge between two roads ends and
  // the verge between them begins, the end is closed: a kerb across it from
  // one road's edge to the other's and, between raised roads, their wall and
  // parapet carried across too (on a deck, its edge beam). So the kerbs and
  // walls of the two roads start from one nose, not each from its own
  // square end with a hole between them.
  interface GoreCap { a: XZ; b: XZ; ya: number; yb: number; d: XZ; drop: number }
  const goreCapCache = new Map<number, GoreCap[]>();
  const goreCaps = (id: number) => {
    let out = goreCapCache.get(id);
    if (out) return out;
    out = [];
    goreCapCache.set(id, out);
    const { rows, deck } = gores[id];
    const n = rows.length;
    for (const [e, i] of [[0, 1], [n - 1, n - 2]]) {
      const r = rows[e], q = rows[i];
      if (Math.hypot(r.a[0] - r.b[0], r.a[1] - r.b[1]) < 0.9) continue;
      const mx = (r.a[0] + r.b[0]) / 2, mz = (r.a[1] + r.b[1]) / 2;
      const d = unit(mx - (q.a[0] + q.b[0]) / 2, mz - (q.a[1] + q.b[1]) / 2);
      const y = (r.ya + r.yb) / 2;
      // (Only where the verge really begins: not where another road, a junction or the next wedge takes over.)
      const x = mx + d[0] * 0.8, z = mz + d[1] * 0.8;
      if (drawnRoadAt(x, z, y) || inGore(x, z) || inPaving(x, z, y) || onIsland(x, z, y) || jGrid.get(Math.floor(x / JCELL) * 100003 + Math.floor(z / JCELL))?.some((k) => inRingXZ(JPOLY[k].ring, x, z) && Math.abs(jTop(k, x, z) - y) < 3)) continue;
      out.push({ a: r.a, b: r.b, ya: r.ya, yb: r.yb, d, drop: deck > 0 ? 99 : deck < 0 ? 0 : y + 0.09 - heightAt(mx + d[0] * 1.05, mz + d[1] * 1.05) });
    }
    return out;
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
          for (const c of goreCaps(id)) {
            // (A nose on the ground has its kerb from the outline on a redrawn map.)
            if (!oneLine) {
              const kerb = acc('kerb');
              const kb = kerb.pos.length / 3;
              for (const [p, y] of [[c.a, c.ya], [c.b, c.yb]] as [XZ, number][])
                for (const o of [-0.05, 0.3]) {
                  kerb.pos.push(p[0] + c.d[0] * o, y + 0.07, p[1] + c.d[1] * o);
                  kerb.uv.push(p[0] / 6, p[1] / 6);
                }
              faceUp(kerb, kb, kb + 2, kb + 1);
              faceUp(kerb, kb + 1, kb + 2, kb + 3);
            }
            const dk = gores[id].deck;
            if (dk < 0) continue;
            const deck = acc('deck');
            const W: XZ[] = [[c.a[0] + c.d[0] * 0.3, c.a[1] + c.d[1] * 0.3], [c.b[0] + c.d[0] * 0.3, c.b[1] + c.d[1] * 0.3]];
            const cw = [0, Math.hypot(c.a[0] - c.b[0], c.a[1] - c.b[1])];
            const yk = (q: number) => (q ? c.yb : c.ya) + 0.09;
            if (dk > 0) {
              band(deck, W, cw, 0, 1, 0, yk, dk, 0.05, () => true);
              band(deck, W, cw, 0, 1, 0, yk, 0, PARAPET_H, () => true);
            } else if (c.drop > WALL_FROM) {
              band(deck, W, cw, 0, 1, 0, yk, Math.max(0, c.drop) + 0.3, wallTop(c.drop), () => true);
              if (c.drop > PARAPET_FROM) band(deck, W, cw, 0, 1, 0, yk, 0, parapetTop(c.drop), () => true);
            }
          }
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
    // (The parapet across a nose stops the car as the roads' own do.)
    for (const [k, all] of byTile)
      inChunks('near', k, 'nose barriers', all.filter((id) => gores[id].deck >= 0), 10, (list, kit) => {
        for (const id of list)
          for (const c of goreCaps(id)) {
            const h = gores[id].deck > 0 ? PARAPET_H : parapetTop(c.drop);
            if (h >= 0.3) barrierBox(tileBody(kit), c.a[0] + c.d[0] * 0.3, c.a[1] + c.d[1] * 0.3, c.b[0] + c.d[0] * 0.3, c.b[1] + c.d[1] * 0.3, (c.ya + c.yb) / 2 + 0.09, h);
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
  /**
   * The lines of a paired road (the two sides of a dual carriageway drawn
   * as one): a painted median, two solid lines where the sides met, and
   * each side's lane lines counted out from it, so where the road widens
   * or narrows it is the kerbside lane that comes or goes. Each as [how
   * far left of the road's line, dashed?, the half-width the road must
   * have there for the line to be on it].
   */
  /** A paired road's painted median at fraction f along it: its offset to the left of the road's line, and its width. (Eased along the road where two pieces differ: `ms`, from the redraw.) */
  const medianAt = (i: number, f: number): [number, number] => {
    const e = edges[i];
    const ms = e.ms;
    if (!ms || !ms.length) return [e.mo ?? 0, e.med ?? 0];
    let k = 0;
    while (k < ms.length - 2 && ms[k + 1][0] <= f) k++;
    const a = ms[k], b = ms[Math.min(ms.length - 1, k + 1)];
    const u = b[0] > a[0] ? Math.max(0, Math.min(1, (f - a[0]) / (b[0] - a[0]))) : 0;
    return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  };
  const PAIR_LANE = 3.3;
  const PAIR_LANES = 5;
  /**
   * A paired road's lines at fraction f along it, each [offset left of the
   * road's line, dashed?, the half width the road needs for it]: the two
   * solid lines of its median, and lane lines every PAIR_LANE m counted
   * out from the median on each side (always the same list, in the same
   * order; a line is drawn only where the road is wide enough for it).
   * Counted from the median at one lane width, a line keeps its place all
   * along the road, whatever the pieces it was put together from.
   */
  const pairedLines = (i: number, f = 0.5): [number, boolean, number][] => {
    const [mid, med] = medianAt(i, f);
    const gap = Math.max(0.5, Math.min(med, 4)) / 2;
    const out: [number, boolean, number][] = [];
    for (const sgn of [-1, 1]) {
      out.push([mid + sgn * gap, false, 0]);
      for (let l = 1; l <= PAIR_LANES; l++) out.push([mid + sgn * (gap + l * PAIR_LANE), true, sgn * mid + gap + (l + 0.6) * PAIR_LANE]);
    }
    return out.sort((x, y) => x[0] - y[0]);
  };
  {
    const COS30 = Math.cos((30 * Math.PI) / 180);
    const lanesOf = (i: number) => Math.max(1, Math.round((edges[i].w - 0.7) / 3.3));
    /** A give-way line across a road's mouth at junction id, if it comes in there and carries markings. */
    const giveWay = (id: number, m: (typeof JX.shapes)[number]['mouths'][number]) => {
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
    };
    JX.shapes.forEach((sh, id) => {
      const M = sh.mouths;
      // (A tee: the road running through has the right of way, unless the side road is the bigger.)
      if (sh.nodes.length === 1 && JX.tee[sh.nodes[0]]) {
        const j = sh.nodes[0];
        const top = Math.max(...jE[j].filter((i) => thruEnd(i, j)).map((i) => rankOf(edges[i].cls)));
        // (Not a slip road: it leaves or joins in its own lane.)
        for (const m of M) if (!crossEnd.has(`${m.line}:${m.end}`) && rankOf(edges[m.line].cls) <= top && !/^(motorway|trunk)|_link$/.test(edges[m.line].cls)) giveWay(id, m);
        return;
      }
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
        if (!onAxis.has(q)) giveWay(id, m);
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
            // (The lane width the road itself draws its lines at: see laneWOf.)
            const w = laneWOf(i), n = Math.max(lanesOf(i), Math.floor((2 * EHALF[i]) / w + 0.01));
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
        } else if (paired(ea) && paired(eb)) {
          // A paired road's lines carry on across, matched from the median outwards.
          const offs = (m: typeof A, i: number, sg: number) =>
            pairedLines(i, m.end)
              .filter(([, , need]) => m.half > need)
              .map(([o, d]) => [sg * o, d] as [number, boolean])
              .sort((x, y) => x[0] - y[0]);
          const oa = offs(A, A.line, sa), ob = offs(B, B.line, sb);
          const ia = oa.findIndex(([, d]) => !d), ib = ob.findIndex(([, d]) => !d);
          if (rank >= 1) for (let d = -Math.min(ia, ib); ia + d < oa.length && ib + d < ob.length; d++) line(oa[ia + d][0], ob[ib + d][0], 'white', oa[ia + d][1] && ob[ib + d][1]);
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
    // (A road running through a tee carries its markings straight through.)
    const stopAt = (j: number, trim: number) => (trim > 0 ? trim + 1 : thruMate(line, j) !== undefined && (JX.tee[j] || jDegree[j] === 2) ? -1 : jDegree[j] === 2 ? 0.3 : jDegree[j] > 2 ? jRadius[j] + 2 : 2);
    return [
      // (A strip has no mouth: its crossing lies clear of its side roads' mouths.)
      crossEnd.has(`${line}:0`) ? (thruEnd(line, e.a) ? crossEnd.get(`${line}:0`)!.s : JX.trimA[line]) + STOP_AT + 0.5 : stopAt(e.a, JX.trimA[line]),
      crossEnd.has(`${line}:1`) ? (thruEnd(line, e.b) ? crossEnd.get(`${line}:1`)!.s : JX.trimB[line]) + STOP_AT + 0.5 : stopAt(e.b, JX.trimB[line]),
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
        // (On a redrawn map a road on the ground has its kerbs from the outline: see 'outline'.)
        if ((kerbedRoad(e) || dy) && !JX.internal[line] && !outlined[line])
          for (const sgn of [-1, 1]) {
            // Each side's kerb, except where it runs inside a paved island or
            // a junction (a road overlapping a junction past its mouth).
            const off = (kk: number) => sgn * (halfAt(kk) + 0.1);
            // (On another road's surface, where two roads merge or run
            // side by side, a kerb would stand across its lanes. Nor along
            // the paving of a joint this road runs through.)
            // (Cut to fit, half a metre at a time: it ends where the other
            // road, the junction or the wedge begins.)
            const clearMid = (x0: number, y: number, z0: number, cx: number, cz: number) => {
              const x = x0 + cx * sgn * 0.1, z = z0 + cz * sgn * 0.1;
              const yy = dy ? y : NaN;
              return !(onIsland(x, z, yy) || inPaving(x, z, yy) || coveredBy(line, x, z, yy) || inGore(x, z) || onTeeOf(line, x + cx * sgn * 0.7, z + cz * sgn * 0.7));
            };
            const clearAt = (x: number, y: number, z: number) => !inPaving(x, z, dy ? y : NaN) && !coveredBy(line, x, z, dy ? y : NaN);
            strip(kerb, P, cum, lo, hi, 0.25, 0.07, { ...opt, off, clearAt, clearMid, sub: 0.5 });
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
          return !coveredBy(line, x, z, y) && !onIsland(x, z, y) && !inPaving(x, z, y);
        };
        const clear = clearOn(pts);
        if (dy && !isDeck[line]) {
          // A raised road: where the ground beside it falls away (its bank
          // was cut short by a road below), a retaining wall, and a parapet
          // where the drop is more than a kerb.
          const deck = acc('deck');
          const ext = runsOn(line, P);
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
              // (The ground just past the wall, or a metre further out if lower there: the fall a car would go over.)
              const g = (o: number) => heightAt(P[kk][0] + ((b[1] - a[1]) / tl) * o, P[kk][1] - ((b[0] - a[0]) / tl) * o);
              dr[kk - lo] = dy[kk] + 0.09 - Math.min(g(off(kk) + sgn * 0.6), g(off(kk) + sgn * 1.6));
            }
            const y = (kk: number) => dy[kk] + 0.09;
            // (Both grow with the drop: the wall comes out of the ground from
            // nothing, and the parapet rises to its full height as the drop
            // passes that of a kerb, as a crash barrier's end ramps up. Neither
            // begins or ends as a square stub standing on the verge.)
            band(deck, P, cum, lo, hi, off, y, (kk) => Math.max(0, dr[kk - lo]) + 0.3, (kk) => wallTop(dr[kk - lo]), (kk) => Math.max(dr[kk - lo], dr[kk + 1 - lo]) > WALL_FROM && !inGore(...besideMid(line, kk, off(kk))) && !inGore(...besideMid(line, kk, off(kk) - sgn * 0.3)) && !onTeeOf(line, ...besideMid(line, kk, off(kk) + sgn * 0.45)), ext(sgn));
            band(deck, P, cum, lo, hi, off, y, 0, (kk) => parapetTop(dr[kk - lo]), (kk) => Math.max(dr[kk - lo], dr[kk + 1 - lo]) > PARAPET_FROM && parapetClear(line, kk, off(kk)), ext(sgn));
          }
        }
        if (dy && isDeck[line]) {
          // Deck sides: a concrete edge beam, an underside and parapets.
          const deck = acc('deck');
          const depth = elevated[line] ? 1.2 : 0.6;
          const side = (sgn: number) => (kk: number) => sgn * (halfAt(kk) + 0.45);
          const y = (kk: number) => dy[kk] + 0.09;
          const ext = runsOn(line, pts);
          for (const sgn of [-1, 1]) {
            band(deck, pts, cum, k0, k1, side(sgn), y, depth, 0.05, () => true, ext(sgn));
            band(deck, pts, cum, k0, k1, side(sgn), y, 0, 0.95, (kk) => parapetClear(line, kk, side(sgn)(kk)), ext(sgn));
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
        // (No edge line across a slip road's opening: along a junction's
        // paving that this road runs through as one strip.)
        // (A slip road's only, whatever the road: past a side road that
        // comes in square a road's lines run on, as its kerb line would.)
        const openings = teePaving().get(line);
        const openAt = (kk: number, off: number) => {
          if (!openings) return false;
          const a = mp[kk], b = mp[kk + 1];
          const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          const o = off + Math.sign(off) * 0.8;
          const x = (a[0] + b[0]) / 2 + ((b[1] - a[1]) / tl) * o, z = (a[1] + b[1]) / 2 - ((b[0] - a[0]) / tl) * o;
          return openings.some((id) => inRingXZ(JPOLY[id].ring, x, z));
        };
        // (Every line is cut to fit, half a metre at a time: it ends where
        // the junction, the other road or the opening begins, so the lines
        // of two roads that come together end at the same place.)
        const drawn = (kk: number) => (!thA || kk >= cut.lo) && (!thB || kk < cut.hi);
        const span: [number, number] = [thA ? -Infinity : ca, thB ? Infinity : len - cb];
        const openXZ = (x: number, z: number) => !!openings && openings.some((id) => inRingXZ(JPOLY[id].ring, x, z));
        /** A line `side` of the middle (1 left, -1 right, 0 the middle line): solid lines stop across a slip road's opening. */
        const fit = (side: number, solidLine: boolean) => ({
          span,
          sub: 0.5,
          clearAt: lineClear,
          clearInner: (x: number, y: number, z: number) => !inPaving(x, z, dy ? y : NaN) && !coveredBy(line, x, z, dy ? y : NaN),
          clearMid: (x: number, y: number, z: number, cx: number, cz: number) => !onIsland(x, z, dy ? y : NaN) && !(solidLine && openXZ(x + cx * side * 0.8, z + cz * side * 0.8)),
        });
        const solid = (_off: (kk: number) => number) => drawn;
        // (On a redrawn map dashes are counted along the road's whole run,
        // 4 m in every 12, so they keep their rhythm from one road of it to
        // the next. Today's map: one piece in three.)
        const R0 = runOf[line];
        const DASH = oneLine ? { from: (sAt: number) => R0.at + (R0.fwd ? sAt : len - sAt), period: 12, on: 4 } : undefined;
        const dashed = (_off: (kk: number) => number) => (DASH ? drawn : (kk: number) => kk % 3 === 0 && drawn(kk));
        void ends;
        void clearM;
        void openAt;
        if (rank >= 2 && !outlined[line]) {
          const l = (kk: number) => halfAt(kk) - 0.35;
          const r = (kk: number) => -(halfAt(kk) - 0.35);
          strip(yellow, mp, cum, k0, k1, 0.07, 0.11, { ...mo, off: l, keep: solid(l), yAt, tilt, ...fit(1, true) });
          strip(yellow, mp, cum, k0, k1, 0.07, 0.11, { ...mo, off: r, keep: solid(r), yAt, tilt, ...fit(-1, true) });
        }
        const lanes = Math.max(1, Math.round((e.w - 0.7) / 3.3));
        if (e.one) {
          // Lane lines follow the lanes: each a full lane's width from the
          // last, counted from the right-hand (fast) side, so where the
          // road tapers the lines run on straight and the nearside lane
          // narrows until its line ends (a lane dropped, or one added),
          // rather than every lane squeezing.
          const laneW = laneWOf(line);
          for (let l = 1; l < Math.max(lanes, Math.floor((2 * EHALF[line]) / laneW + 0.01)); l++) {
            const off = (kk: number) => -halfAt(kk) + l * laneW;
            const room = (kk: number) => halfAt(kk) - off(kk) > 0.6 * laneW && halfAt(kk + 1) - off(kk + 1) > 0.6 * laneW;
            strip(white, mp, cum, k0, k1, 0.07, 0.11, { ...mo, off, keep: (kk) => room(kk) && dashed(off)(kk), yAt, tilt, ...fit(0, false), dash: DASH });
          }
        } else if (paired(e)) {
          // (Each line's place at every point along the road: the median may ease sideways.)
          const PL = cum.map((c) => pairedLines(line, len > 0 ? c / len : 0));
          for (let q = 0; q < PL[0].length; q++) {
            const broken = PL[0][q][1];
            const off = (kk: number) => PL[kk][q][0];
            const fits = (kk: number) => halfAt(kk) > PL[kk][q][2] && halfAt(kk + 1) > PL[kk + 1][q][2];
            strip(white, mp, cum, k0, k1, 0.07, 0.11, { ...mo, off, keep: (kk) => fits(kk) && (broken ? dashed(off)(kk) : solid(off)(kk)), yAt, tilt, ...fit(Math.sign(off(Math.min(k0 + 1, k1))), !broken), dash: broken ? DASH : undefined });
          }
        } else if (rank >= 1 && e.w >= 6) {
          const off = () => 0;
          strip(white, mp, cum, k0, k1, 0.07, 0.11, { ...mo, keep: rank >= 3 ? solid(off) : dashed(off), yAt, tilt, ...fit(0, rank >= 3), dash: rank >= 3 ? undefined : DASH });
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
      if (!ok || i === self || d > halfNear(i, seg, u) + 1.2) return;
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
            // A raised road only needs one where its side drops away: as
            // tall as the parapet drawn there (it ramps up with the drop).
            const ph = isDeck[line] ? PARAPET_H : parapetTop(y - heightAt(mx + dz * sgn * 0.6, mz - dx * sgn * 0.6));
            if (ph < 0.3) continue;
            world.createCollider(
              RAPIER.ColliderDesc.cuboid(sl / 2 + 0.15, ph / 2 + 0.125, 0.25)
                .setTranslation(mx, y + ph / 2 + 0.025, mz)
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
      // (At the joint, the middle of every road's line: on a redrawn map, each road's own height there.)
      sum += oneLine ? y : lerp(y, dropAt(x, z) + relAlong(i, s), t);
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
    // (Nor does a joint in the middle of a strip: the road's one ribbon runs
    // through it. A flat pad there lay over a ramp as a second sheet, 0.2 m
    // proud a few metres down the slope.)
    if (jDegree[j] === 2 && thruJoint(jEdges[j][0], j) === jEdges[j][1]) return;
    // (Nor a dead end on a raised or ramped road: there is no wedge to
    // fill, and a flat pad over a road end that leans with the ground
    // beside it stood up from it as a step.)
    if (jDegree[j] === 1 && hasProfile[jEdges[j][0]]) return;
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
        const r = jDegree[j] === 2 ? (halfEnd(jEdges[j][0], j) + halfEnd(jEdges[j][1], j)) / 2 : jRadius[j];
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
  // (The parapets round a joint stop the car as the roads' own do.)
  for (const [k, all] of shapesByTile)
    inChunks('near', k, 'joint barriers', all.filter((id) => jointDeck(id) >= 0 && JPOLY[id].kerbs.length), 4, (list, kit) => {
      for (const id of list) {
        for (const w of jointWalls(id))
          for (let q = 0; q + 1 < w.W.length; q++) {
            if (!w.keep[q]) continue;
            const h = deckPiece(w, q) ? PARAPET_H : (parapetTop(Math.min(w.drop[q], 9)) + parapetTop(Math.min(w.drop[q + 1], 9))) / 2;
            if (h >= 0.3) barrierBox(tileBody(kit), w.W[q][0], w.W[q][1], w.W[q + 1][0], w.W[q + 1][1], (w.y[q] + w.y[q + 1]) / 2, h);
          }
      }
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
          // (An edge line across the paving comes from the outline on a redrawn map.)
          if (oneLine && ln.kind === 'yellow') continue;
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
        // A slip road's wedge has an edge line along its outside, from where
        // the road it leaves stops its own (across the opening) to the slip
        // road's mouth, where the slip road's own line carries on.
        if (part === 0 && id < JX.shapes.length && JX.shapes[id].slip && JX.shapes[id].nodes.length === 1 && !oneLine) {
          const j = JX.shapes[id].nodes[0];
          const ring = JPOLY[id].ring;
          if (JX.tee[j] && jE[j].every((i) => rankOf(edges[i].cls) >= 2)) {
            const parts = [id, ...JX.fills.map((f, q) => (f.tee === j ? JX.shapes.length + q : -1)).filter((q) => q >= 0)];
            const topAt = (x: number, z: number) => paveY(parts.find((q) => inRingXZ(JPOLY[q].ring, x, z)) ?? id, x, z);
            for (const K of JPOLY[id].kerbs) {
              // (A point every metre and a half or so is plenty for the line: the kerb's are a metre apart.)
              const F: XZ[] = K.filter((p, q) => q === 0 || q === K.length - 1 || Math.hypot(p[0] - K[q - 1][0], p[1] - K[q - 1][1]) > 1.2 || q % 2 === 0);
              let run = 0;
              for (let q = 1; q < F.length; q++) run += Math.hypot(F[q][0] - F[q - 1][0], F[q][1] - F[q - 1][1]);
              if (F.length < 3 || run < 6) continue;
              const nrm = (q: number): XZ => {
                const a = F[Math.max(0, q - 1)];
                const b = F[Math.min(F.length - 1, q + 1)];
                const [tx, tz] = unit(b[0] - a[0], b[1] - a[1]);
                return [tz, -tx];
              };
              const m = F.length >> 1;
              const [mx, mz] = nrm(m);
              // (Into the paving from its kerb, as far as a road's edge line lies inside its edge.)
              const sgn = inRingXZ(ring, F[m][0] + mx * 0.5, F[m][1] + mz * 0.5) ? 1 : -1;
              const yellow = acc('yellow');
              const base = yellow.pos.length / 3;
              const ok: boolean[] = [];
              F.forEach((p, q) => {
                const [nx, nz] = nrm(q);
                const cx = p[0] + nx * sgn * 0.35, cz = p[1] + nz * sgn * 0.35;
                // (Not inside the lines of the road it leaves, where the two are still one surface.)
                const h = roads.nearest(cx, cz, 30, (i) => thruEnd(i, j));
                // (Nor on another junction's paving or an island: the line is this wedge's own.)
                const other = jGrid.get(Math.floor(cx / JCELL) * 100003 + Math.floor(cz / JCELL))?.some((q) => !parts.includes(q) && inRingXZ(JPOLY[q].ring, cx, cz));
                ok.push(!(h && h.d < halfNear(h.line, h.seg, h.u) - 0.3) && !other);
                for (const o of [-0.07, 0.07]) {
                  const x = cx + nx * o, z = cz + nz * o;
                  yellow.pos.push(x, topAt(x, z) + 0.115, z);
                  yellow.uv.push(x / 6, z / 6);
                }
              });
              for (let q = 0; q + 1 < F.length; q++) {
                if (!ok[q] || !ok[q + 1]) continue;
                const v = base + q * 2;
                faceUp(yellow, v, v + 2, v + 1);
                faceUp(yellow, v + 1, v + 2, v + 3);
              }
            }
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
          // (On a deck the joint has an underside, as its roads have.)
          const dk = jointDeck(id);
          if (dk > 0) {
            const deck = acc('deck');
            const db = deck.pos.length / 3;
            for (let v = base; v < road.pos.length / 3; v++) {
              deck.pos.push(road.pos[v * 3], road.pos[v * 3 + 1] - lift + 0.09 - dk, road.pos[v * 3 + 2]);
              deck.uv.push(road.uv[v * 2], road.uv[v * 2 + 1]);
            }
            for (let i = 0; i < n; i++) {
              const i1 = (i + 1) % n;
              deck.idx.push(db, db + 1 + i1, db + 1 + i);
              for (let r = 0; r + 1 < RINGS.length; r++) {
                const a = db + 1 + r * n;
                const b = a + n;
                deck.idx.push(a + i, a + i1, b + i1, a + i, b + i1, b + i);
              }
            }
          }
        }
        if (part === 2) {
          const dk = jointDeck(id);
          for (const w of jointWalls(id)) {
            const deck = acc('deck');
            const last = w.W.length - 1;
            const yk = (q: number) => w.y[q];
            if (dk > 0) {
              band(deck, w.W, w.cum, 0, last, 0, yk, dk, 0.05, (q) => w.keep[q] && deckPiece(w, q));
              band(deck, w.W, w.cum, 0, last, 0, yk, 0, PARAPET_H, (q) => w.keep[q] && deckPiece(w, q));
            }
            // (Elsewhere a wall down to the ground, growing with the drop beside it, and its parapet.)
            const dr = (q: number) => Math.min(w.drop[q], 9);
            band(deck, w.W, w.cum, 0, last, 0, yk, (q) => Math.max(0, dr(q)) + 0.3, (q) => wallTop(dr(q)), (q) => w.keep[q] && !deckPiece(w, q) && Math.max(dr(q), dr(q + 1)) > WALL_FROM);
            band(deck, w.W, w.cum, 0, last, 0, yk, 0, (q) => parapetTop(dr(q)), (q) => w.keep[q] && !deckPiece(w, q) && Math.max(dr(q), dr(q + 1)) > PARAPET_FROM);
          }
        }
        if (part === 2 && !oneLine) for (const F of sh.kerbs) {
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
  // Yellow boxes: on the junction's paving as drawn, or on a road through it.
  /** The paving's drawn top at (x, z) (or the ground's, on a road), and a hair over it. */
  const boxY = (x: number, z: number) => {
    // (Over the highest of them, where a road's end and the paving overlap.)
    let y = -Infinity;
    for (const q of jGrid.get(Math.floor(x / JCELL) * 100003 + Math.floor(z / JCELL)) ?? []) if (inRingXZ(JPOLY[q].ring, x, z)) y = Math.max(y, paveY(q, x, z) + 0.14);
    let onRoad = y === -Infinity;
    if (!onRoad) roads.each(x, z, 16, (i, seg, u, d) => void (!onRoad && !elevated[i] && drawnAt(i, seg, u) && d < halfNear(i, seg, u) && (onRoad = true)));
    return Math.max(y, onRoad ? Math.max(rawHeight(x, z), WL + 0.15) + 0.145 : -Infinity);
  };
  {
    // (Not where another junction's lines, carried across its paving, or a
    // give-way line come within a metre of the box: two sets of paint.)
    const painted: XZ[] = [];
    for (const lines of throughLines.values()) for (const ln of lines) painted.push(...ln.pts);
    for (const g of giveWays) painted.push(...g.dashes);
    const PC = 8;
    const pGrid = new Map<number, XZ[]>();
    for (const p of painted) {
      const k = Math.floor(p[0] / PC) * 100003 + Math.floor(p[1] / PC);
      (pGrid.get(k) ?? pGrid.set(k, []).get(k)!).push(p);
    }
    const nearPaint = (x: number, z: number) => {
      for (let a = Math.floor((x - 1) / PC); a <= Math.floor((x + 1) / PC); a++)
        for (let b = Math.floor((z - 1) / PC); b <= Math.floor((z + 1) / PC); b++)
          for (const p of pGrid.get(a * 100003 + b) ?? []) if (Math.hypot(p[0] - x, p[1] - z) < 1.2) return true;
      return false;
    };
    for (let q = yBoxes.length - 1; q >= 0; q--) {
      const b = yBoxes[q];
      const lines = [...b.ring.map((p, i) => [p, b.ring[(i + 1) % b.ring.length]] as [XZ, XZ]), ...b.x];
      const hit = lines.some(([p, r]) => {
        const L = Math.hypot(r[0] - p[0], r[1] - p[1]);
        for (let t = 0; t <= L; t += 0.5) if (nearPaint(lerp(p[0], r[0], L ? t / L : 0), lerp(p[1], r[1], L ? t / L : 0))) return true;
        return false;
      });
      if (hit) {
        boxWhy.push({ x: +b.ring[0][0].toFixed(1), z: +b.ring[0][1].toFixed(1), why: 'other lines across it' });
        yBoxes.splice(q, 1);
      }
    }
    const byTile = new Map<string, YBox[]>();
    for (const b of yBoxes) {
      const k = tileKey(b.ring[0][0], b.ring[0][1]);
      (byTile.get(k) ?? byTile.set(k, []).get(k)!).push(b);
    }
    for (const [k, list] of byTile)
      onTile('far', k, 'yellow boxes', (_kit, acc) => {
        const box = acc('box');
        for (const b of list)
          for (const [p, q] of [...b.ring.map((p, i) => [p, b.ring[(i + 1) % b.ring.length]] as [XZ, XZ]), ...b.x]) {
            // (In pieces a metre or so long, each draped on the ground.)
            const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
            const n = Math.max(1, Math.ceil(L / 1.2));
            const t: XZ = [(q[0] - p[0]) / (L || 1), (q[1] - p[1]) / (L || 1)];
            const nn: XZ = [-t[1], t[0]];
            for (let i = 0; i < n; i++) {
              const f0 = i / n, f1 = (i + 1) / n;
              const base = box.pos.length / 3;
              for (const [f, w] of [[f0, -1], [f1, -1], [f0, 1], [f1, 1]]) {
                const x = lerp(p[0], q[0], f) + t[0] * 0.1 * (f === f0 ? -1 : 1) + nn[0] * 0.1 * w;
                const z = lerp(p[1], q[1], f) + t[1] * 0.1 * (f === f0 ? -1 : 1) + nn[1] * 0.1 * w;
                box.pos.push(x, boxY(x, z), z);
                box.uv.push(0, 0);
              }
              box.idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
            }
          }
      });
  }
  // ---------- One outline per paved surface (redrawn maps) ----------
  // Every road on the ground, its junctions' paving, its islands and its
  // gores, merged into one outline, tile by tile: the kerbs run along that
  // outline, and the edge lines 0.35 m inside it wherever it lies along a
  // lined road's edge. Where roads merge, split or meet, the surface is one,
  // and so are its kerbs and lines: they carry on round the merge as the
  // asphalt does, and stop only where the outline turns away from a road's
  // edge (a side road's mouth, a divider's nose), at a zebra or a yellow box.
  // (Decks keep their own kerbs and lines: the outline stops at them.)
  const OUT_S = 1000; // (traced in whole millimetres)
  const outlined = edges.map((_, i) => oneLine && !(JX.internal[i] && internalHidden[i]) && EP[i].length > 1);
  // The decks, each flyover (its pieces joined end to end) a level of its
  // own: its outline is traced apart from the ground's and other decks'.
  const deckGrp = new Int32Array(edges.length).fill(-1);
  {
    const up = edges.map((_, i) => i);
    const find = (i: number): number => (up[i] === i ? i : (up[i] = find(up[i])));
    for (let j = 0; j < (jE as number[][]).length; j++) {
      const ds = (jE[j] ?? []).filter((i) => isDeck[i]);
      for (let k = 1; k < ds.length; k++) up[find(ds[k])] = find(ds[0]);
    }
    edges.forEach((_, i) => isDeck[i] && (deckGrp[i] = find(i)));
  }
  /** The level a road's surface is traced in: -1 the ground, else its flyover. */
  const lvlOf = (i: number) => deckGrp[i];
  /** Road i's drawn surface as a polygon: its two sides from mouth to mouth, as the road's strip draws them. */
  const surfacePoly = (i: number): XZ[] => {
    const cut = cutOf(i);
    const P = cut.pts;
    const join = joinOf(i);
    const L: XZ[] = [];
    const R: XZ[] = [];
    for (let k = cut.lo; k <= cut.hi; k++) {
      const { nx, nz, mm } = section(P, k, cut.lo, cut.hi, join);
      const h = halfAtE(i, k) * mm;
      // (Each end 5 cm on into whatever it meets, the next road or a
      // junction's paving, so the two overlap: two edges laid exactly on
      // each other can leave a crack in the outline. Not at a dead end.)
      const end = k === cut.lo ? -1 : k === cut.hi ? 1 : 0;
      const j = end < 0 ? edges[i].a : edges[i].b;
      let ex = 0, ez = 0;
      if (end && (jDegree[j] > 1 || (end < 0 ? cut.lo > 0 || JX.trimA[i] > 0 : cut.hi < P.length - 1 || JX.trimB[i] > 0))) {
        const o = P[end < 0 ? k + 1 : k - 1];
        const l = Math.hypot(P[k][0] - o[0], P[k][1] - o[1]) || 1;
        ex = ((P[k][0] - o[0]) / l) * 0.05;
        ez = ((P[k][1] - o[1]) / l) * 0.05;
      }
      L.push([P[k][0] + nx * h + ex, P[k][1] + nz * h + ez]);
      R.push([P[k][0] - nx * h + ex, P[k][1] - nz * h + ez]);
    }
    return [...L, ...R.reverse()];
  };
  type OutSrc = { ring: XZ[]; lvl: number; x0: number; z0: number; x1: number; z1: number };
  let outSrcs: OutSrc[] | null = null;
  /** A joint's level: the ground, or the flyover its deck pieces belong to. */
  const jLvl = (id: number) => {
    if (jointDeck(id) <= 0) return -1;
    const fill = id < JX.shapes.length ? undefined : JX.fills[id - JX.shapes.length];
    const es = (fill ? (fill.tee !== undefined ? [fill.tee] : []) : JX.shapes[id].nodes).flatMap((j) => jE[j]);
    const d = es.find((i) => isDeck[i]);
    return d === undefined ? -1 : lvlOf(d);
  };
  /** A gore's level: the ground, or the flyover whose deck lies nearest its first row. */
  const goreLvl = (g: (typeof gores)[number]) => {
    if (g.deck <= 0) return -1;
    const r = g.rows[0];
    const hit = roads.nearest((r.a[0] + r.b[0]) / 2, (r.a[1] + r.b[1]) / 2, 30, (i) => isDeck[i]);
    return hit ? lvlOf(hit.line) : -1;
  };
  const outSources = () => {
    if (outSrcs) return outSrcs;
    const rings: [XZ[], number][] = [];
    edges.forEach((_, i) => outlined[i] && rings.push([surfacePoly(i), lvlOf(i)]));
    JPOLY.forEach((sh, id) => rings.push([sh.ring, jLvl(id)]));
    for (const g of gores) rings.push([g.ring, goreLvl(g)]);
    outSrcs = rings
      .filter(([r]) => r.length >= 3)
      .map(([ring, lvl]) => {
        const xs = ring.map((p) => p[0]), zs = ring.map((p) => p[1]);
        return { ring, lvl, x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) };
      });
    return outSrcs;
  };
  /**
   * The paved outline round tile (ix, iz), and 30 m beyond: closed rings,
   * each with the paving on its left (+ the strip's normal), cut into
   * pieces of about a metre on a fixed lattice (so two tiles cut the same
   * stretch of outline at the same places, and their kerbs meet).
   */
  /**
   * Smooth an outline (Clipper's points, mm) where two pieces of paving hand
   * over and their edges do not quite agree: a fold or hook, out and back
   * within 3 m to within 0.4 m of where it left, is cut off; a jog, a few
   * short sides stepping sideways under 0.4 m between two long sides that
   * run the same way, is spread along the long sides either side. Real
   * corners and curves stay as they are. (By the outline's own points
   * only, so two tiles smooth the same stretch the same way.)
   */
  const smoothRing = (r: Path64) => {
    const d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    // Folds and hooks.
    for (let again = true; again && r.length > 4; ) {
      again = false;
      const n = r.length;
      for (let i = 0; i < n && !again; i++) {
        let path = 0;
        // (Twice the area out and back, from r[i]: a crack, a thin wedge
        // where two pieces' square ends meet at an angle, is cut off too,
        // however deep, where it is under 0.3 m wide on average.)
        let a2 = 0;
        for (let k = 1; k < Math.min(40, n - 2); k++) {
          const p0 = r[(i + k - 1) % n], p1 = r[(i + k) % n];
          path += d(p0, p1);
          if (path > 12 * OUT_S) break;
          a2 += (p0.x - r[i].x) * (p1.y - r[i].y) - (p1.x - r[i].x) * (p0.y - r[i].y);
          if (k < 2) continue;
          const gap = d(r[i], r[(i + k) % n]);
          const crack = Math.abs(a2) / path < 0.3 * OUT_S;
          if (gap < 0.4 * OUT_S && ((path <= 3 * OUT_S && path > 3 * gap + 0.5 * OUT_S) || (crack && path > 3 * gap + 0.5 * OUT_S))) {
            // (Cut out the points between, from the far end back.)
            const cut = new Set<number>();
            for (let v = 1; v < k; v++) cut.add((i + v) % n);
            const keep = r.filter((_, q) => !cut.has(q));
            r.length = 0;
            r.push(...keep);
            again = true;
            break;
          }
        }
      }
    }
    // Jogs.
    const LONG = 1 * OUT_S, SHORT = 0.6 * OUT_S;
    for (let again = true; again && r.length > 5; ) {
      again = false;
      const n = r.length;
      for (let b = 0; b < n && !again; b++) {
        const a = (b - 1 + n) % n;
        if (d(r[a], r[b]) < LONG) continue;
        // (Short sides from b on, up to 1.5 m of them, to c; then a long one, c to e.)
        let c = b, run = 0;
        while (run < 1.5 * OUT_S && d(r[c], r[(c + 1) % n]) < SHORT && (c + 1) % n !== a) run += d(r[c], r[(c = (c + 1) % n)]);
        if (c === b || run >= 1.5 * OUT_S) continue;
        const e = (c + 1) % n;
        if (d(r[c], r[e]) < LONG) continue;
        const u1x = (r[b].x - r[a].x) / d(r[a], r[b]), u1y = (r[b].y - r[a].y) / d(r[a], r[b]);
        const u2x = (r[e].x - r[c].x) / d(r[c], r[e]), u2y = (r[e].y - r[c].y) / d(r[c], r[e]);
        if (u1x * u2x + u1y * u2y < Math.cos((20 * Math.PI) / 180)) continue;
        const side = Math.abs((r[c].x - r[b].x) * u1y - (r[c].y - r[b].y) * u1x);
        if (side >= 0.4 * OUT_S) continue;
        // (b to c go: a runs straight on to e.)
        const cut = new Set<number>();
        for (let v = b; v !== e; v = (v + 1) % n) cut.add(v);
        const keep = r.filter((_, q) => !cut.has(q));
        r.length = 0;
        r.push(...keep);
        again = true;
      }
    }
  };
  const outlineRings = (ix: number, iz: number) => {
    const M = 30;
    const bx0 = ix * TILE - M, bz0 = iz * TILE - M, bx1 = (ix + 1) * TILE + M, bz1 = (iz + 1) * TILE + M;
    // (Each level by itself: the ground, and each flyover.)
    const byLvl = new Map<number, Paths64>();
    for (const s of outSources()) {
      if (s.x1 < bx0 || s.x0 > bx1 || s.z1 < bz0 || s.z0 > bz1) continue;
      const p = new Path64();
      for (const q of s.ring) p.push(new Point64(Math.round(q[0] * OUT_S), Math.round(q[1] * OUT_S)));
      // (All one way round: where two pieces wound opposite ways overlap,
      // their windings would cancel and leave a false hole.)
      if (Clipper.area(p) < 0) p.reverse();
      (byLvl.get(s.lvl) ?? byLvl.set(s.lvl, new Paths64()).get(s.lvl)!).push(p);
    }
    const out: { pts: XZ[]; corner: XZ[]; edge: number[]; at: number[]; hole: boolean; lvl: number }[] = [];
    for (const [lvl, paths] of [...byLvl].sort((p, q) => p[0] - q[0]))
    for (const r of Clipper.Union(paths, undefined, FillRule.NonZero)) {
      // (Slivers and specks, where two pieces of paving all but touch: no surface.)
      if (Math.abs(Clipper.area(r)) < 1e6) continue;
      // (Nor a spike: the outline running out and straight back along itself, a crack of no width.)
      for (let again = true; again && r.length > 3; ) {
        again = false;
        for (let q = 0; q < r.length && r.length > 3; q++) {
          const a = r[(q - 1 + r.length) % r.length], c = r[(q + 1) % r.length];
          const b = r[q];
          const back = Math.abs(a.x - c.x) <= 20 && Math.abs(a.y - c.y) <= 20;
          const same = Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
          if (!back && !same) continue;
          // (A spike: its tip and the way back; a repeated point: itself.)
          if (back && !same) r.splice(q, 1), r.splice(q % r.length, 1);
          else r.splice(q, 1);
          again = true;
          q--;
        }
      }
      smoothRing(r);
      // (Nor a sliver, paved or not, where two pieces of paving all but
      // meet: under 0.6 m wide on average, area against length round.)
      let round = 0;
      for (let q = 0; q < r.length; q++) round += Math.hypot(r[q].x - r[(q + 1) % r.length].x, r[q].y - r[(q + 1) % r.length].y);
      if ((2 * Math.abs(Clipper.area(r))) / (round || 1) < 0.6 * OUT_S) continue;
      const pts: XZ[] = [];
      /** The outline's own corners; and each piece's side (from corner[e] to the next), and where along it its middle is (0..1). */
      const corner: XZ[] = [];
      const edge: number[] = [];
      const at: number[] = [];
      // (Clipper keeps the paving on its own left, y up: on the strip's, x
      // east and z south, that is the right. Turned round.)
      for (let q = r.length - 1; q >= 0; q--) {
        const a = r[q], b = r[(q - 1 + r.length) % r.length];
        const ax = a.x / OUT_S, az = a.y / OUT_S, bx = b.x / OUT_S, bz = b.y / OUT_S;
        const e = corner.length;
        corner.push([ax, az]);
        const first = pts.length;
        pts.push([ax, az]);
        // (Cut where it crosses each whole metre of its main way.)
        const ux = Math.abs(bx - ax) >= Math.abs(bz - az);
        const u0 = ux ? ax : az, u1 = ux ? bx : bz;
        const lo = Math.min(u0, u1), hi = Math.max(u0, u1);
        const cuts: number[] = [];
        for (let m = Math.floor(lo) + 1; m < hi; m++) if (m - lo > 0.05 && hi - m > 0.05) cuts.push((m - u0) / (u1 - u0));
        cuts.sort((p, q) => p - q);
        for (const t of cuts) pts.push([lerp(ax, bx, t), lerp(az, bz, t)]);
        const ts = [0, ...cuts, 1];
        for (let q = first; q < pts.length; q++) {
          edge.push(e);
          at.push((ts[q - first] + ts[q - first + 1]) / 2);
        }
      }
      // (An island's ring, a hole in the paving: paving outside it. Turned
      // round as above, a ring round paving comes out with a negative signed
      // area, x east and z south; round a hole, positive.)
      let area2 = 0;
      for (let q = 0; q < corner.length; q++) area2 += corner[q][0] * corner[(q + 1) % corner.length][1] - corner[(q + 1) % corner.length][0] * corner[q][1];
      // (A hole where a road's drawn surface lies is no island: the union
      // missed a little of the paving there, between pieces that do not
      // quite meet. Nothing is drawn round it. Asked just inside its sides.)
      if (area2 > 0) {
        let paved = false;
        for (let q = 0; q < corner.length && !paved; q++) {
          const a = corner[q], b = corner[(q + 1) % corner.length];
          const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (l < 1) continue;
          // (The paving on the left, the hole on the right: x east, z south.)
          const x = (a[0] + b[0]) / 2 - ((b[1] - a[1]) / l) * 0.3, z = (a[1] + b[1]) / 2 + ((b[0] - a[0]) / l) * 0.3;
          if (!inRingXZ(corner, x, z)) continue;
          const near: Near = new Map([...nearRoads(x, z)].filter(([i]) => lvlOf(i) === lvl));
          const r = edgeRoadOf(near, (i) => !JX.internal[i]);
          if (r && r.past < -0.1) paved = true;
        }
        if (paved) continue;
      }
      out.push({ pts, corner, edge, at, hole: area2 > 0, lvl });
    }
    return out;
  };
  /** Road i's half width as its strip draws it, at a SegIndex hit (halfNear is the width other things go by). */
  const drawnHalf = (i: number, seg: number, u: number) => halfAtS(i, lerp(ECUM[i][seg], ECUM[i][Math.min(ECUM[i].length - 1, seg + 1)], u));
  type Near = Map<number, { seg: number; u: number; d: number }>;
  /** Each road on the ground or deck within 16 m of (x, z), by its nearest point (one look round, for all that is asked there). */
  const nearRoads = (x: number, z: number): Near => {
    const m: Near = new Map();
    roads.each(x, z, 16, (i, seg, u, d) => {
      if (!outlined[i] && !isDeck[i]) return;
      const h = m.get(i);
      if (!h || d < h.d) m.set(i, { seg, u, d });
    });
    return m;
  };
  /** The road on whose drawn surface a point lies, or lies nearest: by how far past its edge (from its nearest roads). */
  const edgeRoadOf = (near: Near, ok: (i: number) => boolean) => {
    let best: { i: number; seg: number; u: number; d: number; past: number } | null = null;
    for (const [i, h] of near) {
      if (!outlined[i] || !ok(i)) continue;
      const past = h.d - drawnHalf(i, h.seg, h.u);
      if (!best || past < best.past) best = { i, ...h, past };
    }
    return best;
  };
  const jointDeckOf = new Map<number, number>();
  const jDeck = (id: number) => jointDeckOf.get(id) ?? jointDeckOf.set(id, jointDeck(id)).get(id)!;
  const jLvlOf = new Map<number, number>();
  const jLvlM = (id: number) => jLvlOf.get(id) ?? jLvlOf.set(id, jLvl(id)).get(id)!;
  /** The joints whose paving may hold (x, z) (its cell's, close enough to its centre). */
  const jointsNear = (x: number, z: number, pad = 1) => (jGrid.get(Math.floor(x / JCELL) * 100003 + Math.floor(z / JCELL)) ?? []).filter((q) => Math.hypot(x - JPOLY[q].centre[0], z - JPOLY[q].centre[1]) < JPOLY[q].radius + pad);
  /** The drawn surface's height at (x, z) on the outline (NaN: lying on the ground, as the strips drape it). */
  const outlineY = (x: number, z: number, near = nearRoads(x, z), lvl = -1) => {
    // (A joint between raised roads on the ground, or on a flyover: its own paving.)
    const id = jointsNear(x, z).find((q) => (lvl < 0 ? jDeck(q) === 0 : jLvlM(q) === lvl) && ringDist(JPOLY[q].ring, x, z)[0] < 0.3);
    if (id !== undefined) return paveY(id, x, z);
    const r = edgeRoadOf(near, () => true);
    if (!r || !hasProfile[r.i]) return NaN;
    const i = r.i;
    const s = lerp(ECUM[i][r.seg], ECUM[i][r.seg + 1], r.u);
    const a = EP[i][r.seg], b = EP[i][r.seg + 1];
    return tiltY(i, s, deckAtHit(i, r.seg, r.u), x, z, lerp(a[0], b[0], r.u), lerp(a[1], b[1], r.u));
  };
  /** Does all of the ground near here lie as the strips drape it (no raised road, no raised joint)? Then no height need be worked out. */
  const flatNear = (x: number, z: number, near: Near) => ![...near.keys()].some((i) => outlined[i] && hasProfile[i]) && !jointsNear(x, z, 2).some((q) => jDeck(q) === 0);
  /** Is (x, z), near height y, on a deck (or a deck's joint or gore)? The outline stops there: the deck has its own. */
  const onDeckAt = (x: number, z: number, y: number) => {
    const g = y === y ? y : dropAt(x, z);
    let hit = false;
    roads.each(x, z, 16, (i, seg, u, d) => {
      if (hit || !isDeck[i] || d > drawnHalf(i, seg, u) + 0.05) return;
      hit = Math.abs(deckAtHit(i, seg, u) - g) < 1.5;
    });
    if (hit) return true;
    if (jointsNear(x, z).some((q) => jDeck(q) > 0 && inRingXZ(JPOLY[q].ring, x, z) && Math.abs(jTop(q, x, z) - g) < 1.5)) return true;
    return !!goreGrid.get(Math.floor(x / GCELL) * 100003 + Math.floor(z / GCELL))?.some((q) => gores[q].deck > 0 && inRingXZ(gores[q].ring, x, z));
  };
  /** Is (x, z), near height y, on paving of another level than lvl (a flyover's end on the ground, or the ground's under its end)? */
  const otherAt = (x: number, z: number, y: number, lvl: number) => {
    if (y !== y) return false;
    let hit = false;
    roads.each(x, z, 16, (i, seg, u, d) => {
      if (hit || lvlOf(i) === lvl || !outlined[i] || d > drawnHalf(i, seg, u) + 0.05) return;
      hit = Math.abs((hasProfile[i] ? deckAtHit(i, seg, u) : dropAt(x, z)) - y) < 1.5;
    });
    return hit || jointsNear(x, z).some((q) => jLvlM(q) !== lvl && inRingXZ(JPOLY[q].ring, x, z) && Math.abs(jTop(q, x, z) - y) < 1.5);
  };
  const segDist = (a: XZ, b: XZ, x: number, z: number) => {
    const vx = b[0] - a[0], vz = b[1] - a[1];
    const u = Math.max(0, Math.min(1, ((x - a[0]) * vx + (z - a[1]) * vz) / (vx * vx + vz * vz || 1)));
    return Math.hypot(a[0] + vx * u - x, a[1] + vz * u - z);
  };
  const crossTiles = new Map<string, Crossing[]>();
  const boxTiles = new Map<string, YBox[]>();
  type OutMark = { kerb: boolean; line: boolean; stop: boolean; flat: boolean; why: string; road: number; seg: number; joint: number; lr: number; ls: number; lvl: number };
  /**
   * Does the outline's side a -> b (paving on its left, as the strip has
   * it) get a kerb, and an edge line inside it, at (mx, mz) on it? (why:
   * what decided; flat: the ground here lies as the strips drape it; road
   * and seg, or joint: whose surface it bounds, for its height.)
   */
  const outlineMarks = (a: XZ, b: XZ, mx: number, mz: number, hole = false, lvl = -1): OutMark => {
    const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const tx = (b[0] - a[0]) / tl, tz = (b[1] - a[1]) / tl;
    // (Into the paving: + the strip's normal.)
    const nx = tz, nz = -tx;
    // (The roads of this outline's own level: the ground's, or this flyover's.)
    const all = nearRoads(mx, mz);
    const near: Near = new Map([...all].filter(([i]) => lvlOf(i) === lvl));
    const flat = lvl < 0 && flatNear(mx, mz, near);
    const joint = flat ? -1 : jointsNear(mx, mz).find((q) => (lvl < 0 ? jDeck(q) === 0 : jLvlM(q) === lvl) && ringDist(JPOLY[q].ring, mx, mz)[0] < 0.3) ?? -1;
    const under = edgeRoadOf(near, () => true);
    const y = flat ? NaN : outlineY(mx, mz, near, lvl);
    const base = { flat, joint, road: under && hasProfile[under.i] ? under.i : -1, seg: under?.seg ?? 0, lr: -1, ls: 0, lvl };
    // The road whose edge this is.
    const r = edgeRoadOf(near, (i) => !JX.internal[i]);
    // (Across a road's very end, where it stops at the map's edge or a dead end: no kerb, no line.
    // Not where another road carries on from it: a step there between the two is no end.)
    if (r && r.past < 0.1) {
      const s = lerp(ECUM[r.i][r.seg], ECUM[r.i][r.seg + 1], r.u);
      const endJ = s < ELEN[r.i] / 2 ? edges[r.i].a : edges[r.i].b;
      const pa = EP[r.i][r.seg], pb = EP[r.i][r.seg + 1];
      const dl = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) || 1;
      if ((s < 0.5 || s > ELEN[r.i] - 0.5) && jDegree[endJ] <= 1 && Math.abs((tx * (pb[0] - pa[0]) + tz * (pb[1] - pa[1])) / dl) < 0.5) return { ...base, kerb: false, line: false, stop: true, why: 'road end' };
    }
    // (Where a deck carries on from it: the deck's own kerbs and lines.)
    // (And where a flyover's end lands on the ground: the ground's.)
    if (lvl >= 0 ? otherAt(mx - nx * 0.4, mz - nz * 0.4, y, lvl) : ([...all].some(([i, h]) => isDeck[i] && h.d < drawnHalf(i, h.seg, h.u) + 1) || jointsNear(mx, mz).some((q) => jDeck(q) > 0) || !!goreGrid.get(Math.floor(mx / GCELL) * 100003 + Math.floor(mz / GCELL))?.some((q) => gores[q].deck > 0)) && onDeckAt(mx - nx * 0.4, mz - nz * 0.4, y))
      return { ...base, kerb: false, line: false, stop: true, why: lvl >= 0 ? 'ground beyond' : 'deck beyond' };
    // A kerb, but beside a road that has none (a lane, a drive), or round
    // a junction's corner that has none.
    let kerb = !!r && (kerbedRoad(edges[r.i]) || hasProfile[r.i]);
    // (Where an unkerbed road's end reaches just as far as a kerbed road's
    // edge, the kerbed road's: a side road drawn across to the far side.)
    if (r && !kerb && Math.abs(r.past) < 0.15) {
      const k = edgeRoadOf(near, (i) => !JX.internal[i] && (kerbedRoad(edges[i]) || hasProfile[i]));
      if (k && Math.abs(k.past) < 0.15) kerb = true;
    }
    let why = r ? `road ${r.i} past ${r.past.toFixed(2)}` : 'no road';
    /** The joint whose paving's side this is (not a road's). */
    const jointSide = r && Math.abs(r.past) > 0.2 ? jointsNear(mx, mz).find((q) => jLvlM(q) === lvl && inRingXZ(JPOLY[q].ring, mx + nx * 0.05, mz + nz * 0.05) && !inRingXZ(JPOLY[q].ring, mx - nx * 0.05, mz - nz * 0.05)) : undefined;
    if (jointSide !== undefined) {
      if (kerb) kerb = JPOLY[jointSide].kerbs.some((F) => F.some((p, w) => w > 0 && segDist(F[w - 1], p, mx, mz) < 0.6));
      why += ` joint ${jointSide}`;
    }
    // An edge line: where the outline runs along a lined road's edge.
    // (Each road by its nearest point: any other point of it, a corner
    // further along, may happen to lie a road's half width away too. Not
    // off its end: there the outline is round its end, not along its side.)
    let lined = -1;
    let ls = 0;
    let off = Infinity;
    for (const [i, { seg, u, d }] of near) {
      if (!outlined[i] || JX.internal[i] || rankOf(edges[i].cls) < 2) continue;
      // (Where the road carries on as another piece, round the outside of
      // the bend between them is still its side.)
      if ((seg === 0 && u <= 0 && thruMate(i, edges[i].a) === undefined) || (seg === EP[i].length - 2 && u >= 1 && thruMate(i, edges[i].b) === undefined)) continue;
      const o = d - drawnHalf(i, seg, u);
      // (A little inside its edge too: where two roads overlap, one may be drawn a little narrower than its width says.)
      if (o > -1 && o < 0.6 && (lined < 0 || Math.abs(o) < Math.abs(off))) (lined = i), (ls = seg);
      if (Math.abs(o) < Math.abs(off)) off = o;
    }
    // (A slip road's wedge between lined roads: its outside carries the
    // edge line from the road it leaves to the slip road's own.)
    const wedge = lined < 0 && jointSide !== undefined && slipLined(jointSide);
    // (Across a junction the through road wins, on a side nothing joins
    // from: its edge line carries on where the way across puts it, even
    // where the road's own piece there lies hidden under the junction.)
    const thru = lined < 0 && !wedge && thruYellowNear(mx + nx * 0.35, mz + nz * 0.35, lvl) < 0.4;
    // (An island's kerb, among lined roads: the edge line follows it all
    // the way round, as it does round a divider's nose.)
    const island = lined < 0 && !wedge && !thru && hole && kerb && [...near].some(([i]) => rankOf(edges[i].cls) >= 2);
    why += ` lined ${lined} off ${off.toFixed(2)}${wedge ? ' wedge' : ''}${thru ? ' through' : ''}${island ? ' island' : ''}`;
    return { ...base, kerb, line: lined >= 0 || wedge || thru || island, stop: false, why, lr: lined, ls };
  };
  /** How far is (x, z) from the nearest through road's edge line across a junction (on the ground)? */
  let thruGrid: Map<number, [XZ, XZ, number][]> | null = null;
  const thruYellowNear = (x: number, z: number, lvl: number) => {
    if (!thruGrid) {
      thruGrid = new Map();
      for (const [id, lines] of throughLines) {
        const lv = jLvlM(id);
        for (const ln of lines) {
          if (ln.kind !== 'yellow') continue;
          for (let k = 1; k < ln.pts.length; k++) {
            const a = ln.pts[k - 1], b = ln.pts[k];
            for (const c of new Set([Math.floor(a[0] / 8) * 100003 + Math.floor(a[1] / 8), Math.floor(b[0] / 8) * 100003 + Math.floor(b[1] / 8)])) (thruGrid.get(c) ?? thruGrid.set(c, []).get(c)!).push([a, b, lv]);
          }
        }
      }
    }
    let best = Infinity;
    const ci = Math.floor(x / 8), cj = Math.floor(z / 8);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) for (const [a, b, lv] of thruGrid.get(i * 100003 + j) ?? []) if (lv === lvl) best = Math.min(best, segDist(a, b, x, z));
    return best;
  };
  /** Is joint id a slip road's wedge (or a far part of one) where every road is lined? */
  const slipLined = (id: number) => {
    const fill = id < JX.shapes.length ? undefined : JX.fills[id - JX.shapes.length];
    const j = fill ? (fill.slip ? fill.tee : undefined) : JX.shapes[id].slip && JX.shapes[id].nodes.length === 1 ? JX.shapes[id].nodes[0] : undefined;
    return j !== undefined && !!JX.tee[j] && jE[j].every((i) => rankOf(edges[i].cls) >= 2);
  };
  /** Does an edge line stop at (x, z): a zebra, or a yellow box? */
  let outGrids = false;
  const lineStops = (x: number, z: number) => {
    if (!outGrids) {
      outGrids = true;
      for (const c of crossings) for (const kk of new Set([tileKey(c.c[0] - 8, c.c[1] - 8), tileKey(c.c[0] + 8, c.c[1] - 8), tileKey(c.c[0] - 8, c.c[1] + 8), tileKey(c.c[0] + 8, c.c[1] + 8)])) (crossTiles.get(kk) ?? crossTiles.set(kk, []).get(kk)!).push(c);
      for (const bx of yBoxes) for (const kk of new Set(bx.ring.map((p) => tileKey(p[0], p[1])))) (boxTiles.get(kk) ?? boxTiles.set(kk, []).get(kk)!).push(bx);
    }
    const k = tileKey(x, z);
    return (
      (crossTiles.get(k) ?? []).some((c) => {
        const vx = x - c.c[0], vz = z - c.c[1];
        return Math.abs(vx * c.t[0] + vz * c.t[1]) < CROSS_W / 2 + 0.2 && Math.abs(vx * c.t[1] - vz * c.t[0]) < c.half + 0.6;
      }) || (boxTiles.get(k) ?? []).some((bx) => inRingXZ(bx.ring, x, z))
    );
  };
  /** The drawn surface's height at (x, z), on the surface a mark's side bounds (cheap: no look round). */
  const yOn = (m: OutMark, x: number, z: number) => {
    if (m.flat) return NaN;
    if (m.joint >= 0) return paveY(m.joint, x, z);
    /** Road o's drawn height at (x, z), by its nearest point among pieces lo..hi. */
    const at = (o: number, lo: number, hi: number) => {
      const P = EP[o];
      let best = Infinity, bs = 0, bu = 0;
      for (let s = Math.max(0, lo); s <= Math.min(P.length - 2, hi); s++) {
        const vx = P[s + 1][0] - P[s][0], vz = P[s + 1][1] - P[s][1];
        const u = Math.max(0, Math.min(1, ((x - P[s][0]) * vx + (z - P[s][1]) * vz) / (vx * vx + vz * vz || 1)));
        const d = Math.hypot(P[s][0] + vx * u - x, P[s][1] + vz * u - z);
        if (d < best) (best = d), (bs = s), (bu = u);
      }
      return tiltY(o, lerp(ECUM[o][bs], ECUM[o][bs + 1], bu), deckAtHit(o, bs, bu), x, z, lerp(P[bs][0], P[bs + 1][0], bu), lerp(P[bs][1], P[bs + 1][1], bu));
    };
    // (Its own road's, a few pieces either side of where the side was asked.)
    let y = m.road >= 0 ? at(m.road, m.seg - 4, m.seg + 4) : NaN;
    // (Where raised pieces of the same level overlap, as a ramp leaves a
    // road, the one on top is what shows: the mark lies on it.)
    roads.each(x, z, 12, (o, seg, u, d) => {
      if (o === m.road || !hasProfile[o] || lvlOf(o) !== m.lvl || !outlined[o] || d > drawnHalf(o, seg, u) + 0.4) return;
      const h = at(o, seg, seg);
      if (y !== y || (h > y && h - y < 1.5)) y = h;
    });
    return y;
  };
  // (A tile's outline is worked out over several build slices, each short:
  // first the outline itself, then its sides a share at a time, asked
  // every 4 m or so along each, then the kerbs and lines drawn.)
  type OutRing = { P: XZ[]; cum: number[]; n: number; drawn: boolean[]; corner: XZ[]; edge: number[]; at: number[]; samples: (OutMark | null)[][]; hole: boolean; lvl: number };
  const outWork = new Map<string, { rings: OutRing[]; todo: [number, number, number][]; draws: ((kerb: Acc, yellow: Acc) => void)[]; drawW: number[] }>();
  const OUT_PARTS = 6;
  const OUT_DRAW = 6;
  /** How many places along a side of the outline are asked (one every 4 m or so). */
  const sidePlaces = (a: XZ, b: XZ) => Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
  if (oneLine) {
    for (const k of roadRuns.keys()) {
      const [ix, iz] = k.split(',').map(Number);
      const inTile = (x: number, z: number) => Math.floor(x / TILE) === ix && Math.floor(z / TILE) === iz;
      onTile('far', k, 'outline', () => {
        const rings: OutRing[] = [];
        const todo: [number, number, number][] = [];
        for (const { pts: R, corner, edge, at, hole, lvl } of outlineRings(ix, iz)) {
          const n = R.length;
          // (Closed: one point before the start and two past it, for the cross-sections there. Piece q is R's q - 1.)
          const P: XZ[] = [R[n - 1], ...R, R[0], R[1]];
          const mid = (q: number) => [(P[q][0] + P[q + 1][0]) / 2, (P[q][1] + P[q + 1][1]) / 2] as XZ;
          const drawn = P.slice(0, -1).map((_, q) => q >= 1 && q <= n && inTile(...mid(q)));
          if (!drawn.some(Boolean)) continue;
          const cum = [0];
          for (let q = 1; q < P.length; q++) cum.push(cum[q - 1] + Math.hypot(P[q][0] - P[q - 1][0], P[q][1] - P[q - 1][1]));
          const id = rings.length;
          const C = corner.length;
          const samples = corner.map((a, e) => new Array<OutMark | null>(sidePlaces(a, corner[(e + 1) % C])).fill(null));
          // (Each side that has a piece in the tile, or within 15 m of it,
          // all along: a side across the tile's edge is judged the same
          // from both tiles.)
          const want = new Set<number>();
          for (let q = 1; q <= n; q++) {
            const [x, z] = mid(q);
            if (x > ix * TILE - 15 && x < (ix + 1) * TILE + 15 && z > iz * TILE - 15 && z < (iz + 1) * TILE + 15) want.add(edge[q - 1]);
          }
          for (const e of want) for (let j = 0; j < samples[e].length; j++) todo.push([id, e, j]);
          rings.push({ P, cum, n, drawn, corner, edge, at, samples, hole, lvl });
        }
        outWork.set(k, { rings, todo, draws: [], drawW: [] });
      });
      for (let part = 0; part < OUT_PARTS; part++)
        onTile('far', k, 'outline marks', () => {
          const w = outWork.get(k);
          if (!w) return;
          const per = Math.ceil(w.todo.length / OUT_PARTS);
          for (const [id, e, j] of w.todo.slice(part * per, (part + 1) * per)) {
            const R = w.rings[id];
            const a = R.corner[e], b = R.corner[(e + 1) % R.corner.length];
            const t = (j + 0.5) / R.samples[e].length;
            R.samples[e][j] = outlineMarks(a, b, lerp(a[0], b[0], t), lerp(a[1], b[1], t), R.hole, R.lvl);
          }
        });
      onTile('far', k, 'outline lines', () => {
        const w = outWork.get(k);
        if (!w) return;
        for (const { P, cum, n, drawn: drawnP, edge, at, samples, hole, lvl } of w.rings) {
          // (By the ring's own pieces: piece q runs from point q to q + 1, round.)
          const R = P.slice(1, n + 1);
          const nx = (q: number) => (q + 1) % n;
          const len = (q: number) => cum[q + 2] - cum[q + 1];
          const drawn = R.map((_, q) => drawnP[q + 1]);
          // Each piece as its side was found where asked nearest it; an
          // edge line stops at a zebra or a yellow box.
          const marks: (OutMark | null)[] = R.map((a, q) => {
            const S = samples[edge[q]];
            const m = S[Math.min(S.length - 1, Math.floor(at[q] * S.length))];
            if (!m || !m.line) return m;
            const b = R[nx(q)];
            const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
            const cx = (a[0] + b[0]) / 2 + ((b[1] - a[1]) / tl) * 0.35, cz = (a[1] + b[1]) / 2 - ((b[0] - a[0]) / tl) * 0.35;
            return lvl < 0 && lineStops(cx, cz) ? { ...m, line: false, stop: true, why: m.why + ' zebra' } : m;
          });
          const zebra = (q: number) => !!marks[q]?.stop && marks[q]!.why.endsWith(' zebra');
          // (An island is lined all round or not at all: where any of its
          // kerb has a line, all of it does, but at a zebra.)
          // (A hole with no kerb anywhere round it is no island: paving the
          // union missed, inside a junction. Nothing is drawn round it.)
          if (hole && !marks.some((m) => m?.kerb)) marks.forEach((m, q) => m && m.line && (marks[q] = { ...m, line: false, why: m.why + ' bare hole' }));
          if (hole && marks.some((m) => m?.line)) marks.forEach((m, q) => m && m.kerb && !m.line && !m.stop && (marks[q] = { ...m, line: true, why: m.why + ' island' }));
          // Round a nose (a divider's end, a gore's tip) the edge line carries
          // on from one side to the other: a short stretch with no road's
          // edge, turning more than 120°, between two lined stretches. And
          // across a joint's paving where one road's edge runs on into the
          // next's (a merge, a split, a bend), turning less than 40°: the
          // paving there lies a little off both roads' edges. (A corner into
          // a side road, turning about 90°, is a mouth: the line stops.)
          // (And round a nose from its lined side to a zebra just past its
          // tip, either way round: the line follows the kerb to the zebra.)
          for (let q = 1; q < n; q++) {
            if (!(marks[q - 1]?.line || zebra(q - 1)) || !marks[q] || marks[q]!.line || marks[q]!.stop) continue;
            let e = q;
            let run = 0;
            while (e < n - 1 && marks[e] && !marks[e]!.line && !marks[e]!.stop && run < 12) run += len(e++);
            if (!(marks[e]?.line || zebra(e)) || run >= 12) continue;
            const toZebra = !marks[q - 1]!.line || !marks[e]!.line;
            if (toZebra && !marks[q - 1]!.line && !marks[e]!.line) continue;
            // (Its way in and out over 3 m either side: the line may already
            // have turned some way round where it leaves off.)
            let qb = q - 1;
            while (qb > 0 && marks[qb - 1]?.line && Math.hypot(R[q][0] - R[qb][0], R[q][1] - R[qb][1]) < 3) qb--;
            let ef = nx(e);
            while (ef < n - 1 && marks[ef]?.line && Math.hypot(R[ef][0] - R[e][0], R[ef][1] - R[e][1]) < 3) ef++;
            const t0 = unit(R[q][0] - R[qb][0], R[q][1] - R[qb][1]), t1 = unit(R[ef][0] - R[e][0], R[ef][1] - R[e][1]);
            const c = t0[0] * t1[0] + t0[1] * t1[1];
            // (A nose may be half rounded already where the line leaves off: a
            // narrow one, under 8 m across, turning more than about 100°, is one too.)
            const nose = c < -0.5 || (c < -0.2 && Math.hypot(R[e][0] - R[q][0], R[e][1] - R[q][1]) < 8);
            if (!nose && (toZebra || c < Math.cos((40 * Math.PI) / 180))) continue;
            if (toZebra && !marks.slice(q, e).every((m) => m!.kerb)) continue;
            for (let v = q; v < e; v++) marks[v] = { ...marks[v]!, line: true, why: marks[v]!.why + (nose ? ' nose' : ' on') };
          }
          // Round a junction's kerbed corner from a lined road the edge line
          // follows the kerb all the way round, as a kerb line does: into a
          // lined road it carries on, into an unlined one it stops where the
          // corner ends. (It used to stop where the corner left the road's
          // own edge, part way round the curve.)
          const corner = (q: number) => !!marks[q] && marks[q]!.kerb && !marks[q]!.line && !marks[q]!.stop && marks[q]!.why.includes(' joint ');
          const corners = () => {
            for (let q = 0; q < n; ) {
              if (!corner(q)) {
                q++;
                continue;
              }
              let e = q;
              let run = 0;
              while (e < n && corner(e)) run += len(e++);
              const before = marks[(q - 1 + n) % n], after = marks[e % n];
              // (Or from a zebra on a lined road, where the road's line stops.)
              if (run < 30 && (before?.line || after?.line || zebra((q - 1 + n) % n) || zebra(e % n)) && !(q === 0 && e === n)) for (let v = q; v < e; v++) marks[v] = { ...marks[v]!, line: true, why: marks[v]!.why + ' corner' };
              q = e;
            }
          };
          // (No kerb or line on or off for under 3 m between two stretches
          // the other way: where pieces hand over, the outline may run back
          // and forth across a road's edge or a deck's end. A gap at a zebra
          // or a deck stays.)
          const flicker = (key: 'kerb' | 'line') => {
            const runs: { s: number; e: number; on: boolean; L: number }[] = [];
            for (let q = 0; q < n; ) {
              const on = !!marks[q]?.[key];
              let e = q, L = 0;
              while (e < n && !!marks[e]?.[key] === on && !!marks[e] === !!marks[q]) L += len(e++);
              runs.push({ s: q, e, on, L });
              q = e;
            }
            for (let i = 1; i + 1 < runs.length; i++) {
              const R = runs[i];
              if (R.L >= 3 || runs[i - 1].on !== runs[i + 1].on || runs[i - 1].on === R.on) continue;
              if (marks.slice(R.s, R.e).some((m) => !m || (!R.on && m.stop))) continue;
              // (Nor a short line from a zebra: it runs from the zebra to where the kerb turns away.)
              if (R.on && (marks[(R.s - 1 + n) % n]?.stop || marks[R.e % n]?.stop)) continue;
              for (let v = R.s; v < R.e; v++) marks[v] = { ...marks[v]!, [key]: !R.on };
              R.on = !R.on;
            }
          };
          // (The kerbs first: a corner's kerb may be one such stretch, and
          // its line follows from the kerb.)
          flicker('kerb');
          corners();
          flicker('line');
          {
            const D = (globalThis as unknown as { __outDbg?: [number, number, number] }).__outDbg;
            if (D) {
              const out = ((globalThis as unknown as { __outDbgOut?: string[] }).__outDbgOut ??= []);
              R.forEach((a, q) => Math.hypot(a[0] - D[0], a[1] - D[1]) < D[2] && out.push(`${a[0].toFixed(1)},${a[1].toFixed(1)} ${marks[q] ? (marks[q]!.kerb ? 'K' : '-') + (marks[q]!.line ? 'L' : '-') + (marks[q]!.stop ? 'S' : '') + ' ' + marks[q]!.why : 'null'}`));
            }
          }
          // Only the points where something changes are kept: the outline's
          // corners, and where a kerb or a line starts or stops (or the tile
          // ends). The road's own strips are drawn between its own points,
          // and the marks lie on them the same way.
          const same = (p: number, q: number) => edge[p] === edge[q] && drawn[p] === drawn[q] && !!marks[p]?.kerb === !!marks[q]?.kerb && !!marks[p]?.line === !!marks[q]?.line;
          const K: number[] = [];
          // (And on a raised road, a point every 3 m or so: the heights
          // between kept points are straight, and a road's rise is curved.)
          let since = 0;
          for (let q = 0; q < n; q++) {
            since += len((q - 1 + n) % n);
            if (!same((q - 1 + n) % n, q) || (since >= 3 && marks[q] && !marks[q]!.flat)) K.push(q), (since = 0);
          }
          const m = K.length;
          if (m < 2) continue;
          const Q: XZ[] = [R[K[m - 1]], ...K.map((q) => R[q]), R[K[0]], R[K[1]]];
          const qc = [0];
          for (let j = 1; j < Q.length; j++) qc.push(qc[j - 1] + Math.hypot(Q[j][0] - Q[j - 1][0], Q[j][1] - Q[j - 1][1]));
          // (Piece j of Q is the kept stretch from K[j - 1], as the first piece of it says.)
          const at0 = (j: number) => K[(j - 1 + m) % m];
          const mk = (j: number) => marks[at0(j)];
          const dr = (j: number) => j >= 1 && j <= m && drawn[at0(j)];
          for (let j0 = 1; j0 <= m; j0++) {
            if (!dr(j0)) continue;
            let j1 = j0;
            while (j1 + 1 <= m && dr(j1 + 1)) j1++;
            const J0 = j0, J1 = j1;
            // (Its share of the drawing: by its points, the heights of each asked.)
            w.drawW.push(J1 - J0 + 2);
            w.draws.push((kerb, yellow) => {
              const j0 = J0, j1 = J1;
              // (Heights where the ground does not lie as the strips drape it, from the surface the side bounds.)
              const hK: number[] = [];
              const hY: number[] = [];
              for (let v = j0; v <= j1 + 1; v++) {
                const mm = (v <= j1 ? mk(v) : null) ?? mk(v - 1);
                if (!mm || mm.flat) {
                  hK[v] = hY[v] = NaN;
                  continue;
                }
                const { nx: sx, nz: sz } = section(Q, v, 0, Q.length - 1, undefined, true);
                hK[v] = yOn(mm, Q[v][0], Q[v][1]);
                hY[v] = yOn(mm, Q[v][0] + sx * 0.35, Q[v][1] + sz * 0.35);
              }
              // (Each kerb and line by itself, square across at its ends: at a
              // bend in the outline where it stops, a cross-section on the
              // bend's bisector would cut it off aslant. Where it runs on into
              // the next tile, as the next tile has it there.)
              const runs = (keep: (j: number) => boolean, f: (lo: number, hi: number, a: number, b: number) => void) => {
                for (let a = j0; a <= j1; a++) {
                  if (!keep(a)) continue;
                  let b = a;
                  while (b + 1 <= j1 && keep(b + 1)) b++;
                  f(a === j0 && keep(j0 - 1) ? 0 : a, b === j1 && keep(j1 + 1) ? Q.length - 1 : b + 1, a, b + 1);
                  a = b;
                }
              };
              const isKerb = (j: number) => !!mk(j)?.kerb, isLine = (j: number) => !!mk(j)?.line;
              runs(isKerb, (lo, hi, a, b) => strip(kerb, Q, qc, a, b, 0.25, 0.07, { lo, hi, off: -0.1, yAt: (j) => hK[j], bisect: true }));
              runs(isLine, (lo, hi, a, b) => strip(yellow, Q, qc, a, b, 0.07, 0.11, { lo, hi, off: 0.35, yAt: (j) => hY[j], bisect: true }));
            });
            j0 = j1;
          }
        }
      });
      // (Drawn a share at a time.)
      for (let part = 0; part < OUT_DRAW; part++)
        onTile('far', k, 'outline draw', (_kit, acc) => {
          const w = outWork.get(k);
          if (!w) return;
          // (Shared out by their points, not their number: one long run round
          // a raised road costs as much as many short ones.)
          const total = w.drawW.reduce((a, b) => a + b, 0) || 1;
          const kerb = acc('kerb');
          const yellow = acc('yellow');
          let before = 0;
          w.draws.forEach((f, q) => {
            const mid = before + w.drawW[q] / 2;
            before += w.drawW[q];
            if (Math.min(OUT_DRAW - 1, Math.floor((mid / total) * OUT_DRAW)) === part) f(kerb, yellow);
          });
          if (part === OUT_DRAW - 1) outWork.delete(k);
        });
    }
  }
  /** (For the checks: the outline's sides within r of (x, z), and what each gets at its nearest point.) */
  const outlineAt = (x: number, z: number, r = 3) => {
    const out: { a: XZ; b: XZ; kerb: boolean; line: boolean; why: string }[] = [];
    for (const { corner: R, hole, lvl } of outlineRings(Math.floor(x / TILE), Math.floor(z / TILE)))
      R.forEach((a, q) => {
        const b = R[(q + 1) % R.length];
        if (segDist(a, b, x, z) >= r) return;
        const vx = b[0] - a[0], vz = b[1] - a[1];
        const u = Math.max(0, Math.min(1, ((x - a[0]) * vx + (z - a[1]) * vz) / (vx * vx + vz * vz || 1)));
        const m = outlineMarks(a, b, a[0] + vx * u, a[1] + vz * u, hole, lvl);
        out.push({ a, b, kerb: m.kerb, line: m.line && !lineStops(a[0] + vx * u, a[1] + vz * u), why: m.why + (hole ? ' (hole)' : '') + (lvl >= 0 ? ` (deck ${lvl})` : '') });
      });
    return out;
  };
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
        if (!ok || d > halfNear(i, seg, u) + margin) return;
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
            if (d > halfNear(r, seg, u) + PHALF[i]) return;
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
      // (Its ends on the banks meet the ground as its mesh draws it.)
      g[k] = groundY(pts[k][0], pts[k][1]);
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
  /**
   * A vertical band along pts at sideways offset `off`, from y(k) - below to
   * y(k) + above. (ext: how far to carry it on past the first and the last
   * of pts, where the road carries on into the next piece: the two pieces'
   * walls overlap a little instead of leaving a hairline between them where
   * the road bends at the joint.)
   */
  const band = (acc: Acc, pts: XZ[], cum: number[], k0: number, k1: number, offIn: number | ((k: number) => number), y: (k: number) => number, belowIn: number | ((k: number) => number), aboveIn: number | ((k: number) => number), keep: (k: number) => boolean, ext: [number, number] = [0, 0]) => {
    const base = acc.pos.length / 3;
    for (let k = k0; k <= k1; k++) {
      const a = pts[Math.max(0, k - 1)];
      const b = pts[Math.min(pts.length - 1, k + 1)];
      const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const off = typeof offIn === 'number' ? offIn : offIn(k);
      const along = k === 0 ? -ext[0] : k === pts.length - 1 ? ext[1] : 0;
      const x = pts[k][0] + ((b[1] - a[1]) / tl) * off + ((b[0] - a[0]) / tl) * along;
      const z = pts[k][1] - ((b[0] - a[0]) / tl) * off + ((b[1] - a[1]) / tl) * along;
      const yk = y(k);
      const below = typeof belowIn === 'number' ? belowIn : belowIn(k);
      const above = typeof aboveIn === 'number' ? aboveIn : aboveIn(k);
      acc.pos.push(x, yk - below, z, x, yk + above, z);
      acc.uv.push(0, cum[k] / 6, 1, cum[k] / 6);
    }
    for (let k = k0; k < k1; k++) {
      if (!keep(k)) continue;
      const q = base + (k - k0) * 2;
      acc.idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
    }
  };
  /**
   * For band(): 0.25 m at each end of road line's points where it carries
   * straight on into the next piece (no junction there, nothing cut back),
   * on side sgn (as band's offset) unless the wall carried on would stand
   * on the next piece's road (the inside of a bend, where the two pieces'
   * walls already cross).
   */
  const runsOn = (line: number, P: XZ[]) => (sgn: number): [number, number] => {
    const e = edges[line];
    const L = EP[line];
    const n = P.length - 1;
    const on = (j: number, trim: number, k: number, kIn: number) => {
      const p = P[k];
      if (trim > 0 || jDegree[j] !== 2 || Math.hypot(p[0] - L[k === 0 ? 0 : L.length - 1][0], p[1] - L[k === 0 ? 0 : L.length - 1][1]) > 0.01) return 0;
      const o = jE[j].find((i) => i !== line);
      if (o === undefined) return 0;
      // (band's offset direction at this end, from the first or last piece of the line.)
      const a = P[Math.min(k, kIn)], b = P[Math.max(k, kIn)];
      const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const tx = (b[0] - a[0]) / tl, tz = (b[1] - a[1]) / tl;
      const off = sgn * (halfAtE(line, k) + 0.45);
      const along = k === 0 ? -0.25 : 0.25;
      const x = p[0] + tz * off + tx * along, z = p[1] - tx * off + tz * along;
      // (Carried on, does its foot stand on the next piece's road?)
      const h = roads.nearest(x, z, 20, (i) => i === o);
      return h && h.d < halfNear(o, h.seg, h.u) + 0.3 ? 0 : 0.25;
    };
    return [on(e.a, JX.trimA[line] || 0, 0, 1), on(e.b, JX.trimB[line] || 0, n, n - 1)];
  };
  // Paths lie on the ground as its mesh draws it: a STEP m lattice of
  // heightAt, each square cut corner to corner the same way. (On the
  // smooth ground below it, a path on a bank or a hump sinks under the
  // grass between the mesh's points, and shows only in shards.)
  const latY = new Map<number, number>();
  const latAt = (i: number, j: number) => {
    const k = i * 100003 + j;
    let v = latY.get(k);
    if (v === undefined) latY.set(k, (v = heightAt(WB.minX + i * STEP, WB.minZ + j * STEP)));
    return v;
  };
  const groundY = (x: number, z: number) => {
    const fx = (x - WB.minX) / STEP, fz = (z - WB.minZ) / STEP;
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    if (u + v <= 1) return latAt(i, j) + (latAt(i + 1, j) - latAt(i, j)) * u + (latAt(i, j + 1) - latAt(i, j)) * v;
    return latAt(i + 1, j + 1) + (latAt(i, j + 1) - latAt(i + 1, j + 1)) * (1 - u) + (latAt(i + 1, j) - latAt(i + 1, j + 1)) * (1 - v);
  };
  /**
   * Points k0..k1 of a path (and one either side, for the direction at its
   * ends), with more between wherever the mesh bends under it: each piece
   * on the ground is halved until it lies within 1.5 cm of the mesh at its
   * middle and its quarters, or is 0.5 m long. (On a bridge, as it is:
   * from the bank onto a bridge's dry end, on the ground like the rest.)
   */
  const drape = (pts: XZ[], cum: number[], k0: number, k1: number, deck: Float32Array, half: number, joints: Uint8Array) => {
    const a0 = Math.max(0, k0 - 1), a1 = Math.min(pts.length - 1, k1 + 1);
    const P: XZ[] = [], C: number[] = [], Y: number[] = [];
    // (Where each of the path's own points went.)
    const orig = new Map<number, number>();
    let from = 0, to = 0;
    // (Along its middle and both its edges.)
    const off = (x0: number, z0: number, x1: number, z1: number) => {
      const l = Math.hypot(x1 - x0, z1 - z0) || 1;
      const nx = (z1 - z0) / l, nz = -(x1 - x0) / l;
      let worst = 0;
      for (const f of [-half, 0, half]) {
        const ax = x0 + nx * f, az = z0 + nz * f, bx = x1 + nx * f, bz = z1 + nz * f;
        const g0 = groundY(ax, az), g1 = groundY(bx, bz);
        for (const t of [0.25, 0.5, 0.75]) worst = Math.max(worst, Math.abs(groundY(lerp(ax, bx, t), lerp(az, bz, t)) - lerp(g0, g1, t)));
      }
      return worst;
    };
    // (Nothing is added within a bend's mitre of it: there the strip's
    // inside edge reaches back along the piece, and a point added there
    // would fold it over. joints: where the path is drawn in two instead.)
    const reach = (k: number) => {
      if (k <= 0 || k >= pts.length - 1 || joints[k]) return 0;
      const p = pts[k - 1], q = pts[k], r = pts[k + 1];
      const l1 = Math.hypot(q[0] - p[0], q[1] - p[1]), l2 = Math.hypot(r[0] - q[0], r[1] - q[1]);
      if (l1 < 1e-3 || l2 < 1e-3) return 0;
      const c = ((q[0] - p[0]) * (r[0] - q[0]) + (q[1] - p[1]) * (r[1] - q[1])) / (l1 * l2);
      const ch = Math.sqrt(Math.max(0, (1 + c) / 2));
      const mm = ch < Math.cos((10 * Math.PI) / 180) ? 1 / Math.max(0.5, ch) : 1;
      return half * mm * Math.sqrt(Math.max(0, 1 - ch * ch)) + 0.1;
    };
    let lo_c = -Infinity, hi_c = Infinity;
    const split = (x0: number, z0: number, c0: number, x1: number, z1: number, c1: number, depth: number) => {
      if (depth < 6 && c1 - c0 > 0.5 && off(x0, z0, x1, z1) > 0.015 && (c0 + c1) / 2 > lo_c && (c0 + c1) / 2 < hi_c) {
        const xm = (x0 + x1) / 2, zm = (z0 + z1) / 2, cm = (c0 + c1) / 2;
        split(x0, z0, c0, xm, zm, cm, depth + 1);
        P.push([xm, zm]);
        C.push(cm);
        Y.push(NaN);
        split(xm, zm, cm, x1, z1, c1, depth + 1);
      }
    };
    for (let k = a0; k <= a1; k++) {
      if (k === k0) from = P.length;
      orig.set(k, P.length);
      P.push(pts[k]);
      C.push(cum[k]);
      Y.push(deck[k]);
      if (k === k1) to = P.length - 1;
      lo_c = cum[k] + reach(k);
      hi_c = cum[Math.min(k + 1, pts.length - 1)] - reach(k + 1);
      if (k < a1 && k >= k0 && k < k1 && (deck[k] !== deck[k] || deck[k + 1] !== deck[k + 1])) split(pts[k][0], pts[k][1], cum[k], pts[k + 1][0], pts[k + 1][1], cum[k + 1], 0);
    }
    return { P, C, Y, from, to, orig };
  };
  /**
   * The points where a path turns so tightly that, drawn as one strip, its
   * inside edge would run backwards and the strip fold over on itself: it
   * is drawn in two there, each part square to its own last piece, and a
   * round pad covers the joint (as at its ends).
   */
  const pathJoints = new Map<number, Uint8Array>();
  const jointsOf = (line: number) => {
    let J = pathJoints.get(line);
    if (J) return J;
    const P = paths[line].pts, N = P.length, H = PHALF[line];
    J = new Uint8Array(N);
    const turn = (k: number) => {
      const p = P[k - 1], q = P[k], r = P[k + 1];
      const l1 = Math.hypot(q[0] - p[0], q[1] - p[1]), l2 = Math.hypot(r[0] - q[0], r[1] - q[1]);
      return l1 < 1e-3 || l2 < 1e-3 ? 1 : ((q[0] - p[0]) * (r[0] - q[0]) + (q[1] - p[1]) * (r[1] - q[1])) / (l1 * l2);
    };
    for (let pass = 0, more = true; more && pass < 6; pass++) {
      more = false;
      // (Each run between joints as strip() draws it: mitred at its bends.)
      for (let a = 0; a < N - 1; ) {
        let b = a + 1;
        while (b < N - 1 && !J[b]) b++;
        const side = (k: number, sgn: number): XZ => {
          let mm = 1;
          if (k > a && k < b) {
            const ch = Math.sqrt(Math.max(0, (1 + turn(k)) / 2));
            if (ch < Math.cos((10 * Math.PI) / 180)) mm = 1 / Math.max(0.5, ch);
          }
          const u = P[Math.max(a, k - 1)], v = P[Math.min(b, k + 1)];
          let tx = v[0] - u[0], tz = v[1] - u[1];
          if (k > a && k < b) {
            const l1 = Math.hypot(P[k][0] - u[0], P[k][1] - u[1]) || 1, l2 = Math.hypot(v[0] - P[k][0], v[1] - P[k][1]) || 1;
            tx = (P[k][0] - u[0]) / l1 + (v[0] - P[k][0]) / l2;
            tz = (P[k][1] - u[1]) / l1 + (v[1] - P[k][1]) / l2;
          }
          const tl = Math.hypot(tx, tz) || 1;
          return [P[k][0] + (tz / tl) * H * mm * sgn, P[k][1] - (tx / tl) * H * mm * sgn];
        };
        // (As strip() lays its triangles: each piece's two halves either
        // side of its diagonal, and each piece and the next either side of
        // the line across between them. Both on one side: a fold.)
        const apart = (p: XZ, q: XZ, u: XZ, v: XZ) => {
          const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (L < 1e-3) return true;
          const f = (o: XZ) => ((q[0] - p[0]) * (o[1] - p[1]) - (q[1] - p[1]) * (o[0] - p[0])) / L;
          const fu = f(u), fv = f(v);
          return fu * fv <= 0 || Math.min(Math.abs(fu), Math.abs(fv)) <= 0.01;
        };
        for (let k = a; k < b; k++) {
          if (Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]) < 1e-3) continue;
          const L0 = side(k, -1), R0 = side(k, 1), L1 = side(k + 1, -1), R1 = side(k + 1, 1);
          let ok = apart(R0, L1, L0, R1);
          if (ok && k + 1 < b) ok = apart(L1, R1, R0, side(k + 2, -1));
          if (ok) continue;
          // (Cut at the tighter of the piece's bends, where it has one.)
          const c = [k, k + 1, k + 2].filter((m) => m > a && m < b && m < N - 1).sort((m, n) => turn(m) - turn(n));
          if (c.length) {
            J[c[0]] = 1;
            more = true;
          }
        }
        a = b;
      }
    }
    pathJoints.set(line, J);
    return J;
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
        const J = jointsOf(line);
        const dr = drape(pa.pts, PCUM[line], k0, k1, deck, PHALF[line], J);
        const last = pa.pts.length - 1;
        for (let a = k0; a < k1; ) {
          let b = a + 1;
          while (b < k1 && !J[b]) b++;
          strip(into, dr.P, dr.C, dr.orig.get(a)!, dr.orig.get(b)!, PHALF[line], lift, {
            yAt: (kk) => dr.Y[kk],
            ground: groundY,
            bisect: true,
            lo: J[a] || a === 0 ? dr.orig.get(a)! : 0,
            hi: J[b] || b === last ? dr.orig.get(b)! : dr.P.length - 1,
          });
          if (J[a]) disc(into, pa.pts[a][0], pa.pts[a][1], PHALF[line], lift, deck[a] === deck[a] ? deck[a] : undefined, groundY);
          a = b;
        }
        // Round ends, so paths that meet or branch join without a notch.
        if (k0 === 0 && deck[0] !== deck[0]) disc(into, pa.pts[0][0], pa.pts[0][1], PHALF[line], lift, undefined, groundY);
        if (k1 === pa.pts.length - 1 && deck[k1] !== deck[k1]) disc(into, pa.pts[k1][0], pa.pts[k1][1], PHALF[line], lift, undefined, groundY);
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
    if (r && r.d < halfNear(r.line, r.seg, r.u) + pad) return false;
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
          const off = (halfK(line, k) + 2.4 + rand() * 0.8) * side;
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
  // The roads as the map draws them: a road built as one strip past its side
  // roads (a tee) is one line, the pieces between other joints are a line
  // each. (So the map shows a break only where the road has one.)
  const mapRoads: { e: OsmEdge; pts: XZ[]; width: number }[] = [];
  {
    const used = new Uint8Array(edges.length);
    const next = (i: number, j: number) => (JX.tee[j] || jDegree[j] === 2 ? thruMate(i, j) : undefined);
    edges.forEach((e, i) => {
      if (used[i]) return;
      // Back to where the strip starts, then along it.
      let first = i, from = e.a;
      for (let o = next(first, from); o !== undefined && o !== i && !used[o]; o = next(first, from)) {
        from = edges[o].a === from ? edges[o].b : edges[o].a;
        first = o;
      }
      const pts: XZ[] = [];
      let wl = 0, len = 0;
      for (let c: number | undefined = first, at = from; c !== undefined && !used[c]; ) {
        used[c] = 1;
        const P = edges[c].a === at ? EP[c] : [...EP[c]].reverse();
        pts.push(...(pts.length ? P.slice(1) : P));
        wl += edges[c].w * ELEN[c];
        len += ELEN[c];
        at = edges[c].a === at ? edges[c].b : edges[c].a;
        c = next(c, at);
      }
      // (One piece: its own width, as before. A strip of several: their average by length.)
      mapRoads.push({ e, pts, width: len > ELEN[first] && len > 0 ? wl / len : edges[first].w });
    });
  }
  const mapLines: MapData['lines'] = [
    ...canals.map((c) => ({ pts: c.pts, width: c.w, color: '#7fb6d4' })),
    ...paths.map((p) => ({ pts: p.pts, width: 1.6, color: p.k === 'cycle' ? '#c98a73' : '#e2dccd' })),
    ...viaducts.map((pts) => ({ pts, width: 5, color: '#8d8d96' })),
    ...mapRoads
      .sort((p, q) => rankOf(p.e.cls) - rankOf(q.e.cls))
      .map(({ e, pts, width }) => ({ pts, width, color: rankOf(e.cls) >= 5 ? '#f3c46b' : rankOf(e.cls) >= 3 ? '#f8e29a' : '#ffffff' })),
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
      blds, rankOf, deckSplits, nearDeck, WB, GORE, throughLines, throughPairs, paveY, giveWays, bldRoads, pairedLines: (i: number, f = 0.5) => (paired(edges[i]) ? pairedLines(i, f) : null), laneWOf,
      // May road `line` carry a marking at (x, z)? Not under another road, on an island or in a junction.
      lineOpen: (line: number, x: number, z: number, y: number) => !coveredBy(line, x, z, y) && !onIsland(x, z) && !inPaving(x, z, y),
      // Where any mark may stop (for the checks: no one road asked about).
      outlineAt,
      outlineRingsNear: (x: number, z: number, r: number) => outlineRings(Math.floor(x / TILE), Math.floor(z / TILE)).filter((g) => g.corner.some((p) => Math.abs(p[0] - x) < r && Math.abs(p[1] - z) < r)).map((g) => ({ hole: g.hole, corner: g.corner })),
      stopsAt: (x: number, z: number, y: number) => ({ paving: inPaving(x, z, y), island: onIsland(x, z), gore: inGore(x, z) }),
      whyClosed: (line: number, x: number, z: number, y: number) => ({ covered: coveredBy(line, x, z, y), island: onIsland(x, z), paving: inPaving(x, z, y), gore: inGore(x, z) }),
      markStops, throughEnd: (line: number, end: number) => throughEnds.has(line * 2 + end),
      piers: () => {
        const out: { x: number; z: number; top: number; kind: string; self: number }[] = [];
        edges.forEach((_, line) => pillarsOf(line, 0, EP[line].length - 1, (x, z, top) => out.push({ x, z, top, kind: 'flyover', self: line })));
        viaducts.forEach((pts, line) => railPiers(line).forEach((q) => out.push({ x: pts[q][0], z: pts[q][1], top: railY(line, q) - 1.1, kind: 'rail', self: -1 })));
        return out;
      },
      crossings, CROSS_FROM, CROSS_W, yBoxes, boxWhy, signals: M.signals ?? [],
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
      halfNear,
      cutOf,
      jointWalls, jointDeck, onTeeOf, isDeckSplit: (j: number) => deckSplits.has(j), needs, jCap, jCeil, deckEnd, sepA, sepB, relAlong, relOwn, stripShape, landOver, trims: (i: number) => [trimA(i), trimB(i)], mates, jE, ELEN, tiltAt, LIMITS, WL, throughOf, mateOf: mate, WIDTH_RATE, runOf, runs,
      fillTop: (k: number, x: number, z: number) => fillTop(JX.shapes.length + k, x, z),
      jTop: (k: number, x: number, z: number) => jTop(k, x, z),
      oneLine, edges, EP, ECUM, EHALF, elevated, isDeck, embank, hasProfile, deckY, jRel, baseAt, heightAt, paths, PHALF, roads, jointsOf, drape, PCUM, pathDeck };
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
        // (Asked the way the car asks whether it is in the water. A road's
        // bed lies a little below the land around it, so "lower than the
        // land" ruled out every road, and no spot was ever found.)
        if (/water/i.test(surfaceAt(px, pz, heightAt(px, pz)).name)) continue;
        return { x: px, z: pz, yaw: Math.atan2(-(b[1] - a[1]), b[0] - a[0]) };
      }
      return null;
    },
    surfaceY(x, z, y) {
      const g = heightAt(x, z);
      const r = roads.nearest(x, z, 12, (i) => hasProfile[i]);
      if (r && r.d < halfNear(r.line, r.seg, r.u) + 0.6) {
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
