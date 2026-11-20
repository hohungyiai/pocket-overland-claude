import { clamp, smoothstep } from '../../noise';
import { Polyline } from '../../world/polyline';
import { inRing } from '../../world/segindex';
import type { Surface, XZ } from '../types';
import type { UbinMap } from './ground';

// Pulau Ubin's trails (the trail definitions are in trails.ts). Each is a
// route found on the real OpenStreetMap lanes, tracks and paths between a
// few waypoints, with obstacles along it that each teach a skill. Nothing
// ever fails: the worst that happens is a few minutes.
//
// The easy trail (Ketam) has a signposted way round each obstacle that
// opens after three honest tries. Harder trails have no sign: a longer
// detour exists, on an old track, for whoever finds it.

export type ObstacleKind = 'climb' | 'washout' | 'sand' | 'rocks' | 'descent' | 'summit' | 'mud' | 'ford' | 'camber';

/** What an obstacle needs to get through (for the hints and the checks). */
export interface Needs {
  low?: boolean;
  diff?: boolean;
  /** Carry speed into it. */
  speed?: boolean;
}

export interface ObstacleDef {
  kind: ObstacleKind;
  label: string;
  /** A point on the route where it starts. */
  at: XZ;
  len: number;
  needs: Needs;
  /** Shape numbers for this kind (see shape()). */
  p?: Record<string, number>;
}

export interface TrailDef {
  id: string;
  name: string;
  grade: 'easy' | 'medium' | 'hard';
  waypoints: XZ[];
  /** Paths may carry the route (not just lanes and tracks). */
  paths?: boolean;
  obstacles: ObstacleDef[];
  /** 'gate': a signposted way round each obstacle, opened after three tries. 'hidden': one unmarked detour, always open. */
  wayRound: 'gate' | 'hidden';
  /** The hidden detour's waypoints (found on the map's tracks and paths), and the obstacles it skips. */
  detour?: { waypoints: XZ[]; skips: number[] };
  /** Extra height along the route: [a point on the route, metres]. Smoothly between them, fading out beside the route. */
  profile?: [XZ, number][];
  end: { label: string; sign: string[]; camp?: { id: string; label: string } };
  startSign: string[];
  /** Said at the end: after a clean run, and otherwise. */
  clean: string;
  finish: string;
}
export interface Obstacle {
  kind: ObstacleKind;
  label: string;
  needs: Needs;
  p: Record<string, number>;
  /** Where on the route it starts and ends (metres). */
  s0: number;
  s1: number;
  /** The obstacle's own stretch of route, for nearest-point queries. */
  line: Polyline;
  /** The easier way round, and the side it leaves on (+1 left). */
  bypass: Polyline;
  side: number;
  /** Where the barrier closing the way round stands (signposted ways round only). */
  gate: { x: number; z: number; yaw: number } | null;
  tries: number;
  open: boolean;
  /** How it was passed: on the hard line, or round. */
  done: 'hard' | 'round' | null;
  // Per attempt.
  inside: boolean;
  counted: boolean;
  furthest: number;
  /** Seconds without headway on this try. */
  idle: number;
  /** Seconds the tip stays up after a failed try. */
  tipFor: number;
}

