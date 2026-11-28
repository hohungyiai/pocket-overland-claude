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
 * Triangles of drawn meshes, kept as where they lie in their mesh (which
 * mesh, which corners) and not copied out: copied, each an array of its own,
 * the whole map's one-sheet lawn ran the page out of memory. get(q) gives its
 * corners and which way it faces, [ax, ay, az, bx, by, bz, cx, cy, cz, +-1],
 * in one array used again by the next call.
 */
window.__triRefs = () => {
  const meshes = [];
  let ref = new Int32Array(1 << 16), n = 0, last = null;
  const t = new Float64Array(10);
  return {
    add(pos, idx, q) {
      if (last !== pos) meshes.push(pos, idx), (last = pos);
      if (2 * n + 2 > ref.length) {
        const r = new Int32Array(ref.length * 2);
        r.set(ref);
        ref = r;
      }
      ref[2 * n] = meshes.length - 2;
      ref[2 * n + 1] = q;
      return n++;
    },
    get length() {
      return n;
    },
    get(q) {
      const m = ref[2 * q], pos = meshes[m], idx = meshes[m + 1], o = ref[2 * q + 1];
      for (let c = 0; c < 3; c++) {
        const v = idx[o + c] * 3;
        t[3 * c] = pos[v], t[3 * c + 1] = pos[v + 1], t[3 * c + 2] = pos[v + 2];
      }
      t[9] = (t[5] - t[2]) * (t[6] - t[0]) - (t[3] - t[0]) * (t[8] - t[2]) > 0 ? 1 : -1;
      return t;
    },
  };
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
// (The two kerbs passed for now on 16 Nov, buried 2 and 6 cm, went with
// rebuild B, 17 Nov: the paving is cut to the finished kerb line.)
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
      if (over) pts.push({ what: 'hidden under paving', x: +x.toFixed(2), z: +z.toFixed(2), value: +over.toFixed(2) });
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
// (The walls passed for now on 16 and 17 Nov, 3 to 7 cm out, went with
// rebuild B, 17 Nov: every wall, edge beam and parapet now follows its
// kerb's outer edge, point by point. See wallsToKerb.)
const uprightSeen = (x, z) =>
  UPRIGHTS_SEEN.some(({ a, b, r }) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
    const t = L ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L)) : 0;
    return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t) <= r;
  });
/** An upright sheet's bottom and top at fraction f along its ground line: where the triangle meets the upright through that point (null if it does not). */
window.__sheetSpan = (s, f) => {
  const L = Math.hypot(s.x1 - s.x0, s.z1 - s.z0) || 1;
  const ux = (s.x1 - s.x0) / L, uz = (s.z1 - s.z0) / L, t = f * L;
  const P = s.c.map(([x, y, z]) => [(x - s.x0) * ux + (z - s.z0) * uz, y]);
  const ys = [];
  for (let e = 0; e < 3; e++) {
    const [a, b] = [P[e], P[(e + 1) % 3]];
    if (Math.abs(b[0] - a[0]) < 1e-6) {
      if (Math.abs(t - a[0]) < 1e-6) ys.push(a[1], b[1]);
      continue;
    }
    const w = (t - a[0]) / (b[0] - a[0]);
    if (w >= -1e-6 && w <= 1 + 1e-6) ys.push(a[1] + (b[1] - a[1]) * w);
  }
  return ys.length ? [Math.min(...ys), Math.max(...ys)] : null;
};

