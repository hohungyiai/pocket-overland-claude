import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { buildUbinCourse } from './courses/ubin';
import { buildEastCoastCourse } from './courses/eastcoast';
import { buildPasirRisCourse } from './courses/osmcity';
import { buildUbinTrailCourse } from './courses/ubintrail';
import { skyTexture, type ArtStyle } from './courses/detail';
import { Minimap } from './minimap';
import { FullMap } from './fullmap';
import { Vehicle } from './vehicle';
import { Controls } from './controls';
import { PerfOverlay } from './perf';
import { Weather } from './weather';
import { Camps, loadSave } from './camp';
import './style.css';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const COURSES = {
  pasirris: buildPasirRisCourse,
  // Road redraw trial: the streets round the TPE / PIE / Upper Changi Road
  // East interchange, built by the same builder from a redrawn network.
  trial: ((scene, world, RAPIER, opts) =>
    buildPasirRisCourse(scene, world, RAPIER, { ...opts, map: 'maps/trial-ucre.json', name: 'Road trial: Upper Changi interchange', startAt: [1870, 1759] })) as typeof buildPasirRisCourse,
  eastcoast: buildEastCoastCourse,
  // The first off-road trail: Pulau Ubin, round Ketam Quarry.
  ubintrail: buildUbinTrailCourse,
  ubin: buildUbinCourse,
} as const;
type CourseId = keyof typeof COURSES;

