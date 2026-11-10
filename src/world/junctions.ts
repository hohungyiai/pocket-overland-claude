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
  /** Can this road be cut back and joined to a shaped junction? (ground roads) */
  shapeable: (i: number) => boolean;
  /** Joints left unshaped whatever meets there (a slip road splitting off or merging: the roads just overlap). */
  plain?: (j: number) => boolean;
  /** Do these two road ends (line, end) meet as a road and one of its branches at a split? (Its edge then curves from one to the other, whatever the angle.) */
  sideBySide?: (lineA: number, endA: number, lineB: number, endB: number) => boolean;
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
}

export interface JunctionOut {
  shapes: JunctionShape[];
  /** Junction shape id for each OSM junction point, or -1. */
  shapeOf: Int32Array;
  /** Setback (m) at each road's first and last point (0 = drawn to the point). */
  trimA: Float32Array;
  trimB: Float32Array;
  internal: Uint8Array;
  /** Junctions that could not be shaped cleanly and keep a plain pad. */
  fallback: number[];
  /** Islands inside big crossings (between slip lanes and the main roads), paved over. */
  fills: { ring: XZ[]; centre: XZ; radius: number }[];
  /** Junctions paved as the hull of their mouths. */
  hulls: number;
  /** Why each fallback group was not shaped (for checks). */
  why: { nodes: number[]; why: string }[];
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
    fallback: [],
    fills: [],
    hulls: 0,
    why: [],
  };

  const memo = new Map<string, Built | string>();
  const shapeGroup = (nodes: number[], stub: Uint8Array): Built | string => {
    const key = `${stub === wide.stub ? 'w' : 'b'}${[...nodes].sort((p, q) => p - q).join(',')}`;
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
    const spills = (ring: XZ[]) =>
      ring.some(([x, z]) => {
        let best = Infinity;
        each(x, z, 30, (_o, _k, d, sg) => {
          best = Math.min(best, d - sg.h);
        });
        return best > SPILL;
      });
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
    const tryCentre = (c: XZ, byDir: boolean) => {
      const key = (m: Mouth) => (byDir ? Math.atan2(m.t[1], m.t[0]) : Math.atan2(m.q[1] - c[1], m.q[0] - c[0]));
      const ms = [...mouths].sort((p, q) => key(p) - key(q));
      const ring: XZ[] = [];
      const corners: XZ[][] = [];
      const kerbs: XZ[][] = [];
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
        if (Math.max(I.rank(A.line), I.rank(B.line)) >= 1) kerbs.push(curve);
      }
      // Star-shaped around c: every outline step turns the same way.
      for (let k = 0; k < ring.length; k++) {
        const p = ring[k];
        const q = ring[(k + 1) % ring.length];
        if (cross([p[0] - c[0], p[1] - c[1]], [q[0] - c[0], q[1] - c[1]]) <= 1e-6) {
          return null;
        }
      }
      if (spills(ring)) return null;
      return { ms, ring, corners, kerbs };
    };
    const c1 = mean(nodes.map((j) => junctions[j]));
    const c2 = mean(mouths.map((m) => m.q));
    let centre = c1;
    let isHull = false;
    let got: ReturnType<typeof tryCentre> = null;
    for (const [c, byDir] of [[c1, false], [c1, true], [c2, false], [c2, true]] as [XZ, boolean][]) {
      got = tryCentre(c, byDir);
      if (got) {
        centre = c;
        break;
      }
    }
    if (!got) {
      // Roads that part at a narrow angle and curve away (slip roads) can
      // leave no clean outline: pave the hull of their mouths instead,
      // without kerbs.
      const pts: XZ[] = mouths.flatMap((m) => [m.right, m.left]);
      const hull = convexHull(pts);
      if (hull.length < 3) return 'star';
      const ring: XZ[] = [];
      const corners: XZ[][] = [];
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
        ring.push(...edge.slice(0, -1));
        corners.push(edge);
      }
      if (spills(ring)) return 'spill';
      centre = mean(hull);
      // (Eased sides curve inward: where the outline then folds as seen from
      // the middle of the hull, the paving is filled from the point that
      // sees it best instead.)
      const sees = (c: XZ) => {
        let least = Infinity;
        for (let k = 0; k < ring.length; k++) {
          const p = ring[k];
          const q = ring[(k + 1) % ring.length];
          least = Math.min(least, cross([p[0] - c[0], p[1] - c[1]], [q[0] - c[0], q[1] - c[1]]));
        }
        return least;
      };
      let best = sees(centre);
      if (best <= 1e-6) {
        const x0 = Math.min(...ring.map((p) => p[0])), x1 = Math.max(...ring.map((p) => p[0]));
        const z0 = Math.min(...ring.map((p) => p[1])), z1 = Math.max(...ring.map((p) => p[1]));
        const step = Math.max(0.5, Math.max(x1 - x0, z1 - z0) / 40);
        for (let z = z0; z <= z1; z += step)
          for (let x = x0; x <= x1; x += step) {
            const v = sees([x, z]);
            if (v > best) {
              best = v;
              centre = [x, z];
            }
          }
      }
      got = { ms: mouths, ring, corners, kerbs: [] };
      isHull = true;
    }
    const radius = Math.max(...got.ring.map((p) => Math.hypot(p[0] - centre[0], p[1] - centre[1])));
    return { nodes, centre, radius, ring: got.ring, kerbs: got.kerbs, corners: got.corners, mouths: got.ms, internal, hull: isHull };
  };

  // Shape every group; where two shapes still overlap (two junctions on a
  // short road, each wanting room), they become one junction.
  // A big crossing that can't be shaped whole falls back to its parts.
  let list: number[][] = [];
  for (const nodes of wide.groups.values()) {
    const parts = new Map<number, number[]>();
    for (const j of nodes) (parts.get(base.find(j)) ?? parts.set(base.find(j), []).get(base.find(j))!).push(j);
    if (parts.size === 1 || typeof shapeGroup(nodes, wide.stub) !== 'string') list.push(nodes);
    else list.push(...parts.values());
  }
  const stubOf = (nodes: number[]) => (wide.groups.has(wide.find(nodes[0])) && wide.groups.get(wide.find(nodes[0]))!.length === nodes.length ? wide.stub : base.stub);
  let built: (Built | string)[] = [];
  for (let pass = 0; ; pass++) {
    built = list.map((nodes) => shapeGroup(nodes, stubOf(nodes)));
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
    const next = new Map<number, number[]>();
    list.forEach((nodes, i) => {
      const r = f(i);
      (next.get(r) ?? next.set(r, []).get(r)!).push(...nodes);
    });
    list = [...next.values()];
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
    });
    for (const j of nodes) out.shapeOf[j] = id;
    for (const i of b.internal) out.internal[i] = 1;
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
function convexHull(P: XZ[]): XZ[] {
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
