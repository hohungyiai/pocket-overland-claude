import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, mulberry32, smoothstep, valueNoise } from '../../noise';
import { TILE, TileStreamer, type TileKit } from '../../world/stream';
import * as D from '../detail';
import type { ArtStyle } from '../detail';
import { SURFACES, type Course, type MapData, type Surface, type XZ } from '../types';
import { fill, MASK, UbinGround, type UbinMap } from './ground';
import { UbinTrail } from './trail';

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
const TRACK: Surface = { name: 'Dirt track', grip: 0.82, drag: 1.8 };
const FOREST: Surface = { name: 'Forest floor', grip: 0.72, drag: 3.5 };

interface Tree {
  x: number;
  z: number;
  y: number;
  s: number;
  r: number;
  kind: 'rain' | 'almond' | 'palm' | 'casuarina' | 'mangrove' | 'shrub';
}

export async function buildUbinTrailCourse(scene: THREE.Scene, world: RAPIER_NS.World, RAPIER: Rapier, opts: { style?: ArtStyle } = {}): Promise<Course> {
  const detailed = opts.style !== 'stylized';
  const map: UbinMap = await (await fetch(UBIN_MAP)).json();
  const trail = new UbinTrail(map);
  // The ways round the obstacles are tracks too (for the ground and the map).
  trail.obstacles.forEach((o, i) =>
    map.roads.push({ id: -1 - i, name: 'Way round', kind: 'track', hw: 'track', surface: 'dirt', width: 3.2, nodes: [], pts: o.bypass.pts }),
  );
  const ground = new UbinGround(map);
  ground.shape = (x, z) => trail.shape(x, z);
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
      return kind === 'lane' ? LANE : TRACK;
    }
    const m = ground.maskAt(x, z);
    if (m & MASK.beach) return SURFACES.sand;
    if (m & MASK.wetland) return SURFACES.mud;
    return valueNoise(x / 20, z / 20, SEED + 3) > 0.55 ? FOREST : SURFACES.grass;
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
    rock: new THREE.Color(0.55, 0.53, 0.5),
    bed: new THREE.Color(0.4, 0.38, 0.3),
    sea: new THREE.Color(0.42, 0.47, 0.4),
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
    if (o) out.lerp(o.name === 'Soft sand' ? C.sand : o.name === 'Loose gravel' ? C.rock : C.dirt, 0.7);
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
    D.patchGroundMaterial(groundMat);
  }
  // Tiles with an obstacle get a finer ground (the washout's humps).
  const fineTile = new Set<string>();
  for (const o of trail.obstacles)
    for (const [x, z] of o.line.pts.concat(o.bypass.pts))
      for (const dx of [-20, 0, 20])
        for (const dz of [-20, 0, 20]) fineTile.add(`${Math.floor((x + dx) / TILE)},${Math.floor((z + dz) / TILE)}`);
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
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const x = x0 + i * step;
        const z = z0 + j * step;
        const y = heightAt(x, z);
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
  for (const o of trail.obstacles) signAt([o.label], trail.route, o.s0 - 60, -1);

  // ---------- The ways round: a barrier until opened, then marker posts ----------
  const gateBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const gates = trail.obstacles.map((o) => {
    const g = o.gate;
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
    return { group, collider, posts, opened: false };
  });
  const syncGates = () =>
    trail.obstacles.forEach((o, i) => {
      const g = gates[i];
      if (!o.open || g.opened) return;
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
  const campPoi = map.pois.find((p) => p.kind === 'camp' && Math.hypot(p.x - trail.camp.x, p.z - trail.camp.z) < 200);
  const camp = { id: 'ubin-endut-senin', label: 'Endut Senin camp site', x: trail.camp.x, z: trail.camp.z, radius: 26 };
  if (campPoi) {
    // On the lane by the camp site.
    camp.x = (trail.camp.x + campPoi.x) / 2;
    camp.z = (trail.camp.z + campPoi.z) / 2;
  }

  signAt(['Endut Senin', 'Campsite'], trail.route, trail.route.length - 30, -1);
  signAt(['Pulau Ubin', 'Ketam Trail \u2192 7 km'], trail.route, 22, -1);

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
      { x: camp.x, z: camp.z, label: 'Camp' },
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

  return {
    name: 'Pulau Ubin: Ketam Trail',
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
    solidAt: (x, z) => streamer.solidAt(x, z),
    streamStats: () => ({ ...streamer.stats, horizon: streamer.stats.horizon }),
    camps: [camp],
    update(time, _dt, cam, player) {
      wind.value = time;
      const at = player ?? cam;
      if (at) {
        streamer.update(at.x, at.z);
        updateLods(at.x, at.z);
      }
      for (let i = 0; i < boats.length; i++) {
        boats[i].position.y = 0.05 * Math.sin(time * 1.1 + i * 2);
        boats[i].rotation.z = 0.02 * Math.sin(time * 0.9 + i);
      }
    },
    coach(c) {
      const out = trail.coach(c);
      syncGates();
      return out;
    },
    trail,
  } as Course & { trail: UbinTrail };
}
