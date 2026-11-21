import { clamp, mulberry32, smoothstep } from '../../noise';
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

export type ObstacleKind = 'climb' | 'washout' | 'sand' | 'rocks' | 'descent' | 'summit' | 'mud' | 'ford' | 'camber'
  // The sides of a stretch, closing it in: 'ridge', the track on a crest
  // with soft bog below either side (slide off and you are stuck); 'thicket',
  // boulders either side, too close together to drive between.
  // 'valley', the track down in a narrow valley, a boggy ditch at the foot
  // of each steep, slick wall.
  | 'ridge' | 'thicket' | 'valley';

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
  /** false: no way round this one, even on a signposted trail. */
  round?: boolean;
  /** Shape numbers for this kind (see shape()). */
  p?: Record<string, number>;
  /**
   * A mixed stretch: several kinds of ground at once, each over its own part
   * of the stretch (metres from its start), overlapping where they mix (a
   * climb with loose rock on it, a ford with a sand bed). Their shapes add;
   * where they overlap, the later one's surface is the ground. Left out, the
   * stretch is all `kind`.
   */
  mix?: { kind: ObstacleKind; from: number; to: number; p?: Record<string, number> }[];
  /** Said when it is passed on the hard line (else the kind's own line). */
  nice?: string;
}

/** Something to see on an obstacle's ground (no collider: the ground's own shape is what the car feels). */
export interface Prop {
  kind: 'rock' | 'pebble' | 'ledge' | 'root' | 'puddle' | 'boulder' | 'anchor';
  x: number;
  z: number;
  /** Heading of its long side (radians, like the car's yaw). */
  yaw: number;
  /** Size: across, up, along. */
  sx: number;
  sy: number;
  sz: number;
}

/** One kind of ground over a part of an obstacle's stretch. */
export interface Part {
  kind: ObstacleKind;
  /** Metres from the obstacle's start. */
  from: number;
  to: number;
  p: Record<string, number>;
  /** This part's own stretch of route. */
  line: Polyline;
  /** Its ground, when its numbers change the kind's own. */
  surf?: Surface;
}

export interface TrailDef {
  id: string;
  name: string;
  grade: 'easy' | 'medium' | 'hard';
  waypoints: XZ[];
  /** Paths may carry the route (not just lanes and tracks). */
  paths?: boolean;
  obstacles: ObstacleDef[];
  /** What the ways round need (none, if left out). */
  roundKit?: { low?: boolean; diff?: boolean };
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
  /** Marked trees to winch to beside the obstacles, and a clean-run score. */
  winch?: boolean;
}
export interface Obstacle {
  kind: ObstacleKind;
  label: string;
  needs: Needs;
  nice?: string;
  p: Record<string, number>;
  /** Its kinds of ground (one, unless a mixed stretch). */
  parts: Part[];
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
  /** Clean-run penalty points on this stretch so far (reverses, winch pulls, tries again). */
  points: number;
  /** Driving this stretch now (entered, not yet through). */
  scoring: boolean;
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
  looseWade: 0.5, // loose gravel hit fast: it ploughs in (per (m/s over looseFrom)^2), so charging the climb does not work
  looseFrom: 4.5,
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
  fordSink: 0.18,
  fordWade: 0.18,
  ...((globalThis as { __ubinTune?: object }).__ubinTune ?? {}),
};
const SOFT_SAND: Surface = { name: 'Soft sand', grip: TUNE.sandGrip, drag: TUNE.sandDrag, offroad: true, sink: TUNE.sandSink };
const LOOSE: Surface = { name: 'Loose gravel', grip: TUNE.looseGrip, drag: TUNE.looseDrag, offroad: true, wade: TUNE.looseWade, wadeFrom: TUNE.looseFrom, rough: 0.8 };
const RUTS: Surface = { name: 'Washout', grip: 0.78, drag: 1.5, offroad: true };
// The harder trails' ground.
const ROCKS: Surface = { name: 'Roots and rock', grip: 0.62, drag: 1.5, offroad: true, rough: 0.8 };
const SCREE: Surface = { name: 'Loose rock', grip: 0.5, drag: 1.2, offroad: true, rough: 1 };
const DEEP_MUD: Surface = { name: 'Deep mud', grip: 0.32, drag: 3, offroad: true, sink: 0.16 };
const TIDAL: Surface = { name: 'Tidal sand', grip: 0.3, drag: 4, offroad: true, sink: 0.2 };
const FORD: Surface = { name: 'Ford', grip: 0.72, drag: 3, offroad: true, sink: TUNE.fordSink, wade: TUNE.fordWade };
const LEDGES: Surface = { name: 'Rock ledges', grip: 0.78, drag: 1.2, offroad: true, rough: 0.6 };
const CAMBER: Surface = { name: 'Off-camber shore', grip: 0.8, drag: 1.8, offroad: true };
const SLICK: Surface = { name: 'Slick bank', grip: 0.25, drag: 1.2, offroad: true };
// Below a ridge: soft, wet bog that holds the car (only the try-again button gets you out).
const BOG: Surface = { name: 'Bog', grip: 0.2, drag: 6, offroad: true, sink: 0.6 };
// A valley's walls: too steep and slick to climb out.
const WALL: Surface = { name: 'Steep bank', grip: 0.25, drag: 1.2, offroad: true };
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
  ridge: CAMBER,
  thicket: CAMBER,
  valley: CAMBER,
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
  ridge: 'Along the ridge without slipping off. Nicely done.',
  valley: 'Up and out of the valley. Nicely done.',
  thicket: 'Through. Nicely done.',
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
  ridge: 'A narrow ridge',
  valley: 'A narrow valley',
  thicket: 'A tight squeeze',
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
  ridge: 'Keep to the middle and go slow: off the edge is bog.',
  valley: 'Keep to the middle of the floor: the ditches either side are bog.',
  thicket: 'Slow, and keep to the track.',
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