window.__checkUprightsInKerb = (all = false, OUT = 0.02) => {
  // (Redrawn maps only, the user's call on 16 Nov: today's map keeps its
  // old kerbs, which these rules were never written for.)
  if (!globalThis.__osm.oneLine) return { samples: 0, bad: 0, worst: [], unit: 'm' };
  const F = window.__finishIndex();
  const at = window.__flatIndex(['kerb']);
  const pts = [];
  let n = 0;
  // (Every sheet by the 2 m squares its ground line crosses.)
  const SG = new Map();
  F.sheets.forEach((s, i) => {
    for (let a = Math.floor(Math.min(s.x0, s.x1) / 2); a <= Math.floor(Math.max(s.x0, s.x1) / 2); a++)
      for (let b = Math.floor(Math.min(s.z0, s.z1) / 2); b <= Math.floor(Math.max(s.z0, s.z1) / 2); b++) (SG.get(a * 100003 + b) ?? SG.set(a * 100003 + b, []).get(a * 100003 + b)).push(i);
  });
  /** The lowest bottom and highest top of every sheet standing within 1 cm of (x, z). */
  const spanAt = (x, z) => {
    let lo = Infinity, hi = -Infinity;
    for (const i of SG.get(Math.floor(x / 2) * 100003 + Math.floor(z / 2)) ?? []) {
      const s = F.sheets[i];
      const dx = s.x1 - s.x0, dz = s.z1 - s.z0, L2 = dx * dx + dz * dz;
      const f = ((x - s.x0) * dx + (z - s.z0) * dz) / L2;
      if (f < -1e-3 || f > 1 + 1e-3 || Math.hypot(x - s.x0 - dx * f, z - s.z0 - dz * f) > 0.01) continue;
      const sp = window.__sheetSpan(s, Math.max(0, Math.min(1, f)));
      if (sp) (lo = Math.min(lo, sp[0])), (hi = Math.max(hi, sp[1]));
    }
    return lo < hi ? [lo, hi] : null;
  };
  for (const s of F.sheets) {
    const L = Math.hypot(s.x1 - s.x0, s.z1 - s.z0);
    const nx = (s.z1 - s.z0) / L, nz = -(s.x1 - s.x0) / L;
    for (let u = 0.25; u < L; u += 0.5) {
      const x = s.x0 + ((s.x1 - s.x0) * u) / L, z = s.z0 + ((s.z1 - s.z0) * u) / L;
      // (The upright's own bottom and top there, every sheet standing on
      // that spot taken together, not one triangle's corners' lowest and
      // highest: a sloping wall's triangle reaches its top only at one end,
      // and read by its corners it stood lower than the kerb beside it all
      // along. The user's call on 17 Nov.)
      const sp = spanAt(x, z);
      if (!sp) continue;
      const [lo, hi] = sp;
      // (Nearest kerb either side, at a height the sheet stands up past by
      // more than a centimetre: a deck's edge beam level with the deck
      // below it stands up past nothing.)
      const reach = (sg) => {
        for (let o = 0; o <= 0.6; o += 0.01) if (at(x + nx * sg * o, z + nz * sg * o).some((f) => f.h >= lo - 0.05 && f.h <= hi - 0.01)) return o;
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
        for (let o = 0; o <= OUT + 1e-9; o += 0.01) if (at(x + nx * sg * o, z + nz * sg * o).some((f) => f.h > hi - 0.01 && f.h <= hi + 0.05)) return true;
        return false;
      });
      const seen = uprightSeen(x, z);
      if (r > OUT && !flush && !seen) pts.push({ x: +x.toFixed(2), z: +z.toFixed(2), out: +r.toFixed(2), value: +r.toFixed(2), lo: +lo.toFixed(2), hi: +hi.toFixed(2) });
    }
  }
  const bad = F.places(pts, 2);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: 'm' };
};

