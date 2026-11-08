import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { lerp, mulberry32, smoothstep, valueNoise } from '../noise';
import { SURFACES, type Surface, type XZ, type MapData } from './types';
import { Polyline } from '../world/polyline';
import type { Layer, TileKit } from '../world/stream';
import type { Lane } from '../traffic';

// Changi: the drive carries on east from East Coast Park, along Changi
// Coast Road (the sea on one side, the airport fence on the other, planes
// coming in low over the road) and round the island's eastern tip to
// Changi Beach Park on the north shore. Stylized and compressed, not map
// data: about 3 km of coast instead of the real 10.
//
// Unlike East Coast Park, whose coast runs along x, this coast bends, so
// everything is laid out by distance along the coastline (s) and distance
// inland from it (d), using polylines.

type Rapier = typeof RAPIER_NS;

/** What East Coast Park tells Changi so the two join without a seam. */
export interface Seam {
  seed: number;
  parkH: number;
  /** x where East Coast Park hands over (its road ends here). */
  x: number;
  coastZ(x: number): number;
  pathZ(x: number): number;
  fenceZ: number;
  /** East Coast Park's service road points, west to east. */
  road: XZ[];
  parkGround(x: number, z: number): number;
}

// Coastline after the seam, sea on the right going along it: east, then
// north-east up Changi Coast Road, round the tip, then west along the
// north shore (Changi Beach Park).
const COAST_CTRL: XZ[] = [
  [1050, 31], [1200, 8], [1350, -38], [1500, -108], [1640, -196], [1780, -306], [1900, -438],
  [1998, -588], [2066, -756], [2098, -930], [2082, -1082], [2012, -1204], [1902, -1292],
  [1762, -1352], [1600, -1392], [1400, -1420], [1200, -1438], [1000, -1452], [800, -1470], [640, -1494],
];

// Runway: straight, inside the airport fence, roughly along the coast road.
// Planes come in over the sea and the east end of East Coast Park.
const RUNWAY = { a: [1120, -470] as XZ, b: [1720, -1170] as XZ, half: 22 };
const TOWER: XZ = [1330, -930];

export const CHANGI_BOUNDS = { minX: -1100, maxX: 2400, minZ: -1800, maxZ: 190 };

const ROAD_HALF = 3.6;
const PATH_HALF = 1.6;

