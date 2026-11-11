// In-page checks (run with ?debug) that look at the FINISHED road, not at the
// builder's plan for it: every triangle of asphalt, kerb, paint and deck
// that is drawn, whatever rule drew it. The other checks ask the builder what
// it meant to draw at chosen points (the joint, the lane middle, the plan's
// width); these follow what is there, along the whole of every road, so a
// fault no rule knows about still shows.

// Everything drawn for the roads, bucketed on a 4 m grid (any map size).
//   flatAt(x, z)        every flat piece over (x, z): [{ kind, h }, ...]
//   asphaltAt(x, z, y)  height of the asphalt nearest y there, NaN if none within tol
//   sheets              every upright sheet of deck (parapet, wall, beam) as a
//                       ground segment with its bottom and top heights
window.__finishIndex = () => {
  if (window.__finIdx) return window.__finIdx;
  const d = globalThis.__osm;
  const C = 4;
  const KINDS = ['road', 'kerb', 'white', 'yellow'];
  const tris = [];
  const kinds = [];
  const sheets = [];
  for (const k of d.farTiles()) {
    const accs = d.tileAccs(k);
    KINDS.forEach((kind, ki) => {
      const r = accs[kind];
      if (!r) return;
      const { pos, idx } = r;
      for (let q = 0; q < idx.length; q += 3) {
        const a = idx[q] * 3, b = idx[q + 1] * 3, c = idx[q + 2] * 3;
        const det = (pos[b + 2] - pos[c + 2]) * (pos[a] - pos[c]) + (pos[c] - pos[b]) * (pos[a + 2] - pos[c + 2]);
        if (Math.abs(det) < 1e-6) continue;
        tris.push(pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2], pos[c], pos[c + 1], pos[c + 2]);
        kinds.push(ki);
      }
    });
    const r = accs.deck;
    if (r) {
      const { pos, idx } = r;
      for (let q = 0; q < idx.length; q += 3) {
        const v = [idx[q] * 3, idx[q + 1] * 3, idx[q + 2] * 3];
        const det = (pos[v[1] + 2] - pos[v[2] + 2]) * (pos[v[0]] - pos[v[2]]) + (pos[v[2]] - pos[v[1]]) * (pos[v[0] + 2] - pos[v[2] + 2]);
        if (Math.abs(det) > 1e-4) continue;
        // (Seen from above an upright triangle is a line: its longest side.)
        let best = 0, s = null;
        for (let e = 0; e < 3; e++) {
          const p = v[e], n = v[(e + 1) % 3];
          const l = Math.hypot(pos[n] - pos[p], pos[n + 2] - pos[p + 2]);
          if (l > best) (best = l), (s = [pos[p], pos[p + 2], pos[n], pos[n + 2]]);
        }
        if (best < 0.3) continue;
        const ys = v.map((p) => pos[p + 1]);
        sheets.push({ x0: s[0], z0: s[1], x1: s[2], z1: s[3], lo: Math.min(...ys), hi: Math.max(...ys) });
      }
    }
  }
  const T = new Float32Array(tris);
  const K = new Uint8Array(kinds);
  const grid = new Map();
  for (let t = 0; t < K.length; t++) {
    const o = t * 9;
    const x0 = Math.min(T[o], T[o + 3], T[o + 6]), x1 = Math.max(T[o], T[o + 3], T[o + 6]);
    const z0 = Math.min(T[o + 2], T[o + 5], T[o + 8]), z1 = Math.max(T[o + 2], T[o + 5], T[o + 8]);
    for (let j = Math.floor(z0 / C); j <= Math.floor(z1 / C); j++)
      for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++) {
        const key = j * 100003 + i;
        const l = grid.get(key);
        if (l) l.push(t);
        else grid.set(key, [t]);
      }
  }
  const each = (x, z, f) => {
    const l = grid.get(Math.floor(z / C) * 100003 + Math.floor(x / C));
    if (!l) return;
    for (const t of l) {
      const o = t * 9;
      const ax = T[o], az = T[o + 2], bx = T[o + 3], bz = T[o + 5], cx = T[o + 6], cz = T[o + 8];
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
      f(K[t], l1 * T[o + 1] + l2 * T[o + 4] + l3 * T[o + 7]);
    }
  };
  const flatAt = (x, z) => {
    const out = [];
    each(x, z, (kind, h) => out.push({ kind: KINDS[kind], h }));
    return out;
  };
  const asphaltAt = (x, z, y, tol = 0.6) => {
    let best = NaN;
    each(x, z, (kind, h) => {
      if (kind === 0 && Math.abs(h - y) <= tol && !(Math.abs(h - y) >= Math.abs(best - y))) best = h;
    });
    return best;
  };
  /** The lowest and highest asphalt over (x, z) within tol of y: [lo, hi], or null. */
  const asphaltSpan = (x, z, y, tol = 0.6) => {
    let lo = Infinity, hi = -Infinity;
    each(x, z, (kind, h) => {
      if (kind !== 0 || Math.abs(h - y) > tol) return;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    });
    return hi < lo ? null : [lo, hi];
  };
  /** Kerb or paint over (x, z) within tol of y: its kind, or null. */
  const lineAt = (x, z, y, tol = 0.6) => {
    let found = null;
    each(x, z, (kind, h) => {
      if (kind !== 0 && Math.abs(h - y) <= tol) found = KINDS[kind];
    });
    return found;
  };
  // Every road, walked at a fixed spacing along its WHOLE length (inside the
  // junctions at its ends too): f(i, s, x, z, tx, tz, y, half, k) with k the
  // piece of its middle line the point is on.
  const walk = (step, f) => {
    d.edges.forEach((e, i) => {
      if (d.JX.internal[i]) return;
      const P = d.EP[i];
      const cum = d.ECUM[i];
      const len = cum[cum.length - 1];
      const Y = d.hasProfile[i] ? d.deckY(i) : null;
      let k = 0;
      for (let s = 0; s <= len; s += step) {
        while (k < P.length - 2 && cum[k + 1] <= s) k++;
        const sl = cum[k + 1] - cum[k] || 1;
        const u = (s - cum[k]) / sl;
        const tx = (P[k + 1][0] - P[k][0]) / sl, tz = (P[k + 1][1] - P[k][1]) / sl;
        const x = P[k][0] + (P[k + 1][0] - P[k][0]) * u, z = P[k][1] + (P[k + 1][1] - P[k][1]) * u;
        const y = Y ? Y[k] + (Y[k + 1] - Y[k]) * u : d.surfaceAt(x, z);
        f(i, s, x, z, tx, tz, y, d.halfAtE(i, k) + (d.halfAtE(i, k + 1) - d.halfAtE(i, k)) * u, k);
      }
    });
  };
  /** Points that touch (within cell metres) gathered into places: one entry each, its worst point first. (On the map: the outermost tiles run a little past its edge.) */
  const places = (pts, cell = 4) => {
    const cells = new Map();
    const B = d.WB;
    for (const p of pts) {
      if (p.x < B.minX + 10 || p.x > B.maxX - 10 || p.z < B.minZ + 10 || p.z > B.maxZ - 10) continue;
      const key = `${Math.floor(p.x / cell)},${Math.floor(p.z / cell)}`;
      (cells.get(key) ?? cells.set(key, []).get(key)).push(p);
    }
    const seen = new Set();
    const out = [];
    for (const key of cells.keys()) {
      if (seen.has(key)) continue;
      const group = [];
      const todo = [key];
      seen.add(key);
      while (todo.length) {
        const c = todo.pop();
        group.push(...cells.get(c));
        const [ci, cj] = c.split(',').map(Number);
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const n = `${ci + di},${cj + dj}`;
            if (cells.has(n) && !seen.has(n)) seen.add(n), todo.push(n);
          }
      }
      group.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
      out.push({ ...group[0], over: group[0].value ?? 1, points: group.length });
    }
    return out.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  };
  // The plan of every road (its middle line and half width), to ask whose
  // ground a point is on: roadAt(x, z, not, seg) = a road that covers (x, z),
  // or -1; piece `seg` of road `not` does not count (the road asking), but
  // its other pieces do (a road bending back on itself).
  const RC = 8;
  const plan = new Map();
  d.edges.forEach((e, i) => {
    const P = d.EP[i];
    for (let k = 0; k < P.length - 1; k++) {
      const h = Math.max(d.halfAtE(i, k), d.halfAtE(i, k + 1));
      const x0 = Math.min(P[k][0], P[k + 1][0]) - h, x1 = Math.max(P[k][0], P[k + 1][0]) + h;
      const z0 = Math.min(P[k][1], P[k + 1][1]) - h, z1 = Math.max(P[k][1], P[k + 1][1]) + h;
      for (let j = Math.floor(z0 / RC); j <= Math.floor(z1 / RC); j++)
        for (let c = Math.floor(x0 / RC); c <= Math.floor(x1 / RC); c++) {
          const key = j * 100003 + c;
          const l = plan.get(key);
          if (l) l.push(i, k);
          else plan.set(key, [i, k]);
        }
    }
  });
  const roadAt = (x, z, not, seg) => {
    const l = plan.get(Math.floor(z / RC) * 100003 + Math.floor(x / RC));
    if (!l) return -1;
    for (let q = 0; q < l.length; q += 2) {
      const i = l[q], k = l[q + 1];
      if (i === not && k === seg) continue;
      const P = d.EP[i];
      const ax = P[k][0], az = P[k][1], bx = P[k + 1][0], bz = P[k + 1][1];
      const vx = bx - ax, vz = bz - az;
      const u = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz || 1)));
      const h = d.halfAtE(i, k) + (d.halfAtE(i, k + 1) - d.halfAtE(i, k)) * u;
      if (Math.hypot(x - ax - vx * u, z - az - vz * u) <= h) return i;
    }
    return -1;
  };
  return (window.__finIdx = { flatAt, asphaltAt, asphaltSpan, lineAt, roadAt, sheets, walk, places });
};

