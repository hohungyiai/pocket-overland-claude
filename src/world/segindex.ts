import type { XZ } from '../courses/types';

// Nearest-segment queries over many polylines at once (roads, paths, coast,
// pond edges). Segments are bucketed in a grid; a query searches rings of
// cells outward and stops once nothing closer can exist.

export interface SegHit {
  /** Distance to the nearest segment, metres. */
  d: number;
  /** Signed distance: positive on the left of travel (x east, z south). */
  sd: number;
  /** Which line, which segment, and where along it (0..1). */
  line: number;
  seg: number;
  u: number;
}

export class SegIndex {
  private grid = new Map<number, number[]>();
  private segLine: Int32Array;
  private segIdx: Int32Array;
  private stamp: Uint32Array;
  private tick = 0;

  /**
   * `closed` lines are rings: the last point joins the first. Lines that
   * `skip` returns true for are left out (kept in `lines` so ids stay put).
   */
  constructor(readonly lines: XZ[][], private cell = 32, private closed = false, skip?: (i: number) => boolean) {
    const sl: number[] = [];
    const si: number[] = [];
    lines.forEach((pts, li) => {
      if (skip?.(li)) return;
      const n = closed ? pts.length : pts.length - 1;
      for (let i = 0; i < n; i++) {
        const [ax, az] = pts[i];
        const [bx, bz] = pts[(i + 1) % pts.length];
        const id = sl.length;
        sl.push(li);
        si.push(i);
        const i0 = Math.floor(Math.min(ax, bx) / cell);
        const i1 = Math.floor(Math.max(ax, bx) / cell);
        const j0 = Math.floor(Math.min(az, bz) / cell);
        const j1 = Math.floor(Math.max(az, bz) / cell);
        for (let ci = i0; ci <= i1; ci++)
          for (let cj = j0; cj <= j1; cj++) {
            const k = ci * 100003 + cj;
            const l = this.grid.get(k);
            if (l) l.push(id);
            else this.grid.set(k, [id]);
          }
      }
    });
    this.segLine = Int32Array.from(sl);
    this.segIdx = Int32Array.from(si);
    this.stamp = new Uint32Array(sl.length);
  }

  private pt(line: number, i: number): XZ {
    const pts = this.lines[line];
    return pts[((i % pts.length) + pts.length) % pts.length];
  }

