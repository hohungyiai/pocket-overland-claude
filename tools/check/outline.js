// In-page checks (run with ?debug, after finish.js) on the road's outline as
// it is drawn: the kerb round it, the surface inside it and what stands at
// its edge. Read off the drawn meshes, whatever rule drew them.
//
//   __checkGaps            no uncovered gap inside the road: nowhere does the
//                          ground show through a crack between two pieces
//                          of road surface (a hairline, a sliver)
//   __checkKerbLoops       every kerb runs on unbroken: where one piece ends
//                          the next carries on within 2 cm and at the same
//                          height, or the kerb meets a road or ends where
//                          a plain lane (a driveway) begins; and nothing
//                          drawn lies over it, so its whole width shows
//   __checkUprightsInKerb  no wall or parapet beside a kerb stands more than
//                          2 cm out past the kerb's outer edge (one standing
//                          at a kerb level with its top is that kerb's face)

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
  // (Redrawn maps only, the user's call on 16 Nov: today's map keeps its
  // old kerbs, which these rules were never written for.)
  if (!globalThis.__osm.oneLine) return { samples: 0, bad: 0, worst: [], unit: 'm' };
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
// (Passed for now, the user's call on 16 Nov, to fix straight after the
// PR: a bit of kerb buried 6 cm in the middle of an expressway where its
// slip lane merges, and an island's point 2 cm under the paving beside it.)
const KERBS_FOR_NOW = [[1776.44, 1423.72], [2260.8, 2832.13]];
window.__checkKerbLoops = (all = false, STEP = 0.02, PLAIN = 0.5) => {
  // (Redrawn maps only, the user's call on 16 Nov: today's map keeps its
  // old kerbs, which these rules were never written for.)
  if (!globalThis.__osm.oneLine) return { samples: 0, bad: 0, worst: [], unit: 'm' };
  const F = window.__finishIndex();
  const at = window.__flatIndex(SURFACE_KINDS);
  const pts = [];
  let n = 0;
  const caps = [];
  // (A kerb drawn across a tile's edge is one kerb: where its two tiles'
  // pieces meet on one edge, at one height, that edge is no end. Read tile
  // by tile, a piece of kerb shorter than 1.2 m alone in its tile had its
  // sides taken for ends.)
  const meshes = [];
  const ek = (e) => {
    const a = `${Math.round(e[0] * 1000)},${Math.round(e[2] * 1000)}`, b = `${Math.round(e[3] * 1000)},${Math.round(e[5] * 1000)}`;
    return a < b ? a + '|' + b : b + '|' + a;
  };
  const byEdge = new Map();
  window.__eachMesh(['kerb'], (k, _kind, pos, idx) => {
    const E = window.__openEdges(pos, idx);
    meshes.push({ k, pos, idx, E });
    for (const e of E) {
      const key = ek(e);
      (byEdge.get(key) ?? byEdge.set(key, []).get(key)).push({ k, y: (e[1] + e[4]) / 2 });
    }
  });
  const shared = (k, e) => (byEdge.get(ek(e)) ?? []).some((o) => o.k !== k && Math.abs(o.y - (e[1] + e[4]) / 2) <= STEP);
  for (const { k, pos, idx, E: E0 } of meshes) {
    const E = E0.filter((e) => !shared(k, e));
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
      // (One at each end: two square edges at one corner and none at the
      // other is a kerb's side turning a corner, not its end.)
      let sides = 0;
      let ends = 0;
      let dx = 0, dz = 0;
      for (const [x, z] of [[e[0], e[2]], [e[3], e[5]]]) {
        const before = sides;
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
        if (sides > before) ends++;
      }
      if (ends < 2) return;
      const dl = Math.hypot(dx, dz) || 1;
      caps.push({ x: (e[0] + e[3]) / 2, z: (e[2] + e[5]) / 2, y: Math.max(e[1], e[4]), ox: -dx / dl, oz: -dz / dl, L });
    });
    // (Nothing drawn over the kerb: at each of its triangles' middles.)
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const x = (pos[a] + pos[b] + pos[c]) / 3, z = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3, y = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3;
      n++;
      const over = at(x, z).reduce((m, f) => (f.kind === 'road' && f.h > y + 0.01 && f.h < y + 0.3 ? Math.max(m, f.h - y) : m), 0);
      if (over && !KERBS_FOR_NOW.some(([px, pz]) => Math.hypot(x - px, z - pz) < 1.5)) pts.push({ what: 'hidden under paving', x: +x.toFixed(2), z: +z.toFixed(2), value: +over.toFixed(2) });
    }
  }
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
    // (Or it ends where a plain lane's edge begins, a driveway or a car
    // park lane, which has no kerb: the street's kerb stops there, as a
    // dropped kerb does. The user's choice, 14 Nov.)
    const steps = past.some((f) => f.kind === 'kerb');
    if (!steps && globalThis.__osm.plainRoadNear?.(p.x, p.z, PLAIN)) return;
    pts.push({ what: steps ? 'kerb steps' : 'kerb stops on the verge', x: +p.x.toFixed(2), z: +p.z.toFixed(2), value: 0.1 });
  });
  const bad = F.places(pts, 2);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: 'm' };
};

