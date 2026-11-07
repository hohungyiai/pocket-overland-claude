import * as THREE from 'three';
import { SURFACES, type Surface } from './courses/types';
import { mulberry32 } from './noise';

// Weather and time of day. Style-neutral: it only scales lights, fog and the
// backdrop that the art style already set up, and draws rain as plain
// streaks. Showers come and go on their own and never stop you; the ground
// is a little slipperier while it's wet.
//
// Time of day changes only when you rest at a camp (morning <-> evening),
// so the light stays put while you drive.

type Phase = 'clear' | 'clouding' | 'shower' | 'clearing';
const PHASES: Record<Phase, { next: Phase; min: number; max: number }> = {
  clear: { next: 'clouding', min: 150, max: 260 },
  clouding: { next: 'shower', min: 35, max: 50 },
  shower: { next: 'clearing', min: 60, max: 110 },
  clearing: { next: 'clear', min: 35, max: 50 },
};

export type TimeOfDay = 'morning' | 'evening';

interface LightRig {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sunOffset: THREE.Vector3; // shared with the shadow placement code
}

export class Weather {
  phase: Phase = 'clear';
  /** 0 = clear sky, 1 = full shower. */
  wet = 0;
  time: TimeOfDay = 'morning';
  private dusk = 0; // 0 = morning light, 1 = evening light
  private phaseLeft: number;
  private rand = mulberry32(77);
  private base: {
    sun: number;
    hemi: number;
    sunColor: THREE.Color;
    fog: THREE.Color;
    fogNear: number;
    fogFar: number;
    bg: THREE.Color | null;
    env: number;
    sunOffset: THREE.Vector3;
  };
  private rain: THREE.LineSegments;
  private drops: Float32Array;
  private wetSurfaces = new Map<Surface, Surface>();
  onChange: ((label: string) => void) | null = null;

  constructor(private rig: LightRig) {
    const { scene, sun, hemi, sunOffset } = rig;
    const fog = scene.fog as THREE.Fog;
    this.base = {
      sun: sun.intensity,
      hemi: hemi.intensity,
      sunColor: sun.color.clone(),
      fog: fog.color.clone(),
      fogNear: fog.near,
      fogFar: fog.far,
      bg: scene.background instanceof THREE.Color ? scene.background.clone() : null,
      env: scene.environmentIntensity,
      sunOffset: sunOffset.clone(),
    };
    this.phaseLeft = 40 + this.rand() * 60; // first shower comes fairly soon
    // Rain: short streaks in a box that follows the camera.
    const N = 1400;
    this.drops = new Float32Array(N * 6);
    for (let i = 0; i < N; i++) this.resetDrop(i, true);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.drops, 3));
    this.rain = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: 0xd8e2ea, transparent: true, opacity: 0, depthWrite: false, fog: false }),
    );
    this.rain.frustumCulled = false;
    scene.add(this.rain);
    for (const s of Object.values(SURFACES)) {
      // Wet: a bit less grip on hard ground and grass; sand firms up slightly.
      const grip = s === SURFACES.sand ? s.grip * 1.05 : s.grip * 0.88;
      this.wetSurfaces.set(s, { ...s, name: s.name, grip, drag: s === SURFACES.sand ? s.drag * 0.9 : s.drag });
    }
  }

  private resetDrop(i: number, anywhere: boolean) {
    const d = this.drops;
    const x = (this.rand() - 0.5) * 50;
    const z = (this.rand() - 0.5) * 50;
    const y = anywhere ? this.rand() * 22 : 22;
    d.set([x, y, z, x + 0.05, y - 0.9, z + 0.02], i * 6);
  }

  /** Surface as the car feels it right now (wetter in a shower). */
  feel(s: Surface): Surface {
    return this.wet > 0.5 ? (this.wetSurfaces.get(s) ?? s) : s;
  }

  setTime(t: TimeOfDay) {
    this.time = t;
    this.dusk = t === 'evening' ? 1 : 0;
    // A rest clears the sky.
    this.phase = 'clear';
    this.phaseLeft = 150 + this.rand() * 100;
    this.wet = 0;
    this.apply();
  }

  update(dt: number, camera: THREE.Vector3) {
    this.phaseLeft -= dt;
    if (this.phaseLeft <= 0) {
      const p = PHASES[this.phase];
      this.phase = p.next;
      const q = PHASES[this.phase];
      this.phaseLeft = q.min + this.rand() * (q.max - q.min);
      if (this.phase === 'shower') this.onChange?.('A passing shower');
      if (this.phase === 'clear') this.onChange?.('The rain has passed');
    }
    const target = this.phase === 'clear' ? 0 : this.phase === 'clouding' ? 0.45 : this.phase === 'shower' ? 1 : 0.3;
    this.wet += (target - this.wet) * (1 - Math.exp(-dt / 8));
    this.apply();

    // Rain streaks.
    const rainAmt = Math.max(0, (this.wet - 0.55) / 0.45);
    const mat = this.rain.material as THREE.LineBasicMaterial;
    mat.opacity = rainAmt * 0.55;
    this.rain.visible = rainAmt > 0.01;
    if (this.rain.visible) {
      this.rain.position.set(camera.x, camera.y - 10, camera.z);
      const d = this.drops;
      const fall = 26 * dt;
      for (let i = 0; i < d.length / 6; i++) {
        d[i * 6 + 1] -= fall;
        d[i * 6 + 4] -= fall;
        if (d[i * 6 + 4] < 0) this.resetDrop(i, false);
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
    }
  }

  private grey = new THREE.Color(0x9aa3a8);
  private warm = new THREE.Color(0xffb27a);
  private duskFog = new THREE.Color(0xe7c7a8);
  private apply() {
    const { scene, sun, hemi, sunOffset } = this.rig;
    const b = this.base;
    const w = this.wet;
    const k = this.dusk;
    sun.intensity = b.sun * (1 - 0.7 * w) * (1 - 0.35 * k);
    sun.color.copy(b.sunColor).lerp(this.warm, k * 0.8);
    hemi.intensity = b.hemi * (1 - 0.25 * w) * (1 - 0.3 * k);
    // Evening: a low sun in the west.
    sunOffset.copy(b.sunOffset);
    if (k > 0) sunOffset.set(b.sunOffset.x * (1 + k), b.sunOffset.y * (1 - 0.55 * k), b.sunOffset.z * (1 - 0.5 * k));
    const fog = scene.fog as THREE.Fog;
    fog.color.copy(b.fog).lerp(this.duskFog, k * 0.6).lerp(this.grey, w * 0.65);
    fog.far = b.fogFar * (1 - 0.6 * w);
    fog.near = b.fogNear * (1 - 0.5 * w);
    if (b.bg && scene.background instanceof THREE.Color) scene.background.copy(b.bg).lerp(this.duskFog, k * 0.6).lerp(this.grey, w * 0.65);
    else {
      scene.backgroundIntensity = (1 - 0.45 * w) * (1 - 0.3 * k);
      scene.environmentIntensity = b.env * (1 - 0.4 * w);
    }
  }
}
