// In-page check (run with ?debug): no kerb or road line from one road lies
// across another road's lanes. Where roads merge, split or overlap, each
// road's own edge lines and kerbs must stop where the other road's surface
// begins. Drives down the middle of every lane of every road (well clear of
// its own lines) and looks for any kerb or line drawn there at its level.
// (Zebra crossings and their stop lines run across lanes on purpose.)
window.__checkLanes = (all = false) => {
  const d = globalThis.__osm;
  // Every kerb and line triangle, bucketed on a 4 m grid.
  const X0 = -3600, Z0 = -3600, C = 4, W = 1800;
  const tris = [];
  const kinds = [];
  for (const k of d.farTiles()) {
    const accs = d.tileAccs(k);
    for (const kind of ['kerb', 'white', 'yellow']) {
      const r = accs[kind];
      if (!r) continue;
      const { pos, idx } = r;
      for (let q = 0; q < idx.length; q += 3) {
        const a = idx[q] * 3, b = idx[q + 1] * 3, c = idx[q + 2] * 3;
        tris.push(pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2], pos[c], pos[c + 1], pos[c + 2]);
        kinds.push(kind);
      }
    }
  }
  const T = new Float32Array(tris);
  const grid = new Map();
  for (let t = 0; t < kinds.length; t++) {
    const o = t * 9;
    const x0 = Math.min(T[o], T[o + 3], T[o + 6]), x1 = Math.max(T[o], T[o + 3], T[o + 6]);
    const z0 = Math.min(T[o + 2], T[o + 5], T[o + 8]), z1 = Math.max(T[o + 2], T[o + 5], T[o + 8]);
    for (let j = Math.floor((z0 - Z0) / C); j <= Math.floor((z1 - Z0) / C); j++)
      for (let i = Math.floor((x0 - X0) / C); i <= Math.floor((x1 - X0) / C); i++) {
        const key = j * W + i;
        (grid.get(key) ?? grid.set(key, []).get(key)).push(t);
      }
  }
  /** The kind of kerb or line drawn at (x, z) within 1 m of height y, if any. */
  const lineAt = (x, z, y) => {
    for (const t of grid.get(Math.floor((z - Z0) / C) * W + Math.floor((x - X0) / C)) ?? []) {
      const o = t * 9;
      const ax = T[o], az = T[o + 2], bx = T[o + 3], bz = T[o + 5], cx = T[o + 6], cz = T[o + 8];
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(det) < 1e-9) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      const h = l1 * T[o + 1] + l2 * T[o + 4] + l3 * T[o + 7];
      if (Math.abs(h - y) < 1) return kinds[t];
    }
    return null;
  };
  const nearCrossing = (x, z) =>
    d.crossings.some((cr) => {
      const dx = x - cr.c[0], dz = z - cr.c[1];
      if (dx * dx + dz * dz > 900) return false;
      return Math.abs(dx * cr.t[0] + dz * cr.t[1]) < d.CROSS_W / 2 + 4 && Math.abs(-dx * cr.t[1] + dz * cr.t[0]) < cr.half + 1;
    });
  const bad = [];
  const seen = new Set();
  let n = 0;
  d.edges.forEach((e, i) => {
    if (d.JX.internal[i]) return;
    const P = d.EP[i];
    const cum = d.ECUM[i];
    const len = cum[cum.length - 1];
    const Y = d.hasProfile[i] ? d.deckY(i) : null;
    // Lane middles, as fractions across the road (-1 .. 1).
    const lanes = Math.max(1, Math.round((e.w - 0.7) / 3.3));
    const mids = e.one ? Array.from({ length: lanes }, (_, l) => -1 + (2 * l + 1) / lanes) : lanes > 1 ? [-0.5, 0.5] : [0];
    // (Only along the road itself: inside a junction, the junction checks.)
    const s0 = (d.JX.trimA[i] || 0) + 1, s1 = len - (d.JX.trimB[i] || 0) - 1;
    let k = 0;
    for (let s = s0; s <= s1; s += 1) {
      while (k < P.length - 2 && cum[k + 1] <= s) k++;
      const sl = cum[k + 1] - cum[k] || 1;
      const u = (s - cum[k]) / sl;
      const tx = (P[k + 1][0] - P[k][0]) / sl, tz = (P[k + 1][1] - P[k][1]) / sl;
      const half = d.halfAtE(i, k);
      for (const f of mids) {
        const x = P[k][0] + (P[k + 1][0] - P[k][0]) * u + tz * f * half;
        const z = P[k][1] + (P[k + 1][1] - P[k][1]) * u - tx * f * half;
        if (Math.abs(x) > 3590 || Math.abs(z) > 3590) continue;
        const y = (Y ? Y[k] + (Y[k + 1] - Y[k]) * u : d.surfaceAt(x, z)) + 0.1;
        n++;
        const kind = lineAt(x, z, y);
        if (!kind || nearCrossing(x, z)) continue;
        const key = `${Math.round(x / 4)},${Math.round(z / 4)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bad.push({ road: e.name || e.cls, i, kind, x: +x.toFixed(1), z: +z.toFixed(1), over: 1 });
      }
    }
  });
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40) };
};

// In-page check (after seams.js): every road is drawn out to its edges: no
// notch or bite out of its side where pieces of road meet or widths change.
// (The seam check looks across the middle of the road; this, its edges.)
window.__checkEdges = (all = false) => {
  const d = globalThis.__osm;
  const { drawnAt } = window.__roadIndex();
  const bad = [];
  const seen = new Set();
  let n = 0;
  d.edges.forEach((e, i) => {
    if (d.JX.internal[i]) return;
    const P = d.EP[i];
    const cum = d.ECUM[i];
    const len = cum[cum.length - 1];
    const Y = d.hasProfile[i] ? d.deckY(i) : null;
    let k = 0;
    // (Inside a junction's trims the junction's own paving takes over.)
    for (let s = (d.JX.trimA[i] || 0) + 0.5; s <= len - (d.JX.trimB[i] || 0) - 0.5; s += 0.5) {
      while (k < P.length - 2 && cum[k + 1] <= s) k++;
      const sl = cum[k + 1] - cum[k] || 1;
      const u = (s - cum[k]) / sl;
      const tx = (P[k + 1][0] - P[k][0]) / sl, tz = (P[k + 1][1] - P[k][1]) / sl;
      const half = Math.min(d.halfAtE(i, k), d.halfAtE(i, k + 1));
      for (const f of [-1, 1]) {
        // 30 cm in from the edge.
        const o = f * (half - 0.3);
        const x = P[k][0] + (P[k + 1][0] - P[k][0]) * u + tz * o;
        const z = P[k][1] + (P[k + 1][1] - P[k][1]) * u - tx * o;
        if (Math.abs(x) > 3590 || Math.abs(z) > 3590) continue;
        const y = Y ? Y[k] + (Y[k + 1] - Y[k]) * u : d.surfaceAt(x, z);
        n++;
        if (Math.abs(drawnAt(x, z, y) - y) < 1.5) continue;
        // A bite has road drawn either side of it, along the edge.
        const both = [-2, 2].every((ds) => Math.abs(drawnAt(x + tx * ds, z + tz * ds, y) - y) < 1.5);
        if (!both) continue;
        const key = `${Math.round(x / 3)},${Math.round(z / 3)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bad.push({ road: e.name || e.cls, i, s: +s.toFixed(1), x: +x.toFixed(1), z: +z.toFixed(1), over: 1 });
      }
    }
  });
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40) };
};

