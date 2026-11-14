// In-page checks (run with ?debug, after finish.js) on the road's outline as
// it is drawn: the kerb round it, the surface inside it and what stands at
// its edge. Read off the drawn meshes, whatever rule drew them.
//
//   __checkGaps            no uncovered gap inside the road: nowhere does the
//                          ground show through a crack between two pieces
//                          of road surface (a hairline, a sliver)
//   __checkKerbLoops       every kerb runs on unbroken: where one piece ends
//                          the next carries on within 2 cm and at the same
//                          height, or the kerb meets a road; and nothing
//                          drawn lies over it, so its whole width shows
//   __checkUprightsInKerb  no wall or parapet beside a kerb stands more than
//                          2 cm out past the kerb's outer edge

/** Every triangle of the given drawn kinds, one tile at a time: f(tileKey, kind, pos, idx). */
window.__eachMesh = (kinds, f) => {
  const d = globalThis.__osm;
  for (const k of d.farTiles()) {
    const accs = d.tileAccs(k);
    for (const kind of kinds) {
      const r = accs[kind];
      if (r && r.pos && r.idx) f(k, kind, r.pos, r.idx);
    }
  }
};

/**
 * The edges of a mesh that only one of its triangles has (its outline), as
 * [ax, ay, az, bx, by, bz, cx, cz] with (cx, cz) the triangle's third corner.
 * Corners count as one where they lie within a millimetre of each other.
 */
window.__openEdges = (pos, idx) => {
  const key = (v) => `${Math.round(pos[v * 3] * 1000)},${Math.round(pos[v * 3 + 2] * 1000)}`;
  const seen = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const v = [idx[t], idx[t + 1], idx[t + 2]];
    const ax = pos[v[0] * 3], az = pos[v[0] * 3 + 2], bx = pos[v[1] * 3], bz = pos[v[1] * 3 + 2], cx = pos[v[2] * 3], cz = pos[v[2] * 3 + 2];
    if (Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) < 1e-6) continue;
    const ks = v.map(key);
    for (let e = 0; e < 3; e++) {
      const a = e, b = (e + 1) % 3, c = (e + 2) % 3;
      if (ks[a] === ks[b]) continue;
      const id = ks[a] < ks[b] ? ks[a] + '|' + ks[b] : ks[b] + '|' + ks[a];
      const was = seen.get(id);
      if (was) was.n++;
      else seen.set(id, { n: 1, e: [pos[v[a] * 3], pos[v[a] * 3 + 1], pos[v[a] * 3 + 2], pos[v[b] * 3], pos[v[b] * 3 + 1], pos[v[b] * 3 + 2], pos[v[c] * 3], pos[v[c] * 3 + 2]] });
    }
  }
  const out = [];
  for (const { n, e } of seen.values()) if (n === 1) out.push(e);
  return out;
};

/** Everything flat that is drawn over (x, z), of the kinds asked: [{ kind, h }]. Bucketed on a 2 m grid. */
window.__flatIndex = (kinds) => {
  const C = 2;
  const T = [];
  const K = [];
  window.__eachMesh(kinds, (_k, kind, pos, idx) => {
    for (let q = 0; q < idx.length; q += 3) {
      const a = idx[q] * 3, b = idx[q + 1] * 3, c = idx[q + 2] * 3;
      const det = (pos[b + 2] - pos[c + 2]) * (pos[a] - pos[c]) + (pos[c] - pos[b]) * (pos[a + 2] - pos[c + 2]);
      if (Math.abs(det) < 1e-6) continue;
      T.push(pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2], pos[c], pos[c + 1], pos[c + 2]);
      K.push(kind);
    }
  });
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
  return (x, z) => {
    const out = [];
    const l = grid.get(Math.floor(z / C) * 100003 + Math.floor(x / C));
    if (!l) return out;
    for (const t of l) {
      const o = t * 9;
      const ax = T[o], az = T[o + 2], bx = T[o + 3], bz = T[o + 5], cx = T[o + 6], cz = T[o + 8];
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-5 || l2 < -1e-5 || l3 < -1e-5) continue;
      out.push({ kind: K[t], h: l1 * T[o + 1] + l2 * T[o + 4] + l3 * T[o + 7] });
    }
    return out;
  };
};

const SURFACE_KINDS = ['road', 'kerb', 'white', 'yellow', 'box', 'deck'];