// The outside edge of every road, followed along its whole length. At each
// half metre, each side: how far out from the middle does the asphalt reach?
// The side is OPEN where the asphalt runs on into another road's ground (a
// road joining, or one alongside paved as one surface with this one).
// Returns one entry per road: { i, rows: [{ s, x, z, tx, tz, y, half, w: [left, right], gap: [left, right] }] }
// with w = NaN where no road is drawn, Infinity where the side is open, and
// gap = the width of ground before the next asphalt starts (NaN if none within 3 m).
window.__edgeRuns = () => {
  if (window.__edgeRunsCache) return window.__edgeRunsCache;
  const F = window.__finishIndex();
  const OPEN = 8, D = 0.1, REACH = 3;
  const roads = [];
  let cur = null;
  F.walk(0.5, (i, s, x, z, tx, tz, y, half, seg) => {
    if (!cur || cur.i !== i) roads.push((cur = { i, rows: [] }));
    const row = { s, x, z, tx, tz, y, half, w: [NaN, NaN], gap: [NaN, NaN] };
    cur.rows.push(row);
    const yc = F.asphaltAt(x, z, y, 1.5);
    if (Number.isNaN(yc)) return;
    row.y = yc;
    [-1, 1].forEach((f, side) => {
      const at = (o, yy, tol) => F.asphaltAt(x + tz * f * o, z - tx * f * o, yy, tol);
      let o = Math.max(0, half - 0.3);
      let h = at(o, yc, 0.8);
      if (Number.isNaN(h)) {
        // (The edge is further in than planned: find it.)
        while (o > 0 && Number.isNaN(h)) (o -= D), (h = at(o, yc, 0.8));
        if (Number.isNaN(h)) return;
      } else {
        for (;;) {
          const n = at(o + D, h, 0.5);
          if (Number.isNaN(n)) break;
          o += D;
          h = n;
          if (o > half + OPEN || (o > half + 0.2 && F.roadAt(x + tz * f * o, z - tx * f * o, i, seg) >= 0)) {
            row.w[side] = Infinity;
            return;
          }
        }
      }
      row.w[side] = o;
      for (let g = 2 * D; g <= REACH; g += D)
        if (!Number.isNaN(at(o + g, h, 0.6))) {
          row.gap[side] = g - D;
          break;
        }
    });
  });
  return (window.__edgeRunsCache = roads);
};

