import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { clamp, fbm, lerp, mulberry32, smoothstep, valueNoise } from './noise';

type Rapier = typeof RAPIER_NS;

// A hand-made test course in the spirit of Pulau Ubin: a gravel loop through
// low hills with a steep climb, a rock garden, a quarry-pond water crossing,
// a sand wash and an off-camber traverse. The road is a spline first and the
// terrain is conformed to it, so road and ground can never disagree, and the
// render mesh and physics mesh are built from the same vertices, so there are
// no seams or mismatches between what you see and what you drive on.

export interface Surface {
  name: string;
  /** Tyre friction coefficient (Rapier friction slip). */
  grip: number;
  /** Rolling resistance, applied as a light per-wheel brake. */
  drag: number;
}

export const SURFACES = {
  gravel: { name: 'Gravel', grip: 0.85, drag: 1.5 },
  dirt: { name: 'Dirt', grip: 0.8, drag: 2 },
  grass: { name: 'Grass', grip: 0.7, drag: 4 },
  rock: { name: 'Rock', grip: 1.05, drag: 1 },
  sand: { name: 'Sand', grip: 0.6, drag: 30 },
  mud: { name: 'Mud', grip: 0.5, drag: 22 },
  water: { name: 'Water', grip: 0.55, drag: 24 },
} satisfies Record<string, Surface>;

const SEED = 1965;
const SIZE = 300; // metres, square
const CELLS = 200; // grid cells per side (1.5 m spacing)
const HALF_WIDTH = 3.6; // gravel road half width
const SHOULDER = 7; // blend distance from road edge to natural ground

interface Zone {
  from: number;
  to: number;
  label: string;
}
const ZONES: Zone[] = [
  { from: 0.07, to: 0.17, label: 'Steep climb' },
  { from: 0.3, to: 0.38, label: 'Rock garden' },
  { from: 0.5, to: 0.6, label: 'Quarry crossing' },
  { from: 0.68, to: 0.8, label: 'Sand wash' },
  { from: 0.84, to: 0.94, label: 'Off-camber' },
];

export interface Course {
  start: THREE.Vector3;
  startYaw: number;
  waterLevel: number;
  heightAt(x: number, z: number): number;
  surfaceAt(x: number, z: number, y: number): Surface;
  zoneAt(x: number, z: number): string | null;
  /** Position (on the ground) and heading of the road at loop position t (0..1). */
  poseAt(t: number): { pos: THREE.Vector3; yaw: number };
  /** Loop position (0..1) of the nearest road point. */
  trackT(x: number, z: number): number;
}

interface TrackHit {
  d: number; // distance to the road centreline
  t: number; // 0..1 position along the loop
  side: number; // signed lateral offset (+ = right of travel)
  roadH: number;
}

function buildTrackPoints(): THREE.Vector3[] {
  // Control points for an irregular closed loop.
  const ctrl: [number, number][] = [
    [0, -95], [55, -88], [92, -55], [100, -5], [80, 40], [95, 80],
    [50, 100], [5, 75], [-30, 98], [-80, 85], [-100, 35], [-75, -10],
    [-98, -55], [-60, -92],
  ];
  const curve = new THREE.CatmullRomCurve3(
    ctrl.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    true,
    'centripetal',
  );
  return curve.getSpacedPoints(520).slice(0, 520);
}