// Feedback 9, rule 2 (2026-11-16): an island is never lower than the road
// beside it. Along every kerb: its top stands 3 cm (2 at least) over the
// road it overlaps at its inner edge; and where paving lies again within
// 12 m out past it (an island between two roads, not a verge), the island's
// top just past the kerb's outer edge is level with the kerb's top (within
// 2 cm: between two kerbs at different heights it slopes from one to the
// other). Kerbs on a deck or over a drop (the ground beside them above
// their top, or more than 1 m under it) are the walls' business, not an
// island's; nor is a path across the island, or within 40 cm (it lies on
// the ground, and the island's top stops short of it).
window.__checkIslandTops = (all = false) => {
  const d = globalThis.__osm;
  if (!d.oneLine) return { samples: 0, bad: 0, worst: [], unit: 'm' };
  const C = 2;
  const S = { road: __triRefs(), lawn: __triRefs(), kerb: __triRefs(), path: __triRefs(), deck: __triRefs() };
  const grid = { road: new Map(), lawn: new Map(), kerb: new Map(), path: new Map(), deck: new Map() };
  const kerbs = [];
  window.__eachMesh(['road', 'deck', 'lawn', 'kerb', 'foot', 'cycle'], (k, kind, pos, idx) => {
    for (let q = 0; q < idx.length; q += 3) {
      const t = [];
      for (let c = 0; c < 3; c++) t.push(pos[idx[q + c] * 3], pos[idx[q + c] * 3 + 1], pos[idx[q + c] * 3 + 2]);
      const det = (t[5] - t[8]) * (t[0] - t[6]) + (t[6] - t[3]) * (t[2] - t[8]);
      if (Math.abs(det) < 1e-6) continue;
      if (kind === 'kerb') kerbs.push(t);
      // (A deck's own faces too, apart: a kerb with a deck's underside under it is on a deck.)
      if (kind === 'deck') {
        const n = S.deck.add(pos, idx, q);
        const x0 = Math.floor(Math.min(t[0], t[3], t[6]) / C), x1 = Math.floor(Math.max(t[0], t[3], t[6]) / C);
        const z0 = Math.floor(Math.min(t[2], t[5], t[8]) / C), z1 = Math.floor(Math.max(t[2], t[5], t[8]) / C);
        if ((x1 - x0 + 1) * (z1 - z0 + 1) <= 400)
          for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) (grid.deck.get(i * 100003 + j) ?? grid.deck.set(i * 100003 + j, []).get(i * 100003 + j)).push(n);
      }
      const into = kind === 'lawn' || kind === 'kerb' ? kind : kind === 'foot' || kind === 'cycle' ? 'path' : 'road';
      const n = S[into].add(pos, idx, q);
      const x0 = Math.floor(Math.min(t[0], t[3], t[6]) / C), x1 = Math.floor(Math.max(t[0], t[3], t[6]) / C);
      const z0 = Math.floor(Math.min(t[2], t[5], t[8]) / C), z1 = Math.floor(Math.max(t[2], t[5], t[8]) / C);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 400) continue;
      for (let i = x0; i <= x1; i++)
        for (let j = z0; j <= z1; j++) (grid[into].get(i * 100003 + j) ?? grid[into].set(i * 100003 + j, []).get(i * 100003 + j)).push(n);
    }
  });
  /** The highest surface of a kind at (x, z) within 0.5 m of y, or -Infinity. */
  const top = (kind, x, z, y, within = 0.5) => {
    let best = -Infinity;
    for (const q of grid[kind].get(Math.floor(x / C) * 100003 + Math.floor(z / C)) ?? []) {
      const t = S[kind].get(q);
      const d0 = (t[5] - t[8]) * (t[0] - t[6]) + (t[6] - t[3]) * (t[2] - t[8]);
      const l1 = ((t[5] - t[8]) * (x - t[6]) + (t[6] - t[3]) * (z - t[8])) / d0;
      const l2 = ((t[8] - t[2]) * (x - t[6]) + (t[0] - t[6]) * (z - t[8])) / d0;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const h = l1 * t[1] + l2 * t[4] + l3 * t[7];
      if (Math.abs(h - y) < within && h > best) best = h;
    }
    return best;
  };
  const bad = [];
  let n = 0;
  for (const t of kerbs) {
    // (A kerb is drawn as quads across it, each two triangles: of a
    // triangle's sides the longest is the quad's diagonal, one of the other
    // two runs along the kerb and one across it, 0.38 m or a little more at
    // a bend. Where both could be the one across, it is not asked.)
    const sides = [[0, 3], [3, 6], [6, 0]].map(([a, b]) => ({ a, b, l: Math.hypot(t[b] - t[a], t[b + 2] - t[a + 2]) })).sort((p, q) => p.l - q.l);
    const across = (e) => e.l > 0.37 && e.l < 0.6;
    if (across(sides[0]) === across(sides[1])) continue;
    const al = across(sides[0]) ? sides[1] : sides[0];
    const ux = (t[al.b] - t[al.a]) / al.l, uz = (t[al.b + 2] - t[al.a + 2]) / al.l;
    const cx = (t[0] + t[3] + t[6]) / 3, cy = (t[1] + t[4] + t[7]) / 3, cz = (t[2] + t[5] + t[8]) / 3;
    // (The kerb is 0.38 m wide, its inner 3 cm over the road's edge.)
    const side = [1, -1].find((s) => top('road', cx - uz * s * 0.3, cz + ux * s * 0.3, cy) > -Infinity);
    if (side === undefined) continue;
    const nx = -uz * side, nz = ux * side;
    n++;
    // (Its inner and outer edges, across from its middle.)
    const pv = [0, 3, 6].map((a) => (t[a] - cx) * nx + (t[a + 2] - cz) * nz);
    const pin = Math.max(...pv), pout = Math.min(...pv);
    if (pin - pout < 0.3) continue;
    // (Its top over the road it overlaps, in its inner 3 cm.)
    let worst = 0, what = '';
    {
      const o = pin - 0.015;
      const r = top('road', cx + nx * o, cz + nz * o, cy);
      if (r > -Infinity && r - (cy - 0.02) > worst) (worst = r - (cy - 0.02)), (what = `road ${(r - cy).toFixed(3)} over the kerb's top`);
    }
    // (An island past it: paving again within 12 m out.)
    const gx = cx + nx * (pout - 0.1), gz = cz + nz * (pout - 0.1);
    const g = d.heightAt(gx, gz);
    // (Not where a path crosses the island: it lies on the ground.)
    const path = [[0, 0], [0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4]].some(([ex, ez]) => top('path', gx + ex, gz + ez, g, 1) > -Infinity);
    if (g <= cy && g > cy - 1 && !path && top('deck', cx, cz, cy - 1.25, 1.2) === -Infinity) {
      let island = false;
      for (let s = 0.8; s <= 11.8 && !island; s += 0.5) island = top('road', cx - nx * s, cz - nz * s, cy, 1) > -Infinity;
      if (island) {
        // (Its top, or a kerb's: where two kerbs meet across a narrow island,
        // or at a bend. Within 15 cm: round a small island's point the place
        // just past the kerb can fall on the hairline where the tops from
        // two sides meet.)
        let l = -Infinity;
        for (const [ex, ez] of [[0, 0], [0.15, 0], [-0.15, 0], [0, 0.15], [0, -0.15]]) {
          const h = Math.max(top('lawn', gx + ex, gz + ez, cy), top('road', gx + ex, gz + ez, cy), top('kerb', gx + ex, gz + ez, cy));
          if (h > -Infinity && (l === -Infinity || Math.abs(cy - h) < Math.abs(cy - l))) l = h;
        }
        const low = l === -Infinity ? cy - g : cy - l - 0.02;
        if (low > worst) (worst = low), (what = l === -Infinity ? `island at the ground, ${(cy - g).toFixed(2)} m under the kerb's top` : `island top ${(cy - l).toFixed(3)} under the kerb's top`);
      }
    }
    if (worst > 0) bad.push({ x: +cx.toFixed(1), z: +cz.toFixed(1), value: +worst.toFixed(3), what });
  }
  const pl = window.__finishIndex().places(bad, 4);
  return { samples: n, bad: pl.length, worst: all ? pl : pl.slice(0, 40), unit: 'm' };
};

