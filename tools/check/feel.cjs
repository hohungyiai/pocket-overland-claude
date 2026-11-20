// Road feel: the car must drive on roads exactly as it did before.
// (`npm run build` first, then `node tools/check/feel.cjs`; `--record`
// writes the baseline from the build as it stands.)
// On each course below the car is placed at its start and played a fixed
// script of throttle, brake, steering and reverse, step by step in fast
// physics. Its track (position, speed, heading every quarter second) is
// compared with feel-baseline.json. Changes to the car's physics that are
// meant for off-road surfaces only must leave this unchanged.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const PORT = 4183;
const ROOT = path.join(__dirname, '..', '..');
const BASE = path.join(__dirname, 'feel-baseline.json');
const record = process.argv.includes('--record');
// [course, start (x, z, yaw) or null for the course's own start]
const RUNS = [
  ['pasirris', null],
  ['trial', null],
  ['ubintrail', null],
];
// The script: [seconds, throttle, steer, low range, diff lock]
const SCRIPT = [
  [3, 1, 0, false, false], // pull away hard
  [2, 0.3, 0.08, false, false], // gentle bend
  [1.5, -1, 0, false, false], // brake to a stop
  [1, 0, 0, false, false], // hill-hold
  [2.5, 0.5, -0.3, true, false], // low range, slow turn
  [1, 0, 0, true, true], // diff lock on, coast
  [2, -0.6, 0.2, false, false], // reverse
  [1, 0, 0, false, false],
];
// (Kept clear of kerbs and walls: a knock makes the car's track chaotic,
// so tiny differences in the order things were built would show.)
const TOL = { pos: 0.05, speed: 0.05, yaw: 0.01 };

(async () => {
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2500));
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const out = {};
  try {
    for (const [course, at] of RUNS) {
      const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
      page.on('pageerror', (e) => console.log('pageerror', e.message));
      await page.goto(`http://localhost:${PORT}/?course=${course}&debug`);
      await page.waitForFunction(() => window.game, null, { timeout: 240000 });
      out[course] = await page.evaluate(
        async ({ at, script }) => {
          const g = window.game;
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          // Let the start area finish building, at rest.
          await wait(10000);
          const p0 = g.car.body.translation();
          if (at) g.car.placeAt({ x: at[0], y: g.course.heightAt(at[0], at[1]) + 0.1, z: at[1] }, at[2]);
          else g.car.placeAt({ x: p0.x, y: p0.y + 0.1, z: p0.z }, Math.atan2(-g.car.forward.z, g.car.forward.x));
          const plan = [];
          for (const [sec, throttle, steer, low, diff] of script) for (let k = 0; k < Math.round(sec * 60); k++) plan.push({ throttle, steer, low, diff });
          const settle = 90;
          let step = 0;
          const track = [];
          const own = g.controls.update;
          const cap = g.car.capture;
          g.car.capture = function () {
            step++;
            const k = step - settle;
            if (k >= 0 && k < plan.length && k % 15 === 0) {
              const p = g.car.body.translation();
              const f = g.car.forward;
              track.push([+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3), +g.car.speed.toFixed(3), +Math.atan2(-f.z, f.x).toFixed(4)]);
            }
            return cap.call(this);
          };
          g.controls.update = function () {
            const k = step - settle;
            const s = k >= 0 && k < plan.length ? plan[k] : { throttle: 0, steer: 0, low: false, diff: false };
            this.input.throttle = s.throttle;
            this.input.steer = s.steer;
            g.car.lowRange = s.low;
            g.car.diffLock = s.diff;
          };
          g.sim.fast = 200;
          for (let t = 0; step < settle + plan.length && t < 20000; t++) await wait(5);
          g.sim.fast = 0;
          g.controls.update = own;
          g.car.capture = cap;
          return track;
        },
        { at, script: SCRIPT },
      );
      await page.close();
    }
  } finally {
    await browser.close();
    server.kill();
  }
  if (record) {
    fs.writeFileSync(BASE, JSON.stringify(out));
    console.log('recorded', Object.entries(out).map(([c, t]) => `${c}: ${t.length} samples`).join(', '));
    return;
  }
  const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  let failed = false;
  for (const [course] of RUNS) {
    const a = base[course];
    const b = out[course];
    let worst = { pos: 0, speed: 0, yaw: 0 };
    let at = -1;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (!a[i] || !b[i]) {
        worst.pos = Infinity;
        at = i;
        break;
      }
      const dp = Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1], a[i][2] - b[i][2]);
      const dv = Math.abs(a[i][3] - b[i][3]);
      let dy = Math.abs(a[i][4] - b[i][4]);
      if (dy > Math.PI) dy = 2 * Math.PI - dy;
      if (at < 0 && (dp > TOL.pos || dv > TOL.speed || dy > TOL.yaw)) at = i;
      worst = { pos: Math.max(worst.pos, dp), speed: Math.max(worst.speed, dv), yaw: Math.max(worst.yaw, dy) };
    }
    const ok = worst.pos <= TOL.pos && worst.speed <= TOL.speed && worst.yaw <= TOL.yaw;
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'}  The car drives on ${course} as before: worst ${worst.pos.toFixed(3)} m, ${worst.speed.toFixed(3)} m/s, ${worst.yaw.toFixed(4)} rad off (first off at ${at < 0 ? '-' : (at / 4).toFixed(2) + ' s'})`);
  }
  process.exit(failed ? 1 : 0);
})();