// In-page check: the outside edge of a road never jumps sideways. Followed
// along the whole road, through its junctions, from what is drawn. (An edge
// that swings steadily out to where another road joins is a corner, not a
// jump. One that bulges and steps back is.)
window.__checkEdgeRuns = (all = false, JUMP = 0.4, NEAR = 10) => {
  const F = window.__finishIndex();
  const d = globalThis.__osm;
  const pts = [];
  let n = 0;
  for (const { i, rows } of window.__edgeRuns()) {
    // (Inside a junction its own outline is the edge, and the junction
    // checks look at its shape. The line where the junction hands over to
    // the road counts here.)
    const in0 = (d.JX.trimA[i] || 0) - 0.75, in1 = d.ELEN[i] - (d.JX.trimB[i] || 0) + 0.75;
    for (const side of [0, 1]) {
      /** Walking from row k (the wider side of a jump) in direction dir: does the edge keep swinging out until the side opens? */
      const opens = (k, dir) => {
        let top = rows[k].w[side];
        for (let q = k + dir, c = 0; c < NEAR / 0.5; q += dir, c++) {
          if (q < 0 || q >= rows.length) return false;
          const w = rows[q].w[side];
          if (!Number.isFinite(w)) return true;
          if (w < top - 0.15) return false;
          top = Math.max(top, w);
        }
        return false;
      };
      for (let k = 1; k < rows.length; k++) {
        const a = rows[k - 1], b = rows[k];
        if (!Number.isFinite(a.w[side]) || !Number.isFinite(b.w[side])) continue;
        n++;
        const jump = Math.abs(b.w[side] - a.w[side]);
        if (jump <= JUMP || b.s <= in0 || a.s >= in1) continue;
        if (b.w[side] > a.w[side] ? opens(k, 1) : opens(k - 1, -1)) continue;
        const f = side ? 1 : -1;
        const o = Math.max(a.w[side], b.w[side]);
        pts.push({ road: d.edges[i].name || d.edges[i].cls, i, s: +b.s.toFixed(1), side: side ? 'right' : 'left', x: +(b.x + b.tz * f * o).toFixed(1), z: +(b.z - b.tx * f * o).toFixed(1), value: +jump.toFixed(2) });
      }
    }
  }
  const bad = F.places(pts, 6);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: 'm' };
};