// The reviewer's and feedback thread's rule, 20 Nov: an island whose two
// kerbs stand at one level (within 5 cm) is one flat lawn from kerb to
// kerb, as it was before the slip-road rules: no fold, no crease, no
// trench, no hole. Read off the finished meshes: from every kerb, straight
// across its island to the kerb on the far side (up to 6 m), every 0.2 m
// there is lawn facing up within 3 cm of the two kerbs' tops (or a kerb).
// Folded, the lawn faced down or dipped to the ground at -417.1,-101.7; a
// hole by an island's point showed the ground and a kerb's side through it
// at -2118.7,3152.7.
const levelIslands = (all, holes) => {
  const d = globalThis.__osm;
  if (!d.oneLine) return { samples: 0, bad: 0, worst: [], unit: 'm' };
  const C = 2;
  const S = { road: __triRefs(), lawn: __triRefs(), kerb: __triRefs(), path: __triRefs(), deck: __triRefs() };
  const grid = { road: new Map(), lawn: new Map(), kerb: new Map(), path: new Map(), deck: new Map() };
  const kerbs = [];
  window.__eachMesh(['road', 'deck', 'lawn', 'kerb', 'foot', 'cycle'], (k, kind, pos, idx) => {
    for (let q = 0; q < idx.length; q += 3) {
      const t = [];
      for (let c = 0; c < 3; c++) t.push(pos[idx[q + c] * 3], pos[idx[q + c] * 3 + 1], pos[idx[q + c] * 3 + 2]);
      const det = (t[5] - t[8]) * (t[0] - t[6]) + (t[6] - t[3]) * (t[2] - t[8]);
      if (Math.abs(det) < 1e-6) continue;
      // (Which way it faces: up, or folded over and facing down.)
      const ny = (t[5] - t[2]) * (t[6] - t[0]) - (t[3] - t[0]) * (t[8] - t[2]);
      t.push(ny > 0 ? 1 : -1);
      if (kind === 'kerb') kerbs.push(t);
      const into = kind === 'lawn' || kind === 'kerb' || kind === 'deck' ? kind : kind === 'foot' || kind === 'cycle' ? 'path' : 'road';
      const n = S[into].add(pos, idx, q);
      const x0 = Math.floor(Math.min(t[0], t[3], t[6]) / C), x1 = Math.floor(Math.max(t[0], t[3], t[6]) / C);
      const z0 = Math.floor(Math.min(t[2], t[5], t[8]) / C), z1 = Math.floor(Math.max(t[2], t[5], t[8]) / C);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 400) continue;
      for (let i = x0; i <= x1; i++)
        for (let j = z0; j <= z1; j++) (grid[into].get(i * 100003 + j) ?? grid[into].set(i * 100003 + j, []).get(i * 100003 + j)).push(n);
    }
  });
  /** The surfaces of a kind at (x, z) within `within` of y: [height, facing]. */
  const tops = (kind, x, z, y, within = 0.5) => {
    const r = [];
    for (const q of grid[kind].get(Math.floor(x / C) * 100003 + Math.floor(z / C)) ?? []) {
      const t = S[kind].get(q);
      const d0 = (t[5] - t[8]) * (t[0] - t[6]) + (t[6] - t[3]) * (t[2] - t[8]);
      const l1 = ((t[5] - t[8]) * (x - t[6]) + (t[6] - t[3]) * (z - t[8])) / d0;
      const l2 = ((t[8] - t[2]) * (x - t[6]) + (t[0] - t[6]) * (z - t[8])) / d0;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const h = l1 * t[1] + l2 * t[4] + l3 * t[7];
      if (Math.abs(h - y) < within) r.push([h, t[9]]);
    }
    return r;
  };
  const top = (kind, x, z, y, within) => tops(kind, x, z, y, within).reduce((b, [h]) => Math.max(b, h), -Infinity);
  const bad = [];
  let n = 0;
  for (const t of kerbs) {
    // (Its along and across, and the road's side, as __checkIslandTops reads them.)
    const sides = [[0, 3], [3, 6], [6, 0]].map(([a, b]) => ({ a, b, l: Math.hypot(t[b] - t[a], t[b + 2] - t[a + 2]) })).sort((p, q) => p.l - q.l);
    const across = (e) => e.l > 0.37 && e.l < 0.6;
    if (across(sides[0]) === across(sides[1])) continue;
    const al = across(sides[0]) ? sides[1] : sides[0];
    const ux = (t[al.b] - t[al.a]) / al.l, uz = (t[al.b + 2] - t[al.a + 2]) / al.l;
    const cx = (t[0] + t[3] + t[6]) / 3, cy = (t[1] + t[4] + t[7]) / 3, cz = (t[2] + t[5] + t[8]) / 3;
    const side = [1, -1].find((s) => top('road', cx - uz * s * 0.3, cz + ux * s * 0.3, cy) > -Infinity);
    if (side === undefined) continue;
    const nx = -uz * side, nz = ux * side;
    const pv = [0, 3, 6].map((a) => (t[a] - cx) * nx + (t[a + 2] - cz) * nz);
    const pout = Math.min(...pv);
    if (Math.max(...pv) - pout < 0.3) continue;
    // (Not on a deck, nor beside a raised road's own wall.)
    if (top('deck', cx, cz, cy - 1.25, 1.2) > -Infinity) continue;
    // (Across to the far kerb: past its own kerb's outer edge, the first
    // kerb at its level within 6 m, no road or path between.)
    const at = (s) => [cx + nx * (pout - s), cz + nz * (pout - s)];
    let far = NaN, fs = 0, cross = false;
    for (let s = 0.1; s <= 6 && !(far === far) && !cross; s += 0.1) {
      const [x, z] = at(s);
      if (top('road', x, z, cy, 1) > -Infinity || top('path', x, z, cy, 3) > -Infinity) cross = true;
      else {
        const k = top('kerb', x, z, cy, 0.5);
        if (k > -Infinity && s > 0.2) (far = k), (fs = s);
      }
    }
    if (cross || !(far === far) || Math.abs(far - cy) > 0.05) continue;
    n++;
    const lo = Math.min(cy, far) - 0.03, hi = Math.max(cy, far) + 0.03;
    let worst = 0, what = '', wx = cx, wz = cz;
    for (let s = 0.1; s < fs; s += 0.2) {
      const [x, z] = at(s);
      if (top('kerb', x, z, cy, 0.1) > -Infinity) continue;
      const ls = tops('lawn', x, z, cy, 1.5);
      const up = ls.filter(([, f]) => f > 0).map(([h]) => h);
      let v = 0, w = '';
      if (!up.length) (v = 1), (w = ls.length ? 'lawn folded over, facing down' : 'a hole in the lawn');
      else {
        const h = Math.max(...up);
        if (h < lo) (v = lo - h), (w = `lawn ${(cy - h).toFixed(3)} under the kerbs' tops`);
        else if (h > hi) (v = h - hi), (w = `lawn ${(h - cy).toFixed(3)} over the kerbs' tops`);
      }
      if (!w.startsWith('a hole') === holes) continue;
      if (v > worst) (worst = v), (what = w), (wx = x), (wz = z);
    }
    if (worst > 0) bad.push({ x: +wx.toFixed(1), z: +wz.toFixed(1), value: +worst.toFixed(3), what });
  }
  const pl = window.__finishIndex().places(bad, 4);
  return { samples: n, bad: pl.length, worst: all ? pl : pl.slice(0, 40), unit: 'm' };
};

