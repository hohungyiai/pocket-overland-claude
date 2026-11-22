import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { buildUbinCourse } from './courses/ubin';
import { buildEastCoastCourse } from './courses/eastcoast';
import { buildPasirRisCourse } from './courses/osmcity';
import { buildUbinTrailCourse } from './courses/ubintrail';
import { CHEK_JAWA, PUAKA } from './courses/ubintrail/trails';
import { skyTexture, type ArtStyle } from './courses/detail';
import { Minimap } from './minimap';
import { FullMap } from './fullmap';
import { Vehicle } from './vehicle';
import { Controls } from './controls';
import { PerfOverlay } from './perf';
import { Weather } from './weather';
import { Camps } from './camp';
import { loadJourney, saveJourney, spotOf, checkStorage, storageWarning, backupPanel, restorePanel, describe, encodeCode, decodeCode, normalise, type Journey, type StorageHealth } from './save';
import { Fuel, CRAWL_SPEED, distText, onForecourt } from './fuel';
import { SURFACES } from './courses/types';
import { Stations } from './station';
import { Garages, garagePanel, homePicker, garageById, type GarageSpot } from './garage';
import './style.css';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const COURSES = {
  pasirris: buildPasirRisCourse,
  // Road redraw trial: the streets round the TPE / PIE / Upper Changi Road
  // East interchange, built by the same builder from a redrawn network.
  trial: ((scene, world, RAPIER, opts) =>
    buildPasirRisCourse(scene, world, RAPIER, { ...opts, map: 'maps/trial-ucre.json', name: 'Road trial: Upper Changi interchange', startAt: [1870, 1759] })) as typeof buildPasirRisCourse,
  // The same redraw over the whole map: a preview beside today's map.
  whole: ((scene, world, RAPIER, opts) =>
    buildPasirRisCourse(scene, world, RAPIER, { ...opts, map: 'maps/east-redrawn.json', name: 'Redrawn roads: the whole map (preview)' })) as typeof buildPasirRisCourse,
  eastcoast: buildEastCoastCourse,
  // The first off-road trail: Pulau Ubin, round Ketam Quarry.
  ubintrail: buildUbinTrailCourse,
  ubinpuaka: (...a: Parameters<typeof buildUbinTrailCourse>) => buildUbinTrailCourse(a[0], a[1], a[2], a[3], PUAKA),
  ubinchekjawa: (...a: Parameters<typeof buildUbinTrailCourse>) => buildUbinTrailCourse(a[0], a[1], a[2], a[3], CHEK_JAWA),
  ubin: buildUbinCourse,
} as const;
type CourseId = keyof typeof COURSES;

