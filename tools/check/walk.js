// In-page check (run with ?debug, after bot.js): the drive bot takes random
// trips all over the map, and must never get stuck or tip over.
//
// A trip starts on a random road and carries on from junction to junction,
// taking a random way out of each (never straight back), for `trip` metres;
// the bot drives it at a steady pace, slowing for bends. Where the car stops
// making headway (a lip, a step, a gap, a kerb across the road) or ends up
// on its side, that spot is reported and the next trip starts elsewhere.
// The trips are the same every run (the dice are seeded), so a spot that
// fails keeps failing until the road there is fixed.
window.__driveWalk = async ({ seed = 1, metres = 10000, trip = 1500, cruise = 11, minRank = 0, log = false } = {}) => {
  const d = globalThis.__osm;
  // (mulberry32)
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const jE = new Map();
  d.edges.forEach((e, i) => {
    for (const j of e.a === e.b ? [e.a] : [e.a, e.b]) (jE.get(j) ?? jE.set(j, []).get(j)).push(i);
  });
  const rank = (i) => d.rankOf(d.edges[i].cls);
  const inMap = (i) => d.EP[i].every((p) => Math.abs(p[0]) < 3500 && Math.abs(p[1]) < 3500);
  const starts = [];
  d.edges.forEach((e, i) => {
    if (!d.JX.internal[i] && d.ELEN[i] >= 40 && rank(i) >= Math.max(1, minRank) && inMap(i)) starts.push(i);
  });
  /** The direction road i leaves node j in. */
  const away = (i, j) => {
    const P = d.EP[i];
    const [p, q] = d.edges[i].a === j ? [P[0], P[Math.min(P.length - 1, 2)]] : [P[P.length - 1], P[Math.max(0, P.length - 3)]];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    return [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
  };
  const makeTrip = () => {
    let i = starts[Math.floor(rnd() * starts.length)];
    let fwd = rnd() < 0.5;
    const route = [];
    const used = new Set();
    let len = 0;
    while (len < trip) {
      used.add(i);
      const L = d.ELEN[i];
      // (A trip starts and ends a little clear of the road's ends.)
      route.push(fwd ? [i, route.length ? 0 : Math.min(8, L / 2), L] : [i, route.length ? L : L - Math.min(8, L / 2), 0]);
      len += L;
      const j = fwd ? d.edges[i].b : d.edges[i].a;
      const inDir = away(i, j);
      const next = (jE.get(j) ?? []).filter((o) => {
        if (o === i || used.has(o) || rank(o) < minRank || !inMap(o) || d.edges[o].a === d.edges[o].b) return false;
        // (Not straight back the way it came: no turn sharper than 120°.)
        const out = away(o, j);
        return inDir[0] * out[0] + inDir[1] * out[1] < 0.5;
      });
      if (!next.length) break;
      const o = next[Math.floor(rnd() * next.length)];
      fwd = d.edges[o].a === j;
      i = o;
    }
    return { route, len };
  };
  /** The road piece the car was on, `at` metres into a route. */
  const where = (route, at) => {
    let run = 0;
    for (const [i, s0, s1] of route) {
      run += Math.max(1, Math.round(Math.abs(s1 - s0)));
      if (at <= run) return i;
    }
    return route[route.length - 1][0];
  };
  const trips = [];
  let done = 0;
  let sim = 0;
  const t0 = performance.now();
  while (done < metres && trips.length < 200) {
    const { route, len } = makeTrip();
    if (len < 60) continue;
    const r = await window.__driveRoute(route, { cruise, timeout: 60 + len / 2 });
    done += r.at;
    sim += r.seconds ?? 0;
    const i = where(route, r.at);
    const t = { from: route[0][0], pieces: route.length, metres: r.at, of: r.total, done: !!r.done, maxLeanDeg: r.maxLeanDeg, offRoadM: r.offRoadM, offRoadAt: r.offRoadAt };
    if (!r.done) Object.assign(t, { what: r.tipped ? 'tipped over' : r.stalled ? 'page stopped' : 'stuck', at: r.tipped ?? r.stuck ?? null, edge: i, road: d.edges[i].name || d.edges[i].cls });
    if (log) t.log = r.log;
    trips.push(t);
  }
  return { trips, metres: done, carSeconds: Math.round(sim), wallSeconds: Math.round((performance.now() - t0) / 1000) };
};

window.__checkWalk = async (all = false) => {
  const r = await window.__driveWalk({ seed: 1, metres: 10000 });
  const bad = r.trips.filter((t) => !t.done).map((t) => ({ what: t.what, road: t.road, edge: t.edge, at: t.at, afterM: t.metres, over: 1 }));
  return { samples: r.trips.length, metres: r.metres, carSeconds: r.carSeconds, wallSeconds: r.wallSeconds, bad: bad.length, worst: all ? bad : bad.slice(0, 40) };
};