// No uncovered gap inside the road. Every open edge of the road surface is
// either the road's outline (the kerb lies over it, or there is ground
// beyond) or it meets more road: then whatever is drawn just past it must
// cover it, or the ground shows through a crack. A crack is ground showing
// within 4 mm of an edge with road surface again within 0.5 m beyond.
window.__checkGaps = (all = false) => {
  const F = window.__finishIndex();
  const at = window.__flatIndex(SURFACE_KINDS);
  const pts = [];
  let n = 0;
  window.__eachMesh(['road'], (_k, _kind, pos, idx) => {
    for (const [ax, ay, az, bx, by, bz, cx, cz] of window.__openEdges(pos, idx)) {
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.05) continue;
      // (Outward: away from the triangle's third corner.)
      let nx = (bz - az) / L, nz = -(bx - ax) / L;
      if ((cx - ax) * nx + (cz - az) * nz > 0) (nx = -nx), (nz = -nz);
      for (const t of L > 1 ? [0.25, 0.5, 0.75] : [0.5]) {
        n++;
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t, y = ay + (by - ay) * t;
        const covered = (o, tol) => at(x + nx * o, z + nz * o).some((f) => Math.abs(f.h - y) <= tol);
        if (covered(0.004, 0.15)) continue;
        // (Road again within half a metre beyond, at its level: a crack, not the edge.)
        let w = 0;
        for (let o = 0.02; o <= 0.5 && !w; o += 0.02) if (at(x + nx * o, z + nz * o).some((f) => f.kind === 'road' && Math.abs(f.h - y) <= 0.1)) w = o;
        // (Reported at the crack's middle.)
        if (w) pts.push({ x: +(x + (nx * w) / 2).toFixed(2), z: +(z + (nz * w) / 2).toFixed(2), y: +y.toFixed(2), width: +w.toFixed(2), value: +w.toFixed(2) });
      }
    }
  });
  const bad = F.places(pts, 2);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: 'm' };
};

