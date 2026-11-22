// Drive bot for the Pulau Ubin trail (loaded into the page by ubin.cjs).
// Follows a list of points [x, z] at a cruise speed, in fast physics mode
// (main.ts `game.sim`), with low range and the diff lock set as asked.
// It also plays the part of the HUD: it calls the course's coach a few
// times a second with the same "stuck" timer main.ts keeps, so the tries
// at an obstacle and the way round opening happen as they would in play.
window.__ubinDrive = async (pts, { low = false, diff = false, cruise = 8, timeout = 240, place = true, giveUp = 6, reverseAfterStall = 0, winch = false, change = null, look = 5 } = {}) => {
  // (change: { at, low, diff, cruise, look }: from point `at` on, that kit,
  // pace and how far ahead it steers for, in metres.)
  const g = window.game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const total = pts.length - 1;
  let steps = 0;
  const cap = g.car.capture;
  g.car.capture = function () {
    steps++;
    return cap.call(this);
  };
  const after = async (n) => {
    const until = steps + n;
    for (let t = 0; steps < until && t < 6000; t++) await wait(5);
  };
  const was = g.sim.fast;
  g.sim.fast = 400;
  const ctl = g.controls;
  const own = ctl.update;
  let at = 0;
  const says = [];
  const tips = [];
  let stuck = 0;
  let mode = 'drive';
  let backUntil = 0;
  try {
    if (place) {
      const [x0, z0] = pts[0];
      const [x1, z1] = pts[Math.min(4, total)];
      const yaw = Math.atan2(-(z1 - z0), x1 - x0);
      g.course.prepareAt?.(x0, z0);
      g.car.placeAt({ x: x0, y: g.course.heightAt(x0, z0) + 0.1, z: z0 }, yaw);
      ctl.input.steer = ctl.input.throttle = 0;
      await after(90);
    }
    g.car.lowRange = low;
    g.car.diffLock = diff;
    ctl.update = function () {
      const p = g.car.body.translation();
      let best = Infinity;
      for (let q = Math.max(0, at - 10); q < Math.min(total + 1, at + 30); q++) {
        const dd = (pts[q][0] - p.x) ** 2 + (pts[q][1] - p.z) ** 2;
        if (dd < best) {
          best = dd;
          at = q;
        }
      }
      const v = g.car.speed;
      const [tx, tz] = pts[Math.min(total, at + Math.max(look, Math.round(Math.abs(v) * 0.8)))];
      const f = g.car.forward;
      const dx = tx - p.x;
      const dz = tz - p.z;
      const l = Math.hypot(dx, dz) || 1;
      const right = (-f.z * dx + f.x * dz) / l;
      if (mode === 'back') {
        this.input.steer = -Math.max(-1, Math.min(1, right * 2));
        this.input.throttle = -0.8;
        return;
      }
      this.input.steer = Math.max(-1, Math.min(1, right * 2.5));
      const a = pts[Math.min(total, at)];
      const b = pts[Math.min(total, at + 12)];
      const c = pts[Math.min(total, at + 24)];
      let turn = Math.abs(Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]));
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      const want = Math.min(cruise, turn > 0.8 ? 3.5 : turn > 0.4 ? 5 : cruise);
      this.input.throttle = v < want - 0.5 ? 1 : v > want + 1.5 ? -0.6 : v > want + 0.3 ? 0 : 0.4;
    };
    const t0 = steps;
    let bestAt = 0;
    let bestStep = steps;
    let lean = 0;
    let stalls = 0;
    let winched = 0;
    let refused = 0;
    let refusedAt = 0;
    let changedAt = 0;
    const lifted = [0, 0, 0, 0, 0];
    for (let idle = 0, seen = steps; ; ) {
      await after(6); // ten times a second
      idle = steps === seen ? idle + 1 : 0;
      seen = steps;
      if (idle > 20) return { done: false, stalled: true, at, total, says, tips };
      const p = g.car.body.translation();
      const q = g.car.body.rotation();
      const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
      lifted[g.car.wheelsOnGround]++;
      lean = Math.max(lean, (Math.acos(Math.max(-1, Math.min(1, upY))) * 180) / Math.PI);
      // The HUD's stuck timer, and the coach.
      stuck = Math.abs(g.car.speed) < 0.4 && Math.abs(ctl.input.throttle) > 0.3 ? stuck + 0.1 : 0;
      const c = g.course.coach?.({ x: p.x, z: p.z, speed: g.car.speed, low: g.car.lowRange, diff: g.car.diffLock, stuck }) ?? null;
      if (c?.say) says.push([at, c.say]);
      if (c?.tip && tips[tips.length - 1]?.[1] !== c.tip) tips.push([at, c.tip]);
      if (mode === 'back' && steps > backUntil) {
        mode = 'drive';
        stuck = 0;
        bestStep = steps;
      }
      if (at > bestAt + 0.5) {
        bestAt = at;
        bestStep = steps;
      }
      const res = { at, total, seconds: +((steps - t0) / 60).toFixed(1), maxLeanDeg: +lean.toFixed(1), lifted, stalls, winched, refused, says, tips, pos: [+p.x.toFixed(1), +p.y.toFixed(2), +p.z.toFixed(1)] };
      if (change && !changedAt && at >= change.at) {
        if (change.low !== undefined) g.car.lowRange = change.low;
        if (change.diff !== undefined) g.car.diffLock = change.diff;
        if (change.cruise !== undefined) cruise = change.cruise;
        if (change.look !== undefined) look = change.look;
        changedAt = at;
      }
      res.changed = changedAt;
      if (at >= total - 2) return { done: true, ...res };
      // With the winch: stuck, it hooks up to the best tree and keeps
      // driving, as often as it likes.
      // (Through the button's path: the course is asked with the kit in,
      // and the pull scores.)
      if (winch && mode === 'drive' && stuck > 1 && !g.car.winch && winched < 40) {
        const tp = g.car.towPoint;
        const fw = g.car.mesh.position;
        const tree = g.course.winchAt?.(tp.x, tp.y, tp.z, tp.x - fw.x, tp.z - fw.z, g.car.winchStalledAt, { low: g.car.lowRange, diff: g.car.diffLock });
        if (tree) {
          g.car.winch = tree;
          g.course.penalty?.('winch', p.x, p.z);
          winched++;
          stuck = 0;
          bestStep = steps;
        } else if (!refusedAt || steps - refusedAt > 60) {
          refused++;
          refusedAt = steps;
        }
      }
      if (mode === 'drive' && steps - bestStep > giveUp * 60) {
        stalls++;
        if (stalls > reverseAfterStall) return { done: false, stuck: true, ...res };
        // Back up 4 s and try again (a fresh try at the obstacle).
        mode = 'back';
        backUntil = steps + 4 * 60;
      }
      if (lean > 70) return { done: false, tipped: true, ...res };
      if (steps - t0 > timeout * 60) return { done: false, timeout: true, ...res };
    }
  } finally {
    ctl.update = own;
    g.car.capture = cap;
    g.sim.fast = was;
    ctl.input.steer = ctl.input.throttle = 0;
  }
};