window.__checkLevelIslands = (all = false) => levelIslands(all, false);
// (Its holes apart: hundreds on main, round islands' points where the
// sections across cut each other short, mostly hidden by the ground's own
// grass a hand's width under. A count that may only go down.)
window.__checkLevelIslandHoles = (all = false) => levelIslands(all, true);

// (The reviewer's rule, 21 Nov: an island's grass stays inside its kerbs.
// Two blades of lawn 2 m long fanned out over the road from an island's
// point at -438.6,-1826.1, the sections round the point left uncut.)
// Every lawn triangle facing up, each corner taken 5 cm in towards its
// middle and the middle itself: no road's paving there at the lawn's own
// height or up to 0.6 m under it.
window.__checkLawnInIsland = (all = false) => {
  const C = 2;
  const R = [];
  const grid = new Map();
  window.__eachMesh(['road', 'deck'], (_k, _kind, pos, idx) => {
    for (let q = 0; q < idx.length; q += 3) {
      const t = [];
      for (let c = 0; c < 3; c++) t.push(pos[idx[q + c] * 3], pos[idx[q + c] * 3 + 1], pos[idx[q + c] * 3 + 2]);
      const det = (t[5] - t[8]) * (t[0] - t[6]) + (t[6] - t[3]) * (t[2] - t[8]);
      if (Math.abs(det) < 1e-6) continue;
      const x0 = Math.floor(Math.min(t[0], t[3], t[6]) / C), x1 = Math.floor(Math.max(t[0], t[3], t[6]) / C);
      const z0 = Math.floor(Math.min(t[2], t[5], t[8]) / C), z1 = Math.floor(Math.max(t[2], t[5], t[8]) / C);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 400) continue;
      const n = R.length;
      R.push(t);
      for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) (grid.get(i * 100003 + j) ?? grid.set(i * 100003 + j, []).get(i * 100003 + j)).push(n);
    }
  });
  const paved = (x, z, y) => {
    for (const q of grid.get(Math.floor(x / C) * 100003 + Math.floor(z / C)) ?? []) {
      const t = R[q];
      const d0 = (t[5] - t[8]) * (t[0] - t[6]) + (t[6] - t[3]) * (t[2] - t[8]);
      const l1 = ((t[5] - t[8]) * (x - t[6]) + (t[6] - t[3]) * (z - t[8])) / d0;
      const l2 = ((t[8] - t[2]) * (x - t[6]) + (t[0] - t[6]) * (z - t[8])) / d0;
      if (l1 < -1e-6 || l2 < -1e-6 || 1 - l1 - l2 < -1e-6) continue;
      const h = l1 * t[1] + l2 * t[4] + (1 - l1 - l2) * t[7];
      if (h <= y + 0.05 && h >= y - 0.6) return true;
    }
    return false;
  };
  const pts = [];
  let n = 0;
  window.__eachMesh(['lawn'], (_k, _kind, pos, idx) => {
    for (let q = 0; q < idx.length; q += 3) {
      const t = [];
      for (let c = 0; c < 3; c++) t.push(pos[idx[q + c] * 3], pos[idx[q + c] * 3 + 1], pos[idx[q + c] * 3 + 2]);
      const ny = (t[5] - t[2]) * (t[6] - t[0]) - (t[3] - t[0]) * (t[8] - t[2]);
      const area = Math.abs((t[3] - t[0]) * (t[8] - t[2]) - (t[5] - t[2]) * (t[6] - t[0])) / 2;
      if (ny <= 0 || area < 1e-4) continue;
      n++;
      const cx = (t[0] + t[3] + t[6]) / 3, cy = (t[1] + t[4] + t[7]) / 3, cz = (t[2] + t[5] + t[8]) / 3;
      const S = [[cx, cy, cz]];
      for (let c = 0; c < 9; c += 3) {
        const l = Math.hypot(cx - t[c], cz - t[c + 2]);
        if (l < 0.1) continue;
        const f = 0.05 / l;
        const x = t[c] + (cx - t[c]) * f, z = t[c + 2] + (cz - t[c + 2]) * f;
        // (Not where that is still within 2 cm of the piece's own side, a
        // sliver's: 5 cm along to its middle, it was a centimetre off the
        // lawn's edge, where the lawn meets a deck level with it and the two
        // edges lie a centimetre apart, 1827,1926.9.)
        let edge = Infinity;
        for (let e = 0; e < 9; e += 3) {
          const ax = t[e], az = t[e + 2], bx = t[(e + 3) % 9], bz = t[(e + 5) % 9], L = Math.hypot(bx - ax, bz - az);
          if (L > 1e-9) edge = Math.min(edge, Math.abs((bx - ax) * (z - az) - (bz - az) * (x - ax)) / L);
        }
        if (edge < 0.02) continue;
        S.push([x, t[c + 1] + (cy - t[c + 1]) * f, z]);
      }
      for (const [x, y, z] of S)
        if (paved(x, z, y)) {
          pts.push({ x: +x.toFixed(1), z: +z.toFixed(1), y: +y.toFixed(2), value: 1 });
          break;
        }
    }
  });
  const bad = window.__finishIndex().places(pts, 2);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: '' };
};

