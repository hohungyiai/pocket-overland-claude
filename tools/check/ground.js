// In-page check (run with ?debug): does the ground ever rise above a road's surface?
// Returns stats; called from tools/check/run.cjs.
window.__checkGround = () => {
  const d = globalThis.__osm;
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
      const h = d.EHALF[i];
      const edgeY = (q, sgn) => {
        const [px, pz] = P[q];
        return Y ? Y[q] : d.heightAt(px + nx * sgn * h, pz + nz * sgn * h);
      };
      const la = edgeY(k, -1), ra = edgeY(k, 1), lb = edgeY(k + 1, -1), rb = edgeY(k + 1, 1);
      for (const f of [-0.6, -0.3, 0, 0.3, 0.6]) {
        const t = (f + 1) / 2;
        const o = f * h;
        const m = [(ax + bx) / 2 + nx * o, (az + bz) / 2 + nz * o];
        const g = d.heightAt(...m);
        const surf = (la + (ra - la) * t + lb + (rb - lb) * t) / 2 + 0.09;
        n++;
        if (g > surf + 0.02) bad.push({ road: e.name || e.cls, x: Math.round(m[0]), z: Math.round(m[1]), over: +(g - surf).toFixed(2) });
      }
    }
  });
  bad.sort((a, b) => b.over - a.over);
  return { samples: n, bad: bad.length, worst: bad.slice(0, 12) };
};
