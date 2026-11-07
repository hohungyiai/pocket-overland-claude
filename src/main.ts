import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { buildCourse } from './course';
import { Vehicle } from './vehicle';
import { Controls } from './controls';
import { PerfOverlay } from './perf';
import './style.css';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function start() {
  await RAPIER.init();

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  $('app').prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const sky = new THREE.Color(0xb9d3df);
  scene.background = sky;
  scene.fog = new THREE.Fog(0xc4d6dc, 60, 230);

  scene.add(new THREE.HemisphereLight(0xdfeefa, 0x5a5236, 1.1));
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -32;
  sc.right = sc.top = 32;
  sc.near = 1;
  sc.far = 140;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  const sunOffset = new THREE.Vector3(-40, 70, 30);

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 400);

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const course = buildCourse(scene, world, RAPIER);
  const car = new Vehicle(world, RAPIER, course);
  scene.add(car.mesh, ...car.wheels);

  const controls = new Controls($('touch'), {
    steerBase: $('steer-base'),
    steerKnob: $('steer-knob'),
    pedalBase: $('pedal-base'),
    pedalKnob: $('pedal-knob'),
  });

  // ---- Buttons ----
  const camModes = ['Chase', 'High', 'Low'] as const;
  let camMode = 0;
  const btnLow = $('btn-low');
  const btnDiff = $('btn-diff');
  const btnCam = $('btn-cam');
  const refreshButtons = () => {
    btnLow.classList.toggle('on', car.lowRange);
    btnDiff.classList.toggle('on', car.diffLock);
    btnCam.textContent = camModes[camMode];
  };
  const tap = (el: HTMLElement, fn: () => void) =>
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      fn();
      refreshButtons();
      navigator.vibrate?.(10);
    });
  tap(btnLow, () => car.toggleLowRange());
  tap(btnDiff, () => car.toggleDiffLock());
  tap($('btn-reset'), () => car.recover());
  tap(btnCam, () => (camMode = (camMode + 1) % camModes.length));
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'l') car.toggleLowRange();
    else if (k === 'k') car.toggleDiffLock();
    else if (k === 'r') car.recover();
    else if (k === 'c') camMode = (camMode + 1) % camModes.length;
    else return;
    refreshButtons();
  });
  refreshButtons();

  // Keep the screen awake on long climbs, where supported.
  const wake = () => (navigator as Navigator & { wakeLock?: { request(t: string): Promise<unknown> } }).wakeLock?.request('screen').catch(() => {});
  document.addEventListener('pointerdown', wake, { once: true });

  // ---- Camera ----
  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  let camYaw = course.startYaw;
  // Reused every frame so the camera creates no garbage (GC pauses show up as hitches).
  const fwd = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  const want = new THREE.Vector3();
  const look = new THREE.Vector3();
  const placeCamera = (dt: number, snap: boolean) => {
    // Use the drawn (interpolated) car, not the latest physics state, so the
    // camera and the car always agree within a frame.
    const p = car.mesh.position;
    fwd.set(1, 0, 0).applyQuaternion(car.mesh.quaternion);
    const yaw = Math.atan2(-fwd.z, fwd.x);
    // Follow heading smoothly; when reversing, keep looking the same way.
    let d = yaw - camYaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    camYaw += d * (snap ? 1 : 1 - Math.exp(-dt * 2.2));
    ahead.set(Math.cos(camYaw), 0, -Math.sin(camYaw));
    const mode = camModes[camMode];
    const dist = mode === 'High' ? 11 : mode === 'Low' ? 4.2 : 7.5;
    const height = mode === 'High' ? 9 : mode === 'Low' ? 1.3 : 3.2;
    want.copy(p).addScaledVector(ahead, -dist);
    want.y = Math.max(p.y + height, course.heightAt(want.x, want.z) + 1.2);
    look.copy(p).addScaledVector(ahead, mode === 'Low' ? 6 : 2.5);
    look.y += mode === 'Low' ? 0.9 : 0.8;
    // Frame-rate independent smoothing.
    camPos.lerp(want, snap ? 1 : 1 - Math.exp(-dt * 5));
    camLook.lerp(look, snap ? 1 : 1 - Math.exp(-dt * 8));
    camera.position.copy(camPos);
    camera.lookAt(camLook);
  };

  // The sun follows the car, but moving the shadow map by fractions of a
  // texel makes every shadow shimmer and crawl as soon as the car moves.
  // Snap its centre to whole shadow texels, measured in the light's own axes.
  const lightFwd = sunOffset.clone().negate().normalize();
  const lightRight = new THREE.Vector3().crossVectors(lightFwd, new THREE.Vector3(0, 1, 0)).normalize();
  const lightUp = new THREE.Vector3().crossVectors(lightRight, lightFwd);
  const texel = (sc.right - sc.left) / sun.shadow.mapSize.x;
  const shadowCentre = new THREE.Vector3();
  const placeSun = (p: THREE.Vector3) => {
    const r = Math.round(p.dot(lightRight) / texel) * texel;
    const u = Math.round(p.dot(lightUp) / texel) * texel;
    const f = p.dot(lightFwd);
    shadowCentre.set(0, 0, 0).addScaledVector(lightRight, r).addScaledVector(lightUp, u).addScaledVector(lightFwd, f);
    sun.target.position.copy(shadowCentre);
    sun.position.copy(shadowCentre).add(sunOffset);
  };

  // ---- HUD ----
  const hudSpeed = $('hud-speed');
  const hudSurface = $('hud-surface');
  const hudZone = $('hud-zone');
  const hint = $('hint');
  let hudTimer = 0;
  let fpsFrames = 0;
  let fpsTime = 0;
  const hudFps = $('hud-fps');
  const perf = new PerfOverlay($('app'), hudFps);

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);

  // ---- Loop: fixed 60 Hz physics, render every frame ----
  const STEP = 1 / 60;
  let acc = 0;
  let last = performance.now();
  car.sync();
  placeCamera(0, true);

  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    acc += dt;
    controls.update(dt);
    let steps = 0;
    while (acc >= STEP && steps < 4) {
      car.update(STEP, controls.input);
      world.step();
      car.capture();
      acc -= STEP;
      steps++;
    }
    if (steps === 4) acc = 0;
    perf.record(dt * 1000, steps, now);
    car.sync(acc / STEP);
    placeCamera(dt, false);

    const p = car.mesh.position;
    placeSun(p);

    hudTimer -= dt;
    if (hudTimer <= 0) {
      hudTimer = 0.1;
      hudSpeed.textContent = `${Math.round(Math.abs(car.speed) * 3.6)}`;
      hudSurface.textContent = car.wheelsOnGround ? car.surface.name : 'Airborne';
      const zone = course.zoneAt(p.x, p.z);
      hudZone.textContent = zone ?? '';
      hudZone.style.opacity = zone ? '1' : '0';
    }
    fpsFrames++;
    fpsTime += dt;
    if (fpsTime > 1) {
      hudFps.textContent = `${Math.round(fpsFrames / fpsTime)} fps · build ${__BUILD_ID__}`;
      fpsFrames = 0;
      fpsTime = 0;
    }
    if (controls.used || now > 12000) hint.classList.add('hidden');

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  $('loading').remove();

  // Handy for testing in the console.
  Object.assign(window, { game: { car, course, controls, world } });
}

start().catch((err) => {
  console.error(err);
  $('loading').textContent = 'Could not start: ' + (err?.message ?? err);
});
