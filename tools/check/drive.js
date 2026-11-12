// In-page checks (run with ?debug, after seams.js): every road is drivable
// by the car from a standstill. Drives three lines along every road (its
// middle and both sides, 25 cm steps) over what the car actually rides on
// (the drawn road surfaces, which are its colliders) and measures:
//  - lips: a sudden rise or drop between two steps (a kerb, a pad's edge);
//  - grades: the climb over 5 m (about a car length and a half);
//  - side tilt: how much higher one side of the road is than the other, and
//    how fast that changes along the road (a ramp that rocks the car from
//    side to side).
// Each is held to 60% of what the car can do (measured: see src/limits.ts).
window.__driveScan = () => {
  if (window.__driveScanned) return window.__driveScanned;
  const d = globalThis.__osm;
  const L = d.LIMITS;
  const { topAt } = window.__roadIndex(true);
  const STEP = 0.25;
  const BACK = 20; // steps in 5 m
  const out = { lip: [], grade: [], tilt: [], n: 0, worst: { lip: 0, grade: 0, tilt: 0, twist: 0 } };
  const seen = new Set();
  const push = (kind, e, i, x, z, v, lim, extra = {}) => {
    const key = `${kind}:${Math.round(x / 4)},${Math.round(z / 4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out[kind].push({ road: e.name || e.cls, i, x: +x.toFixed(1), z: +z.toFixed(1), value: +v.toFixed(3), over: +(v - lim).toFixed(3), ...extra });
  };
  const F = [-0.7, 0, 0.7];
  d.edges.forEach((e, i) => {
    if (d.JX.internal[i]) return;
    const P = d.EP[i];
    const cum = d.ECUM[i];
    const len = cum[cum.length - 1];
    if (len < 1) return;
    const Y = d.hasProfile[i] ? d.deckY(i) : null;
    const tilted = Y && !d.elevated[i];
    const ground = (x, z) => Math.max(d.surfaceAt(x, z), d.WL + 0.15);
    const prev = [NaN, NaN, NaN];
    const hist = []; // centre heights, one per step
    const tiltHist = [];
    let k = 0;
    for (let s = 0; s <= len; s += STEP) {
      while (k < P.length - 2 && cum[k + 1] <= s) k++;
      const sl = cum[k + 1] - cum[k] || 1;
      const u = Math.min(1, (s - cum[k]) / sl);
      const tx = (P[k + 1][0] - P[k][0]) / sl, tz = (P[k + 1][1] - P[k][1]) / sl;
      const half = Math.min(d.halfAtE(i, k), d.halfAtE(i, k + 1));
      const cx = P[k][0] + (P[k + 1][0] - P[k][0]) * u;
      const cz = P[k][1] + (P[k + 1][1] - P[k][1]) * u;
      const tk = tilted ? d.tiltAt(i, s) : 0;
      const rk = tilted ? d.relAlong(i, s) : 0;
      const ys = [NaN, NaN, NaN];
      for (let q = 0; q < 3; q++) {
        const x = cx + tz * F[q] * half;
        const z = cz - tx * F[q] * half;
        if (Math.abs(x) > 3590 || Math.abs(z) > 3590) {
          prev[q] = NaN;
          continue;
        }
        // The road as designed here; the car rides on the highest surface
        // drawn near that (anything well above is a deck overhead).
        let want = Y ? Y[k] + (Y[k + 1] - Y[k]) * u : ground(x, z);
        // (On a redrawn map a road at the ground keeps its own height along
        // its line and follows the ground's shape across from its middle:
        // the builder's tiltY.)
        if (tk > 0) want += d.oneLine ? tk * (ground(x, z) - ground(cx, cz)) : (ground(x, z) + rk - want) * tk;
        const y = topAt(x, z, want - 1.5, want + 1.2);
        // Nothing drawn here, at this level: the seam check's business.
        if (y !== y) {
          prev[q] = NaN;
          continue;
        }
        out.n++;
        if (prev[q] === prev[q]) {
          const lip = Math.abs(y - prev[q]) - STEP * L.grade;
          out.worst.lip = Math.max(out.worst.lip, lip);
          if (lip > L.lip) push('lip', e, i, x, z, lip, L.lip, { s: +s.toFixed(1) });
        }
        prev[q] = ys[q] = y;
      }
      hist.push(ys[1]);
      if (hist.length > BACK && hist[hist.length - 1 - BACK] === hist[hist.length - 1 - BACK] && ys[1] === ys[1]) {
        const g = Math.abs(ys[1] - hist[hist.length - 1 - BACK]) / (BACK * STEP);
        out.worst.grade = Math.max(out.worst.grade, g);
        if (g > L.grade) push('grade', e, i, cx, cz, g, L.grade, { s: +s.toFixed(1) });
      }
      const t = ys[0] === ys[0] && ys[2] === ys[2] ? (ys[2] - ys[0]) / (1.4 * half) : NaN;
      tiltHist.push(t);
      if (t === t) {
        out.worst.tilt = Math.max(out.worst.tilt, Math.abs(t));
        if (Math.abs(t) > L.tilt) push('tilt', e, i, cx, cz, Math.abs(t), L.tilt, { s: +s.toFixed(1), what: 'side tilt' });
        const t0 = tiltHist.length > BACK ? tiltHist[tiltHist.length - 1 - BACK] : NaN;
        if (t0 === t0) {
          const tw = Math.abs(t - t0);
          out.worst.twist = Math.max(out.worst.twist, tw);
          if (tw > L.twist) push('tilt', e, i, cx, cz, tw, L.twist, { s: +s.toFixed(1), what: 'rocks side to side' });
        }
      }
    }
  });
  for (const kind of ['lip', 'grade', 'tilt']) out[kind].sort((a, b) => b.over - a.over);
  return (window.__driveScanned = out);
};
const report = (kind) => (all = false) => {
  const r = window.__driveScan();
  return { samples: r.n, bad: r[kind].length, worst: all ? r[kind] : r[kind].slice(0, 40), max: r.worst };
};
window.__checkLips = report('lip');
window.__checkGrades = report('grade');
window.__checkTilt = report('tilt');
