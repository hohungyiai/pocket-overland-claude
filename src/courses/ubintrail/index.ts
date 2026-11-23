import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, mulberry32, smoothstep, valueNoise } from '../../noise';
import { TILE, TileStreamer, type TileKit } from '../../world/stream';
import * as D from '../detail';
import type { ArtStyle } from '../detail';
import { SURFACES, type Course, type MapData, type Surface, type XZ } from '../types';
import { fill, MASK, UbinGround, type UbinMap } from './ground';
import { UbinTrail, type TrailDef } from './trail';
import { KETAM } from './trails';

type Rapier = typeof RAPIER_NS;

// Pulau Ubin: the first off-road trail. The island is built from the
// OpenStreetMap outlines (coast, quarries, ponds, mangrove, beaches, every
// lane and track, the kampong houses), in tiles that stream in around the
// car like the mainland map. The route and its three obstacles are in
// trail.ts; the ground in ground.ts.

export const UBIN_MAP = 'maps/ubin.json';
const SEED = 1965;
const NEAR_STEP = 2; // metres between ground points (1 m on obstacle tiles)

const LANE: Surface = { name: 'Lane', grip: 0.98, drag: 0.8 };
const TRACK: Surface = { name: 'Dirt track', grip: 0.82, drag: 1.8, offroad: true };
// The signposted ways round: an easy, well-worn track (a road as far as
// the car is concerned: the diff does not matter on it).
const WAY: Surface = { name: 'Way round', grip: 0.85, drag: 1.6 };
const FOREST: Surface = { name: 'Forest floor', grip: 0.72, drag: 3.5, offroad: true };
// (Ubin's own copies of the shared beach, wetland and grass: off the road,
// so the diff and soft ground work as they do on the trails.)
const BEACH: Surface = { ...SURFACES.sand, offroad: true, sink: 0.08 };
const MUD: Surface = { ...SURFACES.mud, offroad: true, sink: 0.12 };
const GRASS: Surface = { ...SURFACES.grass, offroad: true };

interface Tree {
  x: number;
  z: number;
  y: number;
  s: number;
  r: number;
  kind: 'rain' | 'almond' | 'palm' | 'casuarina' | 'mangrove' | 'shrub';
}

