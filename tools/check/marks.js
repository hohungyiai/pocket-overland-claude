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
          // (A strip's end is as wide as the mark: a run of one piece, two
          // triangles, would otherwise show its long sides as ends too.)
          if (al > (key === 'yellow' ? 0.3 : 0.8)) continue;
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
window.__checkEdgeBreaks = (all = false) => {
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
  return { samples: ends.length, bad: pl.length, worst: all ? pl : pl.slice(0, 40), unit: 'm' };
};

// Every metre of kerb has its edge line beside it, 0.2 to 0.6 m in from
// it, except where a mark rightly stops (a junction's mouth, a crossing, a
// gore) and beside roads with no lines.
window.__checkKerbLines = (all = false) => {
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
    // (A kerb lies outside the paving: a junction's corner is asked a little
    // over a metre in from it, square across the kerb, either side.)
    const L = [[t[0], t[1], t[2], t[3]], [t[2], t[3], t[4], t[5]], [t[4], t[5], t[0], t[1]]].reduce((m, e) => (Math.hypot(e[2] - e[0], e[3] - e[1]) > Math.hypot(m[2] - m[0], m[3] - m[1]) ? e : m));
    const ll = Math.hypot(L[2] - L[0], L[3] - L[1]) || 1;
    const sx = -(L[3] - L[1]) / ll, sz = (L[2] - L[0]) / ll;
    if (window.__markStopOk(x, z, y) || atCrossing(x, z) || [1.2, -1.2].some((o) => d.stopsAt(x + sx * o, z + sz * o, y).paving)) continue;
    n++;
    const g = near(x, z, y);
    if (g <= 0.75) continue;
    if (!lined(x, z)) continue;
    bad.push({ x: +x.toFixed(1), z: +z.toFixed(1), over: g === Infinity ? 1 : +g.toFixed(2) });
  }
  const pl = window.__finishIndex().places(bad.map((b) => ({ ...b, value: b.over })), 4);
  return { samples: n, bad: pl.length, worst: all ? pl : pl.slice(0, 40), unit: 'm' };
};