async function start(courseId: CourseId, style: ArtStyle, at: { x: number; z: number; yaw: number; cam: number; y?: number } | null) {
  const health = await health$;
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
  // A petrol station's forecourt is paved to its kerb, whatever the ground
  // raster under its edge says.
  const courts = course.fuel ?? [];
  const paved = (x: number, z: number, y: number) =>
    courts.some((s) => Math.abs(x - s.x) < s.r + 1 && Math.abs(z - s.z) < s.r + 1 && onForecourt(s, x, z)) ? SURFACES.asphalt : rawSurface(x, z, y);
  course.surfaceAt = (x, z, y) => weather.feel(paved(x, z, y));
  let toast: string | null = null;
  let toastTime = 0;
  const say = (text: string, secs = 4) => {
    toast = text;
    toastTime = secs;
  };
  weather.onChange = (text) => say(text);
  const camps = course.camps?.length ? new Camps(scene, course.camps, course.heightAt) : null;

  let fromGarage = false;
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
    if (!fromGarage) fullMap.range = null;
    fromGarage = false;
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
      camps.pitch(spot, { x: p.x, z: p.z, yaw: carHeading() });
      const saved = autosave(spot.label, spot.id);
      weather.setTime('evening');
      say(saved ? `Evening at ${spot.label}. Journey saved.` : `Evening at ${spot.label}.`, 6);
    });
  });

  if (at) {
    // (A saved height puts the car back on the bridge deck it was on, not the ground below.)
    const y = at.y !== undefined && course.surfaceY ? course.surfaceY(at.x, at.z, at.y) : course.heightAt(at.x, at.z);
    car.placeAt(new THREE.Vector3(at.x, y, at.z), at.yaw);
    camMode = at.cam % camModes.length;
  }

  // ---- Saving: kept on the phone all the time (see save.ts) ----
  const blank = (): Journey => ({ course: courseId, x: 0, z: 0, yaw: 0, label: '', odo: 0, savedAt: Date.now(), backupOdo: 0, backupAt: Date.now() });
  const journey: Journey = loadJourney() ?? blank();
  let lastSaved = { x: NaN, z: NaN, camp: '' };
  let lastPos = { x: car.mesh.position.x, y: car.mesh.position.y, z: car.mesh.position.z };
  // Fuel (fuel.ts): used only on maps with petrol stations.
  const fuel = new Fuel(course.fuel ?? [], journey.fuel ?? 1);
  const hudFuel = $('hud-fuel');
  hudFuel.hidden = !fuel.used;
  const btnFuel = $('btn-fuel');
  let fuelStage = fuel.level < 0.05 ? 2 : fuel.level < 0.25 ? 1 : 0;
  tap(btnFuel, () => {
    if (fuel.at(car.mesh.position.x, car.mesh.position.z)) fuel.filling = true;
  });
  // Dust and mud build up off the tarmac; the garage washes them off.
  car.setDust(journey.dust ?? 0);

  // Petrol stations as places (station.ts): forecourt, canopy, pumps, sign.
  const stations = new Stations(scene, world, RAPIER, course.fuel ?? []);

  // ---- Garages (garage.ts): drive into the bay, tap Enter garage ----
  const garages = new Garages(scene, courseId, (x, z) => {
    const g = course.heightAt(x, z);
    return course.surfaceY?.(x, z, g + 0.5) ?? g;
  });
  for (const g of garages.here) course.map.pois.push({ x: g.x, z: g.z, label: `${g.name} Garage`, kind: 'garage' });
  const btnGarage = $('btn-garage');
  const enterGarage = (g: GarageSpot) => {
    pause(true);
    journey.garages = [...new Set([...(journey.garages ?? []), g.id])];
    if (!journey.home) journey.home = g.id;
    autosave(`${g.name} Garage`);
    btnGarage.hidden = true;
    const panel = garagePanel($('app'), g, { fuel: fuel.used ? fuel.level : null, dust: car.dust, home: journey.home === g.id }, (a) => {
      if (a === 'refuel') {
        fuel.level = 1;
        fuelStage = 0;
        panel.update({ fuel: 1 });
      } else if (a === 'wash') {
        car.setDust(0);
        panel.update({ dust: 0 });
      } else if (a === 'home') {
        journey.home = g.id;
        panel.update({ home: true });
      } else if (a === 'backup') {
        backupPanel($('app'), journey, (done) => {
          if (done) {
            journey.backupOdo = journey.odo;
            journey.backupAt = Date.now();
            driveSecs = 0;
          }
          autosave(`${g.name} Garage`);
        });
        return;
      } else if (a === 'plan') {
        panel.el.remove();
        pause(false);
        fromGarage = true;
        fullMap.range = fuel.used ? { metres: fuel.rangeKm * 1000, text: `Fuel ${Math.round(fuel.level * 100)}% · about ${Math.round(fuel.rangeKm)} km` } : null;
        openMap();
        return;
      } else if (a === 'leave') {
        pause(false);
        say(`Out on the road from ${g.name}.`, 4);
      }
      autosave(`${g.name} Garage`);
    });
  };
  tap(btnGarage, () => {
    const p = car.mesh.position;
    const g = garages.at(p.x, p.z);
    if (g) enterGarage(g);
  });
  // Driving time since the last backup, this visit.
  let driveSecs = 0;
  const autosave = (label?: string, camp?: string) => {
    const p = car.mesh.position;
    Object.assign(journey, {
      course: courseId,
      x: p.x,
      z: p.z,
      y: p.y,
      yaw: carHeading(),
      label: label ?? camps?.active?.label ?? course.zoneAt(p.x, p.z) ?? course.name,
      fuel: fuel.level,
      dust: car.dust,
      style,
      camp: camp ?? camps?.active?.id,
      savedAt: Date.now(),
    });
    if (!journey.camp) delete journey.camp;
    (journey.spots ??= {})[courseId] = spotOf(journey);
    lastSaved = { x: p.x, z: p.z, camp: journey.camp ?? '' };
    return saveJourney(journey);
  };
  let saveTimer = 10;
  const saveIfMoved = () => {
    const p = car.mesh.position;
    if (Math.hypot(p.x - lastSaved.x, p.z - lastSaved.z) > 2 || (camps?.active?.id ?? '') !== lastSaved.camp || Number.isNaN(lastSaved.x)) autosave();
  };
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && saveIfMoved());
  window.addEventListener('pagehide', saveIfMoved);

  // Backups: offered once you stop after a long drive, never mid-drive.
  // Try an obstacle again: back to a little before its start, facing along
  // the trail, low range and the diff lock as they were. Offered when
  // stopped on or beside one (stuck in the mud, slid off into the water).
  const btnRetry = $('btn-retry');
  let retrySpot: { x: number; z: number; yaw: number; label: string } | null = null;
  tap(btnRetry, () => {
    if (!retrySpot) return;
    const r = retrySpot;
    course.penalty?.('retry', car.mesh.position.x, car.mesh.position.z);
    course.prepareAt?.(r.x, r.z);
    car.placeAt(new THREE.Vector3(r.x, course.heightAt(r.x, r.z) + 0.1, r.z), r.yaw);
    btnRetry.hidden = true;
    say(`Back to the start of the ${r.label.toLowerCase()}.`, 3);
  });
  // The winch (trails with marked trees): offered when slow with a marked
  // tree in reach; tap to reel in, tap again to stop. It unhooks once the
  // car is up to the tree, or driving off under its own power.
  const btnWinch = $('btn-winch');
  let winchTo: { x: number; y: number; z: number; help?: boolean } | null = null;
  const cable = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0x1f1f1f }));
  cable.visible = false;
  cable.frustumCulled = false;
  scene.add(cable);
  tap(btnWinch, () => {
    if (car.winch) {
      car.winch = null;
      say('Winch off.', 2);
    } else if (winchTo) {
      car.winch = winchTo;
      course.penalty?.('winch', car.mesh.position.x, car.mesh.position.z);
      say(winchTo.help ? 'Winching: it helps the wheels, so keep driving it.' : 'Winching back onto the track.', 4);
    }
    btnWinch.hidden = true;
  });
  const hudScore = $('hud-score');
  course.setBest?.(journey.best?.[courseId] ?? {});
  const btnBackup = $('btn-backup');
  let paused = false;
  const pause = (on: boolean) => {
    paused = on;
    controls.reset();
    if (!on) {
      last = performance.now();
      acc = 0;
    }
  };
  const openBackup = () => {
    autosave();
    pause(true);
    btnBackup.hidden = true;
    backupPanel($('app'), journey, (done) => {
      if (done) {
        journey.backupOdo = journey.odo;
        journey.backupAt = Date.now();
        driveSecs = 0;
        autosave();
      } else snooze();
      pause(false);
    });
  };
  // How long a drive counts as long: shorter when this tab may lose progress.
  const longKm = health.installed ? 80 : 20;
  const longSecs = health.installed ? 7200 : 1800;
  let snoozeOdo = 0;
  const snooze = () => (snoozeOdo = journey.odo);
  const backupDue = () =>
    journey.odo - snoozeOdo > 2000 && (journey.odo - journey.backupOdo > longKm * 1000 || (driveSecs > longSecs && journey.odo - journey.backupOdo > 2000));
  tap(btnBackup, openBackup);
  let stoppedFor = 0;

  // Before the drive: say plainly if this tab may not keep it.
  const warning = storageWarning(health);
  // (The notice fades by itself after a while, so nobody has to take a
  // hand off the wheel for it, or goes at once with a tap. The same words
  // stay in the menu.)
  const notice = $('notice');
  // Called once, the first time the player touches the controls.
  let noticeOnDrive: (() => void) | null = null;
  if (warning) {
    notice.innerHTML = '';
    const t = document.createElement('span');
    t.textContent = warning.short;
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = warning.level === 'none' ? 'I understand' : 'OK';
    notice.append(t, b);
    notice.classList.toggle('strong', warning.level === 'none');
    notice.hidden = false;
    // (Only the stronger warning holds the game, and only it lets go.)
    let held = warning.level === 'none';
    if (held) pause(true);
    const hide = () => {
      notice.hidden = true;
      notice.classList.remove('fading');
      if (held && paused) pause(false);
      held = false;
    };
    b.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      hide();
    });
    // (It stays up until the player first touches the controls, then fades
    // two seconds later. The stronger warning holds the game, so nobody can
    // drive: it goes after 15 s on the clock.)
    const fadeIn = (secs: number) => {
      setTimeout(() => !notice.hidden && notice.classList.add('fading'), (secs - 1) * 1000);
      setTimeout(() => !notice.hidden && hide(), secs * 1000);
    };
    if (warning.level === 'none') fadeIn(15);
    else noticeOnDrive = () => fadeIn(2);
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
    if (paused) {
      last = now;
      renderer.render(scene, camera);
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
    // Odometer (a jump, from ↺ or a reload, isn't driving).
    const moved = Math.hypot(p.x - lastPos.x, p.z - lastPos.z);
    if (moved < 10) {
      journey.odo += moved;
      fuel.burn(moved, p.y - lastPos.y, car.surface, car.lowRange);
      // (About 3 km of gravel, or 600 m of sand or mud, to cake it.)
      const grime = car.surface.drag >= 20 ? 1 / 600 : car.surface.drag >= 1.5 ? 1 / 3000 : 0;
      if (grime && car.wheelsOnGround) car.setDust(car.dust + moved * grime);
    }
    lastPos = { x: p.x, y: p.y, z: p.z };
    car.crawl = fuel.empty ? CRAWL_SPEED : 0;
    if (fuel.filling && fuel.pump(dt)) {
      fuel.filling = false;
      say(`Tank full at ${fuel.at(p.x, p.z)?.name ?? 'the station'}.`, 5);
      fuelStage = 0;
      autosave();
    }
    course.update?.(now / 1000, dt, camera.position, p);
    weather.update(dt, camera.position);
    camps?.update(now / 1000);
    minimap.draw(p.x, p.z, carHeading());

    hudTimer -= dt;
    if (hudTimer <= 0) {
      hudTimer = 0.1;
      hudSpeed.textContent = `${Math.round(Math.abs(car.speed) * 3.6)}`;
      hudSurface.textContent = car.wheelsOnGround || car.winch ? car.surface.name : 'Airborne';
      // Never a fail state: if the car sits stuck under throttle, offer a tip.
      stuckTime = Math.abs(car.speed) < 0.4 && Math.abs(controls.input.throttle) > 0.3 ? stuckTime + 0.1 : 0;
      // A trail coaches its own obstacles (and opens a way round after a few tries).
      const coach = course.coach?.({ x: p.x, z: p.z, speed: car.speed, low: car.lowRange, diff: car.diffLock, stuck: stuckTime }) ?? null;
      if (coach?.say) say(coach.say, 6);
      if (coach?.scored) {
        ((journey.best ??= {})[courseId] ??= {})[coach.scored.label] = coach.scored.best;
        autosave();
      }
      const tip = coach?.tip ?? (stuckTime > 3 ? (car.lowRange && car.diffLock ? 'Tip: back up and take a run at it, or tap ↺' : 'Tip: try LOW range and DIFF lock') : null);
      toastTime -= 0.1;
      if (toastTime <= 0) toast = null;
      // Fuel: a calm word when low, the way to the nearest station, a crawl when empty.
      let fuelLine: string | null = null;
      if (fuel.used) {
        const near = fuel.nearest(p.x, p.z);
        const where = near ? `${near.station.name}, ${distText(near.dist)}` : '';
        const stage = fuel.level <= 0 ? 3 : fuel.level < 0.05 ? 2 : fuel.level < 0.25 ? 1 : 0;
        if (stage > fuelStage) {
          if (stage === 1) say(`Fuel getting low. Nearest: ${where}`, 8);
          else toast = null; // (the reserve and crawl lines below take over)
        }
        fuelStage = Math.max(fuelStage, stage);
        if (stage === 2) fuelLine = `Fuel on reserve · ${where}`;
        if (stage === 3) fuelLine = `Out of fuel: crawling on to ${where}`;
        minimap.target = stage > 0 && near ? near.station : null;
        const range = fuel.rangeKm;
        hudFuel.querySelector('b')!.style.width = `${Math.round(fuel.level * 100)}%`;
        hudFuel.querySelector('span')!.textContent = fuel.filling ? `Filling ${Math.round(fuel.level * 100)}%` : stage === 3 ? 'Empty' : `${range < 10 ? range.toFixed(1) : Math.round(range)} km`;
        hudFuel.classList.toggle('low', stage > 0);
        hudFuel.classList.toggle('empty', stage === 3);
        // Fill up: stopped on a station's forecourt.
        const station = fuel.at(p.x, p.z);
        if (!station) fuel.filling = false;
        btnFuel.hidden = !station || fuel.filling || fuel.level > 0.98 || Math.abs(car.speed) > 0.8;
        btnFuel.textContent = `Fill up at ${station?.name ?? ''}`;
      }
      // Garage: the bay drapes on the road once that's built (a ray down, past the car).
      garages.settle((x, z) => {
        if (course.solidAt && !course.solidAt(x, z)) return null;
        const hit = world.castRay(new RAPIER.Ray({ x, y: course.heightAt(x, z) + 6, z }, { x: 0, y: -1, z: 0 }), 12, true, undefined, undefined, undefined, car.body);
        return hit ? course.heightAt(x, z) + 6 - hit.timeOfImpact : null;
      });
      stations.settle(
        (x, z) => course.heightAt(x, z),
        (x, z) => !course.solidAt || course.solidAt(x, z),
        (x, z) => {
          const hit = world.castRay(new RAPIER.Ray({ x, y: course.heightAt(x, z) + 6, z }, { x: 0, y: -1, z: 0 }), 12, true, undefined, undefined, undefined, car.body);
          return hit ? { y: course.heightAt(x, z) + 6 - hit.timeOfImpact, ground: hit.collider.shape.type === RAPIER.ShapeType.HeightField } : null;
        },
        (x, z) => course.safeSpot?.(x, z) ?? null,
      );
      // Garage: Enter garage when stopped in its bay.
      const bay = garages.at(p.x, p.z);
      btnGarage.hidden = !bay || Math.abs(car.speed) > 0.8 || paused;
      if (bay) btnGarage.textContent = `Enter ${bay.name} Garage`;
      const zone = tip ?? toast ?? fuelLine ?? coach?.zone ?? course.zoneAt(p.x, p.z);
      // Camp button: shown when stopped inside a camp, or while camped.
      if (camps) {
        const spot = camps.at(p.x, p.z);
        if (camps.active && !spot && !fading) breakCamp('You packed up at first light.');
        const show = !!camps.active || (!!spot && Math.abs(car.speed) < 0.8);
        btnCamp.hidden = !show;
        btnCamp.textContent = camps.active ? 'Break camp' : `Make camp`;
      }
      // Saving: every 10 s while driving; a backup offer once stopped after a long drive.
      if (Math.abs(car.speed) > 1) {
        driveSecs += 0.1;
      }
      if (noticeOnDrive && (Math.abs(controls.input.throttle) > 0.05 || Math.abs(controls.input.steer) > 0.05)) {
        noticeOnDrive();
        noticeOnDrive = null;
      }
      saveTimer -= 0.1;
      if (saveTimer <= 0) {
        saveTimer = 10;
        saveIfMoved();
      }
      stoppedFor = Math.abs(car.speed) < 1 ? stoppedFor + 0.1 : 0;
      retrySpot = Math.abs(car.speed) < 1.5 && !paused ? (course.retryAt?.(p.x, p.z) ?? null) : null;
      btnRetry.hidden = !retrySpot || !btnCamp.hidden;
      if (course.winchAt) {
        const tp = car.towPoint;
        if (car.winchEnded) {
          say(car.winchEnded === 'stalled' ? 'The winch cannot shift it from here: try another tree, or try again.' : 'Unhooked: the winch is wound in.', 3);
          car.winchEnded = null;
        } else if (car.winch && course.winchHome?.(p.x, p.z)) {
          car.winch = null;
          say('Back on the track: unhooked.', 2);
        }
        const fw = car.mesh.position;
        winchTo = !car.winch && Math.abs(car.speed) < 1.5 && !paused ? course.winchAt(tp.x, tp.y, tp.z, tp.x - fw.x, tp.z - fw.z, car.winchStalledAt, { low: car.lowRange, diff: car.diffLock }) : null;
        btnWinch.hidden = !(car.winch || winchTo) || !btnCamp.hidden;
        btnWinch.textContent = car.winch ? 'Stop winch' : 'Winch';
        const sc = course.score?.();
        hudScore.hidden = !sc;
        if (sc) hudScore.textContent = `${sc.label}: ${sc.points === 0 ? 'clean so far' : `${sc.points} point${sc.points === 1 ? '' : 's'}`}${sc.best !== undefined ? ` · best ${sc.best}` : ''}`;
      }
      if (retrySpot) btnRetry.textContent = `Try the ${retrySpot.label.toLowerCase()} again`;
      if (btnBackup.hidden && btnRetry.hidden && stoppedFor > 2 && btnCamp.hidden && btnFuel.hidden && btnGarage.hidden && backupDue()) btnBackup.hidden = false;
      else if (!btnBackup.hidden && stoppedFor === 0) {
        btnBackup.hidden = true;
        snooze();
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
    cable.visible = !!car.winch;
    if (car.winch) {
      const pos = cable.geometry.attributes.position as THREE.BufferAttribute;
      pos.setXYZ(0, car.towPoint.x, car.towPoint.y, car.towPoint.z);
      pos.setXYZ(1, car.winch.x, car.winch.y, car.winch.z);
      pos.needsUpdate = true;
    }

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  $('loading').remove();

  // Handy for testing in the console.
  Object.assign(window, { game: { RAPIER, car, course, controls, world, renderer, scene, camera, weather, camps, sim, journey, autosave, openBackup, fuel, stations, garages, enterGarage, save: { encodeCode, decodeCode, normalise, loadJourney } } });
}

// ---- Course picker ----
const params = new URLSearchParams(location.search);
const go = (id: CourseId) => {
  $('menu').remove();
  document.body.classList.add('driving');
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
const at =
  (atParts.length === 4 || atParts.length === 5) && atParts.every(Number.isFinite)
    ? { x: atParts[0], z: atParts[1], yaw: atParts[2], cam: atParts[3], y: atParts[4] }
    : null;
// Checked once, before the menu shows and before a drive starts.
const health$: Promise<StorageHealth> = checkStorage();
const continueFrom = (j: Pick<Journey, 'course' | 'x' | 'z' | 'yaw' | 'y' | 'style'>) => {
  if (!(j.course in COURSES)) return;
  const q = new URLSearchParams({ course: j.course, style: j.style ?? 'detailed', at: [j.x, j.z, j.yaw, 0, ...(j.y !== undefined ? [j.y] : [])].map((v) => +v.toFixed(2)).join(',') });
  location.replace(`${location.pathname}?${q}`);
};
if (chosen && chosen in COURSES) go(chosen as CourseId);
else {
  $('loading').style.display = 'none';
  const choices = document.querySelector('#menu .choices')!;
  const journey = loadJourney();
  if (journey && journey.course in COURSES) {
    const b = document.createElement('button');
    b.className = 'continue';
    b.innerHTML = `<b>Continue</b><span></span>`;
    b.querySelector('span')!.textContent = describe(journey);
    b.addEventListener('click', () => continueFrom(journey));
    choices.prepend(b);
  }
  // Backup and restore, and the plain word on whether this tab keeps progress.
  const tools = $('menu-tools');
  const mk = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.className = 'link';
    b.textContent = label;
    b.addEventListener('click', fn);
    tools.append(b);
    return b;
  };
  const openRestore = (prefill = '') =>
    restorePanel(
      $('app'),
      prefill,
      (c) => c in COURSES,
      (j) => {
        saveJourney(j);
        continueFrom(j);
      },
      () => history.replaceState(null, '', location.pathname),
    );
  if (journey) mk('Back up your journey', () => backupPanel($('app'), journey, (done) => {
    if (!done) return;
    journey.backupOdo = journey.odo;
    journey.backupAt = Date.now();
    saveJourney(journey);
  }));
  mk('Restore from a save code', () => openRestore());
  // Home garage: a new journey starts there; choosing one drives you to it.
  const startAt = (g: GarageSpot) => {
    const j: Journey = journey ?? { course: g.courses[0], x: g.x, z: g.z, yaw: g.yaw, label: '', odo: 0, savedAt: Date.now(), backupOdo: 0, backupAt: Date.now() };
    Object.assign(j, { course: g.courses[0], x: g.x, z: g.z, yaw: g.yaw, label: `${g.name} Garage`, home: g.id, garages: [...new Set([...(j.garages ?? []), g.id])], savedAt: Date.now() });
    delete j.y;
    delete j.camp;
    saveJourney(j);
    continueFrom(j);
  };
  const pickHome = () => homePicker($('app'), journey?.home, startAt, () => {});
  if (!journey) {
    const b = document.createElement('button');
    b.className = 'continue';
    b.innerHTML = `<b>Start your journey</b><span>From your home garage in Singapore</span>`;
    b.addEventListener('click', pickHome);
    choices.prepend(b);
  } else {
    const home = garageById(journey.home);
    mk(home ? `Home: ${home.name}` : 'Choose a home garage', pickHome);
  }
  // A shared restore link: …#restore=PO1-…
  const fromHash = () => {
    const hash = decodeURIComponent(location.hash);
    if (hash.startsWith('#restore=') && !document.querySelector('.panel')) openRestore(hash.slice(9));
  };
  fromHash();
  window.addEventListener('hashchange', fromHash);
  health$.then((h) => {
    const w = storageWarning(h);
    if (!w) return;
    const box = $('menu-warning');
    const t = document.createElement('span');
    t.textContent = w.text;
    box.append(t);
    box.classList.toggle('strong', w.level === 'none');
    box.hidden = false;
    // Android: the browser's own install, when it offers one.
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      const prompt = e as Event & { prompt(): Promise<void> };
      const b = document.createElement('button');
      b.className = 'btn primary';
      b.textContent = 'Install';
      b.addEventListener('click', () => prompt.prompt());
      box.append(b);
    });
  });
  // A drive you've been on before carries on where you left it (each drive
  // keeps its own place, so looking at another never loses this one).
  document.querySelectorAll<HTMLButtonElement>('#menu [data-course]').forEach((b) => {
    const id = b.dataset.course as CourseId;
    const spot = journey?.spots?.[id];
    if (spot) {
      const line = document.createElement('span');
      line.className = 'carry-on';
      line.textContent = `Carry on from ${spot.label || 'where you left it'}`;
      b.append(line);
    }
    b.addEventListener('click', () => {
      if (spot) return continueFrom({ course: id, ...spot });
      history.replaceState(null, '', `?course=${id}`);
      go(id);
    });
  });
}

$('btn-menu').addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  location.href = location.pathname;
});
