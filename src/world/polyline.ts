import { clamp } from '../noise';
import type { XZ } from '../courses/types';

// A dense 2D polyline (x, z) with fast nearest-point queries, for coasts,
// roads and paths that bend in any direction. Distances along it ("s") are
// in metres. Points are bucketed in a coarse grid so a query only looks at
// segments nearby.

export interface Near {
  /** Distance to the line, metres. */
  d: number;
  /** Signed distance: positive on the left of the direction of travel. */
  sd: number;
  /** Distance along the line of the nearest point. */
  s: number;
  /** Nearest point. */
  x: number;
  z: number;
}

const CELL = 48;

export class Polyline {
  readonly pts: XZ[];
  readonly cum: number[];
  readonly length: number;
  private grid = new Map<number, number[]>();
  private seen = new Set<number>();

  constructor(pts: XZ[]) {
    this.pts = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    this.length = this.cum[this.cum.length - 1];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      const i0 = Math.floor(Math.min(ax, bx) / CELL);
      const i1 = Math.floor(Math.max(ax, bx) / CELL);
      const j0 = Math.floor(Math.min(az, bz) / CELL);
      const j1 = Math.floor(Math.max(az, bz) / CELL);
      for (let ci = i0; ci <= i1; ci++)
        for (let cj = j0; cj <= j1; cj++) {
          const k = ci * 100003 + cj;
          const l = this.grid.get(k);
          if (l) l.push(i);
          else this.grid.set(k, [i]);
        }
    }
  }

  /** Smooth control points into an evenly spaced polyline. */
  static smooth(ctrl: XZ[], spacing: number): Polyline {
    // Centripetal Catmull-Rom, sampled densely then resampled evenly.
    const dense: XZ[] = [];
    const P = (i: number) => ctrl[clamp(i, 0, ctrl.length - 1)];
    for (let i = 0; i < ctrl.length - 1; i++) {
      const p0 = P(i - 1);
      const p1 = P(i);
      const p2 = P(i + 1);
      const p3 = P(i + 2);
      const seg = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      const steps = Math.max(2, Math.ceil(seg / (spacing / 3)));
      for (let k = 0; k < steps; k++) dense.push(catmull(p0, p1, p2, p3, k / steps));
    }
    dense.push(ctrl[ctrl.length - 1]);
    return new Polyline(resample(dense, spacing));
  }

  /** Point and unit tangent at distance s. */
  at(s: number): { x: number; z: number; tx: number; tz: number } {
    s = clamp(s, 0, this.length);
    let lo = 0;
    let hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const a = this.pts[lo];
    const b = this.pts[hi];
    const segLen = this.cum[hi] - this.cum[lo] || 1;
    const t = (s - this.cum[lo]) / segLen;
    return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, tx: (b[0] - a[0]) / segLen, tz: (b[1] - a[1]) / segLen };
  }

  /**
   * Nearest point within `maxR` metres, or null when nothing is that close.
   * Left of travel is (tz, -tx)... with x east and z south, "left" of a line
   * heading east (+x) is north (-z).
   */
  nearest(x: number, z: number, maxR = 200): Near | null {
    // Search rings of cells outward and stop once no closer segment can exist.
    const r = Math.ceil(maxR / CELL);
    const ci = Math.floor(x / CELL);
    const cj = Math.floor(z / CELL);
    let best = maxR * maxR;
    let bi = -1;
    let bu = 0;
    const seen = this.seen;
    seen.clear();
    for (let ring = 0; ring <= r; ring++) {
      for (let di = -ring; di <= ring; di++)
        for (let dj = -ring; dj <= ring; dj++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue;
          const l = this.grid.get((ci + di) * 100003 + cj + dj);
          if (!l) continue;
          for (const i of l) {
            if (seen.has(i)) continue;
            seen.add(i);
            const [ax, az] = this.pts[i];
            const [bx, bz] = this.pts[i + 1];
            const abx = bx - ax;
            const abz = bz - az;
            const u = clamp(((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz || 1), 0, 1);
            const dx = ax + abx * u - x;
            const dz = az + abz * u - z;
            const d2 = dx * dx + dz * dz;
            if (d2 < best) {
              best = d2;
              bi = i;
              bu = u;
            }
          }
        }
      // Anything in the next ring is at least ring * CELL away.
      if (bi >= 0 && best <= (ring * CELL) ** 2) break;
    }
    if (bi < 0) return null;
    const [ax, az] = this.pts[bi];
    const [bx, bz] = this.pts[bi + 1];
    const nx = ax + (bx - ax) * bu;
    const nz = az + (bz - az) * bu;
    const d = Math.sqrt(best);
    // Cross product of the direction with (point - nearest): left is positive.
    const cross = (bx - ax) * (z - nz) - (bz - az) * (x - nx);
    return { d, sd: cross < 0 ? d : -d, s: this.cum[bi] + (this.cum[bi + 1] - this.cum[bi]) * bu, x: nx, z: nz };
  }

  /** A line offset to the left by off(s) metres (negative = right), resmoothed. */
  offset(off: (s: number) => number, spacing: number, from = 0, to = this.length): Polyline {
    const ctrl: XZ[] = [];
    for (let s = from; s <= to + 1e-6; s += spacing * 4) {
      const p = this.at(s);
      const o = off(s);
      // Left of travel: rotate the tangent (tx, tz) by -90 degrees in the
      // x-east / z-south frame, giving (tz, -tx).
      ctrl.push([p.x + p.tz * o, p.z - p.tx * o]);
    }
    return Polyline.smooth(ctrl, spacing);
  }

  /** Sub-range of points as XZ, every `every` points. */
  sample(every = 1): XZ[] {
    const out: XZ[] = [];
    for (let i = 0; i < this.pts.length; i += every) out.push(this.pts[i]);
    if ((this.pts.length - 1) % every) out.push(this.pts[this.pts.length - 1]);
    return out;
  }
}

function catmull(p0: XZ, p1: XZ, p2: XZ, p3: XZ, t: number): XZ {
  // Centripetal parameterisation (alpha = 0.5) avoids cusps and loops.
  const tj = (a: XZ, b: XZ) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const t0 = 0;
  const t1 = t0 + tj(p0, p1);
  const t2 = t1 + tj(p1, p2);
  const t3 = t2 + tj(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const lerp2 = (a: XZ, b: XZ, ta: number, tb: number): XZ => {
    const k = (u - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  };
  const a1 = lerp2(p0, p1, t0, t1);
  const a2 = lerp2(p1, p2, t1, t2);
  const a3 = lerp2(p2, p3, t2, t3);
  const b1 = lerp2(a1, a2, t0, t2);
  const b2 = lerp2(a2, a3, t1, t3);
  return lerp2(b1, b2, t1, t2);
}

function resample(pts: XZ[], spacing: number): XZ[] {
  const out: XZ[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1];
    const [bx, bz] = pts[i];
    const len = Math.hypot(bx - ax, bz - az);
    let s = spacing - carry;
    while (s <= len) {
      out.push([ax + ((bx - ax) * s) / len, az + ((bz - az) * s) / len]);
      s += spacing;
    }
    carry = len - (s - spacing);
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > spacing * 0.3) out.push(last);
  return out;
}