// Every marking, white or yellow, lies on top of the surface drawn under
// it: no point of any of its triangles (corners, the middles of its sides,
// its centre) lies under a road's, a deck's or a paving's drawn surface
// within half a metre of it (a ramp's tilted foot, a pad, a nose).
// (Redrawn maps only, as the checks above: today's map keeps its old lines.)
window.__checkMarkDepth = (all = false, TOL = 0.01) => {
  const d = globalThis.__osm;
  if (!d.oneLine) return { samples: 0, bad: 0, worst: [], unit: 'm' };
  const CELL = 2;
  const grid = new Map();
  const S = [];
  const marks = [];
  for (const k of d.farTiles()) {
    const A = d.tileAccs(k);
    for (const [key, a] of Object.entries(A)) {
      const mark = key === 'white' || key === 'yellow';
      if (!mark && key !== 'road' && key !== 'deck') continue;
      const P = a.pos, I = a.idx;
      for (let t = 0; t < I.length; t += 3) {
        const tri = [];
        for (let c = 0; c < 3; c++) tri.push(P[I[t + c] * 3], P[I[t + c] * 3 + 1], P[I[t + c] * 3 + 2]);
        if (mark) {
          tri.push(key);
          marks.push(tri);
          continue;
        }
        // (Not a sliver under 2 cm across, where a polygon's points run in a
        // line: nothing of it shows.)
        const cr = Math.abs((tri[3] - tri[0]) * (tri[8] - tri[2]) - (tri[5] - tri[2]) * (tri[6] - tri[0]));
        const long = Math.max(Math.hypot(tri[3] - tri[0], tri[5] - tri[2]), Math.hypot(tri[6] - tri[3], tri[8] - tri[5]), Math.hypot(tri[0] - tri[6], tri[2] - tri[8]));
        if (cr / (long || 1) < 0.02) continue;
        const q = S.length;
        tri.push(key);
        S.push(tri);
        const x0 = Math.floor(Math.min(tri[0], tri[3], tri[6]) / CELL), x1 = Math.floor(Math.max(tri[0], tri[3], tri[6]) / CELL);
        const z0 = Math.floor(Math.min(tri[2], tri[5], tri[8]) / CELL), z1 = Math.floor(Math.max(tri[2], tri[5], tri[8]) / CELL);
        if ((x1 - x0 + 1) * (z1 - z0 + 1) > 400) continue;
        for (let i = x0; i <= x1; i++)
          for (let j = z0; j <= z1; j++) {
            const c = i * 100003 + j;
            (grid.get(c) ?? grid.set(c, []).get(c)).push(q);
          }
      }
    }
  }
  /** The highest drawn surface at (x, z) within half a metre of y. */
  const topAt = (x, z, y) => {
    let best = -Infinity;
    for (const q of grid.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL)) ?? []) {
      const t = S[q];
      const d0 = (t[5] - t[8]) * (t[0] - t[6]) + (t[6] - t[3]) * (t[2] - t[8]);
      if (Math.abs(d0) < 1e-9) continue;
      const l1 = ((t[5] - t[8]) * (x - t[6]) + (t[6] - t[3]) * (z - t[8])) / d0;
      const l2 = ((t[8] - t[2]) * (x - t[6]) + (t[0] - t[6]) * (z - t[8])) / d0;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const h = l1 * t[1] + l2 * t[4] + l3 * t[7];
      if (Math.abs(h - y) < 0.5 && h > best) (best = h), (topAt.key = t[9]);
    }
    return best;
  };
  const bad = [];
  let n = 0;
  for (const t of marks) {
    const pts = [[t[0], t[1], t[2]], [t[3], t[4], t[5]], [t[6], t[7], t[8]]];
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) pts.push([(pts[a][0] + pts[b][0]) / 2, (pts[a][1] + pts[b][1]) / 2, (pts[a][2] + pts[b][2]) / 2]);
    pts.push([(t[0] + t[3] + t[6]) / 3, (t[1] + t[4] + t[7]) / 3, (t[2] + t[5] + t[8]) / 3]);
    let worst = -Infinity, wx = 0, wz = 0, wy = 0, on = '';
    for (const [x, y, z] of pts) {
      n++;
      const h = topAt(x, z, y);
      if (h - y > worst) (worst = h - y), (wx = x), (wz = z), (wy = y), (on = topAt.key);
    }
    // (More than TOL under the surface: a hair under it, or on it, still shows. The user's call, 2026-11-14.)
    if (worst > TOL) bad.push({ x: +wx.toFixed(1), z: +wz.toFixed(1), value: +(worst - TOL).toFixed(3), what: `${t[9]} at ${wy.toFixed(2)} on ${on}` });
  }
  const pl = window.__finishIndex().places(bad, 4);
  return { samples: n, bad: pl.length, worst: all ? pl : pl.slice(0, 40), unit: 'm' };
};

