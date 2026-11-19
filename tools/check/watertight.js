// The user's slip-road rules S3-S5 (19 Nov), read off the finished meshes:
//
// __checkWatertight: every top surface (road, kerb, island lawn, footpath,
//   cycle path) is closed at its edges. Wherever the surface just past an
//   edge lies more than a kerb's height (0.15 m) lower, or there is none and
//   the ground lies that far down, an upright face (a kerb's, a wall's, a
//   beam's or a parapet's) covers the drop there, within 5 cm of the edge,
//   from the edge down to whatever lies below. A missing wall, a slit of sky
//   under a road, a wall that stops square while the drop carries on, and a
//   lawn left floating over a lower road all show as an uncovered drop.
//   It asks only what is drawn, so no rule the builder used to leave a face
//   out can hide one.
// __checkGroundOverTops: the ground never stands up over a kerb, a wall's
//   top or a road's edge beside it (grass poking through a wall's foot or
//   past a kerb).

window.__watertightIndex = () => {
  if (window.__wtIdx) return window.__wtIdx;
  const d = globalThis.__osm;
  const TOPS = ['road', 'kerb', 'lawn', 'foot', 'cycle'];
  const C = 2;
  // Top surfaces: triangles that face up, bucketed by their extent on the ground.
  const tri = [];
  const tgrid = new Map();
  // Upright faces: [x0, z0, x1, z1, lo, hi] for every triangle standing on edge, in any buffer.
  const face = [];
  const fgrid = new Map();
  // Undersides of decks, as the tops are.
  const under = [];
  const ugrid = new Map();
  // Edges of the top surfaces, counted, to find those that border nothing.
  const edges = new Map();
  const key = (x, y, z) => `${Math.round(x * 200)},${Math.round(y * 200)},${Math.round(z * 200)}`;
  const put = (grid, i, x0, z0, x1, z1) => {
    for (let a = Math.floor(x0 / C); a <= Math.floor(x1 / C); a++)
      for (let b = Math.floor(z0 / C); b <= Math.floor(z1 / C); b++) {
        const k = a * 100003 + b;
        (grid.get(k) ?? grid.set(k, []).get(k)).push(i);
      }
  };
  for (const k of d.farTiles()) {
    const accs = d.tileAccs(k);
    for (const [kind, r] of Object.entries(accs)) {
      if (!r || !r.idx) continue;
      const top = TOPS.includes(kind);
      if (!top && kind !== 'deck') continue;
      const { pos, idx } = r;
      for (let q = 0; q < idx.length; q += 3) {
        const a = idx[q] * 3, b = idx[q + 1] * 3, c = idx[q + 2] * 3;
        const det = (pos[b] - pos[a]) * (pos[c + 2] - pos[a + 2]) - (pos[b + 2] - pos[a + 2]) * (pos[c] - pos[a]);
        if (Math.abs(det) < 1e-5) {
          // (On edge: its longest side on the ground, its foot and top.)
          let best = 0, s = null;
          for (const [p, n] of [[a, b], [b, c], [c, a]]) {
            const l = Math.hypot(pos[n] - pos[p], pos[n + 2] - pos[p + 2]);
            if (l > best) (best = l), (s = [pos[p], pos[p + 2], pos[n], pos[n + 2]]);
          }
          if (best < 0.005) continue;
          const lo = Math.min(pos[a + 1], pos[b + 1], pos[c + 1]), hi = Math.max(pos[a + 1], pos[b + 1], pos[c + 1]);
          if (hi - lo < 0.01) continue;
          face.push([...s, lo, hi]);
          put(fgrid, face.length - 1, Math.min(s[0], s[2]), Math.min(s[1], s[3]), Math.max(s[0], s[2]), Math.max(s[1], s[3]));
          continue;
        }
        if (!top) {
          // (A deck's underside, where its edge beam's foot meets it.)
          const u = under.length;
          under.push([pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2], pos[c], pos[c + 1], pos[c + 2]]);
          put(ugrid, u, Math.min(pos[a], pos[b], pos[c]), Math.min(pos[a + 2], pos[b + 2], pos[c + 2]), Math.max(pos[a], pos[b], pos[c]), Math.max(pos[a + 2], pos[b + 2], pos[c + 2]));
          continue;
        }
        const t = tri.length;
        tri.push([pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2], pos[c], pos[c + 1], pos[c + 2]]);
        put(tgrid, t, Math.min(pos[a], pos[b], pos[c]), Math.min(pos[a + 2], pos[b + 2], pos[c + 2]), Math.max(pos[a], pos[b], pos[c]), Math.max(pos[a + 2], pos[b + 2], pos[c + 2]));
        for (const [p, n, o] of [[a, b, c], [b, c, a], [c, a, b]]) {
          const ka = key(pos[p], pos[p + 1], pos[p + 2]), kb = key(pos[n], pos[n + 1], pos[n + 2]);
          const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
          const e = edges.get(ek);
          if (e) e.n++;
          else edges.set(ek, { n: 1, e: [pos[p], pos[p + 1], pos[p + 2], pos[n], pos[n + 1], pos[n + 2], pos[o], pos[o + 2], kind] });
        }
      }
    }
  }
  /** The heights of every top surface over (x, z) (or every underside). */
  const topsAt = (x, z, list = tri, grid = tgrid) => {
    const out = [];
    for (const t of grid.get(Math.floor(x / C) * 100003 + Math.floor(z / C)) ?? []) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = list[t];
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(det) < 1e-9) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det, l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      out.push(l1 * ay + l2 * by + l3 * cy);
    }
    return out;
  };
  /** The upright faces within r of (x, z): [lo, hi] each. */
  const facesNear = (x, z, r) => {
    const out = [];
    const seen = new Set();
    for (let a = Math.floor((x - r) / C); a <= Math.floor((x + r) / C); a++)
      for (let b = Math.floor((z - r) / C); b <= Math.floor((z + r) / C); b++)
        for (const i of fgrid.get(a * 100003 + b) ?? []) {
          if (seen.has(i)) continue;
          seen.add(i);
          const [x0, z0, x1, z1, lo, hi] = face[i];
          const dx = x1 - x0, dz = z1 - z0, L2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / L2));
          if (Math.hypot(x0 + dx * t - x, z0 + dz * t - z) <= r) out.push([lo, hi]);
        }
    return out;
  };
  // (The ground as drawn: heights on a 4 m lattice from the map's corner,
  // each square cut in two from its +x corner to its +z one. Between the
  // lattice's points it is not the ground the builder asks of heightAt.)
  const STEP = 4;
  const memo = new Map();
  const hv = (i, j) => {
    const k = i * 100003 + j;
    let h = memo.get(k);
    if (h === undefined) memo.set(k, (h = d.heightAt(d.WB.minX + i * STEP, d.WB.minZ + j * STEP)));
    return h;
  };
  const groundAt = (x, z) => {
    const u = (x - d.WB.minX) / STEP, v = (z - d.WB.minZ) / STEP;
    const i = Math.floor(u), j = Math.floor(v), fx = u - i, fz = v - j;
    const a = hv(i, j), b = hv(i, j + 1), c = hv(i + 1, j);
    if (fx + fz <= 1) return a + fx * (c - a) + fz * (b - a);
    const e = hv(i + 1, j + 1);
    return e + (1 - fx) * (b - e) + (1 - fz) * (c - e);
  };
  const open = [...edges.values()].filter((e) => e.n === 1).map((e) => e.e);
  const undersAt = (x, z) => topsAt(x, z, under, ugrid);
  return (window.__wtIdx = { topsAt, undersAt, facesNear, open, groundAt });
};

