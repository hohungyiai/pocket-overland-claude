import type { XZ } from '../courses/types';
import { SegIndex } from './segindex';

// Junction shapes. OSM marks a junction as a point where road centre lines
// meet; a big crossing (two dual carriageways) is four or more such points a
// few metres apart, joined by short stubs. Drawing a round pad at each point
// leaves overlapping pads and kerb rings across the lanes.
//
// Here nearby junction points are merged into one junction, each road
// leading out of it is cut back to where it clears the others (its "mouth"),
// and the junction is the shape around those mouths, with a curved corner
// (kerbed) from each mouth to the next. Roads draw from their mouths
// outward; the junction fills everything inside.

export interface JunctionIn {
  junctions: XZ[];
  edges: { a: number; b: number }[];
  /** Road centre lines (resampled) and their cumulative lengths. */
  EP: XZ[][];
  ECUM: number[][];
  /** Half width of road i at point k. */
  halfAt: (i: number, k: number) => number;
  rank: (i: number) => number;
  /** Does road i have kerbs? (Without it, every road ranked 1 or above.) */
  kerbed?: (i: number) => boolean;
  /** Can this road be cut back and joined to a shaped junction? (ground roads) */
  shapeable: (i: number) => boolean;
  /** Joints left unshaped whatever meets there (a slip road splitting off or merging: the roads just overlap). */
  plain?: (j: number) => boolean;
  /** Do these two road ends (line, end) meet as a road and one of its branches at a split? (Its edge then curves from one to the other, whatever the angle.) */
  sideBySide?: (lineA: number, endA: number, lineB: number, endB: number) => boolean;
  /** Is this point a slip road's joint (a slip splitting off or merging, nothing else)? */
  slip?: (j: number) => boolean;
  /** Does this road end carry straight on into another road end at its joint, as one road? (Where a side road meets such a road, the road is not cut back: see `tee`.) */
  thru?: (line: number, end: 0 | 1) => boolean;
  /** Does this road, leaving joint j, climb to a flyover at its far end? (A slip road beside it parts from it as soon as the two are clear, not GAP apart: see teePart.) */
  ramp?: (line: number, j: number) => boolean;
  /** Does an island between a slip road and its road end in a small rounded point (not square across)? */
  round?: boolean;
  roads: SegIndex;
}

/** Mouths face each other (one road carrying on) when their directions are within 30° of opposite. */
const FACING = Math.cos((30 * Math.PI) / 180);
/** A through road's edge may not turn more sharply than this at any one point (cos of 8°). */
const KINK = Math.cos((8 * Math.PI) / 180);

export interface Mouth {
  line: number;
  /** Which end of the road: 0 = its first point, 1 = its last. */
  end: 0 | 1;
  /** Setback along the road from its end, metres. */
  s: number;
  /** Did the mouth clear the other roads before the setback limit? */
  clear: boolean;
  q: XZ;
  /** Unit direction out of the junction. */
  t: XZ;
  half: number;
  /** Corners: toward the next mouth (counter-clockwise) and the previous one. */
  left: XZ;
  right: XZ;
}

/**
 * Two mouths facing each other are one road carrying straight on, with
 * nothing joining on this side (A's left corner to B's right): its edge must
 * run on smoothly from kerb to kerb. Where the corner drawn between them
 * would kink it (a jog sideways, a bend or a change of width taken in one
 * straight cut), it eases across instead.
 */
const eased = (A: Mouth, B: Mouth, curve: XZ[], split = false): XZ[] => {
  if (!split && A.t[0] * B.t[0] + A.t[1] * B.t[1] >= -FACING) return curve;
  const p0 = A.left;
  const p2 = B.right;
  const dirs: XZ[] = [[-A.t[0], -A.t[1]]];
  for (let k = 0; k + 1 < curve.length; k++) {
    const l = Math.hypot(curve[k + 1][0] - curve[k][0], curve[k + 1][1] - curve[k][1]);
    if (l > 0.05) dirs.push([(curve[k + 1][0] - curve[k][0]) / l, (curve[k + 1][1] - curve[k][1]) / l]);
  }
  dirs.push(B.t);
  let turn = 1;
  for (let k = 0; k + 1 < dirs.length; k++) turn = Math.min(turn, dirs[k][0] * dirs[k + 1][0] + dirs[k][1] * dirs[k + 1][1]);
  const L = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]);
  if (turn >= KINK || L <= 1) return curve;
  const n = Math.max(8, Math.min(16, Math.ceil(L)));
  const out: XZ[] = [];
  for (let k = 0; k <= n; k++) {
    const u = k / n;
    const h00 = 2 * u * u * u - 3 * u * u + 1, h10 = u * u * u - 2 * u * u + u, h01 = -2 * u * u * u + 3 * u * u, h11 = u * u * u - u * u;
    out.push([h00 * p0[0] - h10 * L * A.t[0] + h01 * p2[0] + h11 * L * B.t[0], h00 * p0[1] - h10 * L * A.t[1] + h01 * p2[1] + h11 * L * B.t[1]]);
  }
  return out;
};

export interface JunctionShape {
  id: number;
  nodes: number[];
  centre: XZ;
  /** Outline, counter-clockwise (x east, z south): mouth edges and corner curves. */
  ring: XZ[];
  /** Corner curves that get a kerb, each a polyline running counter-clockwise. */
  kerbs: XZ[][];
  /** Every corner curve, kerbed or not (for checks). */
  corners: XZ[][];
  mouths: Mouth[];
  /** Short stubs between merged points, drawn as part of the junction. */
  internal: number[];
  radius: number;
  /** A slip road's wedge (it comes away from the road it meets at a narrow angle), not a side road's bell mouth. */
  slip?: boolean;
}

export interface JunctionOut {
  shapes: JunctionShape[];
  /** Junction shape id for each OSM junction point, or -1. */
  shapeOf: Int32Array;
  /** Setback (m) at each road's first and last point (0 = drawn to the point). */
  trimA: Float32Array;
  trimB: Float32Array;
  internal: Uint8Array;
  /** Openings in a divider with nothing paved: the road's two sides overlap across them, so marks stop over them. */
  bare: Uint8Array;
  /** Junctions that could not be shaped cleanly and keep a plain pad. */
  fallback: number[];
  /** Islands inside big crossings (between slip lanes and the main roads), paved over. */
  /** Ground paved over that is no junction's own outline: islands roads enclose, and the far parts of a slip road's long wedge (`tee`: the joint it belongs to). */
  fills: { ring: XZ[]; centre: XZ; radius: number; tee?: number; slip?: boolean; kerbs?: XZ[][] }[];
  /** Junctions paved as the hull of their mouths. */
  hulls: number;
  /** Why each fallback group was not shaped (for checks). */
  why: { nodes: number[]; why: string; ring?: XZ[] }[];
  /** Joints where a side road meets a road that carries straight on: the road runs through uncut, and the shape is only the side road's bell mouth. */
  tee: Uint8Array;
}

const MERGE_GAP = 10; // two points this close (kerb to kerb) are one junction
const MAJOR_GAP = 32; // where big roads meet: across medians and turning slips
const MAX_SPAN = 70; // but a merged junction is never wider than this
const MAJOR_SPAN = 95;
const MAX_SETBACK = 45;
const SPILL = 5.5; // furthest a junction's edge may reach from its roads' kerbs

const cross = (a: XZ, b: XZ) => a[0] * b[1] - a[1] * b[0];

/** Point and segment index at distance s along a polyline (clamped). */
function along(pts: XZ[], cum: number[], s: number): { p: XZ; seg: number } {
  const n = pts.length;
  if (s <= 0) return { p: pts[0], seg: 0 };
  if (s >= cum[n - 1]) return { p: pts[n - 1], seg: n - 2 };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (cum[m] <= s) lo = m;
    else hi = m;
  }
  const u = (s - cum[lo]) / (cum[lo + 1] - cum[lo] || 1);
  return { p: [pts[lo][0] + (pts[lo + 1][0] - pts[lo][0]) * u, pts[lo][1] + (pts[lo + 1][1] - pts[lo][1]) * u], seg: lo };
}

