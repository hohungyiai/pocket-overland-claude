// In-page check (run with ?debug): does the ground mesh ever rise above a road's surface?
// Returns stats; called from tools/check/run.cjs.
window.__checkGround = () => {
  const d = globalThis.__osm;
  // The ground you see (and drive on) is a 4 m grid of heightAt samples,
  // split into triangles along the (i+1, j)-(i, j+1) diagonal: compare roads
  // against that mesh, not the smooth function behind it.
  const S = 4, X0 = -3600, Z0 = -3600;
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
  const bad = [];
  let n = 0;
  d.edges.forEach((e, i) => {
    const P = d.EP[i];
    const Y = d.hasProfile[i] ? d.deckY(i) : null;
    if (d.isDeck[i]) return; // decks are in the air: nothing to compare
    for (let k = 0; k + 1 < P.length; k++) {
      const [ax, az] = P[k];
      const [bx, bz] = P[k + 1];
      const tl = Math.hypot(bx - ax, bz - az) || 1;
      const nx = (bz - az) / tl, nz = -(bx - ax) / tl;
      // The ribbon has vertices only at its two edges: its surface across the
      // width is the straight line between them.
      // (A joined line is as wide as it is drawn at each point, not its widest.)
      const hk = (q) => d.halfNear(i, q, 0);
      const edgeY = (q, sgn) => {
        const [px, pz] = P[q];
        return Y ? Y[q] : (d.surfaceAt ?? d.heightAt)(px + nx * sgn * hk(q), pz + nz * sgn * hk(q));
      };
      const la = edgeY(k, -1), ra = edgeY(k, 1), lb = edgeY(k + 1, -1), rb = edgeY(k + 1, 1);
      // Across the full width and out to the kerbs (|f| > 1 holds the edge
      // height), at the joints and three points between them.
      for (const a of [0, 0.25, 0.5, 0.75]) {
        for (const f of [-1.08, -0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9, 1.08]) {
          const t = Math.min(1, Math.max(0, (f + 1) / 2));
          const o = f * (hk(k) + (hk(k + 1) - hk(k)) * a);
          const m = [ax + (bx - ax) * a + nx * o, az + (bz - az) * a + nz * o];
          if (Math.abs(m[0]) > 3596 || Math.abs(m[1]) > 3596) continue; // beyond the built ground
          const g = meshAt(...m);
          const surf = (la + (ra - la) * t) * (1 - a) + (lb + (rb - lb) * t) * a + 0.09;
          n++;
          if (g > surf + 0.02) bad.push({ road: e.name || e.cls, x: Math.round(m[0]), z: Math.round(m[1]), over: +(g - surf).toFixed(2) });
        }
      }
    }
  });
  bad.sort((a, b) => b.over - a.over);
  return { samples: n, bad: bad.length, worst: bad.slice(0, 12) };
};
