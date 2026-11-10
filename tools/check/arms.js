// In-page check (run with ?debug): no spider junctions. A junction should
// offer the driver at most four ways to go. Five or more is hard to read
// from the driver's seat (which arm carries on, which turns off?) and is
// usually a quirk of the map data: two junctions drawn as one, or a service
// road joined at the very corner. Roads leaving side by side (the two
// carriageways of a divided road, within 25 degrees of each other) count
// as one way to go.
window.__checkArms = (all = false) => {
  const d = globalThis.__osm;
  const at = new Map();
  /** Heading out of the node along road i, 12 m out (or its far end). */
  const heading = (i, fromA) => {
    const P = d.EP[i], cum = d.ECUM[i], L = d.ELEN[i];
    const s = fromA ? Math.min(12, L) : Math.max(L - 12, 0);
    let k = 0;
    while (k < P.length - 2 && cum[k + 1] < s) k++;
    const o = fromA ? P[0] : P[P.length - 1];
    const q = P[fromA ? Math.min(P.length - 1, k + 1) : k];
    return Math.atan2(q[1] - o[1], q[0] - o[0]);
  };
  d.edges.forEach((e, i) => {
    const P = d.EP[i];
    for (const fromA of [true, false]) {
      const j = fromA ? e.a : e.b;
      const n = at.get(j) ?? at.set(j, { p: fromA ? P[0] : P[P.length - 1], l: [], h: [] }).get(j);
      n.l.push(i);
      n.h.push(heading(i, fromA));
    }
  });
  const bad = [];
  const LIM = (25 * Math.PI) / 180;
  for (const [j, { p, l, h }] of at) {
    if (l.length < 5) continue;
    // Ways to go: headings in order round the node, split at gaps over 25 degrees.
    const a = h.slice().sort((x, y) => x - y);
    let ways = 0;
    for (let k = 0; k < a.length; k++) {
      const gap = k ? a[k] - a[k - 1] : a[0] + 2 * Math.PI - a[a.length - 1];
      if (gap > LIM) ways++;
    }
    ways = Math.max(1, ways);
    if (ways < 5) continue;
    bad.push({ j, ways, arms: l.length, roads: [...new Set(l.map((i) => d.edges[i].name || d.edges[i].cls))].join(' / '), x: Math.round(p[0]), z: Math.round(p[1]), over: ways - 4 });
  }
  bad.sort((a, b) => b.ways - a.ways);
  return { samples: at.size, bad: bad.length, worst: all ? bad : bad.slice(0, 40) };
};
