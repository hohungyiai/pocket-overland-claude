import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';

type Rapier = typeof RAPIER_NS;

// Traffic. The logic only knows lanes (polylines) and speeds; what a car
// looks like is passed in, so each art style can supply its own model.
//
// Two kinds of lane:
//  - "through" lanes (the expressway): cars loop end to end, never stop,
//    and have no colliders (they are behind the park fence).
//  - "local" lanes (the park's service road): a few slow cars with solid
//    bodies that ease to a stop and wait whenever the player is in front
//    of them. Nothing ever hits you; at worst you wait for a moment.

export interface Lane {
  pts: THREE.Vector3[]; // in driving order, y = road surface height
  speed: number; // m/s cruising speed
  cars: number;
  local?: boolean;
}

interface Car {
  lane: number;
  s: number; // distance along the lane
  v: number; // current speed
  body?: RAPIER_NS.RigidBody;
}

interface LaneData extends Lane {
  cum: number[]; // cumulative length at each point
  length: number;
}

export class Traffic {
  readonly mesh: THREE.InstancedMesh;
  private lanes: LaneData[];
  private cars: Car[] = [];
  private dummy = new THREE.Object3D();
  private tmp = new THREE.Vector3();
  private dir = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    world: RAPIER_NS.World,
    RAPIER: Rapier,
    lanes: Lane[],
    look: { geometry: THREE.BufferGeometry; material: THREE.Material; colors: number[]; halfExtents: [number, number, number] },
    rand: () => number,
  ) {
    this.lanes = lanes.map((l) => {
      const cum = [0];
      for (let i = 1; i < l.pts.length; i++) cum.push(cum[i - 1] + l.pts[i].distanceTo(l.pts[i - 1]));
      return { ...l, cum, length: cum[cum.length - 1] };
    });
    this.lanes.forEach((l, li) => {
      for (let i = 0; i < l.cars; i++) {
        const car: Car = { lane: li, s: ((i + rand() * 0.5) / l.cars) * l.length, v: l.speed };
        if (l.local) {
          const [hx, hy, hz] = look.halfExtents;
          car.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
          world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(0, hy + 0.1, 0), car.body);
        }
        this.cars.push(car);
      }
    });
    this.mesh = new THREE.InstancedMesh(look.geometry, look.material, this.cars.length);
    this.cars.forEach((_, i) => this.mesh.setColorAt(i, new THREE.Color(look.colors[Math.floor(rand() * look.colors.length)])));
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false; // instances span the whole course
    scene.add(this.mesh);
    this.update(0, null);
  }

  /** Point and heading at distance s along a lane. */
  private sample(l: LaneData, s: number, out: THREE.Vector3) {
    let lo = 0;
    let hi = l.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (l.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const a = l.pts[lo];
    const b = l.pts[hi];
    const t = (s - l.cum[lo]) / Math.max(1e-6, l.cum[hi] - l.cum[lo]);
    out.lerpVectors(a, b, t);
    this.dir.subVectors(b, a);
    return Math.atan2(-this.dir.z, this.dir.x);
  }

  update(dt: number, player: { x: number; z: number } | null) {
    const { dummy, tmp } = this;
    this.cars.forEach((c, i) => {
      const l = this.lanes[c.lane];
      let target = l.speed;
      if (l.local && player) {
        // Look ahead along the lane; stop short of the player.
        const yaw0 = this.sample(l, c.s, tmp);
        const fx = Math.cos(yaw0);
        const fz = -Math.sin(yaw0);
        const dx = player.x - tmp.x;
        const dz = player.z - tmp.z;
        const ahead = dx * fx + dz * fz;
        const side = Math.abs(-dx * fz + dz * fx);
        if (ahead > 0 && ahead < 22 && side < 4.5) target = Math.max(0, (ahead - 9) * 0.6);
      }
      // Gentle acceleration and braking.
      c.v += Math.max(-6 * dt, Math.min(2 * dt, target - c.v));
      c.s += c.v * dt;
      if (c.s > l.length) c.s -= l.length;
      const yaw = this.sample(l, c.s, tmp);
      dummy.position.copy(tmp);
      dummy.rotation.set(0, yaw, 0);
      dummy.updateMatrix();
      this.mesh.setMatrixAt(i, dummy.matrix);
      if (c.body) {
        c.body.setNextKinematicTranslation({ x: tmp.x, y: tmp.y, z: tmp.z });
        c.body.setNextKinematicRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
      }
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