// The island lawn, one sheet (the user's pick, 22 Nov: "One-sheet lawn in
// PR 74", in place of stretches laid by two builders, which met in seams
// and creases: K3 at -114.8,-31.9, c1, L2, F4, k1, k4 in round 4, all
// flat on main). Its seams now can only be where one tile's part meets the
// next's: every open edge of a tile's lawn on the tile's own border must
// meet the next tile's lawn there, at the same height (a tile reading the
// kerbs differently would leave a step or a slot).
const lawnTris = (k, key = 'lawn') => {
  const r = globalThis.__osm.tileAccs(k)[key];
  if (!r) return [];
  const { pos, idx } = r, T = [];
  for (let q = 0; q < idx.length; q += 3) T.push([idx[q], idx[q + 1], idx[q + 2]].map((v) => [pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]]));
  return T;
};
const mmKey = (p) => `${Math.round(p[0] * 1000)},${Math.round(p[2] * 1000)}`;
window.__checkLawnSeams = (all = false) => {
  const d = globalThis.__osm;
  const pts = [];
  const TILE = 200;
  const tiles = new Set(d.farTiles());
  // Each tile's lawn triangles, by 1 m square, to find the one over a point.
  const idx = new Map();
  // (Only those by the tile's border: the whole map's at once ran the
  // browser out of memory.)
  const index = (k, key = 'lawn') => {
    const ik = k + '|' + key;
    if (idx.has(ik)) return idx.get(ik);
    const [ti, tj] = k.split(',').map(Number);
    const by = (v) => Math.min(v[0] - ti * TILE, (ti + 1) * TILE - v[0], v[2] - tj * TILE, (tj + 1) * TILE - v[2]) < 1.5;
    const T = lawnTris(k, key).filter((t) => t.some(by)), g = new Map();
    T.forEach((t, i) => {
      const xs = t.map((v) => v[0]), zs = t.map((v) => v[2]);
      for (let a = Math.floor(Math.min(...xs)); a <= Math.floor(Math.max(...xs)); a++)
        for (let b = Math.floor(Math.min(...zs)); b <= Math.floor(Math.max(...zs)); b++) (g.get(a * 100003 + b) ?? g.set(a * 100003 + b, []).get(a * 100003 + b)).push(i);
    });
    const r = { T, g };
    idx.set(ik, r);
    return r;
  };
  // (The nearest to height y of those over the point: two levels' lawns
  // may lie one over the other, 20 cm apart at 1800,1460.4, each whole
  // across the border.)
  const yAt = (k, x, z, y, key = 'lawn') => {
    const { T, g } = index(k, key);
    let best = NaN;
    for (const i of g.get(Math.floor(x) * 100003 + Math.floor(z)) ?? []) {
      const [[x1, y1, z1], [x2, y2, z2], [x3, y3, z3]] = T[i];
      const det = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3);
      if (Math.abs(det) < 1e-12) continue;
      const l1 = ((z2 - z3) * (x - x3) + (x3 - x2) * (z - z3)) / det, l2 = ((z3 - z1) * (x - x3) + (x1 - x3) * (z - z3)) / det, l3 = 1 - l1 - l2;
      if (l1 >= -1e-4 && l2 >= -1e-4 && l3 >= -1e-4) {
        const v = l1 * y1 + l2 * y2 + l3 * y3;
        if (!(Math.abs(v - y) >= Math.abs(best - y))) best = v;
      }
    }
    return best;
  };
  let n = 0;
  for (const k of tiles) {
    const [ti, tj] = k.split(',').map(Number);
    const { T } = index(k);
    const use = new Map();
    for (const t of T)
      for (let e = 0; e < 3; e++) {
        const a = t[e], b = t[(e + 1) % 3];
        const key = [mmKey(a), mmKey(b)].sort().join('|');
        const u = use.get(key);
        if (u) u.n++;
        else use.set(key, { n: 1, a, b });
      }
    for (const { n: c, a, b } of use.values()) {
      if (c !== 1) continue;
      // (On the tile's own border: its middle, 2 mm over into the next
      // tile, must have that tile's lawn under it at the same height. At 2
      // cm, where the lawn's edge crossed the border at a slant, 7 to 19
      // degrees, the point 2 cm over was off the lawn in both tiles alike,
      // 1660.1,2200. On the border to half a millimetre, the clipper's
      // own fineness: a kerb's edge a millimetre inside it is the lawn's
      // own end, no border, 140.2,1200.)
      let ox = 0, oz = 0;
      if (Math.abs(a[0] - ti * TILE) < 0.0005 && Math.abs(b[0] - ti * TILE) < 0.0005) ox = -0.002;
      else if (Math.abs(a[0] - (ti + 1) * TILE) < 0.0005 && Math.abs(b[0] - (ti + 1) * TILE) < 0.0005) ox = 0.002;
      else if (Math.abs(a[2] - tj * TILE) < 0.0005 && Math.abs(b[2] - tj * TILE) < 0.0005) oz = -0.002;
      else if (Math.abs(a[2] - (tj + 1) * TILE) < 0.0005 && Math.abs(b[2] - (tj + 1) * TILE) < 0.0005) oz = 0.002;
      else continue;
      if (Math.hypot(b[0] - a[0], b[2] - a[2]) < 0.05) continue;
      const nk = `${ti + Math.sign(ox)},${tj + Math.sign(oz)}`;
      if (!tiles.has(nk)) continue;
      n++;
      const mx = (a[0] + b[0]) / 2, mz = (a[2] + b[2]) / 2, my = (a[1] + b[1]) / 2;
      const y = yAt(nk, mx + ox, mz + oz, my);
      // (None beyond, but a kerb's top there at about the lawn's height:
      // the lawn meets the kerb at the border, its edge and the border one
      // to the millimetre, 140.7,1200.)
      if (y !== y && Math.abs(yAt(nk, mx + ox, mz + oz, my, 'kerb') - my) < 0.3) continue;
      if (y !== y) pts.push({ x: +mx.toFixed(1), z: +mz.toFixed(1), value: 1, what: 'lawn ends at the tile border, none beyond' });
      else if (Math.abs(y - my) > 0.02) pts.push({ x: +mx.toFixed(1), z: +mz.toFixed(1), value: +Math.abs(y - my).toFixed(3), what: 'lawn steps at the tile border' });
    }
  }
  const bad = window.__finishIndex().places(pts, 2);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: 'm' };
};