// The obstacles' numbers. (A test page can override them before the
// course is built: window.__ubinTune = { climbH: 8, ... }.)
const TUNE = {
  climbH: 8, // metres up
  climbUp: 18, // over this run
  looseGrip: 0.8,
  looseDrag: 1.6,
  humpH: 0.9,
  humpLen: 2.2,
  washDepth: 4,
  washOut: 0.5,
  sandGrip: 0.1,
  sandDrag: 9,
  sandDip: 0.22,
  duneH: 3.5,
  duneFace: 12,
  sandSink: 0.02,
  ...((globalThis as { __ubinTune?: object }).__ubinTune ?? {}),
};
const SOFT_SAND: Surface = { name: 'Soft sand', grip: TUNE.sandGrip, drag: TUNE.sandDrag, offroad: true, sink: TUNE.sandSink };
const LOOSE: Surface = { name: 'Loose gravel', grip: TUNE.looseGrip, drag: TUNE.looseDrag, offroad: true };
const RUTS: Surface = { name: 'Washout', grip: 0.78, drag: 1.5, offroad: true };
// The harder trails' ground.
const ROCKS: Surface = { name: 'Roots and rock', grip: 0.62, drag: 1.5, offroad: true };
const SCREE: Surface = { name: 'Loose rock', grip: 0.5, drag: 1.2, offroad: true };
const DEEP_MUD: Surface = { name: 'Deep mud', grip: 0.32, drag: 3, offroad: true, sink: 0.16 };
const TIDAL: Surface = { name: 'Tidal sand', grip: 0.3, drag: 4, offroad: true, sink: 0.2 };
const FORD: Surface = { name: 'Ford', grip: 0.72, drag: 3, offroad: true, sink: 0.12 };
const LEDGES: Surface = { name: 'Rock ledges', grip: 0.78, drag: 1.2, offroad: true };
const CAMBER: Surface = { name: 'Off-camber shore', grip: 0.55, drag: 1.8, offroad: true };
const KIND_SURFACE: Record<ObstacleKind, Surface> = {
  climb: LOOSE,
  washout: RUTS,
  sand: SOFT_SAND,
  rocks: ROCKS,
  descent: SCREE,
  summit: LEDGES,
  mud: DEEP_MUD,
  ford: FORD,
  camber: CAMBER,
};

const NICE: Record<ObstacleKind, string> = {
  climb: 'Up and over. Nicely done.',
  washout: 'Through the washout. Nicely done.',
  sand: 'Through the sand, and the view over the strait is yours.',
  rocks: 'Through the roots and rock. Nicely done.',
  descent: 'Down in one piece, nice and slow.',
  summit: 'On top of Puaka Hill. Take in the view.',
  mud: 'Through the mud. That took some doing.',
  ford: 'Across the ford and up the bank.',
  camber: 'Along the shore without sliding off. Good line.',
};
const TIP_WHY: Record<ObstacleKind, string> = {
  climb: 'Steep and loose',
  washout: 'A wheel is in the air',
  sand: 'Soft sand',
  rocks: 'A wheel is light on the rocks and spinning',
  descent: 'Steep and loose going down',
  summit: 'Rock ledges, steep',
  mud: 'Deep mud, and a wheel spinning in a hole',
  ford: 'Soft bed and a slick bank out',
  camber: 'The track leans to the sea',
};
const TIP_HOW: Record<ObstacleKind, string> = {
  climb: 'Back down a little and take it slow and steady.',
  washout: 'Keep the wheels turning slowly; let the car rock across.',
  sand: 'Back up and take a run at it, and keep your speed up.',
  rocks: 'Slow and steady: let each wheel climb its rock in turn.',
  descent: 'Off the pedals in low range and let it crawl down.',
  summit: 'Slow and steady at each ledge; do not bounce up them.',
  mud: 'Keep moving: a steady pace, and do not stop in the holes.',
  ford: 'A steady walking pace in, and keep the wheels turning up the bank.',
  camber: 'Keep to the high side of the track, and go slow.',
};

