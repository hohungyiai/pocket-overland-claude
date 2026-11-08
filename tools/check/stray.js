// In-page check (run with ?debug): no stray kerb or road marking inside a
// junction. A junction's paving is open asphalt: kerbs run only round its
// edge, and lane lines, centre lines and crossings stop at its mouths. Any
// kerb or marking piece whose middle lies well inside a junction (or a paved
// island) is a fragment left over where pieces of road were cut back.
window.__checkStray = (all = false) => {
  const d = globalThis.__osm;
  const polys = [...d.JX.shapes, ...d.JX.fills];
  // Bucket the junctions on a 32 m grid.
  const C = 32;
  const grid = new Map();
  polys.forEach((s, id) => {
    const r = s.radius + 1;
    for (let i = Math.floor((s.centre[0] - r) / C); i <= Math.floor((s.centre[0] + r) / C); i++)
      for (let j = Math.floor((s.centre[1] - r) / C); j <= Math.floor((s.centre[1] + r) / C); j++) {
        const k = i * 100003 + j;
        (grid.get(k) ?? grid.set(k, []).get(k)).push(id);
      }
  });
  const ns = d.JX.shapes.length;
  const topOf = (id, x, z) => (id < ns ? d.jTop(id, x, z) : d.fillTop(id - ns, x, z));
  /** How far inside a junction (x, z) lies, at its level (0 if outside every one). */
  const depth = (x, y, z) => {
    let best = 0;
    for (const id of grid.get(Math.floor(x / C) * 100003 + Math.floor(z / C)) ?? []) {
      const ring = polys[id].ring;
      let inside = false;
      let dmin = Infinity;
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const [ax, az] = ring[a];
        const [bx, bz] = ring[b];
        if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
        const dx = bx - ax, dz = bz - az;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
        dmin = Math.min(dmin, Math.hypot(x - ax - dx * t, z - az - dz * t));
      }
      // (A flyover passing over the junction is no part of it.)
      if (inside && Math.abs(y - topOf(id, x, z)) < 1 && dmin > best) {
        best = dmin;
        depth.id = id < ns ? `junction ${id}` : `island ${id - ns}`;
      }
    }
    return best;
  };
  // (A zebra crossing is painted on its own road on purpose, even where the
  // road runs past a paved island: the crossings check sees to those.)
  const onCrossing = (x, z) =>
    d.crossings.some((cr) => {
      const dx = x - cr.c[0], dz = z - cr.c[1];
      if (dx * dx + dz * dz > 400) return false;
      const along = Math.abs(dx * cr.t[0] + dz * cr.t[1]);
      const across = Math.abs(-dx * cr.t[1] + dz * cr.t[0]);
      return along < d.CROSS_W / 2 + 1.5 && across < cr.half + 0.5; // (and its stop line)
    });
  // (A kerb is 0.65 m wide and hugs the edge; a marking may just touch it.)
  const DEEP = 0.8;
  const bad = [];
  const seen = new Set();
  let n = 0;
  for (const k of d.farTiles()) {
    const accs = d.tileAccs(k);
    for (const kind of ['kerb', 'white', 'yellow']) {
      const r = accs[kind];
      if (!r) continue;
      const { pos, idx } = r;
      for (let q = 0; q < idx.length; q += 3) {
        const a = idx[q] * 3, b = idx[q + 1] * 3, c = idx[q + 2] * 3;
        const x = (pos[a] + pos[b] + pos[c]) / 3;
        const y = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3;
        const z = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
        n++;
        const dd = depth(x, y, z);
        if (dd <= DEEP || (kind === 'white' && onCrossing(x, z))) continue;
        const key = `${kind}:${Math.round(x / 3)},${Math.round(z / 3)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bad.push({ kind, x: +x.toFixed(1), z: +z.toFixed(1), in: depth.id, over: +(dd - DEEP).toFixed(2) });
      }
    }
  }
  bad.sort((p, q) => q.over - p.over);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40) };
};
