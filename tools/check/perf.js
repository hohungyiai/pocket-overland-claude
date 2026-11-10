// In-page survey (run with ?debug): what the game costs at spots all over
// the map. The headless browser's own speed says little about a phone, so
// this counts the things that cost the same anywhere: how much is drawn in
// a frame (draw calls, triangles), how much is held (geometries, textures,
// solid bodies), and the longest single slice of tile building (a slice
// can't be interrupted, so it is the hitch a player would feel).
window.__perfSurvey = async ({ seed = 1, spots = 30, frames = 12 } = {}) => {
  const d = globalThis.__osm;
  const g = window.game;
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const starts = [];
  d.edges.forEach((e, i) => {
    if (!d.JX.internal[i] && d.ELEN[i] >= 40 && d.rankOf(e.cls) >= 1 && d.EP[i].every((p) => Math.abs(p[0]) < 3400 && Math.abs(p[1]) < 3400)) starts.push(i);
  });
  const stats = g.course.streamStats();
  const out = [];
  const was = g.sim.fast;
  g.sim.fast = 0;
  try {
    for (let n = 0; n < spots; n++) {
      const i = starts[Math.floor(rnd() * starts.length)];
      const P = d.EP[i];
      const k = Math.floor(P.length / 2);
      const [x, z] = P[k];
      const q = P[Math.min(P.length - 1, k + 1)], p0 = P[Math.max(0, k - 1)];
      const yaw = Math.atan2(-(q[1] - p0[1]), q[0] - p0[0]);
      const y = (d.hasProfile[i] ? d.deckY(i)[k] : d.surfaceAt(x, z)) + 0.09;
      // The world streams in round the new spot a slice at a time, as it
      // does on a drive: each slice is timed.
      g.car.placeAt({ x, y, z }, yaw);
      g.car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      const pos = { x, y, z };
      const before = { near: stats.near, far: stats.far, horizon: stats.horizon };
      let slices = 0, buildMs = 0, worst = 0, over8 = 0, over16 = 0, slowest = '';
      const slow = [];
      const t0 = performance.now();
      for (let c = 0; c < 200000; c++) {
        stats.maxStepMs = 0;
        const s0 = performance.now();
        g.course.update(s0 / 1000, 0, undefined, pos);
        buildMs += performance.now() - s0;
        if (stats.maxStepMs > 0) {
          slices++;
          if (stats.maxStepMs > worst) {
            worst = stats.maxStepMs;
            slowest = stats.slowest;
          }
          if (stats.maxStepMs > 16) slow.push([stats.slowest, +stats.maxStepMs.toFixed(0)]);
          if (stats.maxStepMs > 8) over8++;
          if (stats.maxStepMs > 16) over16++;
        }
        if (!stats.pending) break;
        if (c % 200 === 199) await new Promise((r) => setTimeout(r, 0));
      }
      // Then what a frame there draws (the car at rest, the camera behind it).
      g.car.placeAt({ x, y, z }, yaw);
      let calls = 0, tris = 0;
      for (let f = 0; f < frames; f++) {
        await raf();
        calls = Math.max(calls, g.renderer.info.render.calls);
        tris = Math.max(tris, g.renderer.info.render.triangles);
      }
      let objects = 0;
      g.scene.traverse(() => objects++);
      out.push({
        road: d.edges[i].name || d.edges[i].cls, x: +x.toFixed(0), z: +z.toFixed(0),
        calls, tris, objects,
        geometries: g.renderer.info.memory.geometries, textures: g.renderer.info.memory.textures,
        bodies: g.world.bodies.len(), colliders: g.world.colliders.len(),
        heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0,
        tiles: { near: stats.near, far: stats.far, horizon: stats.horizon },
        built: stats.near - before.near + stats.far - before.far + stats.horizon - before.horizon,
        buildMs: Math.round(buildMs), slices, worstSliceMs: +worst.toFixed(1), slowest, over8, over16, slow,
        wallMs: Math.round(performance.now() - t0),
      });
    }
  } finally {
    g.sim.fast = was;
  }
  return out;
};
