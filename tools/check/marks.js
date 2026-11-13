// In-page checks (run with ?debug): kerbs and edge lines carry on as one
// line, as the road does. Read off the drawn meshes, so they hold however
// the lines are made. Redrawn maps only (today's map keeps its old lines
// until the redrawn map replaces it): there they find nothing to measure.

// The drawn runs of one kind of mark, joined across tiles: each with its
// two ends (a point, and the direction out of the run there).
window.__markRuns = (key) => {
  const d = globalThis.__osm;
  const tris = [];
  const ends = [];
  for (const k of d.farTiles()) {
    const a = d.tileAccs(k)[key];
    if (!a) continue;
    const P = a.pos, I = a.idx;
    const deg = new Map();
    for (let t = 0; t < I.length; t += 3) {
      tris.push([P[I[t] * 3], P[I[t] * 3 + 2], P[I[t + 1] * 3], P[I[t + 1] * 3 + 2], P[I[t + 2] * 3], P[I[t + 2] * 3 + 2], (P[I[t] * 3 + 1] + P[I[t + 1] * 3 + 1] + P[I[t + 2] * 3 + 1]) / 3]);
      for (let c = 0; c < 3; c++) deg.set(I[t + c], (deg.get(I[t + c]) ?? 0) + 1);
    }
    // A strip's end: its last cross-section, one corner in one triangle and
    // the other in two, both in a triangle together.
    for (let t = 0; t < I.length; t += 3) {
      const vs = [I[t], I[t + 1], I[t + 2]];
      for (const u of vs)
        for (const v of vs) {
          if (u >= v || deg.get(u) + deg.get(v) !== 3) continue;
          const w = vs.find((x) => x !== u && x !== v);
          const mx = (P[u * 3] + P[v * 3]) / 2, mz = (P[u * 3 + 2] + P[v * 3 + 2]) / 2;
          // Out of the run: away from the triangle's third corner, square to the end.
          let ax = P[v * 3] - P[u * 3], az = P[v * 3 + 2] - P[u * 3 + 2];
          const al = Math.hypot(ax, az) || 1;
          let ox = -az / al, oz = ax / al;
          if ((P[w * 3] - mx) * ox + (P[w * 3 + 2] - mz) * oz > 0) (ox = -ox), (oz = -oz);
          ends.push({ x: mx, z: mz, y: (P[u * 3 + 1] + P[v * 3 + 1]) / 2, ox, oz, w: al });
        }
    }
  }
  // (Where a run crosses from one tile into the next, both tiles end it at
  // the same cross-section, facing each other: that is no end.)
  const cell = (x, z) => Math.floor(x) * 100003 + Math.floor(z);
  const grid = new Map();
  ends.forEach((e, q) => {
    const c = cell(e.x, e.z);
    if (!grid.has(c)) grid.set(c, []);
    grid.get(c).push(q);
  });
  const gone = new Uint8Array(ends.length);
  ends.forEach((e, q) => {
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const r of grid.get(cell(e.x + dx, e.z + dz)) ?? []) {
          if (r === q) continue;
          const f = ends[r];
          if (Math.hypot(f.x - e.x, f.z - e.z) < 0.02 && e.ox * f.ox + e.oz * f.oz < -0.9) gone[q] = 1;
        }
  });
  return { tris, ends: ends.filter((_, q) => !gone[q]) };
};

// Is (x, z) within a zebra crossing's footprint, grown by `along` metres
// each way along the road and `across` past its ends?
let crossGrid = null;
window.__atCrossing = (x, z, along, across) => {
  const d = globalThis.__osm;
  const CR = typeof d.crossings === 'function' ? d.crossings() : d.crossings;
  if (!crossGrid) {
    crossGrid = new Map();
    CR.forEach((c, q) => {
      const k = Math.floor(c.c[0] / 16) * 100003 + Math.floor(c.c[1] / 16);
      if (!crossGrid.has(k)) crossGrid.set(k, []);
      crossGrid.get(k).push(q);
    });
  }
  for (let i = -1; i <= 1; i++)
    for (let j = -1; j <= 1; j++)
      for (const q of crossGrid.get((Math.floor(x / 16) + i) * 100003 + Math.floor(z / 16) + j) ?? []) {
        const c = CR[q];
        const vx = x - c.c[0], vz = z - c.c[1];
        if (Math.abs(vx * c.t[0] + vz * c.t[1]) < (d.CROSS_W ?? 3) / 2 + along && Math.abs(vx * c.t[1] - vz * c.t[0]) < c.half + across) return true;
      }
  return false;
};

// Is (x, z) where a mark may rightly stop: a junction's paving, a zebra,
// a gore's paving, an island, or under another road?
window.__markStopOk = (x, z, y) => {
  const d = globalThis.__osm;
  const w = d.stopsAt(x, z, y);
  return w.paving || w.island || w.gore || window.__atCrossing(x, z, 0.5, 1);
};