export async function buildUbinTrailCourse(scene: THREE.Scene, world: RAPIER_NS.World, RAPIER: Rapier, opts: { style?: ArtStyle } = {}, def: TrailDef = KETAM): Promise<Course> {
  const detailed = opts.style !== 'stylized';
  const map: UbinMap = await (await fetch(UBIN_MAP)).json();
  const trail = new UbinTrail(map, def);
  // Paths the trail (or its detour) follows are driven: a track's width.
  for (const r of map.roads) {
    if (r.kind !== 'path' || r.pts.length < 2) continue;
    const on = (l: { nearest(x: number, z: number, r: number): { d: number } | null } | null) => !!l && r.pts.every(([x, z]) => (l.nearest(x, z, 6)?.d ?? 99) < 2);
    if (on(trail.route) || on(trail.detour)) Object.assign(r, { kind: 'track', width: 3.4 });
  }
  // The ways round the obstacles are tracks too (for the ground and the
  // map). (A hidden detour is on the map's own tracks and paths already.)
  if (def.wayRound === 'gate')
    trail.obstacles.forEach((o, i) => {
      if (o.gate) map.roads.push({ id: -1 - i, name: 'Way round', kind: 'track', hw: 'track', surface: 'dirt', width: 3.2, nodes: [], pts: o.bypass.pts });
    });
  const ground = new UbinGround(map);
  ground.shape = (x, z) => trail.shape(x, z);
  trail.base = (x, z) => ground.baseAt(x, z);
  const B = map.bounds;
  const heightAt = (x: number, z: number) => ground.heightAt(x, z);

  // Building footprints, for keeping trees off them.
  const houses = new Uint8Array(ground.w * ground.h);
  for (const b of map.buildings) fill(ground.w, ground.h, ground.x0, ground.z0, ground.cell, b.pts, (k) => (houses[k] = 1));

  // ---------- Surfaces ----------
  function surfaceAt(x: number, z: number, y: number): Surface {
    const lvl = ground.waterAt(x, z);
    if (lvl !== null && y < lvl - 0.05) return SURFACES.water;
    if (!ground.isLand(x, z) && y < 0.15) return SURFACES.water;
    const o = trail.surface(x, z);
    if (o) return o;
    const r = ground.road(x, z, 6);
    if (r && r.d < r.half + 0.4) {
      const kind = map.roads[r.road].kind;
      return kind === 'lane' ? LANE : map.roads[r.road].name === 'Way round' ? WAY : TRACK;
    }
    const m = ground.maskAt(x, z);
    if (m & MASK.beach) return BEACH;
    if (m & MASK.wetland) return MUD;
    return valueNoise(x / 20, z / 20, SEED + 3) > 0.55 ? FOREST : GRASS;
  }

  // ---------- Colours ----------
  const C = {
    grass: new THREE.Color(0.25, 0.45, 0.16),
    lush: new THREE.Color(0.17, 0.36, 0.12),
    forest: new THREE.Color(0.24, 0.27, 0.13),
    dirt: new THREE.Color(0.5, 0.36, 0.22),
    path: new THREE.Color(0.55, 0.45, 0.32),
    lane: new THREE.Color(0.55, 0.55, 0.52),
    sand: new THREE.Color(0.9, 0.82, 0.62),
    mud: new THREE.Color(0.3, 0.27, 0.18),
    wetMud: new THREE.Color(0.17, 0.13, 0.08),
    puddle: new THREE.Color(0.1, 0.1, 0.08),
    rock: new THREE.Color(0.55, 0.53, 0.5),
    gravel: new THREE.Color(0.4, 0.35, 0.28),
    bed: new THREE.Color(0.4, 0.38, 0.3),
    sea: new THREE.Color(0.42, 0.47, 0.4),
    laterite: new THREE.Color(0.6, 0.3, 0.16),
    granite: new THREE.Color(0.6, 0.58, 0.55),
  };
  const col = new THREE.Color();
  function colorAt(x: number, z: number, y: number, out: THREE.Color) {
    const shore = ground.shore.at(x, z);
    if (shore < -1) return out.copy(C.sea);
    const m = ground.maskAt(x, z);
    const n = valueNoise(x / 9, z / 9, SEED + 5);
    out.copy(C.grass).lerp(C.lush, n);
    if (m & MASK.wood || valueNoise(x / 60, z / 60, SEED + 8) > 0.5) out.lerp(C.forest, 0.35 + 0.3 * valueNoise(x / 5, z / 5, SEED + 6));
    if (m & MASK.wetland) out.lerp(C.mud, 0.6);
    const lvl = ground.waterAt(x, z);
    if (lvl !== null || ground.wet.at(x, z) > -2.5) out.copy(ground.deep[ground.wetId[ground.cellAt(x, z)]] ? C.rock : C.bed);
    if (m & MASK.beach || (shore < 6 && y < 1.4)) out.lerp(C.sand, m & MASK.beach ? 1 : 0.7);
    const r = ground.road(x, z, 6);
    if (r) {
      const kind = map.roads[r.road].kind;
      const edge = 1 - smoothstep(r.half - 0.6, r.half + 0.8, r.d);
      if (kind === 'track') out.lerp(C.dirt, edge * (0.85 + 0.15 * valueNoise(x / 1.7, z / 1.7, SEED)));
      else if (kind === 'path') out.lerp(C.path, edge * 0.8);
      else out.lerp(C.lane, edge);
    }
    const o = trail.surface(x, z);
    if (o) {
      if (/mud|ford|slick|bog/i.test(o.name)) {
        // Wet, dark mud, with darker puddles in the ruts.
        out.lerp(C.wetMud, 0.92);
        if (valueNoise(x / 2.2, z / 2.2, SEED + 11) > 0.62) out.lerp(C.puddle, 0.6);
      } else if (/laterite/i.test(o.name)) {
        // Red laterite clay, darker where it is worn low.
        out.lerp(C.laterite, 0.85);
        if (valueNoise(x / 1.6, z / 1.6, SEED + 12) > 0.6) out.lerp(C.dirt, 0.4);
      } else if (/granite/i.test(o.name)) out.lerp(C.granite, 0.8 + 0.15 * valueNoise(x / 1.3, z / 1.3, SEED + 13));
      else out.lerp(/sand/i.test(o.name) ? C.sand : /rock|ledge|gravel/i.test(o.name) ? C.gravel : C.dirt, 0.75);
    }
    return out;
  }

  // ---------- Ground tiles ----------
  const groundMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  const DETAIL_M = 2.5;
  if (detailed) {
    const tex = D.groundDetailTexture();
    groundMat.map = tex;
    groundMat.bumpMap = tex;
    groundMat.bumpScale = 1.6;
    groundMat.color.setScalar(0.82);
    D.patchGroundMaterial(groundMat, true);
  }
  // Tiles with an obstacle get a finer ground (the washout's humps).
  const fineTile = new Set<string>();
  for (const o of trail.obstacles)
    for (const [x, z] of o.line.pts.concat(o.bypass.pts))
      for (const dx of [-20, 0, 20])
        for (const dz of [-20, 0, 20]) fineTile.add(`${Math.floor((x + dx) / TILE)},${Math.floor((z + dz) / TILE)}`);
  // Tiles under a fine strip (see trail.fineStrips()).
  const fineTiles = new Set<string>();
  for (const { o, a, b } of trail.fineStrips())
    for (let s = a - 8; s <= b + 8; s += 4) {
      const a = trail.fineAt(o, s, 0);
      for (const dx of [-14, 0, 14]) for (const dz of [-14, 0, 14]) fineTiles.add(`${Math.floor((a.x + dx) / TILE)},${Math.floor((a.z + dz) / TILE)}`);
    }
  interface Patch {
    w: number;
    h: number;
    step: number;
    pos: Float32Array;
    clr: Float32Array;
    uvs: Float32Array;
  }
  const patches = new Map<string, Patch>();
  function* patch(ti: number, tj: number, step: number, colours: boolean): Generator<void, Patch | null, void> {
    const x0 = Math.max(B.minX, ti * TILE);
    const x1 = Math.min(B.maxX, (ti + 1) * TILE);
    const z0 = Math.max(B.minZ, tj * TILE);
    const z1 = Math.min(B.maxZ, (tj + 1) * TILE);
    if (x1 <= x0 || z1 <= z0) return null;
    const w = Math.round((x1 - x0) / step) + 1;
    const h = Math.round((z1 - z0) / step) + 1;
    const pos = new Float32Array(w * h * 3);
    const clr = new Float32Array(w * h * 3);
    const uvs = new Float32Array(w * h * 2);
    let top = -Infinity;
    let t0 = performance.now();
    // (Not the far-off horizon's ground: its points are 10 m apart, too
    // coarse to sink under a strip without dragging the land around down.)
    const sunk = step <= NEAR_STEP && fineTiles.has(`${ti},${tj}`);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const x = x0 + i * step;
        const z = z0 + j * step;
        // (Under a fine strip's middle the tile's ground is sunk: the strip is the ground there.)
        const y = heightAt(x, z) - (sunk && trail.fineCore(x, z) ? 3 : 0);
        top = Math.max(top, y);
        const k = j * w + i;
        pos[k * 3] = x;
        pos[k * 3 + 1] = y;
        pos[k * 3 + 2] = z;
        uvs[k * 2] = x / DETAIL_M;
        uvs[k * 2 + 1] = z / DETAIL_M;
        if (colours) {
          colorAt(x, z, y, col);
          const v = 0.9 + 0.2 * valueNoise(x / 3.3, z / 3.3, SEED + 11);
          clr[k * 3] = col.r * v;
          clr[k * 3 + 1] = col.g * v;
          clr[k * 3 + 2] = col.b * v;
        }
      }
      if (performance.now() - t0 > 4) {
        yield;
        t0 = performance.now();
      }
    }
    if (top < -3) return null;
    return { w, h, step, pos, clr, uvs };
  }
  const gridIdx = (w: number, h: number) => {
    const idx = new Uint32Array((w - 1) * (h - 1) * 6);
    let q = 0;
    for (let j = 0; j < h - 1; j++)
      for (let i = 0; i < w - 1; i++) {
        const a = j * w + i;
        idx.set([a, a + w, a + 1, a + 1, a + w, a + w + 1], q);
        q += 6;
      }
    return idx;
  };
  const groundMesh = (p: Patch, kit: TileKit, coverable: boolean) => {
    const geo = kit.own(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(p.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(p.clr, 3));
    if (detailed) geo.setAttribute('uv', new THREE.BufferAttribute(p.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(gridIdx(p.w, p.h), 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, groundMat);
    mesh.receiveShadow = !coverable;
    kit.add(mesh, coverable);
  };

  // ---------- Lanes: a concrete ribbon on the ground ----------
  const laneMat = new THREE.MeshStandardMaterial({ color: detailed ? 0xb9b6ae : 0xa9a69e, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  if (detailed) {
    const t = D.asphaltTexture();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    laneMat.map = t;
  }
  const lanes = map.roads
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.kind === 'lane')
    .map(({ r, i }) => {
      // Resample every 2 m.
      const pts: XZ[] = [r.pts[0]];
      for (let k = 1; k < r.pts.length; k++) {
        const [ax, az] = r.pts[k - 1];
        const [bx, bz] = r.pts[k];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 2));
        for (let m = 1; m <= n; m++) pts.push([ax + ((bx - ax) * m) / n, az + ((bz - az) * m) / n]);
      }
      return { i, half: r.width / 2, pts };
    });
  function laneRibbons(ti: number, tj: number, kit: TileKit) {
    const P: number[] = [];
    const U: number[] = [];
    const I: number[] = [];
    for (const l of lanes) {
      let run = -1;
      let v = 0;
      for (let k = 0; k < l.pts.length; k++) {
        const [x, z] = l.pts[k];
        const prev = l.pts[Math.max(0, k - 1)];
        const next = l.pts[Math.min(l.pts.length - 1, k + 1)];
        const mid = k > 0 ? [(x + prev[0]) / 2, (z + prev[1]) / 2] : [x, z];
        const inTile = Math.floor(mid[0] / TILE) === ti && Math.floor(mid[1] / TILE) === tj;
        const nextIn = k + 1 < l.pts.length && Math.floor((x + next[0]) / 2 / TILE) === ti && Math.floor((z + next[1]) / 2 / TILE) === tj;
        if (!inTile && !nextIn) {
          run = -1;
          continue;
        }
        let tx = next[0] - prev[0];
        let tz = next[1] - prev[1];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        if (k > 0) v += Math.hypot(x - prev[0], z - prev[1]) / 4;
        const base = P.length / 3;
        for (const side of [-1, 1]) {
          const ex = x - tz * l.half * side;
          const ez = z + tx * l.half * side;
          P.push(ex, heightAt(ex, ez) + 0.035, ez);
          U.push(side > 0 ? l.half / 2 : 0, v);
        }
        if (run >= 0) I.push(run, base, run + 1, run + 1, base, base + 1);
        run = base;
      }
    }
    if (!I.length) return;
    const geo = kit.own(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    geo.setIndex(I);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, laneMat);
    m.receiveShadow = true;
    kit.add(m);
  }

  // ---------- Trees ----------
  const treeCache = new Map<string, Tree[]>();
  const nearHouse = (x: number, z: number) => {
    for (const [dx, dz] of [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4]]) if (houses[ground.cellAt(x + dx, z + dz)]) return true;
    return false;
  };
  function treesIn(ti: number, tj: number): Tree[] {
    const key = `${ti},${tj}`;
    const have = treeCache.get(key);
    if (have) return have;
    const rand = mulberry32(SEED + ti * 7919 + tj * 104729);
    const out: Tree[] = [];
    const G = 6;
    for (let gx = 0; gx < TILE; gx += G)
      for (let gz = 0; gz < TILE; gz += G) {
        const x = ti * TILE + gx + rand() * G;
        const z = tj * TILE + gz + rand() * G;
        const r1 = rand();
        const r2 = rand();
        const r3 = rand();
        if (x < B.minX || x > B.maxX || z < B.minZ || z > B.maxZ) continue;
        const shore = ground.shore.at(x, z);
        if (shore < 2) continue;
        if (ground.wet.at(x, z) > -2) continue;
        const m = ground.maskAt(x, z);
        const wild = valueNoise(x / 45, z / 45, SEED + 12);
        let p = m & MASK.wood ? 0.85 : 0.45 + 0.45 * wild;
        if (m & MASK.beach) p = 0.08;
        if (r1 > p) continue;
        const rd = ground.road(x, z, 9);
        if (rd && rd.d < rd.half + (map.roads[rd.road].kind === 'path' ? 1.2 : 2.6)) continue;
        if (nearHouse(x, z)) continue;
        if (trail.obstacles.some((o) => (o.line.nearest(x, z, 8)?.d ?? 99) < 6)) continue;
        const y = heightAt(x, z);
        let kind: Tree['kind'];
        if (m & MASK.wetland) kind = r2 < 0.85 ? 'mangrove' : 'shrub';
        else if (shore < 40 && r2 < 0.45) kind = r3 < 0.5 ? 'casuarina' : 'palm';
        else if (r2 < 0.36) kind = 'shrub';
        else if (r2 < 0.62) kind = 'rain';
        else if (r2 < 0.9) kind = 'almond';
        else kind = 'palm';
        out.push({ x, z, y, s: 0.75 + r3 * 0.6, r: rand() * Math.PI * 2, kind });
      }
    treeCache.set(key, out);
    if (treeCache.size > 80) treeCache.delete(treeCache.keys().next().value!);
    return out;
  }
  const wind = { value: 0 };
  const tint = (g: THREE.BufferGeometry, c: number) => {
    const g2 = g.index ? g.toNonIndexed() : g;
    const color = new THREE.Color(c);
    const arr = new Float32Array(g2.attributes.position.count * 3);
    for (let i = 0; i < arr.length; i += 3) color.toArray(arr, i);
    g2.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    g2.deleteAttribute('uv');
    return g2;
  };
  const merge = (parts: THREE.BufferGeometry[]) => {
    const g = mergeGeometries(parts)!;
    g.computeVertexNormals();
    return g;
  };
  const swayMat = (strength: number) => {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
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
         transformed.x += sin(uTime * 1.5 + ip.x * 0.11 + ip.z * 0.07) * ${strength.toFixed(4)} * hgt;
         transformed.z += cos(uTime * 1.1 + ip.x * 0.05) * ${(strength * 0.6).toFixed(4)} * hgt;`,
      );
    };
    return m;
  };
  const trunk = (h: number, r0: number, r1: number) => tint(new THREE.CylinderGeometry(r1, r0, h, 5, 1, true).translate(0, h / 2, 0), 0x7a6450);
  // Two levels of detail: rounder crowns near the car, plainer ones (a
  // quarter of the triangles) further off, where the haze softens them.
  type Kinds = Record<Tree['kind'], { geo: THREE.BufferGeometry; mat: THREE.Material; hues: [number, number, number, number]; collide: number }>;
  const mats = { broad: swayMat(0.01), palm: swayMat(0.02), cas: swayMat(0.015), mangrove: swayMat(0.012), shrub: swayMat(0.02) };
  const makeKinds = (detail: number): Kinds => {
    const crown = (r: number, sy: number, x: number, y: number, z: number) => tint(new THREE.IcosahedronGeometry(1, detail).scale(r, sy, r).translate(x, y, z), 0xffffff);
    return {
      rain: { geo: merge([trunk(4.2, 0.45, 0.3), crown(4.8, 2.2, 0, 5.6, 0), crown(3.2, 1.8, 1.9, 6.6, 0.9)]), mat: mats.broad, hues: [0.27, 0.42, 0.3, 0.05], collide: 0.45 },
      almond: { geo: merge([trunk(5, 0.35, 0.22), crown(3.4, 1.0, 0, 4.4, 0), crown(2.2, 1.0, 0, 5.8, 0)]), mat: mats.broad, hues: [0.25, 0.45, 0.33, 0.06], collide: 0.35 },
      palm: {
        geo: merge([
          tint(new THREE.CylinderGeometry(0.18, 0.28, 8, 5, 1, true).translate(0, 4, 0), 0x8a7356),
          ...Array.from({ length: 7 }, (_, i) =>
            tint(new THREE.BoxGeometry(3.4, 0.08, 0.7).translate(1.7, 0, 0).rotateZ(-0.45).rotateY((i / 7) * Math.PI * 2 + 0.2).translate(0, 8, 0), 0xffffff),
          ),
        ]),
        mat: mats.palm,
        hues: [0.22, 0.5, 0.36, 0.04],
        collide: 0.3,
      },
      casuarina: { geo: merge([trunk(3, 0.3, 0.15), tint(new THREE.ConeGeometry(1.9, 9, 6, 1, true).translate(0, 7, 0), 0xffffff)]), mat: mats.cas, hues: [0.3, 0.35, 0.28, 0.03], collide: 0.3 },
      mangrove: { geo: merge([trunk(1.6, 0.25, 0.18), crown(2.8, 1.6, 0, 2.8, 0)]), mat: mats.mangrove, hues: [0.28, 0.4, 0.24, 0.04], collide: 0.3 },
      shrub: { geo: tint(new THREE.IcosahedronGeometry(1, detail).scale(1.6, 1.1, 1.6).translate(0, 0.7, 0), 0xffffff), mat: mats.shrub, hues: [0.27, 0.45, 0.28, 0.06], collide: 0 },
    };
  };
  const KINDS = makeKinds(1);
  const KINDS_FAR = makeKinds(0);
  const dummy = new THREE.Object3D();
  const tcol = new THREE.Color();
  const lods: { hi: THREE.Object3D[]; lo: THREE.Object3D[]; x: number; z: number }[] = [];
  function treeMeshes(ti: number, tj: number, kit: TileKit) {
    const list = treesIn(ti, tj);
    const rand = mulberry32(SEED + 31 + ti * 131 + tj * 977);
    const lod = { hi: [] as THREE.Object3D[], lo: [] as THREE.Object3D[], x: (ti + 0.5) * TILE, z: (tj + 0.5) * TILE };
    for (const name of Object.keys(KINDS) as Tree['kind'][]) {
      const these = list.filter((t) => t.kind === name);
      if (!these.length) continue;
      const k = KINDS[name];
      const im = new THREE.InstancedMesh(k.geo, k.mat, these.length);
      these.forEach((t, n) => {
        dummy.position.set(t.x, t.y - 0.1, t.z);
        dummy.rotation.set(0, t.r, 0);
        dummy.scale.setScalar(t.s);
        dummy.updateMatrix();
        im.setMatrixAt(n, dummy.matrix);
        const [h, s, l, j] = k.hues;
        tcol.setHSL(h + (rand() - 0.5) * j * 2, s + (rand() - 0.5) * 0.15, l + (rand() - 0.5) * 0.12);
        im.setColorAt(n, tcol);
      });
      im.castShadow = name !== 'shrub';
      im.receiveShadow = true;
      im.computeBoundingSphere();
      kit.add(im);
      // The far copy shares the same instances.
      const far = new THREE.InstancedMesh(KINDS_FAR[name].geo, k.mat, these.length);
      far.instanceMatrix = im.instanceMatrix;
      far.instanceColor = im.instanceColor;
      far.boundingSphere = im.boundingSphere;
      far.visible = false;
      kit.add(far);
      lod.hi.push(im);
      lod.lo.push(far);
    }
    lods.push(lod);
  }
  /** Near tiles draw the rounder trees, far ones the plainer copies. */
  let lodAt = { x: Infinity, z: Infinity };
  function updateLods(x: number, z: number) {
    if (Math.hypot(x - lodAt.x, z - lodAt.z) < 10) return;
    lodAt = { x, z };
    for (let i = lods.length - 1; i >= 0; i--) {
      const l = lods[i];
      if (!l.hi[0]?.parent) {
        lods.splice(i, 1);
        continue;
      }
      const near = Math.max(Math.abs(l.x - x), Math.abs(l.z - z)) < TILE * 1.1;
      for (const m of l.hi) m.visible = near;
      for (const m of l.lo) m.visible = !near;
    }
  }
  function treeBodies(ti: number, tj: number, kit: TileKit) {
    const list = treesIn(ti, tj);
    if (!list.length) return;
    const body = kit.body();
    for (const t of list) {
      const r = KINDS[t.kind].collide * t.s;
      if (!r) continue;
      world.createCollider(RAPIER.ColliderDesc.cylinder(1.5, r).setTranslation(t.x, t.y + 1.2, t.z), body);
    }
  }

  // ---------- Kampong houses ----------
  // Each footprint becomes its best-fitting rectangle: plank or painted
  // walls on a low base, a pitched zinc roof with eaves.
  const houseList = map.buildings.map((b, n) => {
    const pts = b.pts;
    let best = { area: Infinity, a: 0, cx: 0, cz: 0, hw: 0, hd: 0 };
    for (let i = 0; i < pts.length; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[(i + 1) % pts.length];
      const a = Math.atan2(bz - az, bx - ax);
      const c = Math.cos(a);
      const s = Math.sin(a);
      let u0 = Infinity;
      let u1 = -Infinity;
      let v0 = Infinity;
      let v1 = -Infinity;
      for (const [x, z] of pts) {
        const u = x * c + z * s;
        const v = -x * s + z * c;
        u0 = Math.min(u0, u);
        u1 = Math.max(u1, u);
        v0 = Math.min(v0, v);
        v1 = Math.max(v1, v);
      }
      const area = (u1 - u0) * (v1 - v0);
      if (area < best.area) {
        const uc = (u0 + u1) / 2;
        const vc = (v0 + v1) / 2;
        best = { area, a, cx: uc * c - vc * s, cz: uc * s + vc * c, hw: (u1 - u0) / 2, hd: (v1 - v0) / 2 };
      }
    }
    const rand = mulberry32(SEED + n * 31);
    const walls = [0xe8e0cf, 0xd9e2d0, 0xcfd9e0, 0xe6d3b8, 0xa77d55, 0x8f6b48][Math.floor(rand() * 6)];
    const roof = [0x8d8f8a, 0x9a5b3c, 0x7d6f63, 0x5f6f73][Math.floor(rand() * 4)];
    return { ...best, hw: Math.max(1.5, best.hw), hd: Math.max(1.5, best.hd), walls, roof, h: 2.7 * Math.min(2, b.levels), y: 0 };
  })
    // A house never stands on a lane or track. (A footprint's best
    // rectangle can be bigger than the house: an L-shaped outline, or one
    // drawn round a yard.) Those are left out rather than guessed at.
    .filter((hs) => {
      for (let u = -1; u <= 1; u += 0.25)
        for (let v = -1; v <= 1; v += 0.25) {
          const x = hs.cx + Math.cos(hs.a) * u * hs.hw - Math.sin(hs.a) * v * hs.hd;
          const z = hs.cz + Math.sin(hs.a) * u * hs.hw + Math.cos(hs.a) * v * hs.hd;
          const r = ground.road(x, z, 8, (i) => map.roads[i].kind !== 'path');
          if (r && r.d < r.half + 0.6) return false;
        }
      return true;
    });
  const houseTiles = new Map<string, number[]>();
  houseList.forEach((hs, n) => {
    const k = `${Math.floor(hs.cx / TILE)},${Math.floor(hs.cz / TILE)}`;
    if (!houseTiles.has(k)) houseTiles.set(k, []);
    houseTiles.get(k)!.push(n);
  });
  const houseMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  function houseMeshes(ti: number, tj: number, kit: TileKit) {
    const ids = houseTiles.get(`${ti},${tj}`);
    if (!ids) return;
    const parts: THREE.BufferGeometry[] = [];
    for (const n of ids) {
      const hs = houseList[n];
      // Sit on the lowest corner, a low base under the rest.
      let lo = Infinity;
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const x = hs.cx + Math.cos(hs.a) * u * hs.hw - Math.sin(hs.a) * v * hs.hd;
        const z = hs.cz + Math.sin(hs.a) * u * hs.hw + Math.cos(hs.a) * v * hs.hd;
        lo = Math.min(lo, heightAt(x, z));
      }
      hs.y = lo;
      const along = hs.hw >= hs.hd;
      const W = hs.hw * 2;
      const Dd = hs.hd * 2;
      const box = tint(new THREE.BoxGeometry(W, hs.h, Dd).translate(0, hs.h / 2 + 0.4, 0), hs.walls);
      const base = tint(new THREE.BoxGeometry(W + 0.2, 1.2, Dd + 0.2).translate(0, -0.2, 0), 0x77736b);
      // Roof: a prism along the long side, eaves 0.5 m out.
      const span = (along ? Dd : W) / 2 + 0.5;
      const len = (along ? W : Dd) + 1;
      const rise = Math.min(2, span * 0.55);
      const shape = new THREE.Shape([new THREE.Vector2(-span, 0), new THREE.Vector2(span, 0), new THREE.Vector2(0, rise)]);
      const roof = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false }).translate(0, 0, -len / 2);
      if (along) roof.rotateY(Math.PI / 2);
      roof.translate(0, hs.h + 0.4, 0);
      const door = tint(new THREE.BoxGeometry(0.9, 2, 0.05).translate(0, 1.4, Dd / 2 + 0.03), 0x4a3a2c);
      const g = merge([box, base, tint(roof, hs.roof), door]);
      g.rotateY(-hs.a);
      g.translate(hs.cx, lo, hs.cz);
      parts.push(g);
    }
    const geo = kit.own(mergeGeometries(parts)!);
    const m = new THREE.Mesh(geo, houseMat);
    m.castShadow = m.receiveShadow = true;
    kit.add(m);
  }
  function houseBodies(ti: number, tj: number, kit: TileKit) {
    const ids = houseTiles.get(`${ti},${tj}`);
    if (!ids) return;
    const body = kit.body();
    for (const n of ids) {
      const hs = houseList[n];
      const y = hs.y || heightAt(hs.cx, hs.cz);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -hs.a);
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(hs.hw, hs.h / 2 + 1, hs.hd).setTranslation(hs.cx, y + hs.h / 2, hs.cz).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
        body,
      );
    }
  }

  // ---------- Tile layers ----------
  const builder = (layer: 'near' | 'far' | 'horizon') =>
    function* (ti: number, tj: number, kit: TileKit): Generator<void, void, void> {
      if (layer === 'horizon') {
        const p = yield* patch(ti, tj, 10, true);
        if (p) groundMesh(p, kit, true);
        yield;
        houseMeshes(ti, tj, kit);
        return;
      }
      const key = `${ti},${tj}`;
      // The drawn ground is 2 m everywhere; the solid ground is 1 m where
      // an obstacle's humps are (the eye can't tell, the wheels can).
      const step = fineTile.has(key) ? 1 : NEAR_STEP;
      if (layer === 'far') {
        const p = yield* patch(ti, tj, NEAR_STEP, true);
        if (!p) return;
        patches.set(key, p);
        if (patches.size > 40) patches.delete(patches.keys().next().value!);
        groundMesh(p, kit, false);
        yield;
        laneRibbons(ti, tj, kit);
        yield;
        treesIn(ti, tj);
        yield;
        treeMeshes(ti, tj, kit);
        return;
      }
      // Near: the solid ground (the far layer's own heights), trees, houses.
      let p = patches.get(key) ?? null;
      if (!p || p.step !== step) p = yield* patch(ti, tj, step, false);
      if (!p) return;
      const { w, h, pos } = p;
      const hts = new Float32Array(w * h);
      for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) hts[i * h + j] = pos[(j * w + i) * 3 + 1];
      const sx = (w - 1) * step;
      const sz = (h - 1) * step;
      world.createCollider(
        RAPIER.ColliderDesc.heightfield(h - 1, w - 1, hts, { x: sx, y: 1, z: sz }).setTranslation(pos[0] + sx / 2, 0, pos[2] + sz / 2).setFriction(0.9),
        kit.body(),
      );
      yield;
      treeBodies(ti, tj, kit);
      yield;
      houseBodies(ti, tj, kit);
    };
  const streamer = new TileStreamer(
    scene,
    world,
    RAPIER,
    { near: builder('near'), far: builder('far'), horizon: builder('horizon') },
    B,
    { near: 230, far: 430, horizon: 1300 },
  );

  // ---------- Sea, quarries and ponds ----------
  const waterMat = (color: number, opacity: number, repeat: number) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.12, metalness: 0.05, transparent: true, opacity });
    if (detailed) {
      const wn = D.waterNormalTexture();
      wn.wrapS = wn.wrapT = THREE.RepeatWrapping;
      wn.repeat.set(repeat, repeat);
      Object.assign(m, { normalMap: wn, roughness: 0.06 });
      m.normalScale.set(0.4, 0.4);
      D.patchWaterMaterial(m, wind);
    }
    return m;
  };
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(14000, 12000).rotateX(-Math.PI / 2), waterMat(0x2a6a70, 0.9, 400));
  sea.position.y = 0;
  sea.receiveShadow = true;
  scene.add(sea);
  {
    const P: number[] = [];
    const U: number[] = [];
    let n = 0;
    map.areas
      .filter((a) => a.kind === 'water')
      .forEach((a, id) => {
        const lvl = ground.levels[id];
        const contour = a.pts.map(([x, z]) => new THREE.Vector2(x, z));
        const tris = THREE.ShapeUtils.triangulateShape(contour, []);
        for (const t of tris)
          for (const v of [t[0], t[2], t[1]]) {
            P.push(a.pts[v][0], lvl, a.pts[v][1]);
            U.push(a.pts[v][0] / 30, a.pts[v][1] / 30);
            n++;
          }
      });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    geo.computeVertexNormals();
    const ponds = new THREE.Mesh(geo, waterMat(0x2f5f52, 0.88, 1));
    ponds.receiveShadow = true;
    scene.add(ponds);
  }

  // Fords: brown water across the track, level with the ground either side.
  // The water fills the hollow as water would: every bit of ground below its
  // level that joins up with the ford's line (a ditch beside it too), and its
  // edge is where the ground comes up to meet it, so it never hangs over
  // lower ground nor runs into the bank. (Worked out on a 0.25 m grid; each
  // edge point slid to where the ground crosses the water level.)
  const waterEdges: { x: number; z: number; y: number }[] = [];
  const puddleRims: { x: number; z: number; y: number; lo: number }[] = [];
  for (const o of trail.obstacles.flatMap((ob) => ob.parts)) {
    if (o.kind !== 'ford' && o.kind !== 'creek') continue;
    const len = o.to - o.from;
    // (A creek: a little water along the bottom of its channel, which
    // crosses the track at the middle of its part.)
    const creek = o.kind === 'creek';
    const a = o.line.at(creek ? len / 2 : 0);
    const lvl = heightAt(a.x, a.z) + (creek ? (o.p.water ?? 0.3) : -0.3);
    const C = 0.25;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let s = 0; s <= len; s += 2) {
      const p = o.line.at(s);
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
    }
    x0 -= 30; x1 += 30; z0 -= 30; z1 += 30;
    const nx = Math.ceil((x1 - x0) / C);
    const nz = Math.ceil((z1 - z0) / C);
    const W = nx + 1;
    const g = new Float32Array(W * (nz + 1));
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) g[j * W + i] = heightAt(x0 + i * C, z0 + j * C);
    // Wet cells: all four corners under the water (a hair over, at most),
    // joined to the ford's line.
    const wetOk = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < nz && g[j * W + i] < lvl + 0.04 && g[j * W + i + 1] < lvl + 0.04 && g[(j + 1) * W + i] < lvl + 0.04 && g[(j + 1) * W + i + 1] < lvl + 0.04;
    const wet = new Uint8Array(nx * nz);
    const stack: number[] = [];
    for (let s = creek ? len / 2 - 1 : 0; s <= (creek ? len / 2 + 1 : len); s += 0.5) {
      const p = o.line.at(s);
      const i = Math.floor((p.x - x0) / C);
      const j = Math.floor((p.z - z0) / C);
      if (wetOk(i, j) && !wet[j * nx + i]) {
        wet[j * nx + i] = 1;
        stack.push(i, j);
      }
    }
    while (stack.length) {
      const j = stack.pop()!;
      const i = stack.pop()!;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a2 = i + di;
        const b2 = j + dj;
        if (wetOk(a2, b2) && !wet[b2 * nx + a2]) {
          wet[b2 * nx + a2] = 1;
          stack.push(a2, b2);
        }
      }
    }
    // The mesh: a quad per wet cell, corners shared.
    const vid = new Int32Array(W * (nz + 1)).fill(-1);
    const P: number[] = [];
    const I: number[] = [];
    const corner = (i: number, j: number) => {
      const k = j * W + i;
      if (vid[k] < 0) {
        vid[k] = P.length / 3;
        P.push(x0 + i * C, lvl, z0 + j * C);
      }
      return vid[k];
    };
    const isWet = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < nz && wet[j * nx + i] === 1;
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        if (!wet[j * nx + i]) continue;
        const v00 = corner(i, j), v10 = corner(i + 1, j), v01 = corner(i, j + 1), v11 = corner(i + 1, j + 1);
        I.push(v00, v01, v10, v10, v01, v11);
      }
    // The edge: corners not wholly inside the water, each slid out towards
    // the higher ground next to it, to where the ground meets the water.
    for (let j = 0; j <= nz; j++)
      for (let i = 0; i <= nx; i++) {
        const k = j * W + i;
        if (vid[k] < 0) continue;
        if (isWet(i - 1, j - 1) && isWet(i, j - 1) && isWet(i - 1, j) && isWet(i, j)) continue;
        let bx = x0 + i * C;
        let bz = z0 + j * C;
        const gv = g[k];
        let best = -Infinity;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const a2 = i + di;
          const b2 = j + dj;
          if (a2 < 0 || b2 < 0 || a2 > nx || b2 > nz) continue;
          const gn = g[b2 * W + a2];
          if (gn <= lvl || gn <= best) continue;
          best = gn;
          const t = clamp((lvl - gv) / (gn - gv), 0, 0.95);
          bx = x0 + (i + di * t) * C;
          bz = z0 + (j + dj * t) * C;
        }
        const v = vid[k];
        P[v * 3] = bx;
        P[v * 3 + 2] = bz;
        waterEdges.push({ x: bx, z: bz, y: lvl });
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setIndex(I);
    geo.computeVertexNormals();
    if (geo.attributes.normal.getY(0) < 0) geo.setIndex(I.map((_, i) => I[i - (i % 3) + [0, 2, 1][i % 3]]));
    geo.computeVertexNormals();
    const ford = new THREE.Mesh(geo, creek ? waterMat(0x4d5a40, 0.9, 2) : waterMat(0x5b5a3e, 0.93, 2));
    ford.receiveShadow = true;
    scene.add(ford);
  }

  // ---------- Fine strips: the ground of deep ruts, notches, ditches and ledges ----------
  // Every 0.5 m along and 0.25 m across, drawn and solid (the tiles' own
  // ground is sunk under its middle): wheel-width ruts and a notch's crack
  // need finer ground than the tiles have.
  const fineMeshes: THREE.Mesh[] = [];
  {
    const mat = groundMat.clone();
    // (A clone keeps the textures but not the ground's shader patch, which
    // blends them by the ground's colour: without it the detail texture
    // shows raw, as stripes.)
    if (detailed) D.patchGroundMaterial(mat, true);
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -2;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const HALF = UbinTrail.FINE_HALF;
    // The tiles' drawn ground (its points 2 m apart, in two triangles a
    // square, as gridIdx lays them) at a point, as if it were not sunk.
    const tileGround = (x: number, z: number) => {
      const x0 = Math.max(B.minX, Math.floor(x / TILE) * TILE);
      const z0 = Math.max(B.minZ, Math.floor(z / TILE) * TILE);
      const i = Math.floor((x - x0) / NEAR_STEP);
      const j = Math.floor((z - z0) / NEAR_STEP);
      const fx = (x - x0) / NEAR_STEP - i;
      const fz = (z - z0) / NEAR_STEP - j;
      const X = x0 + i * NEAR_STEP;
      const Z = z0 + j * NEAR_STEP;
      const h10 = heightAt(X + NEAR_STEP, Z);
      const h01 = heightAt(X, Z + NEAR_STEP);
      if (fx + fz <= 1) {
        const h00 = heightAt(X, Z);
        return h00 + fx * (h10 - h00) + fz * (h01 - h00);
      }
      const h11 = heightAt(X + NEAR_STEP, Z + NEAR_STEP);
      return h11 + (1 - fx) * (h01 - h11) + (1 - fz) * (h10 - h11);
    };
    for (const { o, a: sA, b: sB } of trail.fineStrips()) {
      const nu = Math.round((sB - sA) / 0.5) + 1;
      // (Across: every 0.25 m over the middle 8 m, every metre out to the edges.)
      const offs: number[] = [];
      for (let v = -HALF; v < -4; v += 1) offs.push(v);
      for (let v = -4; v < 4; v += 0.25) offs.push(v);
      for (let v = 4; v <= HALF + 1e-6; v += 1) offs.push(v);
      const nv = offs.length;
      const pos = new Float32Array(nu * nv * 3);
      const solid = new Float32Array(nu * nv * 3);
      const clr = new Float32Array(nu * nv * 3);
      const uvs = new Float32Array(nu * nv * 2);
      for (let i = 0; i < nu; i++) {
        const u = sA + ((sB - sA) * i) / (nu - 1);
        // (Narrower on the inside of a tight bend: see trail.fineHalf.)
        const hl = trail.fineHalf(o, u, 1);
        const hr = trail.fineHalf(o, u, -1);
        for (let j = 0; j < nv; j++) {
          const off = offs[j] * (offs[j] > 0 ? hl : hr) / HALF;
          const half = off > 0 ? hl : hr;
          const { x, z } = trail.fineAt(o, u, off);
          const y = heightAt(x, z);
          const k = i * nv + j;
          solid.set([x, y, z], k * 3);
          // Drawn: the ground itself in the middle, easing out to the
          // tiles' own drawn ground at the edges and ends, so the strip meets
          // the tiles with no step, gap or flap (the solid ground keeps the
          // true heights, the tiles' as much as the strip's).
          const t = Math.max(smoothstep(half - UbinTrail.FINE_RIM - 2, half - UbinTrail.FINE_RIM, Math.abs(off)), 1 - smoothstep(sA + 3, sA + 6, u), smoothstep(sB - 6, sB - 3, u));
          pos.set([x, t > 0 ? y + (tileGround(x, z) - y) * t : y, z], k * 3);
          uvs.set([x / DETAIL_M, z / DETAIL_M], k * 2);
          colorAt(x, z, y, col);
          const v = 0.9 + 0.2 * valueNoise(x / 3.3, z / 3.3, SEED + 11);
          clr.set([col.r * v, col.g * v, col.b * v], k * 3);
        }
      }
      const idx = gridIdx(nv, nu);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(clr, 3));
      if (detailed) geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      // (The tiles it lies on.)
      const tiles = new Set<string>();
      for (let k = 0; k < pos.length; k += 3) tiles.add(`${Math.floor(pos[k] / TILE)},${Math.floor(pos[k + 2] / TILE)}`);
      mesh.userData.tiles = [...tiles].map((t) => t.split(',').map(Number));
      scene.add(mesh);
      fineMeshes.push(mesh);
      world.createCollider(RAPIER.ColliderDesc.trimesh(solid, idx).setFriction(0.9), body);
    }
  }

  // ---------- The drops' rock lips (built with the props below) ----------
  // Heights along each lip: its top on the ground above the drop, a few
  // centimetres proud and uneven (a rough rock edge), tapering into the
  // ground over its last 1.4 m at either end; its back on the ground; its
  // foot just under the ground below.
  type LipPoint = ReturnType<UbinTrail['lipLine']>[number] & { yBack: number; yTop: number; yUpper: number; yFoot: number; yLower: number };
  const lips: LipPoint[][] = trail.obstacles
    .filter((o) => o.drop)
    .map((o) => {
      const line = trail.lipLine(o);
      const n = line.length;
      return line.map((q, k) => {
        const yUpper = heightAt(q.upper[0], q.upper[1]);
        const yLower = heightAt(q.lower[0], q.lower[1]);
        const end = Math.min(k, n - 1 - k) * 0.2; // metres from the nearer end
        const t = Math.min(1, end / 1.4);
        const rough = 0.09 + 0.045 * Math.sin(q.off * 2.3 + o.s0) + 0.03 * Math.sin(q.off * 5.1 + 1.3 * o.s0);
        const ground = heightAt(q.top[0], q.top[1]);
        return {
          ...q,
          yUpper,
          yLower,
          yBack: heightAt(q.back[0], q.back[1]),
          yTop: ground + (yUpper + rough - ground) * t,
          yFoot: Math.min(heightAt(q.foot[0], q.foot[1]), yLower) - 0.08,
        };
      });
    });

  // ---------- The rough ground, to see ----------
  // Rocks on the humps, slabs at the ledges, roots across the rocky track,
  // loose stones on the gravel and scree, puddles in the mud holes. For
  // looks only: what the car feels is the ground's own shape under them.
  {
    const props = trail.props();
    // (Kept for the checks: each puddle's level and the lowest ground at its rim.)
    const rockGeo = (() => {
      const g = new THREE.IcosahedronGeometry(1, 1);
      const pos = g.attributes.position;
      const r = mulberry32(SEED + 77);
      const bump = new Map<string, number>();
      for (let i = 0; i < pos.count; i++) {
        const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
        if (!bump.has(key)) bump.set(key, 0.78 + 0.4 * r());
        const k = bump.get(key)!;
        pos.setXYZ(i, pos.getX(i) * k, Math.max(pos.getY(i) * k, -0.55), pos.getZ(i) * k);
      }
      g.computeVertexNormals();
      return g;
    })();
    const kinds = {
      rock: { geo: rockGeo, mat: new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), hsl: [0.08, 0.08, 0.2], shadow: true },
      boulder: { geo: rockGeo, mat: new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), hsl: [0.1, 0.1, 0.24], shadow: true },
      pebble: { geo: new THREE.IcosahedronGeometry(1, 0), mat: new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }), hsl: [0.07, 0.1, 0.24], shadow: false },
      ledge: { geo: (() => { const g = new THREE.BoxGeometry(1, 1, 1, 3, 1, 1); const pos = g.attributes.position; const r = mulberry32(SEED + 78); for (let i = 0; i < pos.count; i++) if (pos.getY(i) > 0) pos.setY(i, pos.getY(i) - 0.12 * r()); g.computeVertexNormals(); return g; })(), mat: new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), hsl: [0.08, 0.07, 0.22], shadow: true },
      root: { geo: new THREE.CylinderGeometry(1, 1, 1, 6).rotateX(Math.PI / 2), mat: new THREE.MeshStandardMaterial({ roughness: 0.9 }), hsl: [0.07, 0.4, 0.13], shadow: true },
      // (A fallen trunk: grey-brown bark, its cut ends paler.)
      log: { geo: merge([tint(new THREE.CylinderGeometry(1, 1, 1, 11, 1, true).rotateX(Math.PI / 2), 0x5a4a3c), tint(new THREE.CircleGeometry(1, 11).translate(0, 0, 0.5), 0xa08560), tint(new THREE.CircleGeometry(1, 11).rotateY(Math.PI).translate(0, 0, -0.5), 0xa08560)]), mat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }), hsl: [0, 0, 0.8], shadow: true },
      // (A look spot's post: weathered wood, a yellow band at the top.)
      post: { geo: merge([tint(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), 0x6b5236), tint(new THREE.BoxGeometry(1.15, 0.16, 1.15).translate(0, 0.86, 0), 0xe8c020)]), mat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }), hsl: [0, 0, 0.93], shadow: true },
      puddle: { geo: new THREE.CircleGeometry(0.5, 14).rotateX(-Math.PI / 2), mat: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.9 }), hsl: [0.09, 0.3, 0.11], shadow: false },
    };
    const dummy = new THREE.Object3D();
    const c = new THREE.Color();
    const rnd = mulberry32(SEED + 79);
    const boulderBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const [name, k] of Object.entries(kinds)) {
      const list = props.filter((p) => p.kind === name);
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(k.geo, k.mat, list.length);
      list.forEach((p, i) => {
        const h = heightAt(p.x, p.z);
        dummy.rotation.set(0, p.yaw, 0);
        if (name === 'boulder') {
          // Bedded in, and solid: the car cannot squeeze between them.
          dummy.position.set(p.x, h - p.sy * 0.25, p.z);
          dummy.scale.set(p.sx / 2, p.sy, p.sz / 2);
          world.createCollider(RAPIER.ColliderDesc.cylinder(1.2, p.sx * 0.45).setTranslation(p.x, h + 0.6, p.z), boulderBody);
        } else if (name === 'rock') {
          // As tall as its hump, its top just proud of it.
          dummy.position.set(p.x, h + 0.05 - p.sy, p.z);
          dummy.scale.set(p.sx / 2, p.sy, p.sz / 2);
        } else if (name === 'pebble') {
          dummy.position.set(p.x, h + p.sy * 0.15, p.z);
          dummy.rotation.set(rnd() * 3, p.yaw, rnd() * 3);
          dummy.scale.set(p.sx, p.sy, p.sz);
        } else if (name === 'ledge') {
          // Its top flush with the step above.
          dummy.position.set(p.x, h - p.sy / 2 + 0.03, p.z);
          dummy.scale.set(p.sz, p.sy, p.sx);
        } else if (name === 'post') {
          dummy.position.set(p.x, h - 0.1, p.z);
          dummy.scale.set(p.sx, p.sy, p.sz);
        } else if (name === 'log') {
          // Along its slant, level with the hump's top a little either side
          // of the track's middle (tilted to follow it), its top just under it.
          const dx = Math.sin(p.yaw);
          const dz = Math.cos(p.yaw);
          const ya = heightAt(p.x - dx * 2.2, p.z - dz * 2.2) - p.sx + 0.02;
          const yb = heightAt(p.x + dx * 2.2, p.z + dz * 2.2) - p.sx + 0.02;
          dummy.position.set(p.x, (ya + yb) / 2, p.z);
          dummy.lookAt(p.x + dx * 2.2, yb, p.z + dz * 2.2);
          dummy.rotateZ(rnd() * 6.28);
          dummy.scale.set(p.sx, p.sx, p.sz);
        } else if (name === 'root') {
          dummy.position.set(p.x, h + p.sx * 0.25, p.z);
          dummy.scale.set(p.sx, p.sx * 0.8, p.sz);
        } else {
          // Water fills the hole most of the way to its rim, and never above
          // the lowest point of the rim: on a slope there is no puddle (water
          // would run off), where a level disc would hang in the air.
          let rim = 0;
          let lo = Infinity;
          const cy = Math.cos(p.yaw);
          const sy = Math.sin(p.yaw);
          for (let k = 0; k < 12; k++) {
            const lx = (Math.cos((k * Math.PI) / 6) * p.sz) / 2;
            const lz = (Math.sin((k * Math.PI) / 6) * p.sx) / 2;
            const rh = heightAt(p.x + lx * cy + lz * sy, p.z - lx * sy + lz * cy);
            rim += rh / 12;
            lo = Math.min(lo, rh);
          }
          const y = Math.max(h + 0.02, Math.min(h + 0.7 * Math.max(0, rim - h) + 0.03, lo + 0.04));
          // (And none on sloping ground at all, over about 6 degrees across
          // 4 m: the camber's mud holes sit on a bench beside a steep bank.)
          let wlo = Infinity;
          let whi = -Infinity;
          for (let k = 0; k < 8; k++) {
            const wh = heightAt(p.x + 2 * Math.cos((k * Math.PI) / 4), p.z + 2 * Math.sin((k * Math.PI) / 4));
            wlo = Math.min(wlo, wh);
            whi = Math.max(whi, wh);
          }
          if (y - lo > 0.1 || whi - wlo > 0.42) {
            dummy.position.set(p.x, -1000, p.z);
            dummy.scale.set(0.001, 0.001, 0.001);
          } else {
            dummy.position.set(p.x, y, p.z);
            dummy.scale.set(p.sz, 1, p.sx); // long along the track
            puddleRims.push({ x: p.x, z: p.z, y, lo });
          }
        }
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
        const [hh, ss, ll] = k.hsl;
        c.setHSL(hh + (rnd() - 0.5) * 0.04, ss + (rnd() - 0.5) * 0.06, ll + (rnd() - 0.5) * 0.12);
        im.setColorAt(i, c);
      });
      im.castShadow = k.shadow;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      scene.add(im);
    }
    // Each drop's rock lip: one piece of rock across the track, its top
    // following the ground above the drop with a rough, uneven edge, its
    // face down to the ground below, and tapering into the ground at
    // either end. Solid: the face is a wall no wheel climbs back up.
    for (const L of lips) {
      const n = L.length;
      const pos: number[] = [];
      const col: number[] = [];
      const base = new THREE.Color().setHSL(0.08, 0.08, 0.22);
      const tc = new THREE.Color();
      const push = (x: number, y: number, z: number, k: number) => {
        pos.push(x, y, z);
        // (Patchy, not striped: slow changes along it.)
        tc.copy(base).offsetHSL(0, 0, 0.035 * Math.sin(k * 0.37) + 0.02 * Math.sin(k * 0.91 + 2));
        col.push(tc.r, tc.g, tc.b);
      };
      const idx: number[] = [];
      L.forEach((q, k) => {
        push(q.back[0], q.yBack, q.back[1], k);
        // (Its edge not ruler-straight: in and out a little along the track.)
        const jig = 0.12 * Math.sin(k * 0.8) + 0.06 * Math.sin(k * 2.1 + 1);
        push(q.top[0] + (q.upper[0] - q.top[0]) * jig, q.yTop, q.top[1] + (q.upper[1] - q.top[1]) * jig, k);
        push(q.foot[0], q.yFoot, q.foot[1], k);
        if (k < n - 1) {
          const a = k * 3;
          const b = a + 3;
          // (Wound to face up and out, whichever way the drop runs.)
          idx.push(a, b, a + 1, b, b + 1, a + 1, a + 1, b + 1, a + 2, b + 1, b + 2, a + 2);
        }
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      const ng = g.toNonIndexed();
      ng.computeVertexNormals();
      const mesh = new THREE.Mesh(ng, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true, side: THREE.DoubleSide }));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      // (The wall itself: narrow blocks, each no higher than the lowest
      // of the lip's top over its width, so none stands above the rock.)
      for (let k = 0; k + 3 < n; k += 3) {
        const span = L.slice(k, k + 4);
        const top = Math.min(...span.map((q) => q.yUpper));
        const a = span[0];
        const b = span[span.length - 1];
        const cx = (a.upper[0] + b.upper[0]) / 2;
        const cz = (a.upper[1] + b.upper[1]) / 2;
        const ax = b.upper[0] - a.upper[0];
        const az = b.upper[1] - a.upper[1];
        const yaw = Math.atan2(-az, ax);
        const hh = (top - Math.min(...span.map((q) => q.yLower)) + 0.3) / 2;
        const qq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        // (Across: the span's width; along the track: from the back edge to the face.)
        // (Centred 0.15 m behind the upper point: 1.4 m deep, its face where the lip's is.)
        const bx = (a.upper[0] - a.top[0]) / 0.55;
        const bz = (a.upper[1] - a.top[1]) / 0.55;
        world.createCollider(RAPIER.ColliderDesc.cuboid(Math.hypot(ax, az) / 2 + 0.05, hh, 0.7).setTranslation(cx + bx * 0.15, top - hh, cz + bz * 0.15).setRotation({ x: qq.x, y: qq.y, z: qq.z, w: qq.w }).setFriction(0.9), boulderBody);
      }
    }
  }

  // ---------- Plank bridges: two planks over a gully, solid ----------
  // Each plank's top a little above the bank at either end, straight
  // between (tilted if one bank is higher), on a log bearer at each bank.
  {
    const planks = trail.planks();
    if (planks.length) {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      const wood = new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.85, vertexColors: true });
      const bark = new THREE.MeshStandardMaterial({ color: 0x5a4a3c, roughness: 0.92 });
      const T = 0.12;
      const o3 = new THREE.Object3D();
      for (const P of planks) {
        const ya = heightAt(P.a[0], P.a[1]) + 0.08 - T / 2;
        const yb = heightAt(P.b[0], P.b[1]) + 0.08 - T / 2;
        const a = new THREE.Vector3(P.a[0], ya, P.a[1]);
        const b = new THREE.Vector3(P.b[0], yb, P.b[1]);
        const L = a.distanceTo(b);
        o3.position.copy(a).add(b).multiplyScalar(0.5);
        o3.lookAt(b);
        o3.updateMatrix();
        // (Two boards side by side, a hair apart.)
        const g = merge([tint(new THREE.BoxGeometry(P.w / 2 - 0.01, T, L).translate(-P.w / 4, 0, 0), 0xffffff), tint(new THREE.BoxGeometry(P.w / 2 - 0.01, T, L).translate(P.w / 4, 0, 0), 0xe8e0d8)]);
        const m = new THREE.Mesh(g, wood);
        m.position.copy(o3.position);
        m.quaternion.copy(o3.quaternion);
        m.castShadow = true;
        m.receiveShadow = true;
        scene.add(m);
        const q = o3.quaternion;
        world.createCollider(RAPIER.ColliderDesc.cuboid(P.w / 2, T / 2, L / 2).setTranslation(o3.position.x, o3.position.y, o3.position.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setFriction(0.8), body);
        // (The bearers: a log under each end, bedded in the bank.)
        for (const e of [a, b]) {
          const toward = new THREE.Vector3().subVectors(o3.position, e).setY(0).normalize();
          const c = e.clone().addScaledVector(toward, 0.9);
          const bm = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.1, 9).rotateZ(Math.PI / 2), bark);
          // (Its top just under the plank.)
          const f = e === a ? 0.9 / L : 1 - 0.9 / L;
          bm.position.set(c.x, ya + (yb - ya) * f - T / 2 - 0.165, c.z);
          bm.rotation.y = Math.atan2(toward.x, toward.z);
          bm.castShadow = true;
          scene.add(bm);
        }
      }
    }
  }

  // ---------- Ubin Jetty and the bumboats ----------
  const jetty = map.piers.find((p) => /public jetty/i.test(p.name)) ?? map.piers[0];
  const boats: THREE.Object3D[] = [];
  if (jetty) {
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i + 1 < jetty.pts.length; i++) {
      const [ax, az] = jetty.pts[i];
      const [bx, bz] = jetty.pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const a = Math.atan2(bz - az, bx - ax);
      const deck = tint(new THREE.BoxGeometry(len + 0.5, 0.3, 4), 0xb5aea0).rotateY(-a).translate((ax + bx) / 2, 1.6, (az + bz) / 2);
      parts.push(deck);
      for (let s = 0; s <= len; s += 5)
        for (const side of [-1.7, 1.7]) {
          const x = ax + Math.cos(a) * s - Math.sin(a) * side;
          const z = az + Math.sin(a) * s + Math.cos(a) * side;
          parts.push(tint(new THREE.CylinderGeometry(0.15, 0.15, 3.5, 6).translate(x, -0.2, z), 0x5c5650));
        }
    }
    const m = new THREE.Mesh(merge(parts), houseMat);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    // Two bumboats tied up at the end.
    const [ex, ez] = jetty.pts[jetty.pts.length - 1];
    const boatGeo = merge([
      tint(new THREE.BoxGeometry(8, 1, 2.4).translate(0, 0.3, 0), 0xe8e4da),
      tint(new THREE.BoxGeometry(8.1, 0.25, 2.5).translate(0, 0.85, 0), 0x2d6aa3),
      tint(new THREE.BoxGeometry(4, 0.12, 2.6).translate(-0.5, 2.4, 0), 0x3b7d4a),
      tint(new THREE.CylinderGeometry(0.06, 0.06, 1.5, 4).translate(1.4, 1.6, 1.1), 0x555555),
      tint(new THREE.CylinderGeometry(0.06, 0.06, 1.5, 4).translate(1.4, 1.6, -1.1), 0x555555),
    ]);
    for (const [dx, dz, r] of [[6, 4, 0.4], [-5, 5, -0.3]]) {
      const b = new THREE.Mesh(boatGeo, houseMat);
      b.position.set(ex + dx, 0, ez + dz);
      b.rotation.y = r;
      b.castShadow = true;
      scene.add(b);
      boats.push(b);
    }
  }

  // ---------- Wooden signboards ----------
  const signPost = new THREE.MeshStandardMaterial({ color: 0x6b5236, roughness: 0.9 });
  function makeSign(lines: string[], x: number, z: number, yaw: number) {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 256;
    const g = c.getContext('2d')!;
    g.fillStyle = '#5a3f26';
    g.fillRect(0, 0, 512, 256);
    g.fillStyle = '#6d4d2f';
    for (let k = 0; k < 4; k++) g.fillRect(0, k * 64 + 2, 512, 58);
    g.fillStyle = '#f3e7c9';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    lines.forEach((t, k) => {
      g.font = `${k ? 'normal 44px' : 'bold 58px'} system-ui, sans-serif`;
      g.fillText(t, 256, 128 + (k - (lines.length - 1) / 2) * 72);
    });
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const group = new THREE.Group();
    const board = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.1, 0.08), [signPost, signPost, signPost, signPost, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }), signPost]);
    board.position.y = 1.9;
    board.castShadow = true;
    group.add(board);
    for (const dx of [-0.9, 0.9]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.4, 0.12), signPost);
      post.position.set(dx, 1.2, 0);
      group.add(post);
    }
    group.position.set(x, heightAt(x, z), z);
    group.rotation.y = yaw;
    scene.add(group);
    return group;
  }
  /** A sign beside the route at s, on the right, facing the driver coming along it. */
  const signAt = (lines: string[], line: { at(s: number): { x: number; z: number; tx: number; tz: number } }, s: number, side = 1, out = 4.2) => {
    const p = line.at(s);
    // Right of travel is (-tz, tx) with x east and z south.
    const x = p.x - p.tz * out * side;
    const z = p.z + p.tx * out * side;
    // A plane's front faces +z; turn it to face back along the route.
    return makeSign(lines, x, z, Math.atan2(-p.tx, -p.tz));
  };
  // (Named on the easy and medium trails; the hard one has no signs.)
  if (def.wayRound === 'gate') for (const o of trail.obstacles) signAt([o.label], trail.route, o.s0 - 60, -1);

  // ---------- The ways round: a barrier until opened, then marker posts ----------
  const gateBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const gates = trail.obstacles.flatMap((o) => {
    const g = o.gate;
    if (!g) return [];
    const y = heightAt(g.x, g.z);
    const group = new THREE.Group();
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, 5.5, 8).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x5e4a3a, roughness: 1 }));
    log.position.set(0, 0.35, 0);
    log.castShadow = true;
    group.add(log);
    // Leafy fallen branches either side.
    for (const s of [-1, 1]) {
      const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(1.1, 0), new THREE.MeshStandardMaterial({ color: 0x3f6a2c, roughness: 0.9, flatShading: true }));
      leaf.position.set(s * 2.4, 0.6, 0.3 * s);
      group.add(leaf);
    }
    group.position.set(g.x, y, g.z);
    group.rotation.y = g.yaw + Math.PI / 2;
    scene.add(group);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), g.yaw + Math.PI / 2);
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(2.9, 0.6, 0.45).setTranslation(g.x, y + 0.45, g.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
      gateBody,
    );
    // Marker posts every 14 m along the way round, shown once it opens.
    const posts = new THREE.Group();
    const postGeo = merge([tint(new THREE.BoxGeometry(0.14, 1.1, 0.14).translate(0, 0.55, 0), 0x6b5236), tint(new THREE.BoxGeometry(0.16, 0.22, 0.16).translate(0, 1.0, 0), 0xe06a1c)]);
    const postMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
    for (let s = 6; s < o.bypass.length - 4; s += 14) {
      const p = o.bypass.at(s);
      const side = -o.side; // posts on the outside of the bend
      const x = p.x - p.tz * 2.4 * side;
      const z = p.z + p.tx * 2.4 * side;
      const m = new THREE.Mesh(postGeo, postMat);
      m.position.set(x, heightAt(x, z), z);
      posts.add(m);
    }
    const sign = signAt(['Easier way round', o.side > 0 ? '\u2190 this way' : 'this way \u2192'], trail.route, o.s0 - 34, -1, 4.6);
    posts.add(sign);
    scene.remove(sign);
    posts.visible = false;
    scene.add(posts);
    return [{ o, group, collider, posts, opened: false }];
  });
  const syncGates = () =>
    gates.forEach((g) => {
      if (!g.o.open || g.opened) return;
      g.opened = true;
      world.removeCollider(g.collider, true);
      // The log is dragged off the track to one side (it lies across the
      // track along the group's x, so it moves along x and turns to lie
      // beside the track).
      g.group.children[0].position.x = 4.6;
      g.group.children[0].rotation.y = 1.3;
      g.posts.visible = true;
    });

  // ---------- Camp ----------
  const campPoi = def.end.camp ? map.pois.find((p) => p.kind === 'camp' && Math.hypot(p.x - trail.camp.x, p.z - trail.camp.z) < 200) : null;
  const camp = { id: def.end.camp?.id ?? `ubin-${def.id}-end`, label: def.end.camp?.label ?? def.end.label, x: trail.camp.x, z: trail.camp.z, radius: 26 };
  if (campPoi) {
    // On the lane by the camp site.
    camp.x = (trail.camp.x + campPoi.x) / 2;
    camp.z = (trail.camp.z + campPoi.z) / 2;
  }

  signAt(def.end.sign, trail.route, trail.route.length - 30, -1);
  signAt(def.startSign, trail.route, 22, -1);

  // ---------- Map ----------
  const mapData: MapData = {
    bounds: { ...B },
    background: '#3d6f86',
    pxPerM: 0.5,
    attribution: map.attribution,
    areas: [
      ...map.land.map((l) => ({ pts: l.pts, color: '#6f9655' })),
      ...map.areas.filter((a) => a.kind === 'wood').map((a) => ({ pts: a.pts, color: '#5a8446' })),
      ...map.areas.filter((a) => a.kind === 'wetland').map((a) => ({ pts: a.pts, color: '#5f7a55' })),
      ...map.areas.filter((a) => a.kind === 'beach').map((a) => ({ pts: a.pts, color: '#e3d3a4' })),
      ...map.areas.filter((a) => a.kind === 'water').map((a) => ({ pts: a.pts, color: '#4f8a96' })),
      ...houseList.map((hs) => ({
        pts: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [hs.cx + Math.cos(hs.a) * u * hs.hw - Math.sin(hs.a) * v * hs.hd, hs.cz + Math.sin(hs.a) * u * hs.hw + Math.cos(hs.a) * v * hs.hd] as XZ),
        color: '#b86f55',
      })),
    ],
    lines: [
      { pts: trail.route.pts, width: 9, color: '#f0a33a' },
      ...map.roads.filter((r) => r.kind === 'path').map((r) => ({ pts: r.pts, width: 1.5, color: '#a28d6c' })),
      ...map.roads.filter((r) => r.kind === 'track').map((r) => ({ pts: r.pts, width: 3.5, color: '#9b6f45' })),
      ...map.roads.filter((r) => r.kind === 'lane').map((r) => ({ pts: r.pts, width: 4.5, color: '#efe9da' })),
    ],
    pois: [
      ...trail.obstacles.map((o) => {
        const p = o.line.at((o.s1 - o.s0) / 2);
        return { x: p.x, z: p.z, label: o.label };
      }),
      { x: camp.x, z: camp.z, label: def.end.camp ? 'Camp' : def.end.label },
      ...(jetty ? [{ x: jetty.pts[0][0], z: jetty.pts[0][1], label: 'Ubin Jetty' }] : []),
      ...map.pois.filter((p) => p.name && ['quarry', 'peak', 'place'].includes(p.kind)).map((p) => ({ x: p.x, z: p.z, label: p.name })),
    ],
  };

  // ---------- Names ----------
  const places = map.pois.filter((p) => p.name);
  function zoneAt(x: number, z: number): string | null {
    for (const o of trail.obstacles) {
      const n = o.line.nearest(x, z, 20);
      if (n && n.d < 16) return o.label;
    }
    let best: string | null = null;
    let bd = 70;
    for (const p of places) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) {
        bd = d;
        best = p.name;
      }
    }
    if (best) return best;
    const r = ground.road(x, z, 8);
    if (r && map.roads[r.road].name) return map.roads[r.road].name;
    return null;
  }

  // ---------- Start: the lane at the top of the jetty, facing inland ----------
  const R = trail.route;
  const s0 = R.at(4);
  const startYaw = Math.atan2(-s0.tz, s0.tx);
  const start = new THREE.Vector3(s0.x, heightAt(s0.x, s0.z) + 1.4, s0.z);
  streamer.prepare(s0.x, s0.z, 300);

  const poseAt = (t: number) => {
    const p = R.at(clamp(t, 0, 1) * R.length);
    return { pos: new THREE.Vector3(p.x, heightAt(p.x, p.z), p.z), yaw: Math.atan2(-p.tz, p.tx) };
  };

  // Ruts: a dark, wet mark on each worn half-metre square, laid on the
  // ground's slope, darker the deeper it is dug.
  const lastDig = { x: 0, z: 0 };
  let rutShown = 0;
  const RUT_MAX = 4000;
  const rutMarks = new THREE.InstancedMesh(
    // (A dug-in patch: a dark, wet hollow, round, a little bigger than its cell so they run together.)
    new THREE.CircleGeometry(UbinTrail.RUT_CELL * 0.75, 10).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, transparent: true, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
    RUT_MAX,
  );
  rutMarks.count = 0;
  rutMarks.frustumCulled = false;
  rutMarks.renderOrder = 2;
  if (def.ruts) scene.add(rutMarks);
  const drawRuts = () => {
    rutShown = trail.rutVersion;
    const cells = trail.rutCells();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const nrm = new THREE.Vector3();
    const col = new THREE.Color();
    const wet = new THREE.Color(0x140e08);
    const dry = new THREE.Color(0x33261a);
    let n = 0;
    // (On the ground as drawn: a metre between its points on the trail, so
    // between them it is flatter than the bumps it was made from.)
    const drawn = (x: number, z: number) => {
      const x0 = Math.floor(x);
      const z0 = Math.floor(z);
      const fx = x - x0;
      const fz = z - z0;
      const a = heightAt(x0, z0) * (1 - fx) + heightAt(x0 + 1, z0) * fx;
      const b = heightAt(x0, z0 + 1) * (1 - fx) + heightAt(x0 + 1, z0 + 1) * fx;
      return a * (1 - fz) + b * fz;
    };
    for (const c of cells) {
      if (n >= RUT_MAX || c.w < 0.12) continue;
      const h = Math.max(drawn(c.x, c.z), heightAt(c.x, c.z));
      nrm.set(drawn(c.x - 0.5, c.z) - drawn(c.x + 0.5, c.z), 1, drawn(c.x, c.z - 0.5) - drawn(c.x, c.z + 0.5)).normalize();
      q.setFromUnitVectors(up, nrm);
      const sc = 0.7 + 0.3 * c.w;
      m.compose(new THREE.Vector3(c.x, h + 0.06, c.z), q, new THREE.Vector3(sc, 1, sc));
      rutMarks.setMatrixAt(n, m);
      rutMarks.setColorAt(n, col.copy(dry).lerp(wet, c.w));
      n++;
    }
    rutMarks.count = n;
    rutMarks.instanceMatrix.needsUpdate = true;
    if (rutMarks.instanceColor) rutMarks.instanceColor.needsUpdate = true;
  };

  return {
    name: def.name,
    map: mapData,
    styles: true,
    sky: { background: 0xb9d3df, fog: 0xc8d8dc, fogNear: 140, fogFar: 560 },
    start,
    startYaw,
    heightAt,
    surfaceAt,
    zoneAt,
    poseAt,
    trackT: (x, z) => (R.nearest(x, z, 400)?.s ?? 0) / R.length,
    safeSpot(x, z) {
      const n = R.nearest(x, z, 3000);
      if (!n) return null;
      const p = R.at(n.s);
      return { x: p.x, z: p.z, yaw: Math.atan2(-p.tz, p.tx) };
    },
    prepareAt: (x, z) => streamer.prepare(x, z, 300),
    // (For the checks: the fine strips and the tiles' ground material.)
    fineGround: { strips: fineMeshes, groundMat },
    retryAt: (x, z) => trail.retryAt(x, z),
    ...(def.ruts
      ? {
          rutAt: (x: number, z: number) => trail.rutAt(x, z),
          dig: (x: number, z: number, amount: number) => {
            trail.dig(x, z, amount);
            lastDig.x = x;
            lastDig.z = z;
          },
          resetRuts: () => trail.resetRuts(),
        }
      : {}),
    solidAt: (x, z) => streamer.solidAt(x, z),
    streamStats: () => ({ ...streamer.stats, horizon: streamer.stats.horizon }),
    camps: def.end.camp ? [camp] : [],
    update(time, _dt, cam, player) {
      wind.value = time;
      const at = player ?? cam;
      if (at) {
        streamer.update(at.x, at.z);
        updateLods(at.x, at.z);
        // (A strip shows only while all the tiles' ground around it is near
        // enough to be drawn in full: out on the horizon's coarser ground its
        // edges would not meet it.)
        // (And only once those tiles are built: until then the horizon's
        // coarse ground is drawn there.)
        for (const m of fineMeshes) {
          const b = m.geometry.boundingSphere!;
          m.visible = Math.hypot(at.x - b.center.x, at.z - b.center.z) + b.radius < 410 && (m.userData.tiles as [number, number][]).every(([i, j]) => streamer.built('far', i, j));
        }
      }
      if (def.ruts) {
        // (Left far behind, the trail's ruts settle: fresh ground next time.)
        if (at && trail.ruts.size && Math.hypot(at.x - lastDig.x, at.z - lastDig.z) > 150) trail.resetRuts();
        if (trail.rutVersion !== rutShown) drawRuts();
      }
      for (let i = 0; i < boats.length; i++) {
        boats[i].position.y = 0.05 * Math.sin(time * 1.1 + i * 2);
        boats[i].rotation.z = 0.02 * Math.sin(time * 0.9 + i);
      }
    },
    /** For the checks: the water's edge points and each puddle's level. */
    water: () => ({ edges: waterEdges, puddles: puddleRims }),
    /** For the checks: each drop's rock lip as built. */
    lips: () => lips,
    coach(c) {
      const out = trail.coach(c);
      syncGates();
      return out;
    },
    trail,
  } as Course & { trail: UbinTrail };
}
