// In-page check (run with ?debug) on footpaths and cycle paths, as drawn.
//
// __checkPaths: a path lies on the grass as the ground's mesh draws it (a
//   4 m lattice of heightAt, each square cut corner to corner the same
//   way), never under it: nowhere does the ground rise more than GRASS
//   through a path's surface (paths lie 5 cm above it). And a path's
//   surface never folds over on itself: wherever two of its triangles
//   share a side, they lie on either side of it, not one over the other
//   (a bend so tight that the inside edge runs backwards, the pieces
//   overlapping in grey shards).

window.__checkPaths = (all = false) => {
  const d = globalThis.__osm;
  const S = 4, X0 = d.WB.minX, Z0 = d.WB.minZ;
  const memo = new Map();
  const at = (i, j) => {
    const k = i * 100003 + j;
    let v = memo.get(k);
    if (v === undefined) memo.set(k, (v = d.heightAt(X0 + i * S, Z0 + j * S)));
    return v;
  };
  const meshAt = (x, z) => {
    const fx = (x - X0) / S, fz = (z - Z0) / S;
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    if (u + v <= 1) return at(i, j) + (at(i + 1, j) - at(i, j)) * u + (at(i, j + 1) - at(i, j)) * v;
    return at(i + 1, j + 1) + (at(i, j + 1) - at(i + 1, j + 1)) * (1 - u) + (at(i + 1, j) - at(i + 1, j + 1)) * (1 - v);
  };
  const GRASS = 0.04;
  const pts = [];
  let n = 0;
  for (const k of d.farTiles()) {
    const A = d.tileAccs(k);
    for (const nm of ['foot', 'cycle']) {
      const r = A[nm];
      if (!r) continue;
      const { pos, idx } = r;
      // Under the grass: at each triangle's middle and the middles of its sides.
      for (let q = 0; q < idx.length; q += 3) {
        const v = [idx[q] * 3, idx[q + 1] * 3, idx[q + 2] * 3];
        for (const w of [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]]) {
          const x = w[0] * pos[v[0]] + w[1] * pos[v[1]] + w[2] * pos[v[2]];
          const y = w[0] * pos[v[0] + 1] + w[1] * pos[v[1] + 1] + w[2] * pos[v[2] + 1];
          const z = w[0] * pos[v[0] + 2] + w[1] * pos[v[1] + 2] + w[2] * pos[v[2] + 2];
          if (x < d.WB.minX + 4 || x > d.WB.maxX - 4 || z < d.WB.minZ + 4 || z > d.WB.maxZ - 4) continue;
          n++;
          const over = meshAt(x, z) - y;
          if (over > GRASS) pts.push({ x: +x.toFixed(1), z: +z.toFixed(1), y: +y.toFixed(1), value: +over.toFixed(3), what: 'under the grass' });
        }
      }
      // Folded: two triangles sharing a side, both on the same side of it.
      const sideOf = new Map();
      for (let q = 0; q < idx.length; q += 3)
        for (let e = 0; e < 3; e++) {
          const a = idx[q + e], b = idx[q + ((e + 1) % 3)], o = idx[q + ((e + 2) % 3)];
          const key = a < b ? a * 4194304 + b : b * 4194304 + a;
          (sideOf.get(key) ?? sideOf.set(key, []).get(key)).push([a, b, o]);
        }
      for (const l of sideOf.values()) {
        if (l.length !== 2) continue;
        const [[a, b, o1], [, , o2]] = l;
        const ax = pos[a * 3], az = pos[a * 3 + 2], bx = pos[b * 3], bz = pos[b * 3 + 2];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 1e-3) continue;
        const s = (o) => ((bx - ax) * (pos[o * 3 + 2] - az) - (bz - az) * (pos[o * 3] - ax)) / L;
        const s1 = s(o1), s2 = s(o2);
        n++;
        // (By more than a centimetre each side: two sides of a path meeting in a straight line are not a fold.)
        if (s1 * s2 > 0 && Math.min(Math.abs(s1), Math.abs(s2)) > 0.01) pts.push({ x: +((ax + bx) / 2).toFixed(1), z: +((az + bz) / 2).toFixed(1), y: +pos[a * 3 + 1].toFixed(1), value: +Math.min(Math.abs(s1), Math.abs(s2)).toFixed(2), what: 'folded' });
      }
    }
  }
  const bad = window.__finishIndex().places(pts, 3);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: 'm' };
};
