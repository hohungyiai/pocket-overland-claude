import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { SURFACES, type Course, type Surface } from './courses/types';
import { clamp, lerp } from './noise';

type Rapier = typeof RAPIER_NS;

// A 4x4 on Rapier's ray-cast vehicle controller. The chassis' local forward
// axis is +X, up is +Y, so the right-hand side is +Z.

export interface DriveInput {
  steer: number; // -1 (left) .. 1 (right)
  throttle: number; // -1 (brake / reverse) .. 1 (accelerate)
}

const TUNING = {
  wheelRadius: 0.42,
  restLength: 0.42,
  maxTravel: 0.32,
  stiffness: 32, // per unit of chassis mass (Bullet-style)
  compression: 3.6,
  relaxation: 5.2,
  maxSuspensionForce: 120000,
  engineForceHigh: 2200, // N per wheel
  engineForceLow: 5600,
  topSpeedHigh: 24, // m/s (~86 km/h)
  topSpeedLow: 8, // m/s (~29 km/h)
  reverseForce: 2600,
  brakeMax: 55,
  holdBrake: 25,
  steerCrawl: 0.62,
  steerFast: 0.14,
  steerRate: 2.6, // rad/s
};

// Front-left, front-right, rear-left, rear-right.
const WHEELS = [
  { x: 1.42, z: -0.86, front: true },
  { x: 1.42, z: 0.86, front: true },
  { x: -1.38, z: -0.86, front: false },
  { x: -1.38, z: 0.86, front: false },
];