export interface Coaching {
  tip?: string;
  say?: string;
  zone?: string;
  /** A stretch just finished on a clean-run trail: its points and the best. */
  scored?: { label: string; points: number; best: number };
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
      // (Nothing to go round where nothing stops you: a descent, a camber.)
      if (def.wayRound === 'gate' && od.round !== false && od.kind !== 'descent' && od.kind !== 'camber') {
        const w = this.wayRound(s0, s1);
        bypass = w.bypass;
        side = w.side;
        const g = bypass.at(14);
        const g2 = bypass.at(15);
        gate = { x: g.x, z: g.z, yaw: Math.atan2(-(g2.z - g.z), g2.x - g.x) };
      } else bypass = this.detour ?? line;
      const mix = od.mix ?? [{ kind: od.kind, from: 0, to: s1 - s0, p: od.p }];
      const parts = mix.map((m) => ({ kind: m.kind, from: m.from, to: Math.min(m.to, s1 - s0), p: m.p ?? {}, line: stretch(R, s0 + m.from, Math.min(s1, s0 + m.to)) }));
      this.obstacles.push({
        kind: od.kind,
        label: od.label,
        needs: od.needs,
        nice: od.nice,
        p: od.p ?? parts.find((q) => q.kind === od.kind)?.p ?? {},
        parts,
        s0,
        s1,
        line,
        bypass,
        side,
        gate,
        tries: 0,
        open: !gate,
        done: null,
        inside: false,
        counted: false,
        furthest: 0,
        idle: 0,
        tipFor: 0,
        points: 0,
        scoring: false,
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
    if (def.winch) this.placeAnchors();
  }

  // ---------------- The winch: marked trees beside the obstacles ----------------

  /** Trees with an orange strap: the only ones the winch hooks onto. */
  readonly anchors: { x: number; z: number }[] = [];
  static readonly REACH = 30;
  /** What the last winchAt on a stretch was missing (LOW, DIFF): why no tree. */
  winchNeeds: string[] = [];

  /**
   * One marked tree every 22 m along each obstacle, sides taking turns,
   * just off the track: on the edge of a ridge's crest or the valley floor,
   * up the bank above a camber. So wherever the car is stuck, on the line
   * or slid off it, one is close (the cable reaches 30 m).
   */
  private placeAnchors() {
    for (const o of this.obstacles) {
      const len = o.s1 - o.s0;
      let side = 1;
      // (And a couple before its start and past its end, for a car stuck at either end.)
      // (Every 11 m, sides in turn: on each side one every 22 m, so a car
      // off either side always has one on the far edge level with it or just behind.)
      for (let s = -16; s < len + 20; s += 11, side = -side) {
        let off = 3.6;
        let sd = side;
        // (Before the start, as at the start.)
        const ps = Math.max(0, s);
        for (const q of o.parts) {
          if (ps < q.from || ps > q.to) continue;
          if (q.kind === 'ridge') off = (q.p.w ?? 2.6) + 0.7;
          // (A valley's on the very edge of its floor, clear of the ditch a car slides into.)
          if (q.kind === 'valley') off = (q.p.w ?? 2.6) + 0.15;
          if (q.kind === 'camber') {
            // (Always up the bank: down the bank is where the car ends up.)
            sd = q.p.dir ?? 1;
            off = (q.p.edge ?? 1) + (q.p.width ?? 3.2) + 1.5;
          }
        }
        // (Past its end, clear of the trail where it opens out again.)
        if (s > len) off = Math.max(off, 4.5);
        const a = s >= 0 && s <= len ? o.line.at(s) : this.route.at(o.s0 + s);
        this.anchors.push({ x: a.x + a.tz * sd * off, z: a.z - a.tx * sd * off });
      }
    }
  }

  /**
   * The marked tree the winch hooks onto from (x, y, z), the car facing
   * (fx, fz). Of those within the cable's reach whose line is not blocked by
   * the ground (`ground` gives its height): off the track, the one that
   * pulls the car back across it (a tree on the far edge lands it on the
   * track); on it, the one furthest ahead. Null when there is none.
   */
  anchorFor(x: number, y: number, z: number, fx: number, fz: number, ground: (x: number, z: number) => number, avoid: { x: number; z: number } | null = null, kit: { low: boolean; diff: boolean } | null = null): { x: number; y: number; z: number; help?: boolean; to?: { x: number; z: number } } | null {
    // Which way the track is, and how far; where along it the car is.
    let tx = 0;
    let tz = 0;
    let off = 0;
    let side = 0;
    let at = 0;
    let line: Polyline | null = null;
    let near: Obstacle | null = null;
    let ns = 0;
    let nx = 0;
    let nz = 0;
    let ntx = 1;
    let ntz = 0;
    for (const o of this.obstacles) {
      const n = o.line.nearest(x, z, 40);
      if (n && (!off || n.d < off)) {
        near = o;
        off = n.d;
        tx = n.x - x;
        tz = n.z - z;
        side = Math.sign(n.sd);
        at = this.route.nearest(n.x, n.z, 40)?.s ?? 0;
        line = o.line;
        ns = n.s;
        nx = n.x;
        nz = n.z;
        const tg = o.line.at(n.s);
        ntx = tg.tx;
        ntz = tg.tz;
      }
    }
    const tl = Math.hypot(tx, tz) || 1;
    const fl = Math.hypot(fx, fz) || 1;
    const across = off > 2.5;
    // On a stretch, the winch only helps the kit it needs, never stands in
    // for it: no tree until LOW and DIFF are in, as it asks.
    this.winchNeeds = [];
    if (!across && near && at > near.s0 - 10 && at < near.s1 + 5 && kit) {
      if (near.needs.low && !kit.low) this.winchNeeds.push('LOW');
      if (near.needs.diff && !kit.diff) this.winchNeeds.push('DIFF');
      if (this.winchNeeds.length) return null;
    }
    // Hauled back from off the track: to its middle beside the car, or on
    // an off-camber shore to its high line (the middle slides it straight
    // back off).
    let home = 0;
    for (const q of near?.parts ?? []) if (q.kind === 'camber' && ns >= q.from && ns <= q.to) home = (q.p.dir ?? 1) * ((q.p.edge ?? 1) + 1.5);
    let best: { x: number; y: number; z: number; help?: boolean; to?: { x: number; z: number } } | null = null;
    let score = -Infinity;
    for (const a of this.anchors) {
      const d = Math.hypot(a.x - x, a.z - z);
      if (d >= UbinTrail.REACH || d < (across ? 3 : 5)) continue;
      // (Not the tree it just could not shift the car from, if there is another.)
      if (avoid && Math.hypot(a.x - avoid.x, a.z - avoid.z) < 0.5) continue;
      // (On the track, only trees 4 m or more ahead, never back along it.
      // Off it, a tree no further along than the car: hauled back, never
      // hauled past the crux it slid off beside.)
      const as = this.route.nearest(a.x, a.z, 40)?.s ?? 0;
      if (across ? as > at || as < at - 22 : as < at + 4) continue;
      const ay = ground(a.x, a.z) + 0.8;
      let clear = true;
      for (let k = 1; k < 10 && clear; k++) {
        const t = k / 10;
        // (Over a crest or a shoulder is fine, as a cable would go; not
        // through a hill higher than both ends.)
        const gh = ground(x + (a.x - x) * t, z + (a.z - z) * t);
        if (gh > Math.max(y, ay) + 1) clear = false;
      }
      if (!clear) continue;
      const ux = (a.x - x) / d;
      const uz = (a.z - z) / d;
      const ahead = (ux * fx + uz * fz) / fl;
      const toTrack = (ux * tx + uz * tz) / tl;
      // Off the track, a tree on the far edge first: pulled across, the car
      // ends up on the track. On it, the one furthest along.
      const far = across && line ? Math.sign(line.nearest(a.x, a.z, 40)?.sd ?? side) !== side : false;
      // Hauled from off the track the car goes along its cable, to where
      // the cable crosses the track's middle (on an off-camber shore, its
      // high line): the tree must be across it, and the crossing short of
      // the tree.
      let to: { x: number; z: number } | undefined;
      if (across) {
        const sdOf = (px: number, pz: number) => (px - nx) * ntz - (pz - nz) * ntx;
        const c = sdOf(x, z);
        const t = sdOf(a.x, a.z);
        const f = (home - c) / (t - c || 1e-6);
        if (!(f > 0 && f < 0.85)) continue;
        to = { x: x + (a.x - x) * f, z: z + (a.z - z) * f };
      }
      const sc = across ? (far ? 5 : 0) + toTrack - Math.abs(as - at) * 0.05 : (as - at) * 0.1 + ahead;
      if (sc > score) {
        score = sc;
        best = across ? { x: a.x, y: ay, z: a.z, to } : { x: a.x, y: ay, z: a.z, help: true };
      }
    }
    if (!best && avoid) return this.anchorFor(x, y, z, fx, fz, ground, null, kit);
    this.pullFrom = best && across && line ? { line, side, home } : null;
    return best;
  }

  /** Pulled in from off the track: which line, and which side of it the car was. */
  private pullFrom: { line: Polyline; side: number; home: number } | null = null;
  /** Winching back from off the track, is the car on it again (near its middle)? Then it unhooks. */
  winchHome(x: number, z: number): boolean {
    const f = this.pullFrom;
    if (!f) return false;
    const n = f.line.nearest(x, z, 40);
    // (Onto a camber's high line all the way; elsewhere well onto the track.)
    return !!n && (n.sd - f.home) * f.side < (f.home ? 0.5 : 1.6);
  }

  /** The boulders, as the winch's haul rides over them: centre, radius, height above the ground. */
  private boulders: { x: number; z: number; r: number; top: number }[] | null = null;
  /** How far above the ground a boulder stands at (x, z) (0 where there is none). */
  boulderAt(x: number, z: number): number {
    if (!this.boulders) this.boulders = this.props().filter((p) => p.kind === 'boulder').map((p) => ({ x: p.x, z: p.z, r: Math.max(p.sx, p.sz) / 2, top: p.sy * 0.75 }));
    let best = 0;
    for (const b of this.boulders) {
      const d = Math.hypot(x - b.x, z - b.z);
      if (d < b.r) best = Math.max(best, b.top * Math.sqrt(1 - (d / b.r) ** 2));
    }
    return best;
  }

  // ---------------- The clean-run score ----------------

  /** Best (fewest) points per stretch, by label, from the save. */
  best: Record<string, number> = {};
  private revFor = 0;
  private revLatched = false;

  /** The stretch the car is on, or stuck beside (as retryAt finds it). */
  private stretchAt(x: number, z: number): Obstacle | null {
    let best: { o: Obstacle; d: number } | null = null;
    for (const o of this.obstacles) {
      const n = o.line.nearest(x, z, 60);
      if (!n || n.d > 40 || n.s < 0 || n.s > o.s1 - o.s0) continue;
      if (!best || n.d < best.d) best = { o, d: n.d };
    }
    return best?.o ?? null;
  }

  /** Penalty points: 5 for a winch pull, 10 for a try again. */
  penalty(what: 'winch' | 'retry', x: number, z: number) {
    if (!this.def.winch) return;
    const o = this.obstacles.find((q) => q.scoring) ?? this.stretchAt(x, z);
    if (!o || o.done) return;
    o.scoring = true;
    o.points += what === 'winch' ? 5 : 10;
  }

  /** What the score badge shows: the stretch and its points, while on one. */
  score(): { label: string; points: number; best?: number } | null {
    if (!this.def.winch) return null;
    const o = this.obstacles.find((q) => q.scoring);
    return o ? { label: o.label, points: o.points, best: this.best[o.label] } : null;
  }

  // The profile spread beside the route: route samples every 4 m in a
  // grid, blended by distance, so the ground is smooth where the route
  // bends back near itself (a nearest point would jump from one part of
  // the route to another, and the ground with it).
  private liftGrid: Map<string, [number, number, number][]> | null = null;
  private liftNear(x: number, z: number) {
    const G = 25;
    if (!this.liftGrid) {
      this.liftGrid = new Map();
      for (let s = 0; s <= this.route.length; s += 4) {
        const p = this.route.at(s);
        const k = `${Math.floor(p.x / G)},${Math.floor(p.z / G)}`;
        if (!this.liftGrid.has(k)) this.liftGrid.set(k, []);
        this.liftGrid.get(k)!.push([p.x, p.z, this.liftAt(s)]);
      }
    }
    const cx = Math.floor(x / G);
    const cz = Math.floor(z / G);
    let dmin = Infinity;
    const near: [number, number][] = [];
    for (let i = cx - 2; i <= cx + 2; i++)
      for (let j = cz - 2; j <= cz + 2; j++)
        for (const [px, pz, h] of this.liftGrid.get(`${i},${j}`) ?? []) {
          const d2 = (px - x) ** 2 + (pz - z) ** 2;
          if (d2 > 2500) continue;
          near.push([d2, h]);
          dmin = Math.min(dmin, d2);
        }
    if (!near.length) return 0;
    let sw = 0;
    let sh = 0;
    for (const [d2, h] of near) {
      const w = Math.exp(-(d2 - dmin) / 200);
      sw += w;
      sh += w * h;
    }
    return (sh / sw) * (1 - smoothstep(7, 50, Math.sqrt(dmin)));
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
    if (this.lift.length) y += this.liftNear(x, z);
    for (const o of this.obstacles) {
      const n = o.line.nearest(x, z, 40);
      if (!n) continue;
      for (const part of o.parts) {
        const s = n.s - part.from;
        const len = part.to - part.from;
        if (s < -20 || s > len + 20) continue;
        // (shift: a part laid along a line beside the route, like mud ruts
        // on the high side of an off-camber bench.)
        const sd = n.sd - (part.p.shift ?? 0);
        y += this.partShape(o, part.kind, part.p, s, Math.abs(sd), sd, len);
      }
    }
    return y;
  }

  /** One kind of ground's shape, s metres into its part of the stretch. */
  private partShape(o: Obstacle, kind: ObstacleKind, P: Record<string, number>, s: number, d: number, sd: number, len: number): number {
    const n = { d, sd };
    let y = 0;
    if (kind === 'climb') {
      // Up 6.5 m in 22 m, a short top, then easing down to the trail again.
      const up = smoothstep(4, 4 + (P.up ?? TUNE.climbUp), s);
      const down = 1 - smoothstep(12 + (P.up ?? TUNE.climbUp) + (P.top ?? 0), len, s);
      const across = 1 - smoothstep(4, 20, n.d);
      y += (P.h ?? TUNE.climbH) * Math.min(up, down) * across;
    } else if (kind === 'washout') {
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
    } else if (kind !== 'sand') {
      return this.feature(o, kind, P, s, n.d, n.sd, len);
    } else {
      // Sand: soft dips, then a low dune across the trail. With speed
      // you float over it; slow, the sand holds the wheels and you dig in.
      const across = 1 - smoothstep(3, 8, n.d);
      const fade = smoothstep(0, 10, s) * (1 - smoothstep(len - 10, len, s));
      y += -(P.dip ?? TUNE.sandDip) * fade * (0.5 + 0.5 * Math.sin(s * 0.45)) * across;
      const face = P.duneFace ?? TUNE.duneFace;
      const dune = smoothstep(0.55 * len - face, 0.55 * len, s) * (1 - smoothstep(0.75 * len, len - 4, s));
      y += (P.duneH ?? TUNE.duneH) * dune * (1 - smoothstep(4, 14, n.d));
    }
    return y;
  }

  /** The harder trails' obstacles: their shape across and along (metres up). */
  private feature(o: Obstacle, kind: ObstacleKind, P: Record<string, number>, s: number, d: number, sd: number, len: number): number {
    const fade = (a: number) => smoothstep(0, a, s) * (1 - smoothstep(len - a, len, s));
    // A bump under one side of the car: centred `side` metres off the line.
    const under = (side: number, w = 1.6) => clamp(1 - Math.abs(sd - side) / w, 0, 1);
    const bell = (t: number) => (Math.abs(t) > 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * t));
    // Roots and rock steps on alternate sides, so the car twists corner to
    // corner and one wheel or another is always light or in the air.
    const humps = (H: number) => {
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
    };
    if (kind === 'rocks') return humps(P.humpH ?? 0.55);
    if (kind === 'summit') {
      // Rock ledges across the track, a step up every few metres.
      const step = P.every ?? 9;
      const H = P.ledgeH ?? 0.3;
      const t = s / step;
      const ledge = H * (Math.floor(t) + smoothstep(0.75, 0.9, t - Math.floor(t)));
      // (Held at the top: the ledges are part of the climb.)
      return (ledge - H * (len / step) * smoothstep(0, len, s)) * (1 - smoothstep(4, 9, d)) * fade(3) + humps(P.humpH ?? 0);
    }
    if (kind === 'descent') {
      // Washed-out ruts down the slope.
      const rut = (P.rut ?? 0.25) * (under(0.9, 0.5) + under(-0.9, 0.5));
      return -rut * fade(5) * (1 - smoothstep(3, 5, d));
    }
    if (kind === 'mud') {
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
    if (kind === 'ford') {
      // Down a short bank into the water, across a soft bed, and up a
      // steep, slick bank out.
      const depth = P.depth ?? 0.8;
      const inn = P.inn ?? 8;
      const out = P.out ?? 6;
      const down = smoothstep(0, inn, s);
      const up = smoothstep(len - out, len, s);
      return -depth * down * (1 - up) * (1 - smoothstep(6, 16, d)) + (P.bank ?? 1.2) * bell((s - (len - out * 0.6)) / (out * 0.6)) * (1 - smoothstep(4, 9, d));
    }
    if (kind === 'ridge') {
      // The track on a crest `w` metres either side of the line, the ground
      // falling `drop` metres within `run` beyond it, into bog.
      const w = P.w ?? 2.6;
      const run = P.run ?? 3;
      return -(P.drop ?? 3) * smoothstep(w, w + run, d) * (1 - smoothstep(w + run + 8, w + run + 16, d)) * fade(P.ends ?? 8);
    }
    if (kind === 'thicket') return 0;
    if (kind === 'valley') {
      // Down `depth` metres into a valley: a floor `w` either side of the
      // line, then a boggy ditch, then a steep wall back up to the land.
      const w = P.w ?? 2.6;
      const ditch = P.ditch ?? 1.6;
      const wall = P.wall ?? 3.5;
      const floor = -(P.depth ?? 4) * (1 - smoothstep(w + ditch, w + ditch + wall, d));
      const dip = -(P.ditchDepth ?? 0.6) * clamp(1 - Math.abs(d - (w + ditch / 2)) / (ditch / 2), 0, 1);
      // (In over `ends` metres, out over `endOut`: gentle enough to climb out on loose ground.)
      const ein = P.ends ?? 25;
      const eout = P.endOut ?? ein;
      return (floor + dip) * smoothstep(0, ein, s) * (1 - smoothstep(len - eout, len, s));
    }
    if (kind === 'camber') {
      // The track is a narrow bench along the bank above the sea: level
      // enough on its high side (a car's width, against the bank), but from
      // the middle down it falls away steep and slick. Drive the middle and
      // the downhill wheels slide, and the car goes down the bank.
      const E = P.edge ?? 1;
      const u = (P.dir ?? 1) * sd - E; // metres uphill of the bench's edge
      const bench = Math.tan(((P.bench ?? 5) * Math.PI) / 180);
      const steep = Math.tan(((P.deg ?? 27) * Math.PI) / 180);
      const W = P.width ?? 3.2;
      let y = u >= 0 ? u * bench : u * steep;
      if (u > W) y = W * bench + (u - W) * Math.tan(Math.PI / 6); // the bank above
      return y * fade(10) * (1 - smoothstep(9, 14, d));
    }
    return 0;
  }

  /**
   * What the ground you feel looks like: a rock on each hump, ledges at
   * each step, roots across the rocky track, loose stones on the gravel and
   * scree, puddles in the mud holes. Worked out from the same numbers as
   * the shapes in partShape() and feature(), so they sit where the bumps are.
   */
  props(): Prop[] {
    const out: Prop[] = [];
    for (const o of this.obstacles) {
      const rand = mulberry32(Math.floor(o.s0 * 7) + 11);
      for (const q of o.parts) {
        const P = q.p;
        const len = q.to - q.from;
        const shift = P.shift ?? 0;
        // A point s metres into the part, `side` metres left of its line.
        const at = (s: number, side: number) => {
          const a = o.line.at(q.from + s);
          const lft = side + shift;
          return { x: a.x + a.tz * lft, z: a.z - a.tx * lft, yaw: Math.atan2(-a.tz, a.tx) };
        };
        const fade = (s: number, a: number) => smoothstep(0, a, s) * (1 - smoothstep(len - a, len, s));
        const rock = (s: number, side: number, h: number, w: number) => {
          if (h < 0.06) return;
          const p = at(s, side);
          out.push({ kind: 'rock', x: p.x, z: p.z, yaw: p.yaw + rand() * 3, sx: w * (0.8 + 0.4 * rand()), sy: h, sz: w * (0.7 + 0.4 * rand()) });
        };
        const stones = (perM: number, half: number, big = 1) => {
          for (let s = 1; s < len - 1; s += 1 / perM) {
            const p = at(s, (rand() * 2 - 1) * half);
            const r = (0.07 + 0.16 * rand() ** 2) * big;
            out.push({ kind: 'pebble', x: p.x, z: p.z, yaw: rand() * 6.28, sx: r * (1 + rand() * 0.6), sy: r * 0.6, sz: r });
          }
        };
        if (q.kind === 'rocks' || q.kind === 'summit') {
          const H = P.humpH ?? (q.kind === 'rocks' ? 0.55 : 0);
          if (H > 0) {
            const k = P.period ?? 5.6;
            const L = P.humpLen ?? 1.8;
            for (let i = 0; i * k + 2 < len; i++) {
              const c = i * k + 2;
              const r = Math.sin(i * 12.9898 + o.s0) * 43758.5453;
              const jig = 0.75 + 0.5 * (r - Math.floor(r));
              rock(c, 1, H * jig * fade(c, 4) + 0.08, L * 1.1);
              rock(c + k / 2, -1, H * jig * fade(c + k / 2, 4) + 0.08, L * 1.1);
              // Roots across the track between the rocks, on the rooty ground.
              if (q.kind === 'rocks' && rand() < 0.55) {
                const p = at(c + k / 4, (rand() - 0.5) * 1.2);
                out.push({ kind: 'root', x: p.x, z: p.z, yaw: p.yaw + (rand() - 0.5) * 0.7, sx: 0.1 + 0.06 * rand(), sy: 0.1, sz: 3.2 + 2 * rand() });
              }
            }
          }
          if (q.kind === 'rocks') stones(1.5, 2.6);
        }
        if (q.kind === 'summit') {
          // A slab at each step, its top flush with the step.
          const step = P.every ?? 9;
          const H = P.ledgeH ?? 0.3;
          for (let m = 0; (m + 0.82) * step < len - 3; m++) {
            const sm = (m + 0.82) * step;
            const p = at(sm + 0.5, 0);
            out.push({ kind: 'ledge', x: p.x, z: p.z, yaw: p.yaw, sx: 5.4 + rand(), sy: H + 0.35, sz: 1.3 });
          }
        }
        if (q.kind === 'washout') {
          const out0 = TUNE.washOut * len;
          const k = 5.6;
          for (let c = out0 + 1; c < len - 3; c += k) {
            rock(c, 1, TUNE.humpH * 0.85, TUNE.humpLen * 0.9);
            rock(c + k / 2, -1, TUNE.humpH * 0.85, TUNE.humpLen * 0.9);
          }
          stones(1, 2.4);
        }
        if (q.kind === 'thicket') {
          // Two staggered rows of boulders either side, gaps narrower than the car.
          const w = P.w ?? 3.4;
          for (const side of [1, -1])
            for (let s = 1; s < len - 1; s += P.gap ?? 2.4) {
              for (let row = 0; row < (P.rows ?? 2); row++) {
                const r = 0.75 + 0.45 * rand();
                const p = at(s + (row % 2) * 1.2, side * (w + r * 0.8 + row * 1.6));
                out.push({ kind: 'boulder', x: p.x, z: p.z, yaw: rand() * 6.28, sx: r * 2, sy: r * (0.9 + 0.4 * rand()), sz: r * 2 });
              }
            }
        }
        if (q.kind === 'ridge') {
          // A few rocks on the crest's edges.
          const w = P.w ?? 2.6;
          for (let s = 3; s < len - 3; s += 7 + 6 * rand()) {
            const side = rand() < 0.5 ? 1 : -1;
            rock(s, side * (w + 0.4), 0.25 + 0.2 * rand(), 0.9);
          }
        }
        if (q.kind === 'climb') stones(3, 2.4);
        if (q.kind === 'descent') stones(3, 2.4, 1.3);
        if (q.kind === 'ford') stones(0.6, 4, 1.4);
        if (q.kind === 'mud') {
          const k = P.period ?? 7;
          for (let i = 0; i * k + 3 < len; i++) {
            for (const [c, side] of [[i * k + 3, 0.9], [i * k + 3 + k / 2, -0.9]] as const) {
              if (c > len - 4 || fade(c, 4) < 0.3) continue;
              const p = at(c, side);
              out.push({ kind: 'puddle', x: p.x, z: p.z, yaw: p.yaw, sx: 1.9 + 0.5 * rand(), sy: 1, sz: 3.2 + 1 * rand() });
            }
          }
        }
      }
    }
    // (Nothing solid on top of a marked tree.)
    if (this.anchors.length) return out.filter((p) => (p.kind !== 'boulder' && p.kind !== 'rock') || this.anchors.every((a) => Math.hypot(a.x - p.x, a.z - p.z) > 1.8));
    return out;
  }

  /** Surface on an obstacle's hard line, if (x, z) is on one. */
  surface(x: number, z: number): Surface | null {
    for (const o of this.obstacles) {
      const n = o.line.nearest(x, z, 8);
      if (!n) continue;
      // (The ford is the ford all the way across the water; the camber's
      // slick side runs down the bank. Where parts overlap, the later one.)
      const inside = (q: Part) => n.s - q.from >= 2 && n.s - q.from <= q.to - q.from - 2;
      for (const q of o.parts) if (q.kind === 'camber' && inside(q) && n.d < 8 && (q.p.dir ?? 1) * n.sd < (q.p.edge ?? 1) + 0.2) return SLICK;
      // (Off the ridge: bog, down the slope and at the bottom.)
      // (Only where the ground has dropped: not in the fade at its ends, nor
      // out where it has risen back to the land around, where a track may cross.)
      for (const q of o.parts) {
        if (q.kind !== 'valley') continue;
        const s = n.s - q.from;
        const e = q.p.ends ?? 25;
        const w = q.p.w ?? 2.6;
        const ditch = q.p.ditch ?? 1.6;
        if (s < e * 0.6 || s > q.to - q.from - (q.p.endOut ?? e) * 0.6 || n.d < w + 0.3) continue;
        if (n.d < w + ditch + 0.4) return BOG;
        if (n.d < w + ditch + (q.p.wall ?? 3.5) + 0.5) return WALL;
      }
      for (const q of o.parts) {
        if (q.kind !== 'ridge') continue;
        const s = n.s - q.from;
        const e = q.p.ends ?? 8;
        const w = q.p.w ?? 2.6;
        if (s > e * 0.6 && s < q.to - q.from - e * 0.6 && n.d > w + 0.3 && n.d < w + (q.p.run ?? 3) + 9) return BOG;
      }
      for (let i = o.parts.length - 1; i >= 0; i--) {
        const q = o.parts[i];
        if (!inside(q) || q.kind === 'ridge' || q.kind === 'thicket' || q.kind === 'valley') continue;
        if (Math.abs(n.sd - (q.p.shift ?? 0)) > (q.kind === 'ford' || q.kind === 'camber' ? 8 : 3.6)) continue;
        const base = q.kind === 'sand' && q.p.tidal ? TIDAL : KIND_SURFACE[q.kind];
        // (A part may soften or firm its ground: p.sink, p.grip.)
        if (q.p.sink === undefined && q.p.grip === undefined) return base;
        return (q.surf ??= { ...base, sink: q.p.sink ?? base.sink, grip: q.p.grip ?? base.grip });
      }
    }
    return null;
  }

  /** The part of an obstacle's stretch at s metres into it. */
  partAt(o: Obstacle, s: number): Part {
    for (let i = o.parts.length - 1; i >= 0; i--) if (s >= o.parts[i].from && s <= o.parts[i].to && o.parts[i].kind !== 'thicket') return o.parts[i];
    return o.parts[0];
  }

  /**
   * On an obstacle, or stuck beside it (slid off the bank into the water, or
   * bogged off the line): where to start it again, a little before it on
   * the trail, facing along it.
   */
  retryAt(x: number, z: number): { x: number; z: number; yaw: number; label: string } | null {
    let best: { o: Obstacle; d: number } | null = null;
    for (const o of this.obstacles) {
      const n = o.line.nearest(x, z, 60);
      // (Not before it, and not once past its end.)
      if (!n || n.d > 40 || n.s < 2 || n.s > o.s1 - o.s0 - 1) continue;
      if (!best || n.d < best.d) best = { o, d: n.d };
    }
    if (!best) return null;
    const p = this.route.at(Math.max(0, best.o.s0 - 12));
    return { x: p.x, z: p.z, yaw: Math.atan2(-p.tz, p.tx), label: best.o.label };
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
  coach(c: { x: number; z: number; speed: number; low: boolean; diff: boolean; stuck: number }): Coaching | null {
    let out: Coaching | null = null;
    for (const o of this.obstacles) {
      const n = o.line.nearest(c.x, c.z, 30);
      const len = o.s1 - o.s0;
      const onLine = !!n && n.d < 4.5;
      if (n && n.d < 16 && n.s > -1 && n.s < len + 1) out = { ...(out ?? {}), zone: o.label };
      // Passed it: got to the far end on the hard line (or left it there,
      // a little wide, at speed).
      if (n && o.inside && !o.done && (n.s > len - 3 || o.furthest > len - 3) && n.d < (o.parts.some((q) => q.kind === 'camber' && q.to > len - 5) ? 3.5 : 10)) {
        o.done = 'hard';
        o.inside = false;
        const nice = o.nice ?? NICE[o.kind];
        if (this.def.winch) {
          // The clean-run score: said at the end, the best kept.
          o.scoring = false;
          const was = this.best[o.label];
          const better = was === undefined || o.points < was;
          if (better) this.best[o.label] = o.points;
          const how = o.points === 0 ? 'Clean run!' : `Through with ${o.points} point${o.points === 1 ? '' : 's'}${better && was !== undefined ? ', your best yet' : was !== undefined ? ` (best ${was})` : ''}.`;
          out = { ...(out ?? {}), say: `${how} ${nice}`, scored: { label: o.label, points: o.points, best: this.best[o.label] } };
        } else out = { ...(out ?? {}), say: nice };
        continue;
      }
      // (On the clean-run trails: the score starts as the car enters a stretch.)
      if (this.def.winch && n && n.d < 16 && n.s > 0 && n.s < len && !o.scoring) {
        for (const q of this.obstacles) q.scoring = false;
        o.scoring = true;
      }
      if (!o.done && o.bypass !== o.line && this.onBypass(o, c.x, c.z) && o.open) {
        const b = o.bypass.nearest(c.x, c.z, 10)!;
        if (b.s > o.bypass.length - 12) {
          o.done = 'round';
          o.scoring = false;
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
    // Backing up on a stretch: a point each time (a metre or more, once per
    // spell in reverse).
    const on = this.obstacles.find((q) => q.scoring);
    if (on && c.speed < -0.3) {
      this.revFor += -c.speed * 0.1;
      if (this.revFor > 1 && !this.revLatched) {
        this.revLatched = true;
        on.points += 1;
      }
    } else if (c.speed > 0.3) {
      this.revFor = 0;
      this.revLatched = false;
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
  private tried(o: Obstacle, out: Coaching | null) {
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
    const single = o.parts.length === 1;
    if (single && o.kind === 'climb') return (c.low ? 'Back down a little and take it slow and steady.' : 'Steep and loose: tap LOW for low range, then ease up it.') + round;
    if (single && o.kind === 'washout') {
      if (!c.diff) return 'A wheel is in the air and spinning: tap DIFF to lock the diff' + (c.low ? '.' : ', and LOW for the climb out.') + round;
      return (c.low ? 'Keep the wheels turning slowly; let the car rock across.' : 'Tap LOW too, and crawl up out of the gully.') + round;
    }
    if (single && o.kind === 'sand') return 'Soft sand: back up and take a run at it, and keep your speed up over the dune.' + round;
    // The harder trails: what is missing first, then how to drive it.
    const want: string[] = [];
    if (o.needs.low && !c.low) want.push('LOW for low range');
    if (o.needs.diff && !c.diff) want.push('DIFF to lock the diff');
    // (On a mixed stretch, about the ground where the car got stuck.)
    const k = this.partAt(o, o.furthest).kind;
    if (want.length) return `${TIP_WHY[k]}: tap ${want.join(' and ')}.` + round;
    return TIP_HOW[k] + round;
  }

}