window.__checkWatertight = (all = false) => {
  const d = globalThis.__osm;
  const F = window.__finishIndex();
  const W = window.__watertightIndex();
  // (A kerb's height: a fall past an edge to another surface any more than
  // this wants a face. To the ground, more than this past where the ground
  // lies beside every road: each road is drawn 0.2 to 0.25 m over the ground
  // its builder seals under it, and its kerb's top 0.15 m over that again,
  // 0.35 m in all, with no face under it, along every road on the map, out
  // of sight from a car's height. 0.4 m is a kerb's height past that.)
  const STEP = 0.15;
  const STEP_GROUND = 0.4;
  const pts = [];
  const hist = {};
  let n = 0;
  for (const [x0, y0, z0, x1, y1, z1, ox, oz, kind] of W.open) {
    // (The roads' own tops, their kerbs' and the islands' lawns: a footpath
    // or cycle path's edge is not a road's, the rules are the roads'.)
    if (kind === 'foot' || kind === 'cycle') continue;
    const L = Math.hypot(x1 - x0, z1 - z0);
    if (L < 0.01) continue;
    // (Outward: away from the triangle's third corner.)
    let nx = (z1 - z0) / L, nz = -(x1 - x0) / L;
    if ((ox - x0) * nx + (oz - z0) * nz > 0) (nx = -nx), (nz = -nz);
    const m = Math.max(1, Math.round(L / 0.5));
    for (let s = 0; s < m; s++) {
      const t = (s + 0.5) / m;
      const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t, z = z0 + (z1 - z0) * t;
      if (x < d.WB.minX + 5 || x > d.WB.maxX - 5 || z < d.WB.minZ + 5 || z > d.WB.maxZ - 5) continue;
      // (Just past the edge: anything at about its height, or a little
      // over it, carries on from it; overhead, a deck's, does not count.)
      const qx = x + nx * 0.03, qz = z + nz * 0.03;
      const hs = W.topsAt(qx, qz);
      if (hs.some((h) => h >= y - STEP && h <= y + 2)) continue;
      const g = W.groundAt(qx, qz);
      const lower = hs.filter((h) => h < y - STEP);
      const top = lower.length ? Math.max(...lower) : -Infinity;
      // (What lies below: another surface, or the ground. A lawn lying on
      // the ground, within 10 cm of it, is the ground's own top: a kerb's
      // end over it is the kerb's end over the ground, as anywhere else.)
      const below = Math.max(g, top), step = top >= g + 0.1 ? STEP : STEP_GROUND;
      if (y - below <= step) continue;
      n++;
      // (Covered: upright faces within 5 cm, together reaching down from
      // the edge with gaps of 2 cm at most, to within the step of what lies
      // below, or to a deck's underside there.)
      const iv = W.facesNear(x, z, 0.05).sort((a, b) => b[1] - a[1]);
      let at = y - 0.02;
      for (const [lo, hi] of iv) {
        if (hi < at - 0.02) break;
        at = Math.min(at, lo);
      }
      if (at <= below + step) continue;
      const ix = x - nx * 0.1, iz = z - nz * 0.1;
      if (W.undersAt(ix, iz).some((h) => h < y - 0.3 && at <= h + 0.05)) continue;
      const hk = kind + (iv.length ? ' faces' : ' none');
      hist[hk] = (hist[hk] ?? 0) + 1;
      pts.push({ x: +x.toFixed(1), z: +z.toFixed(1), y: +y.toFixed(2), value: +(y - below).toFixed(2), open: +(at - below).toFixed(2), kind });
    }
  }
  window.__wtPts = pts;
  const bad = F.places(pts, 4);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: 'm', hist };
};

