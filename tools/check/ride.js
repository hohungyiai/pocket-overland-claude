// In-page check (run with ?debug, after seams.js): the car rides on the road you see. Drops
// the car on a spread of ground roads and measures each wheel's bottom
// against the drawn road surface (wheels sinking in, or floating above).
window.__checkRide = async (count = 8) => {
  const d = globalThis.__osm;
  const g = window.game;
  const { drawnAt } = window.__roadIndex();
  const R = 0.42; // wheel radius (vehicle.ts)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Straight-ish stretches of main ground roads, spread over the map.
  const cand = [];
  d.edges.forEach((e, i) => {
    if (d.hasProfile[i] || d.JX.internal[i] || !e.name) return;
    const cum = d.ECUM[i];
    const len = cum[cum.length - 1];
    if (len < 80) return;
    cand.push(i);
  });
  const pick = [];
  for (let q = 0; q < count; q++) pick.push(cand[Math.floor(((q + 0.5) / count) * cand.length)]);
  const bad = [];
  let n = 0;
  // (The car runs ahead of the clock with nothing drawn: a drop settles in
  // a moment, however slowly this page draws.)
  const was = g.sim.fast;
  g.sim.fast = 400;
  for (const i of pick) {
    const P = d.EP[i];
    const k = Math.floor(P.length / 2);
    const [x, z] = P[k];
    const [x2, z2] = P[k + 1];
    // Set down on the road (from the 1.4 m the car is always placed at),
    // once the world round it is built: given 2.5 s of its own time to
    // land, then until it has settled on its springs (all four wheels
    // down, its height above the road no longer changing, three polls
    // running).
    // (Not until it stands still: off the pedals the car creeps down a
    // hill of 1 in 20 at half a metre a second, and at 400 steps a frame a
    // wait for it to stop rolled it 40 m off the end of a dead-end road,
    // where there is no road under the wheels to measure. So the clock
    // runs slowly while it settles, and a creeping car is measured where
    // it is: still on the road it was put on.)
    g.course.prepareAt?.(x, z);
    g.car.placeAt({ x, y: g.course.surfaceY(x, z, 999), z }, Math.atan2(-(z2 - z), x2 - x));
    for (let s0 = g.sim.steps, t = 0; g.sim.steps < s0 + 150 && t < 3000; t++) await wait(10);
    g.sim.fast = 10;
    const above = () => {
      const p = g.car.body.translation();
      return p.y - d.surfaceAt(p.x, p.z);
    };
    for (let t = 0, calm = 0, h0 = above(); t < 200 && calm < 3; t++) {
      await wait(50);
      const h = above();
      calm = g.car.wheelsOnGround === 4 && Math.abs(g.car.speed) < 1 && Math.abs(h - h0) < 0.005 ? calm + 1 : 0;
      h0 = h;
    }
    g.sim.fast = 400;
    const V = g.car.wheels[0].position.constructor;
    for (const w of g.car.wheels) {
      const v = w.getWorldPosition(new V());
      // (Against the road as drawn there: its pieces, not the ground under them.)
      const drawn = drawnAt(v.x, v.z, v.y - R);
      const off = v.y - R - (drawn === drawn ? drawn : d.surfaceAt(v.x, v.z) + 0.09);
      n++;
      if (Math.abs(off) > 0.05) bad.push({ road: d.edges[i].name, x: Math.round(v.x), z: Math.round(v.z), off: +off.toFixed(2), over: +Math.abs(off).toFixed(2) });
    }
  }
  g.sim.fast = was;
  bad.sort((a, b) => b.over - a.over);
  return { samples: n, bad: bad.length, worst: bad.slice(0, 12) };
};
