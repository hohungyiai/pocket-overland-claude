// Measures what the car (src/vehicle.ts) can drive over, on flat test
// surfaces in Rapier with no game around it. `npm run limits` prints:
//  - climbDeg: steepest slope climbed from a standstill (high and low range);
//  - lip: highest step climbed from a standstill, front wheels against it;
//  - tiltDeg: side slope where the parked car first slides (or tips);
//  - twist: how fast a road's side tilt may swing (per 5 m) before the car,
//    driven flat out along it, rolls over.
// Copy the results into src/limits.ts (CAR).
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Vehicle } from '../../src/vehicle';
import { SURFACES } from '../../src/courses/types';

await RAPIER.init();
const course = { start: new THREE.Vector3(), startYaw: 0, heightAt: () => 0, surfaceAt: () => SURFACES.asphalt } as never;
type Setup = (w: RAPIER.World) => void;
const upY = (car: Vehicle) => {
  const q = car.body.rotation();
  return new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w)).y;
};
function run(setup: Setup, o: { low?: boolean; throttle?: number; steps?: number; x0?: number; hold?: boolean }) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  setup(world);
  const car = new Vehicle(world, RAPIER as never, course);
  car.placeAt(new THREE.Vector3(o.x0 ?? 0, 0, 0), 0);
  car.lowRange = !!o.low;
  for (let i = 0; i < 180; i++) {
    car.update(1 / 60, { steer: 0, throttle: 0 });
    world.step();
  }
  const p0 = { ...car.body.translation() };
  let minUp = 1;
  for (let i = 0; i < (o.steps ?? 600); i++) {
    const p = car.body.translation();
    const f = car.forward;
    // Keep straight (toward z = 0).
    car.update(1 / 60, { steer: o.hold ? Math.max(-1, Math.min(1, -(0.5 * p.z + 4 * f.z))) : 0, throttle: o.throttle ?? 1 });
    world.step();
    minUp = Math.min(minUp, upY(car));
  }
  const p = car.body.translation();
  return { dx: p.x - p0.x, dz: p.z - p0.z, minUp };
}
const ground = (w: RAPIER.World) => w.createCollider(RAPIER.ColliderDesc.cuboid(300, 1, 300).setTranslation(0, -1, 0).setFriction(1));
const slope = (deg: number): Setup => (w) => {
  const a = (deg * Math.PI) / 180;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a);
  w.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 50).setTranslation(Math.sin(a), -Math.cos(a), 0).setRotation(q).setFriction(1));
};
const lip = (h: number): Setup => (w) => {
  ground(w);
  w.createCollider(RAPIER.ColliderDesc.cuboid(50, h / 2, 50).setTranslation(4 + 50, h / 2, 0).setFriction(1));
};
const side = (deg: number): Setup => (w) => {
  const a = (deg * Math.PI) / 180;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), a);
  w.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 200).setTranslation(0, -1 / Math.cos(a), 0).setRotation(q).setFriction(1));
};
// A straight road along +x, 24 m wide, whose side tilt swings ±A (rise per
// metre across) with period P after a 300 m run-up.
const wave = (A: number, P: number): Setup => (w) => {
  const v: number[] = [];
  const ix: number[] = [];
  const W = 12;
  const N = 1200;
  for (let n = 0; n <= N; n++) {
    const x = -50 + n * 0.5;
    const s = x - 250;
    const t = s > 0 ? A * Math.sin((2 * Math.PI * s) / P) : 0;
    v.push(x, -t * W, -W, x, t * W, W);
    if (n < N) ix.push(n * 2, n * 2 + 1, n * 2 + 2, n * 2 + 1, n * 2 + 3, n * 2 + 2);
  }
  w.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(v), new Uint32Array(ix)).setFriction(1));
};
const out: Record<string, number> = {};
for (const low of [false, true]) {
  let best = 0;
  for (let deg = 2; deg <= 50; deg++) {
    if (run(slope(deg), { low }).dx > 8) best = deg;
    else break;
  }
  out[low ? 'climbDegLow' : 'climbDeg'] = best;
  let h = 0;
  for (let t = 0.02; t <= 0.8; t += 0.02) {
    // Front wheels (1.42 m ahead, 0.42 m radius) against the step at x = 4.
    if (run(lip(t), { low, x0: 2.12 }).dx > 10) h = +t.toFixed(2);
    else break;
  }
  out[low ? 'lipLow' : 'lip'] = h;
}
for (let deg = 2; deg <= 70; deg++) {
  const r = run(side(deg), { throttle: 0, steps: 300 });
  if (Math.abs(r.dz) > 1 || r.minUp < Math.cos(((deg + 15) * Math.PI) / 180)) {
    out.tiltDeg = deg;
    break;
  }
}
// Twist: rolled past 60° at any period of 10, 20 or 40 m.
let twist = Infinity;
for (const P of [10, 20, 40])
  for (let A = 0.05; A <= 0.6; A += 0.05) {
    const r = run(wave(A, P), { hold: true, steps: 60 * 40, x0: -40 });
    if (r.minUp < 0.5) {
      // The most the tilt changes within 5 m on that wave.
      twist = Math.min(twist, 2 * A * Math.sin(Math.min(Math.PI / 2, (Math.PI * 5) / P)));
      break;
    }
  }
out.twist = +twist.toFixed(2);
console.log(JSON.stringify(out));
