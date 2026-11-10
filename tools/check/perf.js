// In-page checks (run with ?debug): the performance budget.
//
// The headless browser's own speed says little about a phone, so the survey
// mostly counts things that cost the same anywhere: how much a frame draws
// (draw calls, triangles) at spots all over the map. Two things are timed,
// against limits with plenty of room for a slow machine: the longest single
// slice of tile building (a slice can't be interrupted, so it is the hitch
// a player would feel on the road), and how long the game takes to start
// (run.cjs times that and leaves it in window.__startMs).
const PERF_BUDGET = {
  // Today's worst is about 950 calls and 1.5 million triangles (the sun's
  // shadow pass included): room for that and no more. Not yet a figure
  // proven on a phone: to be brought down, not up.
  calls: 1200,
  tris: 1900000,
  // Was 912 ms before the roads were drawn a few pieces to a slice; 20 to
  // 40 ms now, from run to run (it is a time, on a shared machine: the
  // limit leaves room for that, and still catches a slice gone wrong).
  sliceMs: 100,
  // Was 33 s before junction heights were settled in order; about 8 s now.
  startMs: 20000,
};

window.__perfSurvey = async ({ seed = 1, spots = 16, frames = 20 } = {}) => {
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
      // does on a drive (but all at once, from nothing): each slice is timed.
      g.car.placeAt({ x, y, z }, yaw);
      const pos = { x, y, z };
      let slices = 0, buildMs = 0, worst = 0, slowest = '', over16 = 0;
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
      out.push({
        road: d.edges[i].name || d.edges[i].cls, x: +x.toFixed(0), z: +z.toFixed(0),
        calls, tris,
        geometries: g.renderer.info.memory.geometries, textures: g.renderer.info.memory.textures,
        bodies: g.world.bodies.len(), colliders: g.world.colliders.len(),
        buildMs: Math.round(buildMs), slices, worstSliceMs: +worst.toFixed(1), slowest, over16,
      });
    }
  } finally {
    g.sim.fast = was;
  }
  // (What each kind of slice has cost: see sliceCost in osmcity.ts.)
  const cost = [...(d.sliceCost ?? [])].map(([what, c]) => ({ what, n: c.n, ms: Math.round(c.ms), maxMs: +c.max.toFixed(1), at: c.at })).sort((p, q) => q.maxMs - p.maxMs);
  return { spots: out, cost };
};

// (One survey serves all three checks.)
const perfOnce = () => (window.__perfDone ??= window.__perfSurvey());

window.__checkDrawn = async (all = false) => {
  const r = await perfOnce();
  const B = PERF_BUDGET;
  const bad = r.spots
    .filter((s) => s.calls > B.calls || s.tris > B.tris)
    .map((s) => ({ road: s.road, x: s.x, z: s.z, calls: s.calls, tris: s.tris, over: +Math.max(s.calls / B.calls, s.tris / B.tris).toFixed(2) }))
    .sort((p, q) => q.over - p.over);
  const most = (f) => Math.max(...r.spots.map(f));
  return { samples: r.spots.length, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: 'times the budget', note: `most ${most((s) => s.calls)} draw calls (budget ${B.calls}), ${(most((s) => s.tris) / 1e6).toFixed(2)} million triangles (budget ${B.tris / 1e6})` };
};

window.__checkSlices = async (all = false) => {
  const r = await perfOnce();
  const B = PERF_BUDGET;
  const bad = r.spots
    .filter((s) => s.worstSliceMs > B.sliceMs)
    .map((s) => ({ road: s.road, x: s.x, z: s.z, slice: s.slowest, over: s.worstSliceMs }))
    .sort((p, q) => q.over - p.over);
  const slices = r.spots.reduce((n, s) => n + s.slices, 0);
  const note = `longest ${Math.max(...r.spots.map((s) => s.worstSliceMs))} ms (limit ${B.sliceMs}), ${r.spots.reduce((n, s) => n + s.over16, 0)} of ${slices} slices over 16 ms, ${(r.spots.reduce((n, s) => n + s.buildMs, 0) / 1000).toFixed(1)} s of building; slowest kinds: ${r.cost.slice(0, 3).map((c) => `${c.what} ${c.maxMs} ms`).join(', ')}`;
  return { samples: slices, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: 'ms', note };
};

window.__checkStart = async () => {
  const ms = window.__startMs ?? 0;
  const bad = ms > PERF_BUDGET.startMs ? [{ what: 'slow to start', over: +(ms / 1000).toFixed(1) }] : [];
  return { samples: 1, bad: bad.length, worst: bad, unit: 's', note: `${(ms / 1000).toFixed(1)} s (limit ${PERF_BUDGET.startMs / 1000})` };
};