/** Find the route on the lanes and tracks (paths only if nothing else joins). */
function findRoute(map: UbinMap, waypoints: XZ[], paths = false): XZ[] {
  const pos = new Map<number, XZ>();
  const adj = new Map<number, { to: number; w: number }[]>();
  const cost = { lane: 1, track: 1, path: paths ? 1.3 : 1000 };
  for (const r of map.roads) {
    if (r.nodes.length !== r.pts.length) continue;
    for (let i = 0; i + 1 < r.nodes.length; i++) {
      const a = r.nodes[i];
      const b = r.nodes[i + 1];
      pos.set(a, r.pts[i]);
      pos.set(b, r.pts[i + 1]);
      const w = Math.hypot(r.pts[i + 1][0] - r.pts[i][0], r.pts[i + 1][1] - r.pts[i][1]) * cost[r.kind];
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a)!.push({ to: b, w });
      adj.get(b)!.push({ to: a, w });
    }
  }
  const nearestNode = ([x, z]: XZ) => {
    let best = Infinity;
    let id = -1;
    for (const r of map.roads) {
      if (r.kind === 'path' && !paths) continue;
      r.nodes.forEach((n, i) => {
        const d = Math.hypot(r.pts[i][0] - x, r.pts[i][1] - z);
        if (d < best) {
          best = d;
          id = n;
        }
      });
    }
    return id;
  };
  const used = new Set<string>();
  const ek = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const path = (a: number, b: number) => {
    // Dijkstra with a binary heap. (A stretch already driven costs a lot
    // more, so the loop round the quarry is taken, not the same way back.)
    const dist = new Map<number, number>([[a, 0]]);
    const prev = new Map<number, number>();
    const heap: [number, number][] = [[0, a]];
    const push = (e: [number, number]) => {
      heap.push(e);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    while (heap.length) {
      const [d, u] = pop();
      if (u === b) break;
      if (d > (dist.get(u) ?? Infinity)) continue;
      for (const { to, w } of adj.get(u) ?? []) {
        const nd = d + (used.has(ek(u, to)) ? w * 1000 : w);
        if (nd < (dist.get(to) ?? Infinity)) {
          dist.set(to, nd);
          prev.set(to, u);
          push([nd, to]);
        }
      }
    }
    const out = [b];
    while (out[out.length - 1] !== a) {
      const p = prev.get(out[out.length - 1]);
      if (p === undefined) throw new Error('Ubin trail: no way between waypoints');
      out.push(p);
    }
    out.reverse();
    for (let i = 0; i + 1 < out.length; i++) used.add(ek(out[i], out[i + 1]));
    return out;
  };
  const nodes = waypoints.map(nearestNode);
  const all = [nodes[0]];
  for (let i = 0; i + 1 < nodes.length; i++) all.push(...path(nodes[i], nodes[i + 1]).slice(1));
  // Drop repeated points (ways that share a node twice in a row).
  const pts: XZ[] = [];
  for (const n of all) {
    const p = pos.get(n)!;
    const q = pts[pts.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.5) pts.push(p);
  }
  return pts;
}

/** Cut a stretch [s0, s1] out of a polyline, resampled every metre. */
function stretch(line: Polyline, s0: number, s1: number): Polyline {
  const pts: XZ[] = [];
  for (let s = s0; s <= s1; s += 1) {
    const p = line.at(s);
    pts.push([p.x, p.z]);
  }
  return new Polyline(pts);
}

export class UbinTrail {
  readonly route: Polyline;
  readonly obstacles: Obstacle[] = [];
  /** Where the off-road part starts and the camp is. */
  readonly camp: { x: number; z: number };

  /** The hidden detour (harder trails), if there is one. */
  readonly detour: Polyline | null = null;
  /** Extra height along the route: (s, metres), in order. */
  private readonly lift: [number, number][] = [];