// Its folds: no two lawn triangles side by side meet at a crease sharper
// than 30 degrees (a 1 in 2 bank meets level lawn at 27), and none stands
// steeper than 40 degrees (a lawn is never steeper than 1 in 2; its walls
// are kerb sides, not lawn). (The round 3b feedback: folds, slits and
// panels in one-level islands, E1 -2123.9,3149.9 and F3, F4, T2, k4; a
// shard of grass 2 m tall at 1416,653 in the sheet's first try.) Slivers
// under 50 cm square are left out: too small to see, and their slope is
// any three nearby heights'.
window.__checkLawnFolds = (all = false) => {
  const d = globalThis.__osm;
  const pts = [];
  let n = 0;
  const nrm = (t) => {
    const [a, b, c] = t;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const l = Math.hypot(x, y, z);
    if (y < 0) (x = -x), (y = -y), (z = -z);
    return { n: [x / l, y / l, z / l], area: l / 2 };
  };
  for (const k of d.farTiles()) {
    const T = lawnTris(k);
    const N = T.map(nrm);
    const use = new Map();
    T.forEach((t, i) => {
      if (N[i].area < 0.005) return;
      n++;
      const steep = (Math.acos(Math.min(1, N[i].n[1])) * 180) / Math.PI;
      const mx = (t[0][0] + t[1][0] + t[2][0]) / 3, mz = (t[0][2] + t[1][2] + t[2][2]) / 3;
      if (steep > 40) pts.push({ x: +mx.toFixed(1), z: +mz.toFixed(1), value: +steep.toFixed(0), what: `lawn ${steep.toFixed(0)} deg steep` });
      for (let e = 0; e < 3; e++) {
        const key = [mmKey(t[e]), mmKey(t[(e + 1) % 3])].sort().join('|');
        const j = use.get(key);
        if (j === undefined) {
          use.set(key, i);
          continue;
        }
        const a = N[i].n, b = N[j].n;
        const ang = (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
        if (ang > 30) {
          const p = t[e], q = t[(e + 1) % 3];
          pts.push({ x: +((p[0] + q[0]) / 2).toFixed(1), z: +((p[2] + q[2]) / 2).toFixed(1), value: +ang.toFixed(0), what: `lawn creased ${ang.toFixed(0)} deg` });
        }
      }
    });
  }
  const bad = window.__finishIndex().places(pts, 2);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: 'deg' };
};

