// In-page check (run with ?debug, after seams.js): where two roads at one
// level split apart or come together at a small angle (a slip road leaving
// an expressway, a road dividing round a median), the road is whole between
// them until they are clear of each other (GORE m apart): no wedge of grass
// or hole showing between the two.
window.__checkGores = (all = false) => {
  const d = globalThis.__osm;
  const { drawnAt } = window.__roadIndex();
  const GORE = 1.5;
  const byNode = new Map();
  d.edges.forEach((e, i) => {
    if (d.JX.internal[i]) return;
    for (const j of e.a === e.b ? [e.a] : [e.a, e.b]) (byNode.get(j) ?? byNode.set(j, []).get(j)).push(i);
  });
  /** Point and unit direction s m out along road i from its end at node j. */
  const at = (i, j, s) => {
    const P = d.EP[i], cum = d.ECUM[i], L = d.ELEN[i];
    const ss = Math.max(0, Math.min(L, d.edges[i].a === j ? s : L - s));
    let k = 0;
    while (k < P.length - 2 && cum[k + 1] <= ss) k++;
    const sl = cum[k + 1] - cum[k] || 1;
    const u = (ss - cum[k]) / sl;
    const sg = d.edges[i].a === j ? 1 : -1;
    return { x: P[k][0] + (P[k + 1][0] - P[k][0]) * u, z: P[k][1] + (P[k + 1][1] - P[k][1]) * u, tx: (sg * (P[k + 1][0] - P[k][0])) / sl, tz: (sg * (P[k + 1][1] - P[k][1])) / sl, k, u };
  };
  const want = (i, x, z, k, u) => {
    const Y = d.hasProfile[i] ? d.deckY(i) : null;
    return Y ? Y[k] + (Y[k + 1] - Y[k]) * u : d.surfaceAt(x, z);
  };
  // (Up to the far junction, whose paving takes over.)
  const farTrim = (i, j) => (d.edges[i].a === j ? d.JX.trimB[i] || 0 : d.JX.trimA[i] || 0);
  const trimAt = (i, j) => (d.edges[i].a === j ? d.JX.trimA[i] || 0 : d.JX.trimB[i] || 0);
  const bad = [];
  const seen = new Set();
  let n = 0;
  let pairs = 0;
  for (const [j, l] of byNode) {
    if (l.length < 3) continue;
    for (let p = 0; p < l.length; p++)
      for (let q = p + 1; q < l.length; q++) {
        const A = l[p], B = l[q];
        if (d.ELEN[A] < 20 || d.ELEN[B] < 20) continue;
        const a0 = at(A, j, 0), a1 = at(A, j, 20), b1 = at(B, j, 20);
        const va = [a1.x - a0.x, a1.z - a0.z], vb = [b1.x - a0.x, b1.z - a0.z];
        const cos = (va[0] * vb[0] + va[1] * vb[1]) / (Math.hypot(...va) * Math.hypot(...vb) || 1);
        if (cos < Math.cos((35 * Math.PI) / 180)) continue;
        pairs++;
        for (let s = Math.max(trimAt(A, j), trimAt(B, j)) + 0.5; s < Math.min(d.ELEN[A] - farTrim(A, j), d.ELEN[B] - farTrim(B, j)); s += 1) {
          const pa = at(A, j, s), pb = at(B, j, s);
          // Each road's edge on the side facing the other.
          const side = (pt, o) => Math.sign(-pt.tz * (o.x - pt.x) + pt.tx * (o.z - pt.z)) || 1;
          const ha = d.halfAtE(A, pa.k), hb = d.halfAtE(B, pb.k);
          const sa = side(pa, pb), sb = side(pb, pa);
          const ea = [pa.x - pa.tz * sa * ha, pa.z + pa.tx * sa * ha];
          const eb = [pb.x - pb.tz * sb * hb, pb.z + pb.tx * sb * hb];
          const sep = Math.hypot(pa.x - pb.x, pa.z - pb.z) - ha - hb;
          if (sep >= GORE) break;
          if (sep < 0.2) continue;
          const ya = drawnAt(ea[0], ea[1], want(A, ea[0], ea[1], pa.k, pa.u));
          const yb = drawnAt(eb[0], eb[1], want(B, eb[0], eb[1], pb.k, pb.u));
          // (Two roads at different levels part as they climb: not a merge.)
          if (!(Math.abs(ya - yb) < 0.5)) break;
          n++;
          const mx = (ea[0] + eb[0]) / 2, mz = (ea[1] + eb[1]) / 2;
          const y = (ya + yb) / 2;
          if (Math.abs(drawnAt(mx, mz, y) - y) < 0.5) continue;
          const key = `${Math.round(mx / 3)},${Math.round(mz / 3)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          bad.push({ roads: `${d.edges[A].name || d.edges[A].cls} / ${d.edges[B].name || d.edges[B].cls}`, a: A, b: B, j, s, x: +mx.toFixed(1), z: +mz.toFixed(1), sep: +sep.toFixed(2), over: 1 });
        }
      }
  }
  return { samples: n, pairs, bad: bad.length, worst: all ? bad : bad.slice(0, 40) };
};
