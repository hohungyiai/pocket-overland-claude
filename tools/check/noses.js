// Island ends (the noses of splits), the user's rule N with the nose fix
// (27 Nov, plan "Lawn beside ramps and noses"), read off what is built:
//
// __checkNoseEnds: every end of a split's paved wedge, where an island
//   begins between the two roads, has its rounded nose, or is handed to
//   what carries on there (a road, the next wedge, paving, a paved island,
//   a junction), or is too narrow for one (under 0.3 m: the kerb itself is
//   the end). The builder says why for each end; any other reason fails.
// __checkNoseKerbFaces: within 6 m of a nose, no face in the kerb's side
//   stands taller than a kerb (0.25 m) over the road or ground at its foot:
//   a bigger drop is a wall's.
// __checkNoseSteps: within 6 m of a nose, across the island's top, no step
//   over 2 cm (past the lawn's own 1 in 2 fall) between neighbouring points
//   5 cm apart on the same surface, kerb or lawn: no crease where two kerb
//   tops meet, no fold or tear in the grass.

window.__noseList = () => {
  if (window.__noseL) return window.__noseL;
  const d = globalThis.__osm;
  const out = [];
  d.gores.forEach((g, id) => {
    for (const c of d.goreCaps(id)) out.push({ id, C: c.C, d: c.d, y: (c.ya + c.yb) / 2 });
  });
  return (window.__noseL = out);
};

window.__checkNoseEnds = () => {
  const d = globalThis.__osm;
  if (!d.oneLine) return { samples: 0, bad: 0, worst: [], unit: 'ends' };
  const HANDED = new Set(['narrow', 'road', 'wedge', 'paving', 'island', 'junction']);
  const ends = d.goreEnds();
  const counts = {};
  const bad = [];
  for (const e of ends) {
    const why = e.why ?? 'none';
    counts[why] = (counts[why] ?? 0) + 1;
    if (why.startsWith('capped') || HANDED.has(why)) continue;
    bad.push({ x: +(e.x ?? 0).toFixed(1), z: +(e.z ?? 0).toFixed(1), gore: e.id, end: e.e, why, w: +(e.w ?? 0).toFixed(2), over: 1 });
  }
  return { samples: ends.length, bad: bad.length, worst: bad, unit: 'ends', note: Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') };
};

// The built meshes of the tiles about the noses: { tile key: accs }.
window.__noseAccs = () => {
  if (window.__noseA) return window.__noseA;
  const d = globalThis.__osm;
  const keys = new Set();
  for (const n of window.__noseList())
    for (const dx of [-7, 7]) for (const dz of [-7, 7]) keys.add(`${Math.floor((n.C[0] + dx) / 200)},${Math.floor((n.C[1] + dz) / 200)}`);
  const far = new Set(d.farTiles());
  const out = new Map();
  for (const k of keys) if (far.has(k)) out.set(k, d.tileAccs(k));
  return (window.__noseA = out);
};

// The top surfaces (kerb, lawn, road) about the noses, indexed on a 1 m
// grid: topAt(x, z, below) is the highest under `below`, [kind, height].
const NOSE_KINDS = ['kerb', 'lawn', 'road'];
window.__noseTops = () => {
  if (window.__noseT) return window.__noseT;
  const tris = [];
  const grid = new Map();
  for (const accs of window.__noseAccs().values())
    NOSE_KINDS.forEach((kind, ki) => {
      const r = accs[kind];
      if (!r) return;
      const { pos, idx } = r;
      for (let q = 0; q < idx.length; q += 3) {
        const a = idx[q] * 3, b = idx[q + 1] * 3, c = idx[q + 2] * 3;
        const det = (pos[b + 2] - pos[c + 2]) * (pos[a] - pos[c]) + (pos[c] - pos[b]) * (pos[a + 2] - pos[c + 2]);
        if (Math.abs(det) < 1e-6) continue;
        const t = tris.length;
        tris.push([pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2], pos[c], pos[c + 1], pos[c + 2], ki, det]);
        for (let i = Math.floor(Math.min(pos[a], pos[b], pos[c])); i <= Math.floor(Math.max(pos[a], pos[b], pos[c])); i++)
          for (let j = Math.floor(Math.min(pos[a + 2], pos[b + 2], pos[c + 2])); j <= Math.floor(Math.max(pos[a + 2], pos[b + 2], pos[c + 2])); j++) (grid.get(i * 100003 + j) ?? grid.set(i * 100003 + j, []).get(i * 100003 + j)).push(t);
      }
    });
  const topAt = (x, z, below) => {
    let best = -Infinity, kind = -1;
    for (const t of grid.get(Math.floor(x) * 100003 + Math.floor(z)) ?? []) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz, ki, det] = tris[t];
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det, l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const h = l1 * ay + l2 * by + l3 * cy;
      if (h < below && h > best) (best = h), (kind = ki);
    }
    return [kind, best];
  };
  return (window.__noseT = topAt);
};

