import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, fbm, lerp, mulberry32, smoothstep, valueNoise } from '../noise';
import { SURFACES, type Course, type MapData, type Surface, type XZ } from './types';

type Rapier = typeof RAPIER_NS;

// East Coast Park, Singapore: a stylized, hand-laid stretch (not map data).
// From south to north: the strait with ships at anchor, the beach with rock
// groynes, a palm-lined jogging path, the park and its service road with
// carparks, a hedge, the East Coast Parkway, then Marine Parade's HDB blocks.
// Hand-placed anchors: coastline shape, service road, carparks, Bedok Jetty,
// the lagoon and its food village, camp areas. Generated from the seed:
// trees, shrubs, park furniture, HDB layout and colours.
//
// Axes: x runs west -> east, z runs north (negative) -> south (positive, sea).

const SEED = 6533;
const X0 = -1100;
const X1 = 1100;
const Z0 = -360;
const Z1 = 190;
const STEP = 3; // terrain vertex spacing, metres
const CHUNKS = 10; // terrain/vegetation chunks along x (lets the GPU skip what's off-screen)
const PARK_H = 1.6; // park ground height above sea level
const ROAD_HALF = 3.6;
const PATH_HALF = 1.6;
const FENCE_Z = -74; // hedge + fence between park and expressway (play boundary)
const END_X = 790; // play boundary at each end
const LAGOON = { x0: 300, x1: 430, z0: -6, z1: 14, level: 1.05 };

// ---------- Hand-placed layout ----------

/** Waterline (z) at a given x. */
const coastZ = (x: number) => 46 + 10 * Math.sin(x / 170) + 5 * Math.sin(x / 61 + 1);
const beachTopZ = (x: number) => coastZ(x) - 26;
const pathZ = (x: number) => beachTopZ(x) - 7;

const ROAD_CTRL: XZ[] = [
  [-800, -30], [-690, -24], [-580, -36], [-460, -22], [-340, -30], [-220, -18],
  [-100, -32], [20, -26], [140, -38], [250, -30], [360, -40], [480, -26],
  [600, -34], [700, -22], [800, -30],
];

interface Rect { x0: number; x1: number; z0: number; z1: number; label: string }
// Carparks sit on the north side of the road.
const CARPARKS: Rect[] = [
  { x0: -650, x1: -600, z0: -66, z1: -44, label: 'Carpark B' },
  { x0: -250, x1: -195, z0: -62, z1: -38, label: 'Carpark C' },
  { x0: 200, x1: 290, z0: -70, z1: -48, label: 'Carpark E' },
  { x0: 640, x1: 690, z0: -64, z1: -40, label: 'Carpark G' },
];
const HAWKER = { x: 240, z: -60, w: 34, d: 18 };
const JETTY = { x: 560, len: 190, w: 4.5, deck: 2.6 };
// Campsite hooks (from the campsite research): marked on the map, with deep
// beach sand around Area G. The camp loop itself comes later.
const CAMPS = [
  { x: -380, label: 'Camp Area D' },
  { x: 470, label: 'Camp Area G' },
];
const GROYNES = [-700, -520, -330, -140, 60, 250, 700];

function buildRoad(): THREE.Vector3[] {
  const curve = new THREE.CatmullRomCurve3(
    ROAD_CTRL.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    false,
    'centripetal',
  );
  return curve.getSpacedPoints(800);
}