// Every kerb runs on unbroken, its whole width showing. Each piece of kerb
// is a ribbon; where one ends (its square end, a cap) another must carry on
// from the same place, within 2 cm across and up, or the kerb must meet a
// road or a deck there (a mouth, a crossing). A cap with nothing to carry it
// on is a gap or a fragment; one carried on off-line or at another height is
// a step. And nothing of the road's surface lies over a kerb: where paving
// or road lies over it, part of its width is hidden (a notch).
window.__checkKerbLoops = (all = false, STEP = 0.02) => {
  const F = window.__finishIndex();
  const at = window.__flatIndex(SURFACE_KINDS);
  const pts = [];
  let n = 0;
  const caps = [];
  window.__eachMesh(['kerb'], (_k, _kind, pos, idx) => {
    const E = window.__openEdges(pos, idx);
    // (Each corner's open edges, to tell a cap from a side.)
    const byV = new Map();
    const vk = (x, z) => `${Math.round(x * 1000)},${Math.round(z * 1000)}`;
    E.forEach((e, q) => {
      for (const [x, z] of [[e[0], e[2]], [e[3], e[5]]]) {
        const key = vk(x, z);
        (byV.get(key) ?? byV.set(key, []).get(key)).push(q);
      }
    });
    E.forEach((e, q) => {
      const L = Math.hypot(e[3] - e[0], e[5] - e[2]);
      if (L < 0.2 || L > 1.2) return;
      const ux = (e[3] - e[0]) / L, uz = (e[5] - e[2]) / L;
      // (A cap meets a side at each end, square to it.)
      let sides = 0;
      let dx = 0, dz = 0;
      for (const [x, z] of [[e[0], e[2]], [e[3], e[5]]]) {
        for (const r of byV.get(vk(x, z)) ?? []) {
          if (r === q) continue;
          const f = E[r];
          const l = Math.hypot(f[3] - f[0], f[5] - f[2]) || 1;
          const c = ((f[3] - f[0]) * ux + (f[5] - f[2]) * uz) / l;
          if (Math.abs(c) < 0.5) {
            sides++;
            // (The way the ribbon runs on, away from the cap.)
            const far = Math.hypot(f[0] - x, f[2] - z) > 1e-3 ? [f[0], f[2]] : [f[3], f[5]];
            dx += far[0] - x;
            dz += far[1] - z;
          }
        }
      }
      if (sides < 2) return;
      const dl = Math.hypot(dx, dz) || 1;
      caps.push({ x: (e[0] + e[3]) / 2, z: (e[2] + e[5]) / 2, y: Math.max(e[1], e[4]), ox: -dx / dl, oz: -dz / dl, L });
    });
    // (Nothing drawn over the kerb: at each of its triangles' middles.)
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const x = (pos[a] + pos[b] + pos[c]) / 3, z = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3, y = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3;
      n++;
      const over = at(x, z).reduce((m, f) => (f.kind === 'road' && f.h > y + 0.01 && f.h < y + 0.3 ? Math.max(m, f.h - y) : m), 0);
      if (over) pts.push({ what: 'hidden under paving', x: +x.toFixed(2), z: +z.toFixed(2), value: +over.toFixed(2) });
    }
  });
  const grid = new Map();
  const C = 1;
  caps.forEach((p, q) => {
    const key = Math.floor(p.z / C) * 100003 + Math.floor(p.x / C);
    (grid.get(key) ?? grid.set(key, []).get(key)).push(q);
  });
  caps.forEach((p, q) => {
    n++;
    let best = Infinity, dy = 0;
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++)
        for (const r of grid.get((Math.floor(p.z / C) + j) * 100003 + Math.floor(p.x / C) + i) ?? []) {
          if (r === q) continue;
          const o = caps[r];
          // (Another cap facing it: the kerb carried on.)
          if (o.ox * p.ox + o.oz * p.oz > -0.5) continue;
          const dd = Math.hypot(o.x - p.x, o.z - p.z);
          if (dd < best) (best = dd), (dy = Math.abs(o.y - p.y));
        }
    if (best <= STEP && dy <= STEP) return;
    if (best <= 0.3) {
      pts.push({ what: 'kerb steps', x: +p.x.toFixed(2), z: +p.z.toFixed(2), across: +best.toFixed(3), up: +dy.toFixed(3), value: +Math.max(best, dy).toFixed(3) });
      return;
    }
    // (Carried on by road, deck or more kerb just past its end, at its level.)
    const past = at(p.x + p.ox * 0.05, p.z + p.oz * 0.05);
    if (past.some((f) => Math.abs(f.h - p.y) <= 0.15 && (f.kind !== 'kerb' || Math.abs(f.h - p.y) <= STEP))) return;
    pts.push({ what: past.some((f) => f.kind === 'kerb') ? 'kerb steps' : 'kerb stops on the verge', x: +p.x.toFixed(2), z: +p.z.toFixed(2), value: 0.1 });
  });
  const bad = F.places(pts, 2);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: 'm' };
};

// No wall or parapet beside a kerb stands out past it. Along every upright
// sheet beside a kerb (within 0.6 m of one, that it stands up past), the
// kerb must reach to within 2 cm of it.
window.__checkUprightsInKerb = (all = false, OUT = 0.02) => {
  const F = window.__finishIndex();
  const at = window.__flatIndex(['kerb']);
  const pts = [];
  let n = 0;
  for (const s of F.sheets) {
    const L = Math.hypot(s.x1 - s.x0, s.z1 - s.z0);
    const nx = (s.z1 - s.z0) / L, nz = -(s.x1 - s.x0) / L;
    for (let u = 0.25; u < L; u += 0.5) {
      const x = s.x0 + ((s.x1 - s.x0) * u) / L, z = s.z0 + ((s.z1 - s.z0) * u) / L;
      // (Nearest kerb either side, at a height the sheet stands up past by
      // more than a centimetre: a deck's edge beam level with the deck
      // below it stands up past nothing.)
      const reach = (sg) => {
        for (let o = 0; o <= 0.6; o += 0.01) if (at(x + nx * sg * o, z + nz * sg * o).some((f) => f.h >= s.lo - 0.05 && f.h <= s.hi - 0.01)) return o;
        return Infinity;
      };
      const r = Math.min(reach(1), reach(-1));
      if (r === Infinity) continue;
      n++;
      if (r > OUT) pts.push({ x: +x.toFixed(2), z: +z.toFixed(2), out: +r.toFixed(2), value: +r.toFixed(2) });
    }
  }
  const bad = F.places(pts, 2);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: 'm' };
};