// No wall or parapet beside a kerb stands out past it. Along every upright
// sheet beside a kerb (within 0.6 m of one, that it stands up past), the
// kerb must reach to within 2 cm of it.
// (Places the user looked at, in pictures from the driver's seat and from
// above, and passed as they are, 15 Nov: a wall holding up a raised road
// beside a lower road, and two ramp walls at a short slip road's point.)
// (Each a stretch from a to b, and r about it.)
const UPRIGHTS_SEEN = [
  { a: [-2788.0, 2252.8], b: [-2801.0, 2258.1], r: 1 },
  { a: [-2068.72, -1071.77], b: [-2068.72, -1071.77], r: 3 },
  { a: [1789.93, 2072.64], b: [1789.93, 2072.64], r: 3 },
];
// (Passed for now, the user's call on 16 Nov: open the PR and fix these
// straight after it. Four walls 4-5 cm out and one 29 cm out on the whole
// map, two of 3-4 cm on the trial map.)
const UPRIGHTS_FOR_NOW = [
  [1821.23, 1622.32], [-3024.5, -1945.9], [-3507.16, 2792.19], [93.04, 2762.52], [100.36, 2763.52], [1750.15, 1827.29], [1779.1, 1797.64],
];
// (The one at -3024.5 runs 12 samples along: 3 m about it.)
for (const [x, z] of UPRIGHTS_FOR_NOW) UPRIGHTS_SEEN.push({ a: [x, z], b: [x, z], r: x === -3024.5 ? 3 : 2 });
const uprightSeen = (x, z) =>
  UPRIGHTS_SEEN.some(({ a, b, r }) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
    const t = L ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L)) : 0;
    return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t) <= r;
  });
window.__checkUprightsInKerb = (all = false, OUT = 0.02) => {
  // (Redrawn maps only, the user's call on 16 Nov: today's map keeps its
  // old kerbs, which these rules were never written for.)
  if (!globalThis.__osm.oneLine) return { samples: 0, bad: 0, worst: [], unit: 'm' };
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
      // (A sheet standing right at a kerb whose top is level with its own,
      // within 2 cm, is that kerb's own face: it stands out past nothing.
      // Passed over for being level with it, the reach ran on across the
      // grass to another road's kerb, lower, and took that for its own.)
      const flush = [1, -1].some((sg) => {
        for (let o = 0; o <= OUT + 1e-9; o += 0.01) if (at(x + nx * sg * o, z + nz * sg * o).some((f) => f.h > s.hi - 0.01 && f.h <= s.hi + 0.05)) return true;
        return false;
      });
      const seen = uprightSeen(x, z);
      if (r > OUT && !flush && !seen) pts.push({ x: +x.toFixed(2), z: +z.toFixed(2), out: +r.toFixed(2), value: +r.toFixed(2) });
    }
  }
  const bad = F.places(pts, 2);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: 'm' };
};