export function shapeJunctions(I: JunctionIn): JunctionOut {
  const hasKerb = (i: number) => (I.kerbed ? I.kerbed(i) : I.rank(i) >= 1);
  const { junctions, edges, EP, ECUM } = I;
  const NJ = junctions.length;
  const len = ECUM.map((c) => c[c.length - 1]);
  const jE: number[][] = junctions.map(() => []);
  edges.forEach((e, i) => {
    jE[e.a]?.push(i);
    if (e.b !== e.a) jE[e.b]?.push(i);
  });
  const endHalf = (i: number, j: number) => I.halfAt(i, edges[i].a === j ? 0 : EP[i].length - 1);
  const rad = jE.map((l, j) => Math.max(0, ...l.map((i) => endHalf(i, j))));
  const eligible = jE.map((l, j) => l.length >= 3 && !I.plain?.(j) && l.every((i) => I.shapeable(i) && edges[i].a !== edges[i].b));
  // A major junction: two big roads (secondary and up) cross or meet there.
  const major = jE.map((l) => l.filter((i) => I.rank(i) >= 3).length >= 2);

  // A tee: a side road meeting a road that carries straight on (see `thru`).
  // (Or two side roads, one from each side of it. A side road may be only
  // an opening in a divider: a few metres of road to the other side of a
  // divided road, itself a tee there.)
  const thruAt = (i: number, j: number) => !!I.thru && I.thru(i, edges[i].a === j ? 0 : 1);
  const teeAt = jE.map((l, j) => !!I.thru && (l.length === 3 || l.length === 4) && l.filter((i) => thruAt(i, j)).length === 2);
  /** Room for a side road's bell mouth beyond the through road's edge, metres. */
  const TEE_ROOM = 4;

  // ---- Merge points joined by a short stub ----
  const order = edges.map((_, i) => i).sort((p, q) => len[p] - len[q]);
  const mergeBy = (bigOk: boolean, bigGap = MAJOR_GAP, bigSpan = MAJOR_SPAN, ok: boolean[] = eligible, either = false) => {
    const parent = Int32Array.from({ length: NJ }, (_, i) => i);
    const box = junctions.map(([x, z]) => [x, z, x, z]);
    const find = (j: number): number => (parent[j] === j ? j : (parent[j] = find(parent[j])));
    const stub = new Uint8Array(edges.length);
    for (const i of order) {
      const { a, b } = edges[i];
      if (a === b || !ok[a] || !ok[b]) continue;
      // Between two major points the medians and turning slips go too: a
      // big crossing is open asphalt, with no islands in the middle.
      const big = bigOk && (either ? major[a] || major[b] : major[a] && major[b]);
      if (len[i] > rad[a] + rad[b] + (big ? bigGap : MERGE_GAP)) continue;
      // (A tee keeps to itself: its through road is not part of any junction,
      // and its side road needs only room for a bell mouth.)
      if ((teeAt[a] || teeAt[b]) && len[i] > rad[a] + rad[b] + TEE_ROOM) continue;
      // (Nor does it take in a short side road: that ends in a bell mouth
      // with just room for its corners, or is an opening paved between two
      // such roads.)
      if ((teeAt[a] && !thruAt(i, a)) || (teeAt[b] && !thruAt(i, b))) continue;
      // (Nor are two of them one junction because the road between them is
      // short: it carries on through both.)
      if (teeAt[a] && teeAt[b] && thruAt(i, a) && thruAt(i, b)) continue;
      const ra = find(a);
      const rb = find(b);
      stub[i] = 1;
      if (ra === rb) continue;
      const A = box[ra];
      const B = box[rb];
      const bb = [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.max(A[2], B[2]), Math.max(A[3], B[3])];
      if (Math.hypot(bb[2] - bb[0], bb[3] - bb[1]) > (big ? bigSpan : MAX_SPAN)) {
        stub[i] = 0;
        continue;
      }
      parent[rb] = ra;
      box[ra] = bb;
    }
    const groups = new Map<number, number[]>();
    for (let j = 0; j < NJ; j++) {
      if (!ok[j]) continue;
      const r = find(j);
      const g = groups.get(r);
      if (g) g.push(j);
      else groups.set(r, [j]);
    }
    return { groups, stub, find };
  };
  const base = mergeBy(false);
  const wide = mergeBy(true);

  const out: JunctionOut = {
    shapes: [],
    shapeOf: new Int32Array(NJ).fill(-1),
    trimA: new Float32Array(edges.length),
    trimB: new Float32Array(edges.length),
    internal: new Uint8Array(edges.length),
    bare: new Uint8Array(edges.length),
    fallback: [],
    fills: [],
    hulls: 0,
    why: [],
    tee: new Uint8Array(NJ),
  };

  // (Off only to ask what the outline's corners alone would have allowed.)
  let whole = true;
  const cornersOnly = (nodes: number[], stub: Uint8Array) => {
    whole = false;
    const r = shapeGroupRaw(nodes, stub);
    whole = true;
    return r;
  };
  // (On only for the parts of a junction that has come apart: see below.)
  let seek = false;
  const memo = new Map<string, Built | string>();
  // Groups whose shape is settled below: those that keep the shape their
  // outline's corners allowed, and parts that got their curved corners.
  const asWas = new Map<string, Built>();
  const keyOf = (nodes: number[], stub: Uint8Array) => `${stub === wide.stub ? 'w' : 'b'}${[...nodes].sort((p, q) => p - q).join(',')}`;
  const shapeGroup = (nodes: number[], stub: Uint8Array): Built | string => {
    const key = keyOf(nodes, stub);
    const w = asWas.get(key);
    if (w) return w;
    let r = memo.get(key);
    if (r === undefined) memo.set(key, (r = shapeGroupRaw(nodes, stub)));
    return r;
  };
  const shapeGroupRaw = (nodes: number[], stub: Uint8Array): Built | string => {
    const inG = new Set(nodes);
    const lines = new Set<number>();
    for (const j of nodes) for (const i of jE[j]) lines.add(i);
    const internal = [...lines].filter((i) => (stub[i] || len[i] < 80) && inG.has(edges[i].a) && inG.has(edges[i].b));
    const intSet = new Set(internal);
    // Each road end in the group that leads out is a mouth.
    const ends: { line: number; end: 0 | 1 }[] = [];
    for (const i of lines) {
      if (intSet.has(i)) continue;
      if (inG.has(edges[i].a)) ends.push({ line: i, end: 0 });
      if (inG.has(edges[i].b)) ends.push({ line: i, end: 1 });
    }
    // The group's road segments near it, for the distance tests below
    // (a short list beats the map-wide index here).
    const gc = nodes.reduce((a, j) => [a[0] + junctions[j][0] / nodes.length, a[1] + junctions[j][1] / nodes.length], [0, 0]);
    const gr = Math.max(...nodes.map((j) => Math.hypot(junctions[j][0] - gc[0], junctions[j][1] - gc[1]))) + MAX_SETBACK + 20;
    const segs: { o: number; k: number; ax: number; az: number; bx: number; bz: number; h: number }[] = [];
    for (const o of lines) {
      const P = EP[o];
      for (let k = 0; k + 1 < P.length; k++) {
        const [ax, az] = P[k];
        const [bx, bz] = P[k + 1];
        if (Math.min(Math.hypot(ax - gc[0], az - gc[1]), Math.hypot(bx - gc[0], bz - gc[1])) > gr) continue;
        segs.push({ o, k, ax, az, bx, bz, h: I.halfAt(o, k) });
      }
    }
    const each = (x: number, z: number, maxR: number, f: (o: number, k: number, d: number, sg: (typeof segs)[number]) => void, list = segs) => {
      for (const sg of list) {
        const abx = sg.bx - sg.ax;
        const abz = sg.bz - sg.az;
        let u = ((x - sg.ax) * abx + (z - sg.az) * abz) / (abx * abx + abz * abz || 1);
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const d = Math.hypot(sg.ax + abx * u - x, sg.az + abz * u - z);
        if (d <= maxR) f(sg.o, sg.k, d, sg);
      }
    };
    // A junction stays on its roads: no point of its outline is further than
    // a corner's reach from one of them.
    // (Asked of its whole paving, not only the outline's corners: a straight
    // side between two mouths has no corner in its middle, and the ground
    // three roads enclose lies inside every side.)
    const far = (x: number, z: number) => {
      for (const sg of segs) {
        const abx = sg.bx - sg.ax;
        const abz = sg.bz - sg.az;
        let u = ((x - sg.ax) * abx + (z - sg.az) * abz) / (abx * abx + abz * abz || 1);
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const dx = sg.ax + abx * u - x;
        const dz = sg.az + abz * u - z;
        const r = sg.h + SPILL;
        if (dx * dx + dz * dz <= r * r) return false;
      }
      return true;
    };
    const spills = (ring: XZ[]) => {
      if (!whole) return ring.some(([x, z]) => far(x, z));
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let k = 0; k < ring.length; k++) {
        const [ax, az] = ring[k];
        const [bx, bz] = ring[(k + 1) % ring.length];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 1.5));
        for (let q = 0; q < n; q++) if (far(ax + ((bx - ax) * q) / n, az + ((bz - az) * q) / n)) return true;
        x0 = Math.min(x0, ax);
        x1 = Math.max(x1, ax);
        z0 = Math.min(z0, az);
        z1 = Math.max(z1, az);
      }
      for (let x = Math.floor(x0) + 0.5; x < x1; x++) for (let z = Math.floor(z0) + 0.5; z < z1; z++) if (inRingXZ(ring, x, z) && far(x, z)) return true;
      return false;
    };
    // Fillet radius between two roads: wider for bigger roads.
    const R = (p: number, q: number) => 2 + 0.6 * Math.min(4, Math.min(I.rank(p), I.rank(q)));
    const mouths: Mouth[] = [];
    const makeMouth = (line: number, end: 0 | 1, s: number, clear: boolean): Mouth => {
      const pts = EP[line];
      const L = len[line];
      const at = along(pts, ECUM[line], end === 0 ? s : L - s);
      const seg = at.seg;
      // Out of the junction along the road's own segment (as the ribbon draws it).
      let tx = pts[seg + 1][0] - pts[seg][0];
      let tz = pts[seg + 1][1] - pts[seg][1];
      if (end === 1) {
        tx = -tx;
        tz = -tz;
      }
      const tl = Math.hypot(tx, tz) || 1;
      const t: XZ = [tx / tl, tz / tl];
      const h = I.halfAt(line, end === 0 ? seg : seg + 1);
      const n: XZ = [-t[1], t[0]];
      return {
        line,
        end,
        s,
        clear,
        q: at.p,
        t,
        half: h,
        left: [at.p[0] + n[0] * h, at.p[1] + n[1] * h],
        right: [at.p[0] - n[0] * h, at.p[1] - n[1] * h],
      };
    };
    for (const { line, end } of ends) {
      const pts = EP[line];
      const cum = ECUM[line];
      const L = len[line];
      // The far end is shaped too: leave it room.
      const far = end === 0 ? edges[line].b : edges[line].a;
      const cap = Math.min(MAX_SETBACK, L * (eligible[far] ? 0.45 : 0.8));
      let s = 1;
      let clear = false;
      // Only segments within reach of this road's first cap metres matter.
      const e0 = end === 0 ? pts[0] : pts[pts.length - 1];
      const reach = cap + 30;
      const near = segs.filter((sg) => sg.o !== line && Math.min(Math.hypot(sg.ax - e0[0], sg.az - e0[1]), Math.hypot(sg.bx - e0[0], sg.bz - e0[1])) < reach);
      for (; s <= cap; s += 1) {
        const { p } = along(pts, cum, end === 0 ? s : L - s);
        const k = end === 0 ? along(pts, cum, s).seg : along(pts, cum, L - s).seg + 1;
        const h = I.halfAt(line, k);
        // Out of the junction here.
        const sg = end === 0 ? k - 0 : k - 1;
        let ux = pts[sg + 1][0] - pts[sg][0];
        let uz = pts[sg + 1][1] - pts[sg][1];
        const ul = Math.hypot(ux, uz) || 1;
        ux /= ul;
        uz /= ul;
        let ok = true;
        each(p[0], p[1], h + 12, (o, oseg, d) => {
          if (!ok) return;
          // A road running alongside (the other carriageway, a merging slip
          // road) only has to be clear of this one, not by a corner's width:
          // where two roads split, the junction runs on until they part.
          const op = EP[o];
          const vx = op[oseg + 1][0] - op[oseg][0];
          const vz = op[oseg + 1][1] - op[oseg][1];
          if (Math.abs(ux * vx + uz * vz) > 0.94 * (Math.hypot(vx, vz) || 1)) {
            // (Lanes that never part within a few metres just overlap.)
            if (s < 15 && d < I.halfAt(o, oseg) + h + 0.3) ok = false;
            return;
          }
          // The cut must clear road o's kerb by the corner radius, across its whole width.
          if (d < I.halfAt(o, oseg) + h + R(line, o)) ok = false;
        }, near);
        if (ok) {
          clear = true;
          break;
        }
      }
      mouths.push(makeMouth(line, end, Math.min(s, cap), clear));
    }
    // Roads leaving side by side (a split into two carriageways, two lanes
    // that part later) end level with each other, so their mouths sit side
    // by side and the edge between them runs straight across.
    for (let pass = 0; pass < 3; pass++)
      for (let a = 0; a < mouths.length; a++)
        for (let b = 0; b < mouths.length; b++) {
          const A = mouths[a];
          const B = mouths[b];
          if (a === b || A.s >= B.s) continue;
          if (A.t[0] * B.t[0] + A.t[1] * B.t[1] < 0.85) continue;
          if (Math.hypot(A.q[0] - B.q[0], A.q[1] - B.q[1]) > A.half + B.half + 8) continue;
          const cap = Math.min(MAX_SETBACK, len[A.line] * 0.8);
          mouths[a] = makeMouth(A.line, A.end, Math.min(B.s, cap), A.clear);
        }
    if (mouths.length < 2) return 'mouths';
    const mean = (pts: XZ[]): XZ => [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
    // How well a point sees an outline: above zero when every step of the
    // outline turns the same way round it (the paving is filled as a fan).
    const sees = (ring: XZ[], c: XZ) => {
      let least = Infinity;
      for (let k = 0; k < ring.length; k++) {
        const p = ring[k];
        const q = ring[(k + 1) % ring.length];
        least = Math.min(least, cross([p[0] - c[0], p[1] - c[1]], [q[0] - c[0], q[1] - c[1]]));
      }
      return least;
    };
    const seesBest = (ring: XZ[], from: XZ): XZ => {
      let centre = from;
      let best = sees(ring, centre);
      const x0 = Math.min(...ring.map((p) => p[0])), x1 = Math.max(...ring.map((p) => p[0]));
      const z0 = Math.min(...ring.map((p) => p[1])), z1 = Math.max(...ring.map((p) => p[1]));
      const step = Math.max(0.5, Math.max(x1 - x0, z1 - z0) / 40);
      for (let z = z0; z <= z1; z += step)
        for (let x = x0; x <= x1; x += step) {
          const v = sees(ring, [x, z]);
          if (v > best) {
            best = v;
            centre = [x, z];
          }
        }
      return centre;
    };
    /** The middle of the part of an outline (anticlockwise) that sees all of it, or null if no point does. */
    const kernelOf = (ring: XZ[]): XZ | null => {
      const x0 = Math.min(...ring.map((p) => p[0])), x1 = Math.max(...ring.map((p) => p[0]));
      const z0 = Math.min(...ring.map((p) => p[1])), z1 = Math.max(...ring.map((p) => p[1]));
      let poly: XZ[] = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
      for (let k = 0; k < ring.length && poly.length >= 3; k++) {
        const a = ring[k], b = ring[(k + 1) % ring.length];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const dl = Math.hypot(dx, dz);
        if (dl < 1e-6) continue;
        // (Kept: the side of a -> b the outline's inside is on, by a millimetre or more.)
        const side = (p: XZ) => (dx * (p[1] - a[1]) - dz * (p[0] - a[0])) / dl - 0.001;
        const next: XZ[] = [];
        for (let q = 0; q < poly.length; q++) {
          const P = poly[q], Q = poly[(q + 1) % poly.length];
          const sP = side(P), sQ = side(Q);
          if (sP >= 0) next.push(P);
          if (sP >= 0 !== sQ >= 0) {
            const u = sP / (sP - sQ);
            next.push([P[0] + (Q[0] - P[0]) * u, P[1] + (Q[1] - P[1]) * u]);
          }
        }
        poly = next;
      }
      if (poly.length < 3) return null;
      let A = 0, cx = 0, cz = 0;
      for (let q = 0; q < poly.length; q++) {
        const P = poly[q], Q = poly[(q + 1) % poly.length];
        const w = cross(P, Q);
        A += w;
        cx += (P[0] + Q[0]) * w;
        cz += (P[1] + Q[1]) * w;
      }
      // (A kernel all but nothing, a sliver along one line: its centroid by
      // area is ill-conditioned and landed tens of metres off along that
      // line, and the paving was drawn from there, folded over. The mean of
      // its corners lies in it, being convex.)
      const mean: XZ = [poly.reduce((t, p) => t + p[0], 0) / poly.length, poly.reduce((t, p) => t + p[1], 0) / poly.length];
      if (Math.abs(A) < 2e-4) return Math.abs(A) < 1e-12 ? null : mean;
      const c: XZ = [cx / (3 * A), cz / (3 * A)];
      return Math.hypot(c[0] - mean[0], c[1] - mean[1]) < Math.hypot(x1 - x0, z1 - z0) ? c : mean;
    };
    /**
     * A simple outline (anticlockwise) that no one point sees all of, in
     * parts that each have one: cut into triangles, then those joined
     * again wherever two side by side still have a point that sees both.
     * Null where the outline crosses itself.
     */
    const starParts = (ring: XZ[]): { ring: XZ[]; c: XZ }[] | null => {
      const n = ring.length;
      if (n < 3) return null;
      const segX = (a: XZ, b: XZ, c: XZ, d: XZ) => {
        const o = (p: XZ, q: XZ, r: XZ) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
        return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
      };
      for (let i = 0; i < n; i++)
        for (let k = i + 2; k < n; k++) if (!(i === 0 && k === n - 1) && segX(ring[i], ring[(i + 1) % n], ring[k], ring[(k + 1) % n])) return null;
      // Ears, clipped one at a time.
      const left = ring.map((_, i) => i);
      const tris: number[][] = [];
      const inTri = (p: XZ, a: XZ, b: XZ, c: XZ) => cross([b[0] - a[0], b[1] - a[1]], [p[0] - a[0], p[1] - a[1]]) > 1e-9 && cross([c[0] - b[0], c[1] - b[1]], [p[0] - b[0], p[1] - b[1]]) > 1e-9 && cross([a[0] - c[0], a[1] - c[1]], [p[0] - c[0], p[1] - c[1]]) > 1e-9;
      for (let guard = 0; left.length > 3 && guard < n * n; guard++) {
        let cut = -1;
        for (let q = 0; q < left.length && cut < 0; q++) {
          const a = ring[left[(q + left.length - 1) % left.length]], b = ring[left[q]], c = ring[left[(q + 1) % left.length]];
          if (cross([b[0] - a[0], b[1] - a[1]], [c[0] - b[0], c[1] - b[1]]) <= 1e-9) continue;
          if (left.some((v) => v !== left[q] && v !== left[(q + left.length - 1) % left.length] && v !== left[(q + 1) % left.length] && inTri(ring[v], a, b, c))) continue;
          cut = q;
        }
        if (cut < 0) return null;
        tris.push([left[(cut + left.length - 1) % left.length], left[cut], left[(cut + 1) % left.length]]);
        left.splice(cut, 1);
      }
      if (left.length === 3) tris.push([...left]);
      // Joined again: two pieces that share a side become one wherever a point still sees the whole.
      let parts = tris.map((t) => [...t]);
      for (let joined = true; joined; ) {
        joined = false;
        for (let a = 0; a < parts.length && !joined; a++)
          for (let b = a + 1; b < parts.length && !joined; b++) {
            const A = parts[a], B = parts[b];
            for (let x = 0; x < A.length && !joined; x++) {
              const u = A[x], v = A[(x + 1) % A.length];
              const y = B.findIndex((w, k) => w === v && B[(k + 1) % B.length] === u);
              if (y < 0) continue;
              // (A from v round to u, then B's points between u and v.)
              const m: number[] = [];
              for (let k = 0; k < A.length; k++) m.push(A[(x + 1 + k) % A.length]);
              for (let k = 2; k < B.length; k++) m.push(B[(y + k) % B.length]);
              if (!kernelOf(m.map((i) => ring[i]))) continue;
              parts[a] = m;
              parts.splice(b, 1);
              joined = true;
            }
          }
      }
      const got = parts.map((q) => {
        const r = q.map((i) => ring[i]);
        return { ring: r, c: kernelOf(r) };
      });
      if (got.some((q) => !q.c)) return null;
      return got as { ring: XZ[]; c: XZ }[];
    };
    // A side road meeting a road that carries straight on (a tee): the
    // through road is one strip, not cut back at the joint, so the junction
    // is only the side road's bell mouth: from its mouth, round a corner
    // curve either side, to the through road's edge.
    const INSET = 0.1; // the paving tucks this far under the through road's edge
    const REACH = 120; // (A slip road off an expressway may run beside it this far before it is clear: the map tool asks the same.)
    /** Where side road sLine's two edges leave the road running through joint j (null: they never do). */
    const teeGeom = (j: number, sLine: number) => {
      const through = jE[j].filter((i) => thruAt(i, j));
      const sEnd: 0 | 1 = edges[sLine].a === j ? 0 : 1;
      // Each through piece from the joint outward: its points and half widths.
      const legs = through.map((i) => {
        const pts = EP[i];
        const n = pts.length;
        const fromA = edges[i].a === j;
        const P: XZ[] = [];
        const H: number[] = [];
        let run = 0;
        for (let step = 0; step < n && run <= REACH; step++) {
          const k = fromA ? step : n - 1 - step;
          if (step) run += Math.hypot(pts[k][0] - P[P.length - 1][0], pts[k][1] - P[P.length - 1][1]);
          P.push(pts[k]);
          H.push(I.halfAt(i, k));
        }
        return { P, H };
      });
      if (legs.some((o) => o.P.length < 2)) return null;
      // Distance from a point to the through road's middle, less its half width there (below zero: on the road).
      const offRoad = (x: number, z: number) => {
        let best = Infinity;
        for (const { P, H } of legs)
          for (let k = 0; k + 1 < P.length; k++) {
            const ax = P[k][0], az = P[k][1];
            const dx = P[k + 1][0] - ax, dz = P[k + 1][1] - az;
            const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
            best = Math.min(best, Math.hypot(x - ax - dx * u, z - az - dz * u) - (H[k] + (H[k + 1] - H[k]) * u));
          }
        return best;
      };
      // The side road, from the joint outward: where each of its edges leaves the through road.
      const sp = EP[sLine];
      const sc = I.ECUM[sLine];
      const sL = len[sLine];
      const sideAt = (d: number, sgn: number): XZ => {
        const at = along(sp, sc, sEnd === 0 ? d : sL - d);
        let tx = sp[at.seg + 1][0] - sp[at.seg][0], tz = sp[at.seg + 1][1] - sp[at.seg][1];
        if (sEnd === 1) (tx = -tx), (tz = -tz);
        const tl = Math.hypot(tx, tz) || 1;
        const h = I.halfAt(sLine, sEnd === 0 ? at.seg : at.seg + 1);
        return [at.p[0] - (tz / tl) * h * sgn, at.p[1] + (tx / tl) * h * sgn];
      };
      // (Where each edge of the side road comes clear of the road. A side
      // road as wide as the road, leaving at a narrow angle, has both edges
      // on the road's edges at the joint: the one on the far side then runs
      // in across the road and leaves it only at the far edge, where the
      // wedge between the two closes. Taken where it first touched the
      // edge, both left at once and its mouth folded over itself.)
      const leaves = [1, -1].map((sgn) => {
        let wasIn = false;
        for (let d = 0; d <= Math.min(sL, REACH); d += 0.25) {
          const p = sideAt(d, sgn);
          const o = offRoad(p[0], p[1]);
          if (o < -INSET) wasIn = true;
          else if (wasIn) return { d, p };
          else {
            const q = sideAt(d + 0.5, sgn);
            if (offRoad(q[0], q[1]) >= o) return { d, p };
          }
        }
        return null;
      });
      return { through, sEnd, legs, offRoad, sp, sL, sideAt, leaves };
    };
    type TeePart = { ring: XZ[]; corners: XZ[][]; kerbs: XZ[][]; c: XZ; mouth: Mouth | null; inside: number | null; more: NonNullable<Built['more']>; kerbed: boolean; flip: number; sharp: boolean; empty?: boolean };
    /** The paving where side road sLine meets the road running through joint j. */
    const teePart = (j: number, sLine: number, no: (why: string, ring?: XZ[]) => null, asSlip = false): TeePart | null => {
      const G = teeGeom(j, sLine);
      if (!G) return no('short');
      const { through, sEnd, legs, offRoad, sp, sL, sideAt, leaves } = G;
      if (!leaves[0] || !leaves[1]) return no('side road never leaves the road');
      const hS = I.halfAt(sLine, sEnd === 0 ? 0 : sp.length - 1);
      const farJ = sEnd === 0 ? edges[sLine].b : edges[sLine].a;
      // (The far end needs room for its own junction, if it has one.)
      const room = jE[farJ].length >= 3 ? Math.max(sL * 0.5, sL - rad[farJ] - 4) : sL * 0.8;
      const dMax = Math.max(leaves[0].d, leaves[1].d);
      // A slip road: it comes away at a narrow angle (under about 40 degrees:
      // one edge leaves the road much further out than the other). No corner
      // is rounded on the side of the wedge between the two roads: the two
      // are one surface until they are GAP apart, and the slip road's own
      // strip starts there.
      const g = leaves[0].d >= leaves[1].d ? 0 : 1; // the wedge's side: 0 the side road's left as it leaves, 1 its right
      // (Not an opening in a divider that crosses it on the slant: a few
      // metres over to the other side of the road, itself a tee there.)
      const opener = teeAt[farJ] && !thruAt(sLine, farJ) && sL < 30;
      const sharp = !opener && (asSlip || Math.abs(leaves[0].d - leaves[1].d) > 2.4 * hS);
      // (Beside a road climbing to a flyover, only until the two are clear
      // of each other: one climbs, the other does not, and paving between
      // them would be a slope across from one to the other. Bartley Road
      // East's slip road ran 117 m beside its ramp, under 1.8 m apart.)
      const GAP = through.some((i) => I.ramp?.(i, j)) ? 0.3 : 1.8; // (a little more than the 1.5 m under which roads side by side are paved as one: that paving has nothing left to do here)
      let dG = -1;
      if (sharp) {
        for (let d = leaves[g]!.d; d <= Math.min(sL, REACH); d += 0.5) {
          const p = sideAt(d, g === 0 ? 1 : -1);
          if (offRoad(p[0], p[1]) >= GAP - INSET) {
            dG = d;
            break;
          }
        }
        if (dG < 0 || dG > room) return no('no room for the slip road to come away');
      }
      // An opening in a divider: the side road is a few metres across to
      // another road that runs through its own joint the same way, with no
      // room between the two for a strip of its own. Each joint paves its
      // half: as far as half way across the gap between the two roads' edges.
      const Rd = Math.max(2.5, Math.min(6, 1.5 + hS * 0.8));
      let openAt = -1;
      // (Where the two roads' edges come within 0.3 m of each other across
      // it, or overlap, the two pavings would too: each is cut back at the
      // opening's middle, the line where the other's begins.)
      let cutMid = false;
      let dF0 = -1;
      if (!sharp && teeAt[farJ] && !thruAt(sLine, farJ)) {
        const F = teeGeom(farJ, sLine);
        const dF = F && F.leaves[0] && F.leaves[1] ? Math.max(F.leaves[0].d, F.leaves[1].d) : -1;
        dF0 = dF;
        if (dF >= 0 && sL - dMax - dF < 2 * Rd + 3) openAt = dMax + Math.max(0.15, (sL - dMax - dF) / 2);
        cutMid = openAt >= 0 && sL - dMax - dF < 0.3;
      }
      // (A slip road's outside edge swings onto the road's over a longer curve.)
      const R = sharp ? Math.min(10, dG - leaves[1 - g]!.d) : Math.min(Rd, (openAt >= 0 ? openAt : room) - dMax);
      // (A short stub has room for corners of half a metre at least.)
      if (R < (openAt >= 0 ? 0.1 : 0.4)) return no('no room for the corners');
      const M = makeMouth(sLine, sEnd, sharp ? dG : openAt >= 0 ? openAt : dMax + R, true);
      // The through road's edge on the side road's side, as one line through the joint.
      const edgeLine = (o: (typeof legs)[number], flip: number): XZ[] =>
        o.P.map((p, k) => {
          const a = o.P[Math.max(0, k - 1)], b = o.P[Math.min(o.P.length - 1, k + 1)];
          const dl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          const h = Math.max(0, o.H[k] - INSET) * flip;
          return [p[0] - ((b[1] - a[1]) / dl) * h, p[1] + ((b[0] - a[0]) / dl) * h] as XZ;
        });
      const sDir: XZ = [M.q[0] - junctions[j][0], M.q[1] - junctions[j][1]];
      const flipOf = (o: (typeof legs)[number]) => (cross([o.P[1][0] - o.P[0][0], o.P[1][1] - o.P[0][1]], sDir) > 0 ? 1 : -1);
      // Another side road close by on the same side of the road, at the
      // next joint along it (the other side of a divided road, a few
      // metres on): each rounds its corner over no more than half the gap
      // between the two, so their pavings meet and never overlap. (With no
      // gap to speak of, the corner is square: the divider's nose.)
      const lim = [R, R];
      if (!sharp)
        for (const t of through) {
          const j2 = edges[t].a === j ? edges[t].b : edges[t].a;
          if (len[t] > 40 || !teeAt[j2] || !thruAt(t, j2)) continue;
          const along: XZ = [junctions[j2][0] - junctions[j][0], junctions[j2][1] - junctions[j][1]];
          for (const s2 of jE[j2]) {
            if (thruAt(s2, j2)) continue;
            const G2 = teeGeom(j2, s2);
            if (!G2 || !G2.leaves[0] || !G2.leaves[1]) continue;
            const q2 = G2.sideAt(Math.min(G2.sL, Math.max(G2.leaves[0].d, G2.leaves[1].d) + 2), 0);
            if (cross(along, sDir) > 0 !== cross(along, [q2[0] - junctions[j2][0], q2[1] - junctions[j2][1]]) > 0) continue;
            for (const lv2 of G2.leaves)
              for (const k of [0, 1]) lim[k] = Math.min(lim[k], Math.max(0, (Math.hypot(leaves[k]!.p[0] - lv2!.p[0], leaves[k]!.p[1] - lv2!.p[1]) - 0.3) / 2));
          }
        }
      const e0 = edgeLine(legs[0], flipOf(legs[0]));
      const e1 = edgeLine(legs[1], flipOf(legs[1]));
      const jp: XZ = [(e0[0][0] + e1[0][0]) / 2, (e0[0][1] + e1[0][1]) / 2];
      const E: XZ[] = [...e0.slice(1).reverse(), jp, ...e1.slice(1)];
      const eCum = [0];
      for (let k = 1; k < E.length; k++) eCum.push(eCum[k - 1] + Math.hypot(E[k][0] - E[k - 1][0], E[k][1] - E[k - 1][1]));
      const eLen = eCum[eCum.length - 1];
      const uOf = (p: XZ) => {
        let best = Infinity, bu = 0;
        for (let k = 0; k + 1 < E.length; k++) {
          const dx = E[k + 1][0] - E[k][0], dz = E[k + 1][1] - E[k][1];
          const u = Math.max(0, Math.min(1, ((p[0] - E[k][0]) * dx + (p[1] - E[k][1]) * dz) / (dx * dx + dz * dz || 1)));
          const d = Math.hypot(p[0] - E[k][0] - dx * u, p[1] - E[k][1] - dz * u);
          if (d < best) (best = d), (bu = eCum[k] + u * (eCum[k + 1] - eCum[k]));
        }
        return bu;
      };
      const eAt = (u: number) => along(E, eCum, Math.max(0, Math.min(eLen, u))).p;
      // (Left of the side road as it leaves, then right.)
      const corner = [M.left, M.right];
      const uX = leaves.map((lv) => uOf(lv!.p));
      if (Math.abs(uX[0] - uX[1]) < 0.5) return no('corners meet');
      const curveOf = (k: number): XZ[] => {
        const outU = uX[k] + (uX[k] > uX[1 - k] ? lim[k] : -lim[k]);
        if (outU < 0.5 || outU > eLen - 0.5) return [];
        const p0 = corner[k], c1 = eAt(uX[k]), p2 = eAt(outU);
        const n = 8;
        const c: XZ[] = [];
        for (let q = 0; q <= n; q++) {
          const u = q / n;
          c.push([(1 - u) * (1 - u) * p0[0] + 2 * u * (1 - u) * c1[0] + u * u * p2[0], (1 - u) * (1 - u) * p0[1] + 2 * u * (1 - u) * c1[1] + u * u * p2[1]]);
        }
        return c;
      };
      let ring: XZ[];
      let corners: XZ[][];
      let c: XZ;
      let more: Built['more'];
      let kerbLines: XZ[][] | undefined;
      if (sharp) {
        const o = 1 - g;
        const sgnO = o === 0 ? 1 : -1;
        // Where the mouth's corner on the wedge's side is nearest the road's edge: the paving closes straight across there.
        const uG = uOf(corner[g]);
        const outU = uX[o] + (uX[o] > uG ? R : -R);
        if (outU < 0.5 || outU > eLen - 0.5) return no('no corner');
        // The outside: back along the slip road's own edge from its mouth, then round onto the road's edge.
        const outer: XZ[] = [corner[o]];
        for (let d = dG - 2; d > leaves[o]!.d + R + 1; d -= 2) outer.push(sideAt(d, sgnO));
        const p0 = sideAt(leaves[o]!.d + R, sgnO), c1 = eAt(uX[o]), p2 = eAt(outU);
        for (let q = 0; q <= 8; q++) {
          const u = q / 8;
          outer.push([(1 - u) * (1 - u) * p0[0] + 2 * u * (1 - u) * c1[0] + u * u * p2[0], (1 - u) * (1 - u) * p0[1] + 2 * u * (1 - u) * c1[1] + u * u * p2[1]]);
        }
        const nose: XZ[] = [eAt(uG), corner[g]];
        // The road's edge between the two, from the rounded end to the wedge.
        const between: XZ[] = [];
        const fwd = uG > outU;
        for (let k = fwd ? 0 : E.length - 1; k >= 0 && k < E.length; k += fwd ? 1 : -1)
          if (eCum[k] > Math.min(uG, outU) + 0.3 && eCum[k] < Math.max(uG, outU) - 0.3) between.push(E[k]);
        ring = [...nose, ...outer, ...between];
        corners = [outer, nose];
        const ccw = (r: XZ[]) => {
          let area = 0;
          for (let k = 0; k < r.length; k++) area += cross(r[k], r[(k + 1) % r.length]);
          return area >= 0;
        };
        const turned = !ccw(ring);
        if (turned) {
          ring = ring.reverse();
          corners = [[...nose].reverse(), [...outer].reverse()];
        }
        // (The kerbs stop at the road's edge: the outline itself tucks under it.)
        const clearOfRoad = (q: XZ) => offRoad(q[0], q[1]) >= 0.2;
        const noseOut = Math.min(0.9, 0.4 / (Math.hypot(nose[1][0] - nose[0][0], nose[1][1] - nose[0][1]) || 1));
        const noseK: XZ[] = [[nose[0][0] + (nose[1][0] - nose[0][0]) * noseOut, nose[0][1] + (nose[1][1] - nose[0][1]) * noseOut], nose[1]];
        const outerK = outer.filter(clearOfRoad);
        kerbLines = turned ? [[...noseK].reverse(), [...outerK].reverse()] : [outerK, noseK];
        kerbLines = kerbLines.filter((k) => k.length >= 2);
        let k0 = kernelOf(ring);
        if (!k0) {
          // A long wedge beside a curving road can't be filled from one
          // point. It is cut across into lengths of 12 m or so: the one at
          // the mouth is the junction's own outline, the rest are paved
          // with it (same surface, same height), each from its own centre.
          const lower: XZ[] = [eAt(uG), ...[...between].reverse(), eAt(outU)];
          const even = (poly: XZ[], n: number): XZ[] => {
            const cum = [0];
            for (let k = 1; k < poly.length; k++) cum.push(cum[k - 1] + Math.hypot(poly[k][0] - poly[k - 1][0], poly[k][1] - poly[k - 1][1]));
            const out: XZ[] = [];
            for (let k = 0; k <= n; k++) out.push(along(poly, cum, (cum[cum.length - 1] * k) / n).p);
            return out;
          };
          const lenOf = (poly: XZ[]) => {
            let l = 0;
            for (let k = 1; k < poly.length; k++) l += Math.hypot(poly[k][0] - poly[k - 1][0], poly[k][1] - poly[k - 1][1]);
            return l;
          };
          // (Its far end comes to a point along the road's edge, which no
          // centre can see into: it stops where it is 0.2 m wide, half of
          // that tucked under the road's edge and the rest under the kerb.)
          const fine = Math.max(8, Math.ceil(lenOf(outer)));
          const O0 = even(outer, fine), L0 = even(lower, fine);
          let end = fine;
          while (end > 2 && Math.hypot(O0[end][0] - L0[end][0], O0[end][1] - L0[end][1]) < 0.2) end--;
          const oCut = O0.slice(0, end + 1), lCut = L0.slice(0, end + 1);
          const lenO = lenOf(oCut);
          let parts: XZ[][] = [];
          let cs: (XZ | null)[] = [null];
          // (Shorter lengths where the road curves too much for these.)
          for (let K = Math.max(2, Math.ceil(lenO / 12)); K <= 64 && cs.some((x) => !x); K *= 2) {
            const m = Math.max(2, Math.ceil(lenO / K / 2.5));
            const O = even(oCut, K * m), Lw = even(lCut, K * m);
            parts = [];
            for (let q = 0; q < K; q++) {
              const a = q * m, b = (q + 1) * m;
              let part: XZ[] = [Lw[a], ...(q === 0 ? [corner[g]] : []), ...O.slice(a, b + 1), ...Lw.slice(a + 1, b + 1).reverse()];
              if (!ccw(part)) part = part.reverse();
              parts.push(part);
            }
            cs = parts.map((r) => kernelOf(r));
            // (A length that has come to nothing, its two sides on one
            // another, has nothing to pave: no centre sees into it, and none
            // needs to. Not the one at the mouth.)
            const nil = (r: XZ[]) => Math.abs(r.reduce((t, p, k) => t + cross(p, r[(k + 1) % r.length]), 0)) / 2 < 0.02;
            if (cs.some((x, q) => !x && q > 0 && nil(parts[q]))) {
              const keep = parts.map((r, q) => !!cs[q] || q === 0 || !nil(r));
              parts = parts.filter((_, q) => keep[q]);
              cs = cs.filter((_, q) => keep[q]);
            }
          }
          if (cs.some((x) => !x)) return no('outline folds: wedge', parts[cs.findIndex((x) => !x)]);
          ring = parts[0];
          k0 = cs[0];
          more = parts.slice(1).map((r, q) => ({ ring: r, centre: cs[q + 1]!, radius: Math.max(...r.map((p) => Math.hypot(p[0] - cs[q + 1]![0], p[1] - cs[q + 1]![1]))) }));
        }
        // The island's end beyond the wedge: a small rounded point, its two
        // sides tapering in over 4 m from the two roads' edges (square
        // across, the kerb and edge lines turned two sharp corners round it).
        // Paved as two shoulders, one from each road's edge to the point.
        if (I.round) {
          const sgnG = g === 0 ? 1 : -1;
          const s = fwd ? 1 : -1;
          const L = Math.min(4, sL - dG - 0.1);
          // (The road's edge past the end of the line through the joint, as it was going.)
          const eAtX = (u: number): XZ => {
            if (u >= 0 && u <= eLen) return eAt(u);
            const [p, q] = u < 0 ? [E[0], E[1]] : [E[E.length - 1], E[E.length - 2]];
            const dl = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
            const o = u < 0 ? -u : u - eLen;
            return [p[0] + ((p[0] - q[0]) / dl) * o, p[1] + ((p[1] - q[1]) / dl) * o];
          };
          const A0 = eAt(uG), B0 = corner[g];
          const w = Math.hypot(B0[0] - A0[0], B0[1] - A0[1]);
          const Rn = Math.min(0.5, w / 2 - 0.05);
          if (L >= 1 && Rn >= 0.05) {
            /** The side road's edge at d, a little in on its strip. */
            const sideIn = (d: number): XZ => {
              const p = sideAt(d, sgnG), q = sideAt(d, -sgnG);
              const t = 0.1 / (Math.hypot(q[0] - p[0], q[1] - p[1]) || 1);
              return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
            };
            const aL = eAtX(uG + s * L), bL = sideIn(dG + L);
            const mx = (A0[0] + B0[0]) / 2, mz = (A0[1] + B0[1]) / 2;
            const dl = Math.hypot((aL[0] + bL[0]) / 2 - mx, (aL[1] + bL[1]) / 2 - mz) || 1;
            const dd: XZ = [((aL[0] + bL[0]) / 2 - mx) / dl, ((aL[1] + bL[1]) / 2 - mz) / dl];
            // (Its point a little back from the line across, the paving
            // round it all one piece: touching the line, the two shoulders
            // either side met at a point and no centre could see into them.)
            // (Clear of the line across by that much square to it: the line
            // may lie aslant across the island.)
            const nb = Math.abs(dd[0] * (B0[1] - A0[1]) - dd[1] * (B0[0] - A0[0])) / (w || 1);
            const off = (Rn + 0.1) / Math.max(0.35, nb);
            const C: XZ = [mx + dd[0] * off, mz + dd[1] * off];
            const ua: XZ = [(A0[0] - mx) / (w || 1), (A0[1] - mz) / (w || 1)];
            const touch = (P: XZ, side: XZ): number => {
              const vx = P[0] - C[0], vz = P[1] - C[1];
              const D = Math.hypot(vx, vz);
              const base = Math.atan2(vz, vx), off = Math.acos(Math.min(1, Rn / D));
              const t1 = base + off, t2 = base - off;
              return Math.cos(t1) * side[0] + Math.sin(t1) * side[1] >= Math.cos(t2) * side[0] + Math.sin(t2) * side[1] ? t1 : t2;
            };
            const wrap = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
            const front = Math.atan2(-dd[1], -dd[0]);
            const tA = touch(aL, ua), tB = touch(bL, [-ua[0], -ua[1]]);
            // (Round the front, past the point nearest the wedge.)
            let sweep = wrap(tB - tA);
            if (wrap(front - tA) > sweep) sweep -= 2 * Math.PI;
            const N = Math.max(3, Math.ceil(Math.abs(sweep) / (Math.PI / 12)), Math.ceil((Math.abs(sweep) * Rn) / 0.3));
            const arc: XZ[] = [];
            for (let k = 0; k <= N; k++) arc.push([C[0] + Math.cos(tA + (sweep * k) / N) * Rn, C[1] + Math.sin(tA + (sweep * k) / N) * Rn]);
            const eMid: XZ[] = [];
            for (let k = 0; k < E.length; k++) if (s * (eCum[k] - uG) > 0.05 && s * (eCum[k] - uG) < L - 0.05) eMid.push(E[k]);
            if (!fwd) eMid.reverse();
            const sMid: XZ[] = [];
            for (let d = dG + 1; d < dG + L - 0.05; d += 1) sMid.push(sideIn(d));
            let sh: XZ[] = [A0, ...eMid, aL, ...arc, bL, ...sMid.reverse(), B0];
            if (!ccw(sh)) sh = sh.reverse();
            const kc = kernelOf(sh);
            const parts = kc ? [{ ring: sh, c: kc }] : starParts(sh) ?? [];
            for (const q of parts) more = [...(more ?? []), { ring: q.ring, centre: q.c, radius: Math.max(...q.ring.map((p) => Math.hypot(p[0] - q.c[0], p[1] - q.c[1]))) }];
          }
        }
        c = k0 ?? eAt((uG + outU) / 2);
      } else {
        const lo = uX[0] < uX[1] ? 0 : 1;
        const hi = 1 - lo;
        const cLo = curveOf(lo); // mouth corner -> the edge
        const cHi = curveOf(hi);
        if (!cLo.length || !cHi.length) return no('no corner');
        const uLo = uX[lo] - lim[lo], uHi = uX[hi] + lim[hi];
        const between: XZ[] = [];
        for (let k = E.length - 1; k >= 0; k--) if (eCum[k] > uLo + 0.3 && eCum[k] < uHi - 0.3) between.push(E[k]);
        // Edge (low end) -> round to the mouth -> across it -> round to the edge (high end) -> back along the edge.
        ring = [...[...cLo].reverse(), ...cHi, ...between];
        let area = 0;
        for (let k = 0; k < ring.length; k++) area += cross(ring[k], ring[(k + 1) % ring.length]);
        corners = [[...cLo].reverse(), cHi];
        if (area < 0) {
          ring = ring.reverse();
          corners = [[...cHi].reverse(), cLo];
        }
        const mid = eAt((uLo + uHi) / 2);
        c = [mid[0] + (M.q[0] - mid[0]) * 0.3, mid[1] + (M.q[1] - mid[1]) * 0.3];
        if (sees(ring, c) <= 1e-6) c = seesBest(ring, c);
      }
      // (Two points of the outline a hair apart, where a corner curve ends
      // on the road's edge, make a side of no length pointing anywhere: no
      // point would see round it.)
      ring = ring.filter((p, k) => Math.hypot(p[0] - ring[(k + 1) % ring.length][0], p[1] - ring[(k + 1) % ring.length][1]) > 1e-3);
      // (A bell mouth's corners come in along the road's edge, so the points
      // that see the whole outline can be a strip a hand wide: found exactly.)
      if (sees(ring, c) <= 1e-6) c = kernelOf(ring) ?? c;
      // (An outline that bends round the inside of a curving road may have
      // no one point that sees all of it: it is paved in parts, the one
      // with the side road's mouth the junction's own, the rest with it.)
      if (sees(ring, c) <= 1e-6) {
        const sp2 = starParts(ring);
        if (sp2 && sp2.length > 1) {
          const mid: XZ = [(M.left[0] + M.right[0]) / 2, (M.left[1] + M.right[1]) / 2];
          const near = (r: XZ[]) => Math.min(...r.map((p) => Math.hypot(p[0] - mid[0], p[1] - mid[1])));
          sp2.sort((p, q) => near(p.ring) - near(q.ring));
          ring = sp2[0].ring;
          c = sp2[0].c;
          more = [...(more ?? []), ...sp2.slice(1).map((q) => ({ ring: q.ring, centre: q.c, radius: Math.max(...q.ring.map((p) => Math.hypot(p[0] - q.c[0], p[1] - q.c[1]))) }))];
        }
      }
      if (sees(ring, c) <= 1e-6) {
        return no('outline folds', ring);
      }
      const kerbed = [sLine, ...through].some(hasKerb);
      if (cutMid) {
        // The opening's middle: the line across it half way along.
        const at = along(sp, I.ECUM[sLine], sL / 2);
        let tx = sp[at.seg + 1][0] - sp[at.seg][0], tz = sp[at.seg + 1][1] - sp[at.seg][1];
        if (sEnd === 1) (tx = -tx), (tz = -tz);
        const tl = Math.hypot(tx, tz) || 1;
        // (Kept: this joint's side of it, signed distance below zero.)
        const sd = (q: XZ) => ((q[0] - at.p[0]) * tx + (q[1] - at.p[1]) * tz) / tl;
        const clip = (poly: XZ[], closed: boolean): XZ[] => {
          const o: XZ[] = [];
          const n = poly.length;
          for (let k = 0; k < (closed ? n : n - 1); k++) {
            const P = poly[k], Q = poly[(k + 1) % n];
            const a = sd(P), b = sd(Q);
            if (a <= 0) o.push(P);
            if ((a < 0 && b > 0) || (a > 0 && b < 0)) {
              const t = a / (a - b);
              o.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]);
            }
          }
          if (!closed && n && sd(poly[n - 1]) <= 0) o.push(poly[n - 1]);
          return o;
        };
        ring = clip(ring, true);
        // (Where the two sides of the road overlap across the opening, this
        // side's edge is already past the opening's middle: the other side's
        // own strip covers all of it, and there is nothing left to pave
        // here. It was a fall-back to an old-style junction box, the road's
        // lines cut at every such crossing.)
        let empty = ring.length < 3;
        if (!empty && (sd(c) >= -0.05 || sees(ring, c) <= 1e-6)) {
          const k = kernelOf(ring);
          if (!k || sd(k) >= -0.05) empty = true;
          else c = k;
        }
        if (empty) {
          if (sL - dMax - dF0 > 0) return no('opening cut past its centre');
          return { ring: [], corners: [], kerbs: [], c: junctions[j], mouth: null, inside: sLine, more: [], kerbed: false, flip: flipOf(legs[0]), sharp: false, empty: true };
        }
        corners = corners.map((q) => clip(q, false)).filter((q) => q.length >= 2);
        if (kerbLines) kerbLines = kerbLines.map((q) => clip(q, false)).filter((q) => q.length >= 2);
        more = more?.map((f) => ({ ...f, ring: clip(f.ring, true) })).filter((f) => f.ring.length >= 3 && sd(f.centre) < 0);
      }
      return { ring, corners, kerbs: kerbLines ?? corners, c, mouth: openAt >= 0 ? null : M, inside: openAt >= 0 ? sLine : null, more: (more ?? []).map((f) => ({ ...f, slip: sharp })), kerbed, flip: flipOf(legs[0]), sharp };
    };
    const teeShape = (j: number): Built | null => {
      // (Why a marked joint could not be built as a tee: kept for the checks.)
      const no = (why: string, ring?: XZ[]) => {
        out.why.push({ nodes: [j], why: 'tee: ' + why, ring });
        return null;
      };
      const parts: TeePart[] = [];
      for (const sLine of jE[j]) {
        if (thruAt(sLine, j)) continue;
        // (A side road whose bell mouth folds over itself leaves at a
        // narrower angle than its corners can round: it comes away as a slip
        // road does, one surface with the road until it is clear of it.)
        let why = '';
        let part = teePart(j, sLine, (w) => ((why = w), null));
        if (!part && why.startsWith('outline folds')) part = teePart(j, sLine, no, true);
        else if (!part) return no(why);
        if (!part) return null;
        parts.push(part);
      }
      // (Two side roads: one from each side of the road, so each has its own paving.)
      if (parts.length === 2 && parts[0].flip === parts[1].flip) return no('two side roads on one side');
      const reach = (ring: XZ[], c: XZ) => Math.max(...ring.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])));
      // (An opening with nothing to pave: its line is still the junction's own.)
      const internal = parts.flatMap((q) => (q.inside !== null ? [q.inside] : []));
      const paved = parts.filter((q) => !q.empty);
      const bare = parts.flatMap((q) => (q.empty && q.inside !== null ? [q.inside] : []));
      if (!paved.length) {
        // (A speck under the road's middle at the joint: nothing to see, but the joint is still a junction.)
        const [x, z] = junctions[j];
        const ring: XZ[] = [[x - 0.05, z - 0.05], [x + 0.05, z - 0.05], [x, z + 0.05]];
        return { nodes: [j], centre: [x, z - 0.02], radius: 0.1, ring, kerbs: [], corners: [], mouths: [], internal, bare, hull: false, tee: true, slip: false, more: [] };
      }
      const [first, ...rest] = paved;
      const more = [...first.more, ...rest.flatMap((q) => [{ ring: q.ring, centre: q.c, radius: reach(q.ring, q.c), slip: q.sharp }, ...q.more])];
      return {
        nodes: [j],
        centre: first.c,
        radius: reach(first.ring, first.c),
        ring: first.ring,
        kerbs: parts.flatMap((q) => (q.kerbed ? q.kerbs : [])),
        corners: parts.flatMap((q) => q.corners),
        mouths: parts.flatMap((q) => (q.mouth ? [q.mouth] : [])),
        internal,
        bare,
        hull: false,
        tee: true,
        slip: first.sharp,
        more,
      };
    };
    if (nodes.length === 1 && teeAt[nodes[0]]) {
      const t = teeShape(nodes[0]);
      if (t) return t;
    }
    // A median's end. Where two roads leave a junction side by side, the
    // same way (a divided road's two sides), the ground between them ends
    // in a rounded end, not square across: the paving runs a little way on
    // along both roads' edges and round a half circle as wide as the
    // median (up to 2 m round), its point a hair back from the line across.
    // (Square, its two corners turned the kerb and edge lines through two
    // sharp corners each.)
    const medianEnd = (A: Mouth, B: Mouth): { ring: XZ[]; centre: XZ; radius: number; kerbs?: XZ[][] }[] => {
      if (!I.round || A.t[0] * B.t[0] + A.t[1] * B.t[1] < 0.9) return [];
      const p0 = A.left, p2 = B.right;
      const w = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]);
      if (w < 0.9 || w > 6) return [];
      const tl = Math.hypot(A.t[0] + B.t[0], A.t[1] + B.t[1]) || 1;
      const t: XZ = [(A.t[0] + B.t[0]) / tl, (A.t[1] + B.t[1]) / tl];
      // Each corner rounded by a circle r round, touching the road's edge
      // and a line 0.1 m out beyond the line across (its "front"); as wide
      // as the median allows, the two make one half circle. (Worked out from
      // the two lines it touches, so it meets each without a turn however
      // the roads' edges or the line across lie aslant.)
      const e: XZ = [(p2[0] - p0[0]) / w, (p2[1] - p0[1]) / w];
      let n: XZ = [-e[1], e[0]];
      if (n[0] * t[0] + n[1] * t[1] < 0) n = [-n[0], -n[1]];
      const inward = (d: XZ, toward: XZ): XZ => {
        const m: XZ = [-d[1], d[0]];
        return m[0] * toward[0] + m[1] * toward[1] >= 0 ? m : [-m[0], -m[1]];
      };
      const nA = inward(A.t, e), nB = inward(B.t, [-e[0], -e[1]]);
      // C with (C - P)·m = a and (C - P)·n = b.
      const solve = (P: XZ, m: XZ, a: number, b: number): XZ | null => {
        const det = m[0] * n[1] - m[1] * n[0];
        if (Math.abs(det) < 0.2) return null;
        return [P[0] + (a * n[1] - b * m[1]) / det, P[1] + (b * m[0] - a * n[0]) / det];
      };
      const FRONT = 0.1;
      const fillet = (r: number) => {
        const CA = solve(p0, nA, r, FRONT + r), CB = solve(p2, nB, r, FRONT + r);
        if (!CA || !CB) return null;
        const ta: XZ = [CA[0] - nA[0] * r, CA[1] - nA[1] * r], fa: XZ = [CA[0] - n[0] * r, CA[1] - n[1] * r];
        const tb: XZ = [CB[0] - nB[0] * r, CB[1] - nB[1] * r], fb: XZ = [CB[0] - n[0] * r, CB[1] - n[1] * r];
        const sa = (fa[0] - p0[0]) * e[0] + (fa[1] - p0[1]) * e[1], sb = (fb[0] - p0[0]) * e[0] + (fb[1] - p0[1]) * e[1];
        return { CA, CB, ta, fa, tb, fb, ok: sa <= sb + 1e-6 };
      };
      let r = Math.min(2, w / 2);
      let f = fillet(r);
      for (let it = 0; it < 30 && f && !f.ok; it++) f = fillet((r *= 0.95));
      if (!f || !f.ok || r < 0.3) return [];
      const { CA, CB, ta, fa, tb, fb } = f;
      const dA = (ta[0] - p0[0]) * A.t[0] + (ta[1] - p0[1]) * A.t[1], dB = (tb[0] - p2[0]) * B.t[0] + (tb[1] - p2[1]) * B.t[1];
      if (dA < 0.05 || dB < 0.05 || A.s + dA > len[A.line] * 0.5 || B.s + dB > len[B.line] * 0.5) return [];
      const arcOf = (Cq: XZ, from: XZ, to: XZ): XZ[] => {
        const t0 = Math.atan2(from[1] - Cq[1], from[0] - Cq[0]);
        let sw = Math.atan2(to[1] - Cq[1], to[0] - Cq[0]) - t0;
        while (sw > Math.PI) sw -= 2 * Math.PI;
        while (sw < -Math.PI) sw += 2 * Math.PI;
        const N = Math.max(3, Math.ceil(Math.abs(sw) / (Math.PI / 12)), Math.ceil((Math.abs(sw) * r) / 0.3));
        const o: XZ[] = [];
        for (let k = 0; k <= N; k++) o.push([Cq[0] + Math.cos(t0 + (sw * k) / N) * r, Cq[1] + Math.sin(t0 + (sw * k) / N) * r]);
        return o;
      };
      // (Its straight sides a little in on each road, so they lie under the
      // road's own edge, never a hair beside it.)
      const IN = 0.05;
      const midA: XZ[] = [], midB: XZ[] = [];
      for (let d = 1; d < dA - 0.3; d += 1) midA.push([p0[0] + A.t[0] * d - nA[0] * IN, p0[1] + A.t[1] * d - nA[1] * IN]);
      for (let d = 1; d < dB - 0.3; d += 1) midB.push([p2[0] + B.t[0] * d - nB[0] * IN, p2[1] + B.t[1] * d - nB[1] * IN]);
      const q0: XZ = [p0[0] - nA[0] * IN, p0[1] - nA[1] * IN], q2: XZ = [p2[0] - nB[0] * IN, p2[1] - nB[1] * IN];
      // Paved as two halves, each from its road's edge round to the middle
      // of the front and straight back to the line across (as one, a thin
      // strip joins two scoops and no centre may see the whole).
      const Mf: XZ = [(fa[0] + fb[0]) / 2, (fa[1] + fb[1]) / 2];
      const Ml: XZ = [Mf[0] - n[0] * FRONT, Mf[1] - n[1] * FRONT];
      const near = (p: XZ, q: XZ) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.02;
      const arcA = arcOf(CA, ta, fa), arcB = arcOf(CB, fb, tb);
      const inCorner = (P: XZ, a: XZ, b: XZ): XZ => {
        const la = Math.hypot(a[0] - P[0], a[1] - P[1]) || 1, lb = Math.hypot(b[0] - P[0], b[1] - P[1]) || 1;
        return [P[0] + ((a[0] - P[0]) / la + (b[0] - P[0]) / lb) * 0.05, P[1] + ((a[1] - P[1]) / la + (b[1] - P[1]) / lb) * 0.05];
      };
      const halves: [XZ[], XZ][] = [
        [[q0, ...midA, ...arcA, ...(near(fa, Mf) ? [] : [Mf]), Ml], inCorner(q0, midA[0] ?? ta, Ml)],
        [[Ml, ...(near(fb, Mf) ? [] : [Mf]), ...arcB, ...midB.reverse(), q2], inCorner(q2, midB[0] ?? tb, Ml)],
      ];
      // (Kerbed round its end, from each road's edge to the middle of the
      // front: not along its straight sides, which lie under the roads.)
      const kerbed = hasKerb(A.line) || hasKerb(B.line);
      const kerbOf = [[...arcA, Mf], [Mf, ...arcB]];
      const parts: { ring: XZ[]; c: XZ; kerb: XZ[] }[] = [];
      for (let hi = 0; hi < 2; hi++) {
        let [h, hc] = halves[hi];
        let area = 0;
        for (let k = 0; k < h.length; k++) area += cross(h[k], h[(k + 1) % h.length]);
        if (Math.abs(area) < 1e-4) continue;
        if (area < 0) h = h.reverse();
        const kc = sees(h, hc) > 1e-6 ? hc : kernelOf(h);
        if (kc) parts.push({ ring: h, c: kc, kerb: kerbOf[hi] });
        else parts.push(...(starParts(h) ?? []).map((q) => ({ ...q, kerb: kerbOf[hi] })));
      }
      return parts.map((q) => ({ ring: q.ring, centre: q.c, radius: Math.max(...q.ring.map((p) => Math.hypot(p[0] - q.c[0], p[1] - q.c[1]))), ...(kerbed ? { kerbs: [q.kerb] } : {}) }));
    };
    const tryCentre = (c: XZ, byDir: boolean, search = false) => {
      const key = (m: Mouth) => (byDir ? Math.atan2(m.t[1], m.t[0]) : Math.atan2(m.q[1] - c[1], m.q[0] - c[0]));
      const ms = [...mouths].sort((p, q) => key(p) - key(q));
      const ring: XZ[] = [];
      const corners: XZ[][] = [];
      const kerbs: XZ[][] = [];
      const ends: { ring: XZ[]; centre: XZ; radius: number; kerbs?: XZ[][] }[] = [];
      // Two roads that leave overlapping (OSM sometimes draws a pair of
      // lanes closer than their widths) share one wide mouth.
      // So do two that leave at a narrow angle with their end lines crossing
      // (each road's end runs into the other).
      const endsCross = (A: Mouth, B: Mouth) => {
        const ea: XZ = [A.left[0] - A.right[0], A.left[1] - A.right[1]];
        const eb: XZ = [B.left[0] - B.right[0], B.left[1] - B.right[1]];
        const den = cross(ea, eb);
        if (Math.abs(den) < 1e-6) return false;
        const d: XZ = [B.right[0] - A.right[0], B.right[1] - A.right[1]];
        const u = cross(d, eb) / den;
        const v = cross(d, ea) / den;
        return u > 0 && u < 1 && v > 0 && v < 1;
      };
      const joined = ms.map((A, m) => {
        const B = ms[(m + 1) % ms.length];
        if (ms.length <= 2) return false;
        const dot = A.t[0] * B.t[0] + A.t[1] * B.t[1];
        return (dot > 0.85 && Math.hypot(A.q[0] - B.q[0], A.q[1] - B.q[1]) < A.half + B.half) || (dot > 0.7 && endsCross(A, B));
      });
      for (let m = 0; m < ms.length; m++) {
        const A = ms[m];
        const B = ms[(m + 1) % ms.length];
        if (!joined[(m + ms.length - 1) % ms.length]) ring.push(A.right);
        if (joined[m]) {
          // Follow the outer side of the two roads' own end lines (and where
          // they cross), so no sliver is left between outline and road ends.
          const ea: XZ = [A.left[0] - A.right[0], A.left[1] - A.right[1]];
          const eb: XZ = [B.left[0] - B.right[0], B.left[1] - B.right[1]];
          const cand: XZ[] = [A.left, B.right];
          const den = cross(ea, eb);
          if (Math.abs(den) > 1e-6) {
            const d: XZ = [B.right[0] - A.right[0], B.right[1] - A.right[1]];
            const u = cross(d, eb) / den;
            const v = cross(d, ea) / den;
            if (u > 0 && u < 1 && v > 0 && v < 1) cand.push([A.right[0] + ea[0] * u, A.right[1] + ea[1] * u]);
          }
          const p0 = A.right;
          const p1 = B.left;
          const ch: XZ = [p1[0] - p0[0], p1[1] - p0[1]];
          const cl = Math.hypot(ch[0], ch[1]) || 1;
          // Outward is the side away from the centre.
          const inSign = Math.sign(cross(ch, [c[0] - p0[0], c[1] - p0[1]])) || 1;
          const out = (p: XZ) => -inSign * cross(ch, [p[0] - p0[0], p[1] - p0[1]]) / cl;
          const along = (p: XZ) => ((p[0] - p0[0]) * ch[0] + (p[1] - p0[1]) * ch[1]) / cl;
          const pts = cand.filter((p) => out(p) > 0.02 && along(p) > 0 && along(p) < cl).sort((p, q) => along(p) - along(q));
          // The outer convex chain from p0 to p1 through them.
          const chain: XZ[] = [p0];
          for (const p of [...pts, p1]) {
            while (chain.length >= 2) {
              const a = chain[chain.length - 2];
              const b = chain[chain.length - 1];
              // Drop b if it lies inside the line a -> p.
              const t = -inSign * cross([p[0] - a[0], p[1] - a[1]], [b[0] - a[0], b[1] - a[1]]);
              if (t <= 0) chain.pop();
              else break;
            }
            chain.push(p);
          }
          for (let k = 1; k < chain.length - 1; k++) ring.push(chain[k]);
          continue;
        }
        ring.push(A.left);
        // Corner from A's left kerb to B's right kerb, curving through where
        // the two kerb lines would meet (or straight across if they don't).
        const p0 = A.left;
        const p2 = B.right;
        const den = cross(A.t, B.t);
        let curve: XZ[] = [p0, p2];
        // Roads leaving at a narrow angle get a straight edge between them
        // (a curve there would bite back into the junction).
        if (Math.abs(den) > 0.08 && A.t[0] * B.t[0] + A.t[1] * B.t[1] < 0.7) {
          // p0 - a*tA = p2 - b*tB
          const d: XZ = [p2[0] - p0[0], p2[1] - p0[1]];
          const a = -cross(d, B.t) / den;
          const b = -cross(d, A.t) / den;
          if (a > 0 && b > 0 && a < 60 && b < 60) {
            const c1: XZ = [p0[0] - A.t[0] * a, p0[1] - A.t[1] * a];
            const n = Math.max(2, Math.min(16, Math.ceil((a + b) / 1.5)));
            curve = [];
            for (let k = 0; k <= n; k++) {
              const u = k / n;
              const w0 = (1 - u) * (1 - u);
              const w1 = 2 * u * (1 - u);
              const w2 = u * u;
              curve.push([w0 * p0[0] + w1 * c1[0] + w2 * p2[0], w0 * p0[1] + w1 * c1[1] + w2 * p2[1]]);
            }
          }
        }
        if (curve.length === 2 && Math.abs(den) > 0.08 && A.t[0] * B.t[0] + A.t[1] * B.t[1] < 0.7) {
          // No corner to curve round (the kerb lines meet outside): run back
          // along each road's kerb toward the middle instead of across.
          // (Never so far back that the notch bites into the other road.)
          const clearOf = (p: XZ, M: Mouth) => Math.abs(cross(M.t, [p[0] - M.q[0], p[1] - M.q[1]])) >= M.half - 0.05;
          let ka = Math.min(A.s, 12) * 0.8;
          let kb = Math.min(B.s, 12) * 0.8;
          while (ka > 0 && !clearOf([p0[0] - A.t[0] * ka, p0[1] - A.t[1] * ka], B)) ka = Math.max(0, ka - 0.5);
          while (kb > 0 && !clearOf([p2[0] - B.t[0] * kb, p2[1] - B.t[1] * kb], A)) kb = Math.max(0, kb - 0.5);
          curve = [p0, [p0[0] - A.t[0] * ka, p0[1] - A.t[1] * ka], [p2[0] - B.t[0] * kb, p2[1] - B.t[1] * kb], p2];
        }
        curve = eased(A, B, curve, I.sideBySide?.(A.line, A.end, B.line, B.end));
        for (let k = 1; k < curve.length - 1; k++) ring.push(curve[k]);
        corners.push(curve);
        if (hasKerb(A.line) || hasKerb(B.line)) kerbs.push(curve);
        if (curve.length === 2) ends.push(...medianEnd(A, B));
      }
      // Star-shaped around c: every outline step turns the same way.
      // (A curved corner can fold a hair as seen from the middle of the
      // nodes and still be a clean outline: for a part of a junction that
      // has come apart, any point that sees the whole of it will do.)
      if (sees(ring, c) <= 1e-6) {
        if (!search) return null;
        c = seesBest(ring, c);
        if (sees(ring, c) <= 1e-6) return null;
      }
      if (spills(ring)) return null;
      return { ms, ring, corners, kerbs, c, ends };
    };
    const c1 = mean(nodes.map((j) => junctions[j]));
    const c2 = mean(mouths.map((m) => m.q));
    let centre = c1;
    let isHull = false;
    let got: ReturnType<typeof tryCentre> = null;
    for (const [c, byDir, search] of [[c1, false], [c1, true], [c2, false], [c2, true], [c1, false, true], [c2, false, true]] as [XZ, boolean, boolean?][]) {
      if (search && !seek) break;
      got = tryCentre(c, byDir, search);
      if (got) {
        centre = got.c;
        break;
      }
    }
    if (!got) {
      // Roads that part at a narrow angle and curve away (slip roads) can
      // leave no clean outline: pave the hull of their mouths instead. Its
      // sides from one road's mouth to another's are the roads' sides and
      // carry their kerb, as a shaped junction's corners do (the kerb is
      // cut to fit where the side runs on into a road or a wedge); only
      // the sides across a mouth are open.
      const pts: XZ[] = mouths.flatMap((m) => [m.right, m.left]);
      const hull = convexHull(pts);
      const hullEnds: { ring: XZ[]; centre: XZ; radius: number; kerbs?: XZ[][] }[] = [];
      if (hull.length < 3) return 'star';
      const ring: XZ[] = [];
      const corners: XZ[][] = [];
      const kerbs: XZ[][] = [];
      const ownerOf = (p: XZ) => mouths.find((m) => Math.hypot(m.left[0] - p[0], m.left[1] - p[1]) < 1e-6 || Math.hypot(m.right[0] - p[0], m.right[1] - p[1]) < 1e-6);
      for (let k = 0; k < hull.length; k++) {
        const a = hull[k];
        const b = hull[(k + 1) % hull.length];
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
        let edge: XZ[] = [a];
        for (let q = 1; q < n; q++) edge.push([a[0] + ((b[0] - a[0]) * q) / n, a[1] + ((b[1] - a[1]) * q) / n]);
        edge.push(b);
        // (An edge from one mouth's corner straight to a facing mouth's is a through road's side.)
        const same = (p: XZ, q: XZ) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6;
        const A = mouths.find((m) => same(m.left, a));
        const B = mouths.find((m) => same(m.right, b));
        if (A && B && A !== B) edge = eased(A, B, edge, I.sideBySide?.(A.line, A.end, B.line, B.end));
        if (A && B && A !== B && edge.length === 2) hullEnds.push(...medianEnd(A, B));
        ring.push(...edge.slice(0, -1));
        corners.push(edge);
        const Ma = ownerOf(a);
        const Mb = ownerOf(b);
        if (Ma && Mb && Ma !== Mb && (hasKerb(Ma.line) || hasKerb(Mb.line))) kerbs.push(edge);
      }
      if (spills(ring)) return 'spill';
      centre = mean(hull);
      // (Eased sides curve inward: where the outline then folds as seen from
      // the middle of the hull, the paving is filled from the point that
      // sees it best instead.)
      if (sees(ring, centre) <= 1e-6) centre = seesBest(ring, centre);
      got = { ms: mouths, ring, corners, kerbs, c: centre, ends: hullEnds };
      isHull = true;
    }
    const radius = Math.max(...got.ring.map((p) => Math.hypot(p[0] - centre[0], p[1] - centre[1])));
    return { nodes, centre, radius, ring: got.ring, kerbs: got.kerbs, corners: got.corners, mouths: got.ms, internal, hull: isHull, ...(got.ends.length ? { more: got.ends } : {}) };
  };

  // Shape every group; where two shapes still overlap (two junctions on a
  // short road, each wanting room), they become one junction.
  // A big crossing that can't be shaped whole falls back to its parts.
  // A junction that paves ground its roads only enclose comes apart at the
  // longest road inside it, as often as it takes: smaller junctions with a
  // real road (its kerbs, the ground beside it) between them. Only where
  // that leaves a clean result, though: the road between must be long
  // enough to be one, every part must take a shape of its own, and no two
  // of them may overlap. (A slip road's joint may: it needs no shape, its
  // roads lie over each other as at any slip.) A junction that can't come
  // apart cleanly keeps the shape its outline's corners allowed.
  const MIN_CUT = 28;
  const apart = (nodes: number[], stub: Uint8Array): number[][] => {
    if (nodes.length < 2 || typeof shapeGroup(nodes, stub) !== 'string') return [nodes];
    const inG = new Set(nodes);
    const inner = [...new Set(nodes.flatMap((j) => jE[j]))]
      .filter((i) => (stub[i] || len[i] < 80) && edges[i].a !== edges[i].b && inG.has(edges[i].a) && inG.has(edges[i].b))
      .sort((p, q) => len[q] - len[p]);
    for (let cut = 1; cut <= inner.length && len[inner[cut - 1]] >= MIN_CUT; cut++) {
      const par = new Map<number, number>(nodes.map((j) => [j, j]));
      const f = (j: number): number => {
        const p = par.get(j)!;
        if (p === j) return j;
        const r = f(p);
        par.set(j, r);
        return r;
      };
      for (const i of inner.slice(cut)) par.set(f(edges[i].a), f(edges[i].b));
      const comps = new Map<number, number[]>();
      for (const j of nodes) (comps.get(f(j)) ?? comps.set(f(j), []).get(f(j))!).push(j);
      if (comps.size > 1) return [...comps.values()].flatMap((c) => apart(c, base.stub));
    }
    return [nodes];
  };
  // (Slip joints left plain.)
  const loose = new Set<number>();
  const curved = new Map<string, Built>();
  /** A group's shape with curved corners, where today it has only the hull of its road ends. */
  const curvedOf = (nodes: number[], stub: Uint8Array): Built | null => {
    const b = shapeGroup(nodes, stub);
    if (typeof b === 'string' || !b.hull) return null;
    seek = true;
    const c = shapeGroupRaw(nodes, stub);
    seek = false;
    return typeof c === 'string' || c.hull ? null : c;
  };
  /** The parts a group comes apart into, or null where that is not clean. */
  const cleanParts = (nodes: number[], stub: Uint8Array): number[][] | null => {
    if (typeof shapeGroup(nodes, stub) !== 'string') return [nodes];
    const parts = apart(nodes, stub);
    if (parts.length < 2) return null;
    const slip = (p: number[]) => p.length === 1 && !!I.slip?.(p[0]);
    // (A part gets its curved corners where it can: without them it would
    // be the straight-sided hull of its road ends.)
    const B = parts.map((p) => {
      const b = shapeGroup(p, base.stub);
      const c = curvedOf(p, base.stub);
      if (!c) return b;
      curved.set(keyOf(p, base.stub), c);
      return c;
    });
    const plain = new Set<number>();
    for (let a = 0; a < parts.length; a++)
      if (typeof B[a] === 'string') {
        if (!slip(parts[a])) return null;
        plain.add(a);
      }
    for (let a = 0; a < parts.length; a++)
      for (let b = a + 1; b < parts.length; b++) {
        if (plain.has(a) || plain.has(b)) continue;
        const A = B[a] as Built;
        const C = B[b] as Built;
        if (!overlaps(A.ring, C.ring) && !overlaps(C.ring, A.ring)) continue;
        if (slip(parts[a])) plain.add(a);
        else if (slip(parts[b])) plain.add(b);
        else return null;
      }
    for (const a of plain) loose.add(parts[a][0]);
    return parts;
  };
  /** Is every road left between two of the parts long enough to be one? */
  const fits = (parts: number[][]) => {
    const of = new Map<number, number>();
    parts.forEach((q, k) => q.forEach((n) => of.set(n, k)));
    for (const q of parts)
      for (const n of q)
        for (const i of jE[n]) {
          const a = of.get(edges[i].a);
          const b = of.get(edges[i].b);
          if (a !== undefined && b !== undefined && a !== b && len[i] < MIN_CUT) return false;
        }
    return true;
  };
  let list: number[][] = [];
  for (const nodes of wide.groups.values()) {
    const parts = new Map<number, number[]>();
    for (const j of nodes) (parts.get(base.find(j)) ?? parts.set(base.find(j), []).get(base.find(j))!).push(j);
    if (typeof shapeGroup(nodes, wide.stub) !== 'string') {
      list.push(nodes);
      continue;
    }
    // A big crossing first falls back to its parts (its medians and slip
    // islands come back), each of which may come apart in turn.
    let got: number[][] | null;
    if (parts.size === 1) got = cleanParts(nodes, wide.stub);
    else {
      const each = [...parts.values()].map((q) => cleanParts(q, base.stub));
      got = each.every((q) => q) ? (each as number[][][]).flat() : null;
    }
    if (got && got.length > 1 && !fits(got)) {
      for (const q of got) if (q.length === 1) loose.delete(q[0]);
      got = null;
    }
    if (got) {
      for (const q of got) {
        const c = got.length > 1 ? curved.get(keyOf(q, base.stub)) : undefined;
        if (c) asWas.set(keyOf(q, base.stub), c);
      }
      list.push(...got);
      continue;
    }
    // Not cleanly: it keeps the shape its corners allowed...
    const was = cornersOnly(nodes, wide.stub);
    if (typeof was !== 'string') {
      asWas.set(keyOf(nodes, wide.stub), was);
      list.push(nodes);
      continue;
    }
    // ...or, where they allowed it none, its parts keep theirs.
    if (parts.size === 1) {
      list.push(nodes);
      continue;
    }
    for (const q of parts.values()) {
      const w = typeof shapeGroup(q, base.stub) === 'string' ? cornersOnly(q, base.stub) : null;
      if (w && typeof w !== 'string') asWas.set(keyOf(q, base.stub), w);
      list.push(q);
    }
  }
  const stubOf = (nodes: number[]) => (wide.groups.has(wide.find(nodes[0])) && wide.groups.get(wide.find(nodes[0]))!.length === nodes.length ? wide.stub : base.stub);
  let built: (Built | string)[] = [];
  for (let pass = 0; ; pass++) {
    built = list.map((nodes) => (nodes.length === 1 && loose.has(nodes[0]) ? 'slip' : shapeGroup(nodes, stubOf(nodes))));
    if (pass === 3) break;
    const ok = built.map((b, g) => (typeof b === 'string' ? -1 : g)).filter((g) => g >= 0);
    const grid = new Map<number, number[]>();
    const key = (x: number, z: number) => Math.floor(x / 100) * 100003 + Math.floor(z / 100);
    for (const g of ok) {
      const b = built[g] as Built;
      const k = key(b.centre[0], b.centre[1]);
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(g);
    }
    const par = list.map((_, i) => i);
    const f = (i: number): number => (par[i] === i ? i : (par[i] = f(par[i])));
    let merged = false;
    for (const g of ok) {
      const A = built[g] as Built;
      const i0 = Math.floor(A.centre[0] / 100);
      const j0 = Math.floor(A.centre[1] / 100);
      for (let di = -1; di <= 1; di++)
        for (let dj = -1; dj <= 1; dj++)
          for (const h of grid.get((i0 + di) * 100003 + j0 + dj) ?? []) {
            if (h <= g || f(h) === f(g)) continue;
            const B = built[h] as Built;
            if (Math.hypot(A.centre[0] - B.centre[0], A.centre[1] - B.centre[1]) > A.radius + B.radius) continue;
            if (!overlaps(A.ring, B.ring) && !overlaps(B.ring, A.ring)) continue;
            par[f(h)] = f(g);
            merged = true;
          }
    }
    if (!merged) break;
    const sets = new Map<number, number[]>();
    list.forEach((_, i) => {
      const r = f(i);
      (sets.get(r) ?? sets.set(r, []).get(r)!).push(i);
    });
    const next: number[][] = [];
    for (const l of sets.values()) {
      const all = l.flatMap((i) => list[i]);
      const st = stubOf(all);
      if (l.length === 1 || typeof shapeGroup(all, st) !== 'string') {
        next.push(all);
        continue;
      }
      // Two that would become one, but as one would pave ground between
      // their roads: a slip road's joint among them is left plain instead
      // (the rest are asked again without it)...
      const slips = l.filter((i) => list[i].length === 1 && I.slip?.(list[i][0]));
      if (slips.length) {
        for (const i of slips) loose.add(list[i][0]);
        for (const i of l) {
          next.push(list[i]);
          // (What stays a junction of its own gets its curved corners.)
          const c = slips.includes(i) ? null : curvedOf(list[i], stubOf(list[i]));
          if (c) asWas.set(keyOf(list[i], stubOf(list[i])), c);
        }
        continue;
      }
      // ...or else they keep the shape their corners allowed.
      const w = cornersOnly(all, st);
      if (typeof w !== 'string') asWas.set(keyOf(all, st), w);
      next.push(all);
    }
    list = next;
  }
  built.forEach((b, g) => {
    const nodes = list[g];
    if (typeof b === 'string') {
      out.fallback.push(...nodes);
      out.why.push({ nodes, why: b });
      return;
    }
    const id = out.shapes.length;
    if (b.hull) out.hulls++;
    for (const f of b.more ?? []) out.fills.push({ ...f, tee: nodes[0] });
    out.shapes.push({
      id,
      nodes,
      centre: b.centre,
      ring: b.ring,
      kerbs: b.kerbs,
      corners: b.corners,
      mouths: b.mouths,
      internal: b.internal,
      radius: b.radius,
      slip: b.slip,
    });
    for (const j of nodes) out.shapeOf[j] = id;
    if (b.tee) for (const j of nodes) out.tee[j] = 1;
    for (const i of b.internal) out.internal[i] = 1;
    for (const i of b.bare ?? []) out.bare[i] = 1;
    for (const m of b.mouths) (m.end === 0 ? out.trimA : out.trimB)[m.line] = m.s;
  });
  // ---- Islands in big crossings ----
  // The roads of a big crossing (main roads, slip lanes) enclose small
  // islands. Walk the faces of that little road graph and pave the small ones.
  const MAX_ISLAND = 2500;
  // (Slip lanes join the main roads further out than a junction reaches.)
  const isles = mergeBy(true, 70, 180, jE.map((l) => l.length >= 3), true);
  for (const nodes of isles.groups.values()) {
    if (nodes.length < 2 || !nodes.some((j) => major[j])) continue;
    const inG = new Set(nodes);
    // Half-edges run from point to point of the group, through any plain
    // bends (a slip lane is often several OSM pieces).
    type H = { pts: XZ[]; from: number; to: number; ang: number; key: string; twin: string };
    const out_: Map<number, H[]> = new Map();
    const hs: H[] = [];
    const seen = new Set<string>();
    for (const u of nodes)
      for (const e0 of jE[u]) {
        const pts: XZ[] = [];
        const ids: number[] = [];
        let cur = u;
        let e = e0;
        let total = 0;
        for (let step = 0; step < 8; step++) {
          const fwd = edges[e].a === cur;
          const P = fwd ? EP[e] : [...EP[e]].reverse();
          pts.push(...(pts.length ? P.slice(1) : P));
          ids.push(e);
          total += len[e];
          cur = fwd ? edges[e].b : edges[e].a;
          if (inG.has(cur) || jE[cur].length !== 2 || total > 200) break;
          e = jE[cur][0] === e ? jE[cur][1] : jE[cur][0];
        }
        if (!inG.has(cur) || total > 200 || pts.length < 2) continue;
        const key = `${u}:${ids.join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const h: H = { pts, from: u, to: cur, ang: Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]), key, twin: `${cur}:${[...ids].reverse().join(',')}` };
        hs.push(h);
        (out_.get(u) ?? out_.set(u, []).get(u)!).push(h);
      }
    for (const l of out_.values()) l.sort((a, b) => a.ang - b.ang);
    const used = new Set<H>();
    for (const h0 of hs) {
      if (used.has(h0)) continue;
      const face: H[] = [];
      let h = h0;
      let ok = true;
      while (!used.has(h)) {
        used.add(h);
        face.push(h);
        // Arriving at h.to: leave by the next half-edge clockwise from the way back.
        const l = out_.get(h.to)!;
        const back = l.find((x) => x.key === h.twin);
        if (!back) {
          ok = false;
          break;
        }
        const bi = l.indexOf(back);
        h = l[(bi - 1 + l.length) % l.length];
        if (face.length > 12) {
          ok = false;
          break;
        }
      }
      if (!ok || h !== h0 || face.length < 2) continue;
      const ring: XZ[] = [];
      for (const f of face) for (let k = 0; k < f.pts.length - 1; k++) ring.push(f.pts[k]);
      let area = 0;
      for (let k = 0; k < ring.length; k++) area += cross(ring[k], ring[(k + 1) % ring.length]);
      area /= 2;
      if (area <= 20 || area > MAX_ISLAND) continue;
      // Fill from a point that sees the whole outline.
      let cx = 0;
      let cz = 0;
      for (let k = 0; k < ring.length; k++) {
        const p = ring[k];
        const q = ring[(k + 1) % ring.length];
        const w = cross(p, q);
        cx += (p[0] + q[0]) * w;
        cz += (p[1] + q[1]) * w;
      }
      const tries: XZ[] = [
        [cx / (6 * area), cz / (6 * area)],
        [ring.reduce((a, p) => a + p[0], 0) / ring.length, ring.reduce((a, p) => a + p[1], 0) / ring.length],
      ];
      // ...or from points part way in from each corner.
      for (const p of ring.filter((_, k) => k % 3 === 0)) tries.push([(p[0] + tries[0][0]) / 2, (p[1] + tries[0][1]) / 2]);
      const c = tries.find((c) => ring.every((p, k) => {
        const q = ring[(k + 1) % ring.length];
        return cross([p[0] - c[0], p[1] - c[1]], [q[0] - c[0], q[1] - c[1]]) > 1e-6;
      }));
      if (!c) {
        out.why.push({ nodes: [], why: 'island' });
        continue;
      }
      out.fills.push({ ring, centre: c, radius: Math.max(...ring.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1]))) });
    }
  }
  return out;
}

interface Built {
  nodes: number[];
  centre: XZ;
  radius: number;
  ring: XZ[];
  kerbs: XZ[][];
  corners: XZ[][];
  mouths: Mouth[];
  internal: number[];
  hull: boolean;
  tee?: boolean;
  /** Openings at this joint with nothing to pave (see JX.bare). */
  bare?: number[];
  /** More paving that belongs to this junction, each part filled from its own centre. */
  more?: { ring: XZ[]; centre: XZ; radius: number; slip?: boolean; kerbs?: XZ[][] }[];
  slip?: boolean;
}

/** Does any point of ring a lie inside ring b, more than 0.3 m in? */
function overlaps(a: XZ[], b: XZ[]) {
  next: for (const [x, z] of a) {
    if (!inRingXZ(b, x, z)) continue;
    for (let i = 0, j = b.length - 1; i < b.length; j = i++) {
      const [ax, az] = b[j];
      const abx = b[i][0] - ax;
      const abz = b[i][1] - az;
      let u = ((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz || 1);
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      if (Math.hypot(ax + abx * u - x, az + abz * u - z) < 0.3) continue next;
    }
    return true;
  }
  return false;
}

/** Convex hull, counter-clockwise in the same sense as the outlines (cross > 0). Keeps the input points. */
export function convexHull(P: XZ[]): XZ[] {
  const p = [...P].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const turn = (o: XZ, a: XZ, b: XZ) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: XZ[] = [];
  for (const q of p) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: XZ[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Is (x, z) inside a counter-clockwise ring? */
export function inRingXZ(ring: XZ[], x: number, z: number) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
