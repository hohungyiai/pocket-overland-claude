import { clamp, smoothstep } from '../../noise';
import { Polyline } from '../../world/polyline';
import { inRing } from '../../world/segindex';
import type { Surface, XZ } from '../types';
import type { UbinMap } from './ground';

// The first trail: Ubin Jetty, through the village, west along Jalan
// Jelutong and Jalan Endut Senin, over Puaka Bridge, north up Jalan Wat
// Siam, then the Ketam Trail clockwise round Ketam Quarry and back down to
// the camp site at the end of Jalan Endut Senin. The route is found on the
// real OpenStreetMap lanes and tracks between a few waypoints.
//
// Three light obstacles on the Ketam loop, one skill each:
//   1. a steep loose climb: low range,
//   2. a washout of humps on alternate sides that lifts a wheel: diff lock,
//   3. soft sand along the shore: carry speed (high range).
// After three honest tries at one, an easier way round opens beside it
// (a signposted side track, slower, and it skips the reward). Nothing ever
// fails: the worst that happens is a few minutes.

const WAYPOINTS: XZ[] = [
  [1640, 830], // Ubin Jetty
  [-60, 60], // Puaka Bridge
  [-250, -700], // Jalan Wat Siam, north
  [-1055, -115], // the shore below Ketam Quarry
  [-560, -125], // Ketam Trail, back towards Jalan Wat Siam
  [-60, 60], // Puaka Bridge again
  [-177, 300], // Endut Senin camp site
];

export type ObstacleKind = 'climb' | 'washout' | 'sand';
export interface Obstacle {
  kind: ObstacleKind;
  label: string;
  /** Where on the route it starts and ends (metres). */
  s0: number;
  s1: number;
  /** The obstacle's own stretch of route, for nearest-point queries. */
  line: Polyline;
  /** The easier way round, and the side it leaves on (+1 left). */
  bypass: Polyline;
  side: number;
  /** Where the barrier closing the way round stands. */
  gate: { x: number; z: number; yaw: number };
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
  looseGrip: 0.66,
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
  ...((globalThis as { __ubinTune?: object }).__ubinTune ?? {}),
};
const SOFT_SAND: Surface = { name: 'Soft sand', grip: TUNE.sandGrip, drag: TUNE.sandDrag };
const LOOSE: Surface = { name: 'Loose gravel', grip: TUNE.looseGrip, drag: TUNE.looseDrag };
const RUTS: Surface = { name: 'Washout', grip: 0.78, drag: 1.5 };

/** Find the route on the lanes and tracks (paths only if nothing else joins). */
function findRoute(map: UbinMap): XZ[] {
  const pos = new Map<number, XZ>();
  const adj = new Map<number, { to: number; w: number }[]>();
  const cost = { lane: 1, track: 1, path: 1000 };
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
      if (r.kind === 'path') continue;
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
  const nodes = WAYPOINTS.map(nearestNode);
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

  constructor(readonly map: UbinMap) {
    this.route = new Polyline(findRoute(map));
    const R = this.route;
    const onRoute = (x: number, z: number, from: number, to: number) => {
      // Nearest point on a part of the route (it passes Puaka Bridge twice).
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
    const L = R.length;
    const offroad = onRoute(-250, -700, 0, L);
    const shore = onRoute(-1055, -115, offroad, L);
    const at = (x: number, z: number) => onRoute(x, z, offroad, shore + 200);
    const make = (kind: ObstacleKind, label: string, s0: number, len: number) => {
      const s1 = s0 + len;
      const line = stretch(R, s0, s1);
      const { bypass, side } = this.wayRound(s0, s1);
      const g = bypass.at(14);
      const g2 = bypass.at(15);
      this.obstacles.push({
        kind,
        label,
        s0,
        s1,
        line,
        bypass,
        side,
        gate: { x: g.x, z: g.z, yaw: Math.atan2(-(g2.z - g.z), g2.x - g.x) },
        tries: 0,
        open: false,
        done: null,
        inside: false,
        counted: false,
        furthest: 0,
        idle: 0,
        tipFor: 0,
      });
    };
    make('climb', 'Steep climb', at(-420, -575), 80);
    make('washout', 'Washout', at(-1370, -560), 60);
    make('sand', 'Soft sand', at(-1080, -175), 90);
    const end = R.at(L);
    this.camp = { x: end.x, z: end.z };
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
      } else {
        // Sand: soft dips, then a low dune across the trail. With speed
        // you float over it; slow, the sand holds the wheels and you dig in.
        const across = 1 - smoothstep(3, 8, n.d);
        const fade = smoothstep(0, 10, s) * (1 - smoothstep(len - 10, len, s));
        y += -TUNE.sandDip * fade * (0.5 + 0.5 * Math.sin(s * 0.45)) * across;
        const dune = smoothstep(0.55 * len - TUNE.duneFace, 0.55 * len, s) * (1 - smoothstep(0.75 * len, len - 4, s));
        y += TUNE.duneH * dune * (1 - smoothstep(4, 14, n.d));
      }
    }
    return y;
  }

  /** Surface on an obstacle's hard line, if (x, z) is on one. */
  surface(x: number, z: number): Surface | null {
    for (const o of this.obstacles) {
      const n = o.line.nearest(x, z, 8);
      if (!n || n.d > 3.6) continue;
      if (n.s < 2 || n.s > o.s1 - o.s0 - 2) continue;
      return o.kind === 'climb' ? LOOSE : o.kind === 'washout' ? RUTS : SOFT_SAND;
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
      // Passed it.
      if (n && onLine && n.s > len - 1 && o.inside && !o.done) {
        o.done = 'hard';
        o.inside = false;
        const nice = o.kind === 'sand' ? 'Through the sand, and the view over the strait is yours.' : o.kind === 'climb' ? 'Up and over. Nicely done.' : 'Through the washout. Nicely done.';
        out = { ...(out ?? {}), say: nice };
        continue;
      }
      if (!o.done && this.onBypass(o, c.x, c.z) && o.open) {
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
      out = { ...(out ?? {}), say: clean ? 'Clean run: every obstacle on the hard line. Make camp when you are ready.' : 'Endut Senin camp. Make camp when you are ready.' };
    }
    return out;
  }

  private tried(o: Obstacle, out: { tip?: string; say?: string; zone?: string } | null) {
    o.tries++;
    o.tipFor = 9;
    if (o.tries >= 3 && !o.open) {
      o.open = true;
      return { ...(out ?? {}), say: `An easier way round the ${o.label.toLowerCase()} is open: follow the marker posts on the ${o.side > 0 ? 'left' : 'right'}.` };
    }
    return out;
  }

  private tip(o: Obstacle, c: { low: boolean; diff: boolean }) {
    const round = o.open ? ` Or take the way round (marker posts, ${o.side > 0 ? 'left' : 'right'}).` : '';
    if (o.kind === 'climb') return (c.low ? 'Back down a little and take it slow and steady.' : 'Steep and loose: tap LOW for low range, then ease up it.') + round;
    if (o.kind === 'washout') {
      if (!c.diff) return 'A wheel is in the air and spinning: tap DIFF to lock the diff' + (c.low ? '.' : ', and LOW for the climb out.') + round;
      return (c.low ? 'Keep the wheels turning slowly; let the car rock across.' : 'Tap LOW too, and crawl up out of the gully.') + round;
    }
    return 'Soft sand: back up and take a run at it, and keep your speed up over the dune.' + round;
  }
}
