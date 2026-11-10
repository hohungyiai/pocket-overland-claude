// In-page check (run with ?debug): where one road becomes two (or two
// become one), its outside edges carry on.
//
// A split is a joint of three roads at one level: two leaving within 35° of
// each other, the third opposite them. Looking from the single road, its
// left edge must run on as the left branch's left edge, and its right edge
// as the right branch's right edge:
//  - where the three are drawn straight from the joint (no junction paving),
//    the branch's edge starts within 0.3 m of the single road's;
//  - where a paved junction joins them, its outline from the single road's
//    corner to the branch's corner turns no more than 10° at any one point.
window.__checkSplitEdges = (all = false) => {
  const d = globalThis.__osm;
  const jE = new Map();
  d.edges.forEach((e, i) => {
    for (const [j, end] of [[e.a, 0], [e.b, 1]]) (jE.get(j) ?? jE.set(j, []).get(j)).push([i, end]);
  });
  /** Road i's points running away from its end. */
  const from = (i, end) => (end ? [...d.EP[i]].reverse() : d.EP[i]);
  /** The same as OSM has them (which roads split is read from these: the game moves the branches). */
  const osm = (i, end) => (end ? [...d.edges[i].pts].reverse() : d.edges[i].pts);
  const along = (P, s) => {
    let run = 0;
    for (let k = 0; k + 1 < P.length; k++) {
      const l = Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]);
      if (run + l >= s) return [P[k][0] + ((P[k + 1][0] - P[k][0]) * (s - run)) / (l || 1), P[k][1] + ((P[k + 1][1] - P[k][1]) * (s - run)) / (l || 1)];
      run += l;
    }
    return P[P.length - 1];
  };
  const unit = (a, b) => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  const halfEnd = (i, end) => d.halfAtE(i, end ? d.EP[i].length - 1 : 0);
  const trim = (i, end) => (end ? d.JX.trimB[i] : d.JX.trimA[i]) || 0;
  const COS35 = Math.cos((35 * Math.PI) / 180);
  const bad = [];
  /** Sides whose outline could not be followed from mouth to mouth (not judged). */
  const skipped = [];
  let n = 0;
  for (const [j, list] of jE) {
    if (list.length !== 3 || new Set(list.map((q) => q[0])).size !== 3) continue;
    const P = list.map(([i, end]) => from(i, end));
    const O = list.map(([i, end]) => osm(i, end));
    const dir = O.map((Q) => unit(Q[0], along(Q, 12)));
    const dot = (a, b) => dir[a][0] * dir[b][0] + dir[a][1] * dir[b][1];
    for (let c = 0; c < 3; c++) {
      const a = (c + 1) % 3, b = (c + 2) % 3;
      if (dot(a, b) < COS35 || -dot(c, a) < 0.8 || -dot(c, b) < 0.8) continue;
      const [ic, ec] = list[c];
      if (list.some(([i]) => !!d.elevated[i] !== !!d.elevated[ic])) break;
      // Left and right, looking from the single road into the branches.
      const u = [-dir[c][0], -dir[c][1]];
      const qa = along(O[a], 30), qb = along(O[b], 30);
      const aLeft = (qa[0] - qb[0]) * u[1] - (qa[1] - qb[1]) * u[0] > 0;
      const L = aLeft ? a : b, R = aLeft ? b : a;
      const road = d.edges[ic].name || d.edges[ic].cls;
      const shape = d.JX.shapeOf[j] >= 0 && list.some(([i, end]) => trim(i, end) > 0) ? d.JX.shapes[d.JX.shapeOf[j]] : null;
      for (const [q, side] of [[L, 1], [R, -1]]) {
        const [iq, eq] = list[q];
        if (!shape) {
          // How far out the branch's edge starts, measured across the single
          // road from its middle: it should be the single road's half width.
          // (A branch leaving at an angle turns the edge; it does not step it.)
          const off = ((P[q][0][0] - P[c][0][0]) * u[1] - (P[q][0][1] - P[c][0][1]) * u[0]) * side;
          const step = Math.abs(halfEnd(ic, ec) - (off + halfEnd(iq, eq)));
          n++;
          if (step > 0.3) bad.push({ road, j, x: +P[c][0][0].toFixed(1), z: +P[c][0][1].toFixed(1), side: side > 0 ? 'left' : 'right', kind: d.elevated[ic] ? 'flyover' : 'ground', stepM: +step.toFixed(2), over: +(step - 0.3).toFixed(2) });
          continue;
        }
        // The junction's outline between the two mouths on that side.
        const M = shape.mouths;
        const mc = M.find((m) => m.line === ic && m.end === ec), mq = M.find((m) => m.line === iq && m.end === eq);
        if (!mc || !mq) continue;
        // (The outline runs from one mouth's left corner to the next mouth's
        // right: whichever way round joins these two directly is the outside.)
        const R0 = shape.ring;
        const at = (p) => R0.findIndex((r) => Math.hypot(r[0] - p[0], r[1] - p[1]) < 1e-4);
        let A = null, B = null, seg = null;
        for (const [a2, b2] of [[mq, mc], [mc, mq]]) {
          const i0 = at(a2.left), i1 = at(b2.right);
          if (i0 < 0 || i1 < 0) continue;
          const sg = [R0[i0]];
          for (let k = i0; k !== i1 && sg.length <= R0.length; ) sg.push(R0[(k = (k + 1) % R0.length)]);
          if (sg.length > R0.length || M.some((m) => m !== a2 && m !== b2 && sg.some((p) => Math.hypot(p[0] - m.q[0], p[1] - m.q[1]) < m.half + 0.5))) continue;
          if (!seg || sg.length < seg.length) [A, B, seg] = [a2, b2, sg];
        }
        if (!seg) {
          skipped.push({ j, side: side > 0 ? 'left' : 'right', x: +P[c][0][0].toFixed(1), z: +P[c][0][1].toFixed(1) });
          continue;
        }
        n++;
        const dirs = [[-A.t[0], -A.t[1]]];
        for (let k = 0; k + 1 < seg.length; k++) if (Math.hypot(seg[k + 1][0] - seg[k][0], seg[k + 1][1] - seg[k][1]) > 0.05) dirs.push(unit(seg[k], seg[k + 1]));
        dirs.push(B.t);
        let turn = 0;
        for (let k = 0; k + 1 < dirs.length; k++) turn = Math.max(turn, (Math.acos(Math.max(-1, Math.min(1, dirs[k][0] * dirs[k + 1][0] + dirs[k][1] * dirs[k + 1][1]))) * 180) / Math.PI);
        if (turn > 10) bad.push({ road, j, x: +P[c][0][0].toFixed(1), z: +P[c][0][1].toFixed(1), side: side > 0 ? 'left' : 'right', kind: 'paved junction', turnDeg: +turn.toFixed(1), over: +(turn - 10).toFixed(1) });
      }
      break;
    }
  }
  bad.sort((p, q) => q.over - p.over);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40), skipped };
};
