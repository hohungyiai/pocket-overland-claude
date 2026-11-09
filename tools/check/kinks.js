// In-page check (run with ?debug): no road jogs sideways. A jog is a sharp
// turn one way and, within a few metres, a sharp turn back (the road steps
// out to one side and carries on straight). A real bend turns one way only.
window.__checkKinks = (all = false) => {
  const d = globalThis.__osm;
  const TURN = (12 * Math.PI) / 180; // a sharp turn between 4 m pieces
  const WITHIN = 12; // m
  const bad = [];
  let n = 0;
  d.edges.forEach((e, i) => {
    if (d.JX.internal[i]) return;
    const P = d.EP[i];
    const cum = d.ECUM[i];
    const head = [];
    for (let k = 0; k + 1 < P.length; k++) head.push(cum[k + 1] - cum[k] > 0.5 ? Math.atan2(P[k + 1][1] - P[k][1], P[k + 1][0] - P[k][0]) : NaN);
    const turn = (k) => {
      // Turn at point k+1, between pieces k and k+1 (skipping tiny pieces).
      let a = head[k], b = head[k + 1];
      if (a !== a || b !== b) return 0;
      let t = b - a;
      while (t > Math.PI) t -= 2 * Math.PI;
      while (t < -Math.PI) t += 2 * Math.PI;
      return t;
    };
    for (let k = 0; k + 1 < head.length; k++) {
      n++;
      const t = turn(k);
      if (Math.abs(t) < TURN) continue;
      for (let m = k + 1; m + 1 < head.length && cum[m + 1] - cum[k + 1] <= WITHIN; m++) {
        const u = turn(m);
        if (Math.abs(u) >= TURN && Math.sign(u) !== Math.sign(t)) {
          bad.push({ road: e.name || e.cls, i, s: +cum[k + 1].toFixed(1), x: +P[k + 1][0].toFixed(1), z: +P[k + 1][1].toFixed(1), turnDeg: +((t * 180) / Math.PI).toFixed(0), backDeg: +((u * 180) / Math.PI).toFixed(0), over: 1 });
          k = m;
          break;
        }
      }
    }
  });
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40) };
};
