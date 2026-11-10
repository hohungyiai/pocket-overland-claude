// In-page check (run with ?debug): every piece of road surface faces up.
//
// A road, a junction's paving, a pad or the paved wedge between two merging
// roads is drawn as flat pieces, each with a top side. A piece that ends up
// upside down (a wedge started from two roads still overlapping, a road's
// end twisted round at its junction, paving folded over itself) shows as a
// dark patch on the road: the ground's shade, not the road's.
//
// Looks at every piece of the drawn road surface map-wide; kerbs and road
// lines too (kinds), which lie flat on it. Slivers under 0.02 m² are not
// counted. One finding per 3 m.
window.__checkFacing = (all = false, kinds = ['road', 'kerb', 'white', 'yellow']) => {
  const d = globalThis.__osm;
  const bad = [];
  const seen = new Set();
  let n = 0;
  for (const k of d.farTiles()) {
    const accs = d.tileAccs(k);
    for (const kind of kinds) {
      const r = accs[kind];
      if (!r) continue;
      const { pos, idx } = r;
      for (let q = 0; q < idx.length; q += 3) {
        const a = idx[q] * 3, b = idx[q + 1] * 3, c = idx[q + 2] * 3;
        const ux = pos[b] - pos[a], uz = pos[b + 2] - pos[a + 2];
        const vx = pos[c] - pos[a], vz = pos[c + 2] - pos[a + 2];
        // (The upward part of the piece's normal, times twice its area.)
        const ny = uz * vx - ux * vz;
        n++;
        if (ny >= 0 || -ny / 2 < 0.02) continue;
        const x = (pos[a] + pos[b] + pos[c]) / 3, z = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
        const key = `${kind},${Math.round(x / 3)},${Math.round(z / 3)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bad.push({ kind, x: +x.toFixed(1), z: +z.toFixed(1), y: +((pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3).toFixed(1), areaM2: +(-ny / 2).toFixed(2), over: +(-ny / 2).toFixed(2) });
      }
    }
  }
  bad.sort((p, q) => q.over - p.over);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40) };
};