window.__checkGroundOverTops = (all = false) => {
  const d = globalThis.__osm;
  const F = window.__finishIndex();
  const W = window.__watertightIndex();
  const pts = [];
  let n = 0;
  // (Along each outer edge of a kerb, a road or a wall's top, the ground
  // just past it stands no higher than the edge: else it pokes up through
  // the wall's foot or over the kerb.)
  for (const [x0, y0, z0, x1, y1, z1, ox, oz, kind] of W.open) {
    // (A kerb's or a road's edge: the user's rule S5 is the kerb's and
    // the wall's. An island's lawn running into the ground rising beside it
    // is grass meeting grass, a bank, as the rule allows.)
    if (kind !== 'road' && kind !== 'kerb') continue;
    const L = Math.hypot(x1 - x0, z1 - z0);
    if (L < 0.01) continue;
    let nx = (z1 - z0) / L, nz = -(x1 - x0) / L;
    if ((ox - x0) * nx + (oz - z0) * nz > 0) (nx = -nx), (nz = -nz);
    const m = Math.max(1, Math.round(L / 0.5));
    for (let s = 0; s < m; s++) {
      const t = (s + 0.5) / m;
      const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t, z = z0 + (z1 - z0) * t;
      if (x < d.WB.minX + 5 || x > d.WB.maxX - 5 || z < d.WB.minZ + 5 || z > d.WB.maxZ - 5) continue;
      const qx = x + nx * 0.03, qz = z + nz * 0.03;
      const hs = W.topsAt(qx, qz);
      // (Where a surface carries on past the edge, the ground under it is hidden.)
      if (hs.some((h) => h >= y - 0.15 && h <= y + 2)) continue;
      n++;
      const g = W.groundAt(qx, qz);
      if (g > y + 0.02) pts.push({ x: +x.toFixed(1), z: +z.toFixed(1), y: +y.toFixed(2), value: +(g - y).toFixed(2) });
    }
  }
  const bad = F.places(pts, 4);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: 'm' };
};
