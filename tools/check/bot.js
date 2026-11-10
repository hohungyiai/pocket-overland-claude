// In-page drive bot (run with ?debug): takes the wheel and drives the car
// along a route of road pieces, steering for a point a few metres ahead.
// Reports where it got stuck, if it did.
//   route: [[edge, from s, to s], ...] (s along each edge; from > to drives it backwards)
//   cruise: 0 = full throttle from a standstill (the hard-spot tests);
//           else a speed in m/s to hold on the straight, slowing for bends.
// The car runs ahead of the clock with nothing drawn (game.sim.fast), so a
// drive takes seconds here: time is counted in physics steps, 60 a second
// of the car's time.
window.__driveRoute = async (route, { low = false, timeout = 60, stopAt = 0, cruise = 0, place = true } = {}) => {
  const d = globalThis.__osm;
  const g = window.game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // The route as points every metre, and the half width of the road at each.
  const pts = [];
  const half = [];
  for (const [i, s0, s1] of route) {
    const P = d.EP[i];
    const cum = d.ECUM[i];
    const n = Math.max(1, Math.round(Math.abs(s1 - s0)));
    for (let q = pts.length ? 1 : 0; q <= n; q++) {
      const s = s0 + ((s1 - s0) * q) / n;
      let k = 0;
      while (k < P.length - 2 && cum[k + 1] <= s) k++;
      const u = Math.max(0, Math.min(1, (s - cum[k]) / (cum[k + 1] - cum[k] || 1)));
      pts.push([P[k][0] + (P[k + 1][0] - P[k][0]) * u, P[k][1] + (P[k + 1][1] - P[k][1]) * u]);
      half.push(d.halfAtE(i, k));
    }
  }
  const total = pts.length - 1;
  // Time is counted in physics steps, not on the wall clock.
  let steps = 0;
  const cap = g.car.capture;
  g.car.capture = function () {
    steps++;
    return cap.call(this);
  };
  const after = async (n) => {
    const until = steps + n;
    // (Gives up if the page stops stepping: never an endless wait.)
    for (let t = 0; steps < until && t < 6000; t++) await wait(5);
  };
  const was = g.sim.fast;
  g.sim.fast = 400;
  const ctl = g.controls;
  const own = ctl.update;
  let at = 0;
  try {
    if (place) {
      const [x0, z0] = pts[0];
      const [x1, z1] = pts[Math.min(3, total)];
      const yaw = Math.atan2(-(z1 - z0), x1 - x0);
      // The world round it is built before the car is let go.
      g.course.prepareAt?.(x0, z0);
      g.car.placeAt({ x: x0, y: g.course.surfaceY(x0, z0, 999), z: z0 }, yaw);
      ctl.input.steer = ctl.input.throttle = 0;
      await after(90);
    }
    g.car.lowRange = low;
    // Autopilot in place of the player's controls.
    const turnAhead = (from, span) => {
      const a = pts[Math.min(total, from)], b = pts[Math.min(total, from + 3)];
      const c = pts[Math.min(total, from + span)], e = pts[Math.min(total, from + span + 3)];
      const h0 = Math.atan2(b[1] - a[1], b[0] - a[0]), h1 = Math.atan2(e[1] - c[1], e[0] - c[0]);
      let t = Math.abs(h1 - h0);
      if (t > Math.PI) t = 2 * Math.PI - t;
      return (t * 180) / Math.PI;
    };
    let off = 0;
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
      off = Math.sqrt(best);
      const v = g.car.speed;
      const [tx, tz] = pts[Math.min(total, at + Math.max(6, Math.round(v * 0.7)))];
      const f = g.car.forward;
      const dx = tx - p.x, dz = tz - p.z;
      const l = Math.hypot(dx, dz) || 1;
      const right = (-f.z * dx + f.x * dz) / l;
      this.input.steer = Math.max(-1, Math.min(1, right * 2.5));
      if (!cruise) {
        this.input.throttle = 1;
        return;
      }
      // Slower for the bend ahead (looked for further off the faster it goes).
      const turn = Math.max(turnAhead(at, 12), turnAhead(at + 10, 14), v > 6 ? turnAhead(at + 20, 14) : 0);
      const want = turn > 60 ? 3 : turn > 30 ? 4.5 : turn > 12 ? Math.min(cruise, 7) : cruise;
      this.input.throttle = v < want - 0.5 ? 1 : v > want + 1.5 ? -0.6 : v > want + 0.3 ? 0 : 0.35;
    };
    const log = [];
    let best = 0;
    let bestAt = steps;
    let lean = 0;
    let far = 0;
    let farAt = null;
    const t0 = steps;
    for (let idle = 0, seen = steps; ; ) {
      await after(30);
      // (A page that has stopped stepping altogether: give up, say so.)
      idle = steps === seen ? idle + 1 : 0;
      seen = steps;
      if (idle > 4) return { done: false, stalled: true, at, total, log };
      const p = g.car.body.translation();
      const q = g.car.body.rotation();
      // How far over the car leans (0 upright).
      const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
      lean = Math.max(lean, Math.acos(Math.max(-1, Math.min(1, upY))) * (180 / Math.PI));
      // How far off the road's edge it wandered.
      const out = off - half[at];
      if (out > far) {
        far = out;
        farAt = [+p.x.toFixed(1), +p.z.toFixed(1)];
      }
      if (log.length < 400) log.push([+p.x.toFixed(1), +p.y.toFixed(2), +p.z.toFixed(1), at, +g.car.speed.toFixed(1), g.car.wheelsOnGround]);
      if (at > best + 0.5) {
        best = at;
        bestAt = steps;
      }
      const res = { at, total, seconds: +((steps - t0) / 60).toFixed(1), maxLeanDeg: +lean.toFixed(1), offRoadM: +Math.max(0, far).toFixed(1), offRoadAt: farAt, log };
      if (at >= total - 2 || (stopAt && at >= stopAt)) return { done: true, ...res };
      const here = [+p.x.toFixed(1), +p.y.toFixed(2), +p.z.toFixed(1)];
      // No headway for 8 s of driving: stuck. On its side or roof: tipped.
      if (steps - bestAt > 8 * 60) return { done: false, stuck: here, ...res };
      if (lean > 70) return { done: false, tipped: here, ...res };
      if (steps - t0 > timeout * 60) return { done: false, timeout: true, stuck: here, ...res };
    }
  } finally {
    ctl.update = own;
    g.car.capture = cap;
    g.sim.fast = was;
    ctl.input.steer = ctl.input.throttle = 0;
  }
};