  constructor(
    readonly map: UbinMap,
    readonly def: TrailDef,
  ) {
    this.route = new Polyline(findRoute(map, def.waypoints, def.paths));
    const R = this.route;
    const L = R.length;
    const onRoute = (x: number, z: number, from: number, to: number) => {
      // Nearest point on a part of the route (it can pass a place twice).
      let best = Infinity;
      let bs = from;
      for (let s = from; s <= to; s += 1) {
        const p = R.at(s);
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < best) {
          best = d;
          bs = s;
        }
      }
      return bs;
    };
    if (def.wayRound === 'hidden' && def.detour) this.detour = new Polyline(findRoute(map, def.detour.waypoints, true));
    // Obstacles in order along the route.
    let from = 0;
    for (const od of def.obstacles) {
      const s0 = onRoute(od.at[0], od.at[1], from, L);
      const s1 = Math.min(L - 1, s0 + od.len);
      from = s1;
      const line = stretch(R, s0, s1);
      let bypass: Polyline;
      let side = 1;
      let gate: Obstacle['gate'] = null;
      if (def.wayRound === 'gate') {
        const w = this.wayRound(s0, s1);
        bypass = w.bypass;
        side = w.side;
        const g = bypass.at(14);
        const g2 = bypass.at(15);
        gate = { x: g.x, z: g.z, yaw: Math.atan2(-(g2.z - g.z), g2.x - g.x) };
      } else bypass = this.detour ?? line;
      this.obstacles.push({
        kind: od.kind,
        label: od.label,
        needs: od.needs,
        p: od.p ?? {},
        s0,
        s1,
        line,
        bypass,
        side,
        gate,
        tries: 0,
        open: def.wayRound !== 'gate',
        done: null,
        inside: false,
        counted: false,
        furthest: 0,
        idle: 0,
        tipFor: 0,
      });
    }
    // The height profile: anchors in order along the route.
    let pf = 0;
    for (const [[x, z], h] of def.profile ?? []) {
      pf = onRoute(x, z, pf, L);
      this.lift.push([pf, h]);
    }
    const end = R.at(L);
    this.camp = { x: end.x, z: end.z };
  }

  /** Extra height of the route's profile at s along it. */
  liftAt(s: number) {
    const A = this.lift;
    if (!A.length) return 0;
    if (s <= A[0][0]) return A[0][1];
    for (let i = 0; i + 1 < A.length; i++) {
      const [s0, h0] = A[i];
      const [s1, h1] = A[i + 1];
      if (s <= s1) {
        // Nearly even all the way (a smoothstep alone is half as steep
        // again in the middle), easing in and out at the ends.
        const t = (s - s0) / Math.max(1e-6, s1 - s0);
        return h0 + (h1 - h0) * (0.6 * t + 0.4 * smoothstep(0, 1, t));
      }
    }
    return A[A.length - 1][1];
  }

  /**
   * The easier way round an obstacle: a track that leaves the trail before
   * it and rejoins after, swinging out to one side (the side with dry land,
   * away from other tracks).
   */
  private wayRound(s0: number, s1: number) {
    const R = this.route;
    const from = s0 - 32;
    const to = s1 + 32;
    const reach = 26;
    const off = (s: number) => reach * smoothstep(from, from + 26, s) * (1 - smoothstep(to - 26, to, s));
    const land = (x: number, z: number) =>
      this.map.land.some((l) => inRing(l.pts, x, z)) && !this.map.areas.some((a) => a.kind === 'water' && inRing(a.pts, x, z));
    let best: { bypass: Polyline; side: number; score: number } | null = null;
    for (const side of [1, -1]) {
      const bypass = R.offset((s) => side * off(s), 1.5, from, to);
      let score = 0;
      for (let s = 0; s <= bypass.length; s += 6) {
        const p = bypass.at(s);
        if (!land(p.x, p.z)) score += 10;
        // Keep clear of other tracks (and the trail itself further along).
        for (const r of this.map.roads) {
          if (r.kind === 'path') continue;
          for (const q of r.pts) if (Math.hypot(q[0] - p.x, q[1] - p.z) < 10) score += 0.02;
        }
      }
      if (!best || score < best.score) best = { bypass, side, score };
    }
    return { bypass: best!.bypass, side: best!.side };
  }

  /** The obstacle's shape at (x, z): extra height on and beside the trail. */
  shape(x: number, z: number): number {
    let y = 0;
    if (this.lift.length) {
      const n = this.route.nearest(x, z, 60);
      if (n) y += this.liftAt(n.s) * (1 - smoothstep(7, 50, n.d));
    }
    for (const o of this.obstacles) {
      const n = o.line.nearest(x, z, 40);
      if (!n) continue;
      const s = n.s;
      const len = o.s1 - o.s0;
      if (o.kind === 'climb') {
        // Up 6.5 m in 22 m, a short top, then easing down to the trail again.
        const up = smoothstep(4, 4 + TUNE.climbUp, s);
        const down = 1 - smoothstep(12 + TUNE.climbUp, len, s);
        const across = 1 - smoothstep(4, 20, n.d);
        y += TUNE.climbH * Math.min(up, down) * across;
      } else if (o.kind === 'washout') {
        // A gully: down into it gently, then out up a washed-out bank of
        // humps on alternate sides, a wheelbase apart, so the car rocks
        // corner to corner with one wheel at a time hanging in the air.
        const out0 = TUNE.washOut * len; // where the climb out starts
        const across = 1 - smoothstep(5, 18, n.d);
        y -= TUNE.washDepth * smoothstep(0, out0 - 6, s) * (1 - smoothstep(out0, len, s)) * across;
        const k = 5.6;
        const fade = smoothstep(out0 - 2, out0 + 3, s) * (1 - smoothstep(len - 5, len - 1, s));
        const hump = (c: number, side: number) => {
          const t = (s - c) / TUNE.humpLen;
          if (Math.abs(t) > 1) return 0;
          const lateral = clamp(1 - Math.abs(n.sd - side * 1.0) / 1.6, 0, 1);
          return TUNE.humpH * (0.5 + 0.5 * Math.cos(Math.PI * t)) * lateral;
        };
        let h = 0;
        for (let c = out0 + 1; c < len - 3; c += k) h += hump(c, 1) + hump(c + k / 2, -1);
        y += h * fade;
      } else if (o.kind !== 'sand') {
        y += this.feature(o, n.s, n.d, n.sd, len);
        continue;
      } else {
        // Sand: soft dips, then a low dune across the trail. With speed
        // you float over it; slow, the sand holds the wheels and you dig in.
        const across = 1 - smoothstep(3, 8, n.d);
        const fade = smoothstep(0, 10, s) * (1 - smoothstep(len - 10, len, s));
        y += -(o.p.dip ?? TUNE.sandDip) * fade * (0.5 + 0.5 * Math.sin(s * 0.45)) * across;
        const face = o.p.duneFace ?? TUNE.duneFace;
        const dune = smoothstep(0.55 * len - face, 0.55 * len, s) * (1 - smoothstep(0.75 * len, len - 4, s));
        y += (o.p.duneH ?? TUNE.duneH) * dune * (1 - smoothstep(4, 14, n.d));
      }
    }
    return y;
  }

  /** The harder trails' obstacles: their shape across and along (metres up). */
  private feature(o: Obstacle, s: number, d: number, sd: number, len: number): number {
    const P = o.p;
    const fade = (a: number) => smoothstep(0, a, s) * (1 - smoothstep(len - a, len, s));
    // A bump under one side of the car: centred `side` metres off the line.
    const under = (side: number, w = 1.6) => clamp(1 - Math.abs(sd - side) / w, 0, 1);
    const bell = (t: number) => (Math.abs(t) > 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * t));
    if (o.kind === 'rocks') {
      // Roots and rock steps on alternate sides, so the car twists corner
      // to corner and one wheel or another is always light or in the air.
      const H = P.humpH ?? 0.55;
      const k = P.period ?? 5.6;
      const L = P.humpLen ?? 1.8;
      let h = 0;
      const i0 = Math.floor(s / k);
      for (let i = i0 - 1; i <= i0 + 1; i++) {
        const c = i * k + 2;
        const r = Math.sin(i * 12.9898 + o.s0) * 43758.5453;
        const jig = 0.75 + 0.5 * (r - Math.floor(r));
        h += H * jig * bell((s - c) / L) * under(1) + H * jig * bell((s - c - k / 2) / L) * under(-1);
      }
      return h * fade(4) * (1 - smoothstep(3, 6, d));
    }
    if (o.kind === 'summit') {
      // Rock ledges across the track, a step up every few metres.
      const step = P.every ?? 9;
      const H = P.ledgeH ?? 0.3;
      const t = s / step;
      const ledge = H * (Math.floor(t) + smoothstep(0.75, 0.9, t - Math.floor(t)));
      // (Held at the top: the ledges are part of the climb.)
      return (ledge - H * (len / step) * smoothstep(0, len, s)) * (1 - smoothstep(4, 9, d)) * fade(3);
    }
    if (o.kind === 'descent') {
      // Washed-out ruts down the slope.
      const rut = (P.rut ?? 0.25) * (under(0.9, 0.5) + under(-0.9, 0.5));
      return -rut * fade(5) * (1 - smoothstep(3, 5, d));
    }
    if (o.kind === 'mud') {
      // Deep wheel ruts, and holes on alternate sides that drop one wheel
      // in and lift the corner opposite.
      const rut = (P.rut ?? 0.3) * (under(0.85, 0.45) + under(-0.85, 0.45));
      const k = P.period ?? 7;
      let holes = 0;
      const i0 = Math.floor(s / k);
      for (let i = i0 - 1; i <= i0 + 1; i++) {
        const c = i * k + 3;
        holes += (P.hole ?? 0.5) * (bell((s - c) / 1.7) * under(0.9, 1.2) + bell((s - c - k / 2) / 1.7) * under(-0.9, 1.2));
      }
      return -(rut + holes) * fade(4) * (1 - smoothstep(3, 6, d));
    }
    if (o.kind === 'ford') {
      // Down a short bank into the water, across a soft bed, and up a
      // steep, slick bank out.
      const depth = P.depth ?? 0.8;
      const inn = P.inn ?? 8;
      const out = P.out ?? 6;
      const down = smoothstep(0, inn, s);
      const up = smoothstep(len - out, len, s);
      return -depth * down * (1 - up) * (1 - smoothstep(6, 16, d)) + (P.bank ?? 1.2) * bell((s - (len - out * 0.6)) / (out * 0.6)) * (1 - smoothstep(4, 9, d));
    }
    if (o.kind === 'camber') {
      // The track tilts towards the sea: stay on the high side.
      const tilt = Math.tan(((P.deg ?? 16) * Math.PI) / 180);
      return (P.dir ?? 1) * sd * tilt * fade(10) * (1 - smoothstep(7, 12, d));
    }
    return 0;
  }

  /** Surface on an obstacle's hard line, if (x, z) is on one. */
  surface(x: number, z: number): Surface | null {
    for (const o of this.obstacles) {
      const n = o.line.nearest(x, z, 8);
      if (!n || n.d > 3.6) continue;
      if (n.s < 2 || n.s > o.s1 - o.s0 - 2) continue;
      return o.kind === 'sand' && o.p.tidal ? TIDAL : KIND_SURFACE[o.kind];
    }
    return null;
  }

  /** Is (x, z) on an obstacle's way round? */
  onBypass(o: Obstacle, x: number, z: number) {
    const n = o.bypass.nearest(x, z, 10);
    return !!n && n.d < 3.5 && n.s > 8 && n.s < o.bypass.length - 8;
  }

  // ---------------- Coaching: tries, hints, the way round ----------------

  private cleanSaid = false;
  /**
   * Called a few times a second with the car's state. Returns a tip to show
   * now (after a stall), and a message to say once (the way round opening,
   * an obstacle passed).
   */
  coach(c: { x: number; z: number; speed: number; low: boolean; diff: boolean; stuck: number }): { tip?: string; say?: string; zone?: string } | null {
    let out: { tip?: string; say?: string; zone?: string } | null = null;
    for (const o of this.obstacles) {
      const n = o.line.nearest(c.x, c.z, 30);
      const len = o.s1 - o.s0;
      const onLine = !!n && n.d < 4.5;
      if (n && n.d < 16 && n.s > -1 && n.s < len + 1) out = { ...(out ?? {}), zone: o.label };
      // Passed it: got to the far end on the hard line (or left it there,
      // a little wide, at speed).
      if (n && o.inside && !o.done && (n.s > len - 3 || o.furthest > len - 3) && n.d < 10) {
        o.done = 'hard';
        o.inside = false;
        const nice = NICE[o.kind];
        out = { ...(out ?? {}), say: nice };
        continue;
      }
      if (!o.done && o.bypass !== o.line && this.onBypass(o, c.x, c.z) && o.open) {
        const b = o.bypass.nearest(c.x, c.z, 10)!;
        if (b.s > o.bypass.length - 12) {
          o.done = 'round';
          out = { ...(out ?? {}), say: 'Back on the trail.' };
        }
      }
      if (o.done) continue;
      // An attempt: on the hard line, past the start. A try ends in a
      // stall (wheels turning, no headway for a few seconds), or in backing
      // out after getting some way in. Backing up for another run after a
      // stall starts the next try.
      const tick = 0.1; // the HUD calls this ten times a second
      if (onLine && n!.s > 1 && n!.s < len) {
        if (!o.inside) {
          o.inside = true;
          o.counted = false;
          o.furthest = n!.s;
          o.idle = 0;
        }
        if (n!.s > o.furthest + 0.5) {
          o.furthest = n!.s;
          o.idle = 0;
        } else o.idle += tick;
        // (Stopped on purpose, off the pedals, is not a stall: rolling back is.)
        const stalled = c.stuck > 2.5 || (o.idle > 4 && Math.abs(c.speed) > 0.15);
        if (stalled && !o.counted) {
          o.counted = true;
          out = this.tried(o, out);
        }
        if (o.counted && n!.s < o.furthest - 6) {
          // Backed up for another go.
          o.counted = false;
          o.furthest = n!.s;
          o.idle = 0;
        }
      } else if (o.inside && (!onLine || n!.s <= 1)) {
        if (!o.counted && o.furthest > 6) out = this.tried(o, out);
        o.inside = false;
      }
      // After a failed try, the tip stays up for a while (rolling back
      // down a climb is over in a moment).
      if (o.tipFor > 0) {
        o.tipFor -= tick;
        out = { ...(out ?? {}), tip: this.tip(o, c) };
      }
    }
    // At camp, after the loop.
    if (!this.cleanSaid && this.obstacles.every((o) => o.done) && Math.hypot(c.x - this.camp.x, c.z - this.camp.z) < 40) {
      this.cleanSaid = true;
      const clean = this.obstacles.every((o) => o.done === 'hard');
      out = { ...(out ?? {}), say: clean ? this.def.clean : this.def.finish };
    }
    return out;
  }

  private hinted = false;
  private tried(o: Obstacle, out: { tip?: string; say?: string; zone?: string } | null) {
    o.tries++;
    o.tipFor = 9;
    if (this.def.wayRound === 'hidden') {
      // No sign on the harder trails: after a good few tries, a word only.
      if (o.tries >= 5 && this.detour && !this.hinted && this.def.detour?.skips.includes(this.obstacles.indexOf(o))) {
        this.hinted = true;
        return { ...(out ?? {}), say: 'The old kampong folk used to go round by an inland track. It is longer, and not marked.' };
      }
      return out;
    }
    if (o.tries >= 3 && !o.open) {
      o.open = true;
      return { ...(out ?? {}), say: `An easier way round the ${o.label.toLowerCase()} is open: follow the marker posts on the ${o.side > 0 ? 'left' : 'right'}.` };
    }
    return out;
  }

  private tip(o: Obstacle, c: { low: boolean; diff: boolean }) {
    const round = o.gate && o.open ? ` Or take the way round (marker posts, ${o.side > 0 ? 'left' : 'right'}).` : '';
    if (o.kind === 'climb') return (c.low ? 'Back down a little and take it slow and steady.' : 'Steep and loose: tap LOW for low range, then ease up it.') + round;
    if (o.kind === 'washout') {
      if (!c.diff) return 'A wheel is in the air and spinning: tap DIFF to lock the diff' + (c.low ? '.' : ', and LOW for the climb out.') + round;
      return (c.low ? 'Keep the wheels turning slowly; let the car rock across.' : 'Tap LOW too, and crawl up out of the gully.') + round;
    }
    if (o.kind === 'sand') return 'Soft sand: back up and take a run at it, and keep your speed up over the dune.' + round;
    // The harder trails: what is missing first, then how to drive it.
    const want: string[] = [];
    if (o.needs.low && !c.low) want.push('LOW for low range');
    if (o.needs.diff && !c.diff) want.push('DIFF to lock the diff');
    if (want.length) return `${TIP_WHY[o.kind]}: tap ${want.join(' and ')}.` + round;
    return TIP_HOW[o.kind] + round;
  }

}