// An edge line never jumps sideways or breaks off and starts again: two of
// its ends facing each other within 4 m are one line broken (unless
// something it rightly stops for lies between them).
window.__checkEdgeBreaks = () => {
  const d = globalThis.__osm;
  if (!d.oneLine) return { samples: 0, bad: 0, worst: [] };
  const { ends } = window.__markRuns('yellow');
  const bad = [];
  const cell = (x, z) => Math.floor(x / 4) * 100003 + Math.floor(z / 4);
  const grid = new Map();
  ends.forEach((e, q) => {
    const c = cell(e.x, e.z);
    if (!grid.has(c)) grid.set(c, []);
    grid.get(c).push(q);
  });
  const seen = new Set();
  ends.forEach((e, q) => {
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const r of grid.get(cell(e.x + dx * 4, e.z + dz * 4)) ?? []) {
          if (r <= q) continue;
          const f = ends[r];
          // Facing each other: f lies ahead of e, out of its run, and e ahead of f.
          const vx = f.x - e.x, vz = f.z - e.z;
          const along = vx * e.ox + vz * e.oz;
          const back = -(vx * f.ox + vz * f.oz);
          if (along < -0.05 || back < -0.05 || along > 4 || e.ox * f.ox + e.oz * f.oz > -0.85) continue;
          const side = Math.abs(vx * e.oz - vz * e.ox);
          if (side > 1.5) continue;
          // (Something it rightly stops for between them: a crossing, a junction, a gore.)
          const mx = e.x + vx / 2, mz = e.z + vz / 2;
          if (window.__markStopOk(mx, mz, (e.y + f.y) / 2)) continue;
          const key = Math.round(mx * 2) + ',' + Math.round(mz * 2);
          if (seen.has(key)) continue;
          seen.add(key);
          if (side > 0.05 || along > 0.2)
            bad.push({ x: +mx.toFixed(1), z: +mz.toFixed(1), what: side > 0.05 ? 'jump' : 'gap', side: +side.toFixed(2), gap: +along.toFixed(2), over: +Math.max(side, along).toFixed(2) });
        }
  });
  const pl = window.__finishIndex().places(bad.map((b) => ({ ...b, value: b.over })), 4);
  return { samples: ends.length, bad: pl.length, worst: pl.slice(0, 40), unit: 'm' };
};

// Every metre of kerb has its edge line beside it, 0.2 to 0.6 m in from
// it, except where a mark rightly stops (a junction's mouth, a crossing, a
// gore) and beside roads with no lines.
window.__checkKerbLines = () => {
  const d = globalThis.__osm;
  if (!d.oneLine) return { samples: 0, bad: 0, worst: [] };
  const kerb = window.__markRuns('kerb').tris;
  const yellow = window.__markRuns('yellow').tris;
  const C = 2;
  const cell = (x, z) => Math.floor(x / C) * 100003 + Math.floor(z / C);
  const grid = new Map();
  yellow.forEach((t, q) => {
    const x0 = Math.min(t[0], t[2], t[4]), x1 = Math.max(t[0], t[2], t[4]);
    const z0 = Math.min(t[1], t[3], t[5]), z1 = Math.max(t[1], t[3], t[5]);
    for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++)
      for (let j = Math.floor(z0 / C); j <= Math.floor(z1 / C); j++) {
        const c = i * 100003 + j;
        if (!grid.has(c)) grid.set(c, []);
        grid.get(c).push(q);
      }
  });
  const segDist = (px, pz, ax, az, bx, bz) => {
    const vx = bx - ax, vz = bz - az;
    const u = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz || 1)));
    return Math.hypot(ax + vx * u - px, az + vz * u - pz);
  };
  const triDist = (px, pz, t) => Math.min(segDist(px, pz, t[0], t[1], t[2], t[3]), segDist(px, pz, t[2], t[3], t[4], t[5]), segDist(px, pz, t[4], t[5], t[0], t[1]));
  const near = (x, z, y) => {
    let best = Infinity;
    for (let i = Math.floor((x - 1) / C); i <= Math.floor((x + 1) / C); i++)
      for (let j = Math.floor((z - 1) / C); j <= Math.floor((z + 1) / C); j++)
        for (const q of grid.get(i * 100003 + j) ?? []) if (Math.abs(yellow[q][6] - y) < 1) best = Math.min(best, triDist(x, z, yellow[q]));
    return best;
  };
  // (Kerbs beside roads that carry no edge line are not asked: the
  // road under the kerb's inside edge has none of its own.)
  // (Edge lines are drawn on roads of rank 2 and up: asked of the roads
  // within a metre of the kerb.)
  const F = window.__finishIndex();
  const lined = (x, z) => {
    for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]) {
      const i = F.roadAt(x + ax, z + az);
      if (i >= 0 && d.rankOf(d.edges[i].cls) >= 2) return true;
    }
    return false;
  };
  // (Nor at a crossing: the edge line stops at the zebra, and the kerb
  // round a divider's nose there has none. Up to 2 m either side of it.)
  const atCrossing = (x, z) => window.__atCrossing(x, z, 2, 2.5);
  const bad = [];
  let n = 0;
  const seen = new Set();
  for (const t of kerb) {
    const x = (t[0] + t[2] + t[4]) / 3, z = (t[1] + t[3] + t[5]) / 3, y = t[6];
    const key = Math.round(x) + ',' + Math.round(z);
    if (seen.has(key)) continue;
    seen.add(key);
    // (A kerb lies outside the paving: a junction's corner is asked a metre in from it, all round.)
    if (window.__markStopOk(x, z, y) || atCrossing(x, z) || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ax, az]) => d.stopsAt(x + ax, z + az, y).paving)) continue;
    n++;
    const g = near(x, z, y);
    if (g <= 0.75) continue;
    if (!lined(x, z)) continue;
    bad.push({ x: +x.toFixed(1), z: +z.toFixed(1), over: g === Infinity ? 1 : +g.toFixed(2) });
  }
  const pl = window.__finishIndex().places(bad.map((b) => ({ ...b, value: b.over })), 4);
  return { samples: n, bad: pl.length, worst: pl.slice(0, 40), unit: 'm' };
};