// In-page check: road widths change gently, no faster than 1 m of width per
// 20 m (WIDTH_RATE), along each road and from one piece of a road to the
// next (where OSM splits a road as a lane is added or dropped).
window.__checkWidths = (all = false) => {
  const d = globalThis.__osm;
  const bad = [];
  let n = 0;
  const halfEnd = (i, j) => (d.edges[i].a === j ? d.halfAtE(i, 0) : d.halfAtE(i, d.EP[i].length - 1));
  d.edges.forEach((e, i) => {
    if (d.JX.internal[i]) return;
    const P = d.EP[i];
    const cum = d.ECUM[i];
    for (let k = 0; k < P.length - 1; k++) {
      const sl = cum[k + 1] - cum[k];
      if (sl < 0.5) continue;
      n++;
      const rate = (2 * Math.abs(d.halfAtE(i, k + 1) - d.halfAtE(i, k))) / sl;
      // (A road too short for its taper changes faster: listed.)
      if (rate > d.WIDTH_RATE * 1.05) bad.push({ road: e.name || e.cls, i, s: +cum[k].toFixed(1), x: +P[k][0].toFixed(1), z: +P[k][1].toFixed(1), what: 'narrows or widens fast', value: +rate.toFixed(3) });
    }
    for (const j of [e.a, e.b]) {
      const o = d.throughOf(j, i);
      if (o === undefined || o < i || d.throughOf(j, o) !== i || d.JX.internal[o]) continue;
      n++;
      const jump = 2 * Math.abs(halfEnd(i, j) - halfEnd(o, j));
      if (jump > 0.1) bad.push({ road: e.name || e.cls, i, other: o, x: +(e.a === j ? P[0] : P[P.length - 1])[0].toFixed(1), z: +(e.a === j ? P[0] : P[P.length - 1])[1].toFixed(1), what: 'width jumps where pieces meet', value: +jump.toFixed(2) });
    }
  });
  bad.sort((a, b) => b.value - a.value);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40) };
};