  /** Nearest segment within maxR, or null. `accept` can rule lines out. */
  nearest(x: number, z: number, maxR: number, accept?: (line: number) => boolean): SegHit | null {
    const cell = this.cell;
    const r = Math.ceil(maxR / cell);
    const ci = Math.floor(x / cell);
    const cj = Math.floor(z / cell);
    let best = maxR * maxR;
    let bs = -1;
    let bu = 0;
    const tick = ++this.tick;
    for (let ring = 0; ring <= r; ring++) {
      for (let di = -ring; di <= ring; di++)
        for (let dj = -ring; dj <= ring; dj++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue;
          const l = this.grid.get((ci + di) * 100003 + cj + dj);
          if (!l) continue;
          for (const s of l) {
            if (this.stamp[s] === tick) continue;
            this.stamp[s] = tick;
            const li = this.segLine[s];
            if (accept && !accept(li)) continue;
            const [ax, az] = this.pt(li, this.segIdx[s]);
            const [bx, bz] = this.pt(li, this.segIdx[s] + 1);
            const abx = bx - ax;
            const abz = bz - az;
            let u = ((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz || 1);
            u = u < 0 ? 0 : u > 1 ? 1 : u;
            const dx = ax + abx * u - x;
            const dz = az + abz * u - z;
            const d2 = dx * dx + dz * dz;
            // At a shared corner prefer the segment seen side-on.
            if (d2 < best - 1e-9 || (d2 <= best + 1e-9 && u > 0 && u < 1 && (bu === 0 || bu === 1))) {
              best = d2;
              bs = s;
              bu = u;
            }
          }
        }
      if (bs >= 0 && best <= (ring * cell) ** 2) break;
    }
    if (bs < 0) return null;
    const line = this.segLine[bs];
    const seg = this.segIdx[bs];
    const d = Math.sqrt(best);
    return { d, sd: this.side(x, z, line, seg, bu) * d, line, seg, u: bu };
  }

  /** Calls f for every segment within maxR of (x, z), with its distance and position along it. */
  each(x: number, z: number, maxR: number, f: (line: number, seg: number, u: number, d: number) => void) {
    const cell = this.cell;
    const i0 = Math.floor((x - maxR) / cell);
    const i1 = Math.floor((x + maxR) / cell);
    const j0 = Math.floor((z - maxR) / cell);
    const j1 = Math.floor((z + maxR) / cell);
    const tick = ++this.tick;
    for (let ci = i0; ci <= i1; ci++)
      for (let cj = j0; cj <= j1; cj++) {
        const l = this.grid.get(ci * 100003 + cj);
        if (!l) continue;
        for (const s of l) {
          if (this.stamp[s] === tick) continue;
          this.stamp[s] = tick;
          const li = this.segLine[s];
          const [ax, az] = this.pt(li, this.segIdx[s]);
          const [bx, bz] = this.pt(li, this.segIdx[s] + 1);
          const abx = bx - ax;
          const abz = bz - az;
          let u = ((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz || 1);
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          const d = Math.hypot(ax + abx * u - x, az + abz * u - z);
          if (d <= maxR) f(li, this.segIdx[s], u, d);
        }
      }
  }

  /** +1 on the left of travel, -1 on the right. */
  private side(x: number, z: number, line: number, seg: number, u: number) {
    const pts = this.lines[line];
    const [ax, az] = this.pt(line, seg);
    const [bx, bz] = this.pt(line, seg + 1);
    // Left normal of a direction (tx, tz) is (tz, -tx).
    let nx = bz - az;
    let nz = -(bx - ax);
    let px = ax + (bx - ax) * u;
    let pz = az + (bz - az) * u;
    if (u <= 0 || u >= 1) {
      // Nearest point is a corner: use the average of both neighbours' normals.
      const v = u <= 0 ? seg : seg + 1;
      const hasPrev = this.closed || v > 0;
      const hasNext = this.closed || v < pts.length - 1;
      const [vx, vz] = this.pt(line, v);
      px = vx;
      pz = vz;
      nx = 0;
      nz = 0;
      if (hasPrev) {
        const [qx, qz] = this.pt(line, v - 1);
        const l = Math.hypot(vx - qx, vz - qz) || 1;
        nx += (vz - qz) / l;
        nz += -(vx - qx) / l;
      }
      if (hasNext) {
        const [qx, qz] = this.pt(line, v + 1);
        const l = Math.hypot(qx - vx, qz - vz) || 1;
        nx += (qz - vz) / l;
        nz += -(qx - vx) / l;
      }
    }
    return (x - px) * nx + (z - pz) * nz >= 0 ? 1 : -1;
  }
}

/** Evenly spaced points along a polyline, keeping both ends. */
export function resample(pts: XZ[], spacing: number): XZ[] {
  const out: XZ[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1];
    const [bx, bz] = pts[i];
    const len = Math.hypot(bx - ax, bz - az);
    let s = spacing - carry;
    while (s < len) {
      out.push([ax + ((bx - ax) * s) / len, az + ((bz - az) * s) / len]);
      s += spacing;
    }
    carry = len - (s - spacing);
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) < spacing * 0.35 && out.length > 1) out[out.length - 1] = last;
  else out.push(last);
  return out;
}

/** Signed area in the x/z plane (positive = counter-clockwise with z as "y"). */
export function ringArea(pts: XZ[]) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % pts.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

/** Point in polygon (even-odd). */
export function inRing(pts: XZ[], x: number, z: number) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i];
    const [xj, zj] = pts[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