// In-page check: no thin strip of ground between two roads running side by
// side. Carriageways that close are either paved as one surface or kept far
// enough apart for a proper island (THIN metres), never a sliver with a kerb
// on each side of it. From what is drawn, along the whole of every road.
window.__checkSlivers = (all = false, THIN = 1.4, RUN = 3) => {
  const F = window.__finishIndex();
  const d = globalThis.__osm;
  const pts = [];
  let n = 0;
  for (const { i, rows } of window.__edgeRuns()) {
    for (const side of [0, 1]) {
      let run = [];
      const flush = () => {
        if (run.length * 0.5 >= RUN)
          for (const r of run) {
            const f = side ? 1 : -1;
            const o = r.w[side] + r.gap[side] / 2;
            pts.push({ road: d.edges[i].name || d.edges[i].cls, i, s: +r.s.toFixed(1), x: +(r.x + r.tz * f * o).toFixed(1), z: +(r.z - r.tx * f * o).toFixed(1), gap: +r.gap[side].toFixed(1), value: +(THIN - r.gap[side]).toFixed(1) });
          }
        run = [];
      };
      for (const r of rows) {
        if (Number.isFinite(r.w[side])) n++;
        if (r.gap[side] < THIN) run.push(r);
        else flush();
      }
      flush();
    }
  }
  const bad = F.places(pts, 3).map((p) => ({ ...p, length: Math.round(p.points / 4) }));
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: 'm' };
};

