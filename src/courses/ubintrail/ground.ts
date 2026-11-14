import { clamp, fbm, lerp, smoothstep } from '../../noise';
import { SegIndex } from '../../world/segindex';
import type { XZ } from '../types';

// Pulau Ubin's ground, worked out once from the OpenStreetMap outlines
// (tools/osm/ubin.mjs): where the land is, how far each point is from the
// shore and from the nearest quarry or pond, and gentle made-up hills on
// top. Every lane, track and path then has the ground shaped to it: the
// road's height is the ground smoothed over about 20 m, so the road never
// pitches with every bump, lanes meet at the same height at a junction,
// and a lane over a pond becomes a low causeway.

export interface UbinMap {
  origin: [number, number];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  attribution: string;
  land: { name: string; pts: XZ[] }[];
  areas: { kind: 'water' | 'wetland' | 'beach' | 'wood' | 'rock' | 'grass'; name: string; pts: XZ[] }[];
  roads: { id: number; name: string; kind: 'lane' | 'track' | 'path'; hw: string; surface: string; bridge?: boolean; width: number; nodes: number[]; pts: XZ[] }[];
  buildings: { pts: XZ[]; levels: number; kind: string }[];
  piers: { name: string; pts: XZ[] }[];
  pois: { kind: string; name: string; x: number; z: number }[];
}

/** A square-celled raster over the map, sampled with bilinear filtering. */
export class Raster {
  readonly w: number;
  readonly h: number;
  readonly data: Float32Array;
  constructor(
    readonly x0: number,
    readonly z0: number,
    readonly cell: number,
    w: number,
    h: number,
  ) {
    this.w = w;
    this.h = h;
    this.data = new Float32Array(w * h);
  }
  at(x: number, z: number) {
    const fx = clamp((x - this.x0) / this.cell, 0, this.w - 1.001);
    const fz = clamp((z - this.z0) / this.cell, 0, this.h - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const d = this.data;
    const k = j * this.w + i;
    return (d[k] * (1 - u) + d[k + 1] * u) * (1 - v) + (d[k + this.w] * (1 - u) + d[k + this.w + 1] * u) * v;
  }
}

/** Visit every cell inside a polygon (scanline, even-odd). */
export function fill(w: number, h: number, x0: number, z0: number, cell: number, pts: XZ[], set: (k: number) => void) {
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const p of pts) {
    zMin = Math.min(zMin, p[1]);
    zMax = Math.max(zMax, p[1]);
  }
  const j0 = Math.max(0, Math.ceil((zMin - z0) / cell - 0.5));
  const j1 = Math.min(h - 1, Math.floor((zMax - z0) / cell - 0.5));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const z = z0 + (j + 0.5) * cell;
    xs.length = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[(i + 1) % n];
      if (az <= z === bz <= z) continue;
      xs.push(ax + ((z - az) / (bz - az)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - x0) / cell - 0.5));
      const i1 = Math.min(w - 1, Math.floor((xs[k + 1] - x0) / cell - 0.5));
      for (let i = i0; i <= i1; i++) set(j * w + i);
    }
  }
}

/**
 * Chamfer distance (metres) from every cell to the nearest cell where
 * `inside` is true, plus which source cell that was (for carrying ids).
 */
function distance(w: number, h: number, cell: number, inside: (k: number) => boolean) {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  const src = new Int32Array(w * h).fill(-1);
  for (let k = 0; k < w * h; k++) if (inside(k)) {
    d[k] = 0;
    src[k] = k;
  } else d[k] = INF;
  const a = cell;
  const b = cell * Math.SQRT2;
  const relax = (k: number, n: number, c: number) => {
    if (d[n] + c < d[k]) {
      d[k] = d[n] + c;
      src[k] = src[n];
    }
  };
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (i > 0) relax(k, k - 1, a);
      if (j > 0) {
        relax(k, k - w, a);
        if (i > 0) relax(k, k - w - 1, b);
        if (i < w - 1) relax(k, k - w + 1, b);
      }
    }
  for (let j = h - 1; j >= 0; j--)
    for (let i = w - 1; i >= 0; i--) {
      const k = j * w + i;
      if (i < w - 1) relax(k, k + 1, a);
      if (j < h - 1) {
        relax(k, k + w, a);
        if (i < w - 1) relax(k, k + w + 1, b);
        if (i > 0) relax(k, k + w - 1, b);
      }
    }
  return { d, src };
}

export const MASK = { land: 1, water: 2, wetland: 4, beach: 8, wood: 16, rock: 32 } as const;
const SEED = 1965;
export const SEA_LEVEL = 0;

export interface RoadHit {
  road: number;
  d: number;
  /** Signed distance, positive on the left of the way's drawn direction. */
  sd: number;
  /** Ground-smoothed road height at the nearest centreline point. */
  h: number;
  half: number;
}