window.__checkNoseKerbFaces = () => {
  const d = globalThis.__osm;
  if (!d.oneLine) return { samples: 0, bad: 0, worst: [], unit: 'm' };
  const noses = window.__noseList();
  const grid = new Map();
  noses.forEach((n, i) => {
    const k = Math.floor(n.C[0] / 8) * 100003 + Math.floor(n.C[1] / 8);
    (grid.get(k) ?? grid.set(k, []).get(k)).push(i);
  });
  const nearNose = (x, z) => {
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++)
        for (const i of grid.get((Math.floor(x / 8) + a) * 100003 + Math.floor(z / 8) + b) ?? []) if (Math.hypot(noses[i].C[0] - x, noses[i].C[1] - z) < 6) return noses[i];
    return null;
  };
  const topAt = window.__noseTops();
  let samples = 0;
  const bad = [];
  const seen = new Set();
  for (const accs of window.__noseAccs().values()) {
    const r = accs.kerbSide;
    if (!r) continue;
    const { pos, idx } = r;
    for (let q = 0; q < idx.length; q += 3) {
      const a = idx[q] * 3, b = idx[q + 1] * 3, c = idx[q + 2] * 3;
      const det = (pos[b] - pos[a]) * (pos[c + 2] - pos[a + 2]) - (pos[b + 2] - pos[a + 2]) * (pos[c] - pos[a]);
      if (Math.abs(det) > 1e-5) continue;
      const x = (pos[a] + pos[b] + pos[c]) / 3, z = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
      const n = nearNose(x, z);
      if (!n) continue;
      samples++;
      // (Its height as seen: from its top down to the road or ground at its
      // foot, either side, a hand's width out; a kerb's side runs on down
      // under the road, 0.12 m, where nobody sees it.)
      const top = Math.max(pos[a + 1], pos[b + 1], pos[c + 1]);
      let foot = Math.min(pos[a + 1], pos[b + 1], pos[c + 1]);
      let ex = 0, ez = 0, el = 0;
      for (const [p, n] of [[a, b], [b, c], [c, a]]) {
        const l = Math.hypot(pos[n] - pos[p], pos[n + 2] - pos[p + 2]);
        if (l > el) (el = l), (ex = (pos[n] - pos[p]) / l), (ez = (pos[n + 2] - pos[p + 2]) / l);
      }
      if (el < 0.005) continue;
      for (const sg of [-1, 1]) {
        const [k, h] = topAt(x - ez * sg * 0.15, z + ex * sg * 0.15, top - 0.01);
        if (k >= 0 && h > foot) foot = h;
      }
      const h = top - foot;
      if (h <= 0.25) continue;
      const key = `${x.toFixed(1)},${z.toFixed(1)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bad.push({ x: +x.toFixed(1), z: +z.toFixed(1), nose: [+n.C[0].toFixed(1), +n.C[1].toFixed(1)], over: +(h - 0.25).toFixed(2) });
    }
  }
  bad.sort((p, q) => q.over - p.over);
  return { samples, bad: bad.length, worst: bad, unit: 'm' };
};

window.__checkNoseSteps = () => {
  const d = globalThis.__osm;
  if (!d.oneLine) return { samples: 0, bad: 0, worst: [], unit: 'm' };
  const KINDS = NOSE_KINDS;
  const topAt = window.__noseTops();
  const STEP = 0.05;
  let samples = 0;
  const bad = [];
  for (const n of window.__noseList()) {
    // (Across the island, square to the way its point faces, every half
    // metre back from the point to 6 m; 3 m either side of its middle line.)
    const [dx, dz] = n.d;
    let worst = null;
    for (let s = 0.25; s <= 6; s += 0.5) {
      const mx = n.C[0] + dx * s, mz = n.C[1] + dz * s;
      let prev = null;
      for (let o = -3; o <= 3 + 1e-9; o += STEP) {
        const x = mx - dz * o, z = mz + dx * o;
        const [k, h] = topAt(x, z, n.y + 2.5);
        samples++;
        const cur = k >= 0 && KINDS[k] !== 'road' ? { k, h, x, z } : null;
        if (cur && prev && prev.k === cur.k) {
          const step = Math.abs(cur.h - prev.h) - 0.5 * STEP;
          if (step > 0.02 && (!worst || step > worst.over)) worst = { x: +x.toFixed(2), z: +z.toFixed(2), nose: [+n.C[0].toFixed(1), +n.C[1].toFixed(1)], on: KINDS[k], over: +step.toFixed(3) };
        }
        prev = cur;
      }
    }
    if (worst) bad.push(worst);
  }
  bad.sort((p, q) => q.over - p.over);
  return { samples, bad: bad.length, worst: bad, unit: 'm' };
};
