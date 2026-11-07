import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Camps: the expedition loop's rest and save points. Stop the car inside a
// camp, tap "Make camp", and the tent goes up beside the car, the fire is
// lit, the evening comes, and your place on the journey is saved. "Break
// camp" in the morning carries on. Nothing here depends on the art style.

export interface CampSpot {
  id: string;
  label: string;
  x: number;
  z: number;
  radius: number;
}

export interface SaveGame {
  course: string;
  camp: string;
  label: string;
  x: number;
  z: number;
  yaw: number;
  style?: string;
  savedAt: number;
}

const SAVE_KEY = 'pocket-overland-save';

export function loadSave(): SaveGame | null {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null');
    return s && typeof s.x === 'number' && typeof s.course === 'string' ? s : null;
  } catch {
    return null;
  }
}

function writeSave(s: SaveGame) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

const tint = (g: THREE.BufferGeometry, hex: number) => {
  const g2 = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(hex);
  const arr = new Float32Array(g2.attributes.position.count * 3);
  for (let i = 0; i < arr.length; i += 3) c.toArray(arr, i);
  g2.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  g2.deleteAttribute('uv');
  return g2;
};

/** Tent, fire ring, logs and a camp chair, origin at the tent door. */
function campGeometry() {
  const tent = new THREE.ConeGeometry(1.9, 1.7, 4, 1, false).rotateY(Math.PI / 4).scale(1, 1, 1.4).translate(0, 0.85, 0);
  const ring = Array.from({ length: 9 }, (_, i) => {
    const a = (i / 9) * Math.PI * 2;
    return tint(new THREE.IcosahedronGeometry(0.17, 0).translate(3.2 + Math.cos(a) * 0.55, 0.08, 1.2 + Math.sin(a) * 0.55), 0x77736c);
  });
  const logs = [0.4, 1.9].map((r) => tint(new THREE.CylinderGeometry(0.07, 0.07, 0.8, 6).rotateZ(Math.PI / 2).rotateY(r).translate(3.2, 0.12, 1.2), 0x5e4a3a));
  const chair = [
    tint(new THREE.BoxGeometry(0.5, 0.06, 0.5).translate(2.2, 0.42, 2.4), 0x2f5d8a),
    tint(new THREE.BoxGeometry(0.5, 0.5, 0.06).translate(2.2, 0.7, 2.62), 0x2f5d8a),
    ...[[-0.22, -0.22], [0.22, -0.22], [-0.22, 0.22], [0.22, 0.22]].map(([dx, dz]) =>
      tint(new THREE.CylinderGeometry(0.02, 0.02, 0.42, 4).translate(2.2 + dx, 0.21, 2.4 + dz), 0x3c4146)),
  ];
  return mergeGeometries([tint(tent, 0xd9772f), ...ring, ...logs, ...chair])!;
}

export class Camps {
  private group = new THREE.Group();
  private flame: THREE.Mesh;
  private glow: THREE.Sprite;
  active: CampSpot | null = null;

  constructor(
    scene: THREE.Scene,
    private spots: CampSpot[],
    private heightAt: (x: number, z: number) => number,
  ) {
    const mesh = new THREE.Mesh(campGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
    mesh.castShadow = mesh.receiveShadow = true;
    this.flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.28, 0.75, 7).translate(3.2, 0.45, 1.2),
      new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.9 }),
    );
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,190,110,0.9)');
    grad.addColorStop(1, 'rgba(255,150,60,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthWrite: false, transparent: true, blending: THREE.AdditiveBlending }));
    this.glow.scale.setScalar(4);
    this.glow.position.set(3.2, 0.7, 1.2);
    this.group.add(mesh, this.flame, this.glow);
    this.group.visible = false;
    scene.add(this.group);
  }

  /** The camp the car is parked in, if any. */
  at(x: number, z: number): CampSpot | null {
    for (const s of this.spots) if (Math.hypot(x - s.x, z - s.z) < s.radius) return s;
    return null;
  }

  /** Pitch beside the car (on its left, door facing the car). */
  pitch(spot: CampSpot, car: { x: number; z: number; yaw: number }, courseId: string, style: string) {
    const lx = -Math.sin(car.yaw); // car's left, in (x, z)
    const lz = -Math.cos(car.yaw);
    const x = car.x + lx * 4.5;
    const z = car.z + lz * 4.5;
    this.group.position.set(x, this.heightAt(x, z), z);
    this.group.rotation.y = car.yaw;
    this.group.visible = true;
    this.active = spot;
    return writeSave({ course: courseId, camp: spot.id, label: spot.label, x: car.x, z: car.z, yaw: car.yaw, style, savedAt: Date.now() });
  }

  strike() {
    this.group.visible = false;
    this.active = null;
  }

  update(time: number) {
    if (!this.group.visible) return;
    const f = 0.85 + Math.sin(time * 11) * 0.08 + Math.sin(time * 17.3) * 0.06;
    this.flame.scale.set(1, f, 1);
    this.glow.material.opacity = 0.6 + f * 0.3;
  }
}
