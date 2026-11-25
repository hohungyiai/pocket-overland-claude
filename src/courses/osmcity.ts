import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fbm, lerp, mulberry32, smoothstep, valueNoise } from '../noise';
import { SURFACES, type Course, type MapData, type Surface, type XZ } from './types';
import * as D from './detail';
import { TILE, TileStreamer, type Layer, type TileKit } from '../world/stream';
import { SegIndex, inRing, resample, ringArea } from '../world/segindex';
import { convexHull, easeSide, inRingXZ, shapeJunctions } from '../world/junctions';
import { LIMITS } from '../limits';
import type { Station } from '../fuel';
import { Clipper, ClipperOffset, EndType, FillRule, JoinType, Path64, Paths64, Point64, PointInPolygonResult } from 'clipper2-js';
import '../world/clipfix';

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
  /** Petrol stations (amenity=fuel). */
  fuel?: Station[];
}

const SEED = 1729;
const LAND = 2; // estate ground level above the sea, metres
const WL = 1.3; // canal and pond water level
const BEACH = 26; // beach width, waterline to the top of the sand
const STEP = 4;
// Each ring's points kept where they stand over tol from the line through
// those kept either side: Douglas-Peucker on the ring as a ring, cut in two
// at its first point and the point farthest from it.
function simplifyRings(P: Paths64, tol: number): Paths64 {
  const out = new Paths64();
  const t2 = tol * tol;
  for (const r of P) {
    const n = r.length;
    if (n < 4) { if (n === 3) out.push(r); continue; }
    const keep = new Uint8Array(n);
    let far = 0, fd = -1;
    for (let i = 1; i < n; i++) { const d = (r[i].x - r[0].x) ** 2 + (r[i].y - r[0].y) ** 2; if (d > fd) { fd = d; far = i; } }
    keep[0] = keep[far] = 1;
    const stack: number[] = [0, far, far, n];
    while (stack.length) {
      const b = stack.pop()!, a = stack.pop()!;
      const A = r[a], B = r[b % n];
      const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy;
      let w = -1, wd = t2;
      for (let i = a + 1; i < b; i++) {
        const ex = r[i].x - A.x, ey = r[i].y - A.y;
        const c = ex * dy - ey * dx;
        const d = L2 > 0 ? (c * c) / L2 : ex * ex + ey * ey;
        if (d > wd) { wd = d; w = i; }
      }
      if (w >= 0) { keep[w] = 1; stack.push(a, w, w, b); }
    }
    const q = new Path64();
    for (let i = 0; i < n; i++) if (keep[i]) q.push(r[i]);
    if (q.length >= 3) out.push(q);
  }
  return out;
}
/** Open lines' points no further than tol from the line through those kept either side (Douglas-Peucker, end to end). */
function simplifyLines(P: Paths64, tol: number): Paths64 {
  const out = new Paths64();
  const t2 = tol * tol;
  for (const r of P) {
    const n = r.length;
    if (n < 3) { out.push(r); continue; }
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const stack: number[] = [0, n - 1];
    while (stack.length) {
      const b = stack.pop()!, a = stack.pop()!;
      const A = r[a], B = r[b];
      const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy;
      let w = -1, wd = t2;
      for (let i = a + 1; i < b; i++) {
        const ex = r[i].x - A.x, ey = r[i].y - A.y;
        const c = ex * dy - ey * dx;
        const d = L2 > 0 ? (c * c) / L2 : ex * ex + ey * ey;
        if (d > wd) { wd = d; w = i; }
      }
      if (w >= 0) { keep[w] = 1; stack.push(a, w, w, b); }
    }
    const q = new Path64();
    for (let i = 0; i < n; i++) if (keep[i]) q.push(r[i]);
    out.push(q);
  }
  return out;
}
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
  /**
   * Where a road carries straight on (one strip) and a third leaves it at a
   * split's narrow angle: [the single road, the branch, its side (1 left,
   * -1 right)]. The branch moves out to the road's edge, as a lane peels
   * off; the road itself is left as it is.
   */
  const thruSplits = new Map<number, [number, number, number]>();
  /** At each, the single road's heading into the split. */
  const splitDir = new Map<number, XZ>();
  {
    const byNode = new Map<number, number[]>();
    edges.forEach((e, i) => {
      for (const j of [e.a, e.b]) (byNode.get(j) ?? byNode.set(j, []).get(j)!).push(i);
    });
    /** Road i's points, running away from joint j (as the map has them: which roads split is read from these). */
    const from = (i: number, j: number) => (edges[i].a === j ? edges[i].pts : [...edges[i].pts].reverse());
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
      // (Where the map marks one road as carrying straight on, that road is
      // one strip, and the third meets its edge: no split, unless the third
      // leaves it at a split's narrow angle (see thruSplits).)
      const thru = list.filter((i) => (edges[i].a === j ? edges[i].ta : edges[i].tb));
      if (thru.length && thru.length !== 2) continue;
      // (All at one level; or a low bridge's end, where the road splits as it
      // comes off the bridge: kept unless the bridge proves to be a flyover,
      // below.)
      const lvs = list.map((i) => edges[i].lv ?? 0);
      const lv = Math.min(...lvs);
      if (lvs.some((v) => v !== lv) && (lvs.some((v) => v >= 2) || list.some((i) => edges[i].vd))) continue;
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
        if (thru.length) {
          // (The road carrying straight on is the single road and one branch;
          // the other branch alone moves out.)
          const side = [L, R].find((q) => !thru.includes(list[q]));
          if (thru.includes(list[c]) && side !== undefined) {
            thruSplits.set(j, [list[c], list[side], side === L ? 1 : -1]);
            splitDir.set(j, u);
          }
          break;
        }
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
    // (Blurred: the distance has a crease along every line midway between
    // two waters, the ridge of a hill, and a road crossing it went from
    // climbing to falling within a metre or two. Two passes of a 5-cell
    // box each way round it off over 30 m or so. Redrawn maps only: today's
    // map keeps its hills to the centimetre.)
    const redrawn = M.edges.some((e) => e.ta || e.tb);
    for (let q = 0; q < d.length; q++) d[q] = Math.min(d[q], 400);
    const t = new Float32Array(d.length);
    for (let pass = 0; pass < (redrawn ? 2 : 0); pass++) {
      for (let j = 0; j < DH; j++)
        for (let i = 0; i < DW; i++) {
          let sum = 0;
          for (let o = -2; o <= 2; o++) sum += d[j * DW + Math.min(DW - 1, Math.max(0, i + o))];
          t[j * DW + i] = sum / 5;
        }
      for (let j = 0; j < DH; j++)
        for (let i = 0; i < DW; i++) {
          let sum = 0;
          for (let o = -2; o <= 2; o++) sum += t[Math.min(DH - 1, Math.max(0, j + o)) * DW + i];
          d[j * DW + i] = sum / 5;
        }
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
  // (A split at a bridge's end where the bridge is a flyover is no split on the ground.)
  for (const S of [deckSplits, thruSplits])
    for (const [j, l] of S)
      if (l.slice(0, S === thruSplits ? 2 : 3).some((i) => elevated[i] !== elevated[l[0]])) {
        S.delete(j);
        splitDir.delete(j);
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
  // (How far apart in height two roads may stand and still be paved across
  // where they part: 25 cm on redrawn maps, whose kerbs and walls stand
  // between roads further apart (feedback 9); 0.8 m on today's map, which
  // keeps its old kerbs and had a gap left open between them at 31 places.)
  const GORE_STEP = oneLine ? 0.25 : 0.8;
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
    const caps: [number, number, number, number][] = [];
    for (const [j, [c, L, R]] of deckSplits) {
      if (isDeck[c]) continue;
      const hc = endHalf(c, j), hl = endHalf(L, j), hr = endHalf(R, j);
      const capL = Math.min(hl, hc), capR = Math.min(hr, hc);
      const capC = Math.min(hc, capL + capR - 0.1);
      caps.push([j, c, capC, hc], [j, L, capL, hl], [j, R, capR, hr]);
    }
    // (A branch peeling off a road that carries on starts no wider than that road.)
    for (const [j, [c, q]] of thruSplits) if (!isDeck[c]) caps.push([j, q, Math.min(endHalf(q, j), endHalf(c, j)), endHalf(q, j)]);
    {
      for (const [j, i, cap, h] of caps) {
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
    const moves: [number, number, number, number][] = [];
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
      moves.push([j, L, sl, 1], [j, R, sr, -1]);
    }
    // (A branch peeling off a road that carries on: its outside edge on that
    // road's edge. A branch wider than the road, where it was not narrowed
    // to start as wide, moves in instead: the road's surface is there.)
    for (const [j, [c, q, side]] of thruSplits) moves.push([j, q, endHalf(c, j) - endHalf(q, j), side]);
    {
      for (const [j, q, shift, side] of moves) {
        if (Math.abs(shift) < 0.15) continue;
        const Q = edges[q].a === j ? EP[q] : [...EP[q]].reverse();
        let len = 0;
        const cum = Q.map((p, k) => (k ? (len += Math.hypot(p[0] - Q[k - 1][0], p[1] - Q[k - 1][1])) : 0));
        const D = Math.min(Math.abs(shift) * SPLIT_RATE * 1.5, len * 0.5);
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
    ramp: (i, j) => (jE[edges[i].a === j ? edges[i].b : edges[i].a] ?? []).some((o) => elevated[o]),
    round: oneLine,
    close: oneLine,
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
  // (Held to an island's point: may run past 40% of the road; see TRIM_A.)
  const ptA = new Float32Array(edges.length);
  const ptB = new Float32Array(edges.length);
  // (The road each is held to that point beside: see holdBase.)
  const ptMateA = new Int32Array(edges.length).fill(-1);
  const ptMateB = new Int32Array(edges.length).fill(-1);
  // (How much of a road held from one end is left to climb or fall in
  // before its other end: 10 m, or 4 m where that end carries straight on
  // into one road on the ground, which climbs on from there. A slip road
  // whose island's point lay in its last 10 m, the rest of it on beyond
  // the joint, was not held to it, and reached it 40 cm below the road
  // it left, its edge line round the point buried under the higher one.)
  const restAt = (q: number, j: number) => {
    const on = (jE[j] ?? []).filter((t) => t !== q);
    return on.length === 1 && !elevated[on[0]] && !elevated[q] ? 4 : 10;
  };
  const restA = (q: number) => restAt(q, edges[q].a);
  const restB = (q: number) => restAt(q, edges[q].b);
  const mates = edges.map(() => [] as { o: number; ia: boolean; oa: boolean; L: number; pt?: boolean }[]);
  jE.forEach((list, j) => {
    if (list.length < 2) return;
    for (const i of list)
      for (const o of list) {
        // (Two flyover decks climb together. Two pieces of one strip are
        // not side by side: one carries on where the other ends.)
        // (Two flyover decks parting at a fork, though, each stood its own
        // height above the hills under it: they reached the island's point
        // up to 0.36 m apart, its kerb climbing between them and a wall
        // standing up out of the lower one's paving. Redrawn maps: they
        // share one height to the point, as roads on the ground do.)
        const decks = elevated[i] && elevated[o];
        if (o === i || (decks && !oneLine) || thruJoint(i, j) === o) continue;
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
        // (How far along the island's point lies: where the two roads'
        // edges are 1.8 m apart, each as wide as drawn there, as the gore
        // between them measures it (a road's one width, wider than its
        // drawn strip, put a gore's point 20 m short of where the hold
        // ended). Never past 10 m short of either road's far end.)
        const lim = Math.min(80, ELEN[i] - (ia ? restB(i) : restA(i)), ELEN[o] - (oa ? restB(o) : restA(o)));
        const toPoint = () => {
          let d = s;
          while (d < lim) {
            const [x1, z1] = along(i, ia, d + 1);
            const [x2, z2] = along(o, oa, d + 1);
            if (Math.hypot(x1 - x2, z1 - z2) >= halfAtS(i, ia ? d + 1 : ELEN[i] - d - 1) + halfAtS(o, oa ? d + 1 : ELEN[o] - d - 1) + 1.8) break;
            d += 1;
          }
          return d;
        };
        if (decks) {
          const d = toPoint();
          if (d < lim) mates[i].push({ o, ia, oa, L: d + 1, pt: true });
          continue;
        }
        // (Wherever two roads part, both stay level on past the point of the
        // island between them, until their edges are 1.8 m apart: one height
        // at the point, a ramp climbing or falling only beyond it, its wall
        // growing from nothing there. Each held as far as its own edge runs
        // beside the other's, and no further than 40 m. Not only where one
        // climbs to a flyover: a slip road rising to meet a deck further on,
        // or one falling with the ground, parted 0.7 m apart at the point.)
        // (At a flyover's end the two come off its deck side by side: held
        // level there, a ramp lost half its length and the roads beyond
        // shifted under the next flyover. They share one height to the
        // point instead, as roads overlapping do: see relAlong.)
        const atDeck = (jE[j] ?? []).some((t) => elevated[t]);
        let mateL = s;
        let pt = false;
        if (oneLine && !elevated[i] && !elevated[o]) {
          // (To the point, however far along it lies, leaving 10 m of each
          // road beyond it to climb or fall in: 40% of the shorter road left
          // a point 31 m along a 61 m slip road with the two 0.7 m apart.)
          const d = toPoint();
          if (d < lim && atDeck) (mateL = d + 1), (pt = true);
          else if (d < lim) {
            if (ia && d + 1 > ptA[i]) (ptA[i] = d + 1), (ptMateA[i] = o);
            else if (!ia && d + 1 > ptB[i]) (ptB[i] = d + 1), (ptMateB[i] = o);
          }
        }
        // Two roads on the ground (or ramps) share one height where they
        // overlap (see relAlong); beside a flyover deck, a road stays level.
        if (!elevated[i] && !elevated[o]) {
          mates[i].push({ o, ia, oa, L: mateL, pt });
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
  // (Held to an island's point as far along as it lies, so long as 10 m of
  // the road is left to climb or fall in between the two ends' holds.)
  const TRIM_A0 = Float64Array.from(edges, (_, i) => Math.min(Math.max(elevated[i] ? 0 : JX.trimA[i] || 0, sepA[i]), ELEN[i] * 0.4));
  const TRIM_B0 = Float64Array.from(edges, (_, i) => Math.min(Math.max(elevated[i] ? 0 : JX.trimB[i] || 0, sepB[i]), ELEN[i] * 0.4));
  const TRIM_A = Float64Array.from(edges, (_, i) => Math.max(TRIM_A0[i], Math.min(ptA[i], ELEN[i] - restB(i) - Math.max(TRIM_B0[i], ptB[i] > 0 ? Math.min(ptB[i], (ELEN[i] - 10) / 2) : 0))));
  const TRIM_B = Float64Array.from(edges, (_, i) => Math.max(TRIM_B0[i], Math.min(ptB[i], ELEN[i] - restA(i) - TRIM_A[i])));
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
    const under = groundUnder;
    let sum = 0;
    let w = 0;
    for (const m of mates[i]) {
      // (One held down under a flyover keeps its height, and where the two
      // share one height to an island's point (pt) the road beside it takes
      // it, all of it: left out, the two parted 0.16 m apart at the point.)
      const mHeld = held(m.o) && !!m.pt;
      if (held(m.o) && !m.pt) continue;
      const d = m.ia ? s : ELEN[i] - s; // from the joint
      if (d > m.L + 60) continue;
      const so = m.oa ? d : ELEN[m.o] - d;
      if (so < 0 || so > ELEN[m.o]) continue;
      const di = m.ia ? m.L : ELEN[i] - m.L;
      const dO = m.oa ? m.L : ELEN[m.o] - m.L;
      // (To an island's point, what they part by is their heights' own
      // difference there, the hills under each counted: two flyover decks
      // at one height above the ground eased apart over 8 m at 2%.)
      let dbL = 0;
      if (m.pt) {
        const ci = Math.max(0, Math.min(ELEN[i], di)), co = Math.max(0, Math.min(ELEN[m.o], dO));
        dbL = roadBase(m.o, co, ...along(m.o, true, co)) - roadBase(i, ci, ...along(i, true, ci));
      }
      const gap = (Math.abs(relOwn(m.o, Math.max(0, Math.min(ELEN[m.o], dO))) + dbL - relOwn(i, Math.max(0, Math.min(ELEN[i], di)))) / 2) * (mHeld ? 2 : 1);
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
      // (To an island's point, one height, not one height above the hills:
      // each road's ground under its own middle, 8 m apart where the two
      // part, differed by 0.2 m there. Not elsewhere: two roads on the
      // ground beside each other lie each on its own.)
      let db = 0;
      if (m.pt) {
        const [xi, zi] = along(i, true, s);
        const [xo, zo] = along(m.o, true, so);
        db = roadBase(m.o, so, xo, zo) - roadBase(i, s, xi, zi);
      }
      sum += (t * (relOwn(m.o, so) + db - r)) / ((oThru && !iThru) || mHeld ? 1 : 2);
      w += t;
    }
    groundUnder = under;
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
      v = stepCache[key] = (oneLine ? holdBase(i, fromA, fromA ? trimA(i) : trimB(i)) : baseAt(M.junctions[j][0], M.junctions[j][1])) - baseAt(x, z);
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
  // The ground a raised road held to an island's point stands on, s m from
  // its joint j: the joint's own across its paving, then rising and falling
  // with the hills under the middle between it and the road it is held
  // beside, so the two are one height all the way to the point. (Held at
  // the joint's height to a point 40 m along a hillside, a slip road came
  // to stand 1.7 m off the ground there, and climbed that back in 6 m.)
  const holdBase = (i: number, fromA: boolean, s: number) => {
    const j = fromA ? edges[i].a : edges[i].b;
    const o = fromA ? ptMateA[i] : ptMateB[i];
    if (o < 0) return jBase[j];
    const oa = edges[o].a === j;
    if ((oa ? ptMateA[o] : ptMateB[o]) !== i) return jBase[j];
    // (Not a road held into where it lies on another from its far end: the
    // two share one surface there, and the hills under the pair's middle
    // stood it 17 cm off the other where the joint's height left it 14.)
    const hold = fromA ? ptA[i] : ptB[i];
    if (mates[i].some((m) => m.ia !== fromA && !m.pt && ELEN[i] - m.L < hold)) return jBase[j];
    // (Its own height across the joint's paving only: held level on past it
    // beside a road it is one surface with, as far as that road's mouth,
    // a road on a hillside stood 1.2 m off the ground at its end.)
    const paved = (q: number, qa: boolean) => Math.min(elevated[q] ? 0 : (qa ? JX.trimA[q] : JX.trimB[q]) || 0, ELEN[q] * 0.4);
    const t0 = Math.max(paved(i, fromA), paved(o, oa));
    if (s <= t0) return jBase[j];
    const mid = (t: number) => {
      const p = along(i, fromA, t);
      const q = along(o, oa, t);
      return baseAt((p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
    };
    return jBase[j] + (mid(s) - mid(t0)) * smoothstep(t0, t0 + 6, s);
  };
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
      // (Sharing the road between its two ends' steps: the larger takes as
      // much of it as its part of the two, the smaller half. Half each, a
      // road held level to two islands' points, 1.2 m to come back to the
      // hills at one end and 7 cm at the other, fell 23% in 8 m.)
      const back = Math.abs(stepAt(i, !fromA));
      const share = Math.max(0.5, Math.abs(stepAt(i, fromA)) / (Math.abs(stepAt(i, fromA)) + back || 1));
      const room = (fromA ? trimB(i) : trimA(i)) > 0 && (jRel[fromA ? edges[i].b : edges[i].a] ?? 0) > 0.02 ? run * share : run;
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
    if (ta > 0 && jRel[e.a] > 0.02) r += smoothstep(0.02, 0.5, jRel[e.a]) * (s <= ta ? holdBase(i, true, s) - b : baseHold(i, true, s, F) * stepAt(i, true));
    if (tb > 0 && jRel[e.b] > 0.02) r += smoothstep(0.02, 0.5, jRel[e.b]) * (ELEN[i] - s <= tb ? holdBase(i, false, ELEN[i] - s) - b : baseHold(i, false, ELEN[i] - s, F) * stepAt(i, false));
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
    type Hit = { i: number; k: number; o: number; so: number; dot: number; yi: number; yo: number; bo: number; beside: boolean };
    const hitsNow = () => {
      const hits: Hit[] = [];
      edges.forEach((_, i) => {
        if (!raised(i)) return;
        const P = EP[i];
        for (let k = 0; k < P.length; k++) {
          const yi = roadBase(i, ECUM[i][k], P[k][0], P[k][1]) + relAlong(i, ECUM[i][k]);
          roads.each(P[k][0], P[k][1], EHALF[i] + 12, (o, seg, u, dd) => {
            // (Overlapping by 0.3 m or more: under it. Touching, or nearly: a
            // slip road beside it, which may only merge, one surface with it
            // until the two part, never be held down or cleared.)
            if (o === i || elevated[o] || shares(i, o) || dd > halfK(i, k) + halfNear(o, seg, u) + (oneLine ? 0.3 : -0.3)) return;
            const beside = dd > halfK(i, k) + halfNear(o, seg, u) - 0.3;
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
            hits.push({ i, k, o, so, dot: Math.abs(d1[0] * d2[0] + d1[1] * d2[1]), yi, yo, bo, beside });
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
      for (const h of hits) if (!merges(h) && !h.beside) hold(h);
      for (const h of hits) {
        if (!merges(h)) continue;
        if (canRise(h.o, h.so, h.yi - h.bo)) {
          needs[h.o].push({ s: h.so, rel: h.yi - h.bo });
          changed = true;
        } else if (!h.beside) hold(h);
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
  /**
   * How far the ground at (x, z) lies above or below that at (cx, cz), as a
   * road on it is drawn across its width: no steeper than 1 in 3.3 from its
   * middle. (Beside an embankment the ground's shape across a slip road could
   * tilt it 0.58 in 1, past what the car can take.)
   * Only the ground's tilt across the road counts, the same point the other
   * side of the middle falling as much as this one rises: the road's middle
   * keeps its own height. (Ground falling away both sides, as off the top of
   * a bank beside a road lower down, took the whole road down with it: 4 cm
   * below its own line, and a step where it ran on into a piece with no
   * such bank.)
   */
  const clampDrop = (dy: number, dist: number) => Math.max(-0.3 * dist, Math.min(0.3 * dist, dy));
  const crossDrop = (x: number, z: number, cx: number, cz: number) => clampDrop((dropAt(x, z) - dropAt(2 * cx - x, 2 * cz - z)) / 2, Math.hypot(x - cx, z - cz));
  const tiltY = (i: number, s: number, y: number, x: number, z: number, cx: number, cz: number) => {
    const t = tiltAt(i, s);
    if (t <= 0) return y;
    return oneLine ? y + t * crossDrop(x, z, cx, cz) : lerp(y, dropAt(x, z) + relAlong(i, s), t);
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
      /** Is point q of F on a road (tested just outside it, along F as it runs there)? */
      const onRoad = (F: XZ[], q: number) => {
        const p = F[q];
        const a = F[Math.max(0, q - 1)];
        const b = F[Math.min(F.length - 1, q + 1)];
        const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const x = p[0] + ((b[1] - a[1]) / tl) * 0.05;
        const z = p[1] - ((b[0] - a[0]) / tl) * 0.05;
        let hit = false;
        roads.each(x, z, 16, (line, seg, u, d) => {
          if (!hit && d < halfNear(line, seg, u) - 0.3 && drawnAt(line, seg, u)) hit = true;
        });
        return hit;
      };
      const runs: XZ[][] = [];
      let run: XZ[] = [];
      F.forEach((p, q) => {
        if (!onRoad(F, q)) run.push(p);
        else {
          if (run.length > 1) runs.push(run);
          run = [];
        }
      });
      if (run.length > 1) runs.push(run);
      // (A run's end looks out along the run alone, not on to the point cut
      // after it: tried again that way, it may touch the road after all.)
      for (const R of runs) {
        while (R.length > 1 && onRoad(R, 0)) R.shift();
        while (R.length > 1 && onRoad(R, R.length - 1)) R.pop();
        if (R.length > 1) kept.push(R);
      }
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
  // (What rawHeight found last: the shore and the water's edge distances. Here, ahead of the crossings, which ask the ground's height.)
  const probe = { s: 60, w: 30 };
  const CROSS_W = 3;
  const STOP_AT = CROSS_FROM + CROSS_W + 1;
  /** span: where a road's two ways share one zebra, the stripes' reach either side of c (to the left of t), on one of them; null on the other. */
  type Crossing = { line: number; end: 0 | 1; s: number; half: number; c: XZ; t: XZ; inbound: number; group: number; light: XZ | null; span?: [number, number] | null; spanT?: XZ };
  const crossings: Crossing[] = [];
  const crossCand: { cr: Crossing; lightOpts: XZ[] }[] = [];
  const crossEnd = new Map<string, Crossing>();
  /** The paved slots through medians where a zebra crosses them, paved once every zebra has been looked at (paving one first made the next pair's median look paved already). */
  const medianCuts: { ring: XZ[]; c: XZ }[] = [];
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
    // (And a narrow one-way carriageway beside its twin, the road's other
    // way, that has one: a zebra crosses the whole road, both its ways. On
    // Tampines Central 1 the one-lane way out had none, the zebra across the
    // two-lane way in stopped half way over the road.)
    const twinOf = (m: Arm) => edges[m.line].one && !!edges[m.line].name && ms.some((o) => o.line !== m.line && edges[o.line].one && edges[o.line].name === edges[m.line].name);
    const crossed = mouths.filter((m) => ms.includes(m) || (!hasProfile[m.line] && rankOf(edges[m.line].cls) >= 1 && m.half >= 1.5 && ELEN[m.line] > m.s + STOP_AT + 4 && twinOf(m)));
    for (const m of crossed) {
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

  /** Do any two of a closed ring's sides cross? */
  const ringCrosses = (r: XZ[]) => {
    const n = r.length;
    for (let a = 0; a < n; a++)
      for (let b = a + 2; b < n; b++) {
        if (a === 0 && b === n - 1) continue;
        const [p, q] = [r[a], r[(a + 1) % n]], [u, v] = [r[b], r[(b + 1) % n]];
        const d1 = (q[0] - p[0]) * (u[1] - p[1]) - (q[1] - p[1]) * (u[0] - p[0]);
        const d2 = (q[0] - p[0]) * (v[1] - p[1]) - (q[1] - p[1]) * (v[0] - p[0]);
        const d3 = (v[0] - u[0]) * (p[1] - u[1]) - (v[1] - u[1]) * (p[0] - u[0]);
        const d4 = (v[0] - u[0]) * (q[1] - u[1]) - (v[1] - u[1]) * (q[0] - u[0]);
        if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
      }
    return false;
  };
  // (Every junction ring a simple polygon, its sides crossing nowhere: a
  // slip road's island end, its edge carried on past the joint, crossed
  // back over its own nose, and the paving drawn from it reached out past
  // its outline over the kerb. Where a ring crosses itself, the part wound
  // the way most of it is is kept, the largest piece.)
  {
    const simple = (r: XZ[]): XZ[] => {
      const p = new Path64();
      for (const q of r) p.push(new Point64(Math.round(q[0] * 1000), Math.round(q[1] * 1000)));
      if (Clipper.area(p) < 0) p.reverse();
      const P = new Paths64();
      P.push(p);
      let best: Path64 | null = null;
      for (const o of Clipper.Union(P, undefined, FillRule.Positive)) if (Clipper.area(o) > 0 && (!best || Clipper.area(o) > Clipper.area(best))) best = o;
      if (!best) return r;
      const out = best.map((q): XZ => [q.x / 1000, q.y / 1000]);
      // (The way round it was given.)
      let a0 = 0;
      r.forEach((q, i) => (a0 += q[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * q[1]));
      return a0 < 0 ? out.reverse() : out;
    };
    for (const sh of [...JX.shapes, ...JX.fills]) if (sh.ring.length > 3 && ringCrosses(sh.ring)) sh.ring = simple(sh.ring);
  }
  // Everything paved at junctions: the shapes, and islands filled in.
  const JPOLY = [...JX.shapes.map((sh) => ({ ...sh, fill: false })), ...JX.fills.map((f) => ({ ...f, mouths: [] as typeof JX.shapes[number]['mouths'], kerbs: f.kerbs ?? ([] as XZ[][]), fill: true }))];
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
  /** Polygon P cut to the side of the line (x if ax 0, z if 1) = v where the coordinate is at least v (above) or at most v. */
  const clipHalf = (P: XZ[], ax: 0 | 1, v: number, above: boolean): XZ[] => {
    const out: XZ[] = [];
    const inn = (p: XZ) => (above ? p[ax] >= v : p[ax] <= v);
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      const ia = inn(a), ib = inn(b);
      if (ia) out.push(a);
      if (ia !== ib) {
        const t = (v - a[ax]) / (b[ax] - a[ax]);
        const q: XZ = ax === 0 ? [v, a[1] + (b[1] - a[1]) * t] : [a[0] + (b[0] - a[0]) * t, v];
        out.push(q);
      }
    }
    return out;
  };
  /**
   * A junction paved as its roads' own surface (closedTo): its paving as
   * drawn, the ring cut into squares GRID_M across, each piece ear-clipped,
   * every corner at the height worked out there; its top read off the same
   * triangles. (Ear-clipped whole, its triangles ran tens of metres corner
   * to corner, straight over the hills, and a kerb laid on the ground
   * beside its edge lay up to 5 cm under it. Cut on a fixed lattice, two
   * squares meet at the same points, so no crack between them.)
   */
  const GRID_M = 2;
  const jMeshOf = new Map<number, { P: XZ[]; Y: number[]; T: number[]; cells: Map<number, number[]> } | null>();
  const jMesh = (id: number) => {
    let M = jMeshOf.get(id);
    if (M !== undefined) return M;
    M = null;
    if (oneLine && (JPOLY[id] as { closed?: boolean }).closed) {
      const ring = JPOLY[id].ring;
      const P: XZ[] = [], Y: number[] = [], T: number[] = [];
      const xs = ring.map((p) => p[0]), zs = ring.map((p) => p[1]);
      const i0 = Math.floor(Math.min(...xs) / GRID_M), i1 = Math.floor(Math.max(...xs) / GRID_M);
      const k0 = Math.floor(Math.min(...zs) / GRID_M), k1 = Math.floor(Math.max(...zs) / GRID_M);
      for (let i = i0; i <= i1; i++) {
        const strip = clipHalf(clipHalf(ring, 0, i * GRID_M, true), 0, (i + 1) * GRID_M, false);
        if (strip.length < 3) continue;
        for (let k = k0; k <= k1; k++) {
          const cell = clipHalf(clipHalf(strip, 1, k * GRID_M, true), 1, (k + 1) * GRID_M, false);
          if (cell.length < 3) continue;
          const base = P.length;
          for (const [x, z] of cell) {
            P.push([x, z]);
            Y.push(jTopOwn(id, x, z));
          }
          for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(cell.map(([x, z]) => new THREE.Vector2(x, z)), [])) {
            const pa = cell[a], pb = cell[b], pc = cell[c];
            const w = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
            if (Math.abs(w) < 1e-9) continue;
            // (Each wound as the fan's are, facing up.)
            T.push(...(w < 0 ? [base + a, base + b, base + c] : [base + a, base + c, base + b]));
          }
        }
      }
      const cells = new Map<number, number[]>();
      for (let t = 0; t < T.length; t += 3) {
        const ps = [P[T[t]], P[T[t + 1]], P[T[t + 2]]];
        const a0 = Math.floor(Math.min(...ps.map((p) => p[0])) / 8), a1 = Math.floor(Math.max(...ps.map((p) => p[0])) / 8);
        const b0 = Math.floor(Math.min(...ps.map((p) => p[1])) / 8), b1 = Math.floor(Math.max(...ps.map((p) => p[1])) / 8);
        for (let ci = a0; ci <= a1; ci++) for (let ck = b0; ck <= b1; ck++) (cells.get(ci * 100003 + ck) ?? cells.set(ci * 100003 + ck, []).get(ci * 100003 + ck)!).push(t);
      }
      M = { P, Y, T, cells };
    }
    jMeshOf.set(id, M);
    return M;
  };
  /** Is joint id's top read off its drawn triangles (jMesh)? Its kerb then lies on what is drawn about it, as among other pavings. */
  const drawnJoint = (id: number) => id >= 0 && jMesh(id) !== null;
  /** The top of junction id's paving at (x, z) (before its small lift). */
  const jTop = (id: number, x: number, z: number) => {
    const M = jMesh(id);
    if (M) {
      for (const t of M.cells.get(Math.floor(x / 8) * 100003 + Math.floor(z / 8)) ?? []) {
        const [a, b, c] = [M.T[t], M.T[t + 1], M.T[t + 2]];
        const [x1, z1] = M.P[a], [x2, z2] = M.P[b], [x3, z3] = M.P[c];
        const det = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3);
        if (Math.abs(det) < 1e-9) continue;
        const l1 = ((z2 - z3) * (x - x3) + (x3 - x2) * (z - z3)) / det, l2 = ((z3 - z1) * (x - x3) + (x1 - x3) * (z - z3)) / det, l3 = 1 - l1 - l2;
        if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) return l1 * M.Y[a] + l2 * M.Y[b] + l3 * M.Y[c];
      }
    }
    return jTopOwn(id, x, z);
  };
  /** Median slots between roads lying on the ground (see jTopOwn). */
  const slotFlat = new Map<number, boolean>();
  /** jTop, worked out at the point. */
  const jTopOwn = (id: number, x: number, z: number) => {
    const sh = JPOLY[id];
    const tee = teeTop(id, x, z);
    if (tee !== undefined) return tee;
    // (A further part of a junction's paving lies on the ground as the junction's own outline does.)
    if (sh.fill && JX.fills[id - JX.shapes.length].tee !== undefined) return Math.max(rawHeight(x, z), WL + 0.15);
    // (A slot through a median between two roads that lie on the ground lies on the ground as they do: blended
    // from its corners, it stood 2-3 cm proud of the ground the kerb and edge lines beside it are laid on.)
    if (sh.fill && (sh as { closed?: boolean }).closed) {
      let flat = slotFlat.get(id);
      if (flat === undefined)
        slotFlat.set(id, (flat = !sh.ring.some(([px, pz]) => {
          const r = roads.nearest(px, pz, 30, (i) => !elevated[i]);
          return !!r && hasProfile[r.line];
        })));
      if (flat) return Math.max(rawHeight(x, z), WL + 0.15);
    }
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
      const h = y === y ? (oneLine ? y + t * clampDrop(g - gm, Math.hypot(x - m.q[0], z - m.q[1])) : lerp(y, g + r, t)) : g;
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
  /**
   * Inside any joint's paving or paved island, at about height y, right up to
   * its edge? (Beside a raised road's wall: there the joint's own wall runs
   * round its outline, and the road's would stand on its paving.)
   */
  const inJoint = (x: number, z: number, y: number) =>
    !!jGrid.get(Math.floor(x / JCELL) * 100003 + Math.floor(z / JCELL))?.some((id) => inRingXZ(JPOLY[id].ring, x, z) && Math.abs(jTop(id, x, z) - y) < 3);
  /** Distance from (x, z) to a junction's outline (0 inside) and the nearest outline point. */
  const ringDist = (ring: XZ[], x: number, z: number): [number, number, number] => {
    let best = Infinity;
    let bx = x;
    let bz = z;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ax = ring[j][0], az = ring[j][1];
      const abx = ring[i][0] - ax;
      const abz = ring[i][1] - az;
      let u = ((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz || 1);
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const ex = ax + abx * u - x, ez = az + abz * u - z;
      const d = Math.sqrt(ex * ex + ez * ez);
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
    // Where a zebra's twin across the other way lies past a median: the
    // median opens, a paved gap the crossing's width through it, its two
    // ends rounded (half round where it is narrow), and the one zebra runs
    // across both ways and the gap (the user's call, 15 Nov: the median
    // had run straight through the crossing, the stripes stopping at its
    // kerb). (Redrawn maps; a gap up to MEDIAN_CUT_MAX wide.)
    const MEDIAN_CUT_MAX = 12;
    const cuts = medianCuts;
    const lightsOf = new Map(crossCand.map(({ cr, lightOpts }) => [cr, lightOpts]));
    const medianCut = (cr: Crossing, o: Crossing, gap: number, lat: number) => {
      const sg = Math.sign(lat);
      const mx = cr.t[0] + o.t[0], mz = cr.t[1] + o.t[1], ml = Math.hypot(mx, mz) || 1;
      const t: XZ = [mx / ml, mz / ml];
      const l: XZ = [-t[1] * sg, t[0] * sg];
      // (About the median's middle, half way along between the two: it runs from -w/2 to w/2 across.)
      const w = gap;
      // (The slot wider than the stripes, so the edge lines down its sides
      // stay clear of them.)
      const h = CROSS_W / 2 + 0.6;
      const ax = (cr.c[0] + o.c[0]) / 2, az = (cr.c[1] + o.c[1]) / 2, ao = ((o.c[0] - cr.c[0]) * l[0] + (o.c[1] - cr.c[1]) * l[1]) / 2;
      const c: XZ = [ax + l[0] * (cr.half + w / 2 - ao), az + l[1] * (cr.half + w / 2 - ao)];
      // (Its ends round: half round where it is narrow, else 0.5 m at each corner.)
      const rc = w <= 3.3 ? w / 2 : 0.5;
      const L0 = -w / 2 - 0.3, L1 = w / 2 + 0.3;
      const P = (a: number, b: number): XZ => [c[0] + t[0] * a + l[0] * b, c[1] + t[1] * a + l[1] * b];
      const ground = (a: number, b: number) => {
        const [x, z] = P(a, b);
        return !inPoly(x, z, true) && !onOther(x, z, -1, 0) && !cuts.some((r) => inRingXZ(r.ring, x, z));
      };
      // (Only through ground, level with both ways, with no path along it.)
      const yOf = (q: Crossing) => {
        const r = roads.nearest(q.c[0], q.c[1], 4, (i) => i === q.line);
        return r ? topAt(r.line, r.seg, r.u, q.c[0], q.c[1]) : NaN;
      };
      const y0 = yOf(cr), y1 = yOf(o);
      // (Two ways a little apart in height are joined by the slot's slope;
      // not where one stands well above the other, nor on a bank above the
      // ground, where the stripes would fall to the ground between.)
      if (!(Math.abs(y0 - y1) <= 0.25) || y0 - Math.max(rawHeight(cr.c[0], cr.c[1]), WL + 0.15) > 0.3 || y1 - Math.max(rawHeight(o.c[0], o.c[1]), WL + 0.15) > 0.3) return false;
      /** A path along the median here (not the one the zebra carries across it). */
      const pathAlong = (x: number, z: number) => {
        const r = pathIdx.nearest(x, z, 2.5);
        if (!r) return false;
        const Q = paths[r.line].pts, A = Q[r.seg], B = Q[Math.min(Q.length - 1, r.seg + 1)];
        const dl = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
        return Math.abs(((B[0] - A[0]) * t[0] + (B[1] - A[1]) * t[1]) / dl) > 0.7;
      };
      // (Ground the whole way across it along the zebra's middle: a median, not a corner of paving.)
      for (let q = 0; q <= 8; q++) if (!ground(0, -w / 2 + 0.3 + ((w - 0.6) * q) / 8)) return false;
      for (const a of [-h, -h / 2, 0, h / 2, h])
        for (const b of [-w / 4, 0, w / 4]) {
          // (Through its middle at least: past that, where the median ends, the stub is paved below.)
          if (!ground(a, b)) {
            if (a === 0) return false;
            continue;
          }
          const [x, z] = P(a, b);
          if (Math.abs(rawHeight(x, z) - (y0 + y1) / 2) > 0.3 || pathAlong(x, z)) return false;
        }
      // (Where the median ends inside the slot, into paving, that side of
      // the slot runs on into the paving. Where it ends a little past the
      // slot, a stub or a blob of median would be left: no slot there.)
      const STUB = 6;
      const endOf = (sg: number) => {
        for (let a = 0.25; a <= h + STUB; a += 0.25) if (!ground(sg * a, 0) || !ground(sg * a, -w / 2 + 0.3) || !ground(sg * a, w / 2 - 0.3)) return a <= h ? Math.max(a + 0.3, h) : -1;
        return 0;
      };
      const arc = (ca: number, cb: number, a0: number, a1: number) => {
        const out: XZ[] = [];
        const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 12)));
        for (let q = 0; q <= n; q++) {
          const an = a0 + ((a1 - a0) * q) / n;
          out.push(P(ca + Math.cos(an) * rc, cb + Math.sin(an) * rc));
        }
        return out;
      };
      const eP = endOf(1), eN = endOf(-1);
      if (eP < 0 || eN < 0) return false;
      const e = h + rc;
      const ring: XZ[] = [P(eN ? -eN : -e, L0), P(eP || e, L0)];
      // (The + end: round the corner by the near way, along the median's end, round the far corner.)
      if (!eP) {
        ring.push(...arc(e, -w / 2 + rc, -Math.PI / 2, -Math.PI));
        ring.push(...arc(e, w / 2 - rc, Math.PI, Math.PI / 2));
      }
      ring.push(P(eP || e, L1), P(eN ? -eN : -e, L1));
      if (!eN) {
        ring.push(...arc(-e, w / 2 - rc, Math.PI / 2, 0));
        ring.push(...arc(-e, -w / 2 + rc, 0, -Math.PI / 2));
      }
      // (Wound as an island's is: anticlockwise.)
      let ar = 0;
      for (let q = 0; q < ring.length; q++) {
        const p = ring[q], n = ring[(q + 1) % ring.length];
        ar += p[0] * n[1] - n[0] * p[1];
      }
      if (ar < 0) ring.reverse();
      cuts.push({ ring, c });
      // (A light that stood in the median moves off the gap.)
      for (const q of [cr, o])
        if (q.light && inRingXZ(ring, q.light[0], q.light[1])) q.light = (lightsOf.get(q) ?? []).find(([x, z]) => !onOther(x, z, -1, 0.3) && !inPoly(x, z, true) && !cuts.some((r) => inRingXZ(r.ring, x, z))) ?? null;
      return true;
    };
    /** Stripes on cr from its own way across to o's far edge. (Square across
     * the two ways' mean: across cr's own way alone, which turned a little,
     * its stripes' ends ran askew over the other way.) */
    const spanBoth = (cr: Crossing, o: Crossing) => {
      const dx = o.c[0] - cr.c[0], dz = o.c[1] - cr.c[1];
      const mx = cr.t[0] + o.t[0], mz = cr.t[1] + o.t[1], ml = Math.hypot(mx, mz) || 1;
      cr.spanT = [mx / ml, mz / ml];
      const lat2 = dx * -cr.spanT[1] + dz * cr.spanT[0];
      cr.span = [Math.min(-cr.half, lat2 - o.half), Math.max(cr.half, lat2 + o.half)];
    };
    // A road's two ways side by side, paved between them, each with its
    // zebra lined up with the other's: one zebra across them both, its
    // stripes even all the way over (each way's own left a gap between
    // them, and read as half a zebra). Each keeps its own stop line.
    for (const cr of crossings) {
      if (cr.span !== undefined || !edges[cr.line].one || !edges[cr.line].name) continue;
      const left: XZ = [-cr.t[1], cr.t[0]];
      for (const o of crossings) {
        if (o === cr || o.span !== undefined || !edges[o.line].one || edges[o.line].name !== edges[cr.line].name) continue;
        if (o.t[0] * cr.t[0] + o.t[1] * cr.t[1] < 0.98) continue;
        const dx = o.c[0] - cr.c[0], dz = o.c[1] - cr.c[1];
        const lat = dx * left[0] + dz * left[1];
        const gap = Math.abs(lat) - cr.half - o.half;
        if (Math.abs(dx * cr.t[0] + dz * cr.t[1]) > 0.6 || gap > MEDIAN_CUT_MAX || gap < -0.5) continue;
        let paved = true;
        const sg = Math.sign(lat);
        for (const a of [-1, 0, 1])
          for (const f of [0.25, 0.5, 0.75]) {
            const off = sg * (cr.half + Math.max(0, gap) * f);
            const x = cr.c[0] + cr.t[0] * a * (CROSS_W / 2) + left[0] * off, z = cr.c[1] + cr.t[1] * a * (CROSS_W / 2) + left[1] * off;
            if (gap > 0 && !inPoly(x, z, true) && !onOther(x, z, -1, 0)) paved = false;
          }
        if (paved ? gap > 4 : !oneLine || gap < 0.3 || !medianCut(cr, o, gap, lat)) continue;
        spanBoth(cr, o);
        o.span = null;
        break;
      }
    }
    // A zebra that ends at a median with its road's other way just past it,
    // where the other way has none of its own (the map marks the crossing
    // on one way only): it carries on through the median, a paved gap as
    // above, and across the other way. (Redrawn maps.)
    if (oneLine)
      for (const cr of crossings) {
        if (cr.span !== undefined || !edges[cr.line].one || !edges[cr.line].name) continue;
        const left: XZ = [-cr.t[1], cr.t[0]];
        for (const sg of [1, -1]) {
          // (Out across the ground from its kerb until a road.)
          let g = 0.3;
          for (; g <= MEDIAN_CUT_MAX; g += 0.25) {
            const x = cr.c[0] + left[0] * sg * (cr.half + g), z = cr.c[1] + left[1] * sg * (cr.half + g);
            if (inPoly(x, z, true)) g = Infinity;
            else if (onOther(x, z, cr.line, 0)) break;
          }
          if (!(g <= MEDIAN_CUT_MAX)) continue;
          const px = cr.c[0] + left[0] * sg * (cr.half + g + 0.5), pz = cr.c[1] + left[1] * sg * (cr.half + g + 0.5);
          const h = roads.nearest(px, pz, 8, (i) => i !== cr.line && !elevated[i]);
          if (!h || edges[h.line].name !== edges[cr.line].name || !edges[h.line].one) continue;
          const P = EP[h.line], a = P[h.seg], b = P[(h.seg + 1) % P.length];
          let tx = b[0] - a[0], tz = b[1] - a[1];
          const tl = Math.hypot(tx, tz) || 1;
          tx /= tl;
          tz /= tl;
          const dot = tx * cr.t[0] + tz * cr.t[1];
          if (Math.abs(dot) < 0.98) continue;
          if (dot < 0) (tx = -tx), (tz = -tz);
          const half = halfNear(h.line, h.seg, h.u);
          const c: XZ = [a[0] + (b[0] - a[0]) * h.u, a[1] + (b[1] - a[1]) * h.u];
          // (Across the other way square to it, its centre where cr's line meets it.)
          const dx = c[0] - cr.c[0], dz = c[1] - cr.c[1];
          const al = dx * cr.t[0] + dz * cr.t[1];
          const o: Crossing = { ...cr, line: h.line, half, c: [c[0] - tx * al, c[1] - tz * al], t: [tx, tz], light: null, span: null };
          const lat = (o.c[0] - cr.c[0]) * left[0] + (o.c[1] - cr.c[1]) * left[1];
          const gap = Math.abs(lat) - cr.half - half;
          if (gap < 0.3 || gap > MEDIAN_CUT_MAX) continue;
          // (The other way clear where the stripes go: not in a junction, nor over a third road.)
          let ok = true;
          for (const a2 of [-1, 0, 1])
            for (const b2 of [-1, -0.5, 0, 0.5, 1]) {
              const x = o.c[0] + tx * a2 * (CROSS_W / 2) + -tz * b2 * (half - 0.4), z = o.c[1] + tz * a2 * (CROSS_W / 2) + tx * b2 * (half - 0.4);
              if (onOther(x, z, new Set([h.line, cr.line]), 0.3) || inPoly(x, z, true) || crossings.some((q) => q !== cr && onCross(q, x, z, 0.3))) ok = false;
            }
          // (Nor where the other way has a zebra of its own close by.)
          if (crossings.some((q) => q !== cr && Math.hypot(q.c[0] - o.c[0], q.c[1] - o.c[1]) < 15)) ok = false;
          if (!ok || !medianCut(cr, o, gap, lat)) continue;
          spanBoth(cr, o);
          // (Listed with the others, its stripes cr's: the other way's lines stop at it as at any zebra. No stop line of its own.)
          o.inbound = 0;
          crossings.push(o);
          break;
        }
      }
    for (const { ring, c } of cuts) {
      // (Not star-shaped about its middle, so drawn on the 2 m lattice as a shaped junction is: see jMesh.)
      const id = JPOLY.length;
      const radius = Math.max(...ring.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])));
      JX.fills.push({ ring, centre: c, radius });
      JPOLY.push(Object.assign({ ring, centre: c, radius, mouths: [], kerbs: [], fill: true }, { closed: true }));
      const r = radius + 10;
      for (let ci = Math.floor((c[0] - r) / JCELL); ci <= Math.floor((c[0] + r) / JCELL); ci++)
        for (let cj = Math.floor((c[1] - r) / JCELL); cj <= Math.floor((c[1] + r) / JCELL); cj++) (jGrid.get(ci * 100003 + cj) ?? jGrid.set(ci * 100003 + cj, []).get(ci * 100003 + cj)!).push(id);
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
          // (0.7 m in from the edge: the edge line is 0.28 to 0.42 m in, the
          // box's line 0.2 m wide, and the two stay apart.)
          const e: XZ = [R.p[0] + n[0] * (R.h - 0.7), R.p[1] + n[1] * (R.h - 0.7)];
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
          // (Clear of the kerbs and the edge lines along them: a box's line is
          // 0.2 m wide, an edge line 0.28 to 0.42 m in from the kerb.)
          if (!clear(x, z, 0.55) || onOther(x, z, own, 0.3) || crossings.some((o) => onCross(o, x, z, 0.3))) return true;
          // (Out on a road past its mouth, well clear of its edge lines.)
          if (!at.rings.some((r) => inRingXZ(r, x, z)) && nearEdgeLine(x, z)) return true;
        }
        return false;
      });
      // (Not under a flyover: there the roads below weave between its piers and slip roads, no plain crossing.
      // Nor over a ramp's foot, where the ramp's paving cuts in among the junction's.)
      let under = false;
      for (const [p, q] of lines)
        for (let t = 0; t <= 1 && !under; t += 0.25)
          roads.each(lerp(p[0], q[0], t), lerp(p[1], q[1], t), 16, (i, seg, u, dd) => void (!under && (elevated[i] || isDeck[i]) && dd < halfNear(i, seg, u) + 1 && (under = true)));
      if (under) {
        why('under a flyover or on a ramp');
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
      if (oneLine) {
        // (Each road by how far its own edge is: the nearest centre line may
        // be a narrow road's while a wide one's edge is right here.)
        let k = 0;
        roads.each(x, z, 24, (i, _seg, _u, d) => void (!isDeck[i] && (k = Math.max(k, smoothstep(EHALF[i] + 8, EHALF[i] + 1.5, d)))));
        h = lerp(h, hb, k);
      } else {
        const r = roads.nearest(x, z, 24, (i) => !isDeck[i]);
        if (r) h = lerp(h, hb, smoothstep(EHALF[r.line] + 8, EHALF[r.line] + 1.5, r.d));
      }
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
  /** The ground an island closed in by raised roads is raised to at (x, z), or -Infinity: set once the roads' outlines are known (see islandsIn). */
  let islandFill: (x: number, z: number, lawn?: boolean) => number = () => -Infinity;
  /** How far the sealed ground lies below a road's own height (its drawn surface is ROAD_LIFT above that). */
  const UNDER = 0.12;
  const ROAD_LIFT = 0.09;
  const sealHits: { line: number; seg: number; u: number; d: number; half: number; s: number; used?: boolean }[] = [];
  /** (Each road piece's edge heights as drawn, for heightAt: worked out once. By road, point, side and the piece whose normal it is.) */
  const edgeHMemo = new Map<number, number>();
  function heightAt(x: number, z: number): number {
    const h = groundAt(x, z);
    // (Inside an island closed in by raised roads, never under the ground
    // the roads round it give it: see islandFill. After the roads' seal and
    // banks, which held it down in a pit.)
    const ps = probe.s, pw = probe.w;
    const f = islandFill(x, z);
    probe.s = ps;
    probe.w = pw;
    return f > h ? f : h;
  }
  function groundAt(x: number, z: number): number {
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
          // (Within its width, as it is drawn: straight across from one
          // edge to the other, not following the ground's shape between.)
          if (oneLine && d < half) {
            const vx = pts[seg + 1][0] - pts[seg][0], vz = pts[seg + 1][1] - pts[seg][1];
            const vl = Math.hypot(vx, vz) || 1;
            const nx = vz / vl, nz = -vx / vl;
            const sideAt = (k: number, sgn: number) => {
              const key = -1 - (((line * 4096 + k) * 2 + (sgn > 0 ? 1 : 0)) * 4096 + seg);
              let v = edgeHMemo.get(key);
              if (v === undefined) edgeHMemo.set(key, (v = tiltY(line, ECUM[line][k], Y[k], pts[k][0] + nx * sgn * halfNear(line, k, 0), pts[k][1] + nz * sgn * halfNear(line, k, 0), pts[k][0], pts[k][1])));
              return v;
            };
            const h0 = lerp(halfNear(line, seg, 0), halfNear(line, seg + 1, 0), u);
            const o = Math.max(-h0, Math.min(h0, (x - cx) * nx + (z - cz) * nz));
            const ya = lerp(sideAt(seg, -1), sideAt(seg + 1, -1), u), yb = lerp(sideAt(seg, 1), sideAt(seg + 1, 1), u);
            yr = Math.min(yr, lerp(ya, yb, (o / (h0 || 1) + 1) / 2));
          }
        }
      } else {
        // A draped road's surface at its edge nearest this point.
        const t = d > half ? half / d : 1;
        yr = Math.max(rawHeight(cx + (x - cx) * t, cz + (z - cz) * t), WL + 0.15);
        // (Within its width, as it is drawn: straight across from one edge's
        // height to the other's. Under a wide road whose one edge dips, by a
        // pond's bank, the ground held only to the height right here stood
        // up through the middle of it.)
        if (oneLine && d < half) {
          const vx = pts[seg + 1][0] - pts[seg][0], vz = pts[seg + 1][1] - pts[seg][1];
          const vl = Math.hypot(vx, vz) || 1;
          const nx = vz / vl, nz = -vx / vl;
          // (Each edge's height at the piece's own two points, straight between.)
          const edgeH = (k: number, sgn: number) => {
            const key = ((line * 4096 + k) * 2 + (sgn > 0 ? 1 : 0)) * 4096 + seg;
            let v = edgeHMemo.get(key);
            if (v === undefined) edgeHMemo.set(key, (v = Math.max(rawHeight(pts[k][0] + nx * sgn * halfNear(line, k, 0), pts[k][1] + nz * sgn * halfNear(line, k, 0)), WL + 0.15)));
            return v;
          };
          const h0 = lerp(halfNear(line, seg, 0), halfNear(line, seg + 1, 0), u);
          const o = Math.max(-h0, Math.min(h0, (x - cx) * nx + (z - cz) * nz));
          const ya = lerp(edgeH(seg, -1), edgeH(seg + 1, -1), u), yb = lerp(edgeH(seg, 1), edgeH(seg + 1, 1), u);
          yr = Math.min(yr, lerp(ya, yb, (o / (h0 || 1) + 1) / 2));
        }
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
  /**
   * One slice of a tile's building. A job with more to do than fits in one
   * slice hands back an iterator instead, and each of its steps is a slice
   * of its own (yielded between, timed as the job's kind).
   */
  type Job = ((kit: TileKit, acc: AccFor) => void | Iterator<unknown>) & { what?: string };
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
  /** A job's steps all at once, and what it comes to. */
  const drain = <T>(g: Generator<unknown, T>) => {
    for (;;) {
      const r = g.next();
      if (r.done) return r.value;
    }
  };
  const inChunks = <T>(layer: Layer, k: string, what: string, items: T[], size: number, job: (part: T[], kit: TileKit, acc: AccFor) => void | Iterator<unknown>) => {
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
  // The ground's height at each point of the STEP m lattice, worked out
  // once and shared: the ground's mesh is drawn on these points, and the
  // paths, walls and island edges that sit on the ground as drawn read
  // them again (see groundY). In 64 x 64 blocks of the lattice, the 256
  // newest kept. (Each was worked out twice, once for the mesh and once
  // for what stands on it: about a second of the trial map's start.)
  // (With each, the shore and water distances heightAt leaves in probe,
  // set again when it is read: the ground's colour there is taken from
  // them. Read from the cache without, the colour was the last point
  // worked out's, anywhere, and the ground and lawn took the shore's pale
  // colour or not by the order tiles were built in, -3410,2612.)
  const LAT_B = 64;
  const latB = new Map<number, Float64Array>();
  const latAt = (i: number, j: number) => {
    const bi = Math.floor(i / LAT_B), bj = Math.floor(j / LAT_B);
    const k = bi * 100003 + bj;
    let b = latB.get(k);
    if (!b) {
      b = new Float64Array(LAT_B * LAT_B * 3).fill(NaN);
      latB.set(k, b);
      if (latB.size > 256) latB.delete(latB.keys().next().value!);
    }
    const q = 3 * ((j - bj * LAT_B) * LAT_B + (i - bi * LAT_B));
    let v = b[q];
    if (v !== v) {
      b[q] = v = heightAt(WB.minX + i * STEP, WB.minZ + j * STEP);
      b[q + 1] = probe.s;
      b[q + 2] = probe.w;
    } else {
      probe.s = b[q + 1];
      probe.w = b[q + 2];
    }
    return v;
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
          const y = step === STEP ? latAt(cx[0] + i, cz[0] + j) : heightAt(x, z);
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
    /** (Normals of its own, where given for every point: see islandSheet.) */
    nrm: number[] = [];
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
      /**
       * With sub: lies on this surface (its height at x, z), every point of
       * it, cut into lengths of `sub` metres however straight: a mark on a
       * road as the road's strip is drawn, not on the ground the strip's
       * corners lie on (straight between them, the strip lies over hollows).
       */
      yXZ?: (x: number, z: number) => number;
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
      for (const sgn of [-1, 1]) {
        const x = px + nx * (off + sgn * half);
        const z = pz + nz * (off + sgn * half);
        // Never below the water: paths out over it become boardwalks.
        let yk = o.yAt ? o.yAt(k) : NaN;
        if (yk === yk && o.tilt) {
          const [tk, rk] = o.tilt(k);
          // (As tiltY: from the middle of the road's line.)
          if (tk > 0) yk = oneLine ? yk + tk * crossDrop(x, z, px, pz) : lerp(yk, Math.max(rawHeight(x, z), WL + 0.15) + rk, tk);
        }
        if (o.yXZ) {
          const h = o.yXZ(x, z);
          if (h === h) yk = h;
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
        const whole = !(o.yXZ && s1 - s0 > sub) && !dashCuts.length && (!dash || dashOn((s0 + s1) / 2)) && s0 >= lo_s && s1 <= hi_s && (!clearAt || (corner(a) && corner(a + 1) && corner(a + 2) && corner(a + 3))) && okAt(at(0), 0) && okAt(at(0.5), 0.5) && okAt(at(1), 1);
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
            if (o.yXZ) {
              const ya = o.yXZ(v[0], v[2]), yb = o.yXZ(v[3], v[5]);
              if (ya === ya) v[1] = ya + lift;
              if (yb === yb) v[4] = yb + lift;
            }
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
    // (A point every 15°: a dead end's round end is the outline's, its
    // kerb round it.)
    const n = 24;
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
    // (A kerb's side down to the ground, the user's rule S3: kept apart from
    // the kerb's top, which the checks read as the kerb, and lit upright.)
    kerbSide: flatMat(0xb9b5aa, -2),
    white: flatMat(0xf2efe4, -5),
    yellow: flatMat(0xe0b52a, -5),
    box: flatMat(0xe0b52a, -5),
    foot: flatMat(0xbdb7aa, -1),
    cycle: flatMat(0xa45b49, -2, tartanTex),
    rail: flatMat(0xd9d6cf, -1),
    ballast: flatMat(0x7d7872, -1),
    deck: flatMat(0xc4c0b8, 0),
  };
  type AccKey = keyof typeof MAT | 'wall' | 'roof' | 'lawn';
  /** Turn a tile's filled buffers into meshes. */
  function* flush(accs: Map<AccKey, Acc>, kit: TileKit): Generator<void, void, void> {
    for (const [key, acc] of accs) {
      yield;
      const t0 = performance.now();
      if (key === 'lawn') {
        // (An island's top, coloured as the ground: see islandSheet.)
        if (!acc.pos.length) continue;
        const g = kit.own(new THREE.BufferGeometry());
        g.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(acc.uv, 2));
        g.setAttribute('color', new THREE.Float32BufferAttribute(acc.col, 3));
        g.setIndex(acc.idx);
        if (acc.nrm.length === acc.pos.length) g.setAttribute('normal', new THREE.Float32BufferAttribute(acc.nrm, 3));
        else g.computeVertexNormals();
        const m = new THREE.Mesh(g, groundMat);
        m.receiveShadow = true;
        kit.add(m);
        cost(`mesh: ${key}`, '', t0);
        continue;
      }
      if (key !== 'wall' && key !== 'roof') {
        accMesh(acc, MAT[key], kit, key === 'deck' || key === 'rail' || key === 'kerbSide');
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
    // (Or nearly: a piece between two joints of the one junction, drawn
    // wider than the junction's paving (turning lanes), stood out up to two
    // metres past it, the kerb stepping out round it and back. The
    // junction's own paving, as wide as the roads that leave it, is the road there.)
    const both = JX.shapeOf[edges[i].b] === JX.shapeOf[edges[i].a];
    const within = (slack: number) => pts.every((p, k) => {
      const a = pts[Math.max(0, k - 1)];
      const b = pts[Math.min(pts.length - 1, k + 1)];
      const [nx, nz] = unit(b[1] - a[1], -(b[0] - a[0]));
      const h = halfAtE(i, k) - 0.3;
      const inside = (x: number, z: number) => inRingXZ(sh.ring, x, z) || (slack > 0 && ringDist(sh.ring, x, z)[0] < slack);
      return (slack === 0 || inRingXZ(sh.ring, p[0], p[1])) && inside(p[0] + nx * h, p[1] + nz * h) && inside(p[0] - nx * h, p[1] - nz * h);
    });
    // (Redrawn maps only: on today's map the joint's paving is not the
    // outline's, and two such pieces hidden left gaps in the road.)
    return within(0) || (oneLine && both && within(2.5));
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
  // (tight: for a raised road's wall, handing its side to the road beside
  // it. Off decks, only to one whose top stands within 0.2 m of this one's
  // (y its top): 3 m let a slip road at 1314.2,549.1 to 1346.7,578.8 hand
  // its wall to the expressway 0.4 to 1.1 m below it, and no wall stood
  // there at all, the underside showing (the user's rules S3 and S4).)
  const coveredBy = (line: number, x: number, z: number, y: number, tight = false) => {
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
      else if (tight && !isDeck[i]) hit = Math.abs((hasProfile[i] ? deckAtHit(i, seg, u) : g === g ? g : (g = heightAt(x, z))) + ROAD_LIFT - y) < 0.2;
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
  type GoreRow = { a: XZ; b: XZ; ya: number; yb: number };
  /** (brk: whether the piece's first and last rows end where the two roads stand apart in height, not where they part on the map: no nose there.) */
  const gores: { ring: XZ[]; rows: GoreRow[]; deck: number; A?: number; B?: number; brk?: [boolean, boolean] }[] = [];
  /**
   * Dividers (the user's rules 1 and 2 at every point, 18 Nov): where two
   * roads on the ground lie on one another, or run less than DIV_W apart,
   * but stand more than GORE_STEP apart in height, they are not one
   * surface and do not meet in a point. A strip DIV_W wide, down the middle
   * between their facing edges and round-ended, is cut out of the ground's
   * outline there: each road keeps its own kerb, and the island between
   * carries the step (its top level from the higher kerb, one face down).
   * Before, the outline joined them into one paving with a step across it,
   * and where they drew apart it came to a sharp point of two kerbs
   * folded together, the higher road's side and bank standing in it.
   */
  const DIV_W = 0.8;
  /**
   * (A divider only where the two stand this far apart in height: as the
   * split check takes two roads to be at different levels. Begun at 12 cm,
   * at a split where a viaduct's ramp leaves an expressway, the divider
   * opened a gap between the two, 0.66 m across, where they were still
   * all but level; and on two carriageways lying over one another as
   * they met, it cut into their lanes.)
   */
  const DIV_FROM = 0.5;
  /** (Nor where they lie further over one another than this: one paving, its lanes, not a strip's place.) */
  const DIV_OVER = 0.7;
  /** The shortest divider. */
  const DIV_LEN = 6;
  let divMs = 0;
  const dividers: { ring: XZ[]; ends: XZ[]; A: number; B: number; dyMax: number; gapMin: number; gapMax: number; len: number; x0: number; z0: number; x1: number; z1: number }[] = [];
  /**
   * Road i's edge exactly as its strip draws it, beside its middle line's
   * point (x, z) on piece k, on the side nearer (rx, rz): straight between
   * the strip's own corners, each square to the line between the points
   * either side (not square to the piece, which is off by half the bend:
   * 18 cm on a 3.5 m half width bending 6°, a hairline of ground between a
   * wedge and the road, and a crack the outline papered over). Null where
   * the road is not drawn.
   */
  const cutMemo = new Map<number, ReturnType<typeof cutOf>>();
  // (A hair in from it, toward the road's middle: an outline traced along
  // two edges laid exactly on one another came out with a crack of no width
  // there, run out and straight back.)
  const EDGE_IN = 0.01;
  const stripEdgeAt = (i: number, k: number, x: number, z: number, rx: number, rz: number, inset = EDGE_IN): XZ | null => {
    const c = cutMemo.get(i) ?? cutMemo.set(i, cutOf(i)).get(i)!;
    if (k < c.lo || k + 1 > c.hi) return null;
    const P = c.pts;
    const vx = P[k + 1][0] - P[k][0], vz = P[k + 1][1] - P[k][1];
    const u = ((x - P[k][0]) * vx + (z - P[k][1]) * vz) / (vx * vx + vz * vz || 1);
    if (u < -1e-3 || u > 1 + 1e-3) return null;
    const join = joinOf(i);
    const at = (kk: number, sgn: number): XZ => {
      const { nx, nz, mm } = section(P, kk, c.lo, c.hi, join);
      const h = halfAtE(i, kk) * mm * sgn;
      return [P[kk][0] + nx * h, P[kk][1] + nz * h];
    };
    let best: XZ | null = null;
    let bd = Infinity;
    for (const sgn of [-1, 1]) {
      const A = at(k, sgn), B = at(k + 1, sgn);
      const t = Math.max(0, Math.min(1, u));
      const q: XZ = [lerp(A[0], B[0], t), lerp(A[1], B[1], t)];
      const dd = Math.hypot(q[0] - rx, q[1] - rz);
      if (dd < bd) (bd = dd), (best = q);
    }
    if (best && inset) {
      const t = Math.max(0, Math.min(1, u));
      const cx = lerp(P[k][0], P[k + 1][0], t), cz = lerp(P[k][1], P[k + 1][1], t);
      const l = Math.hypot(cx - best[0], cz - best[1]) || 1;
      best = [best[0] + ((cx - best[0]) / l) * inset, best[1] + ((cz - best[1]) / l) * inset];
    }
    return best;
  };
  /** Where along road i (metres from its a end) its middle line passes nearest (x, z). */
  const sAlong = (i: number, x: number, z: number) => {
    const P = EP[i];
    let best = Infinity, bs = 0;
    for (let k = 0; k + 1 < P.length; k++) {
      const vx = P[k + 1][0] - P[k][0], vz = P[k + 1][1] - P[k][1];
      const l2 = vx * vx + vz * vz || 1;
      const u = Math.max(0, Math.min(1, ((x - P[k][0]) * vx + (z - P[k][1]) * vz) / l2));
      const d = Math.hypot(P[k][0] + vx * u - x, P[k][1] + vz * u - z);
      if (d < best) (best = d), (bs = ECUM[i][k] + u * Math.sqrt(l2));
    }
    return bs;
  };
  /** Road i's drawn edge from s0 to s1 along it, on the side nearer (rx, rz): its ends and the strip's corners between (null where it is not drawn). */
  const stripEdgeRun = (i: number, s0: number, s1: number, rx: number, rz: number): XZ[] | null => {
    const P = EP[i], cum = ECUM[i];
    const pt = (s: number, inset = EDGE_IN): XZ | null => {
      let k = 0;
      while (k < P.length - 2 && cum[k + 1] <= s) k++;
      const u = (s - cum[k]) / (cum[k + 1] - cum[k] || 1);
      return stripEdgeAt(i, k, lerp(P[k][0], P[k + 1][0], u), lerp(P[k][1], P[k + 1][1], u), rx, rz, inset);
    };
    if (s0 < 0 || s1 < 0 || s0 > ELEN[i] || s1 > ELEN[i]) return null;
    const out: XZ[] = [];
    const first = pt(s0);
    if (!first) return null;
    out.push(first);
    const up = s1 > s0;
    for (let k = up ? 0 : P.length - 1; k >= 0 && k < P.length; k += up ? 1 : -1) {
      if (up ? cum[k] <= s0 + 0.05 || cum[k] >= s1 - 0.05 : cum[k] >= s0 - 0.05 || cum[k] <= s1 + 0.05) continue;
      // (The corners between a little further in, under the road: the run's own sides then never lie on the road's.)
      const q = pt(up ? cum[k] + 1e-4 : cum[k] - 1e-4, 0.03);
      if (!q) return null;
      out.push(q);
    }
    const last = pt(s1);
    if (!last) return null;
    out.push(last);
    return out;
  };
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
  /** On a nose's outline (its point and tapering sides)? */
  // (A nose reaches up to NOSE_L past its wedge's ring, perhaps into the next cell: the cells round about too.)
  const goresNear = (x: number, z: number) => {
    const cx = Math.floor(x / GCELL), cz = Math.floor(z / GCELL);
    const out = new Set<number>();
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const id of goreGrid.get((cx + a) * 100003 + cz + b) ?? []) out.add(id);
    return [...out];
  };
  const onNose = (x: number, z: number) => goresNear(x, z).some((id) => goreCaps(id).some((c) => c.nose.some((p, k) => k > 0 && segDist(c.nose[k - 1], p, x, z) < 0.15)));
  /** On a nose's paving (past the wedge's last row, round to the island's point)? */
  const inNose = (x: number, z: number) =>
    oneLine && goresNear(x, z).some((id) => goreCaps(id).some((c) => inRingXZ(c.pave, x, z)));
  /** A wedge's bounds, with its noses (x0, z0, x1, z1). */
  const goreBoxes = new Map<number, number[]>();
  const goreBox = (id: number) => {
    let b = goreBoxes.get(id);
    if (b) return b;
    b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of [...gores[id].ring, ...goreCaps(id).flatMap((c) => c.pave)]) (b[0] = Math.min(b[0], p[0] - 0.01)), (b[1] = Math.min(b[1], p[1] - 0.01)), (b[2] = Math.max(b[2], p[0] + 0.01)), (b[3] = Math.max(b[3], p[1] + 0.01));
    goreBoxes.set(id, b);
    return b;
  };
  /** The top of a wedge's or a nose's paving at (x, z), exactly as its triangles are drawn (NaN off it). */
  const goreTopAt = (x: number, z: number, near: number[] = goresNear(x, z)) => {
    let top = NaN;
    // (Heights asked only of the triangle the point is in: a nose's are worked out from the roads about it.)
    const tri = (A: XZ, ya: number | (() => number), B: XZ, yb: number | (() => number), C: XZ, yc: number | (() => number)) => {
      const d0 = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
      if (Math.abs(d0) < 1e-9) return;
      const l1 = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (z - C[1])) / d0, l2 = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (z - C[1])) / d0;
      if (l1 < -1e-6 || l2 < -1e-6 || l1 + l2 > 1 + 1e-6) return;
      const v = (y: number | (() => number)) => (typeof y === 'number' ? y : y());
      const h = l1 * v(ya) + l2 * v(yb) + (1 - l1 - l2) * v(yc) + 0.087;
      if (!(h <= top)) top = h;
    };
    for (const id of near) {
      const { rows } = gores[id];
      const bb = goreBox(id);
      if (x < bb[0] || x > bb[2] || z < bb[1] || z > bb[3]) continue;
      for (let q = 0; q + 1 < rows.length; q++) {
        const r = rows[q], t = rows[q + 1];
        if (x < Math.min(r.a[0], r.b[0], t.a[0], t.b[0]) - 0.01 || x > Math.max(r.a[0], r.b[0], t.a[0], t.b[0]) + 0.01 || z < Math.min(r.a[1], r.b[1], t.a[1], t.b[1]) - 0.01 || z > Math.max(r.a[1], r.b[1], t.a[1], t.b[1]) + 0.01) continue;
        tri(r.a, r.ya, t.a, t.ya, r.b, r.yb);
        tri(r.b, r.yb, t.a, t.ya, t.b, t.yb);
      }
      for (const c of goreCaps(id)) for (const [u, v, w] of c.tris) tri(c.pave[u], () => c.yAt(c.pave[u]), c.pave[v], () => c.yAt(c.pave[v]), c.pave[w], () => c.yAt(c.pave[w]));
    }
    return top;
  };
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
    /** Point, direction (away from j) and segment at s out from road i's end at j. (Its half width as its strip draws it: a step from one point's width to the next left a hairline of ground between the wedge and a tapering road, and a spike in the outline at the nose.) */
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
      return { x: lerp(P[k][0], P[k + 1][0], u), z: lerp(P[k][1], P[k + 1][1], u), tx: (sg * (P[k + 1][0] - P[k][0])) / sl, tz: (sg * (P[k + 1][1] - P[k][1])) / sl, k, u, s, h: halfAtS(i, s) };
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
          let brk0 = false;
          const finish = (brk1 = false) => {
            if (rows.length >= 2) gores.push({ ring: [...rows.map((r) => r.a), ...rows.map((r) => r.b).reverse()], rows, deck: goreDeck(A, B), A, B, brk: [brk0, brk1] });
            if (rows.length) brk0 = false;
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
            const ea0: XZ = [pa.x - pa.tz * sa * pa.h, pa.z + pa.tx * sa * pa.h];
            const eb0: XZ = [pb.x - pb.tz * sb * pb.h, pb.z + pb.tx * sb * pb.h];
            // (On each road's edge exactly as drawn.)
            const ea = stripEdgeAt(A, pa.k, pa.x, pa.z, ea0[0], ea0[1]) ?? ea0;
            const eb = stripEdgeAt(B, pb.k, pb.x, pb.z, eb0[0], eb0[1]) ?? eb0;
            const sep = Math.hypot(pa.x - pb.x, pa.z - pb.z) - pa.h - pb.h;
            const ya = roadY(A, pa.k, pa.u, pa.s, ea[0], ea[1]);
            const yb = roadY(B, pb.k, pb.u, pb.s, eb[0], eb[1]);
            // (Two roads at different levels part as one climbs: no gore.
            // Paved across up to 25 cm apart, as two roads side by side are;
            // past that, each keeps its own kerb or wall, and no nose joins
            // them: up to 0.8 m apart, the wedge sloped steeply across and a
            // nose was made against the higher road's wall: TPE by Tampines
            // Ave 6, the user's feedback 9.)
            if (Math.abs(ya - yb) > GORE_STEP) {
              finish(rows.length > 0);
              last = null;
              brk0 = true;
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
        let brk0 = false;
        const finish = (brk1 = false) => {
          // (Nothing shorter than 3 m: a scrap of paving at a junction's mouth only roughens the edge there.)
          if (rows.length >= 2 && Math.hypot(rows[0].a[0] - rows[rows.length - 1].a[0], rows[0].a[1] - rows[rows.length - 1].a[1]) >= 3 && rows.some((r) => Math.hypot(r.a[0] - r.b[0], r.a[1] - r.b[1]) > 0.2)) {
            gores.push({ ring: [...rows.map((r) => r.a), ...rows.map((r) => r.b).reverse()], rows, deck: beside >= 0 ? goreDeck(A, beside) : -1, A, B: beside >= 0 ? beside : undefined, brk: [brk0, brk1] });
            gridGore(gores.length - 1);
          }
          if (rows.length) brk0 = false;
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
            // (Not past B's end: the next piece of the same road, carrying on
            // from A's end, is ahead of A's edge there, not beside it. Its
            // end's corner put a strip of paving 1 m wide over the
            // expressway's edge, and a bump in its kerb, at a slip road.)
            if ((seg === 0 && u <= 0) || (seg === Q.length - 2 && u >= 1)) continue;
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
          const { pa, ea: ea0, m } = at;
          // (Each road's edge exactly as drawn.)
          const ea = stripEdgeAt(A, pa.k, pa.x, pa.z, ea0[0], ea0[1]) ?? ea0;
          const ya = roadY(A, pa.k, pa.u, pa.s, ea[0], ea[1]);
          // (B's edge facing A; where A's edge is already on B, the strip has no width.)
          const dB = Math.hypot(ea[0] - m.x, ea[1] - m.z) || 1;
          const eb0: XZ = [m.x + ((ea[0] - m.x) / dB) * m.hb, m.z + ((ea[1] - m.z) / dB) * m.hb];
          const eb: XZ = m.gap <= 0 ? ea : (stripEdgeAt(m.B, m.seg, m.x, m.z, eb0[0], eb0[1]) ?? eb0);
          const yb = m.gap <= 0 ? ya : roadY(m.B, m.seg, m.u, m.s, eb[0], eb[1]);
          if (Math.abs(ya - yb) > GORE_STEP) {
            finish(rows.length > 0);
            paved = null;
            brk0 = true;
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
          if ((at || prevHit) && sA - prevS > 1.2) {
            take(probe((prevS + sA) / 2));
          }
          take(at);
          prevS = sA;
          prevHit = !!at;
        }
        finish();
      }
    });
    // Dividers (see DIV_W): each pair of roads on the ground once, from the
    // lower-numbered, along its whole length, its junctions' paving too
    // (there the junction's paving has the roads' heights): a slip road
    // dropping away from the road it left inside a tee's paving came to a
    // point at a step of 0.7 m all the same.
    const divT0 = performance.now();
    // (Two roads that both follow the ground stand level: only beside a
    // road with a profile of its own, a ramp's or a bank's, is there one.)
    const boxOf = (i: number) => {
      const P = EP[i];
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const p of P) (x0 = Math.min(x0, p[0])), (z0 = Math.min(z0, p[1])), (x1 = Math.max(x1, p[0])), (z1 = Math.max(z1, p[1]));
      return [x0, z0, x1, z1];
    };
    const profBoxes = edges.flatMap((e, i) => (hasProfile[i] && !JX.internal[i] && !isDeck[i] && e.a !== e.b ? [boxOf(i)] : []));
    edges.forEach((eA, A) => {
      if (JX.internal[A] || eA.a === eA.b || isDeck[A] || ELEN[A] < 4) return;
      const reach = GORE + widest + EP[A].reduce((m, _, k) => Math.max(m, halfAtE(A, k)), 0) + 1.5;
      if (!hasProfile[A]) {
        const [x0, z0, x1, z1] = boxOf(A);
        const R = reach + 4;
        if (!profBoxes.some((b) => b[0] < x1 + R && b[2] > x0 - R && b[1] < z1 + R && b[3] > z0 - R)) return;
      }
      const at = walker(A);
      let rows: { l: XZ; r: XZ; c: XZ; n: XZ; t: XZ; w: number; gap: number; dy: number; ext?: boolean }[] = [];
      let besideB = -1;
      const finish = () => {
        // (Not a scrap of two rows: where one road carries on from another
        // round a bend, the two edges' crossfall alone stood 0.3 m apart
        // for a metre.)
        // (Its own rows: not the ends carried on past them.)
        const own = rows.filter((r) => !r.ext);
        let len = 0;
        for (let q = 1; q < own.length; q++) len += Math.hypot(own[q].c[0] - own[q - 1].c[0], own[q].c[1] - own[q - 1].c[1]);
        // (Only where the two part, an island's point between them: a
        // narrow island, under 0.7 m across, as it begins. Where they only
        // lie on one another and part nowhere, as a slip road merging into
        // an expressway's lanes, a divider stood alone as a pill in the
        // middle of the carriageway.)
        const parts = own.some((r) => r.gap >= 0 && r.gap < 0.7);
        const apart = own.some((r) => r.dy > DIV_FROM);
        // (And at least DIV_LEN long: 3 m of strip on to an island's point,
        // at 1768.1,2113.2, stood off the point with a notch between, the
        // lawn over it broken and folded.)
        if (own.length >= 3 && len >= DIV_LEN && parts && apart) {
          // (Round at each end: half a circle about the row's middle.)
          const cap = (row: (typeof rows)[number], back: number): XZ[] =>
            Array.from({ length: 7 }, (_, q): XZ => {
              const a = ((q + 1) / 8) * Math.PI;
              return [row.c[0] + back * (row.n[0] * Math.cos(a) - row.t[0] * Math.sin(a)) * row.w, row.c[1] + back * (row.n[1] * Math.cos(a) - row.t[1] * Math.sin(a)) * row.w];
            });
          const ring: XZ[] = [...rows.map((r) => r.l), ...cap(rows[rows.length - 1], -1), ...rows.map((r) => r.r).reverse(), ...cap(rows[0], 1)];
          const xs = ring.map((p) => p[0]), zs = ring.map((p) => p[1]);
          // (Each end's tip: its middle, a half width on.)
          const tipOf = (row: (typeof rows)[number], back: number): XZ => [row.c[0] - back * row.t[0] * row.w, row.c[1] - back * row.t[1] * row.w];
          dividers.push({ ring, ends: [tipOf(rows[0], 1), tipOf(rows[rows.length - 1], -1)], A, B: besideB, dyMax: Math.max(...own.map((r) => r.dy)), gapMin: Math.min(...own.map((r) => r.gap)), gapMax: Math.max(...own.map((r) => r.gap)), len, x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) });
        }
        rows = [];
        besideB = -1;
      };
      // (First every 4 m, whether any road runs alongside within GORE +
      // 4 m: a metre at a time along every road, asked of every road
      // within reach, held the game's start up by seconds.)
      const C4 = 4;
      const near4: boolean[] = [];
      for (let s = 0; s <= ELEN[A] + C4; s += C4) {
        const pa = at(Math.min(s, ELEN[A]));
        const ha = lerp(halfAtE(A, pa.k), halfAtE(A, pa.k + 1), pa.u);
        let hit = false;
        roads.each(pa.x, pa.z, reach + C4, (B, seg) => {
          if (hit || B <= A || JX.internal[B] || isDeck[B] || elevated[B] !== elevated[A] || edges[B].a === edges[B].b || (!hasProfile[A] && !hasProfile[B])) return;
          const Q = EP[B];
          const vx = Q[seg + 1][0] - Q[seg][0], vz = Q[seg + 1][1] - Q[seg][1];
          const sl2 = vx * vx + vz * vz || 1;
          const u = Math.max(0, Math.min(1, ((pa.x - Q[seg][0]) * vx + (pa.z - Q[seg][1]) * vz) / sl2));
          const x = Q[seg][0] + vx * u, z = Q[seg][1] + vz * u;
          const hb = Math.max(halfAtE(B, seg), halfAtE(B, seg + 1));
          if (Math.hypot(pa.x - x, pa.z - z) - ha - hb < GORE + C4) hit = true;
        });
        near4.push(hit);
      }
      const mayBe = (s: number) => {
        const k = Math.round(s / C4);
        return !!(near4[k - 1] || near4[k] || near4[k + 1]);
      };
      if (!near4.some(Boolean)) return;
      for (const sgn of [-1, 1]) {
        let wasNone = true;
        for (let s = 0; s <= ELEN[A]; s += 1) {
          const pa = at(s);
          const nx = -pa.tz * sgn, nz = pa.tx * sgn;
          const ha = lerp(halfAtE(A, pa.k), halfAtE(A, pa.k + 1), pa.u);
          const ea0: XZ = [pa.x + nx * ha, pa.z + nz * ha];
          // The nearest road beside this edge, on it or within GORE of it
          // (where a junction's paving may fill the ground between them).
          type Beside = { B: number; seg: number; u: number; gap: number; hb: number; x: number; z: number; s: number };
          let best: Beside | null = null;
          if (mayBe(s)) roads.each(ea0[0], ea0[1], reach, (B, seg) => {
            // (Two roads that both follow the ground stand level.)
            if (B <= A || JX.internal[B] || isDeck[B] || elevated[B] !== elevated[A] || edges[B].a === edges[B].b || (!hasProfile[A] && !hasProfile[B])) return;
            const Q = EP[B];
            const vx = Q[seg + 1][0] - Q[seg][0], vz = Q[seg + 1][1] - Q[seg][1];
            const sl2 = vx * vx + vz * vz || 1;
            const u = Math.max(0, Math.min(1, ((ea0[0] - Q[seg][0]) * vx + (ea0[1] - Q[seg][1]) * vz) / sl2));
            if ((seg === 0 && u <= 0) || (seg === Q.length - 2 && u >= 1)) return;
            const sl = Math.sqrt(sl2);
            if (Math.abs((vx * pa.tx + vz * pa.tz) / sl) < COS_NEAR) return;
            const x = Q[seg][0] + vx * u, z = Q[seg][1] + vz * u;
            if ((x - pa.x) * nx + (z - pa.z) * nz <= 0) return;
            const hb = lerp(halfAtE(B, seg), halfAtE(B, seg + 1), u);
            const gap = Math.hypot(ea0[0] - x, ea0[1] - z) - hb;
            if (gap >= GORE || (best && gap >= best.gap)) return;
            best = { B, seg, u, gap, hb, x, z, s: ECUM[B][seg] + u * sl };
          });
          const m = best as Beside | null;
          // (On to the next piece of the road beside, round its joint: one divider.)
          const next = (B: number) => besideB >= 0 && [edges[besideB].a, edges[besideB].b].some((j) => j === edges[B].a || j === edges[B].b);
          if (!m && rows.length) {
            // (Where they draw more than GORE apart, on 1.5 m into the
            // ground between, to meet the island there: a junction's paving
            // reaching on between them left a neck of paving between the
            // divider's end and the island's point, the two kerbs crossing.)
            const r = rows[rows.length - 1];
            const c: XZ = [r.c[0] + r.t[0] * 1.5, r.c[1] + r.t[1] * 1.5];
            rows.push({ ...r, c, l: [c[0] - r.n[0] * r.w, c[1] - r.n[1] * r.w], r: [c[0] + r.n[0] * r.w, c[1] + r.n[1] * r.w], ext: true });
          }
          if (!m || (besideB >= 0 && m.B !== besideB && !next(m.B))) finish();
          const none = wasNone;
          wasNone = !m;
          if (!m) continue;
          const ea = stripEdgeAt(A, pa.k, pa.x, pa.z, ea0[0], ea0[1]) ?? ea0;
          // (B's edge on the side towards A's middle line, on it or not.)
          const ul = Math.hypot(pa.x - m.x, pa.z - m.z) || 1;
          const eb0: XZ = [m.x + ((pa.x - m.x) / ul) * m.hb, m.z + ((pa.z - m.z) / ul) * m.hb];
          const eb = stripEdgeAt(m.B, m.seg, m.x, m.z, eb0[0], eb0[1]) ?? eb0;
          const ya = roadY(A, pa.k, pa.u, pa.s, ea[0], ea[1]);
          const yb = roadY(m.B, m.seg, m.u, m.s, eb[0], eb[1]);
          // (Only where they stand more than DIV_FROM apart in height, and do
          // not lie over one another more than DIV_OVER.)
          const c: XZ = [(ea[0] + eb[0]) / 2, (ea[1] + eb[1]) / 2];
          // (Nor within 1.2 m of a junction's paving, its round end and the
          // lines round it clear of it: run on into the junction by
          // -2772.9,2246.5, its yellow line lay in the junction.)
          const inJunction = (x: number, z: number) => JX.shapes.some((sh) => Math.hypot(x - sh.centre[0], z - sh.centre[1]) < sh.radius + 2 && inRingXZ(sh.ring, x, z));
          if (Math.abs(ya - yb) <= DIV_FROM || m.gap < -DIV_OVER || inJunction(c[0] + pa.tx * 1.2, c[1] + pa.tz * 1.2) || inJunction(c[0] - pa.tx * 1.2, c[1] - pa.tz * 1.2) || inJunction(c[0], c[1])) {
            finish();
            continue;
          }
          besideB = m.B;
          // (Wider where they stand further apart: all the ground between,
          // so no sliver of what paves it is left beside either at the
          // other's height. And where they lie further over one another:
          // all of that, so neither's strip reaches past it to the other's
          // side.)
          const w = Math.max(DIV_W, Math.abs(m.gap) + 0.02) / 2;
          // (And likewise back from where they first draw within GORE of each other.)
          if (!rows.length && none && s > 0) {
            const b: XZ = [c[0] - pa.tx * 1.5, c[1] - pa.tz * 1.5];
            rows.push({ l: [b[0] - nx * w, b[1] - nz * w], r: [b[0] + nx * w, b[1] + nz * w], c: b, n: [nx, nz], t: [pa.tx, pa.tz], w, gap: m.gap, dy: 0, ext: true });
          }
          rows.push({ l: [c[0] - nx * w, c[1] - nz * w], r: [c[0] + nx * w, c[1] + nz * w], c, n: [nx, nz], t: [pa.tx, pa.tz], w, gap: m.gap, dy: Math.abs(ya - yb) });
        }
        finish();
      }
    });
    divMs = performance.now() - divT0;
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
  // (A raised road's wall stands at its kerb's outer edge, 0.35 m out from
  // the road's edge, 1 cm past it so the kerb's edge is behind it, not
  // showing through as a hairline. Out at 0.45 m, as a deck's edge is, it
  // stood 10 cm proud of the kerb.)
  const WALL_OUT = 0.36;
  // (Its top level with the kerb's, 1 cm over the road: 5 cm over it, the
  // kerb's edge, a centimetre off the wall's line here and there as the
  // outline is simplified, showed through its face as a hairline.)
  const wallTop = (drop: number) => 0.01 * smoothstep(WALL_FROM, WALL_FROM + 0.15, drop);
  const parapetTop = (drop: number) => Math.max(wallTop(drop), PARAPET_H * smoothstep(PARAPET_FROM, PARAPET_FULL, drop));
  const besideMid = (line: number, kk: number, off: number): XZ => {
    const a = EP[line][kk];
    const b = EP[line][kk + 1];
    const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(a[0] + b[0]) / 2 + ((b[1] - a[1]) / tl) * off, (a[1] + b[1]) / 2 - ((b[0] - a[0]) / tl) * off];
  };
  /** Paving at about height y at (x, z) besides a road's own: a paved island, a junction's paving, a joint's pad (raised, or on the ground at that level). */
  const onPaved = (x: number, z: number, y: number) =>
    onIsland(x, z, y) || inJoint(x, z, y) || padsAt(x, z).some((p) => Math.abs(p.y - y) < 0.5) || (drapedPadAt(x, z) && Math.abs(heightAt(x, z) + ROAD_LIFT + UNDER - y) < 0.5);
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
  /** The height of the road surface drawn at (x, z) nearest y, within 3 m of it (NaN: none). */
  const drawnRoadY = (x: number, z: number, y: number) => {
    let best = NaN;
    roads.each(x, z, 16, (i, seg, u, d) => {
      if (JX.internal[i] || d > halfNear(i, seg, u) + 0.2) return;
      const at = ECUM[i][seg] + u * (ECUM[i][seg + 1] - ECUM[i][seg]);
      if (at < (JX.trimA[i] || 0) - 0.05 || at > ELEN[i] - (JX.trimB[i] || 0) + 0.05) return;
      const h = hasProfile[i] ? deckAtHit(i, seg, u) : heightAt(x, z);
      if (Math.abs(h - y) < 3 && !(Math.abs(best - y) <= Math.abs(h - y))) best = h;
    });
    return best;
  };
  const jointWallCache = new Map<number, JointWall[]>();
  /** How far above the ground a deck joint's edge must stand to be drawn as a deck's (edge beam, full parapet). */
  const JOINT_DECK_FROM = 2;
  /** Is piece q of a joint's wall a deck's edge? */
  const deckPiece = (w: JointWall, q: number) => Math.min(w.drop[q], w.drop[q + 1]) >= 99;
  /** (Worked out a kerb point at a time when built, each a slice of its own: see Job.) */
  function* jointWallsIn(id: number) {
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
      for (let q = 0; q < F.length; q++) {
        yield;
        const p = F[q];
        const [nx, nz] = nrm(q);
        W.push([p[0] + nx * sgn * WALL_OUT, p[1] + nz * sgn * WALL_OUT]);
        cum.push(q ? cum[q - 1] + Math.hypot(p[0] - F[q - 1][0], p[1] - F[q - 1][1]) : 0);
        y.push(jTop(id, p[0], p[1]) + 0.09);
        // (On a deck, a deck's edge where it stands well up; where a deck
        // road comes down to the ground at the joint, its edge is the
        // ground's, as on any raised road.)
        const real = y[q] - heightAt(p[0] + nx * sgn * 1.05, p[1] + nz * sgn * 1.05);
        drop.push(deck && real >= JOINT_DECK_FROM ? 99 : real);
      }
      const keep: boolean[] = [];
      for (let q = 0; q + 1 < F.length; q++) {
        yield;
        const [nx, nz] = nrm(q);
        const x = (W[q][0] + W[q + 1][0]) / 2, z = (W[q][1] + W[q + 1][1]) / 2, ym = (y[q] + y[q + 1]) / 2;
        const along = (t: number) => inPaving(lerp(F[q][0], F[q + 1][0], t), lerp(F[q][1], F[q + 1][1], t), NaN, id);
        keep.push(!(along(0.25) || along(0.5) || along(0.75)) && !drawnRoadAt(x, z, ym) && !drawnRoadAt(x + nx * sgn * 0.6, z + nz * sgn * 0.6, ym) && !inPaving(x, z, ym, id) && !onIsland(x, z) && !inGore(x, z));
      }
      if (keep.some(Boolean)) out.push({ W, cum, y, drop, keep });
    }
    return out;
  }
  const jointWalls = (id: number) => jointWallCache.get(id) ?? drain(jointWallsIn(id));
  // The nose of a split. Where the paved wedge between two roads ends and
  // the verge between them begins, the end is closed: a kerb across it from
  // one road's edge to the other's and, between raised roads, their wall and
  // parapet carried across too (on a deck, its edge beam). So the kerbs and
  // walls of the two roads start from one nose, not each from its own
  // square end with a hole between them.
  /** A nose: nose is the island's outline from A's edge round to B's; pave the whole of its paving, from the wedge's last row (a, b) along both roads' drawn edges to the nose and round, and tris its triangles (indices into pave). */
  interface GoreCap { a: XZ; b: XZ; ya: number; yb: number; d: XZ; drop: number; nose: XZ[]; sideA: XZ[]; sideB: XZ[]; pave: XZ[]; tris: [number, number, number][]; C: XZ; yAt: (p: XZ) => number }
  // A nose: the island the two roads part round ends in a small rounded
  // point, not square across the wedge. The paving runs on NOSE_L m along
  // both roads' edges past the wedge's last row, and the island's end is a
  // circle NOSE_R m round with straight sides back to those points: the
  // kerb and edge line go round it as one line. (Square, its two corners
  // turned the edge lines through two sharp corners each, with spikes and
  // kerb pieces crossing.)
  const NOSE_R = 0.5;
  const NOSE_L = 4;
  /** The nose's outline from A's edge round to B's, past the row r (q the row before it; d out of the wedge), and the paving's height there. */
  const noseOf = (r: GoreRow, q: GoreRow, d: XZ, g: { A?: number; B?: number }): { nose: XZ[]; sideA: XZ[]; sideB: XZ[]; pave: XZ[]; tris: [number, number, number][]; C: XZ; yAt: (p: XZ) => number } => {
    const mx = (r.a[0] + r.b[0]) / 2, mz = (r.a[1] + r.b[1]) / 2;
    const w = Math.hypot(r.a[0] - r.b[0], r.a[1] - r.b[1]);
    const ua = unit(r.a[0] - mx, r.a[1] - mz);
    // (Each road's edge carries on the way it was going.)
    const la = Math.hypot(r.a[0] - q.a[0], r.a[1] - q.a[1]), lb = Math.hypot(r.b[0] - q.b[0], r.b[1] - q.b[1]);
    const da = la > 0.05 ? unit(r.a[0] - q.a[0], r.a[1] - q.a[1]) : d, db = lb > 0.05 ? unit(r.b[0] - q.b[0], r.b[1] - q.b[1]) : d;
    let aL: XZ = [r.a[0] + da[0] * NOSE_L, r.a[1] + da[1] * NOSE_L], bL: XZ = [r.b[0] + db[0] * NOSE_L, r.b[1] + db[1] * NOSE_L];
    // (Along each road's edge as it is drawn, not straight on: where the
    // road bends away, a sliver of ground opened between the two, which
    // the outline papered over.)
    const runOf = (i: number | undefined, p: XZ, p0: XZ, other: XZ): XZ[] | null => {
      if (i === undefined) return null;
      const s1 = sAlong(i, p[0], p[1]), s0 = sAlong(i, p0[0], p0[1]);
      if (Math.abs(s1 - s0) < 0.05) return null;
      const run = stripEdgeRun(i, s1, s1 + Math.sign(s1 - s0) * NOSE_L, other[0], other[1]);
      // (Only where that is the edge the wedge's row lies on.)
      return run && Math.hypot(run[0][0] - p[0], run[0][1] - p[1]) < 0.05 ? run : null;
    };
    // (Where the road's strip is not drawn there, inside a junction: along
    // its middle line, as far out from it as the row's end. Straight on, a
    // bending road's edge left it: the island's side stood 0.4 m out past
    // the road's edge, and the kerb stepped out and back round it.)
    const offRun = (i: number | undefined, p: XZ, p0: XZ): XZ[] | null => {
      if (i === undefined) return null;
      const s1 = sAlong(i, p[0], p[1]), s0 = sAlong(i, p0[0], p0[1]);
      if (Math.abs(s1 - s0) < 0.05) return null;
      const P = EP[i], cum = ECUM[i];
      const mid = (sq: number) => {
        let k = 0;
        while (k < P.length - 2 && cum[k + 1] <= sq) k++;
        const u = Math.max(0, Math.min(1, (sq - cum[k]) / (cum[k + 1] - cum[k] || 1)));
        const [tx, tz] = unit(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]);
        return { c: [lerp(P[k][0], P[k + 1][0], u), lerp(P[k][1], P[k + 1][1], u)] as XZ, tx, tz };
      };
      const m1 = mid(s1);
      const off = m1.tx * (p[1] - m1.c[1]) - m1.tz * (p[0] - m1.c[0]);
      const dir = Math.sign(s1 - s0);
      const out: XZ[] = [p];
      for (let m = 1; m <= NOSE_L + 1e-6; m += 1) {
        const sq = s1 + dir * m;
        if (sq < 0 || sq > ELEN[i]) return null;
        const { c, tx, tz } = mid(sq);
        out.push([c[0] - tz * off, c[1] + tx * off]);
      }
      return out;
    };
    const runA = runOf(g.A, r.a, q.a, r.b) ?? offRun(g.A, r.a, q.a), runB = runOf(g.B, r.b, q.b, r.a) ?? offRun(g.B, r.b, q.b);
    if (runA) aL = runA[runA.length - 1];
    if (runB) bL = runB[runB.length - 1];
    const sideA = runA ? runA.slice(1, -1) : [], sideB = runB ? runB.slice(1, -1) : [];
    let R = Math.min(NOSE_R, w / 2 - 0.05);
    // (The circle just past the row; or further on, a quarter metre at a
    // time, until the island's sides back from the 4 m points to it cross
    // neither road's edge: where the two roads part fast, the circle at
    // the row's middle lay behind the row's corner, and the side to it
    // crossed back over A's edge, the paving drawn out over the kerb.)
    const shape = (set: number, smooth = true) => {
      const C: XZ = [mx + d[0] * set, mz + d[1] * set];
      // Where the island's straight side from P touches the circle (on the side away from the other road).
      const touch = (P: XZ, side: XZ): number => {
        const vx = P[0] - C[0], vz = P[1] - C[1];
        const D = Math.hypot(vx, vz);
        const base = Math.atan2(vz, vx), off = Math.acos(Math.min(1, R / D));
        const t1 = base + off, t2 = base - off;
        return Math.cos(t1) * side[0] + Math.sin(t1) * side[1] >= Math.cos(t2) * side[0] + Math.sin(t2) * side[1] ? t1 : t2;
      };
      let tA = touch(aL, ua), tB = touch(bL, [-ua[0], -ua[1]]);
      // (Round the front, past the point nearest the wedge.)
      const front = Math.atan2(-d[1], -d[0]);
      const wrap = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      let sweep = wrap(tB - tA);
      if (wrap(front - tA) > sweep) sweep -= 2 * Math.PI;
      // (A point every 15° at least, and every 0.3 m: no facets on a small point.)
      const N = Math.max(3, Math.ceil(Math.abs(sweep) / (Math.PI / 12)), Math.ceil((Math.abs(sweep) * R) / 0.3));
      const arc: XZ[] = [];
      for (let k = 0; k <= N; k++) {
        const t = tA + (sweep * k) / N;
        arc.push([C[0] + Math.cos(t) * R, C[1] + Math.sin(t) * R]);
      }
      // (Each side from the road's edge to the circle in one smooth curve,
      // leaving the edge the way it runs and meeting the circle the way it
      // goes round: straight across, the side turned off the edge in a
      // corner 3-4 m before the point and onto the circle in another, and
      // the edge line kinked twice each side. Feedback 9, rule 3.)
      const ease = smooth ? easeSide : () => [];
      // (The way each edge runs at its 4 m point, towards the row.)
      // (Along its edge as drawn, or else along its middle line: the wedge's
      // rows ran 4 deg off a road's edge, and the curve left it in a corner.)
      // (The way the edge runs on past the 4 m point, away from the row, as
      // the outline follows it there: the wedge's rows, or the edge between
      // the row and that point, ran 3-4 deg off it, and the curve left the
      // edge in a corner.)
      const back = (i: number | undefined, p: XZ, row: XZ, other: XZ, dd: XZ): XZ => {
        if (i !== undefined) {
          const sp = sAlong(i, p[0], p[1]), sg = Math.sign(sp - sAlong(i, row[0], row[1]));
          const e = sg ? stripEdgeRun(i, sp, sp + sg * 4, other[0], other[1]) : null;
          if (e && e.length >= 2 && Math.hypot(e[0][0] - p[0], e[0][1] - p[1]) < 0.1) {
            const f = e[e.length - 1], t = unit(e[0][0] - f[0], e[0][1] - f[1]);
            if (-(t[0] * dd[0] + t[1] * dd[1]) > 0.9) return t;
          }
        }
        return [-dd[0], -dd[1]];
      };
      const nose: XZ[] = [aL, ...ease(aL, back(g.A, aL, r.a, r.b, da), arc[0], EDGE_IN), ...arc, ...ease(bL, back(g.B, bL, r.b, r.a, db), arc[arc.length - 1], EDGE_IN).reverse(), bL];
      // (Paved as one piece, its triangles found by ear clipping: from the
      // row along A's edge, round the point and back along B's.)
      const pave: XZ[] = [r.a, ...sideA, ...nose, ...[...sideB].reverse(), r.b];
      return { C, nose, pave, sweep };
    };
    // (Nor round more than three quarters of the circle: where one road's
    // edge 4 m on came back within the circle, the two touching points
    // were one and the nose ran all the way round, a disc the outline
    // paved and the paving left as grass.)
    const bad = (q: ReturnType<typeof shape>) => ringCrosses(q.pave) || Math.abs(q.sweep) > 1.5 * Math.PI;
    // (At each, its sides eased into the point, or else straight across:
    // eased only, a curve that crossed the island's own side pushed the
    // point back step after step, 2 m short and wobbling at -139.8,-57.)
    const tryAt = (set: number) => {
      const q = shape(set);
      return bad(q) ? shape(set, false) : q;
    };
    let got = tryAt(R);
    for (let set = R + 0.25; set < NOSE_L - R && bad(got); set += 0.25) got = tryAt(set);
    // (Where the two roads' edges come together again within the 4 m, a
    // circle no wider than the gap left between their ends there; none,
    // the island coming to a point, where they meet.)
    const gap = Math.hypot(aL[0] - bL[0], aL[1] - bL[1]);
    if (bad(got) && gap < 2 * R) {
      const R0 = R;
      R = gap / 2 - 0.02;
      const small = R >= 0.05 ? tryAt(R) : null;
      if (small && !bad(small)) got = small;
      else {
        R = R0;
        const C: XZ = [(aL[0] + bL[0]) / 2, (aL[1] + bL[1]) / 2];
        got = { C, nose: [aL, bL], pave: [r.a, ...sideA, aL, bL, ...[...sideB].reverse(), r.b], sweep: 0 };
      }
    }
    const { C, nose, pave } = got;
    const tris = THREE.ShapeUtils.triangulateShape(pave.map((p) => new THREE.Vector2(p[0], p[1])), []) as [number, number, number][];
    // (Each side's height carries on along it at the slope it had.)
    const sa = la > 0.05 ? (r.ya - q.ya) / la : 0, sb = lb > 0.05 ? (r.yb - q.yb) / lb : 0;
    const guess = (p: XZ) => {
      const t = Math.max(0, Math.min(1, ((p[0] - r.a[0]) * (r.b[0] - r.a[0]) + (p[1] - r.a[1]) * (r.b[1] - r.a[1])) / (w * w || 1)));
      const s = Math.max(0, (p[0] - mx) * d[0] + (p[1] - mz) * d[1]);
      return lerp(r.ya + sa * s, r.yb + sb * s, t);
    };
    // (As the roads either side are drawn there, the nearer counting most:
    // carried on from the wedge's last row, on a ramp's tilted foot it lay
    // over the road's edge and its kerb.)
    const yAt = (p: XZ) => {
      const g = guess(p);
      let sw = 0, sy = 0;
      roads.each(p[0], p[1], 12, (o, seg, u, dd) => {
        if (JX.internal[o]) return;
        const out = Math.max(0, dd - drawnHalf(o, seg, u));
        if (out > 1.5) return;
        const h = hasProfile[o] ? drawnTop(o, seg, u, p[0], p[1]) : dropAt(p[0], p[1]);
        if (!(Math.abs(h - g) < 1)) return;
        const wt = 1 / (out + 0.05) ** 2;
        sw += wt;
        sy += wt * h;
      });
      // (As the roads are, drawn 3 mm under them as the wedge is. Kept
      // under its own carrying on too, it lay 3 cm under the road beside it
      // at the 1797 point, and the kerb along both stood out of the one.)
      return sw > 0 ? sy / sw : g;
    };
    return { nose, sideA, sideB, pave, tris, C, yAt };
  };
  const goreCapCache = new Map<number, GoreCap[]>();
  const goreCaps = (id: number) => {
    let out = goreCapCache.get(id);
    if (out) return out;
    out = [];
    goreCapCache.set(id, out);
    const { rows, deck, brk } = gores[id];
    const n = rows.length;
    for (const [e, i] of [[0, 1], [n - 1, n - 2]]) {
      // (Not where the two roads stand apart in height: see the gores.)
      if (brk?.[e === 0 ? 0 : 1]) continue;
      const r = rows[e], q = rows[i];
      if (Math.hypot(r.a[0] - r.b[0], r.a[1] - r.b[1]) < 0.9) continue;
      const mx = (r.a[0] + r.b[0]) / 2, mz = (r.a[1] + r.b[1]) / 2;
      const d = unit(mx - (q.a[0] + q.b[0]) / 2, mz - (q.a[1] + q.b[1]) / 2);
      const y = (r.ya + r.yb) / 2;
      // (Only where the verge really begins: not where another road, a junction or the next wedge takes over.)
      const x = mx + d[0] * 0.8, z = mz + d[1] * 0.8;
      if (drawnRoadAt(x, z, y) || inGore(x, z) || inPaving(x, z, y) || onIsland(x, z, y) || jGrid.get(Math.floor(x / JCELL) * 100003 + Math.floor(z / JCELL))?.some((k) => inRingXZ(JPOLY[k].ring, x, z) && Math.abs(jTop(k, x, z) - y) < 3)) continue;
      const nz = noseOf(r, q, d, gores[id]);
      // (Its sides running on ahead of its point, as an island's do: where
      // two roads' edges cross at a shallow angle, a wedge of two rows lay
      // lengthwise, and one side ran back past the point, a disc of a nose
      // standing beside the island's own point, the edge line hooked round.)
      const ahead = (p: XZ) => (p[0] - nz.C[0]) * d[0] + (p[1] - nz.C[1]) * d[1] > 0;
      if (!ahead(nz.nose[0]) || !ahead(nz.nose[nz.nose.length - 1])) continue;
      out.push({ a: r.a, b: r.b, ya: r.ya, yb: r.yb, d, drop: deck > 0 ? 99 : deck < 0 ? 0 : y + 0.09 - heightAt(mx + d[0] * 1.05, mz + d[1] * 1.05), ...nz });
    }
    return out;
  };
  /**
   * The line a nose's wall (or a deck's edge beam and parapet) runs on: round
   * the island's point 0.3 m in from it, and on from each end to where the
   * road's own wall begins. NP: the nose's points it is drawn from (with the
   * road walls' ends, eA and eB, where found); NW: the wall's line.
   */
  const noseWall = (id: number, c: GoreCap) => {
    const bandOut = (line: number | undefined, from: XZ): XZ | null => {
      if (line === undefined) return null;
      const P = EP[line];
      let k = 0, best = Infinity;
      P.forEach((p, q) => {
        const dd = Math.hypot(p[0] - from[0], p[1] - from[1]);
        if (dd < best) (best = dd), (k = q);
      });
      const away = (q: number) => Math.hypot(P[q][0] - c.C[0], P[q][1] - c.C[1]);
      const dir = k + 1 < P.length && (k === 0 || away(k + 1) > away(k - 1)) ? 1 : -1;
      for (let kk = k; kk >= 0 && kk < P.length && Math.abs(kk - k) <= 4; kk += dir) {
        const a = P[Math.max(0, kk - 1)], b = P[Math.min(P.length - 1, kk + 1)];
        const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const nx = (b[1] - a[1]) / tl, nz = -(b[0] - a[0]) / tl;
        const sg = nx * (c.C[0] - P[kk][0]) + nz * (c.C[1] - P[kk][1]) > 0 ? 1 : -1;
        const h = halfAtE(line, kk) + WALL_OUT;
        const o: XZ = [P[kk][0] + nx * sg * h, P[kk][1] + nz * sg * h];
        if (!inRingXZ(c.pave, o[0], o[1]) && !inGore(o[0], o[1])) return Math.hypot(o[0] - from[0], o[1] - from[1]) < 5 ? o : null;
      }
      return null;
    };
    const eA = bandOut(gores[id].A, c.nose[0]), eB = bandOut(gores[id].B, c.nose[c.nose.length - 1]);
    const NP: XZ[] = [...(eA ? [eA] : []), ...c.nose, ...(eB ? [eB] : [])];
    // (The ends of the nose's sides, on the roads' edges, out to
    // that same line square to their road; round the point, 0.3 m
    // in from it.)
    const sq = (p: XZ, prev: XZ): XZ => {
      const t = unit(p[0] - prev[0], p[1] - prev[1]);
      const sg = -t[1] * (c.C[0] - p[0]) + t[0] * (c.C[1] - p[1]) > 0 ? 1 : -1;
      return [p[0] - t[1] * sg * WALL_OUT, p[1] + t[0] * sg * WALL_OUT];
    };
    const nA = c.nose[0], nB = c.nose[c.nose.length - 1];
    const NW = NP.map((p, q): XZ => {
      if ((eA && q === 0) || (eB && q === NP.length - 1)) return p;
      if (p === nA && eA) return sq(nA, c.sideA.length ? c.sideA[c.sideA.length - 1] : c.a);
      if (p === nB && eB) return sq(nB, c.sideB.length ? c.sideB[c.sideB.length - 1] : c.b);
      // (0.3 m in, square to the nose's line there: toward the circle's
      // middle, the points along an eased side moved along it more than
      // in from it, and on a long thin point the wall stood 11 cm out past
      // the kerb, at -817,-607.)
      const pr = NP[Math.max(0, q - 1)], nx = NP[Math.min(NP.length - 1, q + 1)];
      const t = unit(nx[0] - pr[0], nx[1] - pr[1]);
      const sg = -t[1] * (c.C[0] - p[0]) + t[0] * (c.C[1] - p[1]) > 0 ? 1 : -1;
      return [p[0] - t[1] * sg * 0.3, p[1] + t[0] * sg * 0.3];
    });
    return { NP, NW, eA, eB };
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
            // (Between two decks, a deck's edge only where the nose stands
            // up off the ground as a deck does, as on a redrawn map below:
            // on today's map too, the nose between two low bridges over a
            // drain (gore 211) stood a full parapet over 12 cm.)
            const wd = dk > 0 ? Math.max(...W.map((p, q) => yk(q) - heightAt(p[0], p[1]))) : c.drop;
            if (dk > 0 && !oneLine && wd >= LOW_DECK) {
              band(deck, W, cw, 0, 1, 0, yk, dk, 0.05, () => true);
              band(deck, W, cw, 0, 1, 0, yk, 0, PARAPET_H, () => true);
            } else if (oneLine) {
              // (Round the nose's point, 0.3 m into the island, from one
              // road's wall to the other's: one wall, no fin standing at its
              // end. Each point's own drop: none where the island is up at
              // the roads' level.)
              // (And on from each end to where the road's own wall begins:
              // its first point clear of the nose's paving, 0.45 m out from
              // the road's edge. Ending 0.3 m in from the end of the nose's
              // side, the two walls jogged 0.3 m sideways there, a step.)
              const { NP, NW, eA, eB } = noseWall(id, c);
              const nc = NW.map((_, q) => (q ? 0 : 0));
              for (let q = 1; q < NW.length; q++) nc[q] = nc[q - 1] + Math.hypot(NW[q][0] - NW[q - 1][0], NW[q][1] - NW[q - 1][1]);
              const ny = (q: number) => c.yAt(NP[q]) + 0.09;
              const nd = NW.map((p, q) => ny(q) - heightAt(p[0], p[1]));
              const at = (q: number, e: XZ | null) => !!e && Math.hypot(NW[q][0] - e[0], NW[q][1] - e[1]) < 0.05;
              const onA = (q: number) => at(q, eA) && nd[q] > ROAD_LIFT + UNDER;
              const onB = (q: number) => at(q + 1, eB) && nd[q + 1] > ROAD_LIFT + UNDER;
              // (Where a road's own wall comes on to the nose's, the nose's
              // carries it on from there however low, its top coming down to
              // the ground by the next point: it grows from nothing, where it
              // stopped square at the road wall's last point, 30 cm tall.)
              // (Between two flyover decks, the decks' edge beam and parapet,
              // round the point the same way. Straight across from one
              // road's edge to the other's, 0.3 m past the wedge, they stood
              // on the nose's paving past its point, a full parapet across.)
              // (Only where the nose stands up off the ground as a deck does:
              // a nose between two low bridges over a drain, at the junction
              // where they leave the ground, had a full parapet standing on
              // the island there, 1 m tall over no drop at all. The user's
              // rule, 18 Nov: a bridge's parapets and walls begin where the
              // ground drops. On the ground, as a raised road's below.)
              if (dk > 0 && Math.max(...nd) >= LOW_DECK) {
                band(deck, NW, nc, 0, NW.length - 1, 0, ny, dk, 0, () => true);
                band(deck, NW, nc, 0, NW.length - 1, 0, ny, 0, PARAPET_H, () => true);
                continue;
              }
              band(deck, NW, nc, 0, NW.length - 1, 0, ny, (q) => Math.max(0, nd[q]) + 0.3, (q) => wallTop(nd[q]), (q) => Math.max(nd[q], nd[q + 1]) > WALL_FROM || onA(q) || onB(q), [0, 0], (q) => (nd[q] > WALL_FROM ? Infinity : -nd[q]));
              band(deck, NW, nc, 0, NW.length - 1, 0, ny, 0, (q) => parapetTop(nd[q]), (q) => Math.max(nd[q], nd[q + 1]) > PARAPET_FROM);
            } else if (wd > WALL_FROM) {
              band(deck, W, cw, 0, 1, 0, yk, Math.max(0, wd) + 0.3, wallTop(wd), () => true);
              if (wd > PARAPET_FROM) band(deck, W, cw, 0, 1, 0, yk, 0, parapetTop(wd), () => true);
            }
          }
          const base = road.pos.length / 3, ib = road.idx.length;
          // (A hair under the roads either side, which cover its edges; and 3
          // cm in under each, so straight from row to row it still meets a
          // road's edge that bends between them: on Simei Street 1 a crack
          // 6 mm wide opened at such a bend.)
          // (Not a row whose sides are crossed over, where the two roads still
          // overlap: there it opened a crack of its own.)
          const lie = (q: number) => {
            const r = rows[q], o = rows[q + 1 < rows.length ? q + 1 : q - 1];
            if (!o) return 0;
            const dx = (o.a[0] + o.b[0] - r.a[0] - r.b[0]) * (q + 1 < rows.length ? 1 : -1), dz = (o.a[1] + o.b[1] - r.a[1] - r.b[1]) * (q + 1 < rows.length ? 1 : -1);
            return Math.sign((r.b[0] - r.a[0]) * dz - (r.b[1] - r.a[1]) * dx);
          };
          let most = 0;
          for (let q = 0; q < rows.length; q++) most += lie(q);
          for (let q = 0; q < rows.length; q++) {
            const r = rows[q];
            const w = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]);
            const tuck = w > 0.01 && most !== 0 && lie(q) === Math.sign(most);
            const ux = tuck ? ((r.b[0] - r.a[0]) / w) * 0.03 : 0, uz = tuck ? ((r.b[1] - r.a[1]) / w) * 0.03 : 0;
            road.pos.push(r.a[0] - ux, r.ya + 0.087, r.a[1] - uz, r.b[0] + ux, r.yb + 0.087, r.b[1] + uz);
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
          // Each nose's paving: from the wedge's last row along both roads' edges, round the island's point.
          for (const c of goreCaps(id)) {
            const f0 = road.pos.length / 3;
            for (const p of c.pave) {
              road.pos.push(p[0], c.yAt(p) + 0.087, p[1]);
              road.uv.push(p[0] / 6, p[1] / 6);
            }
            for (const [u, v, w] of c.tris) {
              const V = [c.pave[u], c.pave[v], c.pave[w]];
              const up = (V[1][1] - V[0][1]) * (V[2][0] - V[0][0]) - (V[1][0] - V[0][0]) * (V[2][1] - V[0][1]) >= 0;
              if (up) road.idx.push(f0 + u, f0 + v, f0 + w);
              else road.idx.push(f0 + u, f0 + w, f0 + v);
            }
          }
          // (Between two decks, an underside to the wedge and its nose, at
          // the foot of the edge beam round them, as a joint on a deck has.
          // The user's rule S4, 19 Nov: no slit or sky at any road's edge.
          // With none, from the road below, the beam round the nose was a
          // ring with nothing in it, the paving's dark underside showing up
          // through it at 1144.9,1934 and 1821.8,1624.3.)
          const dk = gores[id].deck;
          if (dk > 0) {
            const deck = acc('deck');
            const db = deck.pos.length / 3;
            const top = road.pos.length / 3;
            for (let v = base; v < top; v++) {
              deck.pos.push(road.pos[v * 3], road.pos[v * 3 + 1] + 0.003 - dk, road.pos[v * 3 + 2]);
              deck.uv.push(road.uv[v * 2], road.uv[v * 2 + 1]);
            }
            for (let i = ib; i < road.idx.length; i += 3) deck.idx.push(db + road.idx[i] - base, db + road.idx[i + 2] - base, db + road.idx[i + 1] - base);
          }
        }
      });
    // (The parapet across a nose stops the car as the roads' own do.)
    // (Two noses a slice: ten, a busy tile's took 100 to 120 ms in one.)
    for (const [k, all] of byTile)
      inChunks('near', k, 'nose barriers', all.filter((id) => gores[id].deck >= 0), 2, (list, kit) => {
        for (const id of list)
          for (const c of goreCaps(id)) {
            const dropAtEnd = (p: XZ, y: number) => y + 0.09 - heightAt(p[0] + c.d[0] * 0.3, p[1] + c.d[1] * 0.3);
            const wd = gores[id].deck > 0 ? Math.max(dropAtEnd(c.a, c.ya), dropAtEnd(c.b, c.yb)) : c.drop;
            const h = gores[id].deck > 0 && wd >= LOW_DECK ? PARAPET_H : parapetTop(wd);
            if (!oneLine) {
              if (h >= 0.3) barrierBox(tileBody(kit), c.a[0] + c.d[0] * 0.3, c.a[1] + c.d[1] * 0.3, c.b[0] + c.d[0] * 0.3, c.b[1] + c.d[1] * 0.3, (c.ya + c.yb) / 2 + 0.09, h);
              continue;
            }
            // (Round the point, on the line its parapet is drawn on: straight
            // across 0.3 m past the wedge, it stood on the nose's paving past
            // the point, a wall the car hit where none is drawn.)
            // (Each piece as tall as its parapet is drawn, by its own drop.)
            const { NP, NW } = noseWall(id, c);
            const ny = (q: number) => c.yAt(NP[q]) + 0.09;
            // (A deck's only where it stands up off the ground as drawn.)
            const high = gores[id].deck > 0 && NW.some((p, q) => ny(q) - heightAt(p[0], p[1]) >= LOW_DECK);
            for (let q = 1; q < NW.length; q++) {
              const ph = high ? PARAPET_H : parapetTop(Math.max(ny(q - 1) - heightAt(NW[q - 1][0], NW[q - 1][1]), ny(q) - heightAt(NW[q][0], NW[q][1])));
              if (ph >= 0.3) barrierBox(tileBody(kit), NW[q - 1][0], NW[q - 1][1], NW[q][0], NW[q][1], (ny(q - 1) + ny(q)) / 2, ph);
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
            // (Nor where, past either mouth, another road's paving lies against
            // that side (on a redrawn map, or within a metre of it: the outline
            // closes a gap that narrow, or lines it as a sliver): a short median
            // that ends at the junction. The road has no edge there to carry
            // across.)
            const against = [A, B].some((m, w) => {
              const nn = normal[w ? N : 0];
              let hit = false;
              for (const k of [1.5, 4])
                roads.each(m.q[0] + m.t[0] * k + nn[0] * side * (m.half + 0.05), m.q[1] + m.t[1] * k + nn[1] * side * (m.half + 0.05), 16, (i, seg, u, d) => {
                  if (!hit && i !== A.line && i !== B.line && !JX.internal[i] && drawnAt(i, seg, u) && d < halfNear(i, seg, u) + (oneLine ? 0.95 : -0.05)) hit = true;
                });
              return hit;
            });
            if (!open && !against) line(side * (A.half - 0.35), side * (B.half - 0.35), 'yellow', false);
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
  // pieces (about 8 m) to a slice; elsewhere 8 (24 held one up for 80 ms
  // by the Upper Changi Road East interchange). (r0 to r1 is the whole
  // run in the tile, k0 to k1 the part drawn in this slice.)
  const inSlices = (all: { line: number; k0: number; k1: number }[]) => {
    const out: { line: number; r0: number; r1: number; k0: number; k1: number }[] = [];
    for (const { line, k0, k1 } of all) {
      let ramp = false;
      for (let k = k0; k <= k1 && !ramp; k++) ramp = nearRamp(EP[line][k][0], EP[line][k][1]);
      const n = ramp ? 2 : 8;
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
        // (Is the wall, a fraction t along piece kk, still beside the
        // grass its kerb runs round? The grass is the ground no road,
        // joint, island, gore or nose paves, less what the outline paves
        // in rounding its points: a point is in it while a circle the
        // size of a nose's round fits there clear of all paving, the
        // circle reaching to the road's edge. Where a run of wall ends,
        // it is cut back to there.)
        // (Redrawn maps only: today's map has no rounded points, and cut
        // back there 16 raised roads' parapets stopped short over a drop.)
        // (A raised road's wall and a deck's edge beam and parapet alike, Q
        // the points it is drawn along, off its offset and y its foot.)
        const openBesideOf = (Q: XZ[], off: (kk: number) => number, y: (kk: number) => number, sgn: number) => (kk: number, t: number) => {
          const a = Q[kk], b = Q[kk + 1];
          const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          const tx = (b[0] - a[0]) / tl, tz = (b[1] - a[1]) / tl;
          const R = NOSE_R - 0.02;
          const o = off(kk) + (off(kk + 1) - off(kk)) * t + sgn * (R + 0.02 - WALL_OUT);
          const cx = a[0] + (b[0] - a[0]) * t + tz * o, cz = a[1] + (b[1] - a[1]) * t - tx * o;
          const yy = y(kk) + (y(kk + 1) - y(kk)) * t;
          const clear = (x: number, z: number) => !coveredBy(line, x, z, yy) && !inJoint(x, z, yy) && !inGore(x, z) && !inNose(x, z) && !(oneLine && onPaved(x, z, yy));
          if (!clear(cx, cz)) return false;
          for (let q = 0; q < 8; q++) {
            const c = Math.cos((q * Math.PI) / 4) * R, s = Math.sin((q * Math.PI) / 4) * R;
            if (!clear(cx + tx * c + tz * s * sgn, cz + tz * c - tx * s * sgn)) return false;
          }
          return true;
        };
        // (A flyover's piece still on its bank, under LOW_DECK over the
        // ground, is traced with the ground's roads: it is drawn as a raised
        // road is, not as a deck. With its edge beams, underside and full
        // parapets, it stood round the nose where it leaves the road beside
        // it, a grey slab over the grass.)
        const low = (kk: number) => isDeck[line] && lvlOf(line, kk) < 0;
        const raised = (kk: number) => !isDeck[line] || low(kk);
        let anyLow = false;
        if (dy && isDeck[line]) for (let kk = Math.min(lo, k0); kk < Math.max(hi, k1) && !anyLow; kk++) anyLow = low(kk);
        if (dy && (!isDeck[line] || anyLow)) {
          // A raised road: where the ground beside it falls away (its bank
          // was cut short by a road below), a retaining wall, and a parapet
          // where the drop is more than a kerb.
          const deck = acc('deck');
          const ext = runsOn(line, P);
          const sec = { lo: cut.lo, hi: cut.hi, join: opt.join };
          for (const sgn of [-1, 1]) {
            const off = (kk: number) => sgn * (halfAt(kk) + WALL_OUT);
            const dr = new Float32Array(hi - lo + 1), dg = new Float32Array(hi - lo + 1);
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
              // (And to the ground as drawn, its 4 m lattice's, where that
              // lies lower: the plan's ground is held up beside a raised
              // road, and the wall stopped 2 m over the grass at
              // 1148.1,1927.3, the road's underside showing under it. The
              // user's rule S3, 19 Nov: a wall from kerb to ground.)
              const gd = (o: number) => groundY(P[kk][0] + ((b[1] - a[1]) / tl) * o, P[kk][1] - ((b[0] - a[0]) / tl) * o);
              dg[kk - lo] = dy[kk] + 0.09 - Math.min(gd(off(kk) + sgn * 0.05), gd(off(kk) + sgn * 0.6));
            }
            const y = (kk: number) => dy[kk] + 0.09;
            // (Nor where another road's surface lies just past it: the wall
            // measured its drop to the ground under that road, and stood on
            // its paving as a grey shard past an island's point.)
            // (Both grow with the drop: the wall comes out of the ground from
            // nothing, and the parapet rises to its full height as the drop
            // passes that of a kerb, as a crash barrier's end ramps up. Neither
            // begins or ends as a square stub standing on the verge.)
            // (Nor, wall or parapet, where either end of the piece stands on
            // a nose's or a wedge's paving: a piece whose middle is on the
            // island ran on past the island's point and stood there as a
            // blade. The nose's own wall stands round the point.)
            const endAt = (kk: number): XZ => {
              const a = P[Math.max(0, kk - 1)], b = P[Math.min(P.length - 1, kk + 1)];
              const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
              return [P[kk][0] + ((b[1] - a[1]) / tl) * off(kk), P[kk][1] - ((b[0] - a[0]) / tl) * off(kk)];
            };
            const endOff = (kk: number) => inNose(...endAt(kk)) || inGore(...endAt(kk));
            // (Nor where the wall's own line lies on paving at the road's
            // level: another road's, a paved island, a junction's paving or
            // a joint's pad.
            // Tested only beside, 0.3 m out, a wall ran on into a junction's
            // median-end fill and a pad where two roads of different widths
            // meet, standing up through their paving 0.3 to 0.5 m in from
            // the kerb. Their own edges carry the kerb there.)
            // (Asked at three places along the piece, not only its middle: a
            // sharp tee's wedge flares out past the slip road's edge from
            // its mouth, and a 2 m piece of the road's wall ran on slantwise
            // under it, the wedge's own wall standing beyond.)
            const wallOnPaving = (kk: number) => {
              if (!oneLine) return false;
              const a = EP[line][kk], b = EP[line][kk + 1];
              const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
              const nx = (b[1] - a[1]) / tl, nz = -(b[0] - a[0]) / tl;
              return [0.25, 0.5, 0.75].some((t) => {
                const o = lerp(off(kk), off(kk + 1), t);
                const x = lerp(a[0], b[0], t) + nx * o, z = lerp(a[1], b[1], t) + nz * o;
                const yy = lerp(y(kk), y(kk + 1), t);
                return onPaved(x, z, yy) || coveredBy(line, x, z, yy);
              });
            };
            const openBeside = openBesideOf(P, off, y, sgn);
            band(deck, P, cum, lo, hi, off, y, (kk) => Math.max(0, dr[kk - lo], dg[kk - lo]) + 0.3, (kk) => wallTop(dr[kk - lo]), (kk) => raised(kk) && Math.max(dr[kk - lo], dr[kk + 1 - lo]) > WALL_FROM && !coveredBy(line, ...besideMid(line, kk, off(kk) + sgn * 0.3), y(kk), true) && !inJoint(...besideMid(line, kk, off(kk) + sgn * 0.3), y(kk)) && !(oneLine && (endOff(kk) || endOff(kk + 1))) && !inGore(...besideMid(line, kk, off(kk))) && !inGore(...besideMid(line, kk, off(kk) - sgn * 0.3)) && !inNose(...besideMid(line, kk, off(kk))) && !inNose(...besideMid(line, kk, off(kk) - sgn * 0.3)) && !onTeeOf(line, ...besideMid(line, kk, off(kk) + sgn * 0.45)) && !wallOnPaving(kk), ext(sgn), (kk, q) => (Math.max(dr[q - lo], dr[q + 1 - lo]) > WALL_FROM ? Infinity : -dr[kk - lo]), oneLine ? openBeside : undefined, sec);
            band(deck, P, cum, lo, hi, off, y, 0, (kk) => parapetTop(dr[kk - lo]), (kk) => raised(kk) && Math.max(dr[kk - lo], dr[kk + 1 - lo]) > PARAPET_FROM && !(oneLine && (endOff(kk) || endOff(kk + 1))) && parapetClear(line, kk, off(kk)) && !wallOnPaving(kk), ext(sgn), undefined, oneLine ? openBeside : undefined, sec);
          }
        }
        if (dy && isDeck[line]) {
          // Deck sides: a concrete edge beam, an underside and parapets.
          const deck = acc('deck');
          const depth = elevated[line] ? 1.2 : 0.6;
          // (The edge beam and the parapet on it both at the kerb's outer
          // edge, as a raised road's wall is: one face from the underside up.
          // At 0.45 m, the deck's old edge, the beam stood 10 cm out past the
          // kerb, a slot open between them, and so did the parapet before.)
          const side = (sgn: number, out = WALL_OUT) => (kk: number) => sgn * (halfAt(kk) + out);
          const sec = { lo: cut.lo, hi: cut.hi, join: opt.join };
          const y = (kk: number) => dy[kk] + 0.09;
          const ext = runsOn(line, pts);
          for (const sgn of [-1, 1]) {
            // (Nor on paving at the deck's level along the beam's own line:
            // another road's, a junction's or a pad. Where a low bridge's
            // slip road joins the road beside it, its beam ran on inside the
            // other's paving, 0.5 m in from the kerb, its top showing.)
            // (Nor in a split's wedge or on its nose, as a raised road's wall
            // is not: the wedge is paved across from one deck to the other.
            // Where a deck parted from another, both its beams ran on under
            // the wedge's paving, their tops a hairline seam in it, and each
            // parapet stood up 30 cm past the island's rounded point.)
            const onPaving = (kk: number) => {
              if (!oneLine) return false;
              const [x, z] = besideMid(line, kk, side(sgn)(kk));
              const yy = (y(kk) + y(kk + 1)) / 2;
              return onPaved(x, z, yy) || coveredBy(line, x, z, yy) || inGore(x, z) || inNose(x, z);
            };
            // (And where a run of them ends beside a nose, cut back to the
            // ground the kerb runs round, as a raised road's wall is.)
            const open = oneLine ? openBesideOf(pts, side(sgn), y, sgn) : undefined;
            band(deck, pts, cum, k0, k1, side(sgn), y, depth, 0, (kk) => !low(kk) && !onPaving(kk), ext(sgn), undefined, open, sec);
            // (As tall as the fall beside it, as a raised road's: full where
            // the ground lies 1.2 m or more under the deck, and none where it
            // does not fall away at all. The user's rule, 18 Nov: a bridge's
            // parapets begin where the ground drops. Full all along, a little
            // bridge over a drain had one standing 1 m tall at each end,
            // where it left the ground, over a fall of 10 to 30 cm.)
            const dr = (kk: number) => {
              const a = pts[Math.max(0, kk - 1)], b = pts[Math.min(pts.length - 1, kk + 1)];
              const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
              const o = side(sgn)(kk);
              const g = (e: number) => heightAt(pts[kk][0] + ((b[1] - a[1]) / tl) * (o + sgn * e), pts[kk][1] - ((b[0] - a[0]) / tl) * (o + sgn * e));
              return y(kk) - Math.min(g(0.6), g(1.6));
            };
            band(deck, pts, cum, k0, k1, side(sgn, WALL_OUT), y, 0, (kk) => parapetTop(dr(kk)), (kk) => !low(kk) && Math.max(dr(kk), dr(kk + 1)) > PARAPET_FROM && parapetClear(line, kk, side(sgn)(kk)) && !onPaving(kk), ext(sgn), undefined, open, sec);
          }
          for (let a = k0; a < k1; ) {
            if (low(a)) {
              a++;
              continue;
            }
            let b = a;
            while (b < k1 && !low(b)) b++;
            strip(deck, pts, cum, a, b, (kk) => halfAt(kk) + WALL_OUT, 0.09 - depth, { yAt });
            a = b;
          }
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
        // (Nor into a yellow box: the lines stop short of its edge.)
        const lineClear = (x: number, y: number, z: number) => !nearBox(x, z, 0.3) && (atMouth(x, z) || (!inPaving(x, z, dy ? y : NaN) && !coveredBy(line, x, z, dy ? y : NaN)));
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
          // (On the road's strip as drawn: 2 cm over it, its lift over the road's.)
          yXZ: (x: number, z: number) => stripTop(line, x, z),
          clearAt: lineClear,
          clearInner: (x: number, y: number, z: number) => !nearBox(x, z, 0.3) && !inPaving(x, z, dy ? y : NaN) && !coveredBy(line, x, z, dy ? y : NaN),
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
            // (A deck's too, by the fall beside it: see the deck's parapet.)
            const ph = isDeck[line] && lvlOf(line, kk) >= 0 ? parapetTop(y - Math.min(heightAt(mx + dz * sgn * 0.6, mz - dx * sgn * 0.6), heightAt(mx + dz * sgn * 1.6, mz - dx * sgn * 1.6))) : parapetTop(y - heightAt(mx + dz * sgn * 0.6, mz - dx * sgn * 0.6));
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
  /** A pad's shape: a disc of radius r round the joint, or (a slip road's joint) the ring round its roads' ends. */
  const padShape = (j: number) => {
    const [x, z] = M.junctions[j];
    const r = jDegree[j] === 2 ? (halfEnd(jEdges[j][0], j) + halfEnd(jEdges[j][1], j)) / 2 : jRadius[j];
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
      if (ring.length >= 3 && area !== 0) return { x, z, r, ring: area > 0 ? ring : ring.reverse() };
    }
    return { x, z, r, ring: null as XZ[] | null };
  };
  // (The raised pads, by where they lie: a mark at a pad's edge lies on
  // whichever of the pad and the road is on top, as they are drawn.)
  const PCELL = 32;
  const padGrid = new Map<number, { j: number; x: number; z: number; r: number; ring: XZ[] | null; y: number }[]>();
  for (const all of padsByTile.values())
    for (const j of all) {
      const y = padY(j);
      if (y === undefined) continue;
      const p = { j, ...padShape(j), y };
      for (let gx = Math.floor((p.x - p.r - 1) / PCELL); gx <= Math.floor((p.x + p.r + 1) / PCELL); gx++)
        for (let gz = Math.floor((p.z - p.r - 1) / PCELL); gz <= Math.floor((p.z + p.r + 1) / PCELL); gz++) {
          const key = gx * 100003 + gz;
          (padGrid.get(key) ?? padGrid.set(key, []).get(key)!).push(p);
        }
    }
  /** The raised pads at (x, z): each pad's joint and its height (as yOn has heights: under the lift all drawn things share). */
  /** Is (x, z) on (or within grow of) a pad laid on the ground, not level? */
  const drapedShapes = new Map<number, ReturnType<typeof padShape>>();
  const drapedPadAt = (x: number, z: number, grow = 0) =>
    !!padsByTile.get(tileKey(x, z))?.some((j) => {
      if (padY(j) !== undefined) return false;
      const p = drapedShapes.get(j) ?? drapedShapes.set(j, padShape(j)).get(j)!;
      return p.ring ? inRingXZ(p.ring, x, z) || (grow > 0 && ringDist(p.ring, x, z)[0] < grow) : Math.hypot(x - p.x, z - p.z) < p.r + grow;
    });
  const padsAt = (x: number, z: number, grow = 0) =>
    (padGrid.get(Math.floor(x / PCELL) * 100003 + Math.floor(z / PCELL)) ?? []).filter((p) =>
      p.ring ? inRingXZ(p.ring, x, z) || (grow > 0 && ringDist(p.ring, x, z)[0] < grow) : Math.hypot(x - p.x, z - p.z) < p.r * 0.98 + grow,
    );
  for (const [k, all] of padsByTile)
    inChunks('far', k, 'pads', all, 10, (list, _kit, acc) => {
      const road = acc('road');
      for (const j of list) {
        const { x, z, r, ring } = padShape(j);
        const y = padY(j);
        // (No kerb round it: the roads' own kerbs run up to the joint, and a
        // ring would only cross the road as a lip.)
        if (ring) padOver(road, x, z, ring, 0.09, y);
        else disc(road, x, z, r, 0.09, y);
      }
    });
  /** The height of junction id's drawn paving at (x, z): its mesh, not the smooth surface it samples. */
  const paveY = (id: number, x: number, z: number) => {
    // (Ear-clipped and read off its own triangles, not fanned: jMesh.)
    if (drawnJoint(id)) return jTop(id, x, z);
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
    inChunks('far', k, 'junctions', all.flatMap((id) => [0, 1, 2].map((part) => ({ id, part }))), 1, (list, _kit, acc) => (function* () {
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
            // (An end just outside the paving, at its edge: as the paving has
            // it just inside. Outside, the paving's height fell away 5 cm, and
            // the line from there to its next point ran under the paving's edge.)
            const inn = k === 0 ? 0.05 : k === ln.pts.length - 1 ? -0.05 : 0;
            const pIn = inRingXZ(ring, p[0], p[1]);
            for (const o of [-0.07, 0.07]) {
              const x = p[0] + tz * o, z = p[1] - tx * o;
              const y0 = paveY(id, x, z);
              const yi = !pIn && inn ? paveY(id, x + tx * inn, z + tz * inn) : NaN;
              into.pos.push(x, (yi === yi && yi > y0 && yi - y0 < 0.1 ? yi : y0) + 0.11, z);
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
          // (A fan from the middle, rings of it, where every side of the
          // ring faces the middle the same way; otherwise the ring ear-
          // clipped. Fanned, a slip road's island end, its two edges
          // carried on past the joint as prongs, was paved out past its
          // own outline, over the kerb beside it.)
          let pos = 0, neg = 0;
          for (let i = 0; i < n; i++) {
            const a = ring[i], b = ring[(i + 1) % n];
            const c = (a[0] - cx) * (b[1] - cz) - (a[1] - cz) * (b[0] - cx);
            if (c > 1e-6) pos++;
            else if (c < -1e-6) neg++;
          }
          const T: number[] = [];
          const M = jMesh(id);
          if (M) {
            for (let q = 0; q < M.P.length; q++) {
              road.pos.push(M.P[q][0], M.Y[q] + lift, M.P[q][1]);
              road.uv.push(M.P[q][0] / 6, M.P[q][1] / 6);
            }
            T.push(...M.T);
          } else if (pos && neg) {
            for (const p of ring) {
              road.pos.push(p[0], surfY(p[0], p[1]) + lift, p[1]);
              road.uv.push(p[0] / 6, p[1] / 6);
            }
            // (Each triangle wound as the fan's would be, facing up.)
            const S = pos >= neg ? 1 : -1;
            for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(ring.map(([x, z]) => new THREE.Vector2(x, z)), [])) {
              const A = ring[a], B = ring[b], C = ring[c];
              const w = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
              T.push(...(w * S < 0 ? [a, b, c] : [a, c, b]));
            }
          } else {
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
              T.push(0, 1 + i1, 1 + i);
              for (let r = 0; r + 1 < RINGS.length; r++) {
                const a = 1 + r * n;
                const b = a + n;
                T.push(a + i, a + i1, b + i1, a + i, b + i1, b + i);
              }
            }
          }
          for (const q of T) road.idx.push(base + q);
          // (On a deck the joint has an underside, as its roads have.)
          const dk = jointDeck(id);
          if (dk > 0) {
            const deck = acc('deck');
            const db = deck.pos.length / 3;
            for (let v = base; v < road.pos.length / 3; v++) {
              deck.pos.push(road.pos[v * 3], road.pos[v * 3 + 1] - lift + 0.09 - dk, road.pos[v * 3 + 2]);
              deck.uv.push(road.uv[v * 2], road.uv[v * 2 + 1]);
            }
            for (const q of T) deck.idx.push(db + q);
          }
        }
        if (part === 2) {
          const dk = jointDeck(id);
          for (const w of yield* jointWallsIn(id)) {
            const deck = acc('deck');
            const last = w.W.length - 1;
            const yk = (q: number) => w.y[q];
            if (dk > 0) {
              band(deck, w.W, w.cum, 0, last, 0, yk, dk, 0.05, (q) => w.keep[q] && deckPiece(w, q));
              band(deck, w.W, w.cum, 0, last, 0, yk, 0, PARAPET_H, (q) => w.keep[q] && deckPiece(w, q));
            }
            // (Elsewhere a wall down to the ground, growing with the drop beside it, and its parapet.)
            const dr = (q: number) => Math.min(w.drop[q], 9);
            band(deck, w.W, w.cum, 0, last, 0, yk, (q) => Math.max(0, dr(q)) + 0.3, (q) => wallTop(dr(q)), (q) => w.keep[q] && !deckPiece(w, q) && Math.max(dr(q), dr(q + 1)) > WALL_FROM, [0, 0], (q, o) => (w.keep[o] && !deckPiece(w, o) ? -dr(q) : Infinity));
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
    })());
  // Zebra stripes and stop lines.
  const crossByTile = new Map<string, Crossing[]>();
  for (const cr of crossings) {
    const k = tileKey(cr.c[0], cr.c[1]);
    (crossByTile.get(k) ?? crossByTile.set(k, []).get(k)!).push(cr);
  }
  /**
   * A flat quad draped on the ground: centre, along (unit), half length,
   * half width. On a redrawn map, on the roads' strips and the junctions'
   * paving as drawn (straight between their corners, not on the ground,
   * which dips between them: a zebra's stripes went under the road), a
   * metre at a time along it.
   */
  const quad = (acc: Acc, cx: number, cz: number, t: XZ, hl: number, hw: number, lift: number) => {
    const n: XZ = [-t[1], t[0]];
    const yAt = (x: number, z: number) => {
      const g = Math.max(rawHeight(x, z), WL + 0.15);
      if (!oneLine) return g + lift;
      let y = -Infinity;
      roads.each(x, z, 12, (o, seg, u, d) => {
        if (elevated[o] || !outlined[o] || JX.internal[o] || d > drawnHalf(o, seg, u) + 0.05) return;
        const h = stripTop(o, x, z, seg - 1, seg + 1);
        if (stripOut < 0.02 && h > y) y = h;
      });
      for (const q of jointsNear(x, z)) if (jDeck(q) <= 0 && inRingXZ(JPOLY[q].ring, x, z)) y = Math.max(y, paveY(q, x, z));
      return y > -Infinity && y + ROAD_LIFT - g < 0.5 ? Math.max(g + lift, y + ROAD_LIFT + lift - 0.09) : g + lift;
    };
    const cnt = oneLine ? Math.max(1, Math.ceil((2 * hl) / 1)) : 1;
    for (let c = 0; c < cnt; c++) {
      const a0 = -hl + (2 * hl * c) / cnt, a1 = -hl + (2 * hl * (c + 1)) / cnt;
      const base = acc.pos.length / 3;
      for (const [a, b] of [
        [a0, -hw],
        [a1, -hw],
        [a0, hw],
        [a1, hw],
      ]) {
        const x = cx + t[0] * a + n[0] * b;
        const z = cz + t[1] * a + n[1] * b;
        acc.pos.push(x, yAt(x, z), z);
        acc.uv.push(0, 0);
      }
      acc.idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
  };
  for (const [k, list] of crossByTile)
    onTile('far', k, 'crossings', (_kit, acc) => {
      const white = acc('white');
      for (const cr of list) {
        const left: XZ = [-cr.t[1], cr.t[0]];
        // Stripes 0.5 m wide, 0.5 m apart, running along the road.
        const w = cr.half - 0.4;
        if (cr.span) {
          // (Across both ways: as many stripes as fit, centred.)
          const lo = cr.span[0] + 0.4, hi = cr.span[1] - 0.4;
          const n = Math.floor((hi - lo + 0.5) / 1);
          const o0 = (lo + hi) / 2 - (n - 1) / 2;
          const tt = cr.spanT ?? cr.t, ll: XZ = [-tt[1], tt[0]];
          for (let q = 0; q < n; q++) quad(white, cr.c[0] + ll[0] * (o0 + q), cr.c[1] + ll[1] * (o0 + q), tt, CROSS_W / 2, 0.25, 0.115);
        } else if (cr.span === undefined)
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
  /**
   * Which points of a flyover are down on the ground: where it has come down
   * onto its bank, beside the roads on the ground there, or its foot. It is
   * traced with the ground's outline there, not apart as the flyover's own.
   * (A flyover link that came down beside another road on the same bank was
   * traced apart from it all the way: where the two parted, grass showed in
   * a crack between them, and neither had a kerb round the end of it.)
   */
  const LOW_DECK = 1.5;
  const deckLowOf = new Map<number, Uint8Array>();
  const deckLow = (i: number) => {
    let L = deckLowOf.get(i);
    if (L) return L;
    const P = EP[i], dy = deckY(i);
    L = Uint8Array.from(P, (p, k) => +(dy[k] - heightAt(p[0], p[1]) < LOW_DECK));
    deckLowOf.set(i, L);
    return L;
  };
  /** The level piece seg of road i is traced in: -1 the ground, else its flyover. */
  const lvlOf = (i: number, seg: number) => {
    if (deckGrp[i] < 0) return -1;
    const L = deckLow(i);
    const s = Math.max(0, Math.min(L.length - 2, seg));
    return L[s] && L[s + 1] ? -1 : deckGrp[i];
  };
  /** Is road i, about piece seg, traced in level lvl? (Either side of where its level changes, both: the outline's corner there is each's.) */
  const onLvl = (i: number, seg: number, lvl: number) => lvlOf(i, seg) === lvl || (deckGrp[i] >= 0 && (lvlOf(i, seg - 1) === lvl || lvlOf(i, seg + 1) === lvl));
  /** Road i's drawn surface as a polygon: its two sides from mouth to mouth (or from k0 to k1), as the road's strip draws them. */
  const surfacePoly = (i: number, k0 = -1, k1 = -1, bare = false): XZ[] => {
    const cut = cutOf(i);
    const P = cut.pts;
    const join = joinOf(i);
    const L: XZ[] = [];
    const R: XZ[] = [];
    for (let k = k0 < 0 ? cut.lo : k0; k <= (k1 < 0 ? cut.hi : k1); k++) {
      const { nx, nz, mm } = section(P, k, cut.lo, cut.hi, join);
      const h = halfAtE(i, k) * mm;
      // (Each end 5 cm on into whatever it meets, the next road or a
      // junction's paving, so the two overlap: two edges laid exactly on
      // each other can leave a crack in the outline. Not at a dead end.)
      const end = k === cut.lo ? -1 : k === cut.hi ? 1 : 0;
      const j = end < 0 ? edges[i].a : edges[i].b;
      let ex = 0, ez = 0;
      // (Nor where all it meets there is of another level, a flyover's end
      // and the ground road on from it: each level's outline is its own,
      // and the two kerbs ran 10 cm on past each other there.)
      const lv = (o: number) => lvlOf(o, edges[o].a === j ? 0 : EP[o].length - 2);
      const mine = end < 0 ? lvlOf(i, 0) : lvlOf(i, EP[i].length - 2);
      const others = end && jDegree[j] > 1 ? jEdges[j].filter((o) => o !== i && outlined[o]) : [];
      const apart = others.length > 0 && (end < 0 ? cut.lo === 0 : cut.hi === P.length - 1) && others.every((o) => lv(o) !== mine);
      if (!bare && end && !apart && (jDegree[j] > 1 || (end < 0 ? cut.lo > 0 || JX.trimA[i] > 0 : cut.hi < P.length - 1 || JX.trimB[i] > 0))) {
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
  type OutSrc = { ring: XZ[]; bare: XZ[]; lvl: number; x0: number; z0: number; x1: number; z1: number };
  let outSrcs: OutSrc[] | null = null;
  /** A joint's level: the ground, or the flyover its deck pieces belong to. */
  const jLvl = (id: number) => {
    if (jointDeck(id) <= 0) return -1;
    const fill = id < JX.shapes.length ? undefined : JX.fills[id - JX.shapes.length];
    const es = (fill ? (fill.tee !== undefined ? [fill.tee] : []) : JX.shapes[id].nodes).flatMap((j) => jE[j]);
    const d = es.find((i) => isDeck[i]);
    if (d === undefined) return -1;
    const ends = fill ? (fill.tee !== undefined ? [fill.tee] : []) : JX.shapes[id].nodes;
    return lvlOf(d, ends.includes(edges[d].a) ? 0 : EP[d].length - 2);
  };
  /** A gore's level: the ground, or the flyover whose deck lies nearest its first row. */
  const goreLvl = (g: (typeof gores)[number]) => {
    if (g.deck <= 0) return -1;
    const r = g.rows[0];
    const hit = roads.nearest((r.a[0] + r.b[0]) / 2, (r.a[1] + r.b[1]) / 2, 30, (i) => isDeck[i]);
    return hit ? lvlOf(hit.line, hit.seg) : -1;
  };
  const outSources = () => {
    if (outSrcs) return outSrcs;
    // (A road piece's also as its strip draws it, without the 5 cm on: see outlineRings' fills.)
    const rings: [XZ[], number, XZ[]?][] = [];
    edges.forEach((_, i) => {
      if (!outlined[i]) return;
      if (deckGrp[i] < 0) return rings.push([surfacePoly(i), -1, surfacePoly(i, -1, -1, true)]);
      // (A flyover a piece at a time: the ground's where it is down on it.)
      const { lo, hi } = cutOf(i);
      let k0 = lo;
      for (let k = lo; k < hi; k++)
        if (k + 1 === hi || lvlOf(i, k + 1) !== lvlOf(i, k)) {
          rings.push([surfacePoly(i, k0, k + 1), lvlOf(i, k), surfacePoly(i, k0, k + 1, true)]);
          k0 = k + 1;
        }
    });
    JPOLY.forEach((sh, id) => rings.push([sh.ring, jLvl(id)]));
    // (A dead end's round pad: its turning circle is the road's end, the
    // kerb running round it. Left out, the outline ended square across the
    // road and the pad lay past the kerb, the kerb hidden under it.)
    // (Every pad drawn, as drawn: at a bend or a plain joint too, its disc
    // stood out past the roads' edges, the kerb running on under it.)
    for (const all of padsByTile.values())
      for (const j of all) {
        if (!jEdges[j].some((i) => outlined[i])) continue;
        const { x, z, r, ring } = padShape(j);
        const d = jEdges[j].find((i) => isDeck[i]);
        const lvl = d === undefined ? -1 : lvlOf(d, edges[d].a === j ? 0 : EP[d].length - 2);
        rings.push([ring ?? Array.from({ length: 24 }, (_, q): XZ => [x + Math.cos((q / 24) * Math.PI * 2) * r, z + Math.sin((q / 24) * Math.PI * 2) * r]), lvl]);
      }
    gores.forEach((g, id) => {
      // (With its noses: the island's rounded point is the outline's.)
      const caps = oneLine ? goreCaps(id) : [];
      if (!caps.length) return rings.push([g.ring, goreLvl(g)]);
      const n = g.rows.length;
      const at = (row: GoreRow) => caps.find((c) => c.a === row.a && c.b === row.b);
      const head = at(g.rows[0]), tail = at(g.rows[n - 1]);
      const ring: XZ[] = [...g.rows.map((r) => r.a)];
      if (tail) ring.push(...tail.sideA, ...tail.nose, ...[...tail.sideB].reverse());
      ring.push(...g.rows.map((r) => r.b).reverse());
      if (head) ring.push(...head.sideB, ...[...head.nose].reverse(), ...[...head.sideA].reverse());
      rings.push([ring, goreLvl(g)]);
    });
    outSrcs = rings
      .filter(([r]) => r.length >= 3)
      .map(([ring, lvl, bare]) => {
        const xs = ring.map((p) => p[0]), zs = ring.map((p) => p[1]);
        return { ring, bare: bare ?? ring, lvl, x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) };
      });
    return outSrcs;
  };
  /**
   * Islands closed in by raised roads (the user's call, 18 Nov): their
   * ground raised to the roads round them. Between two roads on banks, an
   * island lay in a pit, 1.3 m deep at -139.8,-57 (I0): its lawn lifted to
   * the kerbs over it showed hollows, its footpath lay in a trench, and the
   * car would have fallen through the grass.
   *
   * An island: a hole in the ground-level paving (roads, junctions, pads,
   * split wedges, all as the outline takes them, but for the wedges'
   * rounded points, which are worked out from the ground), no more than
   * ISL_MAX m across and ISL_AREA m², with a road somewhere round it
   * standing ISL_RAISED m or more over the ground inside. Its ground: the
   * roads' heights all round its edge, blended across it by inverse
   * distance, 3 cm under their surface, and never lower than the ground
   * already there. Found a cell of ISL_CELL m at a
   * time, from the paving within ISL_MARGIN m of it: an island with any
   * point in the cell lies wholly in that, so every cell finds it the same.
   */
  const ISL_CELL = 100, ISL_MARGIN = 45, ISL_MAX = 40, ISL_AREA = 3000, ISL_RAISED = 0.5, ISL_NEAR = 60;
  /** The island's ground over the sealed ground round it: 3 cm under the roads' drawn surface (its lawn 6 cm over that, level with the kerbs' tops). */
  const ISL_UP = UNDER + ROAD_LIFT - 0.03;
  type Island = { ring: XZ[]; x0: number; z0: number; x1: number; z1: number; S: number[] };
  let islSrcs: { ring: XZ[]; x0: number; z0: number; x1: number; z1: number }[] | null = null;
  const islSources = () => {
    if (islSrcs) return islSrcs;
    const rings: XZ[][] = [];
    edges.forEach((_, i) => {
      if (!outlined[i]) return;
      if (deckGrp[i] < 0) return rings.push(surfacePoly(i));
      const { lo, hi } = cutOf(i);
      let k0 = lo;
      for (let k = lo; k < hi; k++)
        if (k + 1 === hi || lvlOf(i, k + 1) !== lvlOf(i, k)) {
          if (lvlOf(i, k) < 0) rings.push(surfacePoly(i, k0, k + 1));
          k0 = k + 1;
        }
    });
    JPOLY.forEach((sh, id) => void (jLvl(id) < 0 && rings.push(sh.ring)));
    for (const all of padsByTile.values())
      for (const j of all) {
        if (!jEdges[j].some((i) => outlined[i]) || jEdges[j].some((i) => isDeck[i])) continue;
        const { x, z, r, ring } = padShape(j);
        rings.push(ring ?? Array.from({ length: 24 }, (_, q): XZ => [x + Math.cos((q / 24) * Math.PI * 2) * r, z + Math.sin((q / 24) * Math.PI * 2) * r]));
      }
    gores.forEach((g) => void (goreLvl(g) < 0 && rings.push(g.ring)));
    islSrcs = rings
      .filter((r) => r.length >= 3)
      .map((ring) => {
        const xs = ring.map((p) => p[0]), zs = ring.map((p) => p[1]);
        return { ring, x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) };
      });
    return islSrcs;
  };
  /** Cells within ISL_NEAR m of a raised (profiled, not deck) road: only there can an island lie in a pit. */
  let islNear: Set<number> | null = null;
  const cellKey = (ci: number, cj: number) => ci * 100003 + cj;
  const islNearCells = () => {
    if (islNear) return islNear;
    islNear = new Set();
    edges.forEach((_, i) => {
      if (!hasProfile[i] || isDeck[i]) return;
      for (const [x, z] of EP[i])
        for (let ci = Math.floor((x - ISL_NEAR) / ISL_CELL); ci <= Math.floor((x + ISL_NEAR) / ISL_CELL); ci++)
          for (let cj = Math.floor((z - ISL_NEAR) / ISL_CELL); cj <= Math.floor((z + ISL_NEAR) / ISL_CELL); cj++) islNear!.add(cellKey(ci, cj));
    });
    return islNear;
  };
  /**
   * The ground as sealed under the road nearest (x, z), on the paving just
   * outside an island: that road's own height there, UNDER below it. (Not
   * heightAt: under a split's wedge or a junction's paving away from any
   * road's strip the ground is not sealed, and lay 0.7 m under the pit.)
   */
  const pavedGround = (x: number, z: number) => {
    let best = Infinity, y = NaN;
    roads.each(x, z, 14, (o, seg, u, d) => {
      if (isDeck[o] || JX.internal[o]) return;
      const half = halfNear(o, seg, u);
      if (d - half >= best) return;
      best = d - half;
      if (hasProfile[o]) y = deckAtHit(o, seg, u);
      else {
        const pts = EP[o];
        const cx = lerp(pts[seg][0], pts[seg + 1][0], u), cz = lerp(pts[seg][1], pts[seg + 1][1], u);
        const t = d > half ? half / d : 1;
        y = Math.max(rawHeight(cx + (x - cx) * t, cz + (z - cz) * t), WL + 0.15);
      }
    });
    return y - UNDER;
  };
  const islCells = new Map<number, Island[]>();
  let islBusy = false;
  const islandsIn = (ci: number, cj: number): Island[] => {
    const key = cellKey(ci, cj);
    const got = islCells.get(key);
    if (got) return got;
    const out: Island[] = [];
    islCells.set(key, out);
    if (!islNearCells().has(key)) return out;
    islBusy = true;
    try {
      const wx0 = ci * ISL_CELL - ISL_MARGIN, wz0 = cj * ISL_CELL - ISL_MARGIN, wx1 = (ci + 1) * ISL_CELL + ISL_MARGIN, wz1 = (cj + 1) * ISL_CELL + ISL_MARGIN;
      const P = new Paths64();
      for (const sr of islSources()) {
        if (sr.x1 < wx0 || sr.x0 > wx1 || sr.z1 < wz0 || sr.z0 > wz1) continue;
        const p = new Path64();
        for (const q of sr.ring) p.push(new Point64(Math.round(q[0] * OUT_S), Math.round(q[1] * OUT_S)));
        if (Clipper.area(p) < 0) p.reverse();
        P.push(p);
      }
      if (!P.length) return out;
      for (const h of Clipper.Union(P, undefined, FillRule.NonZero)) {
        const a = Clipper.area(h);
        if (a >= 0 || -a / (OUT_S * OUT_S) > ISL_AREA) continue;
        const ring: XZ[] = h.map((q) => [q.x / OUT_S, q.y / OUT_S]);
        const xs = ring.map((q) => q[0]), zs = ring.map((q) => q[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
        if (x1 - x0 > ISL_MAX || z1 - z0 > ISL_MAX) continue;
        // (Not one that reaches into another cell's own window's edge: see above.)
        if (x1 < ci * ISL_CELL || x0 > (ci + 1) * ISL_CELL || z1 < cj * ISL_CELL || z0 > (cj + 1) * ISL_CELL) continue;
        // (Nor one any road runs through, a bridge or a road the outline
        // leaves out: raised, the ground buried a road crossing an island
        // at -198,184.)
        let crossed = false;
        for (let i = 0; i < EP.length && !crossed; i++) {
          const pts = EP[i];
          for (let k = 0; k + 1 < pts.length && !crossed; k++) {
            const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
            if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1 || Math.max(az, bz) < z0 || Math.min(az, bz) > z1) continue;
            const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az)));
            for (let t = 0; t <= n && !crossed; t++) crossed = inRingXZ(ring, ax + ((bx - ax) * t) / n, az + ((bz - az) * t) / n);
          }
        }
        if (crossed) continue;
        // (Its edge every 2 m: the ground under the paving just outside it,
        // and how far that stands over the ground just inside, as it is
        // without this: islBusy.)
        const S: number[] = [];
        let raised = -Infinity;
        for (let q = 0; q < ring.length; q++) {
          const [ax, az] = ring[q], [bx, bz] = ring[(q + 1) % ring.length];
          const L = Math.hypot(bx - ax, bz - az);
          if (L < 1e-6) continue;
          let nx = (bz - az) / L, nz = -(bx - ax) / L;
          const n = Math.max(1, Math.ceil(L / 2));
          for (let t = 0; t < n; t++) {
            const sx = ax + ((bx - ax) * (t + 0.5)) / n, sz = az + ((bz - az) * (t + 0.5)) / n;
            if (t === 0 && inRingXZ(ring, sx + nx * 0.3, sz + nz * 0.3)) (nx = -nx), (nz = -nz);
            const bh = pavedGround(sx + nx * 0.5, sz + nz * 0.5);
            raised = Math.max(raised, bh - heightAt(sx - nx * 1.5, sz - nz * 1.5));
            S.push(sx, sz, bh);
          }
        }
        if (!(raised >= ISL_RAISED) || !S.length || S.some((v) => v !== v)) continue;
        out.push({ ring, x0, z0, x1, z1, S });
      }
    } finally {
      islBusy = false;
    }
    return out;
  };
  islandFill = (x: number, z: number, lawn = false) => {
    if (islBusy) return -Infinity;
    for (const I of islandsIn(Math.floor(x / ISL_CELL), Math.floor(z / ISL_CELL))) {
      if (x < I.x0 || x > I.x1 || z < I.z0 || z > I.z1 || !inRingXZ(I.ring, x, z)) continue;
      let sw = 0, sh = 0;
      for (let q = 0; q < I.S.length; q += 3) {
        const w = 1 / Math.max(0.01, (I.S[q] - x) ** 2 + (I.S[q + 1] - z) ** 2);
        sw += w;
        sh += w * I.S[q + 2];
      }
      // (Low enough near each road round it that no 4 m mesh square
      // reaching from under the road out to here rises through the road:
      // e m past its kerb, a square's corner 4.5 - e m in under the road
      // sealed 21 cm down, the line between them crosses the kerb under the
      // road's surface while this stands under 0.21 e / (4.5 - e) over it.
      // From a high island standing straight up off a low road's kerb, the
      // mesh rose through that road at -198,184. 3 cm more to spare for a
      // road climbing beside it, lower where the square reaches it than
      // where this is nearest: 2 cm through at -206,170. The lawn over it runs from
      // the kerb's top on up: see islandSheet.)
      // (The lawn over it, a mesh of its own from the kerbs' tops, needs no
      // cap: held down by it, it fell 11 cm in a hand's width beside a kerb,
      // a dark sliver at 1800.3,2092.1.)
      if (lawn) return sh / sw + ISL_UP;
      let cap = Infinity;
      roads.each(x, z, 14, (o, seg, u, d) => {
        if (isDeck[o] || JX.internal[o]) return;
        const half = halfNear(o, seg, u);
        let y: number;
        if (hasProfile[o]) y = deckAtHit(o, seg, u);
        else {
          const pts = EP[o];
          const cx = lerp(pts[seg][0], pts[seg + 1][0], u), cz = lerp(pts[seg][1], pts[seg + 1][1], u);
          const t = d > half ? half / d : 1;
          y = Math.max(rawHeight(cx + (x - cx) * t, cz + (z - cz) * t), WL + 0.15);
        }
        const e = Math.max(0, d - half - 0.35);
        if (e < 4.4) cap = Math.min(cap, y + ROAD_LIFT - 0.08 + (0.21 * e) / (4.5 - e));
      });
      return Math.min(sh / sw + ISL_UP, cap);
    }
    return -Infinity;
  };
  /** A tile's islands found ahead of its ground, a cell a slice (each joins its paving). */
  function* warmIslands(ti: number, tj: number): Generator<void, void, void> {
    const n = TILE / ISL_CELL;
    for (let a = 0; a < n; a++)
      for (let b = 0; b < n; b++) {
        const ci = ti * n + a, cj = tj * n + b;
        if (islCells.has(cellKey(ci, cj))) continue;
        islandsIn(ci, cj);
        yield;
      }
  }
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
    // Knots: three or more points all within 15 cm of the first, where
    // two pieces' corners miss each other by a hair several ways at once
    // (a W of four sides in 10 cm at a road's bend). One point, their
    // middle: the kerb round them, 0.35 m wide, folded over itself there
    // and stood out as an arrowhead.
    const KNOT = 0.15 * OUT_S;
    for (let again = true; again && r.length > 5; ) {
      again = false;
      const n = r.length;
      for (let i = 0; i < n && !again; i++) {
        let e = i;
        while (e - i < n - 4 && d(r[i], r[(e + 1) % n]) < KNOT) e++;
        if (e - i < 2) continue;
        let sx = 0, sy = 0;
        for (let v = i; v <= e; v++) (sx += r[v % n].x), (sy += r[v % n].y);
        const mid = new Point64(Math.round(sx / (e - i + 1)), Math.round(sy / (e - i + 1)));
        const keep: typeof r[number][] = [];
        for (let v = 0; v < n; v++) {
          const inK = e < n ? v >= i && v <= e : v >= i || v <= e - n;
          if (!inK) keep.push(r[v]);
          else if (v === i) keep.push(mid);
        }
        // (Wrapped round the ring's start: the middle stands where its first point was.)
        if (e >= n && !keep.includes(mid)) keep.unshift(mid);
        r.length = 0;
        r.push(...keep);
        again = true;
      }
    }
    // Nicks: a side under 0.25 m at a corner, where a road's end and a
    // junction's mouth miss each other by a hair (a nose's corner). Its
    // two sides either side run on to meet; a kerb or line turning there
    // turned back on itself and stood out as a spike.
    const NICK = 0.25 * OUT_S;
    for (let again = true; again && r.length > 4; ) {
      again = false;
      const n = r.length;
      for (let b = 0; b < n && !again; b++) {
        const c = (b + 1) % n, a = (b - 1 + n) % n, e = (c + 1) % n;
        if (d(r[b], r[c]) >= NICK || d(r[a], r[b]) < NICK || d(r[c], r[e]) < NICK) continue;
        // (Where the lines a-b and c-e cross, near the nick; else its middle.)
        const ux = r[b].x - r[a].x, uy = r[b].y - r[a].y, vx = r[e].x - r[c].x, vy = r[e].y - r[c].y;
        const den = ux * vy - uy * vx;
        const mx = (r[b].x + r[c].x) / 2, my = (r[b].y + r[c].y) / 2;
        let px = mx, py = my;
        if (Math.abs(den) > 1e-9 * Math.hypot(ux, uy) * Math.hypot(vx, vy)) {
          const t = ((r[c].x - r[a].x) * vy - (r[c].y - r[a].y) * vx) / den;
          const qx = r[a].x + ux * t, qy = r[a].y + uy * t;
          if (Math.hypot(qx - mx, qy - my) < 0.3 * OUT_S) (px = qx), (py = qy);
        }
        // (Never into the paving: the new corner on the paving's side of the
        // nick, with the long sides either side turned to meet it, took a
        // sliver off a road still drawn there, a needle of asphalt past the
        // kerb. Its middle then; and if that cuts in too, it stays.)
        const into = (x: number, y: number) => (r[c].x - r[b].x) * (y - r[b].y) - (r[c].y - r[b].y) * (x - r[b].x) > 2e3 * 2;
        if (into(px, py)) (px = mx), (py = my);
        if (into(px, py)) continue;
        const keep: typeof r[number][] = [];
        r.forEach((q, i) => {
          if (i === b) keep.push(new Point64(Math.round(px), Math.round(py)));
          else if (i !== c) keep.push(q);
        });
        r.length = 0;
        r.push(...keep);
        again = true;
      }
    }
    // Spikes: a tip under 10 degrees whose way back runs along its way out
    // (two roads' edges meeting at a hair's angle, the gap between them
    // nothing). The tip goes, and the way back with it, to where the
    // outline leaves that line: a nose there, not a sliver no kerb fits.
    for (let again = true; again && r.length > 4; ) {
      again = false;
      const n = r.length;
      for (let t = 0; t < n && !again; t++) {
        for (const dir of [1, -1]) {
          const a = r[(t - dir + n) % n], T = r[t];
          const lx = T.x - a.x, ly = T.y - a.y, L = Math.hypot(lx, ly);
          if (L < 0.5 * OUT_S) continue;
          // (The points on from the tip, back along the line from a.)
          let k = 1, last = -1;
          for (; k < Math.min(12, n - 2); k++) {
            const p = r[(t + dir * k + n * 2) % n];
            const off = Math.abs((p.x - a.x) * ly - (p.y - a.y) * lx) / L;
            const s = ((p.x - a.x) * lx + (p.y - a.y) * ly) / L;
            if (off > 0.12 * OUT_S || s < 0.05 * OUT_S || s > L) break;
            last = k;
          }
          if (last < 0) continue;
          // (A tip at all: the way back turns round, under 10 degrees.)
          const c = r[(t + dir + n) % n];
          const cx = c.x - T.x, cy = c.y - T.y;
          if ((cx * -lx + cy * -ly) / ((Math.hypot(cx, cy) || 1) * L) < Math.cos((10 * Math.PI) / 180)) continue;
          // (Keep the last point on the line; the tip and those before it go.)
          const cut = new Set<number>([t]);
          for (let v = 1; v < last; v++) cut.add((t + dir * v + n * 2) % n);
          const keep = r.filter((_, q) => !cut.has(q));
          r.length = 0;
          r.push(...keep);
          again = true;
          break;
        }
      }
    }
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
        // (Straight on along the outer of the two, never cutting into the
        // paving: a straight from a to e took a sliver up to 0.4 m wide off
        // a road whose strip is still drawn there, and it showed past the
        // kerb as a needle of asphalt. Out at c: a runs straight to c; in
        // at c: b runs straight to e. What that takes in is paved.)
        const out = (r[b].x - r[a].x) * (r[c].y - r[b].y) - (r[b].y - r[a].y) * (r[c].x - r[b].x) < 0;
        const cut = new Set<number>();
        if (out) for (let v = b; v !== c; v = (v + 1) % n) cut.add(v);
        else for (let v = (b + 1) % n; v !== e; v = (v + 1) % n) cut.add(v);
        const keep = r.filter((_, q) => !cut.has(q));
        r.length = 0;
        r.push(...keep);
        again = true;
      }
    }
  };
  /**
   * Every sharp point of grass in the outline rounded, as an island's nose
   * is: a circle NOSE_R round (less where its sides are short), a point every
   * 15 deg. (Where two roads part with no island drawn between them, the
   * outline met in a bare V: its kerb and line ran into a spike.) The
   * ground cut back from the point is paved: its piece goes in cuts.
   * (Paved by the outline's sources but by no road drawn there, it showed
   * as bare ground where the kerb had run out to the point.)
   * Clipper's rings have the paving on their left, so a point of grass is
   * where the outline turns right.
   */
  /**
   * Feedback 9, rule 3 (rebuild B): an island narrows smoothly to its
   * point. Round each rounded point of ring r (one small round turning
   * 150 deg or more within 2.5 m, no straight piece across it, as the nose
   * check finds them), every corner of the ring within 10 m of it either
   * way that turns more than 3.5 deg (and less than 60: past that it is the
   * next thing's corner, a mouth or another point) is eased into a curve,
   * its turn shared out over points at most 3 deg apart. The paving the
   * curve takes in is filled, and what it leaves out is cut (see paveCuts):
   * the kerb, its line and the paving follow it.
   */
  const easeToTips = (r: Path64, merge = false) => {
    // (Looked at the way the outline is handed on, paving on its right, as
    // the checks look at it: which of a long round's corners is its point
    // depends on the way round it is taken.)
    r.reverse();
    const fine = easeRing(r, merge);
    r.reverse();
    // (Its new points as worked out, before they were rounded to the
    // millimetre: the outline's corners are drawn from these. Rounded, a
    // curve's points 5 cm apart each turned a degree or two either way.)
    if (fine) fineOf.set(r, fine.reverse());
  };
  const fineOf = new WeakMap<Path64, [number, number][]>();
  /**
   * How far round, within 2.5 m, an outline turns at an island's point:
   * 130 deg, a point up to 50 deg wide. (At 150 deg, the island at
   * -139.8,-57 (I0), its point 45 deg wide, was no point: its sides were
   * never eased into it, and bent 10 deg 1 to 5 m from it, a jog in the
   * kerb and the yellow line.)
   */
  const TIP_TURN = (130 * Math.PI) / 180;
  const easeRing = (r: Path64, merge: boolean) => {
    const N = r.length;
    if (N < 6) return;
    const at = (q: number) => r[((q % N) + N) % N];
    // (Paving on the ring's right, y up: a point of grass turns left.)
    const turn: number[] = [], len: number[] = [];
    for (let i = 0; i < N; i++) {
      const a = at(i - 1), b = at(i), c = at(i + 1);
      const ux = b.x - a.x, uz = b.y - a.y, vx = c.x - b.x, vz = c.y - b.y;
      turn.push(Math.atan2(ux * vz - uz * vx, ux * vx + uz * vz));
      len.push(Math.hypot(vx, vz) / OUT_S);
    }
    const tips: number[] = [], all: number[] = [];
    const used = new Uint8Array(N);
    // (The points turning 150 deg first, as before, then the wider ones
    // up to TIP_TURN on what is left: a wide one, found first, took the
    // corners of a sharp one beside it, which then went uneased.)
    const candAt = (th: number) => {
      const cs: { i: number; s: number; arc: number }[] = [];
      for (let i = 0; i < N; i++) {
        if (turn[i] <= 0) continue;
        let t = 0, arc = 0;
        for (let s = 0; s < N; s++) {
          const j = (i + s) % N;
          t += turn[j];
          if (t >= th) {
            cs.push({ i, s, arc });
            break;
          }
          arc += len[j];
          if (arc > 2.5 || t < -0.2) break;
        }
      }
      return cs.sort((p, q) => p.arc - q.arc);
    };
    const sharpN = candAt((150 * Math.PI) / 180);
    const cand = [...sharpN, ...candAt(TIP_TURN)];
    for (let k = 0; k < cand.length; k++) {
      const c = cand[k], wide = k >= sharpN.length;
      let free = true;
      for (let s = 0; s <= c.s; s++) if (used[(c.i + s) % N]) free = false;
      if (!free) continue;
      let t = 0, tip = c.i, flat = 0, sharp = 0;
      for (let s = 0; s <= c.s; s++) {
        const j = (c.i + s) % N;
        t += turn[j];
        if (t < Math.PI / 2) tip = j;
        sharp = Math.max(sharp, turn[j]);
        if (s < c.s) flat = Math.max(flat, len[j]);
      }
      const isTip = flat <= 0.35 && c.arc <= 1.6 && sharp <= Math.PI / 6;
      // (A wide one counts only if it is a rounded point itself: as any
      // other rounding it would keep the easing off the corners near it.)
      if (wide && !isTip) continue;
      for (let s = 0; s <= c.s; s++) used[(c.i + s) % N] = 1;
      if (isTip) tips.push(tip);
      all.push(tip);
    }
    if (!tips.length) return;
    // (Each rounding of the ring's apart, a rounded point's or not: its own.)
    const near = (q: number) => all.some((tp) => Math.hypot(at(q).x - r[tp].x, at(q).y - r[tp].y) < 1.2 * OUT_S);
    const ease = new Set<number>();
    for (const tp of tips)
      for (const dir of [1, -1]) {
        let arc = 0;
        // (Out to 11 m from it as the crow flies, as the check measures, not
        // 10 m along the ring: where the point was taken a corner or two
        // round, a corner 9.8 m from where the check puts it was 10.2 m
        // along, left as it was, at 1335.5,571.6.)
        for (let s = 1; s < N && arc < 16; s++) {
          const j = (((tp + dir * s) % N) + N) % N;
          arc += len[dir > 0 ? (j - 1 + N) % N : j];
          if (arc >= 16 || Math.hypot(r[j].x - r[tp].x, r[j].y - r[tp].y) >= 11 * OUT_S) break;
          if (near(j)) continue;
          const a = Math.abs(turn[j]);
          if (a > Math.PI / 3) break;
          if (merge || a > (3.5 * Math.PI) / 180) ease.add(j);
        }
      }
    if (!ease.size) return;
    const out: (typeof r)[number][] = [];
    // (First, of points under 40 cm apart along it, one: a corner split
    // over two points 2 cm apart, each too close to the next for a curve
    // between, is one corner.)
    if (merge) {
      for (let i = 0; i < N; i++) {
        const l = out[out.length - 1];
        if (ease.has(i) && l && Math.hypot(r[i].x - l.x, r[i].y - l.y) < 0.4 * OUT_S) continue;
        out.push(r[i]);
      }
      if (out.length >= 6 && out.length < N) (r.length = 0), r.push(...out);
      return;
    }
    const fine: [number, number][] = [];
    for (let i = 0; i < N; i++) {
      if (!ease.has(i)) {
        out.push(r[i]);
        fine.push([r[i].x, r[i].y]);
        continue;
      }
      const a = at(i - 1), b = r[i], c = at(i + 1);
      const la = Math.hypot(b.x - a.x, b.y - a.y), lc = Math.hypot(c.x - b.x, c.y - b.y);
      // (Its curve runs at most 45% of the way along each piece where the
      // next corner is eased too, so that one's has room, else 90%; and 3 m.)
      const fa = ease.has((i - 1 + N) % N) ? 0.45 : 0.9, fc = ease.has((i + 1) % N) ? 0.45 : 0.9;
      const T = Math.min(fa * la, fc * lc, 3 * OUT_S);
      if (T < 0.02 * OUT_S) {
        out.push(b);
        fine.push([b.x, b.y]);
        continue;
      }
      // (Its points 8 cm apart at least, or where the curve has no room for
      // that, 5: closer, the millimetre they are rounded to turns each by a
      // degree or two either way.)
      const want = Math.ceil(Math.abs(turn[i]) / ((3 * Math.PI) / 180));
      const n = Math.max(2, Math.min(want, Math.max(Math.floor((2 * T) / (0.08 * OUT_S)), Math.min(want, Math.floor((2 * T) / (0.05 * OUT_S))))));
      const p0x = b.x + ((a.x - b.x) / la) * T, p0z = b.y + ((a.y - b.y) / la) * T;
      const p2x = b.x + ((c.x - b.x) / lc) * T, p2z = b.y + ((c.y - b.y) / lc) * T;
      for (let q = 0; q <= n; q++) {
        const u = q / n;
        const fx = (1 - u) * (1 - u) * p0x + 2 * u * (1 - u) * b.x + u * u * p2x, fz = (1 - u) * (1 - u) * p0z + 2 * u * (1 - u) * b.y + u * u * p2z;
        out.push(new Point64(Math.round(fx), Math.round(fz)));
        fine.push([fx, fz]);
      }
    }
    r.length = 0;
    r.push(...out);
    return fine;
  };
  const roundTips = (r: Path64, cuts: Path64[]) => {
    const TIP = (100 * Math.PI) / 180;
    const STEP = (15 * Math.PI) / 180;
    type P = (typeof r)[number];
    const dist = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);
    for (let b = 0; b < r.length && r.length > 6; b++) {
      const n = r.length;
      const at = (k: number) => r[(((b + k) % n) + n) % n];
      /** How far the outline turns right (into the grass) at k from b, in radians; negative turning left. */
      const right = (k: number) => {
        const A = at(k - 1), B = at(k), C = at(k + 1);
        const ux = B.x - A.x, uy = B.y - A.y, wx = C.x - B.x, wy = C.y - B.y;
        if (Math.hypot(ux, uy) < 1 || Math.hypot(wx, wy) < 1) return 0;
        return -Math.atan2(ux * wy - uy * wx, ux * wx + uy * wy);
      };
      const r0 = right(0);
      // (A short sharp grass spike out of a straight run of verge, between
      // two roads' ends: under 1.2 m across its foot and 2 m long, the verge
      // running on straight past it either side. No island: cut off at its
      // foot, paved. Rounded, a half circle across its foot stood out into
      // the road as a knob of kerb. Its foot may lie aslant, so long as it
      // runs on the way the verge does, where one road's edge is a little out
      // from the other's: a V notch was left between two such edges.)
      if (r0 > TIP) {
        const A = at(-1), C = at(1), Z = at(-2), D = at(2);
        const foot = dist(A, C);
        const dir = (p: { x: number; y: number }, q: { x: number; y: number }) => { const l = dist(p, q) || 1; return [(q.x - p.x) / l, (q.y - p.y) / l]; };
        const [ix, iy] = dir(Z, A), [ox, oy] = dir(C, D), [fx, fy] = dir(A, C);
        const cos45 = Math.SQRT1_2;
        const len = Math.abs((C.x - A.x) * (at(0).y - A.y) - (C.y - A.y) * (at(0).x - A.x)) / (foot || 1);
        if (foot > 0.05 * OUT_S && foot < 1.2 * OUT_S && len < 2 * OUT_S && dist(Z, A) > 0.5 * OUT_S && dist(C, D) > 0.5 * OUT_S && ix * ox + iy * oy > cos45 && ix * fx + iy * fy > 0 && fx * ox + fy * oy > 0) {
          const piece = new Path64();
          for (const p of [A, at(0), C]) piece.push(new Point64(p.x, p.y));
          cuts.push(piece);
          r.splice(b, 1);
          b--;
          continue;
        }
      }
      // (Read on from here, an end as the eye reads one: corners turning a
      // half turn within 2.5 m, the way back no more than a little, with a
      // straight piece over 0.8 m across them; its last corner, or none.
      // Its turn spread over many small corners and one flat, a long round
      // end cut off flat, it was missed below and stood square.)
      const flatEnd = (): number => {
        let t = 0, len = 0, flat = 0;
        for (let q = 0; q < n; q++) {
          t += right(q);
          if (t >= (150 * Math.PI) / 180) return flat > 0.8 * OUT_S ? q : -1;
          const l = dist(at(q), at(q + 1));
          flat = Math.max(flat, l);
          len += l;
          if (len > 2.5 * OUT_S || t < -0.2) return -1;
        }
        return -1;
      };
      const fe = r0 > 0 ? flatEnd() : -1;
      if (r0 < (30 * Math.PI) / 180 && fe < 0) continue;
      // (The point and the bends in the grass's favour beside it, within
      // 3 m: one nose, rounded as one.)
      let ka = 0, kc = 0;
      while (ka < 6 && right(-ka - 1) >= (10 * Math.PI) / 180 && dist(at(-ka - 1), at(0)) < 3 * OUT_S) ka++;
      while (kc < 6 && right(kc + 1) >= (10 * Math.PI) / 180 && dist(at(kc + 1), at(0)) < 3 * OUT_S) kc++;
      // (Or no one sharp point, but an end cut off in two or three corners,
      // the grass turning a half turn or more within 3 m between them: a
      // small island's end, faceted, rounded too. Asked at its sharpest
      // corner only. Left so, its ends stood out square across.)
      if (r0 <= TIP) {
        // (Its corners all those within 3 m turning the grass's way at
        // all: a near straight piece of a few degrees between two of them
        // split one end into two.)
        ka = 0;
        kc = 0;
        while (ka < 8 && right(-ka - 1) >= (2 * Math.PI) / 180 && dist(at(-ka - 1), at(0)) < 3 * OUT_S) ka++;
        while (kc < 8 && right(kc + 1) >= (2 * Math.PI) / 180 && dist(at(kc + 1), at(0)) < 3 * OUT_S) kc++;
        let sum = 0;
        let top = true;
        for (let k = -ka; k <= kc; k++) {
          sum += right(k);
          if (k !== 0 && (right(k) > r0 || (right(k) === r0 && k < 0))) top = false;
        }
        if (!top || sum < (150 * Math.PI) / 180) {
          if (fe < 0) continue;
          ka = 0;
          kc = fe;
        }
      }
      // (Each side's line: from the nose's last point out 1.5 m or more, past short pieces.)
      let fa = ka + 1, fc = kc + 1;
      while (fa < Math.min(24, n / 2 - 1) && dist(at(-fa), at(-ka)) < 1.5 * OUT_S) fa++;
      while (fc < Math.min(24, n / 2 - 1) && dist(at(fc), at(kc)) < 1.5 * OUT_S) fc++;
      // (And on, while the side runs straight on, within 6 degrees, to 8 m,
      // where the nose would else be under half a metre across and no kerb
      // runs round it, the roads either side plain lanes: a long thin
      // island's sides in short pieces gave its nose no room, and its point
      // stayed a sliver of grass a few centimetres across, nothing at its
      // edge to show it. A kerbed one shows its kerb.)
      const straightOn = (sg: number, s0: number, f: number) => {
        const S = at(sg * s0), F = at(sg * f);
        const fx = F.x - S.x, fy = F.y - S.y, fl = Math.hypot(fx, fy) || 1;
        while (f < Math.min(24, n / 2 - 1)) {
          const Q = at(sg * (f + 1));
          const qx = Q.x - S.x, qy = Q.y - S.y, ql = Math.hypot(qx, qy) || 1;
          if (ql > 8 * OUT_S || (fx * qx + fy * qy) / (fl * ql) < Math.cos((6 * Math.PI) / 180)) break;
          f++;
        }
        return f;
      };
      {
        const A0 = at(-ka), B0 = at(-fa), C0 = at(kc), D0 = at(fc);
        const l1 = dist(A0, B0) || 1, l2 = dist(C0, D0) || 1;
        const cs = ((B0.x - A0.x) * (D0.x - C0.x) + (B0.y - A0.y) * (D0.y - C0.y)) / (l1 * l2);
        const tn = Math.tan(Math.acos(Math.max(-1, Math.min(1, cs))) / 2);
        const room = 0.9 * Math.min(l1, l2);
        // (Every road whose edge passes within 2 m of its point, and one at least.)
        let plain = 0;
        roads.each(at(0).x / OUT_S, at(0).y / OUT_S, 12, (o, seg, u, d) => {
          if (!outlined[o] || JX.internal[o] || d - drawnHalf(o, seg, u) > 2) return;
          plain = plain < 0 || kerbedRoad(edges[o]) || hasProfile[o] ? -1 : 1;
        });
        if (plain > 0 && tn > 1e-3 && room < (NOSE_R * OUT_S) / tn && 2 * room * tn < 0.5 * OUT_S) {
          fa = straightOn(-1, ka, fa);
          fc = straightOn(1, kc, fc);
        }
      }
      const SA = at(-ka), FA = at(-fa), SC = at(kc), FC = at(fc);
      const la = dist(SA, FA) || 1, lc = dist(SC, FC) || 1;
      const ux = (FA.x - SA.x) / la, uy = (FA.y - SA.y) / la, wx = (FC.x - SC.x) / lc, wy = (FC.y - SC.y) / lc;
      // (A blunt end, its sides near parallel or its corners turning more
      // than a half turn between them: a half circle across it, set back
      // till it lies wholly in the grass, the island as wide as there.)
      let total = 0;
      for (let k = -ka; k <= kc; k++) total += right(k);
      const blunt = (): boolean => {
        let mx = ux + wx, my = uy + wy;
        const ml = Math.hypot(mx, my);
        if (ml < 1e-3) return false;
        mx /= ml;
        my /= ml;
        const du = ux * mx + uy * my, dw = wx * mx + wy * my;
        if (du < 0.3 || dw < 0.3) return false;
        const dot = (p: { x: number; y: number }) => p.x * mx + p.y * my;
        let deep = -Infinity;
        for (let k = -ka; k <= kc; k++) deep = Math.max(deep, dot(at(k)));
        const feet = (sc: number) => {
          const t1 = (sc - dot(SA)) / du, t2 = (sc - dot(SC)) / dw;
          return { t1, t2, f1: { x: SA.x + ux * t1, y: SA.y + uy * t1 }, f2: { x: SC.x + wx * t2, y: SC.y + wy * t2 } };
        };
        let sc = deep;
        for (let it = 0; it < 3; it++) sc = deep + dist(feet(sc).f1, feet(sc).f2) / 2;
        const { t1, t2, f1, f2 } = feet(sc);
        if (t1 < 0 || t2 < 0 || t1 > 0.9 * la || t2 > 0.9 * lc) return false;
        const cx = (f1.x + f2.x) / 2, cy = (f1.y + f2.y) / 2;
        const R = dist(f1, f2) / 2;
        if (R < 0.2 * OUT_S || R > 3 * OUT_S) return false;
        const a0 = Math.atan2(f1.y - cy, f1.x - cx), a1 = Math.atan2(f2.y - cy, f2.x - cx);
        // (Round by the front: the way from f1 that turns toward -m.)
        const sg = (f1.x - cx) * -my - (f1.y - cy) * -mx > 0 ? 1 : -1;
        let da = (a1 - a0) * sg;
        while (da <= 0) da += 2 * Math.PI;
        while (da > 2 * Math.PI) da -= 2 * Math.PI;
        da *= sg;
        const m = Math.max(2, Math.ceil(Math.abs(da) / STEP));
        const arc: P[] = [];
        for (let q = 0; q <= m; q++) arc.push(new Point64(Math.round(cx + R * Math.cos(a0 + (da * q) / m)), Math.round(cy + R * Math.sin(a0 + (da * q) / m))));
        const gone = new Set<number>();
        const piece = new Path64();
        piece.push(new Point64(arc[0].x, arc[0].y));
        for (let k = -fa + 1; k < fc; k++) {
          // (A side's points back past the half circle stay: an island
          // whose sides curve has points there, and its end was left square.)
          if ((k < -ka || k > kc) && dot(at(k)) >= sc) continue;
          gone.add((((b + k) % n) + n) % n);
          piece.push(new Point64(at(k).x, at(k).y));
        }
        for (let q = arc.length - 1; q >= 0; q--) piece.push(new Point64(arc[q].x, arc[q].y));
        cuts.push(piece);
        const keep: P[] = [];
        for (let q = 0; q < n; q++) {
          if (q === b) keep.push(...arc);
          else if (!gone.has(q)) keep.push(r[q]);
        }
        r.length = 0;
        r.push(...keep);
        b = keep.indexOf(arc[arc.length - 1]);
        return true;
      };
      if (total >= ((r0 <= TIP ? 150 : 160) * Math.PI) / 180 && blunt()) continue;
      // (Where the two lines meet: the point the nose rounds.)
      const den = ux * wy - uy * wx;
      if (Math.abs(den) < 1e-6) continue;
      const s1 = ((SC.x - SA.x) * wy - (SC.y - SA.y) * wx) / den;
      const s2 = ((SC.x - SA.x) * uy - (SC.y - SA.y) * ux) / den;
      // (Behind both nose ends: SA = T + u * -s1.)
      if (s1 > 1 || s2 > 1) continue;
      const T = { x: SA.x + ux * s1, y: SA.y + uy * s1 };
      const phi = Math.acos(Math.max(-1, Math.min(1, ux * wx + uy * wy)));
      if (Math.PI - phi <= TIP || phi < 1e-3) continue;
      const tan = Math.tan(phi / 2);
      const reach = Math.max(dist(T, SA), dist(T, SC));
      const t = Math.min(Math.max((NOSE_R * OUT_S) / tan, reach + 1), 0.9 * Math.min(dist(T, FA), dist(T, FC)));
      if (t < reach) continue;
      const R = t * tan;
      if (R < 0.02 * OUT_S) continue;
      const bx = ux + wx, by = uy + wy, bl = Math.hypot(bx, by) || 1;
      const ox = T.x + (bx / bl) * (R / Math.sin(phi / 2)), oy = T.y + (by / bl) * (R / Math.sin(phi / 2));
      const a0 = Math.atan2(T.y + uy * t - oy, T.x + ux * t - ox);
      let da = Math.atan2(T.y + wy * t - oy, T.x + wx * t - ox) - a0;
      // (The short way round, past the point.)
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      const m = Math.max(2, Math.ceil(Math.abs(da) / STEP));
      const arc: P[] = [];
      for (let q = 0; q <= m; q++) arc.push(new Point64(Math.round(ox + R * Math.cos(a0 + (da * q) / m)), Math.round(oy + R * Math.sin(a0 + (da * q) / m))));
      // (The points between, that the circle cuts off, give way to it; the
      // ground between them and it is paved.)
      const gone = new Set<number>();
      const piece = new Path64();
      piece.push(new Point64(arc[0].x, arc[0].y));
      for (let k = -fa + 1; k < fc; k++) {
        if ((k < -ka || k > kc) && dist(at(k), T) >= t) continue;
        gone.add((((b + k) % n) + n) % n);
        piece.push(new Point64(at(k).x, at(k).y));
      }
      for (let q = arc.length - 1; q >= 0; q--) piece.push(new Point64(arc[q].x, arc[q].y));
      cuts.push(piece);
      const keep: P[] = [];
      for (let q = 0; q < n; q++) {
        if (q === b) keep.push(...arc);
        else if (!gone.has(q)) keep.push(r[q]);
      }
      r.length = 0;
      r.push(...keep);
      b = keep.indexOf(arc[arc.length - 1]);
    }
  };
  /**
   * The outline's first half for tile (ix, iz), in a build slice of its own:
   * its pieces gathered and joined, each level by itself, both as the
   * outline takes them and as their strips draw them. (In one slice with
   * the rest, a busy tile's outline held a frame up for 158 ms.)
   */
  /** (Joined a level at a time, each a slice of its own: see Job.) */
  function* outlineUnionsIn(ix: number, iz: number) {
    const M = 30;
    const bx0 = ix * TILE - M, bz0 = iz * TILE - M, bx1 = (ix + 1) * TILE + M, bz1 = (iz + 1) * TILE + M;
    // (Each level by itself: the ground, and each flyover.)
    const byLvl = new Map<number, Paths64>();
    const bareLvl = new Map<number, Paths64>();
    for (const s of outSources()) {
      if (s.x1 < bx0 || s.x0 > bx1 || s.z1 < bz0 || s.z0 > bz1) continue;
      const p = new Path64();
      for (const q of s.ring) p.push(new Point64(Math.round(q[0] * OUT_S), Math.round(q[1] * OUT_S)));
      // (All one way round: where two pieces wound opposite ways overlap,
      // their windings would cancel and leave a false hole.)
      if (Clipper.area(p) < 0) p.reverse();
      (byLvl.get(s.lvl) ?? byLvl.set(s.lvl, new Paths64()).get(s.lvl)!).push(p);
      const b = new Path64();
      for (const q of s.bare) b.push(new Point64(Math.round(q[0] * OUT_S), Math.round(q[1] * OUT_S)));
      if (Clipper.area(b) < 0) b.reverse();
      (bareLvl.get(s.lvl) ?? bareLvl.set(s.lvl, new Paths64()).get(s.lvl)!).push(b);
    }
    const lv: { lvl: number; U: Paths64; U0: Paths64 }[] = [];
    for (const [lvl, paths] of [...byLvl].sort((p, q) => p[0] - q[0])) {
      yield;
      let U = Clipper.Union(paths, undefined, FillRule.NonZero);
      // (Less the dividers, on the ground: see dividers.)
      if (lvl < 0) {
        const D = new Paths64();
        for (const dv of dividers) {
          if (dv.x1 < bx0 || dv.x0 > bx1 || dv.z1 < bz0 || dv.z0 > bz1) continue;
          const p = new Path64();
          for (const q of dv.ring) p.push(new Point64(Math.round(q[0] * OUT_S), Math.round(q[1] * OUT_S)));
          if (Clipper.area(p) < 0) p.reverse();
          D.push(p);
        }
        if (D.length) {
          // (A slice of its own: with the union, over 100 ms in one.)
          yield;
          U = Clipper.Difference(U, D, FillRule.NonZero);
        }
      }
      yield;
      // (As the pieces pave it, before the outline is tidied: see the
      // end. Each road piece as its strip draws it, not 5 cm on past its
      // end into what it meets: where two meet at an angle, the wedge
      // between their ends, and where one meets a fill, the 5 cm
      // between, are the fills'.)
      lv.push({ lvl, U, U0: Clipper.Union(bareLvl.get(lvl)!, undefined, FillRule.NonZero) });
    }
    return { ix, iz, lv };
  }
  const outlineUnions = (ix: number, iz: number) => drain(outlineUnionsIn(ix, iz));
  /**
   * Rebuild B (the user's plan, 17 Nov): nothing paved lies outside a kerb.
   * Each tile's paving as its pieces draw it, where the finished outline
   * (its folds, nicks, needles and slivers tidied, its points rounded)
   * leaves it out: cut away before the tile is drawn (cutPaving), keeping
   * each piece's own heights. Before, the paving drawn there showed over
   * the kerb, and the kerb was buried under it.
   */
  const paveCuts = new Map<string, Paths64>();
  /** (The ground's, under a flyover's outline: cut only where another surface lies over it.) */
  const paveUnder = new Map<string, Paths64>();
  /** The outline round tile (ix, iz), and 30 m beyond, from its pieces joined (outlineUnions). */
  /** (Traced a ring at a time, each a few slices of its own: see Job.) */
  function* outlineFinishIn({ ix, iz, lv }: ReturnType<typeof outlineUnions>) {
    const M = 30;
    const bx0 = ix * TILE - M, bz0 = iz * TILE - M, bx1 = (ix + 1) * TILE + M, bz1 = (iz + 1) * TILE + M;
    const out: { pts: XZ[]; corner: XZ[]; edge: number[]; at: number[]; hole: boolean; lvl: number; fill?: boolean; holes?: XZ[][] }[] = [];
    // (Rebuild B: the paving as drawn that the finished outline leaves out,
    // every level's, less what any level's outline takes in: see paveCuts.)
    const cutLv: Paths64[] = [], keptLv: Paths64[] = [], lvLv: number[] = [];
    for (const { lvl, U, U0 } of lv) {
    const kept = new Paths64();
    const tipCuts: Path64[] = [];
    for (const r of U) {
      // (Slivers and specks, where two pieces of paving all but touch: no surface.)
      if (Math.abs(Clipper.area(r)) < 1e6) continue;
      yield;
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
      // (Its points' cut-back ground paved only if the ring itself is kept.)
      const cuts: Path64[] = [];
      roundTips(r, cuts);
      // (Nor a zigzag: a piece under 30 cm turned back against the pieces
      // either side of it, the outline stepping back and on again. Its kerb
      // folded over itself, by a small pad off Tampines Avenue 10.)
      for (let again = true; again && r.length > 4; ) {
        again = false;
        for (let q = 0; q < r.length && r.length > 4; q++) {
          const a = r[(q - 1 + r.length) % r.length], b = r[q], c = r[(q + 1) % r.length], e = r[(q + 2) % r.length];
          const bc = Math.hypot(c.x - b.x, c.y - b.y);
          if (bc >= 0.3 * OUT_S || bc < 1) continue;
          const d1 = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y), d2 = (c.x - b.x) * (e.x - c.x) + (c.y - b.y) * (e.y - c.y);
          const cr1 = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x), cr2 = (c.x - b.x) * (e.y - c.y) - (c.y - b.y) * (e.x - c.x);
          if (d1 >= 0 || d2 >= 0 || Math.sign(cr1) === Math.sign(cr2)) continue;
          r[q] = new Point64(Math.round((b.x + c.x) / 2), Math.round((b.y + c.y) / 2));
          r.splice((q + 1) % r.length, 1);
          again = true;
          break;
        }
      }
      easeToTips(r, true);
      easeToTips(r);
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
      const F = fineOf.get(r);
      const fx = (q: number) => (F && F.length === r.length ? F[q][0] : r[q].x), fz = (q: number) => (F && F.length === r.length ? F[q][1] : r[q].y);
      for (let q = r.length - 1; q >= 0; q--) {
        const qb = (q - 1 + r.length) % r.length;
        const ax = fx(q) / OUT_S, az = fz(q) / OUT_S, bx = fx(qb) / OUT_S, bz = fz(qb) / OUT_S;
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
        yield;
        let paved = false;
        for (let q = 0; q < corner.length && !paved; q++) {
          const a = corner[q], b = corner[(q + 1) % corner.length];
          const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (l < 1) continue;
          // (The paving on the left, the hole on the right: x east, z south.)
          const x = (a[0] + b[0]) / 2 - ((b[1] - a[1]) / l) * 0.3, z = (a[1] + b[1]) / 2 + ((b[0] - a[0]) / l) * 0.3;
          // (Only where this tile sees all the paving: outside its margin a
          // piece it was not given leaves a false way out of the hole, and a
          // block's ring reaching out there was dropped by one tile and kept
          // by the next, its kerb stopping at the tile's edge.)
          if (x < bx0 + 1 || x > bx1 - 1 || z < bz0 + 1 || z > bz1 - 1) continue;
          if (!inRingXZ(corner, x, z)) continue;
          // (A road where it is drawn: not where it is cut back at a
          // shaped junction, the junction's paving drawn there instead. Taken
          // as drawn to its full width up to its joint, a median beside a
          // junction was dropped as paving the union missed, and paved over
          // by one tile while the next kept its kerbs, buried under it.)
          const drawn = ([i, h]: [number, { seg: number; u: number }]) => {
            const s = ECUM[i][h.seg] + h.u * (ECUM[i][h.seg + 1] - ECUM[i][h.seg]);
            return s >= (JX.trimA[i] || 0) - 0.05 && s <= ELEN[i] - (JX.trimB[i] || 0) + 0.05;
          };
          const near: Near = new Map([...nearRoads(x, z)].filter(([i, h]) => onLvl(i, h.seg, lvl) && drawn([i, h])));
          const r = edgeRoadOf(near, (i) => !JX.internal[i]);
          if (r && r.past < -0.1) paved = true;
        }
        if (paved) continue;
      }
      out.push({ pts, corner, edge, at, hole: area2 > 0, lvl });
      kept.push(r);
      tipCuts.push(...cuts);
    }
    // (Where the outline, tidied, takes in ground no piece paves: a notch
    // cut across, a sliver or a speck of a hole dropped, a spike cut off.
    // Its kerb runs across it, so it is paved over, a few millimetres under
    // the roads about it: left as it was, the ground showed through the
    // road there, a sliver of grass up to half a metre wide.)
    // (With its holes: a piece the sources pave, or ground outside the
    // outline, within it. Filled whole, a hole laid paving out past the
    // kerb, a strip of asphalt beside it.)
    const toXZ = (f: Path64) => f.map((q): XZ => [q.x / OUT_S, q.y / OUT_S]);
    // (Given copies: the library moves the points it is handed while it
    // works, and the outline's own corners went with them.)
    const copy = (P: Paths64) => {
      const c = new Paths64();
      for (const r of P) c.push(r.map((q) => new Point64(q.x, q.y)) as Path64);
      return c;
    };
    yield;
    const D = Clipper.Difference(copy(kept), copy(U0), FillRule.NonZero);
    const fills: { corner: XZ[]; holes: XZ[][] }[] = [];
    for (const f of D) if (Clipper.area(f) >= 1e3) fills.push({ corner: toXZ(f), holes: [] });
    for (const f of D) {
      if (Clipper.area(f) >= 0) continue;
      const h = toXZ(f);
      fills.find((g) => inRingXZ(g.corner, h[0][0], h[0][1]))?.holes.push(h);
    }
    for (const f of tipCuts) if (Math.abs(Clipper.area(f)) >= 1e3) fills.push({ corner: toXZ(f), holes: [] });
    for (const { corner, holes } of fills) out.push({ pts: corner, corner, edge: [], at: [], hole: true, lvl, fill: true, holes });
    yield;
    cutLv.push(Clipper.Difference(copy(U0), copy(kept), FillRule.NonZero));
    keptLv.push(copy(kept));
    lvLv.push(lvl);
    }
    // (Less what any other level's outline takes in, a level at a time,
    // each a slice of its own: all joined in one, a busy tile's outline
    // held a frame up for 122 ms. But the ground's, under a flyover's
    // outline, kept apart: paving there is cut only where it lies under
    // another surface, the ground's own under the flyover. Taken out whole,
    // a slip road's paving lay on over its island's point under the
    // flyover, the kerb hidden under it.)
    const cut = new Paths64(), under = new Paths64();
    for (let a = 0; a < cutLv.length; a++) {
      let c = cutLv[a];
      for (let b = 0; b < keptLv.length && c.length; b++) {
        if (b === a) continue;
        yield;
        const kb = new Paths64();
        for (const r of keptLv[b]) kb.push(r.map((q) => new Point64(q.x, q.y)) as Path64);
        if (lvLv[a] < 0) {
          const cc = new Paths64();
          for (const r of c) cc.push(r.map((q) => new Point64(q.x, q.y)) as Path64);
          for (const q of Clipper.Intersect(cc, kb, FillRule.NonZero)) under.push(q);
          const kb2 = new Paths64();
          for (const r of keptLv[b]) kb2.push(r.map((q) => new Point64(q.x, q.y)) as Path64);
          c = Clipper.Difference(c, kb2, FillRule.NonZero);
        } else c = Clipper.Difference(c, kb, FillRule.NonZero);
      }
      for (const q of c) cut.push(q);
    }
    paveUnder.delete(`${ix},${iz}`);
    paveUnder.set(`${ix},${iz}`, under);
    if (paveUnder.size > 300) paveUnder.delete(paveUnder.keys().next().value!);
    paveCuts.delete(`${ix},${iz}`);
    paveCuts.set(`${ix},${iz}`, cut);
    if (paveCuts.size > 300) paveCuts.delete(paveCuts.keys().next().value!);
    return out;
  }
  const outlineFinish = (u: ReturnType<typeof outlineUnions>) => drain(outlineFinishIn(u));
  const outlineRings = (ix: number, iz: number) => outlineFinish(outlineUnions(ix, iz));
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
      if (hit || lvlOf(i, seg) < 0 || d > drawnHalf(i, seg, u) + 0.05) return;
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
      if (hit || lvlOf(i, seg) === lvl || !outlined[i] || d > drawnHalf(i, seg, u) + 0.05) return;
      hit = Math.abs((hasProfile[i] ? deckAtHit(i, seg, u) : dropAt(x, z)) - y) < 1.5;
    });
    return hit || jointsNear(x, z).some((q) => jLvlM(q) !== lvl && inRingXZ(JPOLY[q].ring, x, z) && Math.abs(jTop(q, x, z) - y) < 1.5);
  };
  const segDist = (a: XZ, b: XZ, x: number, z: number) => {
    const vx = b[0] - a[0], vz = b[1] - a[1];
    const u = Math.max(0, Math.min(1, ((x - a[0]) * vx + (z - a[1]) * vz) / (vx * vx + vz * vz || 1)));
    const ex = a[0] + vx * u - x, ez = a[1] + vz * u - z;
    return Math.sqrt(ex * ex + ez * ez);
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
    const near: Near = new Map([...all].filter(([i, h]) => onLvl(i, h.seg, lvl)));
    const flat = lvl < 0 && flatNear(mx, mz, near);
    const joint = flat ? -1 : jointsNear(mx, mz).find((q) => (lvl < 0 ? jDeck(q) === 0 : jLvlM(q) === lvl) && ringDist(JPOLY[q].ring, mx, mz)[0] < 0.3) ?? -1;
    const under = edgeRoadOf(near, () => true);
    const y = flat ? NaN : outlineY(mx, mz, near, lvl);
    const base = { flat, joint, road: under && hasProfile[under.i] ? under.i : -1, seg: under?.seg ?? 0, lr: -1, ls: 0, lvl };
    // The road whose edge this is. (Not a road's by its end, where it joins
    // others: there the outline runs round the end of it, across the road
    // it meets, and that road's edge it is. A side road drawn a little
    // across the road it meets took the far side's kerb away.)
    const offEnd = (i: number, h: { seg: number; u: number }) => (h.seg === 0 && h.u <= 0 && jDegree[edges[i].a] >= 2) || (h.seg === EP[i].length - 2 && h.u >= 1 && jDegree[edges[i].b] >= 2);
    let r = edgeRoadOf(new Map([...near].filter(([i, h]) => !offEnd(i, h))), (i) => !JX.internal[i]) ?? edgeRoadOf(near, (i) => !JX.internal[i]);
    // (A junction's own piece of road, drawn, whose edge this is, where no
    // other road's is: a loop at a road's end, all of it a junction's
    // pieces, had no road's edge within metres and no kerb round it.)
    const own = edgeRoadOf(new Map([...near].filter(([i, h]) => JX.internal[i] && !offEnd(i, h))), () => true);
    if (own && Math.abs(own.past) < 0.2 && (!r || Math.abs(r.past) > 0.2)) r = own;
    // (Round a road's very end, where it stops at the map's edge or a dead
    // end: its kerb runs on round the end, and on a lined road its edge
    // line with it, as round an island. The kerb is one closed loop; with
    // none across the end, each side's kerb stopped on the verge.
    // Not where another road carries on from it: a step there between the two is no end.)
    if (r) {
      const s = lerp(ECUM[r.i][r.seg], ECUM[r.i][r.seg + 1], r.u);
      const endJ = s < ELEN[r.i] / 2 ? edges[r.i].a : edges[r.i].b;
      if ((s < 0.5 || s > ELEN[r.i] - 0.5) && jDegree[endJ] <= 1) {
        const kb = kerbedRoad(edges[r.i]) || hasProfile[r.i];
        return { ...base, kerb: kb, line: kb && outlined[r.i] && rankOf(edges[r.i].cls) >= 2, stop: false, why: 'road end', lr: r.i, ls: r.seg };
      }
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
    // (And round a point between a kerbed road and one without, its kerb
    // runs on round the point to where the other road's own side begins:
    // past that road's edge, the outline is the point's, not its side.
    // Taken for the plain road's side round the rounded point, the kerb
    // stopped on the verge a metre short of it.)
    if (r && !kerb && r.past > 0.1) {
      const k = edgeRoadOf(near, (i) => !JX.internal[i] && (kerbedRoad(edges[i]) || hasProfile[i]));
      if (k && Math.abs(k.past) < 3) kerb = true;
    }
    let why = r ? `road ${r.i} past ${r.past.toFixed(2)}` : 'no road';
    /** The joint whose paving's side this is (not a road's). */
    // (Or no road's at all: a joint's paving reaching further than any
    // road near it, its kerb stopped on the verge where no road was near.)
    const jointSide = !r || Math.abs(r.past) > 0.2 ? jointsNear(mx, mz).find((q) => jLvlM(q) === lvl && inRingXZ(JPOLY[q].ring, mx + nx * 0.05, mz + nz * 0.05) && !inRingXZ(JPOLY[q].ring, mx - nx * 0.05, mz - nz * 0.05)) : undefined;
    // (Its kerbs stop short of the roads' edges, where each road's own
    // kerb once ran: an edge line along a kerbed road keeps its kerb there.)
    const kerbAlong = kerb;
    if (jointSide !== undefined) {
      // (On a redrawn map the kerb is one closed loop: round a joint's
      // corner beside a kerbed road it runs on, wherever the junction's own
      // kerb lines lie. Asked of those alone, a corner the tidied outline
      // rounds off more than 0.6 m from them, or one they leave out, had
      // none, and the kerbs either side stopped on the verge.)
      const jk = JPOLY[jointSide].kerbs.some((F) => F.some((p, w) => w > 0 && segDist(F[w - 1], p, mx, mz) < 0.6));
      kerb = oneLine ? kerb || jk : kerb && jk;
      why += ` joint ${jointSide}`;
    }
    // An edge line: where the outline runs along a lined road's edge.
    // (Each road by its nearest point: any other point of it, a corner
    // further along, may happen to lie a road's half width away too. Not
    // off its end: there the outline is round its end, not along its side.)
    let lined = -1;
    let ls = 0;
    let lo = Infinity;
    const onDiv = lvl < 0 && dividers.some((v) => mx > v.x0 - 0.1 && mx < v.x1 + 0.1 && mz > v.z0 - 0.1 && mz < v.z1 + 0.1 && v.ring.some((p, q) => segDist(v.ring[(q + 1) % v.ring.length], p, mx, mz) < 0.1));
    let off = Infinity;
    for (const [i, { seg, u, d }] of near) {
      if (!outlined[i] || JX.internal[i] || rankOf(edges[i].cls) < 2) continue;
      // (Where the road carries on as another piece, round the outside of
      // the bend between them is still its side.)
      if ((seg === 0 && u <= 0 && thruMate(i, edges[i].a) === undefined) || (seg === EP[i].length - 2 && u >= 1 && thruMate(i, edges[i].b) === undefined)) continue;
      const o = d - drawnHalf(i, seg, u);
      // (A little inside its edge too: where two roads overlap, one may be drawn a little narrower than its width says.)
      // (A road the outline lies on or inside first: along a divider's
      // kerb, 0.4 m in from one road's edge, the other road's edge lay
      // nearer, 0.4 m beyond the kerb across the divider, and its line
      // hooked over to that one.)
      const better = lined < 0 || (onDiv && (o <= 0.02) !== (lo <= 0.02) ? o <= 0.02 : Math.abs(o) < Math.abs(lo));
      if (o > -1 && o < 0.6 && better) (lined = i), (ls = seg), (lo = o);
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
    // (And round a nose's point, between the two roads' edge lines: it lies
    // up to 0.75 m out from either road's edge, in the middle of the wedge.)
    const nose = lined < 0 && !wedge && !thru && !island && kerb && lvl < 0 && onNose(mx, mz) && [...near].some(([i]) => rankOf(edges[i].cls) >= 2);
    // (A kerb runs wherever an edge line has ground beyond it: the outline
    // leaves a road's side only where another road leaves it.)
    if (!kerb && kerbAlong && ((lined >= 0 && (kerbedRoad(edges[lined]) || hasProfile[lined])) || wedge)) (kerb = true), (why += ' kept');
    why += ` lined ${lined} off ${off.toFixed(2)}${wedge ? ' wedge' : ''}${thru ? ' through' : ''}${island ? ' island' : ''}${nose ? ' nose' : ''}`;
    return { ...base, kerb, line: lined >= 0 || wedge || thru || island || nose, stop: false, why, lr: lined, ls };
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
  const outGridsOnce = () => {
    if (!outGrids) {
      outGrids = true;
      for (const c of crossings) for (const kk of new Set([tileKey(c.c[0] - 8, c.c[1] - 8), tileKey(c.c[0] + 8, c.c[1] - 8), tileKey(c.c[0] - 8, c.c[1] + 8), tileKey(c.c[0] + 8, c.c[1] + 8)])) (crossTiles.get(kk) ?? crossTiles.set(kk, []).get(kk)!).push(c);
      for (const bx of yBoxes) for (const kk of new Set(bx.ring.map((p) => tileKey(p[0], p[1])))) (boxTiles.get(kk) ?? boxTiles.set(kk, []).get(kk)!).push(bx);
    }
  };
  /** In a yellow box, or within pad of its edge? */
  const nearBox = (x: number, z: number, pad: number) => {
    outGridsOnce();
    return (boxTiles.get(tileKey(x, z)) ?? []).some((bx) => inRingXZ(bx.ring, x, z) || ringDist(bx.ring, x, z)[0] < pad);
  };
  const lineStops = (x: number, z: number) => {
    outGridsOnce();
    const k = tileKey(x, z);
    return (
      (crossTiles.get(k) ?? []).some((c) => {
        const vx = x - c.c[0], vz = z - c.c[1];
        return Math.abs(vx * c.t[0] + vz * c.t[1]) < CROSS_W / 2 + 0.2 && Math.abs(vx * c.t[1] - vz * c.t[0]) < c.half + 0.6;
      }) || (boxTiles.get(k) ?? []).some((bx) => inRingXZ(bx.ring, x, z))
    );
  };
  /** The drawn surface's height at (x, z), on the surface a mark's side bounds (cheap: no look round). */
  /**
   * Road o's surface at (x, z) as its strip is drawn (piece seg, u along):
   * on a road at the ground (tiltAt) its two edges are worked out at its own
   * points, and the surface runs straight between them, across and along.
   * (Worked out at the point itself, a mark on a ramp's foot lay up to 13 cm
   * under the strip and showed in parts.)
   */
  const topMemo = new Map<number, [number, number, number, number, number]>();
  const drawnTop = (o: number, seg: number, u: number, x: number, z: number) => {
    const P = EP[o], Y = deckY(o);
    const k1 = Math.min(P.length - 1, seg + 1);
    if (!(tiltAt(o, ECUM[o][seg]) > 0) && !(tiltAt(o, ECUM[o][k1]) > 0)) return lerp(Y[seg], Y[k1], u);
    const at = (k: number) => {
      // (Its two edge heights at point k, worked out once.)
      const key = o * 4096 + k;
      let e = topMemo.get(key);
      if (!e) {
        const tk = tiltAt(o, ECUM[o][k]);
        if (!(tk > 0)) e = [Y[k], Y[k], 0, 0, 0];
        else {
          const { nx, nz } = section(P, k, 0, P.length - 1);
          const h = drawnHalf(o, Math.min(k, P.length - 2), k === P.length - 1 ? 1 : 0);
          e = [Y[k] + tk * crossDrop(P[k][0] - nx * h, P[k][1] - nz * h, P[k][0], P[k][1]), Y[k] + tk * crossDrop(P[k][0] + nx * h, P[k][1] + nz * h, P[k][0], P[k][1]), nx, nz, h];
        }
        topMemo.set(key, e);
      }
      const [yl, yr, nx, nz, h] = e;
      if (!h) return yl;
      const off = Math.max(-h, Math.min(h, (x - P[k][0]) * nx + (z - P[k][1]) * nz));
      return lerp(yl, yr, (off / h + 1) / 2);
    };
    return lerp(at(seg), at(k1), u);
  };
  /**
   * Road o's surface at (x, z) exactly as its strip is drawn (on the ground):
   * its corners where the strip puts them, the surface flat across each of
   * the strip's two triangles between them. (A mark laid on the ground, or
   * straight along the road's line, lay under it wherever the ground dips
   * between the strip's corners.) Without the strip's lift.
   */
  const cornerMemo = new Map<number, [number, number, number, number, number, number]>();
  const stripTop = (o: number, x: number, z: number, from = 0, to = Infinity) => {
    const cut = cutOf(o);
    const P = cut.pts;
    const lo = cut.lo, hi = cut.hi;
    const dy = hasProfile[o] ? deckY(o) : null;
    const cum = ECUM[o];
    const join = joinOf(o);
    /** Point k's two corners [xl, zl, yl, xr, zr, yr]. */
    const corners = (k: number) => {
      const key = o * 4096 + k;
      let c = cornerMemo.get(key);
      if (c) return c;
      const { nx, nz, mm } = section(P, k, lo, hi, join);
      const half = halfAtE(o, k) * mm;
      const [px, pz] = P[k];
      const v: number[] = [];
      for (const sgn of [-1, 1]) {
        const cx = px + nx * sgn * half, cz = pz + nz * sgn * half;
        let yk = !dy ? NaN : k === lo && cut.ylo === cut.ylo ? cut.ylo : k === hi && cut.yhi === cut.yhi ? cut.yhi : dy[k];
        if (yk === yk && !elevated[o]) {
          const tk = tiltAt(o, cum[k]);
          if (tk > 0) yk = oneLine ? yk + tk * crossDrop(cx, cz, px, pz) : lerp(yk, Math.max(rawHeight(cx, cz), WL + 0.15) + relAlong(o, cum[k]), tk);
        }
        v.push(cx, cz, yk === yk ? yk : Math.max(rawHeight(cx, cz), WL + 0.15));
      }
      cornerMemo.set(key, (c = v as [number, number, number, number, number, number]));
      return c;
    };
    let best = Infinity, bk = Math.max(lo, Math.min(hi - 1, from));
    for (let k = Math.max(lo, from); k < Math.min(hi, to + 1); k++) {
      const d = segDist(P[k], P[k + 1], x, z);
      if (d < best) (best = d), (bk = k);
    }
    // (The strip's two triangles: left k, left k+1, right k; right k, left
    // k+1, right k+1. Each corner [x, z, y] read in place from the corners'
    // lists: asked tens of millions of times while the map is built, its
    // throwaway lists and objects made garbage that held frames up.)
    let found = false, tY = 0, tOut = Infinity;
    const plane = (p: number[], pi: number, q: number[], qi: number, r: number[], ri: number) => {
      const px = p[pi], pz = p[pi + 1], qx = q[qi], qz = q[qi + 1], rx = r[ri], rz = r[ri + 1];
      const d0 = (qz - rz) * (px - rx) + (rx - qx) * (pz - rz);
      if (Math.abs(d0) < 1e-9) return;
      const l1 = ((qz - rz) * (x - rx) + (rx - qx) * (z - rz)) / d0;
      const l2 = ((rz - pz) * (x - rx) + (px - rx) * (z - rz)) / d0;
      const out = Math.max(0, -l1, -l2, l1 + l2 - 1);
      if (!found || out < tOut) (found = true), (tOut = out), (tY = l1 * p[pi + 2] + l2 * q[qi + 2] + (1 - l1 - l2) * r[ri + 2]);
    };
    // (The piece nearest the point's line, or either beside it: at a bend
    // a point by the outside of it lies in the next piece's quad.)
    for (let c = 0; c < 3; c++) {
      const k = c === 0 ? bk : c === 1 ? bk - 1 : bk + 1;
      if (k < lo || k >= hi) continue;
      const A = corners(k), B = corners(k + 1);
      plane(A, 0, B, 0, A, 3);
      plane(A, 3, B, 0, B, 3);
      if (found && tOut === 0) break;
    }
    stripOut = found ? tOut : Infinity;
    if (found) return tY;
    const A = corners(bk);
    return lerp(A[2], A[5], 0.5);
  };
  /** How far outside the strip's nearest triangle the last stripTop's point lay (0 on it; in shares of the triangle). */
  let stripOut = 0;
  /**
   * The height a mark at (x, z) lies on. onTop (an edge line): on whatever
   * is drawn on top there, a joint's level pad or paving too. (Not a kerb:
   * its inner part lies under the asphalt, and lifted onto a pad beside the
   * road it showed through the road as a lump.)
   */
  const yOn = (m: OutMark, x: number, z: number, onTop = false) => {
    // (On the ground where no raised road is near: on the strips of the
    // roads there as they are drawn, straight between their corners, not
    // on the ground itself, which dips between them.)
    if (m.flat) {
      if (!onTop) return NaN;
      let y = NaN;
      roads.each(x, z, 12, (o, seg, u, d) => {
        if (!onLvl(o, seg, m.lvl) || !outlined[o] || JX.internal[o] || d > drawnHalf(o, seg, u) + 0.4) return;
        const h = stripTop(o, x, z, seg - 2, seg + 2);
        if (stripOut < 0.02 && (y !== y || h > y)) y = h;
      });
      // (And on a joint's pad where one lies there: round a pad the
      // outline takes in, past the roads' own strips, the line lay 4 cm
      // under it. A level pad at its level; one laid on the ground, on it.)
      for (const p of padsAt(x, z, 0.5)) if (y !== y || (p.y > y && p.y - y < 0.5)) y = p.y;
      if (y !== y && drapedPadAt(x, z, 0.5)) y = Math.max(rawHeight(x, z), WL + 0.15);
      return y;
    }
    /** Road o's drawn height at (x, z), by its nearest point among pieces lo..hi. */
    const at = (o: number, lo: number, hi: number) => {
      const h = stripTop(o, x, z, lo, hi);
      if (stripOut < 0.02) return h;
      // (Off its strip, past where it is cut back: as its nearest point has it.)
      const P = EP[o];
      let best = Infinity, bs = 0, bu = 0;
      for (let s = Math.max(0, lo); s <= Math.min(P.length - 2, hi); s++) {
        const vx = P[s + 1][0] - P[s][0], vz = P[s + 1][1] - P[s][1];
        const u = Math.max(0, Math.min(1, ((x - P[s][0]) * vx + (z - P[s][1]) * vz) / (vx * vx + vz * vz || 1)));
        const d = Math.hypot(P[s][0] + vx * u - x, P[s][1] + vz * u - z);
        if (d < best) (best = d), (bs = s), (bu = u);
      }
      return drawnTop(o, bs, bu, x, z);
    };
    // (Its own road's, a few pieces either side of where the side was asked;
    // or its junction's paving.)
    let y = m.joint >= 0 ? paveY(m.joint, x, z) : m.road >= 0 ? at(m.road, m.seg - 4, m.seg + 4) : NaN;
    // (Where raised pieces of the same level overlap, as a ramp leaves a
    // road, the one on top is what shows: the mark lies on it.)
    // (A road laid on the ground too, an edge line on its strip: where it
    // lies over the ground between its corners, or over the paving.)
    roads.each(x, z, 12, (o, seg, u, d) => {
      if ((o === m.road && m.joint < 0) || (!hasProfile[o] && !onTop) || JX.internal[o] || !onLvl(o, seg, m.lvl) || !outlined[o] || d > drawnHalf(o, seg, u) + 0.4) return;
      let h: number;
      if (hasProfile[o]) h = at(o, seg, seg);
      else {
        h = stripTop(o, x, z, seg - 1, seg + 1);
        if (stripOut >= 0.02) return;
      }
      if (y !== y || (h > y && h - y < (m.joint >= 0 ? 0.5 : 1.5))) y = h;
    });
    // (And where a joint's level pad reaches over the end of a climbing
    // road, a few cm above it: a line on the road went under the pad's
    // edge and showed as a step.)
    // (From just short of its edge: the height between two of the mark's
    // points runs straight, and the pad's edge lies between them.)
    if (y === y && onTop) for (const p of padsAt(x, z, 0.5)) if (p.y > y && p.y - y < 0.5) y = p.y;
    // (Or one laid on the ground, where it lies above the road's end.)
    if (y === y && onTop && drapedPadAt(x, z, 0.5)) {
      const g = Math.max(rawHeight(x, z), WL + 0.15);
      if (g > y && g - y < 0.5) y = g;
    }
    // (The same where a junction's paving of its level lies over the road's end.)
    if (y === y && onTop)
      for (const q of jointsNear(x, z)) {
        if (q === m.joint || (m.lvl < 0 ? jDeck(q) > 0 : jLvlM(q) !== m.lvl) || (ringDist(JPOLY[q].ring, x, z)[0] > 0.5 && !inRingXZ(JPOLY[q].ring, x, z))) continue;
        const h = paveY(q, x, z);
        if (h > y && h - y < 0.5) y = h;
      }
    // (And a nose's paving round its point, which lies over both roads'
    // edges: an edge line round it went under it.)
    if (y === y && onTop && oneLine)
      for (const id of goresNear(x, z)) {
        const bb = goreBox(id);
        if (x < bb[0] - 0.5 || x > bb[2] + 0.5 || z < bb[1] - 0.5 || z > bb[3] + 0.5) continue;
        for (const c of goreCaps(id)) {
          if (!inRingXZ(c.pave, x, z) && !c.nose.some((p, k) => k > 0 && segDist(c.nose[k - 1], p, x, z) < 0.5)) continue;
          // (In the roads' own frame, as y is: the nose is drawn 3 mm under
          // their drawn surface. Taken as drawn, the edge line round every
          // nose stood 9 cm up off it.)
          // (On its triangles as drawn, flat between their corners, where it
          // lies in them: on the roads' heights at the point itself, the
          // line along an eased side stood up to 7 cm off the long thin
          // triangles drawn under it.)
          // (Just outside them, as at the nearest point of the nose's edge:
          // the roads' heights at the point itself stood the line along an
          // eased side up to 7 cm over the road drawn there.)
          let t = goreTopAt(x, z, [id]);
          if (t !== t) {
            let best = Infinity, px = x, pz = z;
            for (let k = 1; k < c.nose.length; k++) {
              const A = c.nose[k - 1], B = c.nose[k], vx = B[0] - A[0], vz = B[1] - A[1];
              const u = Math.max(0, Math.min(1, ((x - A[0]) * vx + (z - A[1]) * vz) / (vx * vx + vz * vz || 1)));
              const dd = Math.hypot(A[0] + vx * u - x, A[1] + vz * u - z);
              if (dd < best) (best = dd), (px = A[0] + vx * u), (pz = A[1] + vz * u);
            }
            t = goreTopAt(px, pz, [id]);
            if (t !== t) t = c.yAt([px, pz]) + 0.087;
          }
          const h = t - ROAD_LIFT;
          if (h > y && h - y < 0.5) y = h;
        }
      }
    // (And a wedge's paving between two roads, where it lies over the line:
    // a wedge that stops where the two stand apart in height has no nose,
    // and the line round the island's point there runs over its last rows.)
    if (y === y && onTop && oneLine) {
      const g = goreTopAt(x, z) - ROAD_LIFT;
      if (g === g && g > y && g - y < 0.5) y = g;
    }
    // (And a fill of the outline's own, where it lies over the line.)
    if (y === y && onTop && fillTrisNow) {
      const h = fillAt(x, z, m.lvl) - ROAD_LIFT;
      if (h > y && h - y < 0.5) y = h;
    }
    return y;
  };
  // (A tile's outline is worked out over several build slices, each short:
  // first the outline itself, then its sides a share at a time, asked
  // every 4 m or so along each, then the kerbs and lines drawn.)
  type OutRing = { P: XZ[]; cum: number[]; n: number; drawn: boolean[]; corner: XZ[]; edge: number[]; at: number[]; samples: (OutMark | null)[][]; hole: boolean; lvl: number; kq?: boolean[] };
  // (Ground inside the outline that no piece paves (see outlineRings), or
  // a hole no kerb runs round: paved over, a few millimetres under the
  // roads about it.)
  /** The height a paving fill is laid at, at (x, z) of level lvl (without the road's lift; NaN: the ground's). */
  const fillY = (x: number, z: number, lvl: number) => {
    const near: Near = new Map([...nearRoads(x, z)].filter(([i, h]) => onLvl(i, h.seg, lvl)));
    let y = outlineY(x, z, near, lvl);
    // (As high as the surface drawn nearest it, the road's strip, a
    // joint's or a nose's paving, and a little under that: it shows only
    // where nothing else is drawn. Between two roads at different heights
    // the outline's own height, or the other road's, stood it over the
    // edge line laid on the nearer.)
    // (Where a lower road lies within 1.5 m, toward it by up to 10 cm: the
    // fill lies flat between its points, and an edge line round a nose
    // between two roads at different heights runs on from one's to the
    // other's over it.)
    let best = 0.6, low = Infinity;
    roads.each(x, z, 12, (o, seg, u, d) => {
      const out = d - drawnHalf(o, seg, u);
      if (JX.internal[o] || !onLvl(o, seg, lvl) || !outlined[o] || out > 1.5) return;
      // (Nor a road's strip where it is not drawn, inside its junction's
      // trim: by -2772.9,2246.5, 0.4 m over the paving drawn there, stood
      // the fill at a divider's end up as a dark wedge.)
      const at = ECUM[o][seg] + u * (ECUM[o][seg + 1] - ECUM[o][seg]);
      if (at < (JX.trimA[o] || 0) - 0.05 || at > ELEN[o] - (JX.trimB[o] || 0) + 0.05) return;
      const h = stripTop(o, x, z, seg - 1, seg + 1);
      if (h !== h) return;
      low = Math.min(low, h);
      if (out <= best) (best = out), (y = h);
    });
    for (const q of jointsNear(x, z)) {
      if (lvl < 0 ? jDeck(q) > 0 : jLvlM(q) !== lvl) continue;
      const out = inRingXZ(JPOLY[q].ring, x, z) ? 0 : ringDist(JPOLY[q].ring, x, z)[0];
      const h = out <= 1.5 ? paveY(q, x, z) : NaN;
      if (h !== h) continue;
      low = Math.min(low, h);
      if (out <= best) (best = out), (y = h);
    }
    const g = goreTopAt(x, z) - ROAD_LIFT;
    if (g === g && best > 0) y = g;
    if (y === y && low < y) y = Math.max(low, y - 0.1);
    return y;
  };
  /** A fill's triangles: its corners (and its holes'), each at its height as drawn. */
  const holeFillMesh = (ring: XZ[], lvl: number, holes: XZ[][] = []) => {
    // (Its corners as triangulateShape leaves them: it drops a ring's last
    // point where it repeats its first.)
    const C = ring.map(([x, z]) => new THREE.Vector2(x, z));
    const H = holes.map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
    const tris = THREE.ShapeUtils.triangulateShape(C, H);
    const pts = [...C, ...H.flat()].map(({ x, y: z }) => {
      const y = fillY(x, z, lvl);
      return [x, (y === y ? y : Math.max(rawHeight(x, z), WL + 0.15)) + ROAD_LIFT - 0.025, z] as [number, number, number];
    });
    return { pts, tris };
  };
  // (A raised road's deck, from its top to its edge beam's foot.)
  const DECK_DEPTH = 1.2;
  const holeFill = (road: Acc, ring: XZ[], lvl: number, inTile: (x: number, z: number) => boolean, holes: XZ[][] = [], deck?: Acc) => {
    if (ring.length < 3) return;
    let cx = 0, cz = 0;
    for (const p of ring) (cx += p[0]), (cz += p[1]);
    if (!inTile(cx / ring.length, cz / ring.length)) return;
    const { pts, tris } = holeFillMesh(ring, lvl, holes);
    const base = road.pos.length / 3;
    for (const [x, y, z] of pts) {
      road.pos.push(x, y, z);
      road.uv.push(x / 6, z / 6);
    }
    for (const [a, b, c] of tris) faceUp(road, base + a, base + b, base + c);
    // (Up off the ground as a deck is, an underside at its edge beam's
    // foot, as the roads' strips beside it have. The user's rule S4, 19
    // Nov: no slit or underside showing at a road's edge. Round a nose
    // between two decks the fill paving its bulge had none, and from the
    // road below the beam round it was a ring with the fill's dark
    // underside showing up inside it, at 1144.9,1934.)
    if (!deck) return;
    const up = pts.map(([x, y, z]) => y - groundY(x, z) > DECK_DEPTH + 0.05);
    const ub = deck.pos.length / 3;
    for (const [x, y, z] of pts) {
      deck.pos.push(x, y + 0.025 - ROAD_LIFT + 0.09 - DECK_DEPTH, z);
      deck.uv.push(x / 6, z / 6);
    }
    const D = deck.pos;
    for (const [a, b, c] of tris) {
      if (!(up[a] || up[b] || up[c])) continue;
      const [u, v, w] = [ub + a, ub + b, ub + c];
      const upw = (D[v * 3 + 2] - D[u * 3 + 2]) * (D[w * 3] - D[u * 3]) - (D[v * 3] - D[u * 3]) * (D[w * 3 + 2] - D[u * 3 + 2]) >= 0;
      deck.idx.push(u, upw ? w : v, upw ? v : w);
    }
  };
  /**
   * The fills of the tile whose lines are being laid (see yOn), their
   * triangles as drawn, by level: an edge line round an island's point
   * between two roads at different heights runs over a fill there, and
   * laid on the roads' own strips it went under it.
   */
  type V3 = [number, number, number];
  type FillTri = { t: [V3, V3, V3]; x0: number; z0: number; x1: number; z1: number };
  /** A fill ring, its triangles worked out the first time a line comes over it (each costs a height at every corner). */
  type FillRing = { r: ReturnType<typeof outlineRings>[number]; x0: number; z0: number; x1: number; z1: number; tris?: FillTri[] };
  let fillTrisNow: FillRing[] | null = null;
  const fillTrisOf = new Map<string, FillRing[]>();
  const fillTrisFor = (k: string, rings: ReturnType<typeof outlineRings>) => {
    let F = fillTrisOf.get(k);
    if (!F) {
      F = [];
      for (const r of rings) {
        if (!r.fill || r.corner.length < 3) continue;
        const xs = r.corner.map((p) => p[0]), zs = r.corner.map((p) => p[1]);
        F.push({ r, x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) });
      }
      fillTrisOf.set(k, F);
    }
    return F;
  };
  const fillTris = (f: FillRing) => {
    if (!f.tris) {
      f.tris = [];
      const { pts, tris } = holeFillMesh(f.r.corner, f.r.lvl, f.r.holes);
      for (const [a, b, c] of tris) {
        const t: [V3, V3, V3] = [pts[a], pts[b], pts[c]];
        f.tris.push({ t, x0: Math.min(t[0][0], t[1][0], t[2][0]), z0: Math.min(t[0][2], t[1][2], t[2][2]), x1: Math.max(t[0][0], t[1][0], t[2][0]), z1: Math.max(t[0][2], t[1][2], t[2][2]) });
      }
    }
    return f.tris;
  };
  /** The drawn height of a fill of level lvl at (x, z) among the tile's fills, or NaN. */
  const fillAt = (x: number, z: number, lvl: number) => {
    for (const g of fillTrisNow ?? []) {
      if (g.r.lvl !== lvl || x < g.x0 || x > g.x1 || z < g.z0 || z > g.z1) continue;
      for (const f of fillTris(g)) {
        if (x < f.x0 || x > f.x1 || z < f.z0 || z > f.z1) continue;
        const [[x1, y1, z1], [x2, y2, z2], [x3, y3, z3]] = f.t;
        const det = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3);
        if (Math.abs(det) < 1e-9) continue;
        const l1 = ((z2 - z3) * (x - x3) + (x3 - x2) * (z - z3)) / det, l2 = ((z3 - z1) * (x - x3) + (x1 - x3) * (z - z3)) / det, l3 = 1 - l1 - l2;
        if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) return l1 * y1 + l2 * y2 + l3 * y3;
      }
    }
    return NaN;
  };
  /**
   * Feedback 9, rule 2: an island is never lower than the road beside it.
   * Its lawn is laid from its kerbs' tops (see islandSheet), and where the
   * island widens past ISLE_W it falls away to the ground over ISLE_BANK m
   * from half of ISLE_W out from its kerbs. (The ground is held under the
   * roads, 21 cm under the road's drawn surface; an island between two
   * roads showed as a pit, the road's edge face showing into it.)
   */
  const ISLE_W = 12.5, ISLE_BANK = 1.5, KERB_OUT = 0.35;
  /**
   * How far under the kerb the ground beside it may lie for the island's
   * top to be lifted to it: past that a drop is the walls' business.
   * (Lifted on to 3.5 m deep, with banks up to 6 m wide, a bank ended where
   * the lifting did with an open face, a dark notch from above at
   * 1867.4,1818.2. Let down part way between 0.9 and 1.2 m, it stood as a
   * grass hump half up a wall's face there. A pit between raised roads, the
   * spike at -139.8,-57, is filled instead: see islandFill.)
   */
  const ISLE_DEEP = 1.2;
  /**
   * How far under the kerbs' tops the ground may lie under an island under
   * 3 m across between two roads at one level, its lawn spanning kerb to
   * kerb: an embankment's, short of a deck's (JOINT_DECK_FROM). Held to
   * ISLE_DEEP there, each side's lawn fell to the ground in the middle, a
   * trough a metre deep, dark from the road, at 1262.5,1902.9.
   */
  const NARROW_DEEP = 2;
  /** The outline's sides of each level in a tile, on a 4 m grid: [ax, az, bx, bz, lvl]. */
  const outSegs = (w: { rings: OutRing[]; segs?: Map<number, number[][]> }) => {
    if (w.segs) return w.segs;
    const g = new Map<number, number[][]>();
    for (const r of w.rings)
      for (let q = 1; q <= r.n; q++) {
        const a = r.P[q], b = r.P[q + 1];
        const sg = [a[0], a[1], b[0], b[1], r.lvl];
        for (let i = Math.floor(Math.min(a[0], b[0]) / 4); i <= Math.floor(Math.max(a[0], b[0]) / 4); i++)
          for (let j = Math.floor(Math.min(a[1], b[1]) / 4); j <= Math.floor(Math.max(a[1], b[1]) / 4); j++) (g.get(i * 100003 + j) ?? g.set(i * 100003 + j, []).get(i * 100003 + j)!).push(sg);
      }
    return (w.segs = g);
  };
  /** A stretch of kerb as drawn: its points on the outline, its outer edge, which way is out of the paving there, and its top. */
  type KerbRun = { lvl: number; I: XZ[]; E: XZ[]; N: XZ[]; T: number[] };
  /** How far from a kerb its top counts in the sheet's height (m), and how far past a tile's edge its kerbs are worked out for it. */
  const SHEET_R = ISLE_W, SHEET_M = SHEET_R + 1.5;
  /** How far past its tile the island sheet's height rule is worked out (a half metre off the grid: see islandSheet). */
  const SOLVE_M = 12.5;
  /** How far over the lawn another level's paving must stand for the lawn to run on under it (m): a deck's slab is 1.2 m deep. */
  const SHEET_CLEAR = 2.5;
  /**
   * The lawn of every island in a tile, one sheet to an island, on a 1 m
   * grid fixed to the world (the user's call, 22 Nov: built a stretch of
   * kerb at a time, by main's builder and by the one for rules B3 and
   * S1-S6, one island had both where it was level at one end and sloping
   * at the other, and they met in a crease or a patch in the grass, 466
   * places on that day's map, at -2730.2,-2485.8 a dark square). Its
   * height at any point is one rule, the same in every tile: the tops of
   * the kerbs about it, each as near as it is (a blend over all it can
   * see, each bit of kerb counted by how much of the view it fills over
   * how far off it is: between two kerbs, a straight slope from one's top
   * to the other's), never more than 1 in 2 under any lawn kerb's top it
   * can see, and level with it across to a lower kerb too close for that
   * slope (rule B3: the lower road a wall of its own up to the lawn), and
   * where it runs out past half of ISLE_W from every kerb, down to the
   * ground over ISLE_BANK. Where no kerb bounds it, at a road's edge with
   * no kerb or a path, it meets the ground; beside a raised road's kerb
   * over a drop, the ground at the foot of that road's own wall. Its light
   * comes from that rule's own slope, not its triangles': two tiles
   * meeting mid-island light it the same.
   */
  /** The ground at a kerb's outer edge, asked once: each tile within SHEET_M of a kerb asks again (a twentieth of the map's start). */
  // The lawn's colour at (x, z): the ground's at the points of its 4 m
  // lattice round it, as its mesh is coloured (see ensurePatch), and
  // between them. (Asked of the ground's plan at every point of the
  // island sheet's 1 m grid, 3.6 s of the trial map's start.)
  const latCol = new Map<number, [number, number, number]>();
  const lcTmp = new THREE.Color();
  const latColAt = (i: number, j: number) => {
    const k = i * 100003 + j;
    let c = latCol.get(k);
    if (!c) {
      const x = WB.minX + i * STEP, z = WB.minZ + j * STEP;
      rawHeight(x, z);
      colorAt(x, z, latAt(i, j), lcTmp);
      latCol.set(k, (c = [lcTmp.r, lcTmp.g, lcTmp.b]));
    }
    return c;
  };
  // (The last square's four corners kept: the lawn's points come square
  // by square, and looked up afresh each, the colours were a twentieth of
  // the lawn's time.)
  let lcI = NaN, lcJ = NaN, lcA: number[] = [], lcB: number[] = [], lcC: number[] = [], lcD: number[] = [];
  const lawnColour = (x: number, z: number, out: THREE.Color) => {
    const fx = (x - WB.minX) / STEP, fz = (z - WB.minZ) / STEP;
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    if (i !== lcI || j !== lcJ) (lcI = i), (lcJ = j), (lcA = latColAt(i, j)), (lcB = latColAt(i + 1, j)), (lcC = latColAt(i, j + 1)), (lcD = latColAt(i + 1, j + 1));
    const a = lcA, b = lcB, c = lcC, d = lcD, iu = 1 - u, iv = 1 - v;
    return out.setRGB((a[0] * iu + b[0] * u) * iv + (c[0] * iu + d[0] * u) * v, (a[1] * iu + b[1] * u) * iv + (c[1] * iu + d[1] * u) * v, (a[2] * iu + b[2] * u) * iv + (c[2] * iu + d[2] * u) * v);
  };
  const kerbGround = new Map<number, number>();
  const groundAtKerb = (x: number, z: number) => {
    const key = (Math.round(x * 1000) + 5e6) * 1e7 + (Math.round(z * 1000) + 5e6);
    let g = kerbGround.get(key);
    // (The ground as drawn, its lattice's: what shows beside the kerb.)
    if (g === undefined) kerbGround.set(key, (g = groundY(x, z)));
    return g;
  };
  /** Each tile border's island sheet heights, by level, side and corner, once worked out: see islandSheet. */
  const borderKept = new Map<string, Float64Array>();
  function* islandSheet(ix: number, iz: number, w: { rings: OutRing[]; segs?: Map<number, number[][]>; kerbRuns?: KerbRun[]; all?: { pts: XZ[]; hole: boolean; lvl: number }[] }, lawn: Acc, side: Acc): Generator<void, void, void> {
    const KR = w.kerbRuns ?? [];
    if (!KR.length) return;
    let slice = performance.now();
    const pause = () => performance.now() - slice > 4;
    /** A pause, the slice begun again after it: `if (pause()) yield* rest();` between steps. (Whole, a step of the sheet held a frame up for up to a third of a second.) */
    const rest = function* () {
      yield;
      slice = performance.now();
    };
    const X0 = ix * TILE, Z0 = iz * TILE, X1 = X0 + TILE, Z1 = Z0 + TILE;
    const near = (x: number, z: number, m: number) => x > X0 - m && x < X1 + m && z > Z0 - m && z < Z1 + m;
    const gnd = (x: number, z: number) => Math.max(groundY(x, z), islandFill(x, z, true));
    const segs = outSegs(w);
    const REACH = ISLE_W / 2 + ISLE_BANK;
    const S_ = OUT_S;
    const toPath = (pts: XZ[]) => {
      const p = new Path64();
      for (const [x, z] of pts) p.push(new Point64(Math.round(x * S_), Math.round(z * S_)));
      return p;
    };
    const many = (...L: Path64[][]) => {
      const P = new Paths64();
      for (const l of L) for (const q of l) if (q.length >= 2) P.push(q);
      return P;
    };
    const col = new THREE.Color();
    for (const lvl of [...new Set(KR.map((r) => r.lvl))]) {
      // The kerbs' tops and the ground's edges, as samples: x, z, value, out x, out z, length, lawn (1) or ground (0).
      const S: number[] = [];
      const SG = 4;
      const sgrid = new Map<number, number[]>();
      // (Kind: 2 a lawn kerb, 1 a kerb over a drop, 0 the ground. Hold:
      // how far a lawn kerb holds the lawn level with its top before it
      // may fall 1 in 2.)
      const addS = (x: number, z: number, v: number, nx: number, nz: number, len: number, kind: number) => {
        if (!(v === v) || !near(x, z, SHEET_M)) return;
        const n = S.length;
        S.push(x, z, v, nx, nz, len, kind, 0);
        const c = Math.floor(x / SG) * 100003 + Math.floor(z / SG);
        (sgrid.get(c) ?? sgrid.set(c, []).get(c)!).push(n);
      };
      /** The lawn kerbs' outer edges: [ax, az, ta, bx, bz, tb, nx, nz, run, piece] by 2 m square, for the sheet's edge along them. */
      const EG = 2;
      const edges: number[][] = [];
      const egrid = new Map<number, number[]>();
      const lawnLines = new Paths64();
      const bands = new Paths64();
      // A gap shared with another level: a kerb of this level and, across
      // from it within 6 m, facing it, one of another level within a metre
      // of its height (two raised roads side by side, each its own
      // structure). No lawn there: each road its own wall down to the
      // ground between, rule B3, as on main. (Each laid its own lawn, as
      // from a kerb over a drop, down to the ground: it sloped 3 m from
      // one kerb to the other, both at 8.6 m, and the two lawns crossed,
      // -2847.4,-2075; 274 such places on the whole map. Laid level across
      // by one of the two, the other's kerbs on the same line, of a third
      // level, laid theirs too.) Within 6 m: a kerb's partner is then
      // always among the kerbs this tile knows (SHEET_M), so two tiles
      // judge it alike.
      const oP: number[] = [];
      const oGrid = new Map<number, number[]>();
      // (And its pieces, each two points of one run: [a, b] by their places
      // in oP, by 4 m square.)
      const oSeg: number[] = [];
      const sGrid = new Map<number, number[]>();
      for (const r of KR) {
        if (r.lvl === lvl) continue;
        let prev = -1;
        for (let j = 0; j < r.E.length; j++) {
          const t = r.T[j];
          if (!(t === t)) {
            prev = -1;
            continue;
          }
          const [x, z] = r.E[j], nl = Math.hypot(r.N[j][0], r.N[j][1]) || 1, c = Math.floor(x / 4) * 100003 + Math.floor(z / 4);
          (oGrid.get(c) ?? oGrid.set(c, []).get(c)!).push(oP.length);
          if (prev >= 0) {
            const [px, pz] = [oP[prev], oP[prev + 1]], si = oSeg.length;
            oSeg.push(prev, oP.length);
            for (let ci = Math.floor(Math.min(px, x) / 4); ci <= Math.floor(Math.max(px, x) / 4); ci++)
              for (let cj = Math.floor(Math.min(pz, z) / 4); cj <= Math.floor(Math.max(pz, z) / 4); cj++) (sGrid.get(ci * 100003 + cj) ?? sGrid.set(ci * 100003 + cj, []).get(ci * 100003 + cj)!).push(si);
          }
          prev = oP.length;
          oP.push(x, z, t, r.N[j][0] / nl, r.N[j][1] / nl, r.lvl);
        }
      }
      /** Across from a kerb point (x, z) facing (nx, nz), its top t: another level's kerb point within 6 m, as above (its place in oP), or -1. */
      const across = (x: number, z: number, nx: number, nz: number, t: number) => {
        let best = 6.0001, got = -1;
        const ex0 = x + nx * 6, ez0 = z + nz * 6;
        for (let ci = Math.floor((Math.min(x, ex0) - 2) / 4); ci <= Math.floor((Math.max(x, ex0) + 2) / 4); ci++)
          for (let cj = Math.floor((Math.min(z, ez0) - 2) / 4); cj <= Math.floor((Math.max(z, ez0) + 2) / 4); cj++) {
            // (Not a square whose middle lies further from the line out than half its diagonal and the width.)
            const mx = (ci + 0.5) * 4 - x, mz = (cj + 0.5) * 4 - z, al = mx * nx + mz * nz;
            if (Math.max(-al, al - 6, Math.abs(mx * nz - mz * nx) - 1.66) > 4 * 0.7072) continue;
            for (const m of oGrid.get(ci * 100003 + cj) ?? []) {
              if (Math.abs(oP[m + 2] - t) >= 1 || oP[m + 3] * nx + oP[m + 4] * nz > -0.3) continue;
              const ex = oP[m] - x, ez = oP[m + 1] - z, al = ex * nx + ez * nz;
              if (al < 0.02 || al >= best || Math.abs(ex * nz - ez * nx) > 0.75 + 0.15 * al) continue;
              best = al;
              got = m;
            }
          }
        return got;
      };
      // (A gap shared with another level over ground a little under the
      // kerbs, a median between two roads of different structures at one
      // height: the lower level's lawn, laid level to the other's kerb, its
      // top taken as a kerb over a drop's; the other level leaves it. Left
      // to neither, the ground showed in squares between the lawns,
      // -3398.9,2598.4. Over ground deeper than ISLE_DEEP at this kerb, or
      // than 60 cm at the other's (deeper there, the lawn hung over the
      // ground falling away at an embankment's end, -2847.2,-2072.6, and
      // stood up steep beside it, -2716.9,-2239.6), or with the two kerbs'
      // tops more than 15 cm apart, the walls' gap as before, rule B3: taken
      // between two ramps 70 cm apart in height, the lawn's edge hung over
      // the lower one's paving, 1834.4,1932.9.) Asked at a place, of the
      // other kerb's line straight across, not of its points: each tile
      // has the kerbs' points of its own (a run's ends and its half-metre
      // points by a joint fall where its own pieces put them), and asked of
      // the nearest point and of the points next to it along the run, the
      // two tiles took different stretches, and the lawn stepped 3 cm at
      // their border, -3400.4,2600.
      /** Straight across from (x, z) facing (nx, nz), its top t: the first other level's kerb line facing it within 6 m, as [x, z, top, out x, out z, level], or null. */
      const hit: number[] = [0, 0, 0, 0, 0, 0];
      const acrossLine = (x: number, z: number, nx: number, nz: number, t: number) => {
        let best = 6.0001, got = false;
        const ex0 = x + nx * 6, ez0 = z + nz * 6;
        for (let ci = Math.floor(Math.min(x, ex0) / 4); ci <= Math.floor(Math.max(x, ex0) / 4); ci++)
          for (let cj = Math.floor(Math.min(z, ez0) / 4); cj <= Math.floor(Math.max(z, ez0) / 4); cj++)
            for (const si of sGrid.get(ci * 100003 + cj) ?? []) {
              const a = oSeg[si], b = oSeg[si + 1];
              const ax = oP[a], az = oP[a + 1], dx = oP[b] - ax, dz = oP[b + 1] - az;
              const den = nx * dz - nz * dx;
              if (Math.abs(den) < 1e-9) continue;
              // (x + s n = a + u (b - a).)
              const qx = ax - x, qz = az - z, sA = (qx * dz - qz * dx) / den, u = (qx * nz - qz * nx) / den;
              if (u < -1e-6 || u > 1 + 1e-6 || sA < 0.02 || sA >= best) continue;
              const fx = lerp(oP[a + 3], oP[b + 3], u), fz = lerp(oP[a + 4], oP[b + 4], u), ft = lerp(oP[a + 2], oP[b + 2], u);
              if (Math.abs(ft - t) >= 1 || fx * nx + fz * nz > -0.3 * (Math.hypot(fx, fz) || 1)) continue;
              best = sA;
              got = true;
              const fl = Math.hypot(fx, fz) || 1;
              hit[0] = x + nx * sA, hit[1] = z + nz * sA, hit[2] = ft, hit[3] = fx / fl, hit[4] = fz / fl, hit[5] = oP[a + 5];
            }
        return got;
      };
      /** Whether this level's lawn takes the gap straight across from (x, z), as above; the other kerb's place in `hit`. */
      const takesAt = (x: number, z: number, nx: number, nz: number, t: number) => {
        if (!acrossLine(x, z, nx, nz, t) || hit[5] < lvl || Math.abs(hit[2] - t) > 0.15) return false;
        const g = groundAtKerb(x, z), g2 = groundAtKerb(hit[0], hit[1]);
        return g <= t + 0.005 && g >= t - ISLE_DEEP && g2 <= hit[2] + 0.005 && g2 >= hit[2] - 0.6;
      };
      // (Each of this level's kerb points so asked, and taken only along a
      // stretch of 3 m or more of points all taken: a shorter one stays the
      // walls' gap. Taken alone, a point's top stood the lawn up in a spike
      // 1.7 m over the ground beside it, -3219.8,-1917.3; along 2 m where
      // two kerbs' tops, one rising and one falling, crossed, the lawn ran
      // out over the lower road, -2715.6,-2242.6. On across a run's end, in
      // the run that carries on from it: a tile ends its runs where its own
      // pieces do.)
      const tk = new Map<number, boolean[]>();
      const ends = new Map<string, [number, number][]>();
      const endKey = (p: XZ) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;
      for (const [ri, r] of KR.entries()) {
        if (r.lvl !== lvl || r.E.length < 2) continue;
        tk.set(
          ri,
          r.E.map(([x, z], j) => {
            const t = r.T[j], nl = Math.hypot(r.N[j][0], r.N[j][1]) || 1;
            return t === t && takesAt(x, z, r.N[j][0] / nl, r.N[j][1] / nl, t);
          }),
        );
        const n = r.E.length;
        (ends.get(endKey(r.E[0])) ?? ends.set(endKey(r.E[0]), []).get(endKey(r.E[0]))!).push([ri, 0]);
        (ends.get(endKey(r.E[n - 1])) ?? ends.set(endKey(r.E[n - 1]), []).get(endKey(r.E[n - 1]))!).push([ri, n - 1]);
      }
      /** The point next to run ri's point j, the way d (1 or -1) along the kerb, as [run, point], or null. */
      const step = (ri: number, j: number, d: number): [number, number] | null => {
        const n = tk.get(ri)!.length;
        if (j + d >= 0 && j + d < n) return [ri, j + d];
        for (const [o, q] of ends.get(endKey(KR[ri].E[j])) ?? []) {
          if (o === ri) continue;
          const m = tk.get(o)!.length;
          // (The run that carries on: it starts where this one ends, or ends where this one starts.)
          if (d > 0 && q === 0 && m > 1) return [o, 1];
          if (d < 0 && q === m - 1 && m > 1) return [o, m - 2];
        }
        return null;
      };
      /** How far along the kerb the points all taken run on from run ri's point j, either way, up to 3 m. */
      const takenLen = (ri: number, j: number) => {
        let len = 0;
        for (const d of [-1, 1]) {
          let at: [number, number] = [ri, j];
          for (let guard = 0; guard < 64 && len < 3; guard++) {
            const nx = step(at[0], at[1], d);
            if (!nx || !tk.get(nx[0])![nx[1]]) break;
            const [ax, az] = KR[at[0]].E[at[1]], [bx, bz] = KR[nx[0]].E[nx[1]];
            len += Math.hypot(bx - ax, bz - az);
            at = nx;
          }
        }
        return len;
      };
      // (This level's own kerbs' pieces, by 4 m square: see sameAcross.)
      const mSeg: number[] = [];
      const mGrid = new Map<number, number[]>();
      for (const r of KR) {
        if (r.lvl !== lvl) continue;
        for (let j = 0; j + 1 < r.E.length; j++) {
          if (!(r.T[j] === r.T[j]) || !(r.T[j + 1] === r.T[j + 1])) continue;
          const [ax, az] = r.E[j], [bx, bz] = r.E[j + 1], si = mSeg.length;
          const al = Math.hypot(r.N[j][0], r.N[j][1]) || 1, bl = Math.hypot(r.N[j + 1][0], r.N[j + 1][1]) || 1;
          mSeg.push(ax, az, r.T[j], r.N[j][0] / al, r.N[j][1] / al, bx, bz, r.T[j + 1], r.N[j + 1][0] / bl, r.N[j + 1][1] / bl);
          for (let ci = Math.floor(Math.min(ax, bx) / 4); ci <= Math.floor(Math.max(ax, bx) / 4); ci++)
            for (let cj = Math.floor(Math.min(az, bz) / 4); cj <= Math.floor(Math.max(az, bz) / 4); cj++) (mGrid.get(ci * 100003 + cj) ?? mGrid.set(ci * 100003 + cj, []).get(ci * 100003 + cj)!).push(si);
        }
      }
      /** Straight across from (x, z) facing (nx, nz), its top t: how far to the first of this level's own kerbs facing it at its height (within 15 cm), up to m; Infinity if none. */
      const sameAcross = (x: number, z: number, nx: number, nz: number, t: number, m: number) => {
        let best = Infinity;
        const ex0 = x + nx * m, ez0 = z + nz * m;
        for (let ci = Math.floor(Math.min(x, ex0) / 4); ci <= Math.floor(Math.max(x, ex0) / 4); ci++)
          for (let cj = Math.floor(Math.min(z, ez0) / 4); cj <= Math.floor(Math.max(z, ez0) / 4); cj++)
            for (const si of mGrid.get(ci * 100003 + cj) ?? []) {
              const ax = mSeg[si], az = mSeg[si + 1], dx = mSeg[si + 5] - ax, dz = mSeg[si + 6] - az;
              const den = nx * dz - nz * dx;
              if (Math.abs(den) < 1e-9) continue;
              const qx = ax - x, qz = az - z, sA = (qx * dz - qz * dx) / den, u = (qx * nz - qz * nx) / den;
              if (u < -1e-6 || u > 1 + 1e-6 || sA < 0.1 || sA > m || sA >= best) continue;
              const fx = lerp(mSeg[si + 3], mSeg[si + 8], u), fz = lerp(mSeg[si + 4], mSeg[si + 9], u);
              if (Math.abs(lerp(mSeg[si + 2], mSeg[si + 7], u) - t) > 0.15 || fx * nx + fz * nz > -0.3 * (Math.hypot(fx, fz) || 1)) continue;
              best = sA;
            }
        return best;
      };
      const farGrid = new Map<number, number[]>();
      const farPts: number[] = [];
      for (const [ri, r] of KR.entries()) {
        if (r.lvl !== lvl) continue;
        const n = r.E.length;
        if (n < 2) continue;
        bands.push(toPath([...r.I, ...r.E.slice().reverse()]));
        const T = tk.get(ri)!;
        const far = T.map((v, j) => v && takenLen(ri, j) >= 3);
        const share = r.E.map(([x, z], j) => {
          const t = r.T[j], nl = Math.hypot(r.N[j][0], r.N[j][1]) || 1;
          if (!(t === t) || far[j]) return -1;
          return across(x, z, r.N[j][0] / nl, r.N[j][1] / nl, t);
        });
        // (Its top along the kerb every half metre, between two points both
        // taken: only at its points, a few metres apart on a straight, the
        // lawn's edge fell to the ground between them, in teeth,
        // -3398.9,2598.4. Run on to a neighbour whose gap stays the walls',
        // the lawn's edge stood at the kerb's top there with nothing under
        // it, 3080.2,3159.)
        for (let j = 0; j + 1 < n; j++) {
          // (Where it ends, the walls' gap begins: the other kerb's wall foot
          // there, from the last point taken to the next, as this kerb's own
          // below. With nothing there, the lawn ran on at the other kerb's
          // top and stood up its wall in a point, -3404,2605.)
          if (far[j] !== far[j + 1] && (share[j] >= 0 || share[j + 1] >= 0)) {
            const [ax, az] = r.E[j], [bx, bz] = r.E[j + 1];
            const L = Math.hypot(bx - ax, bz - az);
            if (L < 1e-4 || L > 12) continue;
            const k = Math.max(1, Math.ceil(L / 0.5));
            for (let q = 1; q < k; q++) {
              const u = q / k, nx0 = lerp(r.N[j][0], r.N[j + 1][0], u), nz0 = lerp(r.N[j][1], r.N[j + 1][1], u), nl = Math.hypot(nx0, nz0) || 1;
              const t = lerp(r.T[j], r.T[j + 1], u);
              if (!(t === t) || !acrossLine(lerp(ax, bx, u), lerp(az, bz, u), nx0 / nl, nz0 / nl, t) || hit[5] < lvl || Math.abs(hit[2] - t) > 0.15) continue;
              addS(hit[0] + hit[3] * 0.05, hit[1] + hit[4] * 0.05, gnd(hit[0] + hit[3] * 0.1, hit[1] + hit[4] * 0.1) + 0.02, hit[3], hit[4], L / k, 0);
            }
            continue;
          }
          if (!far[j] || !far[j + 1]) continue;
          const ta = r.T[j], tb = r.T[j + 1];
          const [ax, az] = r.E[j], [bx, bz] = r.E[j + 1];
          const L = Math.hypot(bx - ax, bz - az);
          if (L < 1e-4 || L > 12) continue;
          const k = Math.max(1, Math.ceil(L / 0.5));
          for (let q = 0; q <= k; q++) {
            const u = q / k, nx0 = lerp(r.N[j][0], r.N[j + 1][0], u), nz0 = lerp(r.N[j][1], r.N[j + 1][1], u), nl = Math.hypot(nx0, nz0) || 1;
            const t = lerp(ta, tb, u);
            if (!acrossLine(lerp(ax, bx, u), lerp(az, bz, u), nx0 / nl, nz0 / nl, t) || hit[5] < lvl || Math.abs(hit[2] - t) > 0.15) continue;
            const c = Math.floor(hit[0] / 4) * 100003 + Math.floor(hit[1] / 4);
            (farGrid.get(c) ?? farGrid.set(c, []).get(c)!).push(farPts.length);
            farPts.push(hit[0], hit[1]);
            addS(hit[0], hit[1], hit[2], hit[3], hit[4], L / k, 1);
          }
        }
        // (A kerb with the ground beside it a little under its top: the
        // lawn's. Over a drop deeper than ISLE_DEEP, or with the ground
        // over it, the ground's: the walls' business, see wallGaps. Across
        // a gap shared with another level, not the lawn's.)
        const lawnAt = r.E.map(([x, z], j) => {
          const g = groundAtKerb(x, z), t = r.T[j];
          return share[j] < 0 && t === t && g <= t + 0.005 && g >= t - ISLE_DEEP;
        });
        // (Over a drop deeper than ISLE_DEEP with another of this level's
        // kerbs facing it 2.5-8 m across, at its height: two raised roads
        // side by side, each its own structure, each its own wall down to
        // the ground between, rule B3, as on main; the lawn meets the walls'
        // foot. Laid at the kerbs' tops, over ground falling 2.6 m under
        // them, the lawn sagged between the two walls and climbed them in
        // ears where it met the ground's lawn, -3408.4,2608 (3.3-3.6 m
        // across). Nearer, one structure's median, level with its kerbs,
        // as the narrow island 0.3-2.1 m across at 1138.9,1930.7 is on
        // main. With no such kerb within 8 m, an island's
        // wide part, laid level as before: lowered, pale squares of the
        // ground showed through its lawn at 1146,1928.)
        const deepAt = r.E.map(([x, z], j) => {
          if (!(r.T[j] === r.T[j]) || groundAtKerb(x, z) >= r.T[j] - ISLE_DEEP) return false;
          const nl = Math.hypot(r.N[j][0], r.N[j][1]) || 1;
          const w = sameAcross(x, z, r.N[j][0] / nl, r.N[j][1] / nl, r.T[j], 8);
          return w > 2.5 && w <= 8;
        });
        // (And the gap itself off this level's lawn.)
        for (let j = 0; j + 1 < n; j++) {
          const a = share[j], b = share[j + 1];
          if (a >= 0 && b >= 0) bands.push(toPath([r.E[j], r.E[j + 1], [oP[b], oP[b + 1]], [oP[a], oP[a + 1]]]));
        }
        // (Steadied along the kerb: a stretch of either kind under 2 m
        // between two of the other takes theirs, gaps first. Asked point by
        // point of the ground beside a road, held down under its edge, it
        // flickered, and the lawn's edge ran in teeth between a kerb's top
        // and the ground far under it, 1809.3,1979.3.)
        {
          const cum = [0];
          for (let j = 1; j < n; j++) cum.push(cum[j - 1] + Math.hypot(r.E[j][0] - r.E[j - 1][0], r.E[j][1] - r.E[j - 1][1]));
          for (const want of [false, true]) {
            for (let j = 0; j < n; ) {
              if (lawnAt[j] !== want) {
                j++;
                continue;
              }
              let k = j;
              while (k + 1 < n && lawnAt[k + 1] === want) k++;
              if (j > 0 && k < n - 1 && cum[k + 1] - cum[j - 1] < 2) for (let q = j; q <= k; q++) lawnAt[q] = !want;
              j = k + 1;
            }
          }
        }
        let line: XZ[] = [];
        const flush = () => {
          if (line.length >= 2) lawnLines.push(toPath(line));
          line = [];
        };
        for (let j = 0; j + 1 < n; j++) {
          const [ax, az] = r.E[j], [bx, bz] = r.E[j + 1];
          const L = Math.hypot(bx - ax, bz - az);
          const both = lawnAt[j] && lawnAt[j + 1];
          if (both) {
            if (!line.length) line.push(r.E[j]);
            line.push(r.E[j + 1]);
            const e = edges.length;
            const nx = (r.N[j][0] + r.N[j + 1][0]) / 2, nz = (r.N[j][1] + r.N[j + 1][1]) / 2;
            edges.push([ax, az, r.T[j], bx, bz, r.T[j + 1], nx, nz, ri, j]);
            for (let gx = Math.floor((Math.min(ax, bx) - 0.01) / EG); gx <= Math.floor((Math.max(ax, bx) + 0.01) / EG); gx++)
              for (let gz = Math.floor((Math.min(az, bz) - 0.01) / EG); gz <= Math.floor((Math.max(az, bz) + 0.01) / EG); gz++) (egrid.get(gx * 100003 + gz) ?? egrid.set(gx * 100003 + gz, []).get(gx * 100003 + gz)!).push(e);
          } else flush();
          if (L < 1e-4) continue;
          const m = Math.max(1, Math.ceil(L));
          for (let q = 0; q < m; q++) {
            const t = (q + 0.5) / m;
            const x = lerp(ax, bx, t), z = lerp(az, bz, t);
            const nx = lerp(r.N[j][0], r.N[j + 1][0], t), nz = lerp(r.N[j][1], r.N[j + 1][1], t), nl = Math.hypot(nx, nz) || 1;
            // (Every kerb by its top, over a drop too: the lawn between two
            // raised roads' kerbs, the ground under it far down, lies level
            // with them, as main's did. Taken there as the ground's, it fell
            // and rose between them, 1.5 m in a metre, at 1147,1926.)
            // (But a kerb whose gap with another level's is the walls', each
            // road its own wall down to the ground (rule B3), its wall's foot:
            // the lawn meets the wall there. At its top, where a median two
            // levels share ends, the lawn stood up the wall in a point,
            // -3404,2605.)
            if (!both && (share[j] >= 0 || share[j + 1] >= 0 || deepAt[j] || deepAt[j + 1])) {
              const ux = nx / nl, uz = nz / nl;
              addS(x + ux * 0.05, z + uz * 0.05, gnd(x + ux * 0.1, z + uz * 0.1) + 0.02, ux, uz, L / m, 0);
            } else addS(x, z, lerp(r.T[j], r.T[j + 1], t), nx / nl, nz / nl, L / m, both ? 2 : 1);
          }
        }
        flush();
        if (pause()) {
          yield;
          slice = performance.now();
        }
      }
      /** Within r of another level's kerb whose gap this level's lawn takes: the lawn meets its top there, not the ground. */
      const nearFar = (x: number, z: number, r: number) => {
        for (let ci = Math.floor((x - r) / 4); ci <= Math.floor((x + r) / 4); ci++)
          for (let cj = Math.floor((z - r) / 4); cj <= Math.floor((z + r) / 4); cj++)
            for (const m of farGrid.get(ci * 100003 + cj) ?? []) if (Math.hypot(farPts[m] - x, farPts[m + 1] - z) < r) return true;
        return false;
      };
      if (!lawnLines.length) continue;
      // (The outline's sides with no kerb: the lawn meets the ground there.)
      for (const R of w.rings) {
        if (R.lvl !== lvl || !R.kq) continue;
        for (let q = 0; q < R.n; q++) {
          if (R.kq[q]) continue;
          const [ax, az] = R.P[q + 1], [bx, bz] = R.P[q + 2];
          const L = Math.hypot(bx - ax, bz - az);
          if (L < 1e-4 || !near((ax + bx) / 2, (az + bz) / 2, SHEET_M)) continue;
          const nx = -(bz - az) / L, nz = (bx - ax) / L;
          const m = Math.max(1, Math.ceil(L));
          for (let c = 0; c < m; c++) {
            const t = (c + 0.5) / m, x = lerp(ax, bx, t) + nx * 0.05, z = lerp(az, bz, t) + nz * 0.05;
            // (Not along another level's kerb whose gap this lawn takes: its
            // top there, and the ground's between its points stood the lawn's
            // edge in teeth, -3398.9,2598.4.)
            if (farGrid.size && nearFar(x, z, 1)) continue;
            addS(x, z, gnd(x + nx * 0.05, z + nz * 0.05) + 0.02, nx, nz, L / m, 0);
          }
        }
      }
      // (Nor over a path: it lies on the ground. The lawn meets the ground at its edges.)
      const pathStrips = new Paths64();
      // (Only its pieces over the square the rule is worked out over, and
      // its edges' samples only within the lawn's reach of a lawn kerb: a
      // path runs on for a kilometre, and asked of the ground along all of
      // it and cut out whole for each tile, it took a second of the trial
      // map's start.)
      // (Its edges' samples only near a lawn kerb's edge: the lawn meets it nowhere else.)
      const nearLawn = (ax: number, az: number, bx: number, bz: number, r: number) => {
        for (let ci = Math.floor((Math.min(ax, bx) - r) / EG); ci <= Math.floor((Math.max(ax, bx) + r) / EG); ci++)
          for (let cj = Math.floor((Math.min(az, bz) - r) / EG); cj <= Math.floor((Math.max(az, bz) + r) / EG); cj++)
            for (const e of egrid.get(ci * 100003 + cj) ?? []) {
              const E = edges[e];
              for (const [px, pz] of [[E[0], E[1]], [E[3], E[4]], [(E[0] + E[3]) / 2, (E[1] + E[4]) / 2]]) {
                const qx = bx - ax, qz = bz - az, L2 = qx * qx + qz * qz;
                const u = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * qx + (pz - az) * qz) / L2)) : 0;
                if ((ax + qx * u - px) ** 2 + (az + qz * u - pz) ** 2 < r * r) return true;
              }
            }
        return false;
      };
      const byHalf = new Map<number, Paths64>();
      if (lvl < 0)
        for (let i = 0; i < paths.length; i++) {
          const p = paths[i];
          const pts = p.pts;
          if (!pts.some(([x, z]) => near(x, z, SHEET_M + 4))) continue;
          // (A footbridge too, where it lies on the ground or a hand's
          // breadth over it: its ends on the banks. Passed by whole, the lawn
          // was laid over a footbridge's approach beside a canal,
          // -822.8,-633.5. Not where it stands clear over the lawn.)
          const deck = p.b ? pathDeck(i) : null;
          const h = PHALF[i] + 0.05;
          let piece: XZ[] = [];
          const flush = () => {
            if (piece.length >= 2) (byHalf.get(h) ?? byHalf.set(h, new Paths64()).get(h)!).push(toPath(piece));
            piece = [];
          };
          for (let k = 0; k + 1 < pts.length; k++) {
            const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
            const L = Math.hypot(bx - ax, bz - az);
            if (deck && ((deck[k] === deck[k] && deck[k] > gnd(ax, az) + 1) || (deck[k + 1] === deck[k + 1] && deck[k + 1] > gnd(bx, bz) + 1))) {
              flush();
              continue;
            }
            // (Cut out wherever it crosses the square the rule is worked out
            // over, near a lawn kerb or not: cut only near one, a path's
            // piece ended in its round end where a kerb further on was not
            // this tile's to know, and the next tile's lawn stopped at the
            // border where this one's ran on, 1153,1600.)
            if (Math.max(ax, bx) < X0 - SOLVE_M - h - 1 || Math.min(ax, bx) > X1 + SOLVE_M + h + 1 || Math.max(az, bz) < Z0 - SOLVE_M - h - 1 || Math.min(az, bz) > Z1 + SOLVE_M + h + 1) {
              flush();
              continue;
            }
            if (!piece.length) piece.push(pts[k]);
            piece.push(pts[k + 1]);
            if (L < 1e-4 || !nearLawn(ax, az, bx, bz, REACH + h + 1)) continue;
            const ux = (bx - ax) / L, uz = (bz - az) / L;
            const m = Math.max(1, Math.ceil(L));
            for (let c = 0; c < m; c++) {
              const t = (c + 0.5) / m, x = lerp(ax, bx, t), z = lerp(az, bz, t);
              for (const sd of [1, -1]) {
                const nx = -uz * sd, nz = ux * sd, px = x + nx * h, pz = z + nz * h;
                if (near(px, pz, SHEET_M)) addS(px, pz, gnd(px, pz) + 0.02, nx, nz, L / m, 0);
              }
            }
          }
          flush();
          if (pause()) yield* rest();
        }
      // (The clipper widens an open line by half the width it is given, each
      // side: so twice h. Rounded at its bends: so the strip is all within h
      // of the path's line, however a tile cut the line, see clipfix.)
      // (Its rounds to a centimetre: to the clipper's own fineness, under a
      // millimetre, every bend and end took dozens of points.)
      for (const [h, P] of byHalf) {
        const co = new ClipperOffset(2, 0.01 * S_);
        co.addPaths(P, JoinType.Round, EndType.Round);
        const out = new Paths64();
        co.execute(2 * h * S_, out);
        for (const q of out) pathStrips.push(q);
        if (pause()) yield* rest();
      }
      const rect = (x0: number, z0: number, x1: number, z1: number) => many([toPath([[x0, z0], [x1, z0], [x1, z1], [x0, z1]])]);
      const clip = (P: Paths64, x0: number, z0: number, x1: number, z1: number) => Clipper.Intersect(P, rect(x0, z0, x1, z1), FillRule.NonZero);
      /**
       * Each ring's parts on one side of a line along x (or z) = m: its runs
       * on that side, each joined to the next along the line as the ring's
       * inside lies there (the crossings, in order along the line, pair off
       * in and out). A point on the line counts as below it. Where the
       * pairing fails, the clipper's.
       */
      const split = (P: Paths64, alongX: boolean, m: number, below: boolean, x0: number, z0: number, x1: number, z1: number) => {
        const out = new Paths64();
        const c = (q: { x: number; y: number }) => (alongX ? q.x : q.y);
        const u = (q: { x: number; y: number }) => (alongX ? q.y : q.x);
        const keep = (q: { x: number; y: number }) => (below ? c(q) <= m : c(q) > m);
        type Q = { x: number; y: number };
        const at = (a: Q, b: Q): Q => {
          // (The same point from either side, from the edge's ends in order.)
          if (c(a) === m) return a;
          if (c(b) === m) return b;
          const [p, r] = c(a) < c(b) ? [a, b] : [b, a];
          const t = Math.round(u(p) + ((u(r) - u(p)) * (m - c(p))) / (c(r) - c(p)));
          return alongX ? new Point64(m, t) : new Point64(t, m);
        };
        for (const ring of P) {
          const n = ring.length;
          let k0 = -1;
          for (let q = 0; q < n; q++) if (!keep(ring[q])) { k0 = q; break; }
          if (k0 < 0) {
            out.push(ring);
            continue;
          }
          // Runs kept: [in point, points..., out point].
          const runs: Q[][] = [];
          let cur: Q[] | null = null;
          for (let s = 0; s < n; s++) {
            const a = ring[(k0 + s) % n], b = ring[(k0 + s + 1) % n];
            const ka = keep(a), kb = keep(b);
            if (!ka && kb) cur = [at(a, b)];
            if (kb && cur) cur.push(b);
            if (ka && !kb && cur) {
              cur.push(at(a, b));
              runs.push(cur);
              cur = null;
            }
          }
          if (!runs.length) continue;
          // The crossings along the line, paired.
          const ends: [number, number, boolean][] = [];
          runs.forEach((r, i) => {
            ends.push([u(r[0]), i, true], [u(r[r.length - 1]), i, false]);
          });
          ends.sort((p, q) => p[0] - q[0] || (p[2] === q[2] ? 0 : p[2] ? 1 : -1));
          const nextRun = new Map<number, number>();
          let ok = ends.length % 2 === 0;
          for (let q = 0; ok && q < ends.length; q += 2) {
            const [, ia, ina] = ends[q], [, ib, inb] = ends[q + 1];
            if (ina === inb) ok = false;
            else if (ina) nextRun.set(ib, ia);
            else nextRun.set(ia, ib);
          }
          if (!ok || nextRun.size !== runs.length) {
            // (Wound as it was: a hole's ring cut by the clipper came back wound as a piece.)
            const back = Clipper.area(ring) < 0;
            for (const q of clip(many([back ? ring.slice().reverse() : ring]), x0, z0, x1, z1)) out.push(back ? q.slice().reverse() : q);
            continue;
          }
          const used = new Set<number>();
          for (let i = 0; i < runs.length; i++) {
            if (used.has(i)) continue;
            const o = new Path64();
            let j = i;
            while (!used.has(j)) {
              used.add(j);
              for (const q of runs[j]) {
                const l = o[o.length - 1];
                if (!l || l.x !== q.x || l.y !== q.y) o.push(new Point64(q.x, q.y));
              }
              j = nextRun.get(j)!;
            }
            while (o.length > 1 && o[0].x === o[o.length - 1].x && o[0].y === o[o.length - 1].y) o.pop();
            if (o.length >= 3 && Math.abs(Clipper.area(o)) >= 1) out.push(o);
          }
        }
        return out;
      };
      // Where it is laid: within REACH of a lawn kerb, in the tile, off the paving, the kerbs and the paths.
      yield;
      slice = performance.now();
      const pave = new Paths64(), holes = new Paths64();
      for (const r of w.all ?? []) if (r.lvl === lvl) (r.hole ? holes : pave).push(toPath(r.pts));
      // (Nor on another level's paving, but where it stands clear over the
      // lawn, a flyover over an island: a ramp beside a road on a bank, its
      // paving another level's, had the lawn laid on under it, at its
      // slab's foot and under the ground beside it, 1797,1465.4. Clear by
      // the highest kerb of this level within 12 m, or the ground there,
      // where its reach ends: the lawn is nowhere higher than its edges.
      // Each piece of road and each joint's paving by its own height, the
      // level's outline cut to those low enough.)
      // (Whether a lawn kerb is near, from 4 m squares: asked sample by
      // sample, of every piece of road in reach and every point round each
      // joint, it held a frame up for a third of a second.)
      const otherRings = new Paths64(), lowRings = new Paths64();
      {
        for (const r of w.all ?? []) if (r.lvl !== lvl && !r.hole && r.pts.some(([x, z]) => near(x, z, SOLVE_M + 40))) otherRings.push(toPath(r.pts));
        // (Its kerbs too: past the paving's edge, over its slab's edge, 1827,1927.)
        for (const r of KR) if (r.lvl !== lvl && r.E.length >= 2) otherRings.push(toPath([...r.I, ...r.E.slice().reverse()]));
        if (otherRings.length) {
          const cellLawn = new Set<number>();
          for (let n = 0; n < S.length; n += 8) if (S[n + 6] === 2) cellLawn.add(Math.floor(S[n] / SG) * 100003 + Math.floor(S[n + 1] / SG));
          const cells = (x: number, z: number, r: number, f: (c: number) => void) => {
            for (let ci = Math.floor((x - r) / SG); ci <= Math.floor((x + r) / SG); ci++)
              for (let cj = Math.floor((z - r) / SG); cj <= Math.floor((z + r) / SG); cj++) f(ci * 100003 + cj);
          };
          const lawnNear = (x: number, z: number, r: number) => {
            let hit = false;
            cells(x, z, r, (c) => (hit ||= cellLawn.has(c)));
            return hit;
          };
          /**
           * The highest of the ground at (x, z) and this level's kerb tops
           * within 12 m (its roads' heights, a kerb up): the lawn there is no
           * higher. (From the roads themselves, the same in every tile. From
           * this tile's own lawn edges, a piece of road reaching past them
           * was judged low by one tile and clear by the next, and the lawn
           * ended at their border: 63 places on the whole map.)
           */
          // (Kept by the point itself: road pieces share their ends.)
          const refMemo = new Map<number, Map<number, number>>();
          const refAt = (x: number, z: number) => {
            const row = refMemo.get(x) ?? refMemo.set(x, new Map()).get(x)!;
            const got = row.get(z);
            if (got !== undefined) return got;
            let m = gnd(x, z) + 0.02;
            roads.each(x, z, 12 + 16, (i, seg, u, d) => {
              if (seg + 1 >= EP[i].length || lvlOf(i, seg) !== lvl || d >= 12 + Math.max(drawnHalf(i, seg, 0), drawnHalf(i, seg, 1))) return;
              const [ax, az] = EP[i][seg], [bx, bz] = EP[i][seg + 1];
              const y = (hasProfile[i] ? lerp(deckAtHit(i, seg, 0), deckAtHit(i, seg, 1), u) : dropAt(lerp(ax, bx, u), lerp(az, bz, u))) + 0.2;
              if (y > m) m = y;
            });
            row.set(z, m);
            return m;
          };
          const pieces: [number, number][] = [];
          const seen = new Set<number>();
          roads.each((X0 + X1) / 2, (Z0 + Z1) / 2, (TILE / 2) * Math.SQRT2 + SOLVE_M + 2, (i, seg) => {
            const key = i * 65536 + seg;
            if (seen.has(key) || seg + 1 >= EP[i].length || lvlOf(i, seg) === lvl) return;
            seen.add(key);
            pieces.push([i, seg]);
          });
          for (let q = 0; q < pieces.length; q++) {
            const [i, seg] = pieces[q];
            const [ax, az] = EP[i][seg], [bx, bz] = EP[i][seg + 1];
            const L = Math.hypot(bx - ax, bz - az);
            if (L < 1e-6) continue;
            const mx = (ax + bx) / 2, mz = (az + bz) / 2, h = Math.max(drawnHalf(i, seg, 0), drawnHalf(i, seg, 1)) + 1;
            // (None where no lawn kerb is within the lawn's reach of it.)
            if (!lawnNear(mx, mz, L / 2 + h + REACH + 1)) continue;
            const ref = Math.max(refAt(ax, az), refAt(bx, bz), refAt(mx, mz));
            const ya = hasProfile[i] ? deckAtHit(i, seg, 0) : dropAt(ax, az), yb = hasProfile[i] ? deckAtHit(i, seg, 1) : dropAt(bx, bz);
            if (Math.min(ya, yb) - ref >= SHEET_CLEAR) continue;
            const ux = (bx - ax) / L, uz = (bz - az) / L;
            lowRings.push(toPath([[ax - ux - uz * h, az - uz + ux * h], [bx + ux - uz * h, bz + uz + ux * h], [bx + ux + uz * h, bz + uz - ux * h], [ax - ux + uz * h, az - uz - ux * h]]));
            if ((q & 63) === 0 && pause()) {
              yield;
              slice = performance.now();
            }
          }
          for (let ci = Math.floor((X0 - SOLVE_M - 64) / JCELL); ci <= Math.floor((X1 + SOLVE_M + 64) / JCELL); ci++)
            for (let cj = Math.floor((Z0 - SOLVE_M - 64) / JCELL); cj <= Math.floor((Z1 + SOLVE_M + 64) / JCELL); cj++)
              for (const q of jGrid.get(ci * 100003 + cj) ?? []) {
                if (seen.has(-1 - q)) continue;
                seen.add(-1 - q);
                const J = JPOLY[q];
                if ((jDeck(q) === 0 ? -1 : jLvlM(q)) === lvl || !near(J.centre[0], J.centre[1], SOLVE_M + J.radius + 1)) continue;
                if (!lawnNear(J.centre[0], J.centre[1], J.radius + REACH + 1)) continue;
                // (Its paving's height and the lawn's round its edge, at 16 points at most.)
                const st = Math.max(1, Math.floor(J.ring.length / 16));
                let top = Infinity, ref = refAt(J.centre[0], J.centre[1]);
                for (let k = 0; k < J.ring.length; k += st) (top = Math.min(top, jTop(q, J.ring[k][0], J.ring[k][1]))), (ref = Math.max(ref, refAt(J.ring[k][0], J.ring[k][1])));
                if (top - ref >= SHEET_CLEAR) continue;
                const co = new ClipperOffset(2, 0.05 * S_);
                co.addPaths(many([toPath(J.ring)]), JoinType.Round, EndType.Polygon);
                // (Into a list of its own: the clipper empties the one it is given.)
                const out = new Paths64();
                co.execute(1 * S_, out);
                for (const p of out) lowRings.push(p);
                if (pause()) {
                  yield;
                  slice = performance.now();
                }
              }
        }
      }
      // (Its rounds to 5 cm: to the clipper's own fineness, a millimetre, a
      // tile's reach had 2,000 points and its cutting took seconds. Where
      // it ends the lawn lies on the ground, see F.)
      const reach = new Paths64();
      {
        const co = new ClipperOffset(2, 0.05 * S_);
        // (Rounded at its bends, as the paths: within REACH of a kerb is a
        // matter of distance only, the same in every tile. Mitred, a kerb
        // cut into lines differently by two tiles reached 8.2 m in one,
        // 7.75 in the other, and the lawn ended at the border, 1800,2192.5.)
        // (Its lines to a centimetre first: round a nose a kerb has a point
        // every 3 cm, and widened 8 m every one of them crossed dozens of
        // others' on the inside of the bend, a second of the trial map's
        // start; the reach's own rounds are to 5 cm.)
        co.addPaths(simplifyLines(lawnLines, 0.01 * S_), JoinType.Round, EndType.Round);
        // (Twice REACH: the clipper widens an open line by half each side.
        // Given REACH, the lawn reached only half as far from its kerbs,
        // and footpaths were cut out half their width, the lawn over the
        // rest, 1871,1855.)
        co.execute(2 * REACH * S_, reach);
      }
      if (pause()) yield* rest();
      const tileR = many([toPath([[X0, Z0], [X1, Z0], [X1, Z1], [X0, Z1]])]);
      // (Cut into strips 25 m wide, each worked out alone and the pieces
      // joined again: the clipper's time goes as the number of sides a
      // line across the whole lot crosses, and over the whole square that
      // was a third of the sheet's time.)
      const QX0 = X0 - SOLVE_M, QX1 = X1 + SOLVE_M, QZ0 = Z0 - SOLVE_M, QZ1 = Z1 + SOLVE_M, FAR = 1e5;
      const NSTRIP = Math.ceil((QX1 - QX0) / 25 - 1e-9), SW = (QX1 - QX0) / NSTRIP;
      const inSq = (P: Paths64) => split(split(P, false, QZ0 * S_, false, -FAR, QZ0, FAR, FAR), false, QZ1 * S_, true, -FAR, QZ0, FAR, QZ1);
      const band = (P: Paths64, xa: number, xb: number) => split(split(P, true, xa * S_, false, xa, -FAR, FAR, FAR), true, xb * S_, true, -FAR, -FAR, xb, FAR);
      const reachQ = inSq(reach), paveQ = inSq(pave), holesQ = inSq(holes), bandsQ = inSq(bands), psQ = inSq(pathStrips), otherQ = lowRings.length ? inSq(otherRings) : new Paths64(), lowQ = lowRings.length ? inSq(Clipper.Union(lowRings, undefined, FillRule.NonZero)) : new Paths64();
      if (pause()) yield* rest();
      const crumbless = (P: Paths64) => P.filter((p) => Math.abs(Clipper.area(p)) >= 1e-4 * S_ * S_);
      const parts = new Paths64();
      for (let k = 0; k < NSTRIP; k++) {
        const xa = QX0 + k * SW, xb = k === NSTRIP - 1 ? QX1 : QX0 + (k + 1) * SW;
        // (Each worked out 5 cm past its sides, and cut to them after: the
        // narrowing and widening below reach 2 cm.)
        const ea = k === 0 ? xa : xa - 0.05, eb = k === NSTRIP - 1 ? xb : xb + 0.05;
        const reachK = band(reachQ, ea, eb);
        if (!reachK.length) continue;
        // (Each part of it wound the one way: a kerb's band wound against the
        // paving under it cancelled it out, and the lawn was laid over a
        // path there, 1871,1855.)
        const offK = many(Clipper.Difference(Clipper.Union(band(paveQ, ea, eb), undefined, FillRule.NonZero), Clipper.Union(band(holesQ, ea, eb), undefined, FillRule.NonZero), FillRule.NonZero), Clipper.Union(band(bandsQ, ea, eb), undefined, FillRule.NonZero), band(psQ, ea, eb), lowQ.length ? Clipper.Intersect(band(otherQ, ea, eb), band(lowQ, ea, eb), FillRule.NonZero) : new Paths64());
        // (Less its crumbs, rings of under a square centimetre: the clipper
        // takes the way the lowest ring winds for the way they all do, and
        // a crumb of three points in a line wound the other way, lowest of
        // all; narrowed, the tile's lawn came back as none, 633.6,200.)
        const rawK = crumbless(Clipper.Difference(reachK, offK, FillRule.NonZero));
        // (Opened by a centimetre: a kerb's outer edge and the paving's beside
        // it a millimetre apart left a strip of lawn that thin between them,
        // its two sides 30 cm apart in height, standing upright, at 353,1960.)
        // (Both times from rings wound the right way only, outer rings first: the
        // clipper widens or narrows them all by the way the lowest of them
        // winds, and a sliver of 3 square centimetres wound backwards along
        // the square's side, lowest of all, turned the narrowing round and
        // a whole strip's lawn was lost, the next tile's ending at their
        // border: 63 places on the whole map, -719.2,-400.)
        const sure = (P: Paths64) => {
          const U = Clipper.Union(P, undefined, FillRule.Positive);
          return many(U.filter((p) => Clipper.area(p) > 0), U.filter((p) => Clipper.area(p) <= 0));
        };
        const openK = Clipper.InflatePaths(sure(crumbless(Clipper.InflatePaths(sure(rawK), -0.01 * S_, JoinType.Miter, EndType.Polygon))), 0.01 * S_, JoinType.Miter, EndType.Polygon);
        for (const q of band(openK, xa, xb)) parts.push(q);
        if (pause()) yield* rest();
      }
      // (The strips joined again, and its points no closer than 5 mm to the
      // line through those either side: round a nose the kerb is in pieces
      // of 3 cm, and a piece of lawn between three such points, a sliver,
      // stood up on end with the smallest wave in their heights.)
      // (Our own: the clipper's takes a ring for a line from its first point
      // to its last, and where those two stood side by side it dropped the
      // whole ring, 1,436 square metres of lawn in one tile and not the
      // next, 1358.7,2000.)
      const domain = simplifyRings(crumbless(Clipper.Union(parts, undefined, FillRule.NonZero)), 0.005 * S_);
      if (pause()) yield* rest();
      const region = Clipper.Intersect(domain, tileR, FillRule.NonZero);
      yield;
      slice = performance.now();
      if (!region.length) continue;
      // The height rule.
      // (The outline's sides of this level by 4 m square, flat: looked up
      // for every pair of points the rule weighs.)
      const lsegs = new Map<number, Float64Array>();
      for (const [key, L] of segs) {
        const o = L.filter((sg) => sg[4] === lvl);
        if (!o.length) continue;
        const f = new Float64Array(o.length * 4);
        o.forEach((sg, i) => f.set([sg[0], sg[1], sg[2], sg[3]], i * 4));
        lsegs.set(key, f);
      }
      const vis = (ax: number, az: number, bx: number, bz: number) => {
        // (Along the 4 m squares the line passes: does it cross the outline of this level?)
        const dx = bx - ax, dz = bz - az;
        let cx = Math.floor(ax / 4), cz = Math.floor(az / 4);
        const ex = Math.floor(bx / 4), ez = Math.floor(bz / 4);
        const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
        const tdx = dx !== 0 ? Math.abs(4 / dx) : Infinity, tdz = dz !== 0 ? Math.abs(4 / dz) : Infinity;
        let tx = dx !== 0 ? ((dx > 0 ? (cx + 1) * 4 - ax : ax - cx * 4) / Math.abs(dx)) : Infinity;
        let tz = dz !== 0 ? ((dz > 0 ? (cz + 1) * 4 - az : az - cz * 4) / Math.abs(dz)) : Infinity;
        for (let guard = 0; guard < 64; guard++) {
          const sg = lsegs.get(cx * 100003 + cz);
          if (sg)
            for (let i = 0; i < sg.length; i += 4) {
              const qx = sg[i + 2] - sg[i], qz = sg[i + 3] - sg[i + 1];
              const den = dx * qz - dz * qx;
              if (Math.abs(den) < 1e-12) continue;
              const rx = sg[i] - ax, rz = sg[i + 1] - az;
              const t = (rx * qz - rz * qx) / den, u = (rx * dz - rz * dx) / den;
              if (t > 1e-6 && t < 1 - 1e-6 && u >= 0 && u <= 1) return false;
            }
          if (cx === ex && cz === ez) break;
          if (tx < tz) (cx += sx), (tx += tdx);
          else (cz += sz), (tz += tdz);
          if (Math.min(tx - tdx, tz - tdz) > 1) break;
        }
        return true;
      };
      // A kerb over a drop, by what lies across from it. The far side
      // within a metre of its own height (a raised island between two
      // raised roads): the lawn runs evenly across to it from its top.
      // Lower: the lawn keeps to the ground, up to this kerb's own wall,
      // rule B3, as main's did (2.8 m between a raised road's kerb and
      // one 5.4 m lower at 1147,1934; 7.5 m under a 6 m wall at
      // 1857.5,1822). Eased between, over a metre.
      const top0 = new Map<number, number>(), lawn0 = new Set<number>();
      /** Each kerb over a drop's part of its top (1) or of the ground (0), worked out below; NaN where nothing lies across from it. */
      const svOf = new Map<number, number>();
      for (let n = 0; n < S.length; n += 8) {
        if (S[n + 6]) top0.set(n, S[n + 2]);
        if (S[n + 6] === 2) lawn0.add(n);
      }
      for (let n = 0; n < S.length; n += 8) {
        if ((n & 127) === 0 && pause()) yield* rest();
        if (!S[n + 6]) continue;
        const x = S[n], z = S[n + 1], nx = S[n + 3], nz = S[n + 4];
        let best = Infinity, tf = NaN, fk = false;
        // (Only the squares about the line out along its normal, where what
        // lies across from it can be: every square within SHEET_R of it
        // asked, a twentieth of the sheet's time.)
        const ex0 = x + nx * SHEET_R, ez0 = z + nz * SHEET_R, wl = 0.75 + 0.15 * SHEET_R + 0.01;
        for (let ci = Math.floor((Math.min(x, ex0) - wl) / SG); ci <= Math.floor((Math.max(x, ex0) + wl) / SG); ci++)
          for (let cj = Math.floor((Math.min(z, ez0) - wl) / SG); cj <= Math.floor((Math.max(z, ez0) + wl) / SG); cj++) {
            // (The square's distance from the line, by its middle: past half its diagonal and the width, none of it near.)
            const mx = (ci + 0.5) * SG - x, mz = (cj + 0.5) * SG - z, al = mx * nx + mz * nz;
            const cl = Math.max(-al, al - SHEET_R, Math.abs(mx * nz - mz * nx) - wl);
            if (cl > SG * 0.7072) continue;
            for (const m of sgrid.get(ci * 100003 + cj) ?? []) {
              if (m === n || S[m + 3] * nx + S[m + 4] * nz > -0.3) continue;
              const ex = S[m] - x, ez = S[m + 1] - z, al = ex * nx + ez * nz;
              if (al < 0.02 || al >= best || al > SHEET_R || Math.abs(ex * nz - ez * nx) > 0.75 + 0.15 * al) continue;
              if (!vis(x + nx * 0.01, z + nz * 0.01, S[m] + S[m + 3] * 0.01, S[m + 1] + S[m + 4] * 0.01)) continue;
              best = al;
              tf = top0.get(m) ?? S[m + 2];
              fk = lawn0.has(m);
            }
          }
        const d = S[n + 2] - tf;
        if (S[n + 6] === 2) {
          // (A lawn kerb under a higher lawn kerb too close for a 1 in 2 bank
          // up to it: the lawn's edge here lifted to the higher's top, so
          // the lawn is held level across, the lower road its own wall up to
          // it, rule B3; the lawn's edges are what the rule runs between, see
          // below. Sloped there 1 in 2 instead, a strip 10 to 30 cm wide
          // between a slip road's kerb and the road beside it was turned
          // from the light, dark, at 1335,571.6.)
          if (d < 0 && fk) S[n + 2] = lerp(S[n + 2], tf, smoothstep(-2 * d + 1.1, -2 * d + 0.1, best));
          continue;
        }
        svOf.set(n, d === d ? smoothstep(1.5, 0.5, d) : NaN);
      }
      // (Where nothing lies across from it, as its neighbours along the
      // kerb within 1.5 m have it: at the round point of a narrow island's
      // nose one point faces out along the island, nothing across, and
      // taken as the ground's it pulled the lawn of the whole nose down to
      // the ground under it, 1.5 m under its kerbs, 1132.5,1932.6.)
      for (const [n, v] of svOf) {
        let sv = v;
        if (!(sv === sv)) {
          sv = 0;
          const x = S[n], z = S[n + 1];
          for (let ci = Math.floor((x - 1.5) / SG); ci <= Math.floor((x + 1.5) / SG); ci++)
            for (let cj = Math.floor((z - 1.5) / SG); cj <= Math.floor((z + 1.5) / SG); cj++)
              for (const m of sgrid.get(ci * 100003 + cj) ?? []) {
                const u = S[m + 6] === 2 ? 1 : svOf.get(m);
                if (u !== undefined && u === u && u > sv && (S[m] - x) ** 2 + (S[m + 1] - z) ** 2 < 2.25) sv = u;
              }
        }
        S[n + 2] = lerp(gnd(S[n] + S[n + 3] * 0.05, S[n + 1] + S[n + 4] * 0.05) + 0.02, S[n + 2], sv);
        if (sv <= 0) S[n + 6] = 0;
      }
      const NONE: number[] = [];
      // The height rule: the lawn is the smoothest sheet that meets each of
      // its edges at that edge's own height, a kerb's top, or the ground's
      // where it meets the ground. At each point of a 1 m grid fixed to the
      // world it is the mean of its four neighbours, an edge standing in for
      // a neighbour beyond it at its own distance (a harmonic sheet, by
      // Shortley and Weller's stencil). So it runs evenly across between
      // two kerbs, lies level between two at one height, and has no bump,
      // fold or step inside, nor any point higher or lower than its edges.
      // (Weighed from every kerb in sight, the lawn rose in a bullseye by
      // each kerb's point and creased where a kerb came into sight or went
      // out of it: 24,065 folds on the map, scalloped banks at
      // -2730.2,-2485.8.) Worked out over the tile and SOLVE_M beyond it,
      // where the next tile works it out too: the two meet within a
      // centimetre or so at the border.
      /**
       * A lawn kerb's edge at height y at (x, z), no more than 1 in 2 over
       * where the lawn meets the ground or a drop: a path's edge, the
       * outline's with no kerb, a drop's wall foot. Where a kerb ends on the
       * ground, or a path runs a hand's width from it, the lawn's edge comes
       * down along the kerb, the kerb's own side over it, as a kerb ramps
       * down. (Stepped there, the lawn stood upright at the kerb's end,
       * 1167,1665.2.) From each such edge's own height, not theirs
       * together: the lowest ramp up from any of them, unbroken along the
       * kerb. Out to 6 m: a lawn kerb meeting a drop's wall foot up to 3 m
       * down. Over another lawn kerb's top too, one more than a metre
       * lower: two of one level's kerbs a metre apart, 4 m apart in height,
       * stood the lawn up between them in a fin, 1568,923; now the lawn
       * eases up from the lower at 1 in 2, the higher kerb's own side over
       * it. (Kerbs nearer in height, the lawn sloping between them as
       * before.)
       */
      // (Each square's lowest edge sample off a lawn kerb, and its longest
      // half: a square that can't bring the cap down is passed by. Asked of
      // every sample within 6 m, the cap was a tenth of the sheet's time.)
      const capLow = new Map<number, [number, number]>();
      const capAt = (x: number, z: number, y: number) => {
        let cap = y;
        for (let ci = Math.floor((x - 6) / SG); ci <= Math.floor((x + 6) / SG); ci++)
          for (let cj = Math.floor((z - 6) / SG); cj <= Math.floor((z + 6) / SG); cj++) {
            const c = ci * 100003 + cj;
            let lo = capLow.get(c);
            if (!lo) {
              let m = Infinity, h = 0;
              for (const n of sgrid.get(c) ?? NONE) (m = Math.min(m, S[n + 2])), (h = Math.max(h, S[n + 5] / 2));
              capLow.set(c, (lo = [m, h]));
            }
            if (lo[0] >= cap) continue;
            const bx = Math.max(0, ci * SG - x, x - (ci + 1) * SG), bz = Math.max(0, cj * SG - z, z - (cj + 1) * SG);
            const bd = Math.max(0, Math.sqrt(bx * bx + bz * bz) - lo[1] - 1e-6);
            if (bd >= 6 || lo[0] + 0.5 * bd >= cap) continue;
            for (const n of sgrid.get(c) ?? NONE) {
              if (S[n + 2] >= cap || (S[n + 6] === 2 && S[n + 2] > y - 1)) continue;
              const tx = -S[n + 4], tz = S[n + 3], hl = S[n + 5] / 2;
              const al = Math.max(-hl, Math.min(hl, (x - S[n]) * tx + (z - S[n + 1]) * tz));
              const dd = Math.hypot(x - S[n] - tx * al, z - S[n + 1] - tz * al);
              if (dd < 6) cap = Math.min(cap, S[n + 2] + 0.5 * dd);
            }
          }
        return cap;
      };
      /** The height of an edge of the lawn at (x, z): a lawn kerb's top (lifted by rule B3), a drop's kerb's, or the ground's. */
      const edgeRaw = (x: number, z: number) => {
        // (Within 2 cm of one: the lawn's edge along a kerb, or where the
        // grid's lines cross it, a hair off it.)
        let eb = 0.02 * 0.02, ta = NaN, tb = NaN, u = 0;
        for (const e of egrid.get(Math.floor(x / EG) * 100003 + Math.floor(z / EG)) ?? NONE) {
          const [ax, az, a0, bx, bz, b0] = edges[e];
          const qx = bx - ax, qz = bz - az, L2 = qx * qx + qz * qz;
          const ue = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * qx + (z - az) * qz) / L2)) : 0;
          const ox = ax + qx * ue - x, oz = az + qz * ue - z;
          if (ox * ox + oz * oz >= eb) continue;
          (eb = ox * ox + oz * oz), (ta = a0), (tb = b0), (u = ue);
        }
        if (ta === ta) {
          // (Lifted as its samples are, by rule B3, eased along it as below.)
          let sw = 0, sv = 0;
          for (let ci = Math.floor((x - 0.75) / SG); ci <= Math.floor((x + 0.75) / SG); ci++)
            for (let cj = Math.floor((z - 0.75) / SG); cj <= Math.floor((z + 0.75) / SG); cj++)
              for (const n of sgrid.get(ci * 100003 + cj) ?? NONE) {
                if (S[n + 6] !== 2) continue;
                const dd = Math.sqrt((x - S[n]) ** 2 + (z - S[n + 1]) ** 2);
                if (dd >= 0.75) continue;
                const wt = S[n + 5] * (1 - dd / 0.75) ** 2;
                sw += wt;
                sv += wt * (S[n + 2] - top0.get(n)!);
              }
          const y = lerp(ta, tb, u) + (sw > 0 ? sv / sw : 0);
          // (Eased down no further than the ground there, the lawn being
          // laid over it: a kerb's edge eased 1 in 2 towards lower edges a
          // few metres off, where the ground itself fell less, lay a metre
          // under the ground 3 cm from the grid's next point, held on the
          // ground: a fold, 1868,1860.5. Never over its own height: lifted
          // to the ground wherever it lay under it, the lawn stood out over
          // a road beside a kerb in a cutting, 1827,1926.9.)
          return Math.max(capAt(x, z, y), Math.min(y, gnd(x, z) + 0.02));
        }
        // (Else, off a lawn kerb: the ground's or a drop's edge, as its
        // samples within 75 cm have it, each weighed by its length and
        // nearness, even along the edge. None so near: the end of the
        // lawn's reach, on the ground.)
        // (Where the nearest is a lawn kerb's, off its edge, as round a
        // nose's paved point: its top, as its samples have it. Taken as the
        // ground there, the lawn stood up in slivers inside the nose,
        // 1815.6,2035.6.)
        // (Nearer by the line along it than any other edge, not by its
        // nearest sample: a path's edge 70 cm from a kerb took the kerb's
        // top or the path's height by which sample was nearest, turn and
        // turn about every few centimetres, and the lawn stood up in
        // spikes between, 2569.6,1990.6.)
        let kd = 0.75 * 0.75;
        for (let gx = Math.floor((x - 0.75) / EG); gx <= Math.floor((x + 0.75) / EG); gx++)
          for (let gz = Math.floor((z - 0.75) / EG); gz <= Math.floor((z + 0.75) / EG); gz++)
            for (const e of egrid.get(gx * 100003 + gz) ?? NONE) {
              const [ax, az, , bx, bz] = edges[e];
              const qx = bx - ax, qz = bz - az, L2 = qx * qx + qz * qz;
              const ue = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * qx + (z - az) * qz) / L2)) : 0;
              const ox = ax + qx * ue - x, oz = az + qz * ue - z;
              if (ox * ox + oz * oz < kd) kd = ox * ox + oz * oz;
            }
        const [gv, gd] = lowEdge(x, z, 0.75);
        if (Math.sqrt(kd) < Math.min(gd, 0.75)) {
          let sw = 0, sv = 0;
          for (let ci = Math.floor((x - 0.75) / SG); ci <= Math.floor((x + 0.75) / SG); ci++)
            for (let cj = Math.floor((z - 0.75) / SG); cj <= Math.floor((z + 0.75) / SG); cj++)
              for (const n of sgrid.get(ci * 100003 + cj) ?? NONE) {
                if (S[n + 6] !== 2) continue;
                const d2 = (x - S[n]) ** 2 + (z - S[n + 1]) ** 2;
                if (d2 >= 0.75 * 0.75) continue;
                const wt = S[n + 5] * (1 - Math.sqrt(d2) / 0.75) ** 2;
                sw += wt;
                sv += wt * S[n + 2];
              }
          if (sw > 0) return Math.max(capAt(x, z, sv / sw), Math.min(sv / sw, gnd(x, z) + 0.02));
        }
        return gv === gv ? gv : gnd(x, z) + 0.02;
      };
      /**
       * The edges near (x, z) that are not a lawn kerb's (the ground's, a
       * path's, a drop's): their height there, from their samples within r
       * weighed by length and nearness, and how far the nearest is.
       */
      const lowEdge = (x: number, z: number, r: number): [number, number] => {
        let sw = 0, sv = 0, dmin = Infinity;
        for (let ci = Math.floor((x - r) / SG); ci <= Math.floor((x + r) / SG); ci++)
          for (let cj = Math.floor((z - r) / SG); cj <= Math.floor((z + r) / SG); cj++)
            for (const n of sgrid.get(ci * 100003 + cj) ?? NONE) {
              if (S[n + 6] === 2) continue;
              const tx = -S[n + 4], tz = S[n + 3], hl = S[n + 5] / 2;
              const al = Math.max(-hl, Math.min(hl, (x - S[n]) * tx + (z - S[n + 1]) * tz));
              const dd = Math.hypot(x - S[n] - tx * al, z - S[n + 1] - tz * al);
              if (dd >= r) continue;
              if (dd < dmin) dmin = dd;
              const wt = S[n + 5] * (1 - dd / r) ** 2;
              sw += wt;
              sv += wt * S[n + 2];
            }
        return [sw > 0 ? sv / sw : NaN, dmin];
      };
      /**
       * Its edge's height, as edgeRaw has it, held along each edge of the
       * lawn to no more than 1 in 2 over the edge either side of it: where a
       * kerb's top meets a path or the ground beside it, the lawn's edge
       * comes down along the kerb, the kerb's own side over it. (Each spot
       * by itself, a kerb's top 23 cm over a path's edge 4 cm from it stood
       * the lawn up between in a spike, 1759,2307.5; 192 such places on
       * the trial map.) Not over the square's own sides: no edge there.
       */
      const ENV_S = 0.5, ENV_C = 2, ENV_D = 6;
      const envSeg: number[] = [];
      const envGrid = new Map<number, number[]>();
      {
        const sideOf = (u: number, a: number) => Math.abs(u - a) < 0.003;
        const onSquare = (ax: number, az: number, bx: number, bz: number) =>
          (sideOf(ax, X0 - SOLVE_M) && sideOf(bx, X0 - SOLVE_M)) || (sideOf(ax, X1 + SOLVE_M) && sideOf(bx, X1 + SOLVE_M)) || (sideOf(az, Z0 - SOLVE_M) && sideOf(bz, Z0 - SOLVE_M)) || (sideOf(az, Z1 + SOLVE_M) && sideOf(bz, Z1 + SOLVE_M));
        for (const ring of domain) {
          const m = ring.length;
          if (m < 3) continue;
          // The ring's points, every half metre at most, and whether the side from each to the next is an edge.
          const px: number[] = [], pz: number[] = [], open: boolean[] = [];
          for (let q = 0; q < m; q++) {
            const ax = ring[q].x / S_, az = ring[q].y / S_, bx = ring[(q + 1) % m].x / S_, bz = ring[(q + 1) % m].y / S_;
            const free = onSquare(ax, az, bx, bz);
            // (Its points where it crosses the world's half-metre lines:
            // the next tile's the same. Every half metre from each corner,
            // the two tiles' heights between them differed by 5 cm along a
            // kerb whose top ran up and down, -182.4,200.)
            const ts = [0];
            if (!free) {
              for (const [a0, b0] of [[ax, bx], [az, bz]]) {
                if (Math.abs(b0 - a0) < 1e-9) continue;
                for (let g = Math.ceil(Math.min(a0, b0) * 2); g <= Math.floor(Math.max(a0, b0) * 2); g++) {
                  const t = (g / 2 - a0) / (b0 - a0);
                  if (t > 1e-6 && t < 1 - 1e-6) ts.push(t);
                }
              }
              ts.sort((p, q) => p - q);
            }
            for (const t of ts) px.push(lerp(ax, bx, t)), pz.push(lerp(az, bz, t)), open.push(!free);
          }
          const n = px.length;
          const v = new Float64Array(n);
          for (let i = 0; i < n; i++) {
            v[i] = open[i] || open[(i + n - 1) % n] ? edgeRaw(px[i], pz[i]) : NaN;
            if ((i & 7) === 7 && pause()) yield* rest();
          }
          // (From those within ENV_D along it only: the next tile has the
          // edge that far past the border too. Carried on round the whole
          // edge, a low point beyond the one tile's reach brought the
          // border's height down 5 cm in that tile alone, -182.4,200.)
          const v0 = v.slice();
          // (Each side's length once; and no further along than the lowest
          // point anywhere on it could bring it down from: looked along the
          // whole ENV_D from every point, a twentieth of the sheet's time.)
          const len = new Float64Array(n);
          let vmin = Infinity;
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            len[i] = Math.hypot(px[j] - px[i], pz[j] - pz[i]);
            if (v0[i] < vmin) vmin = v0[i];
          }
          for (let i = 0; i < n; i++) {
            if (!(v0[i] === v0[i])) continue;
            for (let dir = 1; dir >= -1; dir -= 2) {
              let j = i, s = 0;
              for (let step = 0; step < n; step++) {
                const k = (j + dir + n) % n;
                if (!open[dir > 0 ? j : k]) break;
                s += len[dir > 0 ? j : k];
                if (s > ENV_D || vmin + ENV_S * s >= v[i]) break;
                const c = v0[k] + ENV_S * s;
                if (c < v[i]) v[i] = c;
                j = k;
              }
            }
          }
          for (let i = 0; i < n; i++) {
            if (!open[i]) continue;
            const j = (i + 1) % n, id = envSeg.length;
            envSeg.push(px[i], pz[i], v[i], px[j], pz[j], v[j]);
            for (let gx = Math.floor((Math.min(px[i], px[j]) - 0.01) / ENV_C); gx <= Math.floor((Math.max(px[i], px[j]) + 0.01) / ENV_C); gx++)
              for (let gz = Math.floor((Math.min(pz[i], pz[j]) - 0.01) / ENV_C); gz <= Math.floor((Math.max(pz[i], pz[j]) + 0.01) / ENV_C); gz++)
                (envGrid.get(gx * 100003 + gz) ?? envGrid.set(gx * 100003 + gz, []).get(gx * 100003 + gz)!).push(id);
          }
        }
      }
      const edgeAt = (x: number, z: number) => {
        let eb = 0.003 * 0.003, y = NaN;
        for (const id of envGrid.get(Math.floor(x / ENV_C) * 100003 + Math.floor(z / ENV_C)) ?? NONE) {
          const ax = envSeg[id], az = envSeg[id + 1], bx = envSeg[id + 3], bz = envSeg[id + 4];
          const qx = bx - ax, qz = bz - az, L2 = qx * qx + qz * qz;
          const u = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * qx + (z - az) * qz) / L2)) : 0;
          const d2 = (ax + qx * u - x) ** 2 + (az + qz * u - z) ** 2;
          if (d2 >= eb) continue;
          eb = d2;
          y = lerp(envSeg[id + 2], envSeg[id + 5], u);
        }
        // (Eased down along the edge, never under the ground there, nor
        // its own height: see capAt.)
        if (!(y === y)) return edgeRaw(x, z);
        return Math.max(y, Math.min(edgeRaw(x, z), gnd(x, z) + 0.02));
      };
      // Where it is worked out: the domain's crossings with each line of the grid, as spans.
      type Span = { a: number; b: number; ea: number; eb: number };
      type Solved = { rows: Map<number, Span[]>; colsG: Map<number, Span[]>; nodeId: Map<number, number>; U: Float64Array };
      // (An edge's height asked once: the border's own sums and the tile's cross the same edges.)
      const edgeMemo = new Map<string, number>();
      const edgeOnce = (alongX: boolean, j: number, u: number) => {
        const key = `${alongX ? 'r' : 'c'}${j}:${u}`;
        let v = edgeMemo.get(key);
        if (v === undefined) edgeMemo.set(key, (v = alongX ? edgeAt(u, j) : edgeAt(j, u)));
        return v;
      };
      /**
       * The sheet over a rectangle, its sides at half metres: past them the
       * sheet goes on, and the grid takes it as level there. Points fix
       * gives a height for are held at it.
       */
      const solveRect = function* (rx0: number, rx1: number, rz0: number, rz1: number, fix?: (i: number, j: number) => number): Generator<void, Solved, void> {
        const dom = Clipper.Intersect(domain, many([toPath([[rx0, rz0], [rx1, rz0], [rx1, rz1], [rx0, rz1]])]), FillRule.NonZero);
        const spansOf = function* (alongX: boolean): Generator<void, Map<number, Span[]>, void> {
          const out = new Map<number, Span[]>();
          const cuts = new Map<number, number[]>();
          for (const p of dom)
            for (let q = 0; q < p.length; q++) {
              const A = p[q], Bq = p[(q + 1) % p.length];
              const ca = (alongX ? A.y : A.x) / S_, cb = (alongX ? Bq.y : Bq.x) / S_;
              const ua = (alongX ? A.x : A.y) / S_, ub = (alongX ? Bq.x : Bq.y) / S_;
              for (let j = Math.ceil(Math.min(ca, cb)); j <= Math.floor(Math.max(ca, cb)); j++) {
                if ((ca <= j) === (cb <= j)) continue;
                const u = ua + ((ub - ua) * (j - ca)) / (cb - ca);
                (cuts.get(j) ?? cuts.set(j, []).get(j)!).push(u);
              }
            }
          const free = (u: number) => Math.abs(u - (alongX ? rx0 : rz0)) < 0.002 || Math.abs(u - (alongX ? rx1 : rz1)) < 0.002;
          for (const [j, L] of cuts) {
            L.sort((p, q) => p - q);
            const sp: Span[] = [];
            for (let q = 0; q + 1 < L.length; q += 2) {
              const a = L[q], b = L[q + 1];
              sp.push({ a, b, ea: free(a) ? NaN : edgeOnce(alongX, j, a), eb: free(b) ? NaN : edgeOnce(alongX, j, b) });
            }
            out.set(j, sp);
            if (pause()) yield* rest();
          }
          return out;
        };
        const rows = yield* spansOf(true);
        if (pause()) {
          yield;
          slice = performance.now();
        }
        const colsG = yield* spansOf(false);
        if (pause()) {
          yield;
          slice = performance.now();
        }
        // The grid's points in the domain, each with its four neighbours: a point, or an edge at its distance, or none (past the side).
        const nodeId = new Map<number, number>();
        const nX: number[] = [], nZ: number[] = [];
        for (const [j, sp] of rows)
          for (const s of sp)
            for (let i = Math.ceil(s.a); i <= Math.floor(s.b); i++) {
              nodeId.set(i * 100003 + j, nX.length);
              nX.push(i), nZ.push(j);
            }
        const N = nX.length;
        const U = new Float64Array(N);
        // Per point and side (-x, +x, -z, +z): the neighbour's id, or -1 with the edge's distance and height, or -2 past the side.
        const nb = new Int32Array(N * 4).fill(-2), nh = new Float64Array(N * 4).fill(1), ne = new Float64Array(N * 4);
        const fixed = new Uint8Array(N);
        const link = function* (lines: Map<number, Span[]>, alongX: boolean): Generator<void, void, void> {
          for (const [j, sp] of lines) {
            if (pause()) yield* rest();
            for (const s of sp)
              for (let i = Math.ceil(s.a); i <= Math.floor(s.b); i++) {
                const id = nodeId.get(alongX ? i * 100003 + j : j * 100003 + i);
                if (id === undefined) continue;
                const lo = alongX ? 0 : 2;
                const side = (k: number, e: number, dist: number, other: number) => {
                  if (dist < 1) {
                    if (e === e) (nb[id * 4 + k] = -1), (nh[id * 4 + k] = dist), (ne[id * 4 + k] = e);
                    else nb[id * 4 + k] = -2;
                    if (dist < 0.002 && e === e) (fixed[id] = 1), (U[id] = e);
                  } else {
                    const o = nodeId.get(alongX ? other * 100003 + j : j * 100003 + other);
                    if (o !== undefined) nb[id * 4 + k] = o;
                  }
                };
                side(lo, s.ea, i - s.a, i - 1);
                side(lo + 1, s.eb, s.b - i, i + 1);
              }
          }
        };
        yield* link(rows, true);
        yield* link(colsG, false);
        // (A first guess, along each row from edge to edge.)
        for (const [j, sp] of rows) {
          if (pause()) yield* rest();
          for (const s of sp) {
            const ea = s.ea === s.ea ? s.ea : s.eb, eb = s.eb === s.eb ? s.eb : s.ea;
            for (let i = Math.ceil(s.a); i <= Math.floor(s.b); i++) {
              const id = nodeId.get(i * 100003 + j)!;
              if (!fixed[id]) U[id] = ea === ea ? lerp(ea, eb, s.b > s.a ? (i - s.a) / (s.b - s.a) : 0.5) : gnd(i, j) + 0.02;
            }
          }
        }
        if (fix)
          for (let id = 0; id < N; id++)
            if (!fixed[id]) {
              const v = fix(nX[id], nZ[id]);
              if (v === v) (fixed[id] = 1), (U[id] = v);
            }
        if (pause()) {
          yield;
          slice = performance.now();
        }
        // Solved by over-relaxation, to a tenth of a millimetre.
        // (Each point's weights on its neighbours and the edges' part, once:
        // worked out afresh each sweep, the solving was a tenth of the
        // sheet's time.)
        const cOff = new Int32Array(N + 1), cNb: number[] = [], cW: number[] = [];
        const cK = new Float64Array(N), cS = new Float64Array(N);
        for (let id = 0; id < N; id++) {
          cOff[id] = cNb.length;
          if (fixed[id]) continue;
          let sa = 0, sv = 0;
          for (let lo = 0; lo <= 2; lo += 2) {
            // (Past the side, the far side's mirror: level there.)
            let k1 = lo, k2 = lo + 1;
            if (nb[id * 4 + k1] === -2 && nb[id * 4 + k2] === -2) continue;
            if (nb[id * 4 + k1] === -2) k1 = k2;
            else if (nb[id * 4 + k2] === -2) k2 = k1;
            const h1 = nh[id * 4 + k1], h2 = nh[id * 4 + k2], c = 2 / (h1 + h2);
            for (const [k, h] of [[k1, h1], [k2, h2]]) {
              sa += c / h;
              if (nb[id * 4 + k] >= 0) cNb.push(nb[id * 4 + k]), cW.push(c / h);
              else sv += (c / h) * ne[id * 4 + k];
            }
          }
          if (!(sa > 0)) continue;
          cS[id] = 1 / sa;
          cK[id] = sv;
        }
        cOff[N] = cNb.length;
        const NB = Int32Array.from(cNb), WT = Float64Array.from(cW);
        const W = 1.85;
        for (let it = 0; it < 4000; it++) {
          let worst = 0;
          for (let id = 0; id < N; id++) {
            const is = cS[id];
            if (!is) continue;
            let sv = cK[id];
            for (let q = cOff[id], e = cOff[id + 1]; q < e; q++) sv += WT[q] * U[NB[q]];
            const d = (sv * is - U[id]) * W;
            U[id] += d;
            if (d > worst) worst = d;
            else if (-d > worst) worst = -d;
          }
          if (worst < 1e-4) break;
          if (pause()) {
            yield;
            slice = performance.now();
          }
        }
        return { rows, colsG, nodeId, U };
      };
      // (The tile's own sheet meets the next tile's at their border: the
      // heights along it are each worked out once, the same way for both
      // tiles, over a strip SOLVE_M either side of it, and each corner's
      // over a square SOLVE_M round it; the tile's own sheet is held to
      // them there. Each tile working out its border over its own ground
      // and SOLVE_M beyond, the two met 12 to 21 cm apart across a wide
      // island, 1766.5,1800.)
      const M = SOLVE_M;
      const at = (r: Solved, i: number, j: number) => {
        const id = r.nodeId.get(i * 100003 + j);
        return id === undefined ? NaN : r.U[id];
      };
      // (Each border's heights kept once worked out, for the tile on its
      // other side: the same numbers, and half the work. None where no
      // lawn comes within a metre of it.)
      const nearLine = (x0: number, z0: number, x1: number, z1: number) => Clipper.Intersect(domain, many([toPath([[x0 - 1, z0 - 1], [x1 + 1, z0 - 1], [x1 + 1, z1 + 1], [x0 - 1, z1 + 1]])]), FillRule.NonZero).length > 0;
      const sideVals = function* (vertical: boolean, cx: number, cz: number): Generator<void, Float64Array, void> {
        const key = `${lvl}|${vertical ? 'v' : 'h'}|${cx}|${cz}`;
        let got = borderKept.get(key);
        if (got) return got;
        got = new Float64Array(TILE + 1).fill(NaN);
        if (vertical ? nearLine(cx, cz, cx, cz + TILE) : nearLine(cx, cz, cx + TILE, cz)) {
          const r = vertical ? yield* solveRect(cx - M, cx + M, cz - M, cz + TILE + M) : yield* solveRect(cx - M, cx + TILE + M, cz - M, cz + M);
          for (let t = 0; t <= TILE; t++) got[t] = vertical ? at(r, cx, cz + t) : at(r, cx + t, cz);
        }
        borderKept.set(key, got);
        return got;
      };
      const cornerVal = function* (cx: number, cz: number): Generator<void, number, void> {
        const key = `${lvl}|c|${cx}|${cz}`;
        let got = borderKept.get(key);
        if (!got) {
          got = new Float64Array(1).fill(NaN);
          if (nearLine(cx, cz, cx, cz)) got[0] = at(yield* solveRect(cx - M, cx + M, cz - M, cz + M), cx, cz);
          borderKept.set(key, got);
        }
        return got[0];
      };
      const sideL = yield* sideVals(true, X0, Z0), sideR = yield* sideVals(true, X1, Z0);
      const sideT = yield* sideVals(false, X0, Z0), sideB = yield* sideVals(false, X0, Z1);
      const cornerAt = new Map<number, number>();
      for (const [cx, cz] of [[X0, Z0], [X1, Z0], [X0, Z1], [X1, Z1]]) cornerAt.set(cx * 100003 + cz, yield* cornerVal(cx, cz));
      const borderAt = (i: number, j: number) => {
        const onL = i === X0, onR = i === X1, onT = j === Z0, onB = j === Z1;
        if ((onL || onR) && (onT || onB)) return cornerAt.get(i * 100003 + j)!;
        if (onL) return sideL[j - Z0];
        if (onR) return sideR[j - Z0];
        if (onT) return sideT[i - X0];
        if (onB) return sideB[i - X0];
        return NaN;
      };
      const own = yield* solveRect(X0 - 0.5, X1 + 0.5, Z0 - 0.5, Z1 + 0.5, borderAt);
      const { rows, colsG, nodeId, U } = own;
      /** The sheet's height at (x, z): at a point of the grid its own; on a line of the grid, between the points or edges either side; elsewhere, on an edge, the edge's. */
      const sheetY = (x: number, z: number) => {
        const xi = Math.round(x), zi = Math.round(z);
        const onX = Math.abs(z - zi) < 1e-6, onZ = Math.abs(x - xi) < 1e-6;
        if (onX && onZ) {
          const id = nodeId.get(xi * 100003 + zi);
          if (id !== undefined) return U[id];
        }
        const along = (lines: Map<number, Span[]>, j: number, u: number, key: (i: number) => number, at: (u: number) => [number, number]) => {
          for (const s of lines.get(j) ?? []) {
            if (u < s.a - 1e-3 || u > s.b + 1e-3) continue;
            const ea = s.ea === s.ea ? s.ea : edgeAt(...at(s.a)), eb = s.eb === s.eb ? s.eb : edgeAt(...at(s.b));
            if (Math.abs(u - s.a) < 1e-3) return ea;
            if (Math.abs(u - s.b) < 1e-3) return eb;
            const il = Math.floor(u), ir = il + 1;
            const idl = nodeId.get(key(il)), idr = nodeId.get(key(ir));
            const [pl, vl] = il <= s.a || idl === undefined ? [s.a, ea] : [il, U[idl]];
            const [pr, vr] = ir >= s.b || idr === undefined ? [s.b, eb] : [ir, U[idr]];
            return pr > pl ? lerp(vl, vr, (u - pl) / (pr - pl)) : vl;
          }
          return NaN;
        };
        let v = NaN;
        if (onX) v = along(rows, zi, x, (i) => i * 100003 + zi, (u) => [u, zi]);
        if (!(v === v) && onZ) v = along(colsG, xi, z, (i) => xi * 100003 + i, (u) => [xi, u]);
        return v === v ? v : edgeAt(x, z);
      };
      // The sheet: 1 m squares fixed to the world, each cut to where it is laid.
      const vIdx = new Map<number, number>();
      /** A point's key, its millimetres packed in one number. */
      const vKey = (X: number, Z: number) => (X + 5e6) * 1e7 + (Z + 5e6);
      const vx: number[] = [], vz: number[] = [];
      const tris: number[] = [];
      const vert = (X: number, Z: number) => {
        const key = vKey(X, Z);
        let i = vIdx.get(key);
        if (i === undefined) {
          vIdx.set(key, (i = vx.length));
          vx.push(X / S_), vz.push(Z / S_);
        }
        return i;
      };
      // (Cut a square at a time, see halve and block below: the clipper's
      // own rectangle clip loops without end on this
      // outline, see clipfix. A 1 m square no edge crosses is whole or
      // empty, as its middle is.)
      /**
       * A piece's triangles, each pair side by side turned the other way
       * across their shared side where that makes the thinner of them less
       * thin (Lawson's flips, seen from above). (Fanned from a corner of the
       * square, three points of the piece nearly in a line made a sliver
       * between them, its middle point a kerb's corner 12 cm over the
       * others: a spike, 1923.9,1633.)
       */
      const flipped = (P: { x: number; y: number }[], F: number[][]) => {
        const q2 = (a: number, b: number, c: number) => {
          // Twice the area over the longest side squared: 0 flat, ~0.87 even.
          const A = P[a], B = P[b], C = P[c];
          const ar = Math.abs((B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y));
          const l = Math.max((B.x - A.x) ** 2 + (B.y - A.y) ** 2, (C.x - B.x) ** 2 + (C.y - B.y) ** 2, (A.x - C.x) ** 2 + (A.y - C.y) ** 2);
          return l > 0 ? ar / l : 0;
        };
        const sgn = (a: number, b: number, c: number) => Math.sign((P[b].x - P[a].x) * (P[c].y - P[a].y) - (P[c].x - P[a].x) * (P[b].y - P[a].y));
        const T = F.map((t) => t.slice());
        for (let pass = 0; pass < 8; pass++) {
          let any = false;
          for (let i = 0; i < T.length; i++)
            for (let e = 0; e < 3; e++) {
              const a = T[i][e], b = T[i][(e + 1) % 3], c = T[i][(e + 2) % 3];
              for (let j = i + 1; j < T.length; j++) {
                const t = T[j];
                const k = t.indexOf(b);
                if (k < 0 || t[(k + 1) % 3] !== a) continue;
                const d = t[(k + 2) % 3];
                // (Only where the four make a convex shape: the new side inside it.)
                const s0 = sgn(a, b, c);
                if (s0 === 0 || sgn(d, b, c) !== s0 || sgn(c, a, d) !== s0) continue;
                const before = Math.min(q2(a, b, c), q2(b, a, d)), after = Math.min(q2(a, d, c), q2(d, b, c));
                if (after <= before * 1.05) continue;
                T[i] = [a, d, c];
                T[j] = [d, b, c];
                any = true;
                break;
              }
            }
          if (!any) break;
        }
        return T;
      };
      const cellTris = (cell: Paths64, cx: number, cz: number) => {
        let area = 0;
        for (const p of cell) area += Clipper.area(p);
        if (Math.abs(area) < 1) return;
        if (Math.abs(Math.abs(area) - S_ * S_) < 2) {
          const a = vert(cx * S_, cz * S_), b = vert((cx + 1) * S_, cz * S_), c = vert((cx + 1) * S_, (cz + 1) * S_), d = vert(cx * S_, (cz + 1) * S_);
          // (Cut corner to corner the way the ground's own squares are, see
          // gridIdx: laid 2 cm over the ground, it lies 2 cm over it all
          // across, where cut the other way the ground's ridges came
          // through it in specks, 1866.5,1816.)
          tris.push(a, b, d, b, c, d);
          return;
        }
        const outers = cell.filter((p) => Clipper.area(p) > 0);
        const inner = cell.filter((p) => Clipper.area(p) < 0);
        for (const o of outers) {
          const hs = inner.filter((h) => Clipper.pointInPolygon(new Point64(h[0].x, h[0].y), o) === PointInPolygonResult.IsInside);
          // (Fanned out from a corner of the square where the piece has one
          // and all of it is in view from there: each piece then has a point
          // of the grid. Cut by ear, pieces of three points along the
          // lawn's edge, a few millimetres across, stood up on end with the
          // smallest wave in the edge's heights, 323 on the trial map.)
          if (!hs.length) {
            const n = o.length;
            const cr = (A: { x: number; y: number }, B: { x: number; y: number }, C: { x: number; y: number }) => (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
            let fan = -1;
            for (let c = 0; c < n && fan < 0; c++) {
              if (o[c].x % S_ !== 0 || o[c].y % S_ !== 0) continue;
              let ok = true;
              for (let q = 1; q + 1 < n && ok; q++) ok = cr(o[c], o[(c + q) % n], o[(c + q + 1) % n]) >= 0;
              if (ok) fan = c;
            }
            if (fan >= 0) {
              const F: number[][] = [];
              for (let q = 1; q + 1 < n; q++) F.push([fan, (fan + q) % n, (fan + q + 1) % n]);
              for (const [a, b, c] of flipped(o, F)) {
                const A = o[a], B = o[b], D = o[c];
                if (Math.abs(cr(A, B, D)) < 2e-6 * S_ * S_) continue;
                tris.push(vert(A.x, A.y), vert(B.x, B.y), vert(D.x, D.y));
              }
              continue;
            }
          }
          const pts = [...o, ...hs.flat()];
          const faces = flipped(pts, THREE.ShapeUtils.triangulateShape(o.map((q) => new THREE.Vector2(q.x, q.y)), hs.map((h) => h.map((q) => new THREE.Vector2(q.x, q.y)))));
          for (const [a, b, c] of faces) {
            // (None with no size from above: three points in a line along
            // the cell's side, at three heights, stood up as a flap.)
            const A = pts[a], B = pts[b], C = pts[c];
            if (Math.abs((B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y)) < 2e-6 * S_ * S_) continue;
            tris.push(vert(A.x, A.y), vert(B.x, B.y), vert(C.x, C.y));
          }
        }
      };
      /** A block of 1 m squares, its piece of the sheet cut to it: each square cut, or whole, or empty. */
      const block = (blk: Paths64, bx0: number, bz0: number, bx1: number, bz1: number) => {
        // (The 1 m squares an edge of it passes through.)
        const hit = new Set<number>();
        const SX0 = bx0 * S_, SX1 = bx1 * S_, SZ0 = bz0 * S_, SZ1 = bz1 * S_;
        for (const p of blk)
          for (let q = 0; q < p.length; q++) {
            const a = p[q], b = p[(q + 1) % p.length];
            // (Not the block's own sides, where it was cut: those are the squares' sides.)
            if ((a.x === b.x && (a.x === SX0 || a.x === SX1)) || (a.y === b.y && (a.y === SZ0 || a.y === SZ1))) continue;
            const ax = a.x / S_, az = a.y / S_, ex = b.x / S_, ez = b.y / S_;
            // (A short side: every square of its box, a hair wider. A square
            // it misses is cut too, and comes out whole or empty.)
            if (Math.abs(ex - ax) < 1 && Math.abs(ez - az) < 1) {
              const gx1 = Math.floor(Math.max(ax, ex) + 0.002), gz0 = Math.floor(Math.min(az, ez) - 0.002), gz1 = Math.floor(Math.max(az, ez) + 0.002);
              for (let gx = Math.floor(Math.min(ax, ex) - 0.002); gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) hit.add(gx * 100003 + gz);
              continue;
            }
            const L = Math.hypot(ex - ax, ez - az), m = Math.max(1, Math.ceil(L * 4));
            for (let t = 0; t <= m; t++) {
              const x = lerp(ax, ex, t / m), z = lerp(az, ez, t / m);
              const xa = Math.floor(x - 0.002) * 100003, xb = Math.floor(x + 0.002) * 100003, za = Math.floor(z - 0.002), zb = Math.floor(z + 0.002);
              hit.add(xa + za), hit.add(xa + zb), hit.add(xb + za), hit.add(xb + zb);
            }
          }
        // (Whether a square no edge crosses is in: by its row's crossings
        // with the line through the squares' middles, once a row. Asked of
        // the block's every side square by square, a tenth of the sheet's
        // time.)
        const inRow = new Map<number, Uint8Array>();
        for (let cz = bz0; cz < bz1; cz++) {
          const zc = (cz + 0.5) * S_;
          const xs: [number, number][] = [];
          for (const p of blk)
            for (let q = 0; q < p.length; q++) {
              const a = p[q], b = p[(q + 1) % p.length];
              if ((a.y <= zc) === (b.y <= zc)) continue;
              xs.push([a.x + ((b.x - a.x) * (zc - a.y)) / (b.y - a.y), a.y <= zc ? 1 : -1]);
            }
          xs.sort((u, v) => u[0] - v[0]);
          const row = new Uint8Array(bx1 - bx0);
          let k = 0, wn = 0;
          for (let cx = bx0; cx < bx1; cx++) {
            const xc = (cx + 0.5) * S_;
            while (k < xs.length && xs[k][0] < xc) wn += xs[k++][1];
            row[cx - bx0] = wn !== 0 ? 1 : 0;
          }
          inRow.set(cz, row);
        }
        const boxOf = (P: Paths64) => P.map((p) => {
          let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
          for (const q of p) (x0 = Math.min(x0, q.x)), (x1 = Math.max(x1, q.x)), (z0 = Math.min(z0, q.y)), (z1 = Math.max(z1, q.y));
          return [x0, z0, x1, z1];
        });
        const boxes = boxOf(blk);
        for (let cx = bx0; cx < bx1; cx++) {
          // (Its column cut out once, and each square from the column: cut
          // from the block's whole piece four times a square, the lawn's
          // edges cost a sixth of the sheet's time.)
          let colP: Paths64 | null = null, colB: number[][] = [];
          for (let cz = bz0; cz < bz1; cz++) {
            if (hit.has(cx * 100003 + cz)) {
              const X0 = cx * S_, Z0 = cz * S_, X1 = X0 + S_, Z1 = Z0 + S_;
              if (!colP) {
                const near1 = new Paths64();
                blk.forEach((p, k) => {
                  const b = boxes[k];
                  if (!(b[2] <= X0 || b[0] >= X1)) near1.push(p);
                });
                colP = split(split(near1, true, X0, false, cx, bz0, cx + 1, bz1), true, X1, true, cx, bz0, cx + 1, bz1);
                colB = boxOf(colP);
              }
              const near1 = new Paths64();
              colP.forEach((p, k) => {
                const b = colB[k];
                if (!(b[3] <= Z0 || b[1] >= Z1)) near1.push(p);
              });
              const cc = split(split(near1, false, Z0, false, cx, cz, cx + 1, cz + 1), false, Z1, true, cx, cz, cx + 1, cz + 1);
              cellTris(cc, cx, cz);
            }
            else if (inRow.get(cz)![cx - bx0]) {
              const a = vert(cx * S_, cz * S_), b = vert((cx + 1) * S_, cz * S_), c = vert((cx + 1) * S_, (cz + 1) * S_), d = vert(cx * S_, (cz + 1) * S_);
              tris.push(a, b, d, b, c, d);
            }
          }
        }
      };
      // (Halved and halved again, each half cut from its own half's piece,
      // down to blocks of 8 m or less: cut from the whole tile's, as 40 m
      // squares were, the clipper took 30 s of the map's start.)
      const halve = function* (P: Paths64, x0: number, z0: number, x1: number, z1: number): Generator<void, void, void> {
        if (!P.length) return;
        let pts = 0;
        for (const p of P) pts += p.length;
        // (Or with few points left, cut a square at a time from there: each
        // call to the clipper costs a tenth of a millisecond, however small.)
        if ((x1 - x0 <= 8 && z1 - z0 <= 8) || pts <= 48) {
          block(P, x0, z0, x1, z1);
          if (pause()) {
            yield;
            slice = performance.now();
          }
          return;
        }
        if (pause()) yield* rest();
        if (x1 - x0 >= z1 - z0) {
          const mx = x0 + Math.floor((x1 - x0) / 2);
          yield* halve(split(P, true, mx * S_, true, x0, z0, mx, z1), x0, z0, mx, z1);
          if (pause()) yield* rest();
          yield* halve(split(P, true, mx * S_, false, mx, z0, x1, z1), mx, z0, x1, z1);
        } else {
          const mz = z0 + Math.floor((z1 - z0) / 2);
          yield* halve(split(P, false, mz * S_, true, x0, z0, x1, mz), x0, z0, x1, mz);
          if (pause()) yield* rest();
          yield* halve(split(P, false, mz * S_, false, x0, mz, x1, z1), x0, mz, x1, z1);
        }
      };
      yield* halve(region, X0, Z0, X1, Z1);
      if (!tris.length) continue;
      // Heights: on a lawn kerb's outer edge its own top (or higher, where rule B3 lifts the lawn), else the rule.
      const vy: number[] = new Array(vx.length);
      const onEdge: [number, number, number][] = [];
      const edgeTop = new Map<number, number>();
      for (let i = 0; i < vx.length; i++) {
        const x = vx[i], z = vz[i];
        let y: number, eBest = -1, eT = 0, eu = 0;
        for (const e of egrid.get(Math.floor(x / EG) * 100003 + Math.floor(z / EG)) ?? []) {
          const [ax, az, ta, bx, bz, tb] = edges[e];
          const qx = bx - ax, qz = bz - az, L2 = qx * qx + qz * qz;
          const u = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * qx + (z - az) * qz) / L2)) : 0;
          const ox = ax + qx * u - x, oz = az + qz * u - z;
          if (ox * ox + oz * oz > 0.003 * 0.003) continue;
          (eBest = e), (eT = lerp(ta, tb, u)), (eu = u);
          break;
        }
        const f = sheetY(x, z);
        if (eBest >= 0) {
          // (The rule's own height there, its kerb's top in effect. Lifted
          // to the kerb's top wherever the rule lay under it, it stood up
          // in slivers a few millimetres across against the lawn beside
          // it, 6500 near upright on the map; the kerb's own side covers
          // the lawn's edge where it lies under the top.)
          y = f === f ? f : eT;
          onEdge.push([eBest, eu, i]);
          vy[i] = y;
          // (Its own top for the face under it: see below.)
          edgeTop.set(i, eT);
        } else vy[i] = Math.max(f, gnd(x, z) + 0.02);
        if ((i & 255) === 0 && pause()) {
          yield;
          slice = performance.now();
        }
      }
      // Its light, from the rule's own slope: at each point of the 1 m
      // grid from its neighbours either side, and between them as they
      // lie about it. (Asked again round every point, the rule was 5
      // asks to a point, 30 s to start the map.)
      const gradN = new Map<number, [number, number]>();
      const grad = (i: number, j: number) => {
        const key = i * 100003 + j;
        let g = gradN.get(key);
        if (g) return g;
        // (Only from points of the 1 m grid the lawn has: the rule asked
        // out on a road beside it gives some other island's heights, and
        // turned a strip between two kerbs dark in specks, 1335,571.6.)
        const At = (a: number, b: number) => {
          const id = nodeId.get(a * 100003 + b);
          return id !== undefined && vIdx.has(vKey(a * S_, b * S_)) ? U[id] : NaN;
        };
        const f0 = At(i, j), xp = At(i + 1, j), xm = At(i - 1, j), zp = At(i, j + 1), zm = At(i, j - 1);
        const d = (p: number, m: number, c: number) => (p === p && m === m ? (p - m) / 2 : p === p && c === c ? p - c : m === m && c === c ? c - m : NaN);
        g = [d(xp, xm, f0), d(zp, zm, f0)];
        gradN.set(key, g);
        return g;
      };
      const nrm: number[] = new Array(vx.length * 3);
      const faceN = new Float64Array(vx.length * 3);
      for (let t = 0; t < tris.length; t += 3) {
        const a = tris[t], b = tris[t + 1], c = tris[t + 2];
        if (!(vy[a] === vy[a] && vy[b] === vy[b] && vy[c] === vy[c])) continue;
        const ux = vx[b] - vx[a], uy = vy[b] - vy[a], uz = vz[b] - vz[a], wx = vx[c] - vx[a], wy = vy[c] - vy[a], wz = vz[c] - vz[a];
        let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        if (ny < 0) (nx = -nx), (ny = -ny), (nz = -nz);
        (faceN[a * 3] += nx), (faceN[a * 3 + 1] += ny), (faceN[a * 3 + 2] += nz);
        (faceN[b * 3] += nx), (faceN[b * 3 + 1] += ny), (faceN[b * 3 + 2] += nz);
        (faceN[c * 3] += nx), (faceN[c * 3 + 1] += ny), (faceN[c * 3 + 2] += nz);
      }
      for (let i = 0; i < vx.length; i++) {
        const x = vx[i], z = vz[i];
        const ci = Math.floor(x), cj = Math.floor(z), u = x - ci, v = z - cj;
        let gx = 0, gz = 0, ws = 0;
        const add = (di: number, dj: number, wt: number) => {
          if (wt <= 1e-9) return;
          const g = grad(ci + di, cj + dj);
          if (!(g[0] === g[0] && g[1] === g[1])) return;
          (gx += g[0] * wt), (gz += g[1] * wt), (ws += wt);
        };
        add(0, 0, (1 - u) * (1 - v));
        add(1, 0, u * (1 - v));
        add(0, 1, (1 - u) * v);
        add(1, 1, u * v);
        if (ws > 0) {
          (gx /= ws), (gz /= ws);
          const l = Math.sqrt(gx * gx + 1 + gz * gz);
          (nrm[3 * i] = -gx / l), (nrm[3 * i + 1] = 1 / l), (nrm[3 * i + 2] = -gz / l);
        } else {
          // (None about it: a strip narrower than the grid. Its pieces' own slope.)
          const f0 = faceN[3 * i], f1 = faceN[3 * i + 1], f2 = faceN[3 * i + 2];
          const l = Math.hypot(f0, f1, f2);
          if (l > 0) (nrm[3 * i] = f0 / l), (nrm[3 * i + 1] = f1 / l), (nrm[3 * i + 2] = f2 / l);
          else (nrm[3 * i] = 0), (nrm[3 * i + 1] = 1), (nrm[3 * i + 2] = 0);
        }
        if ((i & 255) === 0 && pause()) {
          yield;
          slice = performance.now();
        }
      }
      // Into the tile's lawn.
      const base = lawn.pos.length / 3;
      for (let i = 0; i < vx.length; i++) {
        const x = vx[i], z = vz[i], y = vy[i];
        lawnColour(x, z, col);
        const s = 0.9 + 0.2 * valueNoise(x / 3.3, z / 3.3, SEED + 11);
        lawn.pos.push(x, y === y ? y : 0, z);
        lawn.uv.push(x / DETAIL_M, z / DETAIL_M);
        lawn.col.push(col.r * s, col.g * s, col.b * s);
        lawn.nrm.push(nrm[3 * i], nrm[3 * i + 1], nrm[3 * i + 2]);
      }
      for (let t = 0; t < tris.length; t += 3) {
        const a = tris[t], b = tris[t + 1], c = tris[t + 2];
        if (!(vy[a] === vy[a] && vy[b] === vy[b] && vy[c] === vy[c])) continue;
        faceUp(lawn, base + a, base + b, base + c);
      }
      // (Rule B3: where the lawn stands over a lawn kerb's top, a face of its own from the kerb's top up to the lawn's edge, the kerb's side's colour.)
      // (Each lawn point's foot and top once, shared by the pieces either
      // side of it: lit as one face round a curve, where pieces each with
      // points of their own stood out in bands, at 1336,573.)
      const cols = new Map<number, [number, number]>();
      const colOf = (i: number, t: number) => {
        let c = cols.get(i);
        if (!c) {
          const b = side.pos.length / 3;
          side.pos.push(vx[i], t, vz[i], vx[i], vy[i], vz[i]);
          side.uv.push(vx[i] + vz[i], t, vx[i] + vz[i], vy[i]);
          cols.set(i, (c = [b, b + 1]));
        }
        return c;
      };
      // (Along each kerb's whole run, its pieces' points in order: a face
      // to each piece alone left a slit at every bend between them, 1103,1960.)
      const byRun = new Map<number, [number, number, number][]>();
      for (const [e, u, i] of onEdge) (byRun.get(edges[e][8]) ?? byRun.set(edges[e][8], []).get(edges[e][8])!).push([edges[e][9] + u, i, e]);
      for (const L of byRun.values()) {
        if (L.length < 2) continue;
        L.sort((p, q) => p[0] - q[0]);
        for (let q = 0; q + 1 < L.length; q++) {
          const i = L[q][1], j = L[q + 1][1];
          // (Not across where the lawn leaves the kerb and comes back.)
          if (i === j || Math.hypot(vx[j] - vx[i], vz[j] - vz[i]) > 1.5) continue;
          const [, , , , , , nx, nz] = edges[L[q][2]];
          const ti = edgeTop.get(i)!, tj = edgeTop.get(j)!;
          if (vy[i] - ti < 0.005 && vy[j] - tj < 0.005) continue;
          const [bi, ui] = colOf(i, ti), [bj, uj] = colOf(j, tj);
          // (Facing the road: against the way out of the paving.)
          const fx = (vz[j] - vz[i]), fz = -(vx[j] - vx[i]);
          if (fx * -nx + fz * -nz > 0) side.idx.push(bi, bj, ui, ui, bj, uj);
          else side.idx.push(bi, ui, bj, ui, uj, bj);
        }
      }
    }
  }
  /** Cut a tile's paving to its finished outline: see paveCuts. */
  const bareHoles = new Map<string, XZ[][]>();
  const kerbSides = new Map<string, Paths64>();
  function* cutPaving(k: string, road: Acc): Generator<void, void, void> {
    const K = kerbSides.get(k);
    if (!K?.length) return;
    // (A slice at a time: the whole tile at once held a frame up for
    // seconds. Every step below hands back once it has run 4 ms.)
    let slice = performance.now();
    const busy = () => performance.now() - slice > 4;
    const box = (c: Path64) => {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const q of c) (x0 = Math.min(x0, q.x)), (x1 = Math.max(x1, q.x)), (z0 = Math.min(z0, q.y)), (z1 = Math.max(z1, q.y));
      return [x0, z0, x1, z1];
    };
    const meets = (a: number[], b: number[], pad = 0) => a[0] - pad < b[2] && a[2] + pad > b[0] && a[1] - pad < b[3] && a[3] + pad > b[1];
    const copyOf = (c: Path64) => c.map((q) => new Point64(q.x, q.y)) as Path64;
    function* narrow(C0: Paths64 | undefined): Generator<void, Path64[], void> {
    if (!C0?.length) return [];
    const boxC0 = C0.map(box);
    // (Only beside a kerb, within half a metre of its line: what shows over
    // it. Where the outline runs with no kerb, at a road's end, a level's
    // edge or a hole in a junction's paving, the paving past it shows over
    // nothing, and cut there it opened cracks in the road. A few dozen kerb
    // sides at a time, each band against the cuts beside it; the pieces may
    // overlap, which the cut below takes as one.)
    let C: Path64[] = [];
    for (let s = 0; s < K!.length; s += 48) {
      const part = new Paths64();
      for (const c of K!.slice(s, s + 48)) part.push(copyOf(c));
      // (Each side as a box half a metre round it: InflatePaths, rounding
      // every end, took 34 ms a few dozen sides.)
      const band = new Paths64();
      for (const c of part) {
        const [a, b] = [c[0], c[c.length - 1]];
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        if (L < 1) continue;
        const ux = ((b.x - a.x) / L) * 0.5 * OUT_S, uz = ((b.y - a.y) / L) * 0.5 * OUT_S;
        const r = new Path64();
        for (const [s1, s2] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const [ex, ez] = s1 < 0 ? [a.x - ux, a.y - uz] : [b.x + ux, b.y + uz];
          r.push(new Point64(Math.round(ex - uz * s2), Math.round(ez + ux * s2)));
        }
        band.push(r);
      }
      if (!band.length) continue;
      const bb = box(band.flat() as Path64);
      const A = new Paths64();
      boxC0.forEach((b, i) => {
        if (meets(b, bb)) A.push(copyOf(C0[i]));
      });
      // (Nor a sliver of under 25 cm² or a needle of no width: nothing of it shows.)
      if (A.length) for (const c of Clipper.Intersect(A, band, FillRule.NonZero)) if (Math.abs(Clipper.area(c)) >= 2500) C.push(c);
      if (busy()) {
        yield;
        slice = performance.now();
      }
    }
    if (!C.length) return C;
    // (Not inside a hole no kerb runs round: paving the union missed inside
    // a junction, paved over as it is, not an island. Cut there, the road's
    // own paving left a hole in it, grass showing through at Tampines
    // Central 1.)
    const bare = bareHoles.get(k);
    if (bare?.length) {
      const B = bare.map((r) => r.map(([x, z]) => new Point64(Math.round(x * OUT_S), Math.round(z * OUT_S))) as Path64);
      const boxB = B.map(box);
      const D: Path64[] = [];
      for (const c of C) {
        const bc = box(c);
        const near = new Paths64();
        boxB.forEach((b, i) => {
          if (meets(b, bc)) near.push(copyOf(B[i]));
        });
        if (!near.length) D.push(c);
        else {
          const subj = new Paths64();
          subj.push(c);
          for (const d of Clipper.Difference(subj, near, FillRule.NonZero)) D.push(d);
        }
        if (busy()) {
        yield;
          slice = performance.now();
        }
      }
      C = D;
    }
    return C;
    }
    const C1 = yield* narrow(paveCuts.get(k)), nPlain = C1.length;
    const C = C1.concat(yield* narrow(paveUnder.get(k)));
    if (!C.length) return;
    // (Each cut in the 4 m squares its box covers, for a quick look past
    // most of the paving.)
    const G = 4;
    const grid = new Map<number, number[]>();
    const boxes = C.map((c, i) => {
      const b = box(c).map((v) => v / OUT_S);
      for (let gx = Math.floor(b[0] / G); gx <= Math.floor(b[2] / G); gx++)
        for (let gz = Math.floor(b[1] / G); gz <= Math.floor(b[3] / G); gz++) {
          const key = gx * 65536 + gz;
          (grid.get(key) ?? grid.set(key, []).get(key)!).push(i);
        }
      return b;
    });
    const { pos, uv, idx } = road;
    // (Is there paving 2 m or more over triangle t's middle? Its triangles by 4 m square, worked out when first asked.)
    let over: Map<number, number[]> | null = null;
    const overlaid = (t: number) => {
      if (!over) {
        over = new Map();
        for (let q = 0; q < idx.length; q += 3) {
          const xs = [idx[q], idx[q + 1], idx[q + 2]].map((i) => pos[i * 3]), zs = [idx[q], idx[q + 1], idx[q + 2]].map((i) => pos[i * 3 + 2]);
          for (let gx = Math.floor(Math.min(...xs) / G); gx <= Math.floor(Math.max(...xs) / G); gx++)
            for (let gz = Math.floor(Math.min(...zs) / G); gz <= Math.floor(Math.max(...zs) / G); gz++) (over.get(gx * 65536 + gz) ?? over.set(gx * 65536 + gz, []).get(gx * 65536 + gz)!).push(q);
        }
      }
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
      const x = (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3, y = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1]) / 3, z = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3;
      for (const q of over.get(Math.floor(x / G) * 65536 + Math.floor(z / G)) ?? []) {
        const P = [idx[q], idx[q + 1], idx[q + 2]].map((i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
        const det = (P[1][2] - P[2][2]) * (P[0][0] - P[2][0]) + (P[2][0] - P[1][0]) * (P[0][2] - P[2][2]);
        if (Math.abs(det) < 1e-9) continue;
        const l1 = ((P[1][2] - P[2][2]) * (x - P[2][0]) + (P[2][0] - P[1][0]) * (z - P[2][2])) / det, l2 = ((P[2][2] - P[0][2]) * (x - P[2][0]) + (P[0][0] - P[2][0]) * (z - P[2][2])) / det, l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        if (l1 * P[0][1] + l2 * P[1][1] + l3 * P[2][1] > y + 2) return true;
      }
      return false;
    };
    // (Does triangle t reach over the top of the kerb nearest it? The
    // ground's paving under another road's island hides nothing when it
    // lies below the kerb's top: cut there all the same, it opened a crack
    // at the island's point, 21 cm under its kerb.)
    const KE = kerbOuter.get(k) ?? [];
    const KG = new Map<number, number[]>();
    KE.forEach((e, i) => {
      for (let gx = Math.floor((Math.min(e[0], e[3]) - 1) / G); gx <= Math.floor((Math.max(e[0], e[3]) + 1) / G); gx++)
        for (let gz = Math.floor((Math.min(e[1], e[4]) - 1) / G); gz <= Math.floor((Math.max(e[1], e[4]) + 1) / G); gz++) (KG.get(gx * 65536 + gz) ?? KG.set(gx * 65536 + gz, []).get(gx * 65536 + gz)!).push(i);
    });
    const overKerb = (t: number) => {
      const v = [idx[t], idx[t + 1], idx[t + 2]];
      const x = (pos[v[0] * 3] + pos[v[1] * 3] + pos[v[2] * 3]) / 3, z = (pos[v[0] * 3 + 2] + pos[v[1] * 3 + 2] + pos[v[2] * 3 + 2]) / 3;
      const top = Math.max(...v.map((i) => pos[i * 3 + 1]));
      let best = 1, yk = NaN;
      for (const i of KG.get(Math.floor(x / G) * 65536 + Math.floor(z / G)) ?? []) {
        const e = KE[i];
        const dx = e[3] - e[0], dz = e[4] - e[1], L2 = dx * dx + dz * dz;
        const u = L2 > 1e-12 ? Math.max(0, Math.min(1, ((x - e[0]) * dx + (z - e[1]) * dz) / L2)) : 0;
        const d = Math.hypot(x - e[0] - dx * u, z - e[1] - dz * u);
        if (d < best) (best = d), (yk = e[2] + (e[5] - e[2]) * u);
      }
      return !(yk === yk) || top > yk - 0.02;
    };
    const keep: number[] = [];
    const add: number[] = [];
    for (let t = 0; t < idx.length; t += 3) {
      if (busy()) {
        yield;
        slice = performance.now();
      }
      const ia = idx[t], ib = idx[t + 1], ic = idx[t + 2];
      const ax = pos[ia * 3], az = pos[ia * 3 + 2], bx = pos[ib * 3], bz = pos[ib * 3 + 2], cx = pos[ic * 3], cz = pos[ic * 3 + 2];
      const tx0 = Math.min(ax, bx, cx), tx1 = Math.max(ax, bx, cx), tz0 = Math.min(az, bz, cz), tz1 = Math.max(az, bz, cz);
      const near = new Paths64();
      const seen = new Set<number>();
      for (let gx = Math.floor(tx0 / G); gx <= Math.floor(tx1 / G); gx++)
        for (let gz = Math.floor(tz0 / G); gz <= Math.floor(tz1 / G); gz++)
          for (const i of grid.get(gx * 65536 + gz) ?? []) {
            if (seen.has(i)) continue;
            seen.add(i);
            const b = boxes[i];
            if (!(b[0] < tx1 && b[2] > tx0 && b[1] < tz1 && b[3] > tz0)) continue;
            if (i >= nPlain && !(overlaid(t) && overKerb(t))) continue;
            // (Copies: the library moves the points it is handed.)
            near.push(copyOf(C[i]));
          }
      // (Paving below the kerb's top, under the kerb itself, shows
      // nowhere: the kerb is drawn over it. Left there, it closes what
      // would be a crack under the kerb, between two roads at different
      // heights meeting at an island's point.)
      if (near.length) {
        // (This triangle's own plane, for its height under each kerb.)
        const det0 = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        const ay = pos[ia * 3 + 1], by = pos[ib * 3 + 1], cy = pos[ic * 3 + 1];
        const planeY = (x: number, z: number) => {
          const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det0, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det0;
          return l1 * ay + l2 * by + (1 - l1 - l2) * cy;
        };
        const foot = new Paths64();
        const had = new Set<number>();
        for (let gx = Math.floor(tx0 / G); gx <= Math.floor(tx1 / G); gx++)
          for (let gz = Math.floor(tz0 / G); gz <= Math.floor(tz1 / G); gz++)
            for (const i of KG.get(gx * 65536 + gz) ?? []) {
              if (had.has(i)) continue;
              had.add(i);
              const e = KE[i];
              if (e.length < 12 || Math.max(e[0], e[3], e[8], e[10]) < tx0 || Math.min(e[0], e[3], e[8], e[10]) > tx1 || Math.max(e[1], e[4], e[9], e[11]) < tz0 || Math.min(e[1], e[4], e[9], e[11]) > tz1) continue;
              // (Only a kerb whose top the paving stays under, each kerb by
              // its own top: round an island's point between two roads at
              // different heights, one side's kerb stands lower than the
              // other's.)
              if (Math.abs(det0) < 1e-9 || Math.max(planeY(e[0], e[1]), planeY(e[3], e[4]), planeY(e[8], e[9]), planeY(e[10], e[11])) > Math.min(e[2], e[5]) - 0.02) continue;
              const r = new Path64();
              // (Its inner side 5 cm into the road: on the outline's own
              // line, it left slivers a millimetre wide between it and the
              // cut, and the road there in hairline pieces.)
              const ix = -e[6] * 0.05, iz = -e[7] * 0.05;
              for (const [x, z] of [[e[8] + ix, e[9] + iz], [e[10] + ix, e[11] + iz], [e[3], e[4]], [e[0], e[1]]]) r.push(new Point64(Math.round(x * OUT_S), Math.round(z * OUT_S)));
              // (All one way round: two the other way over each other would cancel.)
              if (Clipper.area(r) < 0) r.reverse();
              foot.push(r);
            }
        if (foot.length) {
          const left = Clipper.Difference(near, foot, FillRule.NonZero);
          near.length = 0;
          for (const c of left) if (Math.abs(Clipper.area(c)) >= 100) near.push(c);
        }
      }
      if (!near.length) {
        keep.push(ia, ib, ic);
        continue;
      }
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(det) < 1e-9) continue;
      const tri = new Path64();
      for (const [x, z] of [[ax, az], [bx, bz], [cx, cz]]) tri.push(new Point64(Math.round(x * OUT_S), Math.round(z * OUT_S)));
      const subj = new Paths64();
      subj.push(tri);
      const left = Clipper.Difference(subj, near, FillRule.NonZero);
      // (Untouched, or all but: as it was. Under 25 cm² taken off, nothing
      // of it shows, and a long thin triangle of a junction's fan, cut for
      // so little, came back as needles with hairlines between them.)
      const lost = Math.abs(Clipper.area(tri)) - Math.abs(left.reduce((a, c) => a + Clipper.area(c), 0));
      if ((left.length === 1 && left[0].length === 3 && Math.abs(Math.abs(Clipper.area(left[0])) - Math.abs(Clipper.area(tri))) < 1) || Math.abs(lost) < 2500) {
        keep.push(ia, ib, ic);
        continue;
      }
      // (What is left, laid on the triangle's own plane, its points back on
      // its own corners where they are those: rounded to the millimetre, an
      // edge it shares with the next would open a hairline crack.)
      const V = [[ax, az, ia], [bx, bz, ib], [cx, cz, ic]] as const;
      const pt = (q: { x: number; y: number }): XZ => {
        for (const [x, z] of V) if (Math.abs(q.x - x * OUT_S) <= 2 && Math.abs(q.y - z * OUT_S) <= 2) return [x, z];
        return [q.x / OUT_S, q.y / OUT_S];
      };
      // (The library hands back every outer ring one way round and every
      // hole the other, whichever way the triangle ran: by its own sign, a
      // triangle wound the other way lost all its paving.)
      const outer = left.filter((r) => Clipper.area(r) > 0).map((r) => r.map(pt));
      const holes = left.filter((r) => Clipper.area(r) < 0).map((r) => r.map(pt));
      const sgn = Math.sign(det);
      // (Whatever the cut leaves must come out of the triangulation whole:
      // where a ring folds on itself it may not, and then the triangle is
      // kept as it was rather than lose paving inside the road.)
      let want = 0;
      for (const r of left) want += Clipper.area(r);
      const at0 = add.length, pos0 = pos.length, uv0 = uv.length;
      let got = 0;
      for (const o of outer) {
        const hs = holes.filter((h) => inRingXZ(o, h[0][0], h[0][1]));
        const all = [o, ...hs].flat();
        const base = pos.length / 3;
        for (const [x, z] of all) {
          const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det, l3 = 1 - l1 - l2;
          pos.push(x, l1 * pos[ia * 3 + 1] + l2 * pos[ib * 3 + 1] + l3 * pos[ic * 3 + 1], z);
          uv.push(l1 * uv[ia * 2] + l2 * uv[ib * 2] + l3 * uv[ic * 2], l1 * uv[ia * 2 + 1] + l2 * uv[ib * 2 + 1] + l3 * uv[ic * 2 + 1]);
        }
        // (Each new triangle wound as the one it is cut from, to face the same way.)
        for (const [p, q, r] of THREE.ShapeUtils.triangulateShape(o.map(([x, z]) => new THREE.Vector2(x, z)), hs.map((h) => h.map(([x, z]) => new THREE.Vector2(x, z))))) {
          const P = all[p], Q = all[q], R = all[r];
          const d = (Q[1] - R[1]) * (P[0] - R[0]) + (R[0] - Q[0]) * (P[1] - R[1]);
          add.push(base + p, base + (d * sgn < 0 ? r : q), base + (d * sgn < 0 ? q : r));
          got += Math.abs(d) / 2;
        }
      }
      if (Math.abs(got * OUT_S * OUT_S - Math.abs(want)) > Math.max(2500, Math.abs(want) * 0.01)) {
        add.length = at0, pos.length = pos0, uv.length = uv0;
        keep.push(ia, ib, ic);
      }
    }
    road.idx = keep.concat(add);
  }
  /**
   * Rebuild B: every wall, edge beam and parapet stands at its kerb's
   * outer edge, 1 cm out. Each is drawn beside its road, at its edge as the
   * road's strip has it and 0.36 m out; the kerb runs round the finished
   * outline, which where it was tidied lies a few centimetres off that
   * edge, and there the wall stood out past the kerb with a slot between
   * them, or the kerb ran into the wall. So each of the sheets band() drew
   * is brought, point by point, to the outer edge of the kerb beside it
   * (within 15 cm, at a height the sheet spans).
   */
  const kerbOuter = new Map<string, number[][]>();
  const WALL_SNAP = 0.15;
  /** How far a wall's piece may pass off the kerb points it skips, where it follows a kerb (m). */
  const WALL_BOW = 0.008;
  /**
   * The user's rule, 19 Nov: a raised road's sides are complete, no gap
   * showing its inside or underside. Each road draws its own side, and
   * where none of them owns a stretch of the outline's edge it was left
   * open: where a flyover splits, the through road's outside edge across
   * the split is past the end of one road's side and short of the start of
   * the next's (a 2.5 m slot at -3502,2717.8). So, once the sides are
   * drawn and brought to their kerbs, the kerb's outer edge is walked, and
   * wherever it stands over a drop with nothing drivable past it and no
   * side drawn along it, one is drawn there: a deck's edge beam and
   * parapet, or a raised road's wall and parapet, as tall as the fall.
   */
  /** How far the ground must fall past a raised road's edge for a missing side to be drawn there (m): less, and its side would be a kerb's height, nothing showing under it. */
  const GAP_DROP = 1;
  const gapWalls = new Map<string, { x0: number; z0: number; x1: number; z1: number; y0: number; y1: number; ph0: number; ph1: number }[]>();
  function* wallGaps(k: string, deck: Acc, kerb: Acc, kit: TileKit): Generator<void, void, void> {
    const E = kerbOuter.get(k) ?? [];
    let slice = performance.now();
    const pause = () => performance.now() - slice > 4;
    const G = 2;
    // (The upright sheets drawn so far, by 2 m square: [x0, z0, x1, z1, lo, hi].)
    const sheets: number[][] = [];
    const grid = new Map<number, number[]>();
    // (The flat pieces drawn so far, the decks' undersides, by 2 m square: their first index.)
    const unders: number[] = [];
    const ugrid = new Map<number, number[]>();
    const { pos, uv, idx } = deck;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ar = (pos[b] - pos[a]) * (pos[c + 2] - pos[a + 2]) - (pos[b + 2] - pos[a + 2]) * (pos[c] - pos[a]);
      const P = [a, b, c];
      let i0 = a, i1 = b, dm = -1;
      for (const u of P) for (const v of P) {
        const d = Math.hypot(pos[u] - pos[v], pos[u + 2] - pos[v + 2]);
        if (d > dm) (dm = d), (i0 = u), (i1 = v);
      }
      if (dm >= 0.05 && Math.abs(ar) / dm > 0.02) {
        // (A deck's underside: see hasUnder.)
        const n = unders.length;
        unders.push(t);
        for (let gx = Math.floor(Math.min(pos[a], pos[b], pos[c]) / G); gx <= Math.floor(Math.max(pos[a], pos[b], pos[c]) / G); gx++)
          for (let gz = Math.floor(Math.min(pos[a + 2], pos[b + 2], pos[c + 2]) / G); gz <= Math.floor(Math.max(pos[a + 2], pos[b + 2], pos[c + 2]) / G); gz++)
            (ugrid.get(gx * 65536 + gz) ?? ugrid.set(gx * 65536 + gz, []).get(gx * 65536 + gz)!).push(n);
      }
      if (dm < 0.05 || Math.abs(ar) / dm > 0.02) continue;
      const lo = Math.min(pos[a + 1], pos[b + 1], pos[c + 1]), hi = Math.max(pos[a + 1], pos[b + 1], pos[c + 1]);
      const n = sheets.length;
      // (Which way it faces, from its winding.)
      const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
      const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
      const fx = e1y * e2z - e1z * e2y, fz = e1x * e2y - e1y * e2x, fl = Math.hypot(fx, fz) || 1;
      sheets.push([pos[i0], pos[i0 + 2], pos[i1], pos[i1 + 2], lo, hi, fx / fl, fz / fl]);
      for (let gx = Math.floor(Math.min(pos[i0], pos[i1]) / G); gx <= Math.floor(Math.max(pos[i0], pos[i1]) / G); gx++)
        for (let gz = Math.floor(Math.min(pos[i0 + 2], pos[i1 + 2]) / G); gz <= Math.floor(Math.max(pos[i0 + 2], pos[i1 + 2]) / G); gz++)
          (grid.get(gx * 65536 + gz) ?? grid.set(gx * 65536 + gz, []).get(gx * 65536 + gz)!).push(n);
      if ((t & 1023) === 0 && pause()) {
        yield;
        slice = performance.now();
      }
    }
    /** The highest deck underside over (x, z) between 0.3 and 2 m under y; NaN if none. */
    const underY = (x: number, z: number, y: number) => {
      let best = NaN;
      for (const t of ugrid.get(Math.floor(x / G) * 65536 + Math.floor(z / G)) ?? []) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        const det = (pos[b + 2] - pos[c + 2]) * (pos[a] - pos[c]) + (pos[c] - pos[b]) * (pos[a + 2] - pos[c + 2]);
        if (Math.abs(det) < 1e-9) continue;
        const l1 = ((pos[b + 2] - pos[c + 2]) * (x - pos[c]) + (pos[c] - pos[b]) * (z - pos[c + 2])) / det, l2 = ((pos[c + 2] - pos[a + 2]) * (x - pos[c]) + (pos[a] - pos[c]) * (z - pos[c + 2])) / det;
        if (l1 < -1e-6 || l2 < -1e-6 || l1 + l2 > 1 + 1e-6) continue;
        const h = l1 * pos[a + 1] + l2 * pos[b + 1] + (1 - l1 - l2) * pos[c + 1];
        if (h < y - 0.3 && h > y - 2 && !(h <= best)) best = h;
      }
      return best;
    };
    /** Is there a deck's underside over (x, z), between 0.3 and 2 m under y? */
    const hasUnder = (x: number, z: number, y: number) =>
      (ugrid.get(Math.floor(x / G) * 65536 + Math.floor(z / G)) ?? []).some((t) => {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        const det = (pos[b + 2] - pos[c + 2]) * (pos[a] - pos[c]) + (pos[c] - pos[b]) * (pos[a + 2] - pos[c + 2]);
        if (Math.abs(det) < 1e-9) return false;
        const l1 = ((pos[b + 2] - pos[c + 2]) * (x - pos[c]) + (pos[c] - pos[b]) * (z - pos[c + 2])) / det, l2 = ((pos[c + 2] - pos[a + 2]) * (x - pos[c]) + (pos[a] - pos[c]) * (z - pos[c + 2])) / det;
        if (l1 < -1e-6 || l2 < -1e-6 || l1 + l2 > 1 + 1e-6) return false;
        const h = l1 * pos[a + 1] + l2 * pos[b + 1] + (1 - l1 - l2) * pos[c + 1];
        return h < y - 0.3 && h > y - 2;
      });
    /** Is there a sheet within 15 cm of (x, z) standing to `top`? Its foot, if so. */
    const sheetAt = (x: number, z: number, top: number) => {
      let foot = NaN;
      const gx = Math.floor(x / G), gz = Math.floor(z / G);
      for (const i of [-1, 0, 1].flatMap((a) => [-1, 0, 1].flatMap((b) => grid.get((gx + a) * 65536 + gz + b) ?? []))) {
        const [x0, z0, x1, z1, lo, hi] = sheets[i];
        if (hi < top) continue;
        const dx = x1 - x0, dz = z1 - z0, L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / L2));
        if (Math.hypot(x0 + dx * t - x, z0 + dz * t - z) < 0.15) foot = foot === foot ? Math.min(foot, lo) : lo;
      }
      return foot;
    };
    // (Is the edge at (x, z) one a road draws its own side along: beside
    // one of its pieces, square to it and between its ends, at its level?
    // Asked of the roads' lines, not of what is drawn: a road's side may lie
    // in the next tile, not built yet. Past the end of every road, where a
    // split's through road hands on to its branch, nobody draws it.)
    const owned = (x: number, z: number, y: number, nx: number, nz: number) => {
      let hit = false;
      // (Its wall's end is cut back to where a circle the size of a nose's
      // round, just past the road's edge, lies clear of all other paving:
      // see openBesideOf. So a road owns the edge only where that holds.)
      const R = NOSE_R - 0.02;
      const cx = x + nx * 0.14, cz = z + nz * 0.14;
      roads.each(x, z, 16, (i, seg) => {
        if (hit || JX.internal[i]) return;
        const P = EP[i], a = P[seg], b = P[seg + 1];
        const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
        const u = ((x - a[0]) * dx + (z - a[1]) * dz) / L2;
        if ((u < -0.01 && seg === 0) || (u > 1.01 && seg === P.length - 2)) return;
        const uc = Math.max(0, Math.min(1, u));
        const d = Math.hypot(a[0] + dx * uc - x, a[1] + dz * uc - z);
        if (d > halfNear(i, seg, uc) + 0.9) return;
        const at = ECUM[i][seg] + uc * (ECUM[i][seg + 1] - ECUM[i][seg]);
        if (at < (JX.trimA[i] || 0) - 0.05 || at > ELEN[i] - (JX.trimB[i] || 0) + 0.05) return;
        if (Math.abs((hasProfile[i] ? deckAtHit(i, seg, uc) : heightAt(x, z)) + ROAD_LIFT - y) > 0.5) return;
        // (Drawn in this tile, what was drawn answers: see gapsOf.)
        if (tileKey((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) === k) return;
        const clear = (px: number, pz: number) => !coveredBy(i, px, pz, y) && !inJoint(px, pz, y) && !inGore(px, pz) && !inNose(px, pz) && !(oneLine && onPaved(px, pz, y));
        let ok = clear(cx, cz);
        for (let q = 0; q < 8 && ok; q++) ok = clear(cx + Math.cos((q * Math.PI) / 4) * R, cz + Math.sin((q * Math.PI) / 4) * R);
        hit = ok;
      });
      return hit;
    };
    // (Only beside a raised road or a deck, at its level: a road on the ground has no sides of its own.)
    const raisedBy = (x: number, z: number, y: number) => {
      let hit = false;
      roads.each(x, z, 16, (i, seg, u, d) => {
        if (!hit && hasProfile[i] && !JX.internal[i] && d < halfNear(i, seg, u) + 2) hit = Math.abs(deckAtHit(i, seg, u) + ROAD_LIFT - y) < 0.5;
      });
      return hit;
    };
    // (How far in from a deck's edge at (x, z) its own underside begins, a
    // little past it: a deck road's strip, drawn with one, or a junction's
    // on a deck. 0 where none lies within 8 m.)
    const underIn = (x: number, z: number, y: number) => {
      const has = (px: number, pz: number) => {
        let hit = false;
        roads.each(px, pz, 16, (i, seg, u, d) => {
          if (!hit && isDeck[i] && !JX.internal[i] && lvlOf(i, seg) >= 0 && d < halfNear(i, seg, u) + WALL_OUT - 0.05) hit = Math.abs(deckAtHit(i, seg, u) + ROAD_LIFT - y) < 0.5;
        });
        return hit || inJoint(px, pz, y);
      };
      for (let t = 0.1; t <= 8; t += 0.25) if (has(x - on[0] * t, z - on[1] * t)) return t + 0.3;
      return 0;
    };
    // (The fall past an edge, from y, at 0.6 and 1.6 m out along (nx, nz):
    // to the ground as drawn, its lattice, and, where that falls by more
    // than `need`, no further than to the plan's ground too. The drawn
    // ground alone lies under an island's lawn where it banks down from the
    // kerb, and a wall with a parapet and a square end stood on the bank at
    // 1867.7,1862.1, the grass reaching the kerb already. Asked of the plan
    // only past `need`: heightAt near a ramp is slow.)
    const fallAt = (y: number, x: number, z: number, nx: number, nz: number, need: number) => {
      const g = y - Math.min(groundY(x + nx * 0.6, z + nz * 0.6), groundY(x + nx * 1.6, z + nz * 1.6));
      return g > need ? Math.min(g, y - Math.min(heightAt(x + nx * 0.6, z + nz * 0.6), heightAt(x + nx * 1.6, z + nz * 1.6))) : g;
    };
    const out: { x0: number; z0: number; x1: number; z1: number; y0: number; y1: number; ph0: number; ph1: number }[] = [];
    const acc = { pos, uv, idx };
    // (A side drawn here, known from then on to what follows.)
    const addSheet = (ax: number, az: number, bx: number, bz: number, lo: number, hi: number) => {
      const n = sheets.length;
      sheets.push([ax, az, bx, bz, lo, hi, on[0], on[1]]);
      for (let gx = Math.floor(Math.min(ax, bx) / G); gx <= Math.floor(Math.max(ax, bx) / G); gx++)
        for (let gz = Math.floor(Math.min(az, bz) / G); gz <= Math.floor(Math.max(az, bz) / G); gz++)
          (grid.get(gx * 65536 + gz) ?? grid.set(gx * 65536 + gz, []).get(gx * 65536 + gz)!).push(n);
    };
    /**
     * A wall broken by a slot: two sides that run on in one line, end
     * facing end, a hand's width to a couple of metres apart, with the
     * ground far below between them. Each road's side was drawn to its own
     * end and neither carried on (a 0.3 m slit of sky through the parapet
     * at 1766.3,1392). The slot is closed with a side as tall as the two
     * either end of it. (Roads that pass through a wall leave a gap wider
     * than a lane, and are not taken for a slot.)
     */
    function* closeSlits(): Generator<void, void, void> {
      // (Each upright, by its line on the ground: its foot and top, and its face.)
      const segs = new Map<string, number[]>();
      const r2 = (v: number) => Math.round(v * 50);
      for (const sh of sheets) {
        const [x0, z0, x1, z1, lo, hi, fx, fz] = sh;
        const [ka, kb] = [`${r2(x0)},${r2(z0)}`, `${r2(x1)},${r2(z1)}`].sort();
        const key = `${ka}|${kb}`;
        const g = segs.get(key);
        if (g) (g[4] = Math.min(g[4], lo)), (g[5] = Math.max(g[5], hi));
        else segs.set(key, [x0, z0, x1, z1, lo, hi, fx, fz]);
      }
      const list = [...segs.values()].filter((g) => g[5] - g[4] >= 0.5 && Math.hypot(g[2] - g[0], g[3] - g[1]) >= 0.2);
      const SG = 4;
      const sgrid = new Map<number, number[]>();
      list.forEach((g, i) => {
        for (let gx = Math.floor(Math.min(g[0], g[2]) / SG); gx <= Math.floor(Math.max(g[0], g[2]) / SG); gx++)
          for (let gz = Math.floor(Math.min(g[1], g[3]) / SG); gz <= Math.floor(Math.max(g[1], g[3]) / SG); gz++)
            (sgrid.get(gx * 65536 + gz) ?? sgrid.set(gx * 65536 + gz, []).get(gx * 65536 + gz)!).push(i);
      });
      const nearSegs = (x: number, z: number, r: number) => {
        const got = new Set<number>();
        for (let gx = Math.floor((x - r) / SG); gx <= Math.floor((x + r) / SG); gx++)
          for (let gz = Math.floor((z - r) / SG); gz <= Math.floor((z + r) / SG); gz++) for (const i of sgrid.get(gx * 65536 + gz) ?? []) got.add(i);
        return got;
      };
      // (An end is free where no other upright carries on from it, or past it, at its height.)
      const free = (x: number, z: number, lo: number, hi: number, self: number) => {
        for (const j of nearSegs(x, z, 0.1)) {
          if (j === self) continue;
          const g = list[j];
          if (g[5] < lo + 0.3 || g[4] > hi - 0.3) continue;
          const dx = g[2] - g[0], dz = g[3] - g[1], L2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((x - g[0]) * dx + (z - g[1]) * dz) / L2));
          if (Math.hypot(g[0] + dx * t - x, g[1] + dz * t - z) < 0.06) return false;
        }
        return true;
      };
      // (Each free end: [x, z, lo, hi, way out x, way out z, face x, face z, segment].)
      const ends: number[][] = [];
      list.forEach((g, i) => {
        const L = Math.hypot(g[2] - g[0], g[3] - g[1]);
        for (const e of [0, 1]) {
          const x = e ? g[2] : g[0], z = e ? g[3] : g[1];
          if (free(x, z, g[4], g[5], i)) ends.push([x, z, g[4], g[5], ((e ? 1 : -1) * (g[2] - g[0])) / L, ((e ? 1 : -1) * (g[3] - g[1])) / L, g[6], g[7], i]);
        }
      });
      if (pause()) {
        yield;
        slice = performance.now();
      }
      const used = new Set<number>();
      for (let a = 0; a < ends.length; a++) {
        if (pause()) {
          yield;
          slice = performance.now();
        }
        if (used.has(a)) continue;
        const A = ends[a];
        let best = -1, bd = 2.5;
        for (let b = 0; b < ends.length; b++) {
          if (b === a || used.has(b)) continue;
          const B = ends[b];
          if (B[8] === A[8]) continue;
          const dx = B[0] - A[0], dz = B[1] - A[1], d = Math.hypot(dx, dz);
          if (d < 0.03 || d >= bd) continue;
          // (In one line: each runs on towards the other, and both face the same way.)
          if ((dx * A[4] + dz * A[5]) / d < 0.97 || -(dx * B[4] + dz * B[5]) / d < 0.97 || A[6] * B[6] + A[7] * B[7] < 0.9) continue;
          if (Math.min(A[3], B[3]) - Math.max(A[2], B[2]) < 0.5) continue;
          (best = b), (bd = d);
        }
        if (best < 0) continue;
        const B = ends[best];
        // (Only over a fall: a slot in a wall standing on the ground shows nothing under it.)
        const top = Math.min(A[3], B[3]);
        let dr = Infinity;
        for (const t of [0.25, 0.5, 0.75]) {
          const x = A[0] + (B[0] - A[0]) * t, z = A[1] + (B[1] - A[1]) * t;
          dr = Math.min(dr, fallAt(top - PARAPET_H, x, z, A[6], A[7], GAP_DROP));
        }
        if (!(dr > GAP_DROP)) continue;
        used.add(a), used.add(best);
        (on[0] = A[6]), (on[1] = A[7]);
        // (Run 2 cm into each side, so no hairline shows where they meet.)
        const L = Math.hypot(B[0] - A[0], B[1] - A[1]), ux = (B[0] - A[0]) / L, uz = (B[1] - A[1]) / L;
        const ax = A[0] - ux * 0.02, az = A[1] - uz * 0.02, bx = B[0] + ux * 0.02, bz = B[1] + uz * 0.02;
        // (Along the kerb between them, not straight across it: round a
        // curve, a side drawn as one chord stood 11 cm out past the kerb at
        // 92.8,2763.8. Each point between is put on the kerb's outer edge
        // nearest it, at its level, a centimetre out.)
        const pts: number[][] = [[ax, az, 0]];
        const n = Math.max(1, Math.ceil(L / 0.25));
        for (let q = 1; q < n; q++) {
          const t = q / n, x = A[0] + (B[0] - A[0]) * t, z = A[1] + (B[1] - A[1]) * t, y = A[3] + (B[3] - A[3]) * t - PARAPET_H;
          let bd = 0.3, px = x, pz = z;
          for (const e of E) {
            if (Math.min(e[2], e[5]) > y + 0.6 || Math.max(e[2], e[5]) < y - 0.6) continue;
            const dx = e[3] - e[0], dz = e[4] - e[1], l2 = dx * dx + dz * dz;
            if (!(l2 > 1e-8)) continue;
            const u = Math.max(0, Math.min(1, ((x - e[0]) * dx + (z - e[1]) * dz) / l2));
            const qx = e[0] + dx * u, qz = e[1] + dz * u, dd = Math.hypot(qx - x, qz - z);
            if (dd < bd) (bd = dd), (px = qx + e[6] * 0.01), (pz = qz + e[7] * 0.01);
          }
          pts.push([px, pz, t]);
        }
        pts.push([bx, bz, 1]);
        let s = 0;
        for (let q = 0; q + 1 < pts.length; q++) {
          const [px, pz, ta] = pts[q], [qx, qz, tb] = pts[q + 1];
          const lo0 = A[2] + (B[2] - A[2]) * ta, hi0 = A[3] + (B[3] - A[3]) * ta, lo1 = A[2] + (B[2] - A[2]) * tb, hi1 = A[3] + (B[3] - A[3]) * tb;
          quad(px, pz, lo0, hi0, qx, qz, lo1, hi1, s);
          s += Math.hypot(qx - px, qz - pz);
          out.push({ x0: px, z0: pz, x1: qx, z1: qz, y0: hi0 - PARAPET_H, y1: hi1 - PARAPET_H, ph0: PARAPET_H, ph1: PARAPET_H });
          addSheet(px, pz, qx, qz, Math.max(lo0, lo1), Math.min(hi0, hi1));
        }
      }
    }
    const quad = (ax: number, az: number, a0: number, a1: number, bx: number, bz: number, b0: number, b1: number, s: number) => {
      const q = acc.pos.length / 3;
      acc.pos.push(ax, a0, az, ax, a1, az, bx, b0, bz, bx, b1, bz);
      acc.uv.push(0, s / 6, 1, s / 6, 0, (s + Math.hypot(bx - ax, bz - az)) / 6, 1, (s + Math.hypot(bx - ax, bz - az)) / 6);
      // (One face, facing out over the drop: the material shows both. Both
      // drawn, the two faces' shading fought, a pale patch in the beam.)
      if ((az - bz) * on[0] + (bx - ax) * on[1] > 0) acc.idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
      else acc.idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2);
    };
    const on = [0, 0];
    yield* closeSlits();
    // (Where along an edge, as fractions of it, no side drawn so far
    // stands: none within 15 cm of its line reaching `up` over the road and
    // down to `foot` from it. Measured, not sampled: sampled every half
    // metre, a 30 cm slot in a parapet at -3262.1,-1777.9 lay between two
    // samples, each within reach of a panel.)
    const gapsOf = (x0: number, z0: number, x1: number, z1: number, yr0: number, yr1: number, up: number, foot: number, near = 0.15) => {
      const L = Math.hypot(x1 - x0, z1 - z0), ux = (x1 - x0) / L, uz = (z1 - z0) / L;
      const seen = new Set<number>();
      const iv: number[][] = [];
      for (let gx = Math.floor((Math.min(x0, x1) - 0.2) / G); gx <= Math.floor((Math.max(x0, x1) + 0.2) / G); gx++)
        for (let gz = Math.floor((Math.min(z0, z1) - 0.2) / G); gz <= Math.floor((Math.max(z0, z1) + 0.2) / G); gz++)
          for (const i of grid.get(gx * 65536 + gz) ?? []) {
            if (seen.has(i)) continue;
            seen.add(i);
            const [sx0, sz0, sx1, sz1, lo, hi] = sheets[i];
            if (Math.abs((sx0 - x0) * -uz + (sz0 - z0) * ux) > near || Math.abs((sx1 - x0) * -uz + (sz1 - z0) * ux) > near) continue;
            const t0 = ((sx0 - x0) * ux + (sz0 - z0) * uz) / L, t1 = ((sx1 - x0) * ux + (sz1 - z0) * uz) / L;
            const ta = Math.min(t0, t1), tb = Math.max(t0, t1);
            if (tb < 0 || ta > 1) continue;
            const yr = yr0 + (yr1 - yr0) * Math.max(0, Math.min(1, (ta + tb) / 2));
            if (hi < yr + up || lo > yr + foot) continue;
            iv.push([ta, tb]);
          }
      iv.sort((p, q) => p[0] - q[0]);
      const gaps: number[][] = [];
      let at = 0;
      for (const [ta, tb] of iv) {
        if (ta > at + 0.02 / L) gaps.push([at, Math.min(1, ta)]);
        at = Math.max(at, tb);
        if (at >= 1) break;
      }
      if (at < 1 - 0.02 / L) gaps.push([at, 1]);
      return gaps;
    };
    // (The raised roads and decks in reach of this tile, by 8 m square: a
    // kerb nowhere near one wants no side of a raised road's, and asking
    // every kerb on the map the full question cost a fifth of all building.)
    const RG = 8;
    const rgrid = new Map<number, number[][]>();
    {
      const [ti, tj] = k.split(',').map(Number);
      roads.each((ti + 0.5) * TILE, (tj + 0.5) * TILE, TILE * 0.75 + 25, (i, seg) => {
        if (!hasProfile[i] || JX.internal[i]) return;
        const a = EP[i][seg], b = EP[i][seg + 1], r = halfNear(i, seg, 0.5) + 2.5;
        for (let gx = Math.floor((Math.min(a[0], b[0]) - r) / RG); gx <= Math.floor((Math.max(a[0], b[0]) + r) / RG); gx++)
          for (let gz = Math.floor((Math.min(a[1], b[1]) - r) / RG); gz <= Math.floor((Math.max(a[1], b[1]) + r) / RG); gz++)
            (rgrid.get(gx * 65536 + gz) ?? rgrid.set(gx * 65536 + gz, []).get(gx * 65536 + gz)!).push([a[0], a[1], b[0], b[1], r]);
      });
    }
    const nearRaised = (x: number, z: number, extra: number) =>
      (rgrid.get(Math.floor(x / RG) * 65536 + Math.floor(z / RG)) ?? []).some(([ax, az, bx, bz, r]) => {
        const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
        return Math.hypot(ax + dx * t - x, az + dz * t - z) < r + extra;
      });
    for (const e of E) {
      // (Before each edge, not after: most go on to the next before the
      // end, and a run of them held a slice up 168 ms at 1974,582.)
      if (pause()) {
        yield;
        slice = performance.now();
      }
      const [x0, z0, y0, x1, z1, y1, nx, nz] = e;
      (on[0] = nx), (on[1] = nz);
      const L = Math.hypot(x1 - x0, z1 - z0);
      // (Short ones too: round the point of a V where two decks part, the kerb is in pieces of 3 cm.)
      if (!(L > 0.005) || !(y0 === y0 && y1 === y1)) continue;
      if (!nearRaised((x0 + x1) / 2, (z0 + z1) / 2, L / 2)) continue;
      const P = (t: number) => [x0 + (x1 - x0) * t + nx * 0.01, z0 + (z1 - z0) * t + nz * 0.01, y0 + (y1 - y0) * t - 0.03];
      // (Under a deck's edge beam standing with nothing in from its foot:
      // the user's rule S4, 19 Nov. Round the point of a V where two decks
      // part, the kerb rounds out past both roads' strips and their
      // undersides, and from below the beam round it was a ring with the
      // paving's underside showing up inside, at -3261.4,-1776.3. An
      // underside in from the beam's foot to the deck's own.)
      for (let q = 0, m = Math.max(1, Math.ceil(L / 0.5)); q < m; q++) {
        const [ax, az, ya] = P(q / m), [bx, bz, yb] = P((q + 1) / m);
        const mx = (ax + bx) / 2, mz = (az + bz) / 2, my = (ya + yb) / 2;
        if (my - groundY(mx - nx * 0.6, mz - nz * 0.6) < JOINT_DECK_FROM || hasUnder(mx - nx * 0.1, mz - nz * 0.1, my)) continue;
        const foot = sheetAt(mx, mz, my - 0.05);
        if (!(foot === foot) || my - foot < 0.3 || my - foot > 2) continue;
        const w = underIn(mx, mz, my);
        // (Not where a deck road's own strip begins right in from the edge:
        // its underside is there, drawn after this tile's sides perhaps, and
        // a piece at the beam's foot under it stood out in steps, a saw along
        // a flyover's edge seen from below at 1777.1,1394.5.)
        if (!(w > 0.41)) continue;
        // (The plan's ground asked last, once the rest hold: by a raised
        // road heightAt is slow, and asked first it was most of a second of
        // the trial map's start.)
        if (my - heightAt(mx - nx * 0.6, mz - nz * 0.6) < JOINT_DECK_FROM) continue;
        // (Its inner edge up on the deck's own underside where it reaches
        // one: left at the beam's foot, 0.2 m under it, its inner edge was a
        // saw along a flyover's underside, seen from the road below at
        // 1776.6,1390.7.)
        const f = foot + 0.005, v = acc.pos.length / 3;
        const ua = underY(ax - nx * w, az - nz * w, my), ub = underY(bx - nx * w, bz - nz * w, my);
        acc.pos.push(ax, f, az, bx, f, bz, bx - nx * w, ub === ub ? Math.max(f, ub - 0.003) : f, bz - nz * w, ax - nx * w, ua === ua ? Math.max(f, ua - 0.003) : f, az - nz * w);
        acc.uv.push(0, 0, 1, 0, 1, w / 6, 0, w / 6);
        acc.idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
      }
      // (Where no parapet stands, and where nothing stands below the road either.)
      const tall = gapsOf(x0, z0, x1, z1, y0 - 0.03, y1 - 0.03, 0.6, 0.3);
      if (!tall.length) continue;
      const bare = gapsOf(x0, z0, x1, z1, y0 - 0.03, y1 - 0.03, -0.1, -0.5);
      const isBare = (t: number) => bare.some(([a, b]) => t >= a && t <= b);
      // (Does the edge want a side at t: a drop past it, beside a raised
      // road, nothing drivable or paved past it at its level, and no road in
      // the next tile drawing its own side along it?)
      const wants = (t: number) => {
        const [x, z, yr] = P(t);
        const dr = fallAt(yr, x, z, nx, nz, GAP_DROP);
        if (!(dr > GAP_DROP) || !raisedBy(x, z, yr)) return NaN;
        const goesOn = (o: number) => {
          const ox = x + nx * o, oz = z + nz * o;
          return onPaved(ox, oz, yr) || inPaving(ox, oz, yr) || inGore(ox, oz) || inNose(ox, oz) || drawnRoadAt(ox, oz, yr);
        };
        const ix = x - nx * 0.5, iz = z - nz * 0.5;
        if (goesOn(0.6) || goesOn(1.0) || inJoint(ix, iz, yr) || inPaving(ix, iz, yr) || owned(x, z, yr, nx, nz)) return NaN;
        // (Nor across a narrow island to a road at its own level, the
        // island's lawn laid kerb to kerb between them (see islandSheet:
        // kerbs within a metre of each other's height, on ground within
        // ISLE_DEEP of the kerb's top, NARROW_DEEP under 3 m across). A wall
        // with a parapet stood up out of the lawn there, its end square, at
        // 1262.5,1902.9. Counted to the far road's surface, a little past
        // its kerb: held short of 3 m, never a side left out where no lawn
        // is laid.)
        // (The ground first, it is quick: asked at every quarter metre
        // out, beside every wall, the roads near held a slice up 133 ms.)
        const gk = yr - groundY(x + nx * KERB_OUT, z + nz * KERB_OUT);
        if (gk <= NARROW_DEEP)
          for (let o = 1.25; o <= 6; o += 0.25) {
            const h = drawnRoadY(x + nx * o, z + nz * o, yr);
            if (!(h === h)) continue;
            if (Math.abs(h + ROAD_LIFT + 0.12 - yr) < 0.5 && gk <= (o <= 3.25 ? NARROW_DEEP : ISLE_DEEP)) return NaN;
            break;
          }
        return dr;
      };
      const under = (x: number, z: number, y: number) => {
        const g = y - groundY(x - nx * 0.6, z - nz * 0.6);
        return g < JOINT_DECK_FROM ? g : Math.min(g, y - heightAt(x - nx * 0.6, z - nz * 0.6));
      };
      for (const [ga, gb] of tall) {
        const m = Math.max(1, Math.ceil(((gb - ga) * L) / 0.5));
        for (let q = 0; q < m; q++) {
          const pa = ga + ((gb - ga) * q) / m, pb = ga + ((gb - ga) * (q + 1)) / m;
          const dm = wants((pa + pb) / 2);
          if (!(dm === dm)) continue;
          // (Carried 3 cm into the side it meets at either end of the gap, so no hairline shows between them.)
          const ta = q === 0 && ga > 0 ? pa - 0.03 / L : pa, tb = q === m - 1 && gb < 1 ? pb + 0.03 / L : pb;
          const [ax, az, ya] = P(ta), [bx, bz, yb] = P(tb);
          const da = Math.max(0, ya - Math.min(groundY(ax + nx * 0.6, az + nz * 0.6), groundY(ax + nx * 1.6, az + nz * 1.6)));
          const db = Math.max(0, yb - Math.min(groundY(bx + nx * 0.6, bz + nz * 0.6), groundY(bx + nx * 1.6, bz + nz * 1.6)));
          // (Its parapet as tall as the plan's fall asks, its wall as deep as the drawn ground's.)
          const pa_ = Math.max(0, fallAt(ya, ax, az, nx, nz, PARAPET_FROM)), pb_ = Math.max(0, fallAt(yb, bx, bz, nx, nz, PARAPET_FROM));
          const s = Math.hypot(ax - x0, az - z0);
          // (Below the road too, only where nothing stands there yet: a beam or wall drawn twice over fights itself.)
          const low = isBare((pa + pb) / 2);
          // (A deck's edge where the ground under the road itself lies well down; a raised road's wall to the ground elsewhere.)
          if (under(ax, az, ya) >= JOINT_DECK_FROM && under(bx, bz, yb) >= JOINT_DECK_FROM) {
            if (low) {
              // (As deep as the beam beside it, where one is near.)
              let foot = NaN;
              for (const r of [0.5, 1.5, 3]) {
                for (const sg of [-1, 1]) {
                  const f = sheetAt(ax + ((bx - ax) / (Math.hypot(bx - ax, bz - az) || 1)) * r * sg, az + ((bz - az) / (Math.hypot(bx - ax, bz - az) || 1)) * r * sg, ya - 0.05);
                  if (f === f && ya - f < 1.6) foot = foot === foot ? Math.max(foot, f) : f;
                }
                if (foot === foot) break;
              }
              const depth = foot === foot ? Math.max(0.6, ya - foot) : 1.2;
              // (And under it, in from the beam to the deck's own underside:
              // the user's rule S4, 19 Nov. Round a nose between two decks,
              // the paving out past each road's strip had no underside, and
              // from the road below the beam round it was a ring with the
              // paving's dark underside showing up through it, at
              // 1821.8,1624.3. Where no deck lies in from it at all, a
              // raised road's wall instead, down to the ground.)
              const w = underIn((ax + bx) / 2, (az + bz) / 2, (ya + yb) / 2);
              if (w > 0) {
                quad(ax, az, ya - depth, ya, bx, bz, yb - depth, yb, s);
                const q = acc.pos.length / 3;
                acc.pos.push(ax, ya - depth, az, bx, yb - depth, bz, bx - nx * w, yb - depth, bz - nz * w, ax - nx * w, ya - depth, az - nz * w);
                acc.uv.push(0, 0, 1, 0, 1, w / 6, 0, w / 6);
                acc.idx.push(q, q + 1, q + 2, q, q + 2, q + 3);
              } else quad(ax, az, ya - da - 0.3, ya, bx, bz, yb - db - 0.3, yb, s);
            }
            quad(ax, az, ya, ya + PARAPET_H, bx, bz, yb, yb + PARAPET_H, s);
            out.push({ x0: ax, z0: az, x1: bx, z1: bz, y0: ya, y1: yb, ph0: PARAPET_H, ph1: PARAPET_H });
            addSheet(ax, az, bx, bz, Math.min(ya, yb) - (low ? 0.6 : 0), Math.max(ya, yb) + PARAPET_H);
          } else {
            if (low) quad(ax, az, ya - da - 0.3, ya + wallTop(pa_), bx, bz, yb - db - 0.3, yb + wallTop(pb_), s);
            quad(ax, az, ya, ya + parapetTop(pa_), bx, bz, yb, yb + parapetTop(pb_), s);
            out.push({ x0: ax, z0: az, x1: bx, z1: bz, y0: ya, y1: yb, ph0: parapetTop(pa_), ph1: parapetTop(pb_) });
            addSheet(ax, az, bx, bz, Math.min(ya - (low ? da + 0.3 : 0), yb - (low ? db + 0.3 : 0)), Math.max(ya + parapetTop(pa_), yb + parapetTop(pb_)));
          }
        }
      }
    }
    // (The user's rule S3, 19 Nov: wherever a road stands over the ground
    // beside it, a face from its kerb down to the ground. Each road is drawn
    // 0.2 to 0.25 m over the ground sealed under it, its kerb 0.15 m over
    // that, and nothing closed the kerb's outer side: from the verge, or
    // from a road lower beside it, the ground showed on under the kerb. So
    // wherever nothing stands under a kerb's outer edge, its side is drawn
    // down to the ground as drawn, the 4 m lattice's, a little into it.)
    for (const e of E) {
      const [x0, z0, y0, x1, z1, y1, nx, nz] = e;
      const L = Math.hypot(x1 - x0, z1 - z0);
      if (!(L > 0.005) || !(y0 === y0 && y1 === y1)) continue;
      const P = (t: number) => [x0 + (x1 - x0) * t + nx * 0.002, z0 + (z1 - z0) * t + nz * 0.002, y0 + (y1 - y0) * t];
      (on[0] = nx), (on[1] = nz);
      // (Only a side standing within 4.5 cm of the kerb's edge closes it:
      // round a tight corner in centimetre pieces, a wall 0.1 m off was
      // taken for the kerb's own side and the corner left open, I2 at
      // -2772.4,2246.3; and one 5.5 cm off left a kerb's end open at
      // 1624.5,-474.4, the watertight check asking for 5.)
      // (And reaching up to within 3 cm of its top: a wall standing 10 cm
      // under a kerb's top, at the road's level, left a slit along under
      // the kerb at -2642.3,-2262 and -3483.8,-1485.6. Down to the ground:
      // stopped at that wall's top, a piece raised beside a wall's end hung
      // open over the ground at 1683.5,2396.2.)
      for (const [ga, gb] of gapsOf(x0, z0, x1, z1, y0, y1, -0.03, -0.12, 0.045)) {
        const m = Math.max(1, Math.ceil(((gb - ga) * L) / 0.5));
        for (let q = 0; q < m; q++) {
          const [ax, az, ya] = P(ga + ((gb - ga) * q) / m), [bx, bz, yb] = P(ga + ((gb - ga) * (q + 1)) / m);
          let fa = groundY(ax + nx * 0.05, az + nz * 0.05) - 0.05, fb = groundY(bx + nx * 0.05, bz + nz * 0.05) - 0.05;
          if (ya - fa < 0.1 && yb - fb < 0.1) continue;
          // (A deck's kerb, the ground well down under the road itself: as
          // deep as its edge beam, not to the ground. Down to the ground, a
          // gap of 0.4 m in a flyover's beam stood a needle 10 m tall up to
          // it from the grass at 1777.7,1399.1. Only a deck's, a deck road's
          // strip in from it: a road raised on its walls kept to the ground,
          // or its walls stood open at 1147.6,1933.3. And only with room to
          // see under it, 2.5 m under its beam: lower, the gap under the
          // beam was a slit 0.9 m tall at 1228.4,1900.)
          if (ya - groundY(ax - nx * 0.6, az - nz * 0.6) >= DECK_DEPTH + 2.5 && underIn(ax, az, ya) > 0) fa = Math.max(fa, ya - DECK_DEPTH);
          if (yb - groundY(bx - nx * 0.6, bz - nz * 0.6) >= DECK_DEPTH + 2.5 && underIn(bx, bz, yb) > 0) fb = Math.max(fb, yb - DECK_DEPTH);
          // (Under an island's lawn carrying on from the kerb's top too: it
          // is hidden there. Left out wherever an island's ground was raised
          // near the kerb, it was left out beside a slip road 0.8 m over the
          // expressway, its kerb 9 cm from the expressway's, at 1339.2,575.5,
          // where no lawn was laid.)
          const v = kerb.pos.length / 3, sd = Math.hypot(ax - x0, az - z0);
          kerb.pos.push(ax, Math.min(fa, ya), az, ax, ya, az, bx, Math.min(fb, yb), bz, bx, yb, bz);
          kerb.uv.push(sd, 0, sd, 0.2, sd + Math.hypot(bx - ax, bz - az), 0, sd + Math.hypot(bx - ax, bz - az), 0.2);
          if ((az - bz) * nx + (bx - ax) * nz > 0) kerb.idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
          else kerb.idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
        }
      }
      if (pause()) {
        yield;
        slice = performance.now();
      }
    }
    // (Each parapet stops the car as the roads' own do: see the deck barriers.)
    for (const w of out) {
      const sl = Math.hypot(w.x1 - w.x0, w.z1 - w.z0), ph = Math.min(w.ph0, w.ph1);
      if (sl < 0.05 || ph < 0.3) continue;
      const yaw = Math.atan2(-(w.z1 - w.z0), w.x1 - w.x0), y = (w.y0 + w.y1) / 2;
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(sl / 2, ph / 2, 0.15)
          .setTranslation((w.x0 + w.x1) / 2, y + ph / 2, (w.z0 + w.z1) / 2)
          .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }),
        tileBody(kit),
      );
    }
    gapWalls.set(k, out);
  }
  function* wallsToKerb(k: string, deck: Acc): Generator<void, void, void> {
    const E = kerbOuter.get(k), runs = bandSheets.get(deck);
    if (!E?.length || !runs?.length) return;
    let slice = performance.now();
    const pause = () => performance.now() - slice > 4;
    const G = 2;
    const grid = new Map<number, number[]>();
    E.forEach((e, i) => {
      for (let gx = Math.floor((Math.min(e[0], e[3]) - WALL_SNAP) / G); gx <= Math.floor((Math.max(e[0], e[3]) + WALL_SNAP) / G); gx++)
        for (let gz = Math.floor((Math.min(e[1], e[4]) - WALL_SNAP) / G); gz <= Math.floor((Math.max(e[1], e[4]) + WALL_SNAP) / G); gz++) {
          const key = gx * 65536 + gz;
          (grid.get(key) ?? grid.set(key, []).get(key)!).push(i);
        }
    });
    const { pos, uv, idx } = deck;
    /** Where each sheet's foot was brought to: [edge, t along it], by its first vertex. */
    const at = new Map<number, [number, number]>();
    for (let r = 0; r < runs.length; r += 2) {
      for (let v = runs[r]; v < runs[r] + runs[r + 1]; v += 2) {
        const x = pos[v * 3], yb = pos[v * 3 + 1], z = pos[v * 3 + 2], yt = pos[v * 3 + 4];
        let best = WALL_SNAP, to: XZ | null = null, on: [number, number] | null = null;
        // (Only to the highest kerb in reach, the wall's own road's, and to
        // none more than 0.3 m under it: a slip road's wall, its kerb 9 cm
        // from the expressway's 0.8 m below at 1339.2,575.5, was brought
        // to the expressway's kerb, facing the other way, and stood 6 cm in
        // under its own kerb's edge, the kerb's underside showing.)
        let topK = -Infinity, upTo = -Infinity;
        for (const pass of [0, 1])
        for (const i of grid.get(Math.floor(x / G) * 65536 + Math.floor(z / G)) ?? []) {
          const e = E[i];
          const dx = e[3] - e[0], dz = e[4] - e[1], L = Math.hypot(dx, dz);
          if (L < 1e-6) continue;
          const t = ((x - e[0]) * dx + (z - e[1]) * dz) / (L * L);
          // (Past either end by no more than 5 cm: round a bend the next side's.)
          if (t < -0.05 / L || t > 1 + 0.05 / L) continue;
          const tc = Math.max(0, Math.min(1, t));
          const yk = e[2] + (e[5] - e[2]) * tc;
          // (Up to 20 cm over the sheet's top: where the road leans up toward
          // this side its kerb stands that much over its middle's height.)
          if (!(yk >= yb - 0.05 && yk <= yt + 0.2)) continue;
          if (pass === 0) {
            if (Math.hypot(x - (e[0] + dx * tc), z - (e[1] + dz * tc)) < WALL_SNAP) topK = Math.max(topK, yk);
            continue;
          }
          if (yk < topK - 0.3) continue;
          // (1 cm out past it, out of the paving.)
          const px = e[0] + dx * tc + e[6] * 0.01, pz = e[1] + dz * tc + e[7] * 0.01;
          const d = Math.hypot(x - px, z - pz);
          if (d < best) (best = d), (to = [px, pz]), (on = [i, tc]), (upTo = yk);
        }
        if (to) {
          pos[v * 3] = pos[v * 3 + 3] = to[0];
          pos[v * 3 + 2] = pos[v * 3 + 5] = to[1];
          // (Up to the kerb's top where it stood under it: the wall's top is
          // the road's height on its middle line, and where the road leans
          // up toward this side the kerb stood 13 cm over the wall, a slit
          // under it, at 1333,563.)
          if (upTo > yt && upTo - yt < 0.3) pos[v * 3 + 4] = upTo;
          at.set(v, on!);
        }
      }
      if (pause()) {
        yield;
        slice = performance.now();
      }
    }
    // (Between two of a sheet's points brought to the same kerb, the sheet
    // follows the kerb's own points: straight from one to the next, 3 m or
    // more apart, it cut across where the kerb curves, 12 cm out past it.)
    const swap = new Map<number, number[]>();
    /**
     * The kerb's outer edge on from side i, way dir: its points, each 1 cm
     * out. (From one side to the next that starts where it ends, within
     * 3 cm: a kerb drawn as several runs, or by two rings, is one edge.)
     */
    const kerbWalk = function* (i: number, dir: number): Generator<XZ> {
      let cur = i;
      for (let n = 0; n < 60; n++) {
        const e = E[cur];
        const [qx, qz] = dir > 0 ? [e[3], e[4]] : [e[0], e[1]];
        let next = -1, bd = 0.03;
        for (const j of grid.get(Math.floor(qx / G) * 65536 + Math.floor(qz / G)) ?? []) {
          if (j === cur) continue;
          const f = E[j];
          const d = dir > 0 ? Math.hypot(f[0] - qx, f[1] - qz) : Math.hypot(f[3] - qx, f[4] - qz);
          if (d < bd) (bd = d), (next = j);
        }
        const ox = e[6] + (next >= 0 ? E[next][6] : 0), oz = e[7] + (next >= 0 ? E[next][7] : 0);
        const ol = Math.hypot(ox, oz) || 1;
        yield [qx + (ox / ol) * 0.01, qz + (oz / ol) * 0.01];
        if (next < 0) return;
        cur = next;
      }
    };
    for (let r = 0; r < runs.length; r += 2) {
      for (let v = runs[r]; v + 2 < runs[r] + runs[r + 1]; v += 2) {
        const A = at.get(v), B = at.get(v + 2);
        if ((!A && !B) || (A && B && A[0] === B[0])) continue;
        // (From an end brought to a kerb, along the kerb's points towards
        // the other end, while they lie between the two and within half a
        // metre of the line from one to the other: then straight on, to
        // where the kerb stops or to its other end.)
        const [s0, s1] = A ? [v, v + 2] : [v + 2, v];
        const st0 = (A ?? B)![0];
        const sx = pos[s0 * 3], sz = pos[s0 * 3 + 2], ex = pos[s1 * 3], ez = pos[s1 * 3 + 2];
        const chord = Math.hypot(ex - sx, ez - sz);
        if (chord < 0.05) continue;
        const ux = (ex - sx) / chord, uz = (ez - sz) / chord;
        const fits = (q: XZ | null) => {
          if (!q) return false;
          const t = (q[0] - sx) * ux + (q[1] - sz) * uz, w = Math.abs(-(q[0] - sx) * uz + (q[1] - sz) * ux);
          return t > 0.02 && t < chord - 0.02 && w < 0.5;
        };
        const par = (q: XZ) => (q[0] - sx) * ux + (q[1] - sz) * uz;
        // (The kerb's points either way, past any at the foot itself.)
        const near = (q: XZ) => Math.hypot(q[0] - sx, q[1] - sz) < 0.05;
        const pts = (dir: number) => {
          const out: XZ[] = [];
          let last = -Infinity;
          for (const q of kerbWalk(st0, dir)) {
            if (!out.length && near(q)) continue;
            if (!fits(q) || par(q) <= last) break;
            last = par(q);
            out.push(q);
          }
          return out;
        };
        const fw = pts(1), bw = pts(-1);
        const all = fw.length >= bw.length ? fw : bw;
        if (!all.length) continue;
        if (!A) all.reverse();
        const ax = pos[v * 3], az = pos[v * 3 + 2], bx = pos[(v + 2) * 3], bz = pos[(v + 2) * 3 + 2];
        // (Its pieces as long as they can be with every kerb point they pass
        // within WALL_BOW of them: the kerb's own points crowd round a bend,
        // and a sliver of wall a few centimetres long is no wall, to the eye
        // or to the checks. Short only round a corner too sharp to cut.)
        const mid: XZ[] = [];
        const seq: XZ[] = [...all, [bx, bz]];
        let lx = ax, lz = az;
        for (let i = 0; i < seq.length - 1; ) {
          let j = i;
          for (let c = i + 1; c < seq.length; c++) {
            const [cx, cz] = seq[c], L = Math.hypot(cx - lx, cz - lz);
            if (L < 1e-6) break;
            let ok = true;
            for (let m = i; m < c && ok; m++) ok = Math.abs((seq[m][0] - lx) * (cz - lz) - (seq[m][1] - lz) * (cx - lx)) / L < WALL_BOW;
            if (!ok) break;
            j = c;
          }
          if (j === seq.length - 1) break;
          mid.push(seq[j]);
          (lx = seq[j][0]), (lz = seq[j][1]);
          i = j + 1;
        }
        if (!mid.length) continue;
        const cum: number[] = [];
        let L = 0, px = ax, pz = az;
        for (const m of mid) (L += Math.hypot(m[0] - px, m[1] - pz)), cum.push(L), (px = m[0]), (pz = m[1]);
        L += Math.hypot(bx - px, bz - pz);
        const list = [v];
        mid.forEach(([x, z], q) => {
          const f = cum[q] / (L || 1);
          const n = pos.length / 3;
          for (const c of [0, 1]) {
            pos.push(x, lerp(pos[(v + c) * 3 + 1], pos[(v + 2 + c) * 3 + 1], f), z);
            uv.push(lerp(uv[(v + c) * 2], uv[(v + 2 + c) * 2], f), lerp(uv[(v + c) * 2 + 1], uv[(v + 2 + c) * 2 + 1], f));
          }
          list.push(n);
        });
        list.push(v + 2);
        swap.set(v, list);
      }
      if (pause()) {
        yield;
        slice = performance.now();
      }
    }
    if (!swap.size) return;
    // (Each such piece's quad, as band() drew it, in its place.)
    const out: number[] = [];
    for (let p = 0; p < idx.length; p += 3) {
      const q = idx[p];
      const list = swap.get(q);
      if (list && p + 5 < idx.length && idx[p + 1] === q + 2 && idx[p + 2] === q + 1 && idx[p + 3] === q + 1 && idx[p + 4] === q + 2 && idx[p + 5] === q + 3) {
        for (let j = 0; j + 1 < list.length; j++) {
          const b0 = list[j], b1 = list[j + 1];
          out.push(b0, b1, b0 + 1, b0 + 1, b1, b1 + 1);
        }
        p += 3;
        continue;
      }
      out.push(idx[p], idx[p + 1], idx[p + 2]);
    }
    deck.idx = out;
  }
  const outWork = new Map<string, { rings: OutRing[]; todo: [number, number, number][]; draws: ((kerb: Acc, yellow: Acc, lawn: Acc, side: Acc) => Generator<void>)[]; linePart?: number[]; segs?: Map<number, number[][]>; kerbRuns?: KerbRun[]; all?: { pts: XZ[]; hole: boolean; lvl: number }[] }>();
  const OUT_PARTS = 8;
  const OUT_LINES = 12;
  /** How many places along a side of the outline are asked (one every 4 m or so). */
  const sidePlaces = (a: XZ, b: XZ) => Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
  if (oneLine) {
    // (Every tile any of the outline's pieces may lie in, not only those a
    // road's own points do: a piece whose middle lay in a tile no road had
    // a point in was drawn by no tile, and its kerb and line stopped short
    // at the tile's edge.)
    const outTiles = new Set(roadRuns.keys());
    for (const s of outSources())
      for (let ix = Math.floor(s.x0 / TILE); ix <= Math.floor(s.x1 / TILE); ix++)
        for (let iz = Math.floor(s.z0 / TILE); iz <= Math.floor(s.z1 / TILE); iz++) outTiles.add(`${ix},${iz}`);
    for (const k of outTiles) {
      const [ix, iz] = k.split(',').map(Number);
      const inTile = (x: number, z: number) => Math.floor(x / TILE) === ix && Math.floor(z / TILE) === iz;
      // (Joined in one slice, traced in the next, laid out for asking in the next.)
      let joined: ReturnType<typeof outlineUnions> | null = null;
      let traced: ReturnType<typeof outlineRings> | null = null;
      /** (The traced fills, kept for the lines laid over them: see fillTrisNow.) */
      let fillRings: ReturnType<typeof outlineRings> = [];
      onTile('far', k, 'outline join', () =>
        (function* () {
          joined = yield* outlineUnionsIn(ix, iz);
        })(),
      );
      onTile('far', k, 'outline', () =>
        (function* () {
          traced = yield* outlineFinishIn(joined ?? outlineUnions(ix, iz));
          joined = null;
        })(),
      );
      onTile('far', k, 'outline', (_kit, acc) => (function* () {
        const rings: OutRing[] = [];
        const todo: [number, number, number][] = [];
        const all = traced ?? outlineRings(ix, iz);
        for (const { pts: R, corner, edge, at, hole, lvl, fill, holes } of all) {
          yield;
          if (fill) {
            holeFill(acc('road'), corner, lvl, inTile, holes, acc('deck'));
            continue;
          }
          const n = R.length;
          // (Closed: one point before the start and two past it, for the cross-sections there. Piece q is R's q - 1.)
          const P: XZ[] = [R[n - 1], ...R, R[0], R[1]];
          const mid = (q: number) => [(P[q][0] + P[q + 1][0]) / 2, (P[q][1] + P[q + 1][1]) / 2] as XZ;
          const drawn = P.slice(0, -1).map((_, q) => q >= 1 && q <= n && inTile(...mid(q)));
          // (Or with a piece within SHEET_M of the tile: its kerbs' heights
          // for the island's sheet of lawn, see islandSheet.)
          const nearT = (x: number, z: number) => x > ix * TILE - SHEET_M && x < (ix + 1) * TILE + SHEET_M && z > iz * TILE - SHEET_M && z < (iz + 1) * TILE + SHEET_M;
          if (!drawn.some(Boolean) && !(P.slice(1, n + 1).some((_, q) => nearT(...mid(q + 1))))) continue;
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
        outWork.set(k, { rings, todo, draws: [], all: all.filter((r) => !r.fill).map((r) => ({ pts: r.pts, hole: r.hole, lvl: r.lvl })) });
        bareHoles.delete(k), kerbSides.delete(k), kerbOuter.delete(k);
        fillRings = (traced ?? []).filter((r) => r.fill);
        traced = null;
      })());
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
      // (Its lines worked out a share of its rings at a time, shared out by their points.)
      for (let lp = 0; lp < OUT_LINES; lp++)
      onTile('far', k, 'outline lines', (_kit, acc) => (function* () {
        const w = outWork.get(k);
        if (!w) return;
        if (!w.linePart) {
          const load = new Array(OUT_LINES).fill(0);
          w.linePart = [];
          const order = w.rings.map((r, i) => [r.n, i]).sort((a, b) => b[0] - a[0]);
          for (const [nn, i] of order) {
            const q = load.indexOf(Math.min(...load));
            w.linePart[i] = q;
            load[q] += nn;
          }
        }
        for (const [ri, { P, cum, n, drawn: drawnP, edge, at, samples, hole, lvl }] of w.rings.entries()) {
          if (w.linePart[ri] !== lp) continue;
          // (A ring at a time, each a slice of its own: see Job. Its lines lie on the outline's own fills: see fillTrisNow.)
          yield;
          fillTrisNow = fillTrisFor(k, fillRings);
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
          // (Where a kerb runs, for the paving cut to: see cutPaving.)
          {
            const ks = kerbSides.get(k) ?? kerbSides.set(k, new Paths64()).get(k)!;
            R.forEach((a, q) => {
              if (!marks[q]?.kerb) return;
              const b = R[nx(q)], p = new Path64();
              p.push(new Point64(Math.round(a[0] * OUT_S), Math.round(a[1] * OUT_S)), new Point64(Math.round(b[0] * OUT_S), Math.round(b[1] * OUT_S)));
              ks.push(p);
            });
          }
          // (An island is lined all round or not at all: where any of its
          // kerb has a line, all of it does, but at a zebra.)
          // (A hole with no kerb anywhere round it is no island: paving the
          // union missed, inside a junction. Nothing is drawn round it.)
          if (hole && !marks.some((m) => m?.kerb)) {
            marks.forEach((m, q) => m && m.line && (marks[q] = { ...m, line: false, why: m.why + ' bare hole' }));
            holeFill(acc('road'), w.rings[ri].corner, lvl, inTile, [], acc('deck'));
            // (Paved over, and left as its pieces pave it: see cutPaving.)
            (bareHoles.get(k) ?? bareHoles.set(k, []).get(k)!).push(w.rings[ri].corner);
          }
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
          // (Which of its pieces have a kerb: see islandSheet.)
          w.rings[ri].kq = marks.map((m) => !!m?.kerb);
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
          // (And where it passes onto or off a junction's pad: the pad is
          // level and the road under it climbs, so the height between two
          // points either side would run under the pad's edge.)
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
          // Where a kept piece passes over or beside a joint's level pad or
          // a junction's paving, a point every metre along it, on it: the
          // pad is level and the road beside it climbs, and the height
          // straight between the piece's ends ran under the pad's edge (a
          // line showed a step there). Q2: Q with those points; of2: the
          // piece of Q each piece of Q2 is part of; at2: where Q's points are in Q2.
          const nearJoint = (x: number, z: number, mm: OutMark) =>
            padsAt(x, z, 0.6).length > 0 || jointsNear(x, z).some((q) => q !== mm.joint && (mm.lvl < 0 ? jDeck(q) <= 0 : jLvlM(q) === mm.lvl) && ringDist(JPOLY[q].ring, x, z)[0] < 0.6);
          const Q2: XZ[] = [];
          const of2: number[] = [];
          const at2: number[] = [];
          let endY: [number, OutMark | null, number] | null = null;
          for (let j = 0; j < Q.length; j++) {
            // (A piece at a time: see Job.)
            yield;
            fillTrisNow = fillTrisFor(k, fillRings);
            at2.push(Q2.length);
            Q2.push(Q[j]);
            of2.push(j);
            if (j === Q.length - 1) break;
            const mm = mk(j);
            const L = qc[j + 1] - qc[j];
            // (Only under a line or a kerb: a kerb straight for 20 m beside a
            // road laid on the ground, its strip bent between its corners, lay
            // 1 to 2 cm under where it should stand proud.)
            if (!mm || !(mm.line || mm.kerb) || L < 0.75) continue;
            let near = false;
            if (!mm.flat && L >= 1.5) {
              const n1 = Math.ceil(L);
              for (let c = 0; c <= n1 && !near; c += Math.max(1, n1 >> 1)) near = nearJoint(lerp(Q[j][0], Q[j + 1][0], c / n1), lerp(Q[j][1], Q[j + 1][1], c / n1), mm);
            }
            // (And wherever the surface under the line is not straight
            // between the piece's ends: a kink in the road, another road's
            // edge merging, the ground dipping under a strip laid straight
            // across it. The line straight between them lay under it.)
            if (!near) {
              const s0 = section(Q, j, 0, Q.length - 1, undefined, true), s1 = section(Q, j + 1, 0, Q.length - 1, undefined, true);
              const yAtT = (t: number) => yOn(mm, lerp(Q[j][0], Q[j + 1][0], t) + lerp(s0.nx, s1.nx, t) * 0.35, lerp(Q[j][1], Q[j + 1][1], t) + lerp(s0.nz, s1.nz, t) * 0.35, true);
              // (The piece's start as the last piece's end had it, by the same mark.)
              const ya = endY && endY[0] === j && endY[1] === mm ? endY[2] : yAtT(0), yb = yAtT(1);
              endY = [j + 1, mm, yb];
              // (Or under it, by more than a kerb lies under the road: at a
              // ramp's foot the kerb straight across stood out of it.)
              near = ya === ya && yb === yb && [0.5, ...(L > 3 ? [0.25, 0.75] : [])].some((t) => { const d = yAtT(t) - lerp(ya, yb, t); return d > 0.001 || (mm.kerb && d < -0.012); });
            }
            if (!near) continue;
            const cnt = Math.ceil(L / 0.5);
            for (let c = 1; c < cnt; c++) {
              Q2.push([lerp(Q[j][0], Q[j + 1][0], c / cnt), lerp(Q[j][1], Q[j + 1][1], c / cnt)]);
              of2.push(j);
            }
          }
          const qc2 = [0];
          const busy2 = Q2.map(([x, z], v) => goresNear(x, z).length > 0 || jointsNear(x, z).some((q) => q !== mk(of2[v])?.joint));
          for (let j = 1; j < Q2.length; j++) qc2.push(qc2[j - 1] + Math.hypot(Q2[j][0] - Q2[j - 1][0], Q2[j][1] - Q2[j - 1][1]));
          // (And the kerbs beside the tile, within SHEET_M of it, their
          // heights worked out as their own tile works them out but not
          // drawn: the island's one sheet of lawn (see islandSheet) is laid
          // between kerbs on both sides of a tile's edge, from the same
          // heights in both tiles.)
          const pieceNear = (j: number) => {
            const [ax, az] = Q[j], [bx, bz] = Q[j + 1];
            return Math.max(ax, bx) > ix * TILE - SHEET_M && Math.min(ax, bx) < (ix + 1) * TILE + SHEET_M && Math.max(az, bz) > iz * TILE - SHEET_M && Math.min(az, bz) < (iz + 1) * TILE + SHEET_M;
          };
          const act = (j: number) => dr(j) || (j >= 1 && j <= m && !!mk(j)?.kerb && pieceNear(j));
          for (let j0 = 1; j0 <= m; j0++) {
            if (!act(j0)) continue;
            const drawIt = dr(j0);
            let j1 = j0;
            // (12 points at most to a run, each drawn by itself: round an
            // island's point every kerb point asks what is drawn there, and
            // one run all round it held a frame up for 110 ms, one of 40
            // points beside a busy junction for 100 ms. Each run's ends carry
            // on as the next has it, as across a tile's edge.)
            // (And no more work than 24 of the line's points, a point every
            // half metre where it lies over a joint's paving or a bend in the
            // road; one by a joint or an island's point, where each asks the
            // paving about it, as three: 6 kerb points round a joint beside
            // Simei's slip roads, 22 of the line's, held one up for 80 ms.)
            const cost = (J: number) => {
              let c = 0;
              for (let v = at2[J]; v < (at2[J + 1] ?? Q2.length); v++) c += busy2[v] ? 3 : 1;
              return c;
            };
            let work = cost(j0);
            // (A piece under half a metre goes with the run before it: drawn by
            // itself, at a tile's edge round an island's nose, its line's ends
            // met the next tile's askew.)
            const short = (J: number) => J + 1 < Q.length && Math.hypot(Q[J + 1][0] - Q[J][0], Q[J + 1][1] - Q[J][1]) < 0.5;
            while (j1 + 1 <= m && act(j1 + 1) && dr(j1 + 1) === drawIt && j1 - j0 < 12 && (work + cost(j1 + 1) <= 24 || short(j1 + 1))) work += cost(++j1);
            const J0 = j0, J1 = j1;
            w.draws.push(function* (kerb, yellow) {
              // (Heights where the ground does not lie as the strips drape it,
              // from the surface the side bounds: kerbs at Q's points, lines
              // at Q2's, from Q's point J0 to its point J1 + 1.)
              const hK: number[] = [];
              const hY: number[] = [];
              // (The run's last point as the next piece has it, where the kerb
              // and line carry on into it: the next run, or the next tile,
              // starts there by that piece's own mark. By the last piece's,
              // at a tile's edge on Simei Avenue a kerb stood 3 cm higher on
              // one side than the other: a joint's paving there, the ground
              // past it.)
              const markAt = (o: number) => {
                if (o <= J1) return mk(o) ?? mk(o - 1);
                const a = mk(o - 1), b = mk(o);
                return a && b && a.kerb === b.kerb && a.line === b.line ? b : a ?? b;
              };
              // (What is drawn on top at (x, z), in the roads' own frame, if
              // anything is: a nose's or wedge's paving, a road's strip
              // reaching over it, a joint's paving or level pad.)
              // (What is drawn at (x, z), in the roads' own frame, if anything
              // is: a nose's or wedge's paving, road strips, a joint's paving
              // or level pad. The lowest of what lies within 10 cm of the top:
              // where two pieces overlap a few cm apart, as two roads' strips
              // with their own crossfall do beside an island, each shows at
              // its own edge, and a kerb under only the upper one stood out
              // of the lower.)
              const drawnTopAt = (mm: OutMark, x: number, z: number, gNear?: number[], top0 = false) => {
                const hs: number[] = [];
                const g = goreTopAt(x, z, gNear) - ROAD_LIFT;
                if (g === g) hs.push(g);
                roads.each(x, z, 12, (o, seg, u, d) => {
                  if (JX.internal[o] || !onLvl(o, seg, mm.lvl) || !outlined[o] || d > drawnHalf(o, seg, u) + 0.4) return;
                  const h = stripTop(o, x, z, seg - 1, seg + 1);
                  // (On it, not near: a strip's triangle reaching 2% further,
                  // over the end of one 3 cm lower beside it, tilted a kerb
                  // up out of that one.)
                  if (stripOut < 0.001) hs.push(h);
                });
                for (const q of jointsNear(x, z)) {
                  if ((mm.lvl < 0 ? jDeck(q) > 0 : jLvlM(q) !== mm.lvl) || !inRingXZ(JPOLY[q].ring, x, z)) continue;
                  const h = paveY(q, x, z);
                  if (h === h) hs.push(h);
                }
                if (hs.length) for (const p of padsAt(x, z, 0)) hs.push(p.y);
                if (!hs.length) return NaN;
                // (Nothing far above the rest: a deck's pad over a road's end.)
                const lo0 = Math.min(...hs);
                let top = lo0;
                for (const h of hs) if (h > top && h - lo0 < 0.5) top = h;
                if (top0) return top;
                let lo = top;
                for (const h of hs) if (h < lo && top - h < 0.1) lo = h;
                return lo;
              };
              // (A kerb's height: the highest drawn within its inner 3 cm and
              // its outline point, there and a quarter of the way to its points
              // either side, as it runs straight between them; in the roads'
              // own frame. Beside paving, also what reaches out over the
              // outline under it.)
              // (Its top 3 cm over the road's drawn surface: the road is drawn
              // ROAD_LIFT over its own height, the kerb 0.07 over hK. Feedback
              // 9: 1 cm over, and on a road laid on the ground 2 cm under it,
              // the kerb did not stand proud of the road at all.)
              const KERB_UP = ROAD_LIFT + 0.03 - 0.07;
              const kerbOn = (mm: OutMark, P: XZ[], v: number, busy: boolean, gNear: number[] | undefined, own: number) => {
                const { nx: sx, nz: sz, mm: rm } = section(P, v, 0, P.length - 1, undefined, true);
                const at: XZ[] = [P[v]];
                if (busy) for (const w of [v - 1, v + 1]) if (w >= 0 && w < P.length && Math.hypot(P[w][0] - P[v][0], P[w][1] - P[v][1]) > 0.5) at.push([(P[v][0] * 3 + P[w][0]) / 4, (P[v][1] * 3 + P[w][1]) / 4]);
                let h = own;
                for (const [x, z] of at)
                  for (const o of busy && x === P[v][0] && z === P[v][1] ? [0.03, -0.15] : [0.03]) {
                    // (Along a road's own edge, the road, and whatever else is
                    // drawn under the kerb's inner edge: where another road's
                    // strip reached under it, 14 cm higher, the kerb lay 9 cm
                    // under that road.)
                    const px = x + sx * o * rm, pz = z + sz * o * rm;
                    for (const g of busy ? [drawnTopAt(mm, px, pz, gNear, true)] : [yOn(mm, px, pz), drawnTopAt(mm, px, pz, undefined, true)])
                      if (g === g && (h !== h || (g > h && (own !== own || g - own < 0.5)))) h = g;
                  }
                return h;
              };
              // (Every kerb by one rule: it lies on whatever is drawn beside
              // it, 3 cm over the highest of it, from 3 cm in from the road's
              // edge to 0.35 m out, its whole width showing all the way along
              // and round every island. Laid under the road's edge instead,
              // how much of it showed hung on the heights about it: round an
              // island's point, where paving sloped from one road to the
              // other, it showed wide in one place and narrow in the next,
              // notched at the point, lopsided either side of it.)
              for (let v = J0; v <= J1 + 1; v++) {
                // (A point at a time: round a busy junction each asks all that is drawn about it, a few ms a point.)
                yield;
                const mm = markAt(v);
                // (On a road laid on the ground, on its strip as drawn, straight
                // between its corners; off it, on the ground the strip drapes.
                // Draped on the ground itself, it lay 2 cm under the road.)
                // (And where its own road gives no height there, as by a zebra:
                // left to the ground, it lay 2 cm under the road beside it.)
                hK[v] = !mm ? NaN : mm.flat ? NaN : yOn(mm, Q[v][0], Q[v][1]);
                if (mm && hK[v] !== hK[v]) {
                  // (As drawn there, and 3 cm in, under the kerb's inner edge: the strip's crossfall.)
                  const { nx: sx, nz: sz, mm: rm } = section(Q, v, 0, Q.length - 1, undefined, true);
                  let y = yOn(mm, Q[v][0], Q[v][1], true);
                  const yi = yOn(mm, Q[v][0] + sx * 0.03 * rm, Q[v][1] + sz * 0.03 * rm, true);
                  if (yi === yi && (y !== y || (yi > y && yi - y < 0.5))) y = yi;
                  // (And where its own road is not there, the outline made by
                  // another beside it: whatever is drawn 3 cm in. Left to the
                  // ground, by a road laid a few cm over it, a kerb lay under
                  // the road's edge.)
                  if (y !== y) y = drawnTopAt(mm, Q[v][0] + sx * 0.03 * rm, Q[v][1] + sz * 0.03 * rm, undefined, true);
                  hK[v] = (y === y ? y : Math.max(rawHeight(Q[v][0], Q[v][1]), WL + 0.15)) + KERB_UP;
                  continue;
                }
                if (!mm || mm.flat) continue;
                // (Where paving lies about, a wedge's, a nose's or a joint's,
                // all that is drawn there; along a road's own edge, the road.)
                const [qx, qz] = Q[v];
                const gNear = goresNear(qx, qz).filter((id) => { const b = goreBox(id); return qx > b[0] - 1 && qx < b[2] + 1 && qz > b[1] - 1 && qz < b[3] + 1; });
                const busy = gNear.length > 0 || jointsNear(qx, qz).some((q) => q !== mm.joint) || drawnJoint(mm.joint);
                hK[v] = Math.max(hK[v], kerbOn(mm, Q, v, busy, gNear, hK[v])) + KERB_UP;
              }
              const j0 = at2[J0], j1 = at2[J1 + 1] - 1;
              for (let v = j0; v <= j1 + 1; v++) {
                yield;
                const mm = markAt(of2[v]);
                if (!mm) {
                  hY[v] = NaN;
                  continue;
                }
                const { nx: sx, nz: sz } = section(Q2, v, 0, Q2.length - 1, undefined, true);
                hY[v] = yOn(mm, Q2[v][0] + sx * 0.35, Q2[v][1] + sz * 0.35, true);
                // (Round an island's point or by a junction, across its
                // whole width: a road there climbing away beside the point
                // reached over the line's outer half, 3 cm above its middle.)
                if (hY[v] === hY[v] && (goresNear(Q2[v][0], Q2[v][1]).length || jointsNear(Q2[v][0], Q2[v][1]).some((q) => q !== mm.joint)))
                  for (const o of [0.27, 0.43]) {
                    const h = yOn(mm, Q2[v][0] + sx * o, Q2[v][1] + sz * o, true);
                    if (h === h && h > hY[v] && h - hY[v] < 0.1) hY[v] = h;
                  }
              }
              // (Each kerb and line by itself, square across at its ends: at a
              // bend in the outline where it stops, a cross-section on the
              // bend's bisector would cut it off aslant. Where it runs on into
              // the next tile, as the next tile has it there.)
              const runs = (P: XZ[], lo0: number, hi0: number, piece: (a: number) => number, keep: (j: number) => boolean, f: (lo: number, hi: number, a: number, b: number) => void) => {
                for (let a = lo0; a <= hi0; a++) {
                  if (!keep(piece(a))) continue;
                  let b = a;
                  while (b + 1 <= hi0 && keep(piece(b + 1))) b++;
                  f(a === lo0 && keep(J0 - 1) ? 0 : a, b === hi0 && keep(J1 + 1) ? P.length - 1 : b + 1, a, b + 1);
                  a = b;
                }
              };
              const isKerb = (j: number) => !!mk(j)?.kerb, isLine = (j: number) => !!mk(j)?.line;
              // (Kerbs by Q2's points too where a line's are put in between
              // Q's, where the surface is not straight between them: at a
              // ramp's foot, straight from one of its points to the next 3 m
              // on, a kerb stood 5 cm off the road. Each such point as the
              // kerb's own are found.)
              const hK2: number[] = [];
              for (let v = j0; v <= j1 + 1; v++) {
                yield;
                const J = of2[v];
                if (v === at2[J] || J + 1 >= Q.length || J + 1 > J1 + 1) {
                  hK2[v] = hK[J];
                  continue;
                }
                const va = at2[J], vb = at2[J + 1];
                const t = (qc2[v] - qc2[va]) / (qc2[vb] - qc2[va] || 1);
                hK2[v] = lerp(hK[J], hK[J + 1], t);
                // (On what is drawn there, between its own points: beside
                // paving, as found there; along a road, as far off straight
                // as the line beside it is.)
                const mm = mk(J);
                if (!mm || hK2[v] !== hK2[v]) continue;
                const [x, z] = Q2[v];
                const gNear = goresNear(x, z);
                const busy = gNear.length > 0 || jointsNear(x, z).some((q) => q !== mm.joint) || drawnJoint(mm.joint);
                if (!busy || mm.flat) {
                  const dev = hY[v] - lerp(hY[va], hY[vb], t);
                  if (dev === dev && Math.abs(dev) < 0.5) hK2[v] += dev;
                  continue;
                }
                const h = kerbOn(mm, Q2, v, busy, gNear, hK2[v] - KERB_UP) + KERB_UP;
                if (h === h && Math.abs(h - hK2[v]) < 0.5) hK2[v] = h;
              }
              // (Each stretch of kerb, its outer edge and its top, for the
              // island's sheet of lawn: see islandSheet.)
              runs(Q2, j0, j1, (a) => of2[a], isKerb, (lo, hi, a, b) => {
                const I: XZ[] = [], E: XZ[] = [], N: XZ[] = [], T: number[] = [];
                for (let j = a; j <= b; j++) {
                  const { nx, nz, mm } = section(Q2, j, lo, hi, undefined, true);
                  I.push(Q2[j]), E.push([Q2[j][0] - nx * KERB_OUT * mm, Q2[j][1] - nz * KERB_OUT * mm]), N.push([-nx, -nz]), T.push(hK2[j] + 0.07);
                }
                (w.kerbRuns ??= []).push({ lvl: mk(of2[a])!.lvl, I, E, N, T });
              });
              if (!drawIt) return;
              yield;
              runs(Q2, j0, j1, (a) => of2[a], isKerb, (lo, hi, a, b) => {
                strip(kerb, Q2, qc2, a, b, 0.19, 0.07, { lo, hi, off: -0.16, yAt: (j) => hK2[j], bisect: true });
                // (Its outer edge, for the walls beside it: see wallsToKerb.)
                const E: number[][] = [];
                for (let j = a; j <= b; j++) {
                  const { nx, nz, mm } = section(Q2, j, lo, hi, undefined, true);
                  E.push([Q2[j][0] - nx * KERB_OUT * mm, Q2[j][1] - nz * KERB_OUT * mm, hK2[j] + 0.07, -nx, -nz, Q2[j][0], Q2[j][1]]);
                }
                const ko = kerbOuter.get(k) ?? kerbOuter.set(k, []).get(k)!;
                for (let j = 1; j < E.length; j++) {
                  const [p, q] = [E[j - 1], E[j]];
                  const ol = Math.hypot(p[3] + q[3], p[4] + q[4]) || 1;
                  if (p[2] === p[2] && q[2] === q[2]) ko.push([p[0], p[1], p[2], q[0], q[1], q[2], (p[3] + q[3]) / ol, (p[4] + q[4]) / ol, p[5], p[6], q[5], q[6]]);
                }
              });
              yield;
              runs(Q2, j0, j1, (a) => of2[a], isLine, (lo, hi, a, b) => strip(yellow, Q2, qc2, a, b, 0.07, 0.11, { lo, hi, off: 0.35, yAt: (j) => hY[j], bisect: true }));
            });
            j0 = j1;
          }
        }
      })());
      // (Drawn a kerb point at a time, each a slice of its own: shared out
      // by a guess at each run's work, one share in nine held a frame up for
      // 135 ms: round a busy junction each kerb point asks all that is drawn
      // about it, and how much that is can't be told before asking.)
      onTile('far', k, 'outline draw', (_kit, acc) =>
        (function* () {
          const w = outWork.get(k);
          if (!w) return;
          const kerb = acc('kerb');
          const yellow = acc('yellow');
          const lawn = acc('lawn');
          const side = acc('kerbSide');
          for (const draw of w.draws) {
            // (Set again each step: the lines lie on the outline's own fills, see fillTrisNow.)
            const it = draw(kerb, yellow, lawn, side);
            for (;;) {
              fillTrisNow = fillTrisFor(k, fillRings);
              const r = it.next();
              fillTrisNow = null;
              if (r.done) break;
              yield;
            }
          }
          yield* islandSheet(ix, iz, w, lawn, side);
          outWork.delete(k), fillTrisOf.delete(k);
        })(),
      );
      onTile('far', k, 'paving cut', (_kit, acc) => cutPaving(k, acc('road')));
      onTile('far', k, 'walls to kerb', (_kit, acc) => wallsToKerb(k, acc('deck')));
      onTile('far', k, 'wall gaps', (kit, acc) => wallGaps(k, acc('deck'), acc('kerbSide'), kit));
    }
  }
  /** (For the checks: the outline's sides within r of (x, z), and what each gets at its nearest point.) */
  const outlineAt = (x: number, z: number, r = 3) => {
    const out: { a: XZ; b: XZ; kerb: boolean; line: boolean; why: string }[] = [];
    for (const { corner: R, hole, lvl, fill } of outlineRings(Math.floor(x / TILE), Math.floor(z / TILE)))
      if (!fill) R.forEach((a, q) => {
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
  /** Each acc's sheets drawn by band(), as [first vertex, count]: see wallsToKerb. */
  const bandSheets = new WeakMap<Acc, number[]>();
  const band = (acc: Acc, pts: XZ[], cum: number[], k0: number, k1: number, offIn: number | ((k: number) => number), y: (k: number) => number, belowIn: number | ((k: number) => number), aboveIn: number | ((k: number) => number), keep: (k: number) => boolean, ext: [number, number] = [0, 0], endAbove?: (k: number, off: number) => number, open?: (k: number, t: number) => boolean, sec?: { lo: number; hi: number; join?: (k: number) => { d: XZ; m: number } | null }) => {
    const base = acc.pos.length / 3;
    // (Kept pieces, worked out first: where a run of them ends, its top may
    // come down to endAbove there, as a wall comes out of the ground.)
    const kept: boolean[] = [];
    for (let k = k0; k < k1; k++) kept[k - k0] = keep(k);
    const V: number[][] = [];
    for (let k = k0; k <= k1; k++) {
      const a = pts[Math.max(0, k - 1)];
      const b = pts[Math.min(pts.length - 1, k + 1)];
      const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      let off = typeof offIn === 'number' ? offIn : offIn(k);
      const along = k === 0 ? -ext[0] : k === pts.length - 1 ? ext[1] : 0;
      let nx = (b[1] - a[1]) / tl, nz = -(b[0] - a[0]) / tl;
      // (Beside a road: across it as its strip is drawn, out along the
      // mitre at a bend, so the band keeps its distance from the road's
      // edge. Square to the chord, it came in by 5 cm round a bend's
      // outside, short of the kerb's outer edge.)
      if (sec && k >= sec.lo && k <= sec.hi) {
        const c = section(pts, k, sec.lo, sec.hi, sec.join);
        nx = c.nx;
        nz = c.nz;
        off *= c.mm;
      }
      const x = pts[k][0] + nx * off + ((b[0] - a[0]) / tl) * along;
      const z = pts[k][1] + nz * off + ((b[1] - a[1]) / tl) * along;
      const yk = y(k);
      const below = typeof belowIn === 'number' ? belowIn : belowIn(k);
      let above = typeof aboveIn === 'number' ? aboveIn : aboveIn(k);
      if (endAbove && k > k0 && k < k1 && kept[k - k0 - 1] !== kept[k - k0]) above = Math.min(above, endAbove(k, kept[k - k0] ? k - 1 : k));
      V.push([x, yk - below, z, yk + above]);
    }
    // (Where a run of kept pieces ends inside this stretch, its last piece is
    // kept for its middle, and ran on past where the ground beside it stops:
    // a wall's last metres stood on the next road's paving past an island's
    // point, out beyond its kerb. The run's end is brought back to where the
    // ground beside it is last open, `open` asked along the piece.)
    if (open) {
      const moved = new Map<number, number[]>();
      const trim = (k: number, end: 0 | 1) => {
        if (open(k, end)) return;
        // (From the piece's other end, the run's side, to the first place
        // the ground beside is open, then on to where it stops being.)
        let a = -1, b: number = end;
        for (let q = 0; q < 8 && a < 0; q++) {
          const t = end ? q / 8 : 1 - q / 8;
          if (open(k, t)) a = t;
        }
        if (a < 0) return;
        for (let it = 0; it < 10; it++) {
          const m = (a + b) / 2;
          if (open(k, m)) a = m;
          else b = m;
        }
        const P0 = V[k - k0], P1 = V[k + 1 - k0];
        moved.set(k + end, P0.map((v, q) => v + (P1[q] - v) * a));
      };
      for (let k = k0; k < k1; k++) {
        if (!kept[k - k0]) continue;
        // (At the ends of this stretch too: the road's next stretch, drawn
        // apart, cuts its own wall back from the same point.)
        if (k === k0 || !kept[k - 1 - k0]) trim(k, 0);
        if (k + 1 === k1 || !kept[k + 1 - k0]) trim(k, 1);
      }
      for (const [k, v] of moved) V[k - k0] = v;
    }
    (bandSheets.get(acc) ?? bandSheets.set(acc, []).get(acc)!).push(base, (k1 - k0 + 1) * 2);
    for (let k = k0; k <= k1; k++) {
      const [x, yb, z, yt] = V[k - k0];
      acc.pos.push(x, yb, z, x, yt, z);
      acc.uv.push(0, cum[k] / 6, 1, cum[k] / 6);
    }
    for (let k = k0; k < k1; k++) {
      if (!kept[k - k0]) continue;
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
      // (Nor from a flyover's end on to the ground road, or back: each
      // level's outline, kerb and wall end there, square across.)
      if (oneLine && lvlOf(line, k === 0 ? 0 : L.length - 2) !== lvlOf(o, edges[o].a === j ? 0 : EP[o].length - 2)) return 0;
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
    inChunks('far', k, 'paths', pathSlices(all), 1, (list, _kit, acc) => (function* () {
      // (A path's heights all along it first, a slice by themselves: see Job.)
      for (const { line } of list) if (!deckCache.has(line)) pathDeck(line), yield;
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
    })());

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
  // far: the same tree with fewer faces, drawn beyond FAR_TREE m (a wood seen
  // across a field was 6,000 trees of 184 triangles each: 1.1 million).
  interface VegKind { geo: THREE.BufferGeometry; far?: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[]; shadow: boolean; collide?: number; hues: [number, number, number, number] }
  const frond = (a: number) => tint(new THREE.BoxGeometry(3.4, 0.08, 0.7).translate(1.7, 0, 0).rotateZ(-0.45).rotateY(a).translate(0, 8, 0), 0xffffff);
  const kinds: Record<string, VegKind> = {
    rain: {
      geo: merge([
        tint(new THREE.CylinderGeometry(0.28, 0.45, 5, 6).translate(0, 2.5, 0), 0x5b4636),
        tint(new THREE.IcosahedronGeometry(1, 1).scale(4.6, 1.5, 4.6).translate(0, 6, 0), 0xffffff),
        tint(new THREE.IcosahedronGeometry(1, 1).scale(3.2, 1.2, 3.2).translate(1.6, 6.9, 0.8), 0xffffff),
      ]),
      far: merge([
        tint(new THREE.CylinderGeometry(0.28, 0.45, 5, 4, 1, true).translate(0, 2.5, 0), 0x5b4636),
        tint(new THREE.IcosahedronGeometry(1, 0).scale(4.6, 1.5, 4.6).translate(0, 6, 0), 0xffffff),
        tint(new THREE.IcosahedronGeometry(1, 0).scale(3.2, 1.2, 3.2).translate(1.6, 6.9, 0.8), 0xffffff),
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
      far: merge([
        tint(new THREE.CylinderGeometry(0.22, 0.35, 6, 4, 1, true).translate(0, 3, 0), 0x5b4636),
        tint(new THREE.CylinderGeometry(3.6, 3.8, 0.6, 5).translate(0, 4.2, 0), 0xffffff),
        tint(new THREE.CylinderGeometry(2.6, 2.8, 0.6, 5).translate(0, 5.4, 0), 0xffffff),
        tint(new THREE.CylinderGeometry(1.5, 1.7, 0.6, 5).translate(0, 6.5, 0), 0xffffff),
      ]),
      mat: swayMat(0.01),
      shadow: true,
      collide: 0.35,
      hues: [0.25, 0.45, 0.36, 0.06],
    },
    shrub: { geo: tint(new THREE.IcosahedronGeometry(1, 1), 0xffffff), far: tint(new THREE.IcosahedronGeometry(1, 0), 0xffffff), mat: swayMat(0.02), shadow: false, hues: [0.27, 0.45, 0.3, 0.05] },
    mangrove: {
      geo: merge([
        ...[0, 2.1, 4.2].map((a) => tint(new THREE.CylinderGeometry(0.06, 0.1, 1.6, 4).rotateZ(0.5).rotateY(a).translate(Math.cos(a) * 0.5, 0.6, -Math.sin(a) * 0.5), 0x5b4a3a)),
        tint(new THREE.IcosahedronGeometry(1, 1).scale(2.4, 1.3, 2.4).translate(0, 2.4, 0), 0xffffff),
      ]),
      far: merge([tint(new THREE.IcosahedronGeometry(1, 0).scale(2.4, 1.3, 2.4).translate(0, 2.4, 0), 0xffffff)]),
      mat: swayMat(0.01),
      shadow: true,
      collide: 0.6,
      hues: [0.26, 0.4, 0.24, 0.04],
    },
    grass: { geo: tint(new THREE.ConeGeometry(0.16, 0.6, 4), 0x7a9a40), mat: plainMat, shadow: false, hues: [0.23, 0.32, 0.6, 0.04] },
  };
  if (detailed && D.DETAILED_FOLIAGE) {
    // (These trees have no far version yet: drawn as they are.)
    for (const k of Object.values(kinds)) delete k.far;
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
  const courts = (M.fuel ?? []).filter((f) => f.pts?.length);
  const onCourt = (x: number, z: number, pad: number) =>
    courts.some((f) => {
      if (Math.abs(x - f.x) > f.r + pad || Math.abs(z - f.z) > f.r + pad) return false;
      const P = f.pts!;
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
      return c || best < pad;
    });
  type Plant = { kind: string; x: number; z: number; s: number };
  const nearOnly = new Set<{ mesh: THREE.InstancedMesh; x: number; z: number }>();
  /** Trees drawn with their far version beyond FAR_TREE m of the camera. */
  const FAR_TREE = 220;
  const farTrees = new Set<{ mesh: THREE.InstancedMesh; near: THREE.BufferGeometry; far: THREE.BufferGeometry; x: number; z: number }>();
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
    // Nothing grows on a petrol station's forecourt, or through its kerb.
    for (let i = plants.length - 1; i >= 0; i--) if (onCourt(plants[i].x, plants[i].z, 2.5)) plants.splice(i, 1);
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
      else if (kind.far) farTrees.add({ mesh: im, near: kind.geo, far: kind.far, x: (ti + 0.5) * TILE, z: (tj + 0.5) * TILE });
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
  // (An island's top as well, where it is lifted to its kerbs: drawn and
  // not driven on, it hid a fall of up to 1.3 m to the ground under it, at
  // -134.8,-53.3 beside the expressway.)
  const keepSurf = (k: string, a: Acc | undefined, lawn?: Acc) => {
    roadSurf.delete(k);
    const ap = a?.pos ?? [], ai = a?.idx ?? [], lp = lawn?.pos ?? [], li = lawn?.idx ?? [];
    const pos = new Float32Array(ap.length + lp.length);
    pos.set(ap);
    pos.set(lp, ap.length);
    const idx = new Uint32Array(ai.length + li.length);
    idx.set(ai);
    for (let q = 0, n = ap.length / 3; q < li.length; q++) idx[ai.length + q] = li[q] + n;
    roadSurf.set(k, { pos, idx });
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
      let t0 = performance.now();
      const more = job(offScene, acc);
      cost(`${job.what} (again, for the collider)`, `near:${k}`, t0);
      yield;
      if (more)
        for (let done = false; !done; ) {
          t0 = performance.now();
          done = !!more.next().done;
          cost(`${job.what} (again, for the collider)`, `near:${k}`, t0);
          yield;
        }
    }
    keepSurf(k, accs.get('road'), accs.get('lawn'));
    return roadSurf.get(k)!;
  }
  const roadCollider = (surf: { pos: Float32Array; idx: Uint32Array }, kit: TileKit) => {
    if (!surf.idx.length) return;
    world.createCollider(RAPIER.ColliderDesc.trimesh(surf.pos, surf.idx).setFriction(0.9), kit.body());
  };
  const builder = (layer: Layer) =>
    function* (ti: number, tj: number, kit: TileKit) {
      const at = `${layer}:${ti},${tj}`;
      // (Its islands first, each cell a slice of its own: the ground reads them.)
      for (const it = warmIslands(ti, tj); ; ) {
        const t1 = performance.now();
        const r = it.next();
        cost('islands', at, t1);
        if (r.done) break;
        yield;
      }
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
        const more = job(kit, acc);
        cost(job.what ?? '?', at, t0);
        yield;
        if (more)
          for (let done = false; !done; ) {
            t0 = performance.now();
            done = !!more.next().done;
            cost(job.what ?? '?', at, t0);
            yield;
          }
      }
      if (layer === 'far') keepSurf(`${ti},${tj}`, accs.get('road'), accs.get('lawn'));
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
  // Petrol stations (fuel.ts): where the car fills up.
  const fuel = (M.fuel ?? []).filter((f) => f.x > WB.minX && f.x < WB.maxX && f.z > WB.minZ && f.z < WB.maxZ);
  for (const f of fuel) pois.push({ x: f.x, z: f.z, label: f.name, kind: 'fuel' });
  const map: MapData = { bounds: { ...WB }, background: '#d6d8cc', areas: mapAreas, lines: mapLines, pois, pxPerM: 0.5, attribution: M.attribution };

  // Test hook: ?debug exposes the road plan to the map checks (tools/check).
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug'))
    (globalThis as any).__osm = {
      surfaceAt: rawHeight,
      // Every pier's foot and top, rail and road.
      footTop, footPiers, footStairs, pathIdx,
      blds, rankOf, deckSplits, thruSplits, nearDeck, WB, GORE, throughLines, throughPairs, paveY, giveWays, bldRoads, pairedLines: (i: number, f = 0.5) => (paired(edges[i]) ? pairedLines(i, f) : null), laneWOf,
      // May road `line` carry a marking at (x, z)? Not under another road, on an island or in a junction.
      lineOpen: (line: number, x: number, z: number, y: number) => !coveredBy(line, x, z, y) && !onIsland(x, z) && !inPaving(x, z, y),
      // Where any mark may stop (for the checks: no one road asked about).
      outlineAt,
      gores,
      dividers,
      islandsIn,
      groundAt,
      islReset: (ci: number, cj: number) => islCells.delete(ci * 100003 + cj),
      islNearHas: (ci: number, cj: number) => islNearCells().has(ci * 100003 + cj),
      islandList: () => [...islCells.values()].flat(),
      ISL_CELL,
      divMs: () => divMs,
      goreCaps,
      sAlong,
      fillY,
      drawnHalf: (o: number, seg: number, u: number) => drawnHalf(o, seg, u),
      outlineY: (x: number, z: number, lvl = -1) => outlineY(x, z, nearRoads(x, z), lvl),
      onLvl,
      surfacePoly: (i: number) => surfacePoly(i),
      outSources: () => outSources(),
      padsAt, stripOutNow: () => stripOut, drapedPadAt, padShapeOf: (j: number) => padShape(j), padYOf: (j: number) => padY(j), padsByTile,
      jpolyNear: (x: number, z: number, r: number) => JPOLY.map((sh, id) => ({ id, sh })).filter(({ sh }) => sh.ring.some((p) => Math.hypot(p[0] - x, p[1] - z) < r)).map(({ id, sh }) => ({ id, fill: sh.fill, ring: sh.ring.map((p) => [+p[0].toFixed(2), +p[1].toFixed(2)]) })),
      /** Is (x, z) on or within pad of a drawn plain road (a driveway, a car park lane: no kerb of its own)? */
      plainRoadNear: (x: number, z: number, pad: number) => {
        let hit = false;
        roads.each(x, z, 16, (i, seg, u, d) => {
          if (!hit && outlined[i] && !kerbedRoad(edges[i]) && !hasProfile[i] && d <= drawnHalf(i, seg, u) + pad) hit = true;
        });
        return hit;
      },
      goreInfo: (x: number, z: number) => goresNear(x, z).map((id) => ({ id, A: gores[id].A, B: gores[id].B, deck: gores[id].deck, ring: gores[id].ring, caps: goreCaps(id).map((c) => ({ nose: c.nose, pave: c.pave })) })),
      jxInfo: (i: number) => ({ internal: JX.internal[i], hidden: internalHidden[i], outlined: outlined[i], tee: JX.tee[i], shapeA: JX.shapeOf[edges[i].a], shapeB: JX.shapeOf[edges[i].b], trimA: JX.trimA[i], trimB: JX.trimB[i], half: [EP[i].map((_, k) => halfAtE(i, k))] }),
      jpolyAt: (x: number, z: number) => JPOLY.map((sh, id) => ({ id, sh })).filter(({ sh }) => inRingXZ(sh.ring, x, z)).map(({ id, sh }) => ({ id, fill: sh.fill, n: sh.ring.length, centre: sh.centre, radius: sh.radius, kerbs: sh.kerbs.length, near: jointsNear(x, z).includes(id), lvl: jLvlM(id), deck: jDeck(id) })),
      outlineFillsNear: (x: number, z: number, r: number) => outlineRings(Math.floor(x / TILE), Math.floor(z / TILE)).filter((g) => g.fill && g.corner.some((p) => Math.abs(p[0] - x) < r && Math.abs(p[1] - z) < r)).map((g) => ({ corner: g.corner, lvl: g.lvl })),
      kerbOuterOf: (k: string) => kerbOuter.get(k) ?? [],
      paveCutsOf: (k: string) => (paveCuts.get(k) ?? []).map((c) => c.map((q): XZ => [q.x / OUT_S, q.y / OUT_S])),
      outlineRingsNear: (x: number, z: number, r: number) => outlineRings(Math.floor(x / TILE), Math.floor(z / TILE)).filter((g) => !g.fill && g.corner.some((p) => Math.abs(p[0] - x) < r && Math.abs(p[1] - z) < r)).map((g) => ({ hole: g.hole, corner: g.corner, lvl: g.lvl })),
      stopsAt: (x: number, z: number, y: number) => ({ paving: inPaving(x, z, y), island: onIsland(x, z), gore: inGore(x, z) }),
      whyClosed: (line: number, x: number, z: number, y: number) => ({ covered: coveredBy(line, x, z, y), island: onIsland(x, z), paving: inPaving(x, z, y), gore: inGore(x, z) }),
      markStops, throughEnd: (line: number, end: number) => throughEnds.has(line * 2 + end),
      piers: () => {
        const out: { x: number; z: number; top: number; kind: string; self: number }[] = [];
        edges.forEach((_, line) => pillarsOf(line, 0, EP[line].length - 1, (x, z, top) => out.push({ x, z, top, kind: 'flyover', self: line })));
        viaducts.forEach((pts, line) => railPiers(line).forEach((q) => out.push({ x: pts[q][0], z: pts[q][1], top: railY(line, q) - 1.1, kind: 'rail', self: -1 })));
        return out;
      },
      crossings, medianCuts, CROSS_FROM, CROSS_W, yBoxes, boxWhy, signals: M.signals ?? [],
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
        for (const job of jobs.far.get(k) ?? []) {
          const it = job(kit, acc);
          if (it) while (!it.next().done);
        }
        return Object.fromEntries([...accs].map(([key, a]) => [key, { pos: a.pos, idx: a.idx, nrm: a.nrm }]));
      },
      JX,
      halfAtE,
      halfNear,
      cutOf,
      gapWalls, kerbOuter, jointWalls, jointDeck, onTeeOf, isDeckSplit: (j: number) => deckSplits.has(j), needs, jCap, jCeil, deckEnd, sepA, sepB, ptA, ptB, thruJoint, relAlong, relOwn, stripShape, landOver, trims: (i: number) => [trimA(i), trimB(i)], stepAt, holdBase, ptMateA, ptMateB, roadBase, mates, jE, ELEN, tiltAt, crossDrop, LIMITS, WL, throughOf, mateOf: mate, WIDTH_RATE, runOf, runs,
      fillTop: (k: number, x: number, z: number) => fillTop(JX.shapes.length + k, x, z),
      jTop: (k: number, x: number, z: number) => jTop(k, x, z),
      stripTop, oneLine, edges, EP, ECUM, EHALF, elevated, isDeck, embank, hasProfile, deckY, jRel, baseAt, heightAt, paths, PHALF, roads, jointsOf, drape, PCUM, pathDeck };
  return {
    name: opts.name ?? 'Pasir Ris & Tampines',
    styles: true,
    camps,
    fuel,
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
      // A tile's trees go to their far version when the nearest of the
      // tile is past FAR_TREE m (the tile is 200 m across).
      const eye = cam ?? focus;
      if (eye)
        for (const g of farTrees) {
          if (!g.mesh.parent) farTrees.delete(g);
          else {
            const far = Math.max(Math.abs(g.x - eye.x), Math.abs(g.z - eye.z)) - TILE / 2 > FAR_TREE;
            const geo = far ? g.far : g.near;
            if (g.mesh.geometry !== geo) g.mesh.geometry = geo;
          }
        }
    },
  };
}
