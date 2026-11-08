// In-page check (run with ?debug): the car rides on the road you see. Drops
// the car on a spread of ground roads and measures each wheel's bottom
// against the drawn road surface (wheels sinking in, or floating above).
window.__checkRide = async (count = 8) => {
  const d = globalThis.__osm;
  const g = window.game;
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
  for (const i of pick) {
    const P = d.EP[i];
    const k = Math.floor(P.length / 2);
    const [x, z] = P[k];
    const [x2, z2] = P[k + 1];
    // Dropped from 2.5 m up: wait for it to fall, then to settle (all four
    // wheels down and still, three polls running).
    const y0 = d.surfaceAt(x, z) + 2.5;
    // Held there until the tiles round it have all loaded (as they would
    // have, long before, for a car driven there).
    for (let t = 0; t < 120; t++) {
      g.car.placeAt({ x, y: y0, z }, Math.atan2(x2 - x, z2 - z));
      await wait(250);
      if (t > 4 && g.course.streamStats().pending === 0) break;
    }
    g.car.placeAt({ x, y: y0, z }, Math.atan2(x2 - x, z2 - z));
    let fell = false;
    for (let t = 0, calm = 0; t < 80 && calm < 3; t++) {
      await wait(500);
      fell ||= g.car.mesh.position.y < y0 - 0.5;
      calm = fell && g.car.wheelsOnGround === 4 && Math.abs(g.car.speed) < 0.1 ? calm + 1 : 0;
    }
    const V = g.car.wheels[0].position.constructor;
    for (const w of g.car.wheels) {
      const v = w.getWorldPosition(new V());
      const off = v.y - R - (d.surfaceAt(v.x, v.z) + 0.09);
      n++;
      if (Math.abs(off) > 0.05) bad.push({ road: d.edges[i].name, x: Math.round(v.x), z: Math.round(v.z), off: +off.toFixed(2), over: +Math.abs(off).toFixed(2) });
    }
  }
  bad.sort((a, b) => b.over - a.over);
  return { samples: n, bad: bad.length, worst: bad.slice(0, 12) };
};