// In-page check: the road is one sheet. Nowhere does one piece of road lie
// over another at a different height (its edge shows as a line, or stands up
// as a ridge), and nowhere does the surface step up across a lane. From what
// is drawn, across the full width of every road, every metre.
window.__checkOneSheet = (all = false, LAYER = 0.04, RIDGE = 0.12) => {
  const F = window.__finishIndex();
  const d = globalThis.__osm;
  const pts = [];
  let n = 0;
  for (const { i, rows } of window.__edgeRuns()) {
    for (let k = 0; k < rows.length; k += 2) {
      const r = rows[k];
      if (Number.isNaN(r.w[0]) && Number.isNaN(r.w[1])) continue;
      let prev = NaN;
      const reach = Math.max(0, r.half - 0.25);
      for (let o = -reach; o <= reach + 1e-6; o += 0.5) {
        const x = r.x + r.tz * o, z = r.z - r.tx * o;
        const sp = F.asphaltSpan(x, z, r.y, 1);
        if (!sp) {
          prev = NaN;
          continue;
        }
        n++;
        const layer = sp[1] - sp[0];
        const ridge = Math.abs(sp[1] - prev);
        prev = sp[1];
        const value = Math.max(layer > LAYER ? layer : 0, ridge > RIDGE ? ridge : 0);
        if (value) pts.push({ road: d.edges[i].name || d.edges[i].cls, i, s: +r.s.toFixed(1), x: +x.toFixed(1), z: +z.toFixed(1), what: layer > LAYER ? 'one piece over another' : 'step across the lane', value: +value.toFixed(2) });
      }
    }
  }
  const bad = F.places(pts, 4);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: 'm' };
};

// In-page check: nothing upright (parapet, barrier wall, pier) stands on a
// surface you can drive on. Every upright sheet of deck with the same sheet
// of asphalt at its foot on BOTH sides is standing in the road.
window.__checkUprights = (all = false) => {
  const F = window.__finishIndex();
  const pts = [];
  let n = 0;
  for (const s of F.sheets) {
    if (s.hi - s.lo < 0.4) continue;
    n++;
    const mx = (s.x0 + s.x1) / 2, mz = (s.z0 + s.z1) / 2;
    const l = Math.hypot(s.x1 - s.x0, s.z1 - s.z0);
    const nx = (s.z1 - s.z0) / l, nz = -(s.x1 - s.x0) / l;
    // (Asphalt between the sheet's foot and 30 cm below its top.)
    const foot = (f) => {
      const sp = F.asphaltSpan(mx + nx * f * 0.3, mz + nz * f * 0.3, (s.lo + s.hi) / 2 - 0.1, (s.hi - s.lo) / 2 - 0.1);
      return sp ? sp[0] : NaN;
    };
    const a = foot(1), b = foot(-1);
    if (Math.abs(a - b) < 0.4) pts.push({ x: +mx.toFixed(1), z: +mz.toFixed(1), y: +s.lo.toFixed(1), value: +(s.hi - Math.min(a, b)).toFixed(2) });
  }
  const bad = F.places(pts, 4);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: 'm' };
};

// In-page count: the splits where the builder's own rules are switched off.
// Beside a flyover (within 300 m along the roads) a split on the ground
// still goes without three of them: the road's width may taper into a
// narrower branch, the junction is not shaped with its branches side by
// side, and an expressway joint is not left plain. (Its width caps and the
// branch moved out to the road's edge are back on.) Every such place is one
// where the faults those rules prevent can come back, so the count may only
// fall.
window.__checkSwitchedOff = (all = false) => {
  const d = globalThis.__osm;
  const bad = [];
  let n = 0;
  for (const [j, [c]] of d.deckSplits) {
    n++;
    if (!d.nearDeck[j] || d.isDeck[c]) continue;
    const P = d.EP[c];
    const at = d.edges[c].a === j ? P[0] : P[P.length - 1];
    bad.push({ road: d.edges[c].name || d.edges[c].cls, j, x: +at[0].toFixed(1), z: +at[1].toFixed(1), over: 1 });
  }
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40) };
};
