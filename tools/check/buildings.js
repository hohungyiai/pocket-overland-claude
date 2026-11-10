// In-page check (run with ?debug): a road always has right of way over a
// building.
//
// __checkBuildingsUnderRoads: no building stands up through a raised road.
// Under a deck (a flyover or bridge) a roof must clear the deck's underside
// by at least half a metre; under a road raised on a bank of earth there
// can be no building at all. Walks every raised road, across its width
// (parapets included), and looks at each building whose outline it passes
// over.
window.__checkBuildingsUnderRoads = (all = false) => {
  const d = globalThis.__osm;
  const C = 50;
  const grid = new Map();
  d.blds.forEach((b, id) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of b.pts) {
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      z0 = Math.min(z0, p[1]);
      z1 = Math.max(z1, p[1]);
    }
    for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++)
      for (let j = Math.floor(z0 / C); j <= Math.floor(z1 / C); j++) {
        const k = i * 100003 + j;
        (grid.get(k) ?? grid.set(k, []).get(k)).push(id);
      }
  });
  const inside = (P, x, z) => {
    let c = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const a = P[i], b = P[j];
      if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  };
  const worstOf = new Map();
  let n = 0;
  d.edges.forEach((e, i) => {
    if (!d.hasProfile[i]) return;
    const P = d.EP[i];
    const Y = d.deckY(i);
    const depth = d.elevated[i] ? 1.2 : 0.6;
    for (let k = 0; k + 1 < P.length; k++)
      for (const u of [0, 0.5]) {
        const x0 = P[k][0] + (P[k + 1][0] - P[k][0]) * u, z0 = P[k][1] + (P[k + 1][1] - P[k][1]) * u;
        const y = Y[k] + (Y[k + 1] - Y[k]) * u;
        const l = Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]) || 1;
        const nx = (P[k + 1][1] - P[k][1]) / l, nz = -(P[k + 1][0] - P[k][0]) / l;
        const h = d.halfAtE(i, k) + 0.45;
        for (const o of [-h, -h / 2, 0, h / 2, h]) {
          const x = x0 + nx * o, z = z0 + nz * o;
          n++;
          for (const id of grid.get(Math.floor(x / C) * 100003 + Math.floor(z / C)) ?? []) {
            const b = d.blds[id];
            if (!inside(b.pts, x, z)) continue;
            const top = b.ground + b.h;
            // (On a bank there is no space beneath at all.)
            const limit = d.isDeck[i] ? y - depth - 0.5 : b.ground;
            if (top <= limit) continue;
            const over = +(top - limit).toFixed(2);
            if (!worstOf.has(id) || worstOf.get(id).over < over)
              worstOf.set(id, { road: e.name || e.cls, i, building: id, x: +x.toFixed(1), z: +z.toFixed(1), roofAt: +top.toFixed(1), deckAt: +y.toFixed(1), over });
          }
        }
      }
  });
  const bad = [...worstOf.values()].sort((p, q) => q.over - p.over);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40) };
};