// Every island ends in a small rounded point: where the outline turns
// round an island's end (half a turn within 2.5 m, round the grass), no
// straight piece of it across the end is over 0.8 m (a square end), no
// corner of it turns more than 120 deg (a point sharper than 60 deg, a
// spike), and no wall stops within 1 m of its point (a ramp's wall stands
// on past the kerb as a fin). Nor does the outline cross itself anywhere
// (two kerbs across each other).
window.__checkNoses = (all = false) => {
  const d = globalThis.__osm;
  if (!d.oneLine) return { samples: 0, bad: 0, worst: [], unit: 'm' };
  const F = window.__finishIndex();
  const TILE = 200;
  const pts = [];
  const tips = [];
  let n = 0;
  const cross = (ax, az, bx, bz) => ax * bz - az * bx;
  for (const k of d.farTiles()) {
    const [ix, iz] = k.split(',').map(Number);
    const x0 = ix * TILE, z0 = iz * TILE;
    const own = (x, z) => x >= x0 && x < x0 + TILE && z >= z0 && z < z0 + TILE;
    const rings = d.outlineRingsNear(x0 + TILE / 2, z0 + TILE / 2, 1e9);
    // (Each ring's pieces in this tile, by level, for the crossings.)
    const segs = [];
    rings.forEach((g, r) => {
      // (Points within a centimetre of the last as one.)
      const R = g.corner.filter((p, i, all) => Math.hypot(p[0] - all[(i + all.length - 1) % all.length][0], p[1] - all[(i + all.length - 1) % all.length][1]) > 0.01);
      const N = R.length;
      if (N < 3) return;
      for (let i = 0; i < N; i++) {
        const a = R[i], b = R[(i + 1) % N];
        if (own((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) segs.push({ a, b, r, i, N, lvl: g.lvl });
      }
      if (N < 6) return;
      let A = 0;
      for (let i = 0; i < N; i++) A += cross(R[i][0], R[i][1], R[(i + 1) % N][0], R[(i + 1) % N][1]);
      // (Round the grass: an island's ring, or a wedge of grass into the paving.)
      const sg = (g.hole ? A > 0 : A < 0) ? 1 : -1;
      const turn = [], len = [];
      for (let i = 0; i < N; i++) {
        const a = R[(i + N - 1) % N], b = R[i], c = R[(i + 1) % N];
        const ux = b[0] - a[0], uz = b[1] - a[1], vx = c[0] - b[0], vz = c[1] - b[1];
        turn.push(Math.atan2(cross(ux, uz, vx, vz), ux * vx + uz * vz) * sg);
        len.push(Math.hypot(vx, vz));
      }
      // Half turns: from each corner, the fewest that turn 150 deg within 2.5 m.
      const cand = [];
      for (let i = 0; i < N; i++) {
        if (turn[i] <= 0) continue;
        let t = 0, arc = 0;
        for (let s = 0; s < N; s++) {
          const j = (i + s) % N;
          t += turn[j];
          if (t >= (150 * Math.PI) / 180) {
            cand.push({ i, s, arc });
            break;
          }
          arc += len[j];
          if (arc > 2.5 || t < -0.2) break;
        }
      }
      cand.sort((p, q) => p.arc - q.arc);
      const used = new Uint8Array(N);
      for (const c of cand) {
        let free = true;
        for (let s = 0; s <= c.s; s++) if (used[(c.i + s) % N]) free = false;
        if (!free) continue;
        for (let s = 0; s <= c.s; s++) used[(c.i + s) % N] = 1;
        // (Its point: the corner halfway round.)
        let t = 0, tip = c.i, sharp = 0, flat = 0;
        for (let s = 0; s <= c.s; s++) {
          const j = (c.i + s) % N;
          t += turn[j];
          if (t < (90 * Math.PI) / 180) tip = j;
          sharp = Math.max(sharp, turn[j]);
          if (s < c.s) flat = Math.max(flat, len[j]);
        }
        const [x, z] = R[tip];
        if (!own(x, z)) continue;
        // (Only where a kerb runs round it: an outline with nothing drawn on it shows nothing.)
        if (!d.outlineAt(x, z, 0.6).some((q) => q.kerb)) continue;
        n++;
        tips.push([x, z]);
        if (flat > 0.8) pts.push({ x: +x.toFixed(1), z: +z.toFixed(1), value: +flat.toFixed(2), what: 'square end' });
        const deg = (sharp * 180) / Math.PI;
        if (deg > 120) pts.push({ x: +x.toFixed(1), z: +z.toFixed(1), value: +((deg - 120) / 60).toFixed(2), what: `corner ${deg.toFixed(0)} deg` });
      }
    });
    // Crossings: two pieces of the outline of one level across each other.
    const grid = new Map();
    segs.forEach((s, q) => {
      for (const c of new Set([[s.a, s.b].map((p) => Math.floor(p[0] / 4) * 100003 + Math.floor(p[1] / 4))].flat())) (grid.get(c) ?? grid.set(c, []).get(c)).push(q);
    });
    const seen = new Set();
    for (const list of grid.values())
      for (let p = 0; p < list.length; p++)
        for (let q = p + 1; q < list.length; q++) {
          const s = segs[list[p]], t = segs[list[q]];
          if (s.lvl !== t.lvl) continue;
          if (s.r === t.r && (Math.abs(s.i - t.i) <= 1 || Math.abs(s.i - t.i) === s.N - 1)) continue;
          const key = list[p] + ',' + list[q];
          if (seen.has(key)) continue;
          seen.add(key);
          const d1 = cross(s.b[0] - s.a[0], s.b[1] - s.a[1], t.a[0] - s.a[0], t.a[1] - s.a[1]);
          const d2 = cross(s.b[0] - s.a[0], s.b[1] - s.a[1], t.b[0] - s.a[0], t.b[1] - s.a[1]);
          const d3 = cross(t.b[0] - t.a[0], t.b[1] - t.a[1], s.a[0] - t.a[0], s.a[1] - t.a[1]);
          const d4 = cross(t.b[0] - t.a[0], t.b[1] - t.a[1], s.b[0] - t.a[0], s.b[1] - t.a[1]);
          if (d1 * d2 < -1e-9 && d3 * d4 < -1e-9) {
            const u = d1 / (d1 - d2);
            const x = t.a[0] + (t.b[0] - t.a[0]) * u, z = t.a[1] + (t.b[1] - t.a[1]) * u;
            pts.push({ x: +x.toFixed(1), z: +z.toFixed(1), value: 1, what: 'kerbs cross' });
          }
        }
  }
  // Wall ends near a point: an upright sheet's end that no other sheet
  // carries on from (as the wall ends check finds them).
  const key = (x, z) => `${Math.round(x * 20)},${Math.round(z * 20)}`;
  const ends = new Map();
  const near = (x, z) => tips.some((t) => Math.hypot(t[0] - x, t[1] - z) < 1.5);
  for (const k of d.farTiles()) {
    const r = d.tileAccs(k).deck;
    if (!r) continue;
    const { pos, idx } = r;
    for (let q = 0; q < idx.length; q += 3) {
      const v = [idx[q] * 3, idx[q + 1] * 3, idx[q + 2] * 3];
      const det = (pos[v[1] + 2] - pos[v[2] + 2]) * (pos[v[0]] - pos[v[2]]) + (pos[v[2]] - pos[v[1]]) * (pos[v[0] + 2] - pos[v[2] + 2]);
      if (Math.abs(det) > 1e-4) continue;
      const ys = v.map((p) => pos[p + 1]);
      if (Math.max(...ys) - Math.min(...ys) < 0.02) continue;
      for (const p of v) {
        const x = pos[p], z = pos[p + 2];
        if (!near(x, z)) continue;
        const kk = key(x, z);
        const o = ends.get(kk) ?? { x, z, hi: -Infinity, n: 0 };
        o.n++;
        o.hi = Math.max(o.hi, pos[p + 1]);
        ends.set(kk, o);
      }
    }
  }
  const S = window.__sheetIndex();
  for (const o of ends.values()) {
    if (o.n > 2 || o.hi - d.heightAt(o.x, o.z) < 0.3) continue;
    const t = tips.find((q) => Math.hypot(q[0] - o.x, q[1] - o.z) < 1);
    if (!t) continue;
    let cont = false;
    for (const i of S.near(o.x - 0.7, o.z - 0.7, o.x + 0.7, o.z + 0.7)) {
      const s = F.sheets[i];
      const dx = s.x1 - s.x0, dz = s.z1 - s.z0, L2 = dx * dx + dz * dz || 1;
      const u = Math.max(0, Math.min(1, ((o.x - s.x0) * dx + (o.z - s.z0) * dz) / L2));
      const dd = Math.hypot(s.x0 + dx * u - o.x, s.z0 + dz * u - o.z);
      if ((dd > 0.02 && dd < 0.7 && s.hi > o.hi - 0.35) || (dd <= 0.02 && Math.min(Math.hypot(s.x0 - o.x, s.z0 - o.z), Math.hypot(s.x1 - o.x, s.z1 - o.z)) > 0.02 && s.hi > o.hi - 0.35)) {
        cont = true;
        break;
      }
    }
    if (!cont) pts.push({ x: +t[0].toFixed(1), z: +t[1].toFixed(1), value: +(o.hi - d.heightAt(o.x, o.z)).toFixed(2), what: 'wall end at the point' });
  }
  const bad = F.places(pts, 2);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: 'm' };
};

// A kerb runs wherever an edge line has grass beyond it: no stretch over
// 1 m where an edge line has ground beyond it (no road, no paving there)
// and no kerb between the two. (On the ground only: a raised road has
// its parapet.)
window.__checkKerbBeside = (all = false) => {
  const d = globalThis.__osm;
  if (!d.oneLine) return { samples: 0, bad: 0, worst: [], unit: 'm' };
  const F = window.__finishIndex();
  const CELL = 2;
  const grids = { kerb: new Map(), road: new Map() };
  const T = { kerb: [], road: [] };
  const lines = [];
  for (const k of d.farTiles()) {
    const A = d.tileAccs(k);
    for (const key of ['kerb', 'road', 'yellow']) {
      const a = A[key];
      if (!a) continue;
      const P = a.pos, I = a.idx;
      for (let t = 0; t < I.length; t += 3) {
        const v = [];
        for (let c = 0; c < 3; c++) v.push(P[I[t + c] * 3], P[I[t + c] * 3 + 1], P[I[t + c] * 3 + 2]);
        if (key === 'yellow') {
          lines.push(v);
          continue;
        }
        const q = T[key].length;
        T[key].push(v);
        const x0 = Math.floor(Math.min(v[0], v[3], v[6]) / CELL), x1 = Math.floor(Math.max(v[0], v[3], v[6]) / CELL);
        const z0 = Math.floor(Math.min(v[2], v[5], v[8]) / CELL), z1 = Math.floor(Math.max(v[2], v[5], v[8]) / CELL);
        if ((x1 - x0 + 1) * (z1 - z0 + 1) > 400) continue;
        for (let i = x0; i <= x1; i++)
          for (let j = z0; j <= z1; j++) {
            const c = i * 100003 + j;
            (grids[key].get(c) ?? grids[key].set(c, []).get(c)).push(q);
          }
      }
    }
  }
  /** Is (x, z) on a triangle of this kind, within dy of y? */
  const on = (key, x, z, y, dy) => {
    for (const q of grids[key].get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL)) ?? []) {
      const t = T[key][q];
      const d0 = (t[5] - t[8]) * (t[0] - t[6]) + (t[6] - t[3]) * (t[2] - t[8]);
      if (Math.abs(d0) < 1e-9) continue;
      const l1 = ((t[5] - t[8]) * (x - t[6]) + (t[6] - t[3]) * (z - t[8])) / d0;
      const l2 = ((t[8] - t[2]) * (x - t[6]) + (t[0] - t[6]) * (z - t[8])) / d0;
      if (l1 < -1e-6 || l2 < -1e-6 || 1 - l1 - l2 < -1e-6) continue;
      if (Math.abs(l1 * t[1] + l2 * t[4] + (1 - l1 - l2) * t[7] - y) < dy) return true;
    }
    return false;
  };
  const bad = [];
  const seen = new Set();
  let n = 0;
  for (const v of lines) {
    const x = (v[0] + v[3] + v[6]) / 3, y = (v[1] + v[4] + v[7]) / 3, z = (v[2] + v[5] + v[8]) / 3;
    const key = Math.round(x * 4) + ',' + Math.round(z * 4);
    if (seen.has(key)) continue;
    seen.add(key);
    // (Along its longest side; across, either way.)
    const E = [[0, 3], [3, 6], [6, 0]].map(([a, b]) => [v[b] - v[a], v[b + 2] - v[a + 2]]).reduce((m, e) => (Math.hypot(...e) > Math.hypot(...m) ? e : m));
    const el = Math.hypot(...E) || 1;
    const nx = -E[1] / el, nz = E[0] / el;
    // (On the ground: a raised road's edge has its parapet.)
    if (y - d.heightAt(x, z) > 1.5) continue;
    if (window.__markStopOk(x, z, y)) continue;
    n++;
    for (const s of [1, -1]) {
      const bx = x + nx * s * 1.1, bz = z + nz * s * 1.1;
      // (Ground beyond: no road or paving drawn there, the ground near the line's height.)
      if (on('road', bx, bz, y, 1) || Math.abs(d.heightAt(bx, bz) - y) > 1) continue;
      if ([0.3, 0.45, 0.6].some((o) => on('kerb', x + nx * s * o, z + nz * s * o, y, 0.5))) continue;
      bad.push({ x: +x.toFixed(1), z: +z.toFixed(1), value: 1 });
    }
  }
  // (A stretch over a metre: three or more of its points a quarter metre apart, or more.)
  const pl = F.places(bad, 1).filter((p) => (p.points ?? 1) >= 4);
  return { samples: n, bad: pl.length, worst: all ? pl : pl.slice(0, 40), unit: 'm' };
};
