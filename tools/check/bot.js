// In-page drive bot (run with ?debug): takes the wheel and drives the car
// along a route of road pieces from a standstill, full throttle, steering
// for a point a few metres ahead. Reports where it got stuck, if it did.
//   route: [[edge, from s, to s], ...] (s along each edge; from > to drives it backwards)
window.__driveRoute = async (route, { low = false, timeout = 60, stopAt = 0 } = {}) => {
  const d = globalThis.__osm;
  const g = window.game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // The route as points every metre.
  const pts = [];
  for (const [i, s0, s1] of route) {
    const P = d.EP[i];
    const cum = d.ECUM[i];
    const n = Math.max(1, Math.round(Math.abs(s1 - s0)));
    for (let q = 0; q <= n; q++) {
      const s = s0 + ((s1 - s0) * q) / n;
      let k = 0;
      while (k < P.length - 2 && cum[k + 1] <= s) k++;
      const u = Math.max(0, Math.min(1, (s - cum[k]) / (cum[k + 1] - cum[k] || 1)));
      pts.push([P[k][0] + (P[k + 1][0] - P[k][0]) * u, P[k][1] + (P[k + 1][1] - P[k][1]) * u]);
    }
  }
  const total = pts.length - 1;
  const [x0, z0] = pts[0];
  const [x1, z1] = pts[Math.min(3, total)];
  const yaw = Math.atan2(-(z1 - z0), x1 - x0);
  // Hold it there until the world round it has loaded.
  for (let t = 0; t < 120; t++) {
    g.car.placeAt({ x: x0, y: g.course.surfaceY(x0, z0, 999), z: z0 }, yaw);
    await wait(250);
    if (t > 4 && g.course.streamStats().pending === 0) break;
  }
  g.car.placeAt({ x: x0, y: g.course.surfaceY(x0, z0, 999), z: z0 }, yaw);
  await wait(1500);
  g.car.lowRange = low;
  // Autopilot in place of the player's controls.
  let at = 0;
  const ctl = g.controls;
  const own = ctl.update;
  ctl.update = function () {
    const p = g.car.body.translation();
    let best = Infinity;
    for (let q = at; q < Math.min(total + 1, at + 30); q++) {
      const dd = (pts[q][0] - p.x) ** 2 + (pts[q][1] - p.z) ** 2;
      if (dd < best) {
        best = dd;
        at = q;
      }
    }
    const [tx, tz] = pts[Math.min(total, at + 6)];
    const f = g.car.forward;
    const dx = tx - p.x, dz = tz - p.z;
    const l = Math.hypot(dx, dz) || 1;
    const right = (-f.z * dx + f.x * dz) / l;
    this.input.steer = Math.max(-1, Math.min(1, right * 2.5));
    this.input.throttle = 1;
  };
  // Time is counted in physics steps (60 a second of the car's time), not
  // on the wall clock: a slow headless page runs the car slower.
  let steps = 0;
  const cap = g.car.capture;
  g.car.capture = function () {
    steps++;
    return cap.call(this);
  };
  const log = [];
  let best = 0;
  let bestAt = 0;
  let lean = 0;
  try {
    for (let next = 60; steps < timeout * 60; next += 60) {
      while (steps < next) await wait(20);
      const p = g.car.body.translation();
      const q = g.car.body.rotation();
      // How far over the car leans (0 upright).
      const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
      lean = Math.max(lean, Math.acos(Math.max(-1, Math.min(1, upY))) * (180 / Math.PI));
      log.push([+p.x.toFixed(1), +p.y.toFixed(2), +p.z.toFixed(1), at, +g.car.speed.toFixed(1), g.car.wheelsOnGround]);
      if (at > best + 0.5) {
        best = at;
        bestAt = steps;
      }
      const res = { at, total, seconds: +(steps / 60).toFixed(1), maxLeanDeg: +lean.toFixed(1), log };
      if (at >= total - 2 || (stopAt && at >= stopAt)) return { done: true, ...res };
      // No headway for 8 s of driving: stuck.
      if (steps - bestAt > 8 * 60) return { done: false, stuck: [+p.x.toFixed(1), +p.y.toFixed(2), +p.z.toFixed(1)], ...res };
    }
    return { done: false, timeout: true, at, total, maxLeanDeg: +lean.toFixed(1), log };
  } finally {
    ctl.update = own;
    g.car.capture = cap;
    ctl.input.steer = ctl.input.throttle = 0;
  }
};