// The user's rule (18 Nov): a bridge's parapets and walls begin where the
// ground actually drops, never on an island at the junction. Every upright
// sheet standing on a road's level (a parapet, its foot over the ground)
// and over 0.5 m tall has a fall of at least 0.45 m beside it: the ground
// 0.6 or 1.6 m out from it, either side, that far under the road. (Elias
// Road's two little bridges over a drain: a full parapet round the island
// at the junction where they leave the ground, 1 m tall over no drop.)
window.__checkParapetDrop = (all = false) => {
  const d = globalThis.__osm;
  const F = window.__finishIndex();
  const bad = [];
  let n = 0;
  for (const s of F.sheets) {
    if (s.hi - s.lo < 0.5) continue;
    const l = Math.hypot(s.x1 - s.x0, s.z1 - s.z0) || 1;
    const nx = -(s.z1 - s.z0) / l, nz = (s.x1 - s.x0) / l;
    // (Measured at each upright edge of the sheet, where it stands as tall
    // as it is: a parapet's piece rises along its length from where the
    // ground begins to fall away, so its middle is no measure.)
    const cols = [];
    for (const [x, y, z] of s.c) {
      const c = cols.find((q) => Math.hypot(q.x - x, q.z - z) < 0.02);
      if (c) (c.lo = Math.min(c.lo, y)), (c.hi = Math.max(c.hi, y));
      else cols.push({ x, z, lo: y, hi: y });
    }
    for (const c of cols) {
      if (c.hi - c.lo < 0.5) continue;
      const g = (o) => d.heightAt(c.x + nx * o, c.z + nz * o);
      // (Its foot up off the ground, on a road's level beside it: a parapet,
      // not a wall down into the ground or a beam under a deck.)
      if (c.lo < Math.min(g(0), g(0.3), g(-0.3)) + 0.05) continue;
      const road = c.lo - 0.09;
      let beside = false;
      for (const o of [-0.6, -0.3, 0.3, 0.6])
        if (F.flatAt(c.x + nx * o, c.z + nz * o).some((q) => Math.abs(q.h - road) < 0.15)) beside = true;
      if (!beside) continue;
      n++;
      const drop = road - Math.min(g(0.6), g(1.6), g(-0.6), g(-1.6));
      if (drop < 0.45) bad.push({ x: +c.x.toFixed(1), z: +c.z.toFixed(1), value: +(c.hi - c.lo).toFixed(2), what: `parapet ${(c.hi - c.lo).toFixed(2)} m tall over a fall of ${drop.toFixed(2)} m` });
    }
  }
  const pl = F.places(bad, 2);
  return { samples: n, bad: pl.length, worst: all ? pl : pl.slice(0, 40), unit: 'm' };
};