export class Vehicle {
  readonly body: RAPIER_NS.RigidBody;
  readonly controller: RAPIER_NS.DynamicRayCastVehicleController;
  readonly mesh = new THREE.Group();
  lowRange = false;
  diffLock = false;
  /** Signed forward speed, m/s. */
  speed = 0;
  surface: Surface = SURFACES.gravel;
  wheelsOnGround = 4;
  private steerAngle = 0;
  private wheelMeshes: THREE.Object3D[] = [];
  private upsideDownTime = 0;
  private prev = Vehicle.emptyState();
  private curr = Vehicle.emptyState();
  private static emptyState() {
    return { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), susp: [0, 0, 0, 0], steer: [0, 0, 0, 0], spin: [0, 0, 0, 0] };
  }
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpV = new THREE.Vector3();

  constructor(
    world: RAPIER_NS.World,
    RAPIER: Rapier,
    private course: Course,
  ) {
    const s = course.start;
    const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), course.startYaw);
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(s.x, s.y, s.z)
        .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
        .setCanSleep(false)
        .setLinearDamping(0.05)
        .setAngularDamping(0.4),
    );
    // Body shell plus a heavy, low ballast so the centre of mass sits low,
    // like a loaded overland rig with a full tank.
    world.createCollider(RAPIER.ColliderDesc.cuboid(2.15, 0.42, 0.92).setTranslation(0, 0.25, 0).setDensity(110).setFriction(0.6), this.body);
    world.createCollider(RAPIER.ColliderDesc.cuboid(1.8, 0.1, 0.7).setTranslation(0, -0.2, 0).setDensity(1250), this.body);

    this.controller = world.createVehicleController(this.body);
    for (const w of WHEELS) {
      this.controller.addWheel(
        { x: w.x, y: -0.15, z: w.z },
        { x: 0, y: -1, z: 0 },
        { x: 0, y: 0, z: 1 },
        TUNING.restLength,
        TUNING.wheelRadius,
      );
    }
    for (let i = 0; i < WHEELS.length; i++) {
      this.controller.setWheelSuspensionStiffness(i, TUNING.stiffness);
      this.controller.setWheelSuspensionCompression(i, TUNING.compression);
      this.controller.setWheelSuspensionRelaxation(i, TUNING.relaxation);
      this.controller.setWheelMaxSuspensionTravel(i, TUNING.maxTravel);
      this.controller.setWheelMaxSuspensionForce(i, TUNING.maxSuspensionForce);
      this.controller.setWheelFrictionSlip(i, SURFACES.gravel.grip);
      this.controller.setWheelSideFrictionStiffness(i, 1);
    }
    this.buildMesh();
    this.snap();
  }

  private buildMesh() {
    const paint = new THREE.MeshStandardMaterial({ color: 0xd9cdb0, roughness: 0.55, metalness: 0.1 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.8 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x23323d, roughness: 0.15, metalness: 0.4 });
    const accent = new THREE.MeshStandardMaterial({ color: 0x9a5a2c, roughness: 0.7 });
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      this.mesh.add(m);
      return m;
    };
    // A box whose corners are moved: f gets each corner as (sx, sy, sz) in
    // -1..1 plus its position, and returns the new position. Faces stay flat
    // and keep their own normals, so it still reads as low-poly.
    const shaped = (w: number, h: number, d: number, f: (p: THREE.Vector3, sx: number, sy: number, sz: number) => void) => {
      const g = new THREE.BoxGeometry(w, h, d);
      const pos = g.attributes.position;
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        f(v, Math.sign(v.x), Math.sign(v.y), Math.sign(v.z));
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      g.computeVertexNormals();
      return g;
    };
    // Lower body: slight tumblehome, and a bonnet that drops to a rounded nose.
    add(shaped(4.3, 0.75, 1.84, (p, sx, sy) => {
      if (sy > 0) p.z *= 0.95;
      if (sx > 0) p.x -= sy > 0 ? 0.14 : 0.04;
      if (sx > 0 && sy > 0) p.y -= 0.07;
    }), paint, 0, 0.3, 0);
    // Cabin: raked windscreen, narrower roof. Bottom spans x -1.75..0.85.
    add(shaped(2.6, 0.75, 1.74, (p, sx, sy) => {
      if (sy > 0) {
        p.z *= 0.88;
        p.x -= sx > 0 ? 0.4 : -0.06;
      }
    }), paint, -0.45, 1.05, 0);
    // Glass: windscreen on the raked face, two side windows each side split
    // by a pillar, and a rear window.
    add(new THREE.BoxGeometry(0.03, 0.62, 1.42), glass, 0.665, 1.06, 0).rotation.z = 0.49; // windscreen
    for (const side of [-1, 1]) {
      const z = side * 0.835;
      add(new THREE.BoxGeometry(0.78, 0.46, 0.03), glass, 0.04, 1.1, z).rotation.x = -side * 0.138; // front door
      add(new THREE.BoxGeometry(1.05, 0.46, 0.03), glass, -1.05, 1.1, z).rotation.x = -side * 0.138; // rear door
    }
    add(new THREE.BoxGeometry(0.03, 0.44, 1.3), glass, -1.735, 1.12, 0).rotation.z = -0.08; // rear window
    add(new THREE.BoxGeometry(2.0, 0.08, 1.4), dark, -0.62, 1.47, 0); // roof rack
    add(new THREE.BoxGeometry(1.1, 0.3, 0.5), accent, -0.85, 1.66, 0.3); // gear box on rack
    add(new THREE.BoxGeometry(0.5, 0.22, 0.4), accent, -0.15, 1.62, -0.35); // jerry can
    add(new THREE.BoxGeometry(0.22, 0.32, 1.9), dark, 2.2, 0.15, 0); // front bumper
    add(new THREE.BoxGeometry(0.22, 0.3, 1.9), dark, -2.2, 0.15, 0); // rear bumper
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff3c4, emissive: 0x6b5f2a });
    add(new THREE.BoxGeometry(0.06, 0.15, 0.3), lampMat, 2.05, 0.44, -0.62).rotation.z = 0.14;
    add(new THREE.BoxGeometry(0.06, 0.15, 0.3), lampMat, 2.05, 0.44, 0.62).rotation.z = 0.14;
    const tail = new THREE.MeshStandardMaterial({ color: 0xb8352a, emissive: 0x3a0d08 });
    add(new THREE.BoxGeometry(0.05, 0.18, 0.14), tail, -2.16, 0.5, -0.78);
    add(new THREE.BoxGeometry(0.05, 0.18, 0.14), tail, -2.16, 0.5, 0.78);

    // Wheel-arch flares: open half-cylinder shells over each wheel.
    const flare = new THREE.CylinderGeometry(0.54, 0.54, 0.28, 9, 1, true, Math.PI / 2, Math.PI);
    flare.rotateX(Math.PI / 2);
    const flareMat = new THREE.MeshStandardMaterial({ color: 0x34373b, roughness: 0.85, side: THREE.DoubleSide });
    for (const w of WHEELS) add(flare, flareMat, w.x, -0.4, Math.sign(w.z) * 0.95);

    const tyre = new THREE.CylinderGeometry(TUNING.wheelRadius, TUNING.wheelRadius, 0.34, 14);
    tyre.rotateX(Math.PI / 2);
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x1d1d1d, roughness: 0.95, flatShading: true });
    const hub = new THREE.CylinderGeometry(0.2, 0.2, 0.36, 6);
    hub.rotateX(Math.PI / 2);
    const hubMat = new THREE.MeshStandardMaterial({ color: 0x8c8c8c, roughness: 0.4, metalness: 0.6 });
    for (let i = 0; i < WHEELS.length; i++) {
      const g = new THREE.Group();
      const t = new THREE.Mesh(tyre, tyreMat);
      t.castShadow = true;
      g.add(t, new THREE.Mesh(hub, hubMat));
      this.wheelMeshes.push(g);
    }
    // Spare wheel on the back door, on a small bracket.
    add(new THREE.BoxGeometry(0.1, 0.12, 0.5), dark, -2.2, 0.7, 0);
    const spare = add(tyre, tyreMat, -2.33, 0.7, 0);
    spare.rotation.y = Math.PI / 2;
    spare.scale.set(0.88, 0.88, 0.78);
    const spareHub = add(hub, hubMat, -2.33, 0.7, 0);
    spareHub.rotation.y = Math.PI / 2;
    spareHub.scale.set(0.88, 0.88, 0.78);
  }

  get wheels(): THREE.Object3D[] {
    return this.wheelMeshes;
  }

  toggleLowRange() {
    this.lowRange = !this.lowRange;
  }

  toggleDiffLock() {
    this.diffLock = !this.diffLock;
  }

  /** Place the car at a position and heading, at rest. */
  placeAt(pos: THREE.Vector3, yaw: number) {
    const r = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body.setTranslation({ x: pos.x, y: pos.y + 1.4, z: pos.z }, true);
    this.body.setRotation({ x: r.x, y: r.y, z: r.z, w: r.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.upsideDownTime = 0;
    this.snap();
  }

  /** Put the car back on its wheels a little above where it is. */
  recover() {
    const p = this.body.translation();
    const q = this.body.rotation();
    const fwd = this.tmpV.set(1, 0, 0).applyQuaternion(this.tmpQ.set(q.x, q.y, q.z, q.w));
    const yaw = Math.atan2(-fwd.z, fwd.x);
    const r = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const y = this.course.heightAt(p.x, p.z) + 1.5;
    this.body.setTranslation({ x: p.x, y, z: p.z }, true);
    this.body.setRotation({ x: r.x, y: r.y, z: r.z, w: r.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.upsideDownTime = 0;
    this.snap();
  }

  update(dt: number, input: DriveInput) {
    const c = this.controller;
    const v = c.currentVehicleSpeed();
    this.speed = v;
    const absV = Math.abs(v);

    // Speed-sensitive steering: full lock when crawling, gentle at speed.
    const maxSteer = lerp(TUNING.steerCrawl, TUNING.steerFast, clamp(absV / 20, 0, 1));
    const target = -input.steer * maxSteer; // positive rotation about +Y turns left
    const delta = clamp(target - this.steerAngle, -TUNING.steerRate * dt, TUNING.steerRate * dt);
    this.steerAngle += delta;
    c.setWheelSteering(0, this.steerAngle);
    c.setWheelSteering(1, this.steerAngle);

    // Engine: simple torque falloff toward top speed of the selected range.
    const low = this.lowRange;
    const top = low ? TUNING.topSpeedLow : TUNING.topSpeedHigh;
    const force = low ? TUNING.engineForceLow : TUNING.engineForceHigh;
    let drive = 0;
    let brake = 0;
    if (input.throttle > 0.02) {
      if (v < -0.6) brake = TUNING.brakeMax * input.throttle; // moving backwards: brake first
      else drive = input.throttle * force * clamp(1 - v / top, 0, 1);
    } else if (input.throttle < -0.02) {
      if (v > 0.6) brake = TUNING.brakeMax * -input.throttle;
      else drive = input.throttle * TUNING.reverseForce * (low ? 1.8 : 1) * clamp(1 + v / 6, 0, 1);
    } else if (absV < 1.2) {
      brake = TUNING.holdBrake; // hill-hold when off the pedals
    }

    // Per-wheel surface and contact, plus a simple open/locked differential:
    // with the diff open, an axle loses most drive when one of its wheels is
    // in the air (power goes to the spinning wheel). Locking fixes that.
    let onGround = 0;
    let worst: Surface | null = null;
    const axleLift = [0, 0];
    for (let i = 0; i < 4; i++) {
      if (c.wheelIsInContact(i)) {
        onGround++;
        const cp = c.wheelContactPoint(i);
        if (cp) {
          const s = this.course.surfaceAt(cp.x, cp.z, cp.y);
          c.setWheelFrictionSlip(i, s.grip);
          if (!worst || s.drag > worst.drag) worst = s;
          c.setWheelBrake(i, brake + s.drag);
        }
      } else {
        axleLift[i < 2 ? 0 : 1]++;
        c.setWheelBrake(i, brake);
      }
    }
    this.wheelsOnGround = onGround;
    if (worst) this.surface = worst;
    for (let i = 0; i < 4; i++) {
      const axle = i < 2 ? 0 : 1;
      const open = !this.diffLock && axleLift[axle] > 0;
      const inAir = !c.wheelIsInContact(i);
      let f = drive;
      if (open) f *= 0.2;
      else if (this.diffLock && inAir && axleLift[axle] < 2) f = 0; // locked: grounded wheel gets it
      c.setWheelEngineForce(i, f);
    }

    c.updateVehicle(dt);

    // Self-recovery after a roll.
    const q = this.body.rotation();
    const up = this.tmpV.set(0, 1, 0).applyQuaternion(this.tmpQ.set(q.x, q.y, q.z, q.w));
    if (up.y < 0.25 && absV < 2) this.upsideDownTime += dt;
    else this.upsideDownTime = 0;
    if (this.upsideDownTime > 2) this.recover();
    // Fell out of the world somehow.
    if (this.body.translation().y < -50) this.recover();
  }

  /**
   * Record the physics state after a step. The renderer draws a blend of the
   * last two recorded states (see sync), so motion stays smooth even when a
   * display frame gets zero or two physics steps.
   */
  capture() {
    const [prev, curr] = [this.curr, this.prev];
    this.prev = prev;
    this.curr = curr;
    const p = this.body.translation();
    const q = this.body.rotation();
    curr.pos.set(p.x, p.y, p.z);
    curr.quat.set(q.x, q.y, q.z, q.w);
    const c = this.controller;
    for (let i = 0; i < 4; i++) {
      curr.susp[i] = c.wheelSuspensionLength(i) ?? TUNING.restLength;
      curr.steer[i] = c.wheelSteering(i) ?? 0;
      curr.spin[i] = c.wheelRotation(i) ?? 0;
    }
  }

  /** Forget the previous state, e.g. after teleporting, so nothing blends across the jump. */
  private snap() {
    this.capture();
    this.capture();
  }

  /** Draw the car between the last two physics states (alpha 0 = previous, 1 = latest). */
  sync(alpha = 1) {
    const a = this.prev;
    const b = this.curr;
    this.mesh.position.lerpVectors(a.pos, b.pos, alpha);
    this.mesh.quaternion.slerpQuaternions(a.quat, b.quat, alpha);
    const c = this.controller;
    for (let i = 0; i < 4; i++) {
      const w = this.wheelMeshes[i];
      const conn = c.wheelChassisConnectionPointCs(i)!;
      const len = lerp(a.susp[i], b.susp[i], alpha);
      w.position.set(conn.x, conn.y - len, conn.z).applyQuaternion(this.mesh.quaternion).add(this.mesh.position);
      w.quaternion.copy(this.mesh.quaternion);
      w.rotateY(lerp(a.steer[i], b.steer[i], alpha));
      w.rotateZ(-lerp(a.spin[i], b.spin[i], alpha));
    }
  }

  get forward(): THREE.Vector3 {
    const q = this.body.rotation();
    return new THREE.Vector3(1, 0, 0).applyQuaternion(this.tmpQ.set(q.x, q.y, q.z, q.w));
  }
}