/** Points along the trail's route from s0 to s1 (metres), every metre. */
window.__ubinRoute = (s0, s1) => {
  const R = window.game.course.trail.route;
  const out = [];
  for (let s = Math.max(0, s0); s <= Math.min(R.length, s1); s += 1) {
    const p = R.at(s);
    out.push([p.x, p.z]);
  }
  return out;
};
/** The way round an obstacle, with a run-in from the trail before it and out after. */
window.__ubinRound = (i) => {
  const t = window.game.course.trail;
  const o = t.obstacles[i];
  const out = window.__ubinRoute(o.s0 - 70, o.s0 - 33);
  for (let s = 0; s <= o.bypass.length; s += 1) {
    const p = o.bypass.at(s);
    out.push([p.x, p.z]);
  }
  return out.concat(window.__ubinRoute(o.s1 + 33, o.s1 + 60));
};
window.__ubinObstacles = () =>
  window.game.course.trail.obstacles.map((o) => ({ kind: o.kind, s0: +o.s0.toFixed(1), s1: +o.s1.toFixed(1), tries: o.tries, open: o.open, done: o.done, side: o.side }));
/** Points along the route from s0 to s1, `off` metres to its left (negative: right). */
window.__ubinRouteOff = (s0, s1, off) => {
  const t = window.game.course.trail;
  const R = t.route;
  const out = [];
  for (let s = Math.max(0, s0); s <= Math.min(R.length, s1); s += 1) {
    const p = R.at(s);
    // (Weaving through rock spurs where there are some.)
    const o = t.lineAt ? t.lineAt(s, off) : off;
    // Left of travel, with x east and z south: (tz, -tx).
    out.push([p.x + p.tz * o, p.z - p.tx * o]);
  }
  return out;
};

/**
 * The bot along the route from s0 to s1 with a kit from ubin.cjs: `off`
 * metres left of it (and `runUp` metres more before s0), and a change of
 * kit at route distance `change.s` (a clashing setup), if any.
 */
window.__ubinKitDrive = (s0, s1, kit) => {
  const from = s0 - (kit.runUp ?? 0);
  const pts = window.__ubinRouteOff(from, s1, kit.off ?? 0);
  const opt = { ...kit };
  if (kit.change) opt.change = { ...kit.change, at: Math.max(1, Math.round(kit.change.s - Math.max(0, from))) };
  return window.__ubinDrive(pts, opt);
};