export function buildCourse(scene: THREE.Scene, world: RAPIER_NS.World, RAPIER: Rapier): Course {
  const pts = buildTrackPoints();
  const n = pts.length;
  const at = (t: number) => pts[((Math.round(t * n) % n) + n) % n];
  const climb = at(0.12);
  const pond = at(0.55);

  const natural = (x: number, z: number) => {
    let h = 7 * fbm(x / 90, z / 90, SEED) + 1.8 * fbm(x / 22, z / 22, SEED + 7);
    const dc = Math.hypot(x - climb.x, z - climb.z);
    h += 9 * Math.exp(-(dc * dc) / (2 * 13 * 13));
    const dp = Math.hypot(x - pond.x, z - pond.z);
    h -= 3.2 * (1 - smoothstep(6, 24, dp));
    // Hills ringing the course keep the car inside the map.
    const edge = Math.max(Math.abs(x), Math.abs(z));
    h += 28 * smoothstep(122, 148, edge);
    return h;
  };

  // Road height = natural ground smoothed along the road.
  const raw = pts.map((p) => natural(p.x, p.z));
  const roadH = raw.map((_, i) => {
    let s = 0;
    for (let k = -5; k <= 5; k++) s += raw[(i + k + n) % n];
    return s / 11;
  });
  const waterLevel = roadH[Math.round(0.55 * n)] + 0.45;

  const camber = (t: number) => 0.22 * smoothstep(0.84, 0.86, t) * (1 - smoothstep(0.92, 0.94, t));

  function nearest(x: number, z: number): TrackHit {
    let best = Infinity;
    let bi = 0;
    let bu = 0;
    let bs = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const len2 = abx * abx + abz * abz;
      const u = clamp(((x - a.x) * abx + (z - a.z) * abz) / len2, 0, 1);
      const px = a.x + abx * u - x;
      const pz = a.z + abz * u - z;
      const d2 = px * px + pz * pz;
      if (d2 < best) {
        best = d2;
        bi = i;
        bu = u;
        // Right of travel direction (x,z) is (-z, x) in a y-up right-handed frame.
        bs = ((x - a.x) * -abz + (z - a.z) * abx) / Math.sqrt(len2);
      }
    }
    const h = lerp(roadH[bi], roadH[(bi + 1) % n], bu);
    return { d: Math.sqrt(best), t: (bi + bu) / n, side: bs, roadH: h };
  }

  function heightFrom(x: number, z: number, hit: TrackHit): number {
    const w = smoothstep(HALF_WIDTH, HALF_WIDTH + SHOULDER, hit.d);
    const road = hit.roadH + camber(hit.t) * hit.side;
    return lerp(road, natural(x, z), w);
  }

  const heightAt = (x: number, z: number) => heightFrom(x, z, nearest(x, z));

  function surfaceFrom(x: number, z: number, y: number, hit: TrackHit): Surface {
    if (y < waterLevel - 0.05 && Math.hypot(x - pond.x, z - pond.z) < 30) return SURFACES.water;
    if (hit.d < HALF_WIDTH + 0.6) {
      if (hit.t > 0.3 && hit.t < 0.38) return SURFACES.rock;
      if (hit.t > 0.68 && hit.t < 0.8) return SURFACES.sand;
      return SURFACES.gravel;
    }
    if (Math.hypot(x - pond.x, z - pond.z) < 26) return SURFACES.mud;
    return valueNoise(x / 14, z / 14, SEED + 3) > 0.62 ? SURFACES.dirt : SURFACES.grass;
  }

  // ---- Terrain mesh + physics (one set of vertices for both) ----
  const N = CELLS + 1;
  const step = SIZE / CELLS;
  const positions = new Float32Array(N * N * 3);
  const colors = new Float32Array(N * N * 3);
  const col = new THREE.Color();
  const palette: Record<string, THREE.Color> = {
    Gravel: new THREE.Color(0.66, 0.6, 0.5),
    Dirt: new THREE.Color(0.5, 0.38, 0.26),
    Grass: new THREE.Color(0.33, 0.5, 0.22),
    Rock: new THREE.Color(0.55, 0.52, 0.48),
    Sand: new THREE.Color(0.88, 0.8, 0.62),
    Mud: new THREE.Color(0.36, 0.3, 0.22),
    Water: new THREE.Color(0.3, 0.27, 0.2),
  };
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = -SIZE / 2 + i * step;
      const z = -SIZE / 2 + j * step;
      const hit = nearest(x, z);
      const y = heightFrom(x, z, hit);
      const k = (j * N + i) * 3;
      positions[k] = x;
      positions[k + 1] = y;
      positions[k + 2] = z;
      const s = surfaceFrom(x, z, y, hit);
      col.copy(palette[s.name]);
      // Soft blend of road colour into the shoulder, plus per-vertex variation.
      if (s !== SURFACES.gravel && s !== SURFACES.sand && s !== SURFACES.rock && hit.d < HALF_WIDTH + 2.5) {
        col.lerp(palette.Dirt, 1 - smoothstep(HALF_WIDTH, HALF_WIDTH + 2.5, hit.d));
      }
      const v = 0.88 + 0.24 * valueNoise(x / 3.1, z / 3.1, SEED + 11);
      // Higher, steeper ground gets a drier tint.
      const dry = smoothstep(4, 14, y) * 0.25;
      col.lerp(palette.Dirt, s === SURFACES.grass ? dry : 0);
      colors[k] = col.r * v;
      colors[k + 1] = col.g * v;
      colors[k + 2] = col.b * v;
    }
  }
  const indices = new Uint32Array(CELLS * CELLS * 6);
  let q = 0;
  for (let j = 0; j < CELLS; j++) {
    for (let i = 0; i < CELLS; i++) {
      const a = j * N + i;
      const b = a + 1;
      const c = a + N;
      const d = c + 1;
      indices.set([a, c, b, b, c, d], q);
      q += 6;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.trimesh(positions, indices).setFriction(0.9), groundBody);

  // ---- Water ----
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(30, 48),
    new THREE.MeshStandardMaterial({
      color: 0x3f7472,
      roughness: 0.12,
      metalness: 0.1,
      transparent: true,
      opacity: 0.78,
    }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(pond.x, waterLevel, pond.z);
  scene.add(water);

  const rand = mulberry32(SEED);
  const dummy = new THREE.Object3D();

  // ---- Rock garden: rocks on the road, each with a matching ball collider ----
  const rockCount = 70;
  const rocks = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.MeshStandardMaterial({ color: 0x8a847b, roughness: 1, flatShading: true }),
    rockCount + 40,
  );
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  let ri = 0;
  const placeRock = (x: number, z: number, r: number, sink: number) => {
    const y = heightAt(x, z) + r * sink;
    dummy.position.set(x, y, z);
    dummy.rotation.set(rand() * 6, rand() * 6, rand() * 6);
    dummy.scale.setScalar(r);
    dummy.updateMatrix();
    rocks.setMatrixAt(ri++, dummy.matrix);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
    world.createCollider(RAPIER.ColliderDesc.ball(r * 0.92).setFriction(1), body);
  };
  for (let i = 0; i < rockCount; i++) {
    const t = 0.305 + rand() * 0.07;
    const p = pts[Math.floor(t * n)];
    const p2 = pts[(Math.floor(t * n) + 1) % n];
    const tx = p2.x - p.x;
    const tz = p2.z - p.z;
    const tl = Math.hypot(tx, tz);
    const off = (rand() * 2 - 1) * (HALF_WIDTH + 0.5);
    placeRock(p.x + (-tz / tl) * off, p.z + (tx / tl) * off, 0.25 + rand() * 0.4, -0.15);
  }
  // A few boulders by the roadside for scenery.
  for (let i = 0; i < 40; i++) {
    const p = pts[Math.floor(rand() * n)];
    const a = rand() * Math.PI * 2;
    const r = HALF_WIDTH + 4 + rand() * 10;
    const x = p.x + Math.cos(a) * r;
    const z = p.z + Math.sin(a) * r;
    const size = 0.6 + rand() * 1.4;
    // Keep scenery boulders clear of every part of the road, not just this one.
    if (nearest(x, z).d < HALF_WIDTH + 2 + size) continue;
    placeRock(x, z, size, -0.35);
  }
  rocks.count = ri;
  scene.add(rocks);

  // ---- Vegetation: rain trees, palms, bushes and grass clumps (instanced) ----
  const treeSpots: { x: number; z: number; y: number; s: number }[] = [];
  const palmSpots: typeof treeSpots = [];
  const tries = 4000;
  for (let i = 0; i < tries && treeSpots.length + palmSpots.length < 650; i++) {
    const x = (rand() * 2 - 1) * 135;
    const z = (rand() * 2 - 1) * 135;
    const hit = nearest(x, z);
    if (hit.d < HALF_WIDTH + 4) continue;
    if (Math.hypot(x - pond.x, z - pond.z) < 27) continue;
    // Cluster trees with noise so there are woods and clearings.
    if (valueNoise(x / 30, z / 30, SEED + 21) < 0.42) continue;
    const y = heightFrom(x, z, hit);
    const spot = { x, z, y, s: 0.8 + rand() * 0.6 };
    (rand() < 0.25 ? palmSpots : treeSpots).push(spot);
  }

  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5b4636, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x4a7a33, roughness: 0.9, flatShading: true });
  const leafMat2 = new THREE.MeshStandardMaterial({ color: 0x557d34, roughness: 0.9, flatShading: true });
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.4, 1, 6), trunkMat, treeSpots.length + palmSpots.length);
  const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), leafMat, treeSpots.length);
  const fronds = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 0.6, 7, 1, true), leafMat2, palmSpots.length);
  trunks.castShadow = crowns.castShadow = fronds.castShadow = true;
  let ti = 0;
  treeSpots.forEach((p, i) => {
    const h = 4.5 * p.s;
    dummy.rotation.set(0, rand() * 6, 0);
    dummy.position.set(p.x, p.y + h / 2, p.z);
    dummy.scale.set(p.s * 1.2, h, p.s * 1.2);
    dummy.updateMatrix();
    trunks.setMatrixAt(ti++, dummy.matrix);
    // Rain trees: wide, flat umbrella crowns.
    dummy.position.set(p.x, p.y + h + 1.2 * p.s, p.z);
    dummy.scale.set(4.2 * p.s, 1.7 * p.s, 4.2 * p.s);
    dummy.updateMatrix();
    crowns.setMatrixAt(i, dummy.matrix);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(p.x, p.y + 2, p.z));
    world.createCollider(RAPIER.ColliderDesc.cylinder(2, 0.35 * p.s), body);
  });
  palmSpots.forEach((p, i) => {
    const h = 7 * p.s;
    dummy.rotation.set((rand() - 0.5) * 0.15, 0, (rand() - 0.5) * 0.15);
    dummy.position.set(p.x, p.y + h / 2, p.z);
    dummy.scale.set(0.6, h, 0.6);
    dummy.updateMatrix();
    trunks.setMatrixAt(ti++, dummy.matrix);
    dummy.rotation.set(Math.PI, rand() * 6, 0);
    dummy.position.set(p.x, p.y + h, p.z);
    dummy.scale.set(3 * p.s, 1.6 * p.s, 3 * p.s);
    dummy.updateMatrix();
    fronds.setMatrixAt(i, dummy.matrix);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(p.x, p.y + 2, p.z));
    world.createCollider(RAPIER.ColliderDesc.cylinder(2, 0.25), body);
  });
  // Slight per-instance colour variation so woods don't look copy-pasted.
  const tint = new THREE.Color();
  const vary = (mesh: THREE.InstancedMesh, count: number) => {
    for (let i = 0; i < count; i++) {
      tint.setHSL(0.24 + (rand() - 0.5) * 0.06, 0.45 + rand() * 0.2, 0.75 + rand() * 0.35);
      mesh.setColorAt(i, tint);
    }
  };
  vary(crowns, treeSpots.length);
  vary(fronds, palmSpots.length);
  scene.add(trunks, crowns, fronds);

  const bushCount = 1400;
  const bushes = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), leafMat2, bushCount);
  const grassCount = 3500;
  const grass = new THREE.InstancedMesh(
    new THREE.ConeGeometry(0.18, 0.7, 4),
    new THREE.MeshStandardMaterial({ color: 0x6d8f3a, roughness: 1, flatShading: true }),
    grassCount,
  );
  let bi = 0;
  let gi = 0;
  for (let i = 0; i < 20000 && (bi < bushCount || gi < grassCount); i++) {
    const x = (rand() * 2 - 1) * 140;
    const z = (rand() * 2 - 1) * 140;
    const hit = nearest(x, z);
    if (hit.d < HALF_WIDTH + 1.2) continue;
    const y = heightFrom(x, z, hit);
    if (y < waterLevel + 0.1 && Math.hypot(x - pond.x, z - pond.z) < 30) continue;
    if (bi < bushCount && valueNoise(x / 18, z / 18, SEED + 31) > 0.45) {
      const s = 0.5 + rand() * 0.9;
      dummy.rotation.set(0, rand() * 6, 0);
      dummy.position.set(x, y + s * 0.4, z);
      dummy.scale.set(s * 1.3, s * 0.8, s * 1.3);
      dummy.updateMatrix();
      bushes.setMatrixAt(bi++, dummy.matrix);
    } else if (gi < grassCount) {
      const s = 0.6 + rand() * 0.8;
      dummy.rotation.set((rand() - 0.5) * 0.4, rand() * 6, (rand() - 0.5) * 0.4);
      dummy.position.set(x, y + 0.3 * s, z);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      grass.setMatrixAt(gi++, dummy.matrix);
    }
  }
  vary(bushes, bi);
  bushes.count = bi;
  grass.count = gi;
  bushes.castShadow = true;
  scene.add(bushes, grass);

  // ---- Start: just before the climb, facing along the road ----
  const s0 = pts[Math.round(0.02 * n)];
  const s1 = pts[Math.round(0.02 * n) + 1];
  const startYaw = Math.atan2(-(s1.z - s0.z), s1.x - s0.x);
  const start = new THREE.Vector3(s0.x, heightAt(s0.x, s0.z) + 1.4, s0.z);

  const poseAt = (t: number) => {
    const i = ((Math.floor(t * n) % n) + n) % n;
    const a = pts[i];
    const b = pts[(i + 1) % n];
    return {
      pos: new THREE.Vector3(a.x, heightAt(a.x, a.z), a.z),
      yaw: Math.atan2(-(b.z - a.z), b.x - a.x),
    };
  };

  return {
    poseAt,
    trackT: (x, z) => nearest(x, z).t,
    start,
    startYaw,
    waterLevel,
    heightAt,
    surfaceAt: (x, z, y) => surfaceFrom(x, z, y, nearest(x, z)),
    zoneAt(x, z) {
      const hit = nearest(x, z);
      if (hit.d > HALF_WIDTH + 6) return null;
      return ZONES.find((zn) => hit.t >= zn.from && hit.t <= zn.to)?.label ?? null;
    },
  };
}