export class UbinGround {
  readonly cell = 4;
  readonly w: number;
  readonly h: number;
  readonly x0: number;
  readonly z0: number;
  /** Bit flags per cell (MASK). */
  readonly mask: Uint8Array;
  /** Signed distance to the shore: + on land, - at sea (metres). */
  readonly shore: Raster;
  /** Signed distance to the nearest quarry/pond edge: + inside the water. */
  readonly wet: Raster;
  /** Which water area each cell is in or nearest to. */
  readonly wetId: Int32Array;
  /** Water surface height of each water area. */
  readonly levels: number[];
  /** Quarries are deep with steep granite sides; ponds are shallow. */
  readonly deep: boolean[];
  /** Dry ground before water and roads. */
  readonly base: Raster;
  /** The same, smoothed: the height the roads follow. */
  readonly smooth: Raster;
  readonly roads: SegIndex;
  readonly roadInfo: UbinMap['roads'];
  /** Extra height (and surface) from the trail's obstacles; set by the trail. */
  shape: ((x: number, z: number) => number) | null = null;

  constructor(readonly map: UbinMap) {
    const b = map.bounds;
    const c = this.cell;
    this.x0 = b.minX;
    this.z0 = b.minZ;
    this.w = Math.round((b.maxX - b.minX) / c);
    this.h = Math.round((b.maxZ - b.minZ) / c);
    const { w, h } = this;
    const mask = (this.mask = new Uint8Array(w * h));
    const layer = (pts: XZ[], bit: number) => fill(w, h, this.x0, this.z0, c, pts, (k) => (mask[k] |= bit));
    for (const l of map.land) layer(l.pts, MASK.land);
    // Water areas get ids (the nearest one's level is used near its banks).
    const ids = new Int32Array(w * h).fill(-1);
    const water = map.areas.filter((a) => a.kind === 'water');
    water.forEach((a, n) =>
      fill(w, h, this.x0, this.z0, c, a.pts, (k) => {
        if (!(mask[k] & MASK.land)) return;
        mask[k] |= MASK.water;
        ids[k] = n;
      }),
    );
    for (const a of map.areas) {
      if (a.kind === 'wetland') layer(a.pts, MASK.wetland);
      else if (a.kind === 'beach') layer(a.pts, MASK.beach);
      else if (a.kind === 'wood') layer(a.pts, MASK.wood);
      else if (a.kind === 'rock') layer(a.pts, MASK.rock);
    }

    // Shore distance, both ways.
    const toLand = distance(w, h, c, (k) => !!(mask[k] & MASK.land));
    const toSea = distance(w, h, c, (k) => !(mask[k] & MASK.land));
    this.shore = new Raster(this.x0, this.z0, c, w, h);
    for (let k = 0; k < w * h; k++) this.shore.data[k] = mask[k] & MASK.land ? toSea.d[k] - c / 2 : -(toLand.d[k] - c / 2);

    // Dry ground: low by the shore, rising inland into gentle made-up hills,
    // with Puaka Hill where the real one is.
    this.base = new Raster(this.x0, this.z0, c, w, h);
    const hill = (x: number, z: number, cx: number, cz: number, r: number, hgt: number) => hgt * Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / (2 * r * r));
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        const x = this.x0 + (i + 0.5) * c;
        const z = this.z0 + (j + 0.5) * c;
        const s = this.shore.data[k];
        let y: number;
        if (s < 0) y = Math.max(-7, -0.6 + s * 0.05);
        else {
          const inland = smoothstep(0, 140, s);
          const hills = 6 + 7 * fbm(x / 520, z / 520, SEED) + 2.2 * fbm(x / 140, z / 140, SEED + 9);
          y = 0.7 + s * 0.012 + inland * Math.max(0, hills);
          y += hill(x, z, 443, 150, 120, 18) * inland; // Puaka Hill
          y += hill(x, z, -1150, -640, 260, 7) * inland; // the rise behind Ketam
        }
        this.base.data[k] = y;
      }
    // Roads follow the ground smoothed over about 20 m.
    this.smooth = new Raster(this.x0, this.z0, c, w, h);
    const blur = (src: Float32Array, dst: Float32Array, r: number) => {
      const t = new Float32Array(w * h);
      for (let j = 0; j < h; j++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) acc += src[j * w + clamp(i, 0, w - 1)];
        for (let i = 0; i < w; i++) {
          t[j * w + i] = acc / (2 * r + 1);
          acc += src[j * w + clamp(i + r + 1, 0, w - 1)] - src[j * w + clamp(i - r, 0, w - 1)];
        }
      }
      for (let i = 0; i < w; i++) {
        let acc = 0;
        for (let j = -r; j <= r; j++) acc += t[clamp(j, 0, h - 1) * w + i];
        for (let j = 0; j < h; j++) {
          dst[j * w + i] = acc / (2 * r + 1);
          acc += t[clamp(j + r + 1, 0, h - 1) * w + i] - t[clamp(j - r, 0, h - 1) * w + i];
        }
      }
    };
    const once = new Float32Array(w * h);
    // (On land only the roads use it; keep it out of the sea so a lane by
    // the shore doesn't sink towards the sea bed.)
    const dry = Float32Array.from(this.base.data, (v) => Math.max(v, 0.7));
    blur(dry, once, 3);
    blur(once, this.smooth.data, 2);

    // Quarries and ponds: a level each, a little under the lowest of their banks.
    this.levels = water.map(() => Infinity);
    this.deep = water.map((a) => /quar/i.test(a.name));
    const toWater = distance(w, h, c, (k) => ids[k] >= 0);
    const toDry = distance(w, h, c, (k) => ids[k] < 0);
    this.wetId = new Int32Array(w * h);
    this.wet = new Raster(this.x0, this.z0, c, w, h);
    for (let k = 0; k < w * h; k++) {
      const inside = ids[k] >= 0;
      const id = inside ? ids[k] : toWater.src[k] >= 0 ? ids[toWater.src[k]] : -1;
      this.wetId[k] = id;
      this.wet.data[k] = inside ? toDry.d[k] - c / 2 : -(toWater.d[k] - c / 2);
      // Bank cells (just outside) set the level.
      if (!inside && id >= 0 && toWater.d[k] <= c * 1.5) this.levels[id] = Math.min(this.levels[id], this.base.data[k]);
    }
    this.levels = this.levels.map((l, n) => (Number.isFinite(l) ? Math.max(0.25, l - (this.deep[n] ? 2.5 : 0.45)) : 0.25));

    // Every lane, track and path in one nearest-segment index.
    this.roadInfo = map.roads;
    this.roads = new SegIndex(
      map.roads.map((r) => r.pts),
      24,
    );
  }

  cellAt(x: number, z: number) {
    const i = clamp(Math.floor((x - this.x0) / this.cell), 0, this.w - 1);
    const j = clamp(Math.floor((z - this.z0) / this.cell), 0, this.h - 1);
    return j * this.w + i;
  }

  /** The ground with quarries and ponds cut in, before roads. */
  natural(x: number, z: number) {
    const y = this.base.at(x, z);
    const dw = this.wet.at(x, z);
    if (dw < -14) return y;
    const id = this.wetId[this.cellAt(x, z)];
    if (id < 0) return y;
    const level = this.levels[id];
    const deep = this.deep[id];
    if (dw > 0) return level - Math.min(deep ? 9 : 1.1, 0.35 + dw * (deep ? 0.8 : 0.25));
    // Banks: quarries drop steeply, ponds slope gently.
    const bank = deep ? 5 : 12;
    if (y < level + 0.3) return lerp(level - 0.35, y, smoothstep(0, 2, -dw)) ;
    return lerp(level + 0.2, y, smoothstep(0, bank, -dw));
  }

  /** Nearest lane/track/path within reach, and the height it runs at. */
  road(x: number, z: number, reach = 14, accept?: (i: number) => boolean): RoadHit | null {
    const hit = this.roads.nearest(x, z, reach, accept);
    if (!hit) return null;
    const r = this.roadInfo[hit.line];
    const [ax, az] = r.pts[hit.seg];
    const [bx, bz] = r.pts[hit.seg + 1];
    const px = ax + (bx - ax) * hit.u;
    const pz = az + (bz - az) * hit.u;
    return { road: hit.line, d: hit.d, sd: hit.sd, h: this.roadHeight(px, pz), half: r.width / 2 };
  }

  /** Height a road runs at, at a point on its centreline. */
  roadHeight(x: number, z: number) {
    // Never below the water it crosses (a causeway), nor under the sea.
    const id = this.wetId[this.cellAt(x, z)];
    const floor = id >= 0 && this.wet.at(x, z) > -6 ? this.levels[id] + 0.55 : 0.7;
    return Math.max(this.smooth.at(x, z), floor);
  }

  /** Ground height, roads and trail obstacles included. */
  heightAt(x: number, z: number) {
    let y = this.natural(x, z);
    const r = this.road(x, z);
    if (r) {
      const shoulder = this.roadInfo[r.road].kind === 'path' ? 3 : 6;
      y = lerp(r.h, y, smoothstep(r.half, r.half + shoulder, r.d));
    }
    if (this.shape) y += this.shape(x, z);
    return y;
  }

  isLand(x: number, z: number) {
    return this.shore.at(x, z) > 0;
  }
  maskAt(x: number, z: number) {
    return this.mask[this.cellAt(x, z)];
  }
  /** Water surface at (x, z) if it is inside a quarry or pond, else null. */
  waterAt(x: number, z: number) {
    if (this.wet.at(x, z) <= 0) return null;
    const id = this.wetId[this.cellAt(x, z)];
    return id >= 0 ? this.levels[id] : null;
  }
}