export function changiShape(seam: Seam) {
  const H = seam.parkH;
  const SX = seam.x;

  // --- Lines ---
  const coastCtrl: XZ[] = [];
  for (let x = SX - 200; x <= SX + 120; x += 20) coastCtrl.push([x, seam.coastZ(x)]);
  coastCtrl.push(...COAST_CTRL);
  const coast = Polyline.smooth(coastCtrl, 5);
  const L = coast.length;
  const sAt = (x: number, z: number) => coast.nearest(x, z, 400)!.s;
  const sSeam = sAt(SX, seam.coastZ(SX));
  const sTip = sAt(2098, -930);
  const sBeach = sAt(1762, -1352);

  // Widths across the corridor, measured inland from the waterline.
  // [s, beach, path, road, fence]
  const KEYS: [number, number, number, number, number][] = [
    [0, 26, 33, 71, 115],
    [sSeam + 60, 26, 33, 71, 115],
    [sSeam + 330, 16, 24, 46, 68],
    [sTip - 60, 16, 24, 46, 68],
    [sTip + 300, 30, 42, 98, 128],
    [L, 30, 42, 98, 128],
  ];
  const prof = { beach: 0, path: 0, road: 0, fence: 0 };
  const profile = (s: number) => {
    let k = 0;
    while (k < KEYS.length - 2 && s > KEYS[k + 1][0]) k++;
    const a = KEYS[k];
    const b = KEYS[k + 1];
    const t = smoothstep(a[0], b[0], s);
    prof.beach = lerp(a[1], b[1], t);
    prof.path = lerp(a[2], b[2], t);
    prof.road = lerp(a[3], b[3], t);
    prof.fence = lerp(a[4], b[4], t);
    return prof;
  };
  const offsetPts = (pick: (p: typeof prof) => number, s0: number, s1: number, step: number): XZ[] => {
    const out: XZ[] = [];
    for (let s = s0; s <= s1; s += step) {
      const p = coast.at(s);
      const o = pick(profile(s));
      out.push([p.x + p.tz * o, p.z - p.tx * o]);
    }
    return out;
  };
  const sFrom = (x: number) => sAt(x, seam.coastZ(x));

  // Road: East Coast Park's own road up to the seam, then the coast road.
  const road = Polyline.smooth(
    [...seam.road.filter(([x]) => x >= SX - 160 && x <= SX), ...offsetPts((p) => p.road, sFrom(SX + 140), L - 60, 30)],
    4,
  );
  const pathCtrl: XZ[] = [];
  for (let x = SX - 160; x <= SX + 40; x += 20) pathCtrl.push([x, seam.pathZ(x)]);
  const path = Polyline.smooth([...pathCtrl, ...offsetPts((p) => p.path, sFrom(SX + 110), L - 30, 30)], 2);
  const fence = Polyline.smooth(
    [[SX - 100, seam.fenceZ], [SX, seam.fenceZ], ...offsetPts((p) => p.fence, sFrom(SX + 150), L, 30)],
    4,
  );

  // Carparks in the beach park: between the road and the fence, square to the road.
  const lots = [sBeach + 260, sBeach + 820].map((s) => {
    const p = coast.at(s);
    const o = profile(s).road + ROAD_HALF + 12;
    const r = road.nearest(p.x + p.tz * o, p.z - p.tx * o, 80)!;
    const t = road.at(r.s);
    return { cx: p.x + p.tz * o, cz: p.z - p.tx * o, tx: t.tx, tz: t.tz, hw: 26, hd: 10 };
  });
  type Lot = (typeof lots)[number];
  const lotLocal = (l: Lot, x: number, z: number) => {
    const dx = x - l.cx;
    const dz = z - l.cz;
    return { u: dx * l.tx + dz * l.tz, v: dx * l.tz - dz * l.tx };
  };
  const lotDist = (l: Lot, x: number, z: number) => {
    const { u, v } = lotLocal(l, x, z);
    return Math.hypot(Math.max(Math.abs(u) - l.hw, 0), Math.max(Math.abs(v) - l.hd, 0));
  };

  // Land test for points far from the coast: inside the coast plus a box
  // that closes it off to the west.
  const coarse = coast.sample(4);
  const landPoly: XZ[] = [...coarse, [coarse[coarse.length - 1][0], -1500], [-3000, -1500], [-3000, coarse[0][1]]];
  const inPoly = (x: number, z: number) => {
    let inside = false;
    for (let i = 0, j = landPoly.length - 1; i < landPoly.length; j = i++) {
      const [xi, zi] = landPoly[i];
      const [xj, zj] = landPoly[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };

  // Far from the coast nothing changes within a cell, so remember per cell
  // whether the coast is out of reach and which side it is.
  const FAR = 300;
  const CELLM = 50;
  const farCells = new Map<number, number>(); // 0 = near coast, 1 = land, 2 = sea
  const farState = (x: number, z: number) => {
    const ci = Math.floor(x / CELLM);
    const cj = Math.floor(z / CELLM);
    const k = ci * 100003 + cj;
    let v = farCells.get(k);
    if (v === undefined) {
      const cx = (ci + 0.5) * CELLM;
      const cz = (cj + 0.5) * CELLM;
      v = coast.nearest(cx, cz, FAR + CELLM) ? 0 : inPoly(cx, cz) ? 1 : 2;
      farCells.set(k, v);
    }
    return v;
  };
  const isLand = (x: number, z: number) => inPoly(x, z);
  // Height and colour ask about the same points one after the other.
  let memoX = NaN;
  let memoZ = NaN;
  let memoN: ReturnType<typeof coast.nearest> = null;
  const nearCoast = (x: number, z: number) => {
    if (x === memoX && z === memoZ) return memoN;
    memoX = x;
    memoZ = z;
    memoN = farState(x, z) === 0 ? coast.nearest(x, z, FAR) : null;
    return memoN;
  };
  const farLand = (x: number, z: number) => {
    const st = farState(x, z);
    return st === 1 || (st === 0 && isLand(x, z));
  };

  // --- Height ---
  const flat = H + 0.1;
  const inland = H + 0.2;
  /** Ground height, or null when the coast is far away (caller decides). */
  function heightAt(x: number, z: number): number {
    const n = nearCoast(x, z);
    if (!n) return farLand(x, z) ? inland : -4.3;
    const P = profile(n.s);
    const sd = n.sd;
    if (sd < P.beach) {
      let h: number;
      if (sd > 0) h = lerp(H - 0.1, 0.05, smoothstep(P.beach, 0, sd) ** 0.8);
      else h = -1.3 * smoothstep(0, 28, -sd) - 3 * smoothstep(28, 140, -sd);
      return h + 0.12 * (valueNoise(x / 9, z / 9, seam.seed + 4) - 0.5);
    }
    if (sd > P.fence + 6) return inland;
    let h = seam.parkGround(x, z);
    const r = road.nearest(x, z, 12);
    if (r) h = lerp(flat, h, smoothstep(ROAD_HALF + 0.5, ROAD_HALF + 6, r.d));
    const p = path.nearest(x, z, 8);
    if (p) h = lerp(flat, h, smoothstep(PATH_HALF + 0.5, PATH_HALF + 4, p.d));
    for (const l of lots) h = lerp(flat, h, smoothstep(0.5, 5, lotDist(l, x, z)));
    return lerp(h, inland, smoothstep(P.fence - 4, P.fence + 4, sd));
  }

  // --- Ground colour ---
  const C = {
    grass: new THREE.Color(0.24, 0.46, 0.17),
    grassDry: new THREE.Color(0.4, 0.5, 0.22),
    sand: new THREE.Color(0.93, 0.86, 0.68),
    wetSand: new THREE.Color(0.72, 0.64, 0.48),
    seabed: new THREE.Color(0.55, 0.6, 0.5),
    hard: new THREE.Color(0.62, 0.62, 0.6),
    airfield: new THREE.Color(0.42, 0.56, 0.26),
  };
  const tmp = new THREE.Color();
  const inlandColor = (x: number, z: number, s: number, out: THREE.Color) => {
    // Paved estate where East Coast Park's is, mown airfield elsewhere.
    out.copy(C.airfield).lerp(C.grassDry, valueNoise(x / 40, z / 40, seam.seed + 31) * 0.35);
    const estate = (1 - smoothstep(SX + 10, SX + 70, x)) * smoothstep(-400, -340, z) * (1 - smoothstep(sSeam + 100, sSeam + 200, s));
    return out.lerp(C.hard, estate);
  };
  function colorAt(x: number, z: number, h: number, out: THREE.Color) {
    const n = nearCoast(x, z);
    if (!n) {
      if (farLand(x, z)) return inlandColor(x, z, sSeam, out);
      return out.copy(C.seabed);
    }
    const P = profile(n.s);
    const sd = n.sd;
    if (sd < P.beach) {
      out.copy(C.sand).lerp(C.wetSand, smoothstep(6, 0, sd));
      if (h < -0.1) out.lerp(C.seabed, smoothstep(-0.1, -1.5, h));
      return out;
    }
    if (sd > P.fence + 1) return inlandColor(x, z, n.s, out);
    out.copy(C.grass).lerp(C.grassDry, valueNoise(x / 25, z / 25, seam.seed + 2) * 0.6);
    out.lerp(C.sand, smoothstep(P.beach + 4, P.beach, sd));
    return out.lerp(inlandColor(x, z, n.s, tmp), smoothstep(P.fence - 1, P.fence + 1, sd));
  }

  // --- Surface ---
  function surfaceAt(x: number, z: number, y: number): Surface {
    if (y < -0.05) return SURFACES.water;
    const n = nearCoast(x, z);
    if (!n) return SURFACES.grass;
    const P = profile(n.s);
    if (n.sd < P.beach + 1) {
      const toWater = smoothstep(P.beach, 0, n.sd);
      const drag = 10 + 22 * toWater;
      return { name: 'Sand', grip: 0.62, drag };
    }
    const r = road.nearest(x, z, 8);
    if (r && r.d < ROAD_HALF + 0.3) return SURFACES.asphalt;
    const p = path.nearest(x, z, 4);
    if (p && p.d < PATH_HALF + 0.2) return SURFACES.asphalt;
    for (const l of lots) if (lotDist(l, x, z) === 0) return SURFACES.asphalt;
    return SURFACES.grass;
  }

  function zoneAt(x: number, z: number): string | null {
    const n = nearCoast(x, z);
    if (!n || n.s < sSeam + 80) return null;
    const P = profile(n.s);
    if (n.sd > P.fence) return 'Changi Airport';
    if (n.s > sTip + 120) return n.sd < P.beach ? 'Changi Beach' : 'Changi Beach Park';
    return n.sd < P.beach ? 'Beach' : 'Changi Coast Road';
  }

  /** 0 inside East Coast Park, 1 inside Changi (blends over 40 m at the seam). */
  const weight = (x: number, z: number) => Math.max(smoothstep(SX, SX + 40, x), smoothstep(-330, -370, z));

  return { coast, road, path, fence, lots, lotLocal, profile, heightAt, colorAt, surfaceAt, zoneAt, weight, isLand, sSeam, sTip, sBeach, L };
}

export type ChangiShape = ReturnType<typeof changiShape>;

/** Helpers East Coast Park lends Changi, so both look the same. */
export interface ChangiKit {
  scene: THREE.Scene;
  world: RAPIER_NS.World;
  RAPIER: Rapier;
  detailed: boolean;
  parkH: number;
  heightAt(x: number, z: number): number;
  onTile(layer: Layer, x: number, z: number, job: (kit: TileKit) => void): void;
  tileKey(x: number, z: number): string;
  tileCentre(k: string): { x: number; z: number };
  ribbon(pts: THREE.Vector3[], half: number, lift: number, color: number, dashed?: boolean, tex?: THREE.Texture | null): void;
  asphaltTex: THREE.Texture | null;
  tartanTex: THREE.Texture | null;
  /** Schedule instanced vegetation (kind name -> placements). */
  vegetation(lists: Record<string, { x: number; y: number; z: number; s: number; r: number; c?: THREE.Color }[]>): void;
  hues: Record<string, [number, number, number, number] | undefined>;
  tint(g: THREE.BufferGeometry, c: number): THREE.BufferGeometry;
  merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry;
  plainMat: THREE.Material;
  lamp: THREE.BufferGeometry;
  bench: THREE.BufferGeometry;
  shelter: THREE.BufferGeometry;
  carGeo: THREE.BufferGeometry;
  carMat: THREE.Material;
  carColors: number[];
  lotMat: THREE.Material;
  wind: { value: number };
}

export function buildChangi(shape: ChangiShape, kit: ChangiKit, seed: number) {
  const { coast, road, path, fence, lots, profile, sSeam, sTip, sBeach, L } = shape;
  const { world, RAPIER, scene, heightAt, onTile, tint, merge, parkH: H } = kit;
  const rand = mulberry32(seed + 5000);
  const v3 = (pts: XZ[]) => pts.map(([x, z]) => new THREE.Vector3(x, 0, z));
  const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

  // Where the shared East Coast Park lines stop and Changi's take over.
  const afterSeam = (pts: XZ[], x0: number) => {
    const i = pts.findIndex(([x]) => x >= x0);
    return i < 0 ? [] : pts.slice(Math.max(0, i - 1));
  };
  const seamX = shape.coast.at(sSeam).x;

  // ---------- Ribbons ----------
  const roadPts = v3(afterSeam(road.pts, seamX));
  kit.ribbon(roadPts, ROAD_HALF, 0.04, 0x4a4c50, false, kit.asphaltTex);
  kit.ribbon(roadPts, 0.08, 0.06, 0xf2efe4, true);
  kit.ribbon(roadPts.map((p) => p.clone()), ROAD_HALF + 0.35, 0.02, 0xb9b5aa);
  const pathPts = v3(afterSeam(path.pts, seamX));
  kit.ribbon(pathPts, PATH_HALF, 0.04, 0xa45b49, false, kit.tartanTex);
  kit.ribbon(pathPts, 0.06, 0.06, 0xf2efe4, true);

  // ---------- Invisible walls: sea side, fence, and the far end ----------
  const wallSeg = (ax: number, az: number, bx: number, bz: number, y: number) => {
    const len = Math.hypot(bx - ax, bz - az);
    const rot = -Math.atan2(bz - az, bx - ax);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(len / 2 + 0.5, 4, 0.5)
        .setTranslation((ax + bx) / 2, y, (az + bz) / 2)
        .setRotation({ x: 0, y: Math.sin(rot / 2), z: 0, w: Math.cos(rot / 2) }),
      fixed,
    );
  };
  for (let s = sSeam - 20; s < L - 20; s += 30) {
    const a = coast.at(s);
    const b = coast.at(s + 30);
    const o = -26;
    wallSeg(a.x + a.tz * o, a.z - a.tx * o, b.x + b.tz * o, b.z - b.tx * o, H + 2);
  }
  const fp = fence.pts;
  for (let i = 0; i + 6 < fp.length; i += 6) wallSeg(fp[i][0], fp[i][1], fp[i + 6][0], fp[i + 6][1], H + 2);
  {
    const e = coast.at(L - 20);
    const P = profile(L - 20);
    wallSeg(e.x - e.tz * 30, e.z + e.tx * 30, e.x + e.tz * (P.fence + 5), e.z - e.tx * (P.fence + 5), H + 2);
  }

  // ---------- Airport fence: posts and a see-through mesh panel ----------
  {
    const postGeo = new THREE.BoxGeometry(0.1, 2.8, 0.1).translate(0, 1.4, 0);
    const posts = new Map<string, THREE.BufferGeometry[]>();
    const panels = new Map<string, number[]>();
    const fPts = afterSeam(fence.pts, seamX);
    for (let i = 0; i < fPts.length - 1; i++) {
      const [ax, az] = fPts[i];
      const [bx, bz] = fPts[i + 1];
      const k = kit.tileKey((ax + bx) / 2, (az + bz) / 2);
      if (!posts.has(k)) posts.set(k, []);
      posts.get(k)!.push(postGeo.clone().translate(ax, heightAt(ax, az), az));
      const ya = heightAt(ax, az);
      const yb = heightAt(bx, bz);
      if (!panels.has(k)) panels.set(k, []);
      panels.get(k)!.push(ax, ya + 0.15, az, bx, yb + 0.15, bz, bx, yb + 2.7, bz, ax, ya + 0.15, az, bx, yb + 2.7, bz, ax, ya + 2.7, az);
    }
    const postMat = new THREE.MeshStandardMaterial({ color: 0x5d6266, roughness: 0.6, metalness: 0.4 });
    const panelMat = new THREE.MeshStandardMaterial({ color: 0x9aa1a6, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false, roughness: 0.8 });
    for (const [k, list] of posts) {
      const c = kit.tileCentre(k);
      onTile('far', c.x, c.z, (t) => {
        const m = new THREE.Mesh(t.own(mergeGeometries(list)), postMat);
        m.castShadow = true;
        t.add(m);
        const g = t.own(new THREE.BufferGeometry());
        g.setAttribute('position', new THREE.Float32BufferAttribute(panels.get(k)!, 3));
        g.computeVertexNormals();
        t.add(new THREE.Mesh(g, panelMat));
      });
    }
  }

  // ---------- Vegetation ----------
  type P = { x: number; y: number; z: number; s: number; r: number; c?: THREE.Color };
  const veg: Record<string, P[]> = {};
  const blocked = (x: number, z: number, pad: number) => {
    const r = road.nearest(x, z, ROAD_HALF + pad + 1);
    if (r && r.d < ROAD_HALF + pad) return true;
    const p = path.nearest(x, z, PATH_HALF + pad + 1);
    if (p && p.d < PATH_HALF + pad) return true;
    for (const l of lots) {
      const { u, v } = shape.lotLocal(l, x, z);
      if (Math.abs(u) < l.hw + pad && Math.abs(v) < l.hd + pad) return true;
    }
    return false;
  };
  const put = (kind: string, x: number, z: number, s: number) => {
    if (x < seamX + 6 && z > -330) return; // East Coast Park plants its own side
    const hue = kit.hues[kind];
    const c = hue ? new THREE.Color().setHSL(hue[0] + (rand() - 0.5) * hue[3], hue[1] + (rand() - 0.5) * 0.1, hue[2] + (rand() - 0.5) * 0.1) : undefined;
    (veg[kind] ??= []).push({ x, y: heightAt(x, z), z, s, r: rand() * Math.PI * 2, c });
  };
  /** World point at (s along the coast, d inland). */
  const at = (s: number, d: number) => {
    const p = coast.at(s);
    return { x: p.x + p.tz * d, z: p.z - p.tx * d };
  };
  const beachPark = (s: number) => smoothstep(sTip, sTip + 250, s);
  // Palms and casuarinas either side of the path; casuarinas at the top of the beach.
  for (let s = sSeam; s < L - 30; s += 7 + rand() * 6) {
    const P = profile(s);
    const q = at(s, P.path + (rand() < 0.5 ? -1 : 1) * (PATH_HALF + 2 + rand() * 4));
    if (!blocked(q.x, q.z, 1.5)) put(rand() < 0.5 + 0.2 * beachPark(s) ? 'palm' : 'casuarina', q.x, q.z, 0.85 + rand() * 0.4);
  }
  for (let s = sSeam; s < L - 30; s += 9 + rand() * 10) {
    const P = profile(s);
    const q = at(s, P.beach + 2 + rand() * 5);
    if (!blocked(q.x, q.z, 1.5)) put('casuarina', q.x, q.z, 0.8 + rand() * 0.5);
  }
  // Groves between path and road (and the wide park behind the road in the
  // beach park), sea almonds near the beach.
  for (let i = 0; i < 9000; i++) {
    const s = sSeam + rand() * (L - sSeam - 20);
    const P = profile(s);
    const d = P.path + 3 + rand() * (P.fence - P.path - 6);
    const q = at(s, d);
    const grove = valueNoise(q.x / 60, q.z / 60, seed + 21);
    if (grove < 0.42 || rand() > 0.2) continue;
    if (blocked(q.x, q.z, 4)) continue;
    put(rand() < 0.62 ? 'rain' : 'almond', q.x, q.z, 0.8 + rand() * 0.5);
  }
  // Shrubs, flowers and grass tufts across the park.
  for (let i = 0; i < 9000; i++) {
    const s = sSeam + rand() * (L - sSeam - 20);
    const P = profile(s);
    const q = at(s, P.beach + 1 + rand() * (P.fence - P.beach - 3));
    if (blocked(q.x, q.z, 1)) continue;
    const r = rand();
    if (r < 0.12) put(rand() < 0.3 ? 'flowers' : 'shrub', q.x, q.z, 0.5 + rand() * 0.7);
    else if (r < 0.5) put('grass', q.x, q.z, 0.7 + rand() * 0.7);
  }
  // Hedge inside the fence, and a deep belt of trees just past the seam that
  // hides where the expressway and the estate stop.
  for (let s = sSeam - 10; s < L; s += 2.4) {
    const P = profile(s);
    const q = at(s, P.fence - 2 - rand());
    if (!blocked(q.x, q.z, 1)) put('shrub', q.x, q.z, 1.1 + rand() * 0.5);
  }
  for (let i = 0; i < 260; i++) {
    const x = seamX + 20 + rand() * 120;
    const z = -80 - rand() * 280;
    if (shape.weight(x, z) > 0.99) put(rand() < 0.7 ? 'rain' : 'casuarina', x, z, 0.9 + rand() * 0.5);
  }
  kit.vegetation(veg);

  // ---------- Furniture: lamps along the road, benches, shelters ----------
  const furniture = new Map<string, THREE.BufferGeometry[]>();
  const addAt = (g: THREE.BufferGeometry, x: number, z: number, rot = 0) => {
    const k = kit.tileKey(x, z);
    if (!furniture.has(k)) furniture.set(k, []);
    furniture.get(k)!.push(g.clone().rotateY(rot).translate(x, heightAt(x, z), z));
  };
  const r0 = road.nearest(seamX + 20, -30, 80)?.s ?? 0;
  for (let s = r0, i = 0; s < road.length; s += 34, i++) {
    const p = road.at(s);
    const side = i % 2 === 0 ? 1 : -1;
    const ang = Math.atan2(-p.tz, p.tx);
    // Left of travel is (tz, -tx).
    addAt(kit.lamp, p.x + p.tz * (ROAD_HALF + 1.2) * side, p.z - p.tx * (ROAD_HALF + 1.2) * side, ang + (side > 0 ? -Math.PI / 2 : Math.PI / 2));
  }
  const p0 = path.nearest(seamX + 20, -5, 120)?.s ?? 0;
  for (let s = p0 + 20; s < path.length - 10; s += 28 + rand() * 34) {
    const p = path.at(s);
    const o = PATH_HALF + 1.2;
    const x = p.x + p.tz * o;
    const z = p.z - p.tx * o;
    if (!blocked(x, z, 0.2)) addAt(kit.bench, x, z, Math.atan2(-p.tz, p.tx));
  }
  const shelters: XZ[] = [];
  for (let s = sSeam + 120; s < L - 60; s += 120 + rand() * 80) {
    const P = profile(s);
    const q = at(s, P.path + 10 + rand() * 8);
    if (blocked(q.x, q.z, 6) || P.road - P.path < 26) continue;
    addAt(kit.shelter, q.x, q.z, rand());
    shelters.push([q.x, q.z]);
    const y = heightAt(q.x, q.z) + 1.3;
    onTile('near', q.x, q.z, (t) => {
      const b = t.body(RAPIER.RigidBodyDesc.fixed().setTranslation(q.x, y, q.z));
      for (const [px, pz] of [[-2.2, -2.2], [2.2, -2.2], [-2.2, 2.2], [2.2, 2.2]])
        world.createCollider(RAPIER.ColliderDesc.cylinder(1.3, 0.15).setTranslation(px, 0, pz), b);
    });
  }
  for (const [k, parts] of furniture) {
    const c = kit.tileCentre(k);
    onTile('near', c.x, c.z, (t) => {
      const m = new THREE.Mesh(t.own(mergeGeometries(parts)), kit.plainMat);
      m.castShadow = m.receiveShadow = true;
      t.add(m);
    });
  }

  // ---------- Beach park carparks, with parked cars ----------
  const dummy = new THREE.Object3D();
  for (const l of lots) {
    const rot = Math.atan2(-l.tz, l.tx);
    const lot = new THREE.Mesh(new THREE.PlaneGeometry(l.hw * 2, l.hd * 2).rotateX(-Math.PI / 2), kit.lotMat);
    lot.position.set(l.cx, H + 0.14, l.cz);
    lot.rotation.y = rot;
    lot.receiveShadow = true;
    const lines: THREE.BufferGeometry[] = [];
    const spots: { x: number; z: number; r: number; color: THREE.Color }[] = [];
    for (let u = -l.hw + 2; u < l.hw - 2; u += 2.6)
      for (const v of [-l.hd + 3, l.hd - 3]) {
        lines.push(new THREE.PlaneGeometry(0.12, 5).rotateX(-Math.PI / 2).translate(u, 0.03, v));
        if (rand() < 0.5 && u + 1.3 < l.hw - 2) {
          const x = l.cx + (u + 1.3) * l.tx + v * l.tz;
          const z = l.cz + (u + 1.3) * l.tz - v * l.tx;
          spots.push({ x, z, r: rot + Math.PI / 2 + (rand() - 0.5) * 0.06, color: new THREE.Color(kit.carColors[Math.floor(rand() * kit.carColors.length)]) });
        }
      }
    const bays = new THREE.Mesh(mergeGeometries(lines), new THREE.MeshBasicMaterial({ color: 0xeeeeee }));
    bays.position.copy(lot.position);
    bays.rotation.y = rot;
    onTile('far', l.cx, l.cz, (t) => {
      t.add(lot);
      t.add(bays);
    });
    onTile('near', l.cx, l.cz, (t) => {
      const cars = new THREE.InstancedMesh(kit.carGeo, kit.carMat, spots.length);
      const b = t.body();
      spots.forEach((p, i) => {
        dummy.position.set(p.x, H + 0.14, p.z);
        dummy.rotation.set(0, p.r, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        cars.setMatrixAt(i, dummy.matrix);
        cars.setColorAt(i, p.color);
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(2.1, 0.75, 0.88).setTranslation(p.x, H + 0.9, p.z).setRotation({ x: 0, y: Math.sin(p.r / 2), z: 0, w: Math.cos(p.r / 2) }),
          b,
        );
      });
      cars.castShadow = true;
      cars.computeBoundingSphere();
      t.add(cars);
    });
  }

  // ---------- The airport: runway, lights, a control tower ----------
  {
    const [ax, az] = RUNWAY.a;
    const [bx, bz] = RUNWAY.b;
    const len = Math.hypot(bx - ax, bz - az);
    const tx = (bx - ax) / len;
    const tz = (bz - az) / len;
    const rot = Math.atan2(-tz, tx);
    const y = H + 0.24;
    const g: THREE.BufferGeometry[] = [];
    g.push(tint(new THREE.PlaneGeometry(len, RUNWAY.half * 2).rotateX(-Math.PI / 2), 0x55575b));
    for (let u = -len / 2 + 60; u < len / 2 - 60; u += 30) g.push(tint(new THREE.PlaneGeometry(14, 0.9).rotateX(-Math.PI / 2).translate(u, 0.02, 0), 0xf2efe4));
    for (const e of [-1, 1])
      for (let v = -RUNWAY.half + 3; v < RUNWAY.half - 2; v += 3.2)
        g.push(tint(new THREE.PlaneGeometry(22, 1.6).rotateX(-Math.PI / 2).translate(e * (len / 2 - 20), 0.02, v + 0.8), 0xf2efe4));
    for (const v of [-RUNWAY.half + 0.6, RUNWAY.half - 0.6]) g.push(tint(new THREE.PlaneGeometry(len - 10, 0.5).rotateX(-Math.PI / 2).translate(0, 0.02, v), 0xf2efe4));
    const strip = new THREE.Mesh(merge(g), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 }));
    strip.position.set((ax + bx) / 2, y, (az + bz) / 2);
    strip.rotation.y = rot;
    strip.receiveShadow = true;
    scene.add(strip);
    // Edge and approach lights (warm, faintly glowing).
    const lights: THREE.BufferGeometry[] = [];
    for (let u = -len / 2; u <= len / 2; u += 40)
      for (const v of [-RUNWAY.half - 1.5, RUNWAY.half + 1.5]) lights.push(new THREE.BoxGeometry(0.4, 0.5, 0.4).translate(u, 0.25, v));
    for (let u = 20; u < 320; u += 24) {
      lights.push(new THREE.BoxGeometry(0.3, 2.2, 0.3).translate(-len / 2 - u, 1.1, 0));
      lights.push(new THREE.BoxGeometry(0.5, 0.3, 9).translate(-len / 2 - u, 2.2, 0));
    }
    const lm = new THREE.Mesh(mergeGeometries(lights), new THREE.MeshStandardMaterial({ color: 0xfff1c9, emissive: 0x8a6d2c, roughness: 0.5 }));
    lm.position.copy(strip.position);
    lm.rotation.y = rot;
    scene.add(lm);
    // A generic control tower: shaft, flared cab, dark glass, mast.
    const [tx0, tz0] = TOWER;
    const tower = merge([
      tint(new THREE.CylinderGeometry(3.2, 4.2, 52, 10).translate(0, 26, 0), 0xe6e2d8),
      tint(new THREE.CylinderGeometry(9, 5, 4, 12).translate(0, 54, 0), 0xe6e2d8),
      tint(new THREE.CylinderGeometry(9.4, 8.4, 6, 12).translate(0, 59, 0), 0x22323e),
      tint(new THREE.CylinderGeometry(10, 10, 1.2, 12).translate(0, 62.6, 0), 0xd4d0c6),
      tint(new THREE.CylinderGeometry(0.3, 0.3, 10, 6).translate(0, 68, 0), 0xb8443a),
      tint(new THREE.BoxGeometry(30, 12, 22).translate(14, 6, 0), 0xd8d4ca),
    ]);
    // Hangars and terminal blocks, so the airfield has a skyline. Each spot
    // is checked to sit well inside the fence and clear of the runway.
    const blocks: THREE.BufferGeometry[] = [];
    const brand = mulberry32(seed + 77);
    const runwayDist = (x: number, z: number) => {
      const [ax, az] = RUNWAY.a;
      const [bx, bz] = RUNWAY.b;
      const len = Math.hypot(bx - ax, bz - az);
      const u = clamp01(((x - ax) * (bx - ax) + (z - az) * (bz - az)) / (len * len));
      return Math.hypot(ax + (bx - ax) * u - x, az + (bz - az) * u - z);
    };
    const inside = (x: number, z: number, r: number) => {
      const n = coast.nearest(x, z, 300);
      if (n && n.sd < profile(n.s).fence + r + 30) return false;
      return shape.isLand(x, z) && runwayDist(x, z) > RUNWAY.half + r + 40;
    };
    const taken: [number, number, number][] = [];
    const bRot = Math.atan2(-(RUNWAY.b[1] - RUNWAY.a[1]), RUNWAY.b[0] - RUNWAY.a[0]);
    const place = (g: THREE.BufferGeometry, x: number, z: number) => blocks.push(g.rotateY(bRot).translate(x, 0, z));
    for (let tries = 0; tries < 200 && taken.length < 10; tries++) {
      const w = 60 + brand() * 90;
      const d = 30 + brand() * 40;
      const h = 10 + brand() * 16;
      const x = TOWER[0] + (brand() - 0.5) * 900;
      const z = TOWER[1] + (brand() - 0.5) * 900;
      const r = Math.hypot(w, d) / 2;
      if (!inside(x, z, r) || taken.some(([tx, tz, tr]) => Math.hypot(tx - x, tz - z) < tr + r + 20) || Math.hypot(x - TOWER[0], z - TOWER[1]) < r + 30) continue;
      taken.push([x, z, r]);
      const col = [0xd8d4ca, 0xc9ccd1, 0xe6e2d8, 0xb9c4cc][taken.length % 4];
      place(tint(new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), col), x, z);
      if (taken.length % 3 === 0) place(tint(new THREE.CylinderGeometry(d / 2, d / 2, w, 10, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).scale(1, 0.5, 1).translate(0, h, 0), 0x9aa3a8), x, z);
      else place(tint(new THREE.BoxGeometry(w + 1, 1, d + 1).translate(0, h + 0.5, 0), 0x7d868c), x, z);
    }
    const bm = new THREE.Mesh(merge(blocks), kit.plainMat);
    bm.position.y = H + 0.2;
    bm.castShadow = true;
    scene.add(bm);
    const tm = new THREE.Mesh(tower, kit.plainMat);
    tm.position.set(tx0, H + 0.2, tz0);
    tm.castShadow = true;
    scene.add(tm);
  }

  // ---------- Planes landing ----------
  // One at a time: in low over the sea and the end of East Coast Park,
  // touch down, roll out, and disappear into the airport.
  const plane = (() => {
    const white = 0xf3f4f6;
    const g = merge([
      tint(new THREE.CylinderGeometry(2.1, 2.1, 36, 12).rotateZ(Math.PI / 2), white),
      tint(new THREE.ConeGeometry(2.1, 6, 12).rotateZ(-Math.PI / 2).translate(21, 0, 0), white),
      tint(new THREE.ConeGeometry(2.1, 9, 12).rotateZ(Math.PI / 2).translate(-22.5, 0.6, 0), white),
      tint(new THREE.BoxGeometry(9, 0.5, 40).translate(1, -0.8, 0), 0xd9dde2),
      tint(new THREE.BoxGeometry(5, 0.35, 13).translate(-23, 1.2, 0), 0xd9dde2),
      tint(new THREE.BoxGeometry(6, 8, 0.5).translate(-23, 5, 0), 0x2f5d8a),
      tint(new THREE.CylinderGeometry(1.1, 1.1, 4.5, 10).rotateZ(Math.PI / 2).translate(3, -2.2, -7), 0xc9ccd1),
      tint(new THREE.CylinderGeometry(1.1, 1.1, 4.5, 10).rotateZ(Math.PI / 2).translate(3, -2.2, 7), 0xc9ccd1),
      tint(new THREE.BoxGeometry(6, 1, 4.25).translate(15, 0.9, 0), 0x22323e),
    ]);
    const m = new THREE.Mesh(g, kit.plainMat);
    m.castShadow = true;
    m.visible = false;
    scene.add(m);
    return m;
  })();
  const [rax, raz] = RUNWAY.a;
  const [rbx, rbz] = RUNWAY.b;
  const rLen = Math.hypot(rbx - rax, rbz - raz);
  const rdx = (rbx - rax) / rLen;
  const rdz = (rbz - raz) / rLen;
  const planeYaw = Math.atan2(-rdz, rdx);
  let planeT = -20; // seconds into the current approach (negative = waiting)
  const APPROACH = 1900; // metres out where a plane appears
  const updatePlane = (dt: number) => {
    planeT += dt;
    if (planeT < 0) {
      plane.visible = false;
      return;
    }
    // Distance from the threshold: approach at 75 m/s, slowing on the ground.
    const tTouch = APPROACH / 75;
    let u: number;
    let alt: number;
    if (planeT < tTouch) {
      u = -APPROACH + planeT * 75;
      alt = -u * Math.tan(0.055) + 2.2;
      alt = Math.max(2.2, alt);
    } else {
      const t = planeT - tTouch;
      u = 75 * t - 3.2 * t * t;
      alt = 2.2;
      if (75 - 6.4 * t < 12 || u > rLen - 80) {
        planeT = -(45 + Math.random() * 50);
        plane.visible = false;
        return;
      }
    }
    plane.visible = true;
    plane.position.set(rax + rdx * u, H + alt + 0.4, raz + rdz * u);
    const pitch = planeT < tTouch ? 0.05 : 0.02;
    plane.rotation.set(0, planeYaw, pitch, 'YXZ');
  };

  // ---------- Traffic: a few cars along the coast road ----------
  const side = (k: number) => {
    const out: THREE.Vector3[] = [];
    for (let s = r0; s < road.length - 5; s += 6) {
      const p = road.at(s);
      const x = p.x + p.tz * k;
      const z = p.z - p.tx * k;
      out.push(new THREE.Vector3(x, heightAt(x, z) + 0.05, z));
    }
    return out;
  };
  // Drive on the left: going along the road (north-east) keep left (+).
  const loop = [...side(1.8), ...side(-1.8).reverse()];
  loop.push(loop[0].clone());
  const lanes: Lane[] = [{ pts: loop, speed: 9, cars: 4, local: true }];

  // ---------- Map ----------
  const coastXZ = coast.pts.filter((_, i) => i % 4 === 0);
  const beachTop = offsetLine(shape, (p) => p.beach);
  const fenceXZ = fence.sample(4);
  const map: Partial<MapData> = {
    areas: [
      // Sea north and east of the coast (the land polygon's complement).
      { pts: [...coastXZ, [coastXZ[coastXZ.length - 1][0], -1500], [-1100, -1520], [-1100, -2400], [2800, -2400], [2800, 600], [coastXZ[0][0], 600]], color: '#5aa3b0' },
      { pts: [...coastXZ, ...beachTop.reverse()], color: '#ead9a8' },
      { pts: [...fenceXZ, [-1100, -1500], [-1100, -380], [fenceXZ[0][0], -380]], color: '#a3c486' },
      { pts: rectAlong(RUNWAY.a, RUNWAY.b, RUNWAY.half), color: '#8c8d90' },
      ...lots.map((l) => ({ pts: lotPts(l), color: '#9a9b9e' })),
      ...shelters.map(([x, z]) => ({ pts: [[x - 3, z - 3], [x + 3, z - 3], [x + 3, z + 3], [x - 3, z + 3]] as XZ[], color: '#b0644a' })),
    ],
    lines: [
      { pts: afterSeam(road.pts, seamX).filter((_, i) => i % 2 === 0), width: 7, color: '#f4f1ea' },
      { pts: afterSeam(path.pts, seamX).filter((_, i) => i % 5 === 0), width: 3, color: '#c27a66' },
    ],
    pois: [
      { ...at(sSeam + 700, profile(sSeam + 700).road + 40), label: 'Changi Coast Road' },
      { x: TOWER[0], z: TOWER[1], label: 'Changi Airport' },
      { ...at(sBeach + 500, profile(sBeach + 500).path), label: 'Changi Beach Park' },
      ...lots.map((l) => ({ x: l.cx, z: l.cz, label: 'P' })),
    ],
  };

  return {
    map,
    lanes,
    update(dt: number) {
      updatePlane(dt);
    },
  };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function offsetLine(shape: ChangiShape, pick: (p: { beach: number; path: number; road: number; fence: number }) => number): XZ[] {
  const out: XZ[] = [];
  for (let s = 0; s <= shape.L; s += 20) {
    const p = shape.coast.at(s);
    const o = pick(shape.profile(s));
    out.push([p.x + p.tz * o, p.z - p.tx * o]);
  }
  return out;
}

function rectAlong(a: XZ, b: XZ, half: number): XZ[] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const nx = -(b[1] - a[1]) / len;
  const nz = (b[0] - a[0]) / len;
  return [
    [a[0] + nx * half, a[1] + nz * half],
    [b[0] + nx * half, b[1] + nz * half],
    [b[0] - nx * half, b[1] - nz * half],
    [a[0] - nx * half, a[1] - nz * half],
  ];
}

function lotPts(l: { cx: number; cz: number; tx: number; tz: number; hw: number; hd: number }): XZ[] {
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([a, b]) => [l.cx + a * l.hw * l.tx + b * l.hd * l.tz, l.cz + a * l.hw * l.tz - b * l.hd * l.tx] as XZ);
}