export function buildEastCoastCourse(scene: THREE.Scene, world: RAPIER_NS.World, RAPIER: Rapier): Course {
  const rand = mulberry32(SEED);
  const road = buildRoad();
  const n = road.length;

  // Nearest point on the road. The road runs west->east without doubling
  // back, so we only search segments near the matching x.
  const roadX0 = road[0].x;
  const roadDx = (road[n - 1].x - road[0].x) / (n - 1);
  function nearestRoad(x: number, z: number) {
    const guess = clamp(Math.round((x - roadX0) / roadDx), 0, n - 2);
    let best = Infinity;
    let bi = guess;
    let bu = 0;
    for (let i = Math.max(0, guess - 20); i <= Math.min(n - 2, guess + 20); i++) {
      const a = road[i];
      const b = road[i + 1];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const u = clamp(((x - a.x) * abx + (z - a.z) * abz) / (abx * abx + abz * abz), 0, 1);
      const dx = a.x + abx * u - x;
      const dz = a.z + abz * u - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        bi = i;
        bu = u;
      }
    }
    return { d: Math.sqrt(best), t: (bi + bu) / (n - 1) };
  }

  const inRect = (r: { x0: number; x1: number; z0: number; z1: number }, x: number, z: number, pad = 0) =>
    x > r.x0 - pad && x < r.x1 + pad && z > r.z0 - pad && z < r.z1 + pad;
  const rectDist = (r: { x0: number; x1: number; z0: number; z1: number }, x: number, z: number) =>
    Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.z0 - z, 0, z - r.z1));

  // ---------- Ground height ----------
  const parkGround = (x: number, z: number) =>
    PARK_H + 0.35 * fbm(x / 70, z / 70, SEED) + 0.6 * Math.max(0, fbm(x / 35, z / 35, SEED + 9));

  function heightAt(x: number, z: number): number {
    const top = beachTopZ(x);
    const coast = coastZ(x);
    let h: number;
    if (z > top) {
      // Beach falls gently to the waterline, then the seabed shelves away.
      if (z < coast) h = lerp(PARK_H - 0.1, 0.05, smoothstep(top, coast, z) ** 0.8);
      else h = -1.3 * smoothstep(0, 28, z - coast) - 3 * smoothstep(28, 140, z - coast);
      h += 0.12 * (valueNoise(x / 9, z / 9, SEED + 4) - 0.5);
    } else {
      h = parkGround(x, z);
      // Flatten the ground under the road, the path and the carparks.
      const flat = PARK_H + 0.1;
      const r = nearestRoad(x, z).d;
      h = lerp(flat, h, smoothstep(ROAD_HALF + 0.5, ROAD_HALF + 6, r));
      h = lerp(flat, h, smoothstep(PATH_HALF + 0.5, PATH_HALF + 4, Math.abs(z - pathZ(x))));
      for (const c of CARPARKS) h = lerp(flat, h, smoothstep(0.5, 5, rectDist(c, x, z)));
      h = lerp(flat, h, smoothstep(0.5, 5, rectDist({ x0: HAWKER.x - HAWKER.w / 2, x1: HAWKER.x + HAWKER.w / 2, z0: HAWKER.z - HAWKER.d / 2, z1: HAWKER.z + HAWKER.d / 2 }, x, z)));
      // North of the fence: level ground for the expressway and the estate.
      h = lerp(h, PARK_H + 0.2, smoothstep(FENCE_Z + 4, FENCE_Z - 4, z));
      // The lagoon is a shallow concrete basin.
      if (inRect(LAGOON, x, z, 3)) {
        const edge = smoothstep(0, 3, rectDist(LAGOON, x, z));
        h = lerp(LAGOON.level - 0.7, h, edge);
      }
    }
    return h;
  }

  const waterLevelAt = (x: number, z: number) => (inRect(LAGOON, x, z) ? LAGOON.level : 0);

  // Sand gets softer toward the water, and much softer around Camp Area G,
  // so momentum and low range matter there.
  const campG = CAMPS[1];
  function surfaceAt(x: number, z: number, y: number): Surface {
    if (y < waterLevelAt(x, z) - 0.05) return SURFACES.water;
    if (z > beachTopZ(x) - 1) {
      const toWater = smoothstep(beachTopZ(x), coastZ(x), z);
      const nearG = 1 - smoothstep(30, 90, Math.abs(x - campG.x));
      const drag = 10 + 22 * toWater + 18 * nearG;
      return { name: drag > 32 ? 'Soft sand' : 'Sand', grip: 0.62 - 0.1 * nearG, drag };
    }
    if (nearestRoad(x, z).d < ROAD_HALF + 0.3) return SURFACES.asphalt;
    if (Math.abs(z - pathZ(x)) < PATH_HALF + 0.2) return SURFACES.asphalt;
    for (const c of CARPARKS) if (inRect(c, x, z)) return SURFACES.asphalt;
    return SURFACES.grass;
  }

  // ---------- Terrain, built in chunks that share their edge vertices ----------
  const groundMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  const C = {
    grass: new THREE.Color(0.24, 0.46, 0.17),
    grassDry: new THREE.Color(0.4, 0.5, 0.22),
    sand: new THREE.Color(0.93, 0.86, 0.68),
    wetSand: new THREE.Color(0.72, 0.64, 0.48),
    seabed: new THREE.Color(0.55, 0.6, 0.5),
    hard: new THREE.Color(0.62, 0.62, 0.6),
    lagoonFloor: new THREE.Color(0.5, 0.65, 0.66),
  };
  const col = new THREE.Color();
  const cols = Math.round((X1 - X0) / STEP);
  const rows = Math.round((Z1 - Z0) / STEP);
  const perChunk = Math.ceil(cols / CHUNKS);
  for (let ci = 0; ci < CHUNKS; ci++) {
    const c0 = ci * perChunk;
    const c1 = Math.min(cols, c0 + perChunk);
    const w = c1 - c0 + 1;
    const h = rows + 1;
    const pos = new Float32Array(w * h * 3);
    const clr = new Float32Array(w * h * 3);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const x = X0 + (c0 + i) * STEP;
        const z = Z0 + j * STEP;
        const y = heightAt(x, z);
        const k = (j * w + i) * 3;
        pos[k] = x;
        pos[k + 1] = y;
        pos[k + 2] = z;
        const top = beachTopZ(x);
        if (z > top) {
          col.copy(C.sand).lerp(C.wetSand, smoothstep(coastZ(x) - 6, coastZ(x), z));
          if (y < -0.1) col.lerp(C.seabed, smoothstep(-0.1, -1.5, y));
        } else if (inRect(LAGOON, x, z)) {
          col.copy(C.lagoonFloor);
        } else {
          col.copy(C.grass).lerp(C.grassDry, valueNoise(x / 25, z / 25, SEED + 2) * 0.6);
          col.lerp(C.sand, smoothstep(top - 4, top, z));
          // Worn grass beside the road and path, and the paved estate north of the fence.
          if (z < FENCE_Z - 2) col.copy(C.hard);
        }
        const v = 0.9 + 0.2 * valueNoise(x / 3.3, z / 3.3, SEED + 11);
        clr[k] = col.r * v;
        clr[k + 1] = col.g * v;
        clr[k + 2] = col.b * v;
      }
    }
    const idx = new Uint32Array((w - 1) * (h - 1) * 6);
    let q = 0;
    for (let j = 0; j < h - 1; j++) {
      for (let i = 0; i < w - 1; i++) {
        const a = j * w + i;
        idx.set([a, a + w, a + 1, a + 1, a + w, a + w + 1], q);
        q += 6;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(clr, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, groundMat);
    mesh.receiveShadow = true;
    scene.add(mesh);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(RAPIER.ColliderDesc.trimesh(pos, idx).setFriction(0.9), body);
  }

  // ---------- Play boundaries (invisible walls) ----------
  const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const wall = (x: number, z: number, hx: number, hz: number, rotY = 0) => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, 4, hz).setTranslation(x, PARK_H + 2, z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
      fixed,
    );
  };
  wall(0, FENCE_Z - 1, END_X + 20, 0.5);
  wall(-END_X, -20, 0.5, 200);
  wall(END_X, -20, 0.5, 200);
  for (let x = -END_X; x < END_X; x += 40) {
    const z0 = coastZ(x) + 26;
    const z1 = coastZ(x + 40) + 26;
    wall(x + 20, (z0 + z1) / 2, 21, 0.5, -Math.atan2(z1 - z0, 40));
  }

  // ---------- Ribbons: road, lane markings, jogging path ----------
  const ribbon = (pts: THREE.Vector3[], half: number, lift: number, color: number, dashed = false) => {
    const verts: number[] = [];
    const ids: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const tx = b.x - a.x;
      const tz = b.z - a.z;
      const tl = Math.hypot(tx, tz) || 1;
      const nx = -tz / tl;
      const nz = tx / tl;
      const p = pts[i];
      for (const s of [-1, 1]) {
        const x = p.x + nx * half * s;
        const z = p.z + nz * half * s;
        verts.push(x, heightAt(x, z) + lift, z);
      }
      if (i > 0 && (!dashed || i % 4 < 2)) {
        const k = i * 2;
        ids.push(k - 2, k - 1, k, k - 1, k + 1, k);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setIndex(ids);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 }));
    m.receiveShadow = true;
    scene.add(m);
  };
  ribbon(road, ROAD_HALF, 0.04, 0x4a4c50);
  ribbon(road, 0.08, 0.06, 0xf2efe4, true);
  ribbon(road.map((p) => p.clone()), ROAD_HALF + 0.35, 0.02, 0xb9b5aa); // kerb edge
  const pathPts: THREE.Vector3[] = [];
  for (let x = -1060; x <= 1060; x += 2) pathPts.push(new THREE.Vector3(x, 0, pathZ(x)));
  ribbon(pathPts, PATH_HALF, 0.04, 0xa45b49); // red cycling/jogging track
  ribbon(pathPts, 0.06, 0.06, 0xf2efe4, true);

  // Carparks: asphalt slab + white bay lines.
  const lotMat = new THREE.MeshStandardMaterial({ color: 0x55575b, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 });
  const lineGeos: THREE.BufferGeometry[] = [];
  for (const c of CARPARKS) {
    const lot = new THREE.Mesh(new THREE.PlaneGeometry(c.x1 - c.x0, c.z1 - c.z0), lotMat);
    lot.rotation.x = -Math.PI / 2;
    lot.position.set((c.x0 + c.x1) / 2, PARK_H + 0.14, (c.z0 + c.z1) / 2);
    lot.receiveShadow = true;
    scene.add(lot);
    for (let x = c.x0 + 2; x < c.x1 - 2; x += 2.6) {
      for (const zc of [c.z0 + 3, c.z1 - 3]) {
        const l = new THREE.PlaneGeometry(0.12, 5);
        l.rotateX(-Math.PI / 2);
        l.translate(x, PARK_H + 0.17, zc);
        lineGeos.push(l);
      }
    }
  }
  scene.add(new THREE.Mesh(mergeGeometries(lineGeos), new THREE.MeshBasicMaterial({ color: 0xeeeeee })));

  // ---------- Sea and lagoon ----------
  const wind = { value: 0 };
  const seaGeo = new THREE.PlaneGeometry(5200, 2600, 200, 80);
  seaGeo.rotateX(-Math.PI / 2);
  seaGeo.translate(0, 0, 1300 - 30);
  const seaMat = new THREE.MeshStandardMaterial({ color: 0x2f7c86, roughness: 0.22, metalness: 0.15, transparent: true, opacity: 0.88 });
  seaMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = wind;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         float wv = sin(position.x * 0.045 + uTime * 0.9) * 0.12 + sin(position.z * 0.07 - uTime * 1.3 + position.x * 0.01) * 0.1;
         transformed.y += wv;`,
      );
  };
  const sea = new THREE.Mesh(seaGeo, seaMat);
  sea.receiveShadow = true;
  scene.add(sea);
  const lagoon = new THREE.Mesh(
    new THREE.PlaneGeometry(LAGOON.x1 - LAGOON.x0, LAGOON.z1 - LAGOON.z0),
    new THREE.MeshStandardMaterial({ color: 0x3f8f96, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.85 }),
  );
  lagoon.rotation.x = -Math.PI / 2;
  lagoon.position.set((LAGOON.x0 + LAGOON.x1) / 2, LAGOON.level, (LAGOON.z0 + LAGOON.z1) / 2);
  scene.add(lagoon);

  // ---------- Helpers for instanced, chunked, wind-swayed vegetation ----------
  const tint = (g: THREE.BufferGeometry, c: number) => {
    const color = new THREE.Color(c);
    const n2 = g.attributes.position.count;
    const arr = new Float32Array(n2 * 3);
    for (let i = 0; i < n2; i++) color.toArray(arr, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  };
  const merge = (parts: THREE.BufferGeometry[]) => {
    const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
    g.computeVertexNormals();
    return g;
  };
  const swayMat = (strength: number, opts: THREE.MeshStandardMaterialParameters = {}) => {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true, ...opts });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = wind;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           #ifdef USE_INSTANCING
             vec3 ip = instanceMatrix[3].xyz;
           #else
             vec3 ip = vec3(0.0);
           #endif
           float hgt = max(position.y, 0.0);
           float gust = 0.6 + 0.4 * sin(uTime * 0.37 + ip.x * 0.01);
           transformed.x += sin(uTime * 1.6 + ip.x * 0.11 + ip.z * 0.07) * ${strength.toFixed(4)} * hgt * gust;
           transformed.z += cos(uTime * 1.2 + ip.x * 0.05) * ${(strength * 0.6).toFixed(4)} * hgt * gust;`,
        );
    };
    return m;
  };
  const plainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });

  // Species geometry (origin at the base).
  const rainTree = merge([
    tint(new THREE.CylinderGeometry(0.28, 0.45, 5, 6).translate(0, 2.5, 0), 0x5b4636),
    tint(new THREE.IcosahedronGeometry(1, 1).scale(4.6, 1.5, 4.6).translate(0, 6, 0), 0xffffff),
    tint(new THREE.IcosahedronGeometry(1, 1).scale(3.2, 1.2, 3.2).translate(1.6, 6.9, 0.8), 0xffffff),
  ]);
  const frond = (a: number) =>
    tint(new THREE.BoxGeometry(3.4, 0.08, 0.7).translate(1.7, 0, 0).rotateZ(-0.45).rotateY(a).translate(0, 8, 0), 0xffffff);
  const palm = merge([
    tint(new THREE.CylinderGeometry(0.18, 0.28, 8, 6).translate(0, 4, 0), 0x8a7356),
    ...Array.from({ length: 8 }, (_, i) => frond((i / 8) * Math.PI * 2 + 0.2)),
    tint(new THREE.IcosahedronGeometry(0.45, 0).translate(0, 7.8, 0), 0x6b5a2e),
  ]);
  const casuarina = merge([
    tint(new THREE.CylinderGeometry(0.15, 0.3, 3, 5).translate(0, 1.5, 0), 0x5b4636),
    tint(new THREE.ConeGeometry(1.8, 9, 7).translate(0, 7, 0), 0xffffff),
  ]);
  const seaAlmond = merge([
    tint(new THREE.CylinderGeometry(0.22, 0.35, 6, 6).translate(0, 3, 0), 0x5b4636),
    tint(new THREE.CylinderGeometry(3.6, 3.8, 0.6, 8).translate(0, 4.2, 0), 0xffffff),
    tint(new THREE.CylinderGeometry(2.6, 2.8, 0.6, 8).translate(0, 5.4, 0), 0xffffff),
    tint(new THREE.CylinderGeometry(1.5, 1.7, 0.6, 8).translate(0, 6.5, 0), 0xffffff),
  ]);
  const shrub = new THREE.IcosahedronGeometry(1, 1);
  tint(shrub, 0xffffff);
  const grassClump = new THREE.ConeGeometry(0.16, 0.6, 4);
  tint(grassClump, 0x7a9a40);

  interface Kind {
    geo: THREE.BufferGeometry;
    mat: THREE.Material;
    shadow: boolean;
    collide?: number; // trunk radius
    hues?: [number, number, number, number]; // h, s, l, jitter
  }
  const kinds: Record<string, Kind> = {
    rain: { geo: rainTree, mat: swayMat(0.012), shadow: true, collide: 0.45, hues: [0.27, 0.42, 0.34, 0.05] },
    palm: { geo: palm, mat: swayMat(0.02), shadow: true, collide: 0.3, hues: [0.22, 0.5, 0.38, 0.04] },
    casuarina: { geo: casuarina, mat: swayMat(0.015), shadow: true, collide: 0.3, hues: [0.3, 0.35, 0.3, 0.03] },
    almond: { geo: seaAlmond, mat: swayMat(0.01), shadow: true, collide: 0.35, hues: [0.25, 0.45, 0.36, 0.06] },
    shrub: { geo: shrub, mat: swayMat(0.02), shadow: false, hues: [0.27, 0.45, 0.3, 0.05] },
    flowers: { geo: shrub, mat: swayMat(0.02), shadow: false, hues: [0.92, 0.6, 0.6, 0.04] },
    grass: { geo: grassClump, mat: plainMat, shadow: false },
  };
  type Placement = { x: number; y: number; z: number; s: number; r: number };
  const placements: Record<string, Placement[][]> = {};
  for (const k of Object.keys(kinds)) placements[k] = Array.from({ length: CHUNKS }, () => []);
  const chunkOf = (x: number) => clamp(Math.floor(((x - X0) / (X1 - X0)) * CHUNKS), 0, CHUNKS - 1);
  const put = (kind: string, x: number, z: number, s: number) => {
    placements[kind][chunkOf(x)].push({ x, y: heightAt(x, z), z, s, r: rand() * Math.PI * 2 });
  };

  // Keep-clear test for anything solid.
  const blocked = (x: number, z: number, pad: number) => {
    if (nearestRoad(x, z).d < ROAD_HALF + pad) return true;
    if (Math.abs(z - pathZ(x)) < PATH_HALF + pad) return true;
    if (CARPARKS.some((c) => inRect(c, x, z, pad))) return true;
    if (inRect(LAGOON, x, z, pad + 2)) return true;
    if (Math.abs(x - HAWKER.x) < HAWKER.w / 2 + pad + 2 && Math.abs(z - HAWKER.z) < HAWKER.d / 2 + pad + 2) return true;
    if (Math.abs(x - JETTY.x) < pad + 4 && z > beachTopZ(x) - 6) return true;
    return false;
  };

  const VEG_X = 1060; // scenery continues past the play boundary
  // Palms and casuarinas line the beach edge; rain trees and sea almonds
  // shade the park, clustered so there are groves and open lawns.
  for (let x = -VEG_X; x < VEG_X; x += 7 + rand() * 6) {
    const z = pathZ(x) + (rand() < 0.5 ? -1 : 1) * (PATH_HALF + 2 + rand() * 4);
    if (!blocked(x, z, 1.5)) put(rand() < 0.65 ? 'palm' : 'casuarina', x, z, 0.85 + rand() * 0.4);
  }
  for (let x = -VEG_X; x < VEG_X; x += 9 + rand() * 10) {
    const z = beachTopZ(x) + 2 + rand() * 6;
    if (!blocked(x, z, 1.5) && Math.abs(x - campG.x) > 20) put('casuarina', x, z, 0.8 + rand() * 0.5);
  }
  for (let i = 0; i < 12000; i++) {
    const x = -VEG_X + rand() * VEG_X * 2;
    const z = FENCE_Z + 3 + rand() * (pathZ(x) - FENCE_Z - 6);
    const grove = valueNoise(x / 60, z / 60, SEED + 21);
    if (grove < 0.45) continue;
    if (blocked(x, z, 4)) continue;
    if (rand() > 0.16) continue;
    put(rand() < 0.7 ? 'rain' : 'almond', x, z, 0.8 + rand() * 0.5);
  }
  // Hedge along the fence (also hides where the play area ends).
  for (let x = -VEG_X; x < VEG_X; x += 2.2) put('shrub', x, FENCE_Z + 1 + rand(), 1.1 + rand() * 0.5);
  for (let i = 0; i < 11000; i++) {
    const x = -VEG_X + rand() * VEG_X * 2;
    const z = FENCE_Z + 3 + rand() * (beachTopZ(x) - FENCE_Z - 2);
    if (blocked(x, z, 1)) continue;
    const r = rand();
    if (r < 0.12) put(rand() < 0.3 ? 'flowers' : 'shrub', x, z, 0.5 + rand() * 0.7);
    else if (r < 0.5) put('grass', x, z, 0.7 + rand() * 0.7);
  }

  const dummy = new THREE.Object3D();
  const hsl = new THREE.Color();
  for (const [name, kind] of Object.entries(kinds)) {
    for (const list of placements[name]) {
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(kind.geo, kind.mat, list.length);
      list.forEach((p, i) => {
        dummy.position.set(p.x, p.y - 0.05, p.z);
        dummy.rotation.set(0, p.r, 0);
        if (name === 'shrub' || name === 'flowers') dummy.scale.set(p.s * 1.3, p.s * 0.8, p.s * 1.3);
        else dummy.scale.setScalar(p.s);
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
        if (kind.hues) {
          const [hh, ss, ll, j] = kind.hues;
          hsl.setHSL(hh + (rand() - 0.5) * j, ss + (rand() - 0.5) * 0.1, ll + (rand() - 0.5) * 0.1);
          im.setColorAt(i, hsl);
        }
        if (kind.collide) {
          const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(p.x, p.y + 1.5, p.z));
          world.createCollider(RAPIER.ColliderDesc.cylinder(1.5, kind.collide * p.s), b);
        }
      });
      im.castShadow = kind.shadow;
      im.receiveShadow = !kind.shadow;
      im.computeBoundingSphere();
      scene.add(im);
    }
  }

  // ---------- Groynes: rock breakwaters into the sea ----------
  const rockGeo = new THREE.IcosahedronGeometry(1, 0);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x8b857c, roughness: 1, flatShading: true });
  const rockSpots: Placement[] = [];
  for (const gx of GROYNES) {
    for (let d = -4; d < 32; d += 1.6) {
      const x = gx + (rand() - 0.5) * 2.5;
      const z = coastZ(gx) + d;
      const s = 0.9 + rand() * 0.9;
      rockSpots.push({ x, z, y: heightAt(x, z) + s * 0.3, s, r: rand() * 6 });
    }
  }
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockSpots.length);
  rockSpots.forEach((p, i) => {
    dummy.position.set(p.x, p.y, p.z);
    dummy.rotation.set(p.r, p.r * 2, 0);
    dummy.scale.setScalar(p.s);
    dummy.updateMatrix();
    rocks.setMatrixAt(i, dummy.matrix);
    const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(p.x, p.y, p.z));
    world.createCollider(RAPIER.ColliderDesc.ball(p.s * 0.9), b);
  });
  rocks.castShadow = rocks.receiveShadow = true;
  scene.add(rocks);

  // ---------- Park furniture: lamp posts, benches, shelters ----------
  const furniture: THREE.BufferGeometry[] = [];
  const addAt = (g: THREE.BufferGeometry, x: number, z: number, rot = 0, lift = 0) => {
    furniture.push(g.clone().rotateY(rot).translate(x, heightAt(x, z) + lift, z));
  };
  const lamp = merge([
    tint(new THREE.CylinderGeometry(0.07, 0.1, 6, 6).translate(0, 3, 0), 0x3c4146),
    tint(new THREE.BoxGeometry(1.2, 0.08, 0.08).translate(0.55, 5.95, 0), 0x3c4146),
    tint(new THREE.BoxGeometry(0.5, 0.15, 0.3).translate(1.1, 5.85, 0), 0xf3ead2),
  ]);
  const bench = merge([
    tint(new THREE.BoxGeometry(1.8, 0.08, 0.45).translate(0, 0.45, 0), 0x7a5a3a),
    tint(new THREE.BoxGeometry(1.8, 0.4, 0.06).translate(0, 0.75, -0.2), 0x7a5a3a),
    tint(new THREE.BoxGeometry(0.08, 0.45, 0.45).translate(-0.8, 0.22, 0), 0x3c4146),
    tint(new THREE.BoxGeometry(0.08, 0.45, 0.45).translate(0.8, 0.22, 0), 0x3c4146),
  ]);
  const shelter = merge([
    ...[[-2.2, -2.2], [2.2, -2.2], [-2.2, 2.2], [2.2, 2.2]].map(([px, pz]) =>
      tint(new THREE.CylinderGeometry(0.12, 0.12, 2.6, 6).translate(px, 1.3, pz), 0xe8e2d4)),
    tint(new THREE.ConeGeometry(4, 1.6, 4).rotateY(Math.PI / 4).translate(0, 3.4, 0), 0xa8553a),
    tint(new THREE.BoxGeometry(2.2, 0.08, 1).translate(0, 0.75, 0), 0x7a5a3a),
  ]);
  for (let i = 0; i < n; i += 15) {
    const p = road[i];
    const q = road[Math.min(n - 1, i + 1)];
    const ang = Math.atan2(-(q.z - p.z), q.x - p.x);
    const side = i % 30 === 0 ? 1 : -1;
    const nx = -(q.z - p.z);
    const nz = q.x - p.x;
    const nl = Math.hypot(nx, nz) || 1;
    addAt(lamp, p.x + (nx / nl) * (ROAD_HALF + 1.2) * side, p.z + (nz / nl) * (ROAD_HALF + 1.2) * side, ang + (side > 0 ? Math.PI / 2 : -Math.PI / 2));
  }
  for (let x = -END_X + 10; x < END_X; x += 26 + rand() * 30) {
    const z = pathZ(x) - PATH_HALF - 1.2;
    if (!blocked(x, z, 0.2)) addAt(bench, x, z, Math.PI);
  }
  const shelterSpots: XZ[] = [];
  for (let x = -END_X + 60; x < END_X; x += 110 + rand() * 60) {
    const z = pathZ(x) - 14 - rand() * 10;
    if (blocked(x, z, 6)) continue;
    addAt(shelter, x, z, rand());
    shelterSpots.push([x, z]);
    const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, heightAt(x, z) + 1.3, z));
    for (const [px, pz] of [[-2.2, -2.2], [2.2, -2.2], [-2.2, 2.2], [2.2, 2.2]])
      world.createCollider(RAPIER.ColliderDesc.cylinder(1.3, 0.15).setTranslation(px, 0, pz), b);
  }
  const furnitureMesh = new THREE.Mesh(mergeGeometries(furniture), plainMat);
  furnitureMesh.castShadow = furnitureMesh.receiveShadow = true;
  scene.add(furnitureMesh);

  // ---------- Parked cars ----------
  const carGeo = merge([
    tint(new THREE.BoxGeometry(4.2, 0.75, 1.75).translate(0, 0.6, 0), 0xffffff),
    tint(new THREE.BoxGeometry(2.3, 0.6, 1.6).translate(-0.2, 1.25, 0), 0x2a3640),
    ...[[-1.35, -0.8], [1.35, -0.8], [-1.35, 0.8], [1.35, 0.8]].map(([px, pz]) =>
      tint(new THREE.CylinderGeometry(0.33, 0.33, 0.25, 10).rotateX(Math.PI / 2).translate(px, 0.33, pz), 0x1c1c1c)),
  ]);
  const carColors = [0xf2f2f2, 0xc9ccd1, 0x23262b, 0x8e1f24, 0x2f4f7a, 0xd9cdb0, 0x6d7470];
  const carSpots: { x: number; z: number; r: number }[] = [];
  for (const c of CARPARKS) {
    for (let x = c.x0 + 3.3; x < c.x1 - 2; x += 2.6) {
      for (const zc of [c.z0 + 3, c.z1 - 3]) if (rand() < 0.55) carSpots.push({ x, z: zc, r: Math.PI / 2 + (rand() - 0.5) * 0.06 });
    }
  }
  const cars = new THREE.InstancedMesh(carGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.2 }), carSpots.length);
  carSpots.forEach((p, i) => {
    dummy.position.set(p.x, PARK_H + 0.14, p.z);
    dummy.rotation.set(0, p.r, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    cars.setMatrixAt(i, dummy.matrix);
    cars.setColorAt(i, new THREE.Color(carColors[Math.floor(rand() * carColors.length)]));
    const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(p.x, PARK_H + 0.9, p.z).setRotation({ x: 0, y: Math.sin(p.r / 2), z: 0, w: Math.cos(p.r / 2) }));
    world.createCollider(RAPIER.ColliderDesc.cuboid(2.1, 0.75, 0.88), b);
  });
  cars.castShadow = true;
  scene.add(cars);

  // ---------- Lagoon Food Village (hawker centre) ----------
  {
    const g: THREE.BufferGeometry[] = [];
    const { x, z, w, d } = HAWKER;
    for (let px = -w / 2 + 1; px <= w / 2 - 1; px += 5.5)
      for (const pz of [-d / 2 + 1, d / 2 - 1]) g.push(tint(new THREE.CylinderGeometry(0.25, 0.25, 4.5, 8).translate(px, 2.25, pz), 0xe9e4d8));
    g.push(tint(new THREE.CylinderGeometry(1, Math.SQRT2 * 1, 1, 4, 1).rotateY(Math.PI / 4).scale(w * 0.62, 3.2, d * 0.7).translate(0, 6.1, 0), 0xb4583a));
    g.push(tint(new THREE.BoxGeometry(w + 1, 0.35, d + 1).translate(0, 4.55, 0), 0xf0ebe0));
    for (let px = -w / 2 + 4; px < w / 2 - 3; px += 4)
      for (let pz = -d / 2 + 4; pz < d / 2 - 3; pz += 3.5) {
        g.push(tint(new THREE.CylinderGeometry(0.7, 0.7, 0.08, 10).translate(px, 0.75, pz), 0xd9d4c6));
        g.push(tint(new THREE.CylinderGeometry(0.08, 0.08, 0.75, 6).translate(px, 0.37, pz), 0x6d6d6d));
      }
    // A row of stalls along the back.
    for (let px = -w / 2 + 2; px < w / 2 - 2; px += 3.2)
      g.push(tint(new THREE.BoxGeometry(3, 2.4, 2.2).translate(px + 1.5, 1.2, -d / 2 + 2.2), [0xf4d35e, 0x7fb3d5, 0xe07a5f, 0x81b29a][Math.floor(rand() * 4)]));
    const m = new THREE.Mesh(merge(g), plainMat);
    m.position.set(x, PARK_H + 0.1, z);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, PARK_H + 2.5, z));
    world.createCollider(RAPIER.ColliderDesc.cuboid(w / 2, 2.5, d / 2), b);
  }

  // ---------- Bedok Jetty ----------
  {
    const g: THREE.BufferGeometry[] = [];
    const startZ = beachTopZ(JETTY.x) + 8;
    g.push(tint(new THREE.BoxGeometry(JETTY.w, 0.4, JETTY.len).translate(0, JETTY.deck, startZ + JETTY.len / 2), 0xd8d2c4));
    for (let dz = 4; dz < JETTY.len; dz += 8)
      for (const px of [-JETTY.w / 2 + 0.3, JETTY.w / 2 - 0.3]) {
        g.push(tint(new THREE.CylinderGeometry(0.25, 0.25, 7, 6).translate(px, JETTY.deck - 3.5, startZ + dz), 0xb8b2a4));
        g.push(tint(new THREE.BoxGeometry(0.1, 1, 0.1).translate(px, JETTY.deck + 0.7, startZ + dz), 0xe8e4da));
      }
    // Rails and the shelter at the end.
    for (const px of [-JETTY.w / 2 + 0.05, JETTY.w / 2 - 0.05])
      g.push(tint(new THREE.BoxGeometry(0.08, 0.08, JETTY.len).translate(px, JETTY.deck + 1.2, startZ + JETTY.len / 2), 0xe8e4da));
    g.push(tint(new THREE.ConeGeometry(5, 2, 4).rotateY(Math.PI / 4).translate(0, JETTY.deck + 4, startZ + JETTY.len - 4), 0x2f6f73));
    const m = new THREE.Mesh(merge(g), plainMat);
    m.position.x = JETTY.x;
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    // Solid from the seabed to the deck so it reads as a wall, not a ramp.
    const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(JETTY.x, JETTY.deck - 2, startZ + JETTY.len / 2));
    world.createCollider(RAPIER.ColliderDesc.cuboid(JETTY.w / 2, 2.2, JETTY.len / 2), b);
  }

  // ---------- East Coast Parkway (traffic comes later) ----------
  {
    const ecpZ = -98;
    const deck = new THREE.Mesh(new THREE.PlaneGeometry(X1 - X0, 30), new THREE.MeshStandardMaterial({ color: 0x46484c, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 }));
    deck.rotation.x = -Math.PI / 2;
    deck.position.set(0, PARK_H + 0.25, ecpZ);
    deck.receiveShadow = true;
    scene.add(deck);
    const marks: THREE.BufferGeometry[] = [];
    for (const lz of [-10, -5, 5, 10]) for (let x = X0; x < X1; x += 12) marks.push(new THREE.PlaneGeometry(4, 0.15).rotateX(-Math.PI / 2).translate(x, PARK_H + 0.28, ecpZ + lz));
    marks.push(new THREE.BoxGeometry(X1 - X0, 0.9, 0.5).translate(0, PARK_H + 0.7, ecpZ));
    scene.add(new THREE.Mesh(mergeGeometries(marks.map((m) => (m.index ? m.toNonIndexed() : m))), new THREE.MeshStandardMaterial({ color: 0xe8e6df })));
  }

  // ---------- Marine Parade HDB estate (generated) ----------
  {
    const tex = (() => {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 64;
      const g = c.getContext('2d')!;
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, 64, 64);
      g.fillStyle = '#9aa7b0';
      for (let y = 0; y < 64; y += 16) {
        g.fillRect(6, y + 5, 20, 7);
        g.fillRect(38, y + 5, 20, 7);
      }
      g.fillStyle = '#d8d8d8';
      for (let y = 0; y < 64; y += 16) g.fillRect(0, y + 14, 64, 2);
      const t = new THREE.CanvasTexture(c);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      return t;
    })();
    const walls: THREE.BufferGeometry[] = [];
    const roofs: THREE.BufferGeometry[] = [];
    const palette = [0xf3e9d2, 0xf6d8c4, 0xd8e6ef, 0xdcebd7, 0xe9e2f2, 0xf1f1ee];
    for (let row = 0; row < 4; row++) {
      for (let x = X0 + 40 + rand() * 30; x < X1 - 30; x += 70 + rand() * 50) {
        const z = -150 - row * 52 + (rand() - 0.5) * 16;
        const len = 40 + rand() * 30;
        const depth = 13;
        const floors = 10 + Math.floor(rand() * 16);
        const hgt = floors * 2.9;
        const rot = (rand() < 0.25 ? Math.PI / 2 : 0) + (rand() - 0.5) * 0.2;
        const color = palette[Math.floor(rand() * palette.length)];
        const box = new THREE.BoxGeometry(len, hgt, depth);
        // Tile the window texture: one tile = 2 bays wide (12 m) x 4 floors.
        const uv = box.attributes.uv as THREE.BufferAttribute;
        const nrm = box.attributes.normal as THREE.BufferAttribute;
        for (let i = 0; i < uv.count; i++) {
          const nx = Math.abs(nrm.getX(i));
          const ny = Math.abs(nrm.getY(i));
          const across = ny > 0.5 ? 0 : nx > 0.5 ? depth : len;
          uv.setXY(i, uv.getX(i) * (across / 12), uv.getY(i) * (ny > 0.5 ? 0 : floors / 4));
        }
        box.translate(0, hgt / 2, 0).rotateY(rot).translate(x, PARK_H + 0.2, z);
        walls.push(tint(box, color));
        roofs.push(tint(new THREE.BoxGeometry(len * 0.3, 3, depth * 0.6).translate(len * 0.2, hgt + 1.5, 0).rotateY(rot).translate(x, PARK_H + 0.2, z), 0x8d8f91));
        roofs.push(tint(new THREE.BoxGeometry(len + 0.6, 0.6, depth + 0.6).translate(0, hgt + 0.3, 0).rotateY(rot).translate(x, PARK_H + 0.2, z), 0xb7563c));
      }
    }
    const wallMesh = new THREE.Mesh(mergeGeometries(walls.map((g) => g.toNonIndexed())), new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 0.85 }));
    const roofMesh = new THREE.Mesh(mergeGeometries(roofs.map((g) => g.toNonIndexed())), plainMat);
    wallMesh.castShadow = roofMesh.castShadow = true;
    wallMesh.receiveShadow = true;
    scene.add(wallMesh, roofMesh);
  }

  // ---------- Ships at anchor in the strait ----------
  const shipGeo = merge([
    tint(new THREE.BoxGeometry(120, 10, 20).translate(0, 4, 0), 0x6b2f2a),
    tint(new THREE.BoxGeometry(120, 2, 20).translate(0, 10, 0), 0x2b2f33),
    tint(new THREE.BoxGeometry(14, 14, 16).translate(-48, 18, 0), 0xf0f0f0),
    ...Array.from({ length: 5 }, (_, i) =>
      tint(new THREE.BoxGeometry(12, 6 + (i % 3) * 2, 18).translate(-24 + i * 14, 14 + (i % 3), 0), [0x2f5d8a, 0xb5562f, 0x3f7a4a, 0xc9a227][i % 4])),
  ]);
  const shipCount = 26;
  const ships = new THREE.InstancedMesh(shipGeo, plainMat, shipCount);
  const shipBase: { x: number; z: number; r: number; s: number }[] = [];
  for (let i = 0; i < shipCount; i++) shipBase.push({ x: -2400 + rand() * 4800, z: 450 + rand() * 1700, r: rand() * Math.PI, s: 0.6 + rand() * 0.8 });
  const placeShips = (time: number) => {
    shipBase.forEach((s, i) => {
      dummy.position.set(s.x, Math.sin(time * 0.3 + i) * 0.4 - 1, s.z);
      dummy.rotation.set(Math.sin(time * 0.25 + i) * 0.01, s.r, 0);
      dummy.scale.setScalar(s.s);
      dummy.updateMatrix();
      ships.setMatrixAt(i, dummy.matrix);
    });
    ships.instanceMatrix.needsUpdate = true;
  };
  placeShips(0);
  ships.computeBoundingSphere();
  scene.add(ships);

  // ---------- Course API ----------
  const poseAt = (t: number) => {
    const i = clamp(Math.floor(t * (n - 1)), 0, n - 2);
    const a = road[i];
    const b = road[i + 1];
    return { pos: new THREE.Vector3(a.x, heightAt(a.x, a.z), a.z), yaw: Math.atan2(-(b.z - a.z), b.x - a.x) };
  };
  const startPose = poseAt(0.04);

  const coastLine: XZ[] = [];
  for (let x = X0; x <= X1; x += 20) coastLine.push([x, coastZ(x)]);
  const beachLine: XZ[] = [];
  for (let x = X0; x <= X1; x += 20) beachLine.push([x, beachTopZ(x)]);
  const rectPts = (r: { x0: number; x1: number; z0: number; z1: number }): XZ[] => [[r.x0, r.z0], [r.x1, r.z0], [r.x1, r.z1], [r.x0, r.z1]];
  const map: MapData = {
    bounds: { minX: X0, maxX: X1, minZ: Z0, maxZ: Z1 },
    background: '#86b46a',
    areas: [
      { pts: [...beachLine, [X1, Z1], [X0, Z1]], color: '#ead9a8' },
      { pts: [...coastLine, [X1, Z1], [X0, Z1]], color: '#5aa3b0' },
      { pts: [[X0, FENCE_Z], [X1, FENCE_Z], [X1, Z0], [X0, Z0]], color: '#c9c6bd' },
      { pts: rectPts({ x0: X0, x1: X1, z0: -113, z1: -83 }), color: '#8c8d90' },
      { pts: rectPts(LAGOON), color: '#5aa3b0' },
      ...CARPARKS.map((c) => ({ pts: rectPts(c), color: '#9a9b9e' })),
      { pts: rectPts({ x0: HAWKER.x - HAWKER.w / 2, x1: HAWKER.x + HAWKER.w / 2, z0: HAWKER.z - HAWKER.d / 2, z1: HAWKER.z + HAWKER.d / 2 }), color: '#c0643f' },
      { pts: rectPts({ x0: JETTY.x - 3, x1: JETTY.x + 3, z0: beachTopZ(JETTY.x) + 8, z1: beachTopZ(JETTY.x) + 8 + JETTY.len }), color: '#e9e4d8' },
      ...shelterSpots.map(([x, z]) => ({ pts: rectPts({ x0: x - 3, x1: x + 3, z0: z - 3, z1: z + 3 }), color: '#b0644a' })),
    ],
    lines: [
      { pts: road.map((p) => [p.x, p.z] as XZ), width: 7, color: '#f4f1ea' },
      { pts: pathPts.filter((_, i) => i % 5 === 0).map((p) => [p.x, p.z] as XZ), width: 3, color: '#c27a66' },
    ],
    pois: [
      { x: JETTY.x, z: beachTopZ(JETTY.x) + 60, label: 'Bedok Jetty' },
      { x: HAWKER.x, z: HAWKER.z, label: 'Lagoon Food Village' },
      ...CARPARKS.map((c) => ({ x: (c.x0 + c.x1) / 2, z: (c.z0 + c.z1) / 2, label: 'P' })),
      ...CAMPS.map((c) => ({ x: c.x, z: beachTopZ(c.x) + 8, label: c.label })),
    ],
  };

  return {
    name: 'East Coast Park',
    start: startPose.pos.clone().setY(startPose.pos.y + 1.4),
    startYaw: startPose.yaw,
    heightAt,
    surfaceAt,
    zoneAt(x, z) {
      if (Math.abs(x - JETTY.x) < 40 && z > beachTopZ(x) - 20) return 'Bedok Jetty';
      if (Math.hypot(x - HAWKER.x, z - HAWKER.z) < 45) return 'Lagoon Food Village';
      for (const c of CAMPS) if (Math.abs(x - c.x) < 45 && z > pathZ(x) - 10) return c.label;
      if (inRect(LAGOON, x, z, 8)) return 'East Coast Lagoon';
      if (z > beachTopZ(x)) return 'Beach';
      return null;
    },
    poseAt,
    trackT: (x, z) => nearestRoad(x, z).t,
    map,
    sky: { background: 0xc9dbe6, fog: 0xd6dfe2, fogNear: 150, fogFar: 1700 },
    update(time) {
      wind.value = time;
      placeShips(time);
    },
  };
}