async function start(courseId: CourseId, style: ArtStyle, at: { x: number; z: number; yaw: number; cam: number } | null) {
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

  const detailed = style === 'detailed';
  const hemi = new THREE.HemisphereLight(0xdfeefa, 0x5a5236, 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(detailed ? 2048 : 1024);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -32;
  sc.right = sc.top = 32;
  sc.near = 1;
  sc.far = 140;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  const sunOffset = new THREE.Vector3(-40, 70, 30);

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 3000);

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const course = await COURSES[courseId](scene, world, RAPIER, { style });
  scene.background = new THREE.Color(course.sky.background);
  scene.fog = new THREE.Fog(course.sky.fog, course.sky.fogNear, course.sky.fogFar);
  if (detailed && course.styles) {
    // Painted sky as backdrop and as the reflection environment (water, car paint).
    const sky = skyTexture(sunOffset.clone().normalize());
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.background = sky;
    scene.environment = pmrem.fromEquirectangular(sky).texture;
    scene.environmentIntensity = 0.4;
    pmrem.dispose();
    hemi.intensity = 0.55;
    (scene.fog as THREE.Fog).color.set(0xcfdbe0);
  }
  camera.far = Math.max(400, course.sky.fogFar + 100);
  camera.updateProjectionMatrix();
  // Weather (style-neutral): showers come and go; wet ground grips a little less.
  const weather = new Weather({ scene, sun, hemi, sunOffset });
  const rawSurface = course.surfaceAt;
  course.surfaceAt = (x, z, y) => weather.feel(rawSurface(x, z, y));
  let toast: string | null = null;
  let toastTime = 0;
  const say = (text: string, secs = 4) => {
    toast = text;
    toastTime = secs;
  };
  weather.onChange = (text) => say(text);
  const camps = course.camps?.length ? new Camps(scene, course.camps, course.heightAt) : null;

  const fwdMap = new THREE.Vector3();
  const carHeading = () => Math.atan2(-fwdMap.set(1, 0, 0).applyQuaternion(car.mesh.quaternion).z, fwdMap.x);
  // The drive pauses while the full map is open, so nothing moves while you look.
  const fullMap = new FullMap(
    $('app'),
    course.map,
    course.name,
    () => {
      last = performance.now();
      acc = 0;
    },
    // Drive from a spot picked on the map: the nearest road to it, where
    // the course knows one (a reload, so the world there is built fresh).
    (x, z) => {
      const spot = course.safeSpot?.(x, z) ?? { x, z, yaw: carHeading() };
      const q = new URLSearchParams({
        course: courseId,
        style: detailed ? 'detailed' : 'stylized',
        at: [spot.x, spot.z, spot.yaw, camMode].map((v) => +v.toFixed(2)).join(','),
      });
      location.replace(`${location.pathname}?${q}`);
    },
  );
  const openMap = () => {
    controls.reset();
    fullMap.open(car.mesh.position.x, car.mesh.position.z, carHeading());
  };
  const minimap = new Minimap($('app'), course.map, openMap);
  // Streamed courses load the ground around where the car will appear first.
  const spawn = at ?? { x: course.start.x, z: course.start.z };
  course.prepareAt?.(spawn.x, spawn.z);
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
  // Art style switch: rebuild the same course in the other look, keeping the
  // car where it is (a reload, so the old world is fully freed).
  const btnStyle = $('btn-style');
  if (course.styles) {
    btnStyle.hidden = false;
    btnStyle.textContent = detailed ? 'Detailed' : 'Stylized';
    tap(btnStyle, () => {
      const p = car.mesh.position;
      const q = new URLSearchParams({
        course: courseId,
        style: detailed ? 'stylized' : 'detailed',
        at: [p.x, p.z, carHeading(), camMode].map((v) => +v.toFixed(2)).join(','),
      });
      location.replace(`${location.pathname}?${q}`);
    });
  }
  // ---- Camp: stop inside a camp to rest (evening) and save; leave in the morning ----
  const btnCamp = $('btn-camp');
  const fade = $('fade');
  let fading = false;
  const fadeThen = (fn: () => void) => {
    if (fading) return;
    fading = true;
    fade.classList.add('on');
    setTimeout(() => {
      fn();
      fade.classList.remove('on');
      setTimeout(() => (fading = false), 900);
    }, 900);
  };
  const breakCamp = (msg: string) =>
    fadeThen(() => {
      camps?.strike();
      weather.setTime('morning');
      say(msg);
    });
  tap(btnCamp, () => {
    if (!camps) return;
    if (camps.active) return breakCamp('Morning. On the road again.');
    const spot = camps.at(car.mesh.position.x, car.mesh.position.z);
    if (!spot) return;
    fadeThen(() => {
      const p = car.mesh.position;
      const saved = camps.pitch(spot, { x: p.x, z: p.z, yaw: carHeading() }, courseId, style);
      weather.setTime('evening');
      say(saved ? `Evening at ${spot.label}. Journey saved.` : `Evening at ${spot.label}.`, 6);
    });
  });

  if (at) {
    car.placeAt(new THREE.Vector3(at.x, course.heightAt(at.x, at.z), at.z), at.yaw);
    camMode = at.cam % camModes.length;
  }
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'm') return fullMap.isOpen ? fullMap.close() : openMap();
    if (fullMap.isOpen) return;
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
  // (Recomputed each frame: the sun moves when the evening comes.)
  const lightFwd = new THREE.Vector3();
  const lightRight = new THREE.Vector3();
  const lightUp = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const texel = (sc.right - sc.left) / sun.shadow.mapSize.x;
  const shadowCentre = new THREE.Vector3();
  const placeSun = (p: THREE.Vector3) => {
    lightFwd.copy(sunOffset).negate().normalize();
    lightRight.crossVectors(lightFwd, worldUp).normalize();
    lightUp.crossVectors(lightRight, lightFwd);
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
  let stuckTime = 0;
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

  // For the drive bot (tools/check/bot.js): `sim.fast` physics steps a frame,
  // run ahead of the clock with nothing drawn, so a test drive across the map
  // takes seconds. The car waits wherever the ground ahead is not built yet.
  const sim = { fast: 0, steps: 0 };
  const fastFrame = (now: number) => {
    const t0 = performance.now();
    const built = () => {
      if (!course.solidAt) return true;
      const p = car.body.translation();
      const v = car.body.linvel();
      for (const [dx, dz] of [[0, 0], [15, 0], [-15, 0], [0, 15], [0, -15], [v.x * 1.5, v.z * 1.5]]) if (!course.solidAt(p.x + dx, p.z + dz)) return false;
      return true;
    };
    for (let n = 0; n < sim.fast && performance.now() - t0 < 12; n++) {
      if (!built()) break;
      controls.update(STEP);
      car.update(STEP, controls.input);
      world.step();
      car.capture();
      sim.steps++;
    }
    car.sync(1);
    // (Tiles build in slices of a few milliseconds: several slices a frame.)
    do course.update?.(now / 1000, 0, undefined, car.mesh.position);
    while (!built() && performance.now() - t0 < 40);
    last = now;
    acc = 0;
  };

  const frame = (now: number) => {
    if (fullMap.isOpen) {
      fullMap.draw();
      requestAnimationFrame(frame);
      return;
    }
    if (sim.fast > 0) {
      fastFrame(now);
      requestAnimationFrame(frame);
      return;
    }
    // (Never negative: the first frame after the world is built can carry a
    // time stamp from before the build began, a minute stale on a slow
    // device. That froze the car for as long, and wound the steering and
    // pedal far past full lock and full reverse.)
    const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
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
    course.update?.(now / 1000, dt, camera.position, p);
    weather.update(dt, camera.position);
    camps?.update(now / 1000);
    minimap.draw(p.x, p.z, carHeading());

    hudTimer -= dt;
    if (hudTimer <= 0) {
      hudTimer = 0.1;
      hudSpeed.textContent = `${Math.round(Math.abs(car.speed) * 3.6)}`;
      hudSurface.textContent = car.wheelsOnGround ? car.surface.name : 'Airborne';
      // Never a fail state: if the car sits stuck under throttle, offer a tip.
      stuckTime = Math.abs(car.speed) < 0.4 && Math.abs(controls.input.throttle) > 0.3 ? stuckTime + 0.1 : 0;
      // A trail coaches its own obstacles (and opens a way round after a few tries).
      const coach = course.coach?.({ x: p.x, z: p.z, speed: car.speed, low: car.lowRange, diff: car.diffLock, stuck: stuckTime }) ?? null;
      if (coach?.say) say(coach.say, 6);
      const tip = coach?.tip ?? (stuckTime > 3 ? (car.lowRange && car.diffLock ? 'Tip: back up and take a run at it, or tap ↺' : 'Tip: try LOW range and DIFF lock') : null);
      toastTime -= 0.1;
      if (toastTime <= 0) toast = null;
      const zone = tip ?? toast ?? coach?.zone ?? course.zoneAt(p.x, p.z);
      // Camp button: shown when stopped inside a camp, or while camped.
      if (camps) {
        const spot = camps.at(p.x, p.z);
        if (camps.active && !spot && !fading) breakCamp('You packed up at first light.');
        const show = !!camps.active || (!!spot && Math.abs(car.speed) < 0.8);
        btnCamp.hidden = !show;
        btnCamp.textContent = camps.active ? 'Break camp' : `Make camp`;
      }
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
  Object.assign(window, { game: { car, course, controls, world, renderer, scene, camera, weather, camps, sim } });
}

// ---- Course picker ----
const params = new URLSearchParams(location.search);
const go = (id: CourseId) => {
  $('menu').remove();
  $('loading').style.display = 'flex';
  // Let the loading screen paint before the (blocking) world build.
  requestAnimationFrame(() =>
    setTimeout(() =>
      start(id, style, at).catch((err) => {
        console.error(err);
        $('loading').textContent = 'Could not start: ' + (err?.message ?? err);
      }),
    ),
  );
};
const chosen = params.get('course');
const style: ArtStyle = params.get('style') === 'stylized' ? 'stylized' : 'detailed';
const atParts = (params.get('at') ?? '').split(',').map(Number);
const at = atParts.length === 4 && atParts.every(Number.isFinite) ? { x: atParts[0], z: atParts[1], yaw: atParts[2], cam: atParts[3] } : null;
if (chosen && chosen in COURSES) go(chosen as CourseId);
else {
  $('loading').style.display = 'none';
  const save = loadSave();
  if (save && save.course in COURSES) {
    const b = document.createElement('button');
    b.innerHTML = `<b>Continue</b><span>From ${save.label} · saved ${new Date(save.savedAt).toLocaleDateString()}</span>`;
    b.addEventListener('click', () => {
      const q = new URLSearchParams({ course: save.course, style: save.style ?? 'detailed', at: [save.x, save.z, save.yaw, 0].map((v) => +v.toFixed(2)).join(',') });
      location.replace(`${location.pathname}?${q}`);
    });
    document.querySelector('#menu .choices')!.prepend(b);
  }
  document.querySelectorAll<HTMLButtonElement>('#menu [data-course]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.course as CourseId;
      history.replaceState(null, '', `?course=${id}`);
      go(id);
    }),
  );
}
$('btn-menu').addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  location.href = location.pathname;
});
