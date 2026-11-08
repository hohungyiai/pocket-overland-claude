// In-page check (run with ?debug): every road is drawn across its whole
// width, with no gap where the ground shows through (seams where two pieces
// of road meet, wedges where carriageways split). Builds every far tile's
// road buffers off-scene and tests points across each road against them.
window.__checkSeams = (all = false) => {
  const d = globalThis.__osm;
  const X0 = -3600, Z0 = -3600, C = 4, W = 1800;
  // Every road triangle (asphalt, junction surfaces), in XZ with its corner heights.
  // (Kerbs count too: a paved island's edge is kerb, not asphalt.)
  const tris = [];
  for (const k of d.farTiles()) {
    const accs = d.tileAccs(k);
    for (const r of [accs.road, accs.kerb]) {
      if (!r) continue;
      const { pos, idx } = r;
      for (let q = 0; q < idx.length; q += 3) {
        const a = idx[q] * 3, b = idx[q + 1] * 3, c = idx[q + 2] * 3;
        tris.push(pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2], pos[c], pos[c + 1], pos[c + 2]);
      }
    }
  }
  const T = new Float32Array(tris);
  const nt = T.length / 9;
  // Bucket them on a 4 m grid (count, then fill).
  const cellsOf = (t, f) => {
    const o = t * 9;
    const x0 = Math.min(T[o], T[o + 3], T[o + 6]), x1 = Math.max(T[o], T[o + 3], T[o + 6]);
    const z0 = Math.min(T[o + 2], T[o + 5], T[o + 8]), z1 = Math.max(T[o + 2], T[o + 5], T[o + 8]);
    const i0 = Math.max(0, Math.floor((x0 - X0) / C)), i1 = Math.min(W - 1, Math.floor((x1 - X0) / C));
    const j0 = Math.max(0, Math.floor((z0 - Z0) / C)), j1 = Math.min(W - 1, Math.floor((z1 - Z0) / C));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f(j * W + i);
  };
  const start = new Int32Array(W * W + 1);
  for (let t = 0; t < nt; t++) cellsOf(t, (c) => start[c + 1]++);
  for (let c = 0; c < W * W; c++) start[c + 1] += start[c];
  const fill = start.slice(0, W * W);
  const list = new Int32Array(start[W * W]);
  for (let t = 0; t < nt; t++) cellsOf(t, (c) => (list[fill[c]++] = t));
  /** Height of the road surface drawn at (x, z) nearest to y, or NaN if none. */
  const drawnAt = (x, z, y) => {
    const i = Math.floor((x - X0) / C), j = Math.floor((z - Z0) / C);
    if (i < 0 || j < 0 || i >= W || j >= W) return y;
    const c = j * W + i;
    let best = NaN;
    for (let q = start[c]; q < start[c + 1]; q++) {
      const o = list[q] * 9;
      const ax = T[o], az = T[o + 2], bx = T[o + 3], bz = T[o + 5], cx = T[o + 6], cz = T[o + 8];
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(det) < 1e-9) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
      const h = l1 * T[o + 1] + l2 * T[o + 4] + l3 * T[o + 7];
      if (!(Math.abs(h - y) >= Math.abs(best - y))) best = h;
    }
    return best;
  };
  const bad = [];
  const seen = new Set();
  let n = 0;
  d.edges.forEach((e, i) => {
    const P = d.EP[i];
    const cum = d.ECUM[i];
    const Y = d.hasProfile[i] ? d.deckY(i) : null;
    const len = cum[cum.length - 1];
    // Seams sit where pieces meet: at the road's ends and at its junction
    // mouths. Sample finely (5 cm) within a metre of those, 50 cm elsewhere.
    const joints = [0, len, d.JX.trimA[i] || 0, len - (d.JX.trimB[i] || 0)];
    const fine = (s) => joints.some((j) => Math.abs(s - j) < 1);
    for (let k = 0; k + 1 < P.length; k++) {
      const [ax, az] = P[k];
      const [bx, bz] = P[k + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.01) continue;
      const nx = (bz - az) / L, nz = -(bx - ax) / L;
      const half = Math.min(d.halfAtE(i, k), d.halfAtE(i, k + 1));
      for (let s = 0; s < L; s += fine(cum[k] + s) ? 0.05 : 0.5) {
        const a = s / L;
        // (Across the middle of the road: bites out of its very edge are
        // another matter.)
        for (const f of [-0.6, 0, 0.6]) {
          const x = ax + (bx - ax) * a + nx * f * half;
          const z = az + (bz - az) * a + nz * f * half;
          if (Math.abs(x) > 3590 || Math.abs(z) > 3590) continue;
          const y = Y ? Y[k] + (Y[k + 1] - Y[k]) * a : d.surfaceAt(x, z);
          n++;
          const h = drawnAt(x, z, y);
          // Drawn within 1.5 m of where the road should be: covered.
          if (Math.abs(h - y) < 1.5) continue;
          // A seam has road drawn on both sides of it, along the road; a
          // road merely drawn narrower than its OSM line suggests does not.
          const tx = (bx - ax) / L, tz = (bz - az) / L;
          const both = [-1.5, 1.5].every((ds) => Math.abs(drawnAt(x + tx * ds, z + tz * ds, y) - y) < 1.5);
          if (!both) continue;
          const key = `${Math.round(x / 3)},${Math.round(z / 3)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          bad.push({ road: e.name || e.cls, i, s: +(cum[k] + s).toFixed(1), x: +x.toFixed(1), z: +z.toFixed(1), y: +y.toFixed(2), drawn: +h.toFixed(2), over: 1 });
        }
      }
    }
  });
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40) };
};
