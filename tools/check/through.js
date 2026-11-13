// In-page checks (run with ?debug): the through road wins.
//
// At a junction where one road carries straight on and nothing it meets
// outranks it, that road's lane lines, centre line and (on a side no road
// joins from) edge line are painted across the junction's paving.
//
// __checkThroughLines: every such line is really there on the drawn map:
// painted along its whole length (a dashed one, on each dash), and lying
// just above the junction's paving, neither under it nor floating.
//
// __checkThroughJoins: each end of such a line meets the road's own line
// at the junction's edge: a solid line carries on without a break, and a
// dashed one picks up in line within a dash's gap.
//
// __checkThroughEdges: on a side of the through road where nothing joins
// (the junction's outline runs from one mouth's corner straight to the
// other's), the road's edge carries on smoothly: from the kerb coming in,
// along the outline, to the kerb going out, it never turns more than 10°
// at any one point.
//
// __checkGiveWays: where the through road wins, each road that joins it has
// its give-way line: every dash is really painted, lying on the road's
// surface, within the road's width and outside the junction.
(() => {
  const marks = () => {
    const d = globalThis.__osm;
    if (marks.grid) return marks.grid;
    // Every painted piece (a triangle's middle, and points along its sides
    // every half metre: a long straight run of line may be drawn as a few
    // long triangles), on a 2 m grid.
    const grid = { white: new Map(), yellow: new Map() };
    for (const k of d.farTiles()) {
      const accs = d.tileAccs(k);
      for (const kind of ['white', 'yellow']) {
        const r = accs[kind];
        if (!r) continue;
        const { pos, idx } = r;
        const put = (x, y, z) => {
          const key = Math.floor(x / 2) * 100003 + Math.floor(z / 2);
          (grid[kind].get(key) ?? grid[kind].set(key, []).get(key)).push([x, y, z]);
        };
        for (let q = 0; q < idx.length; q += 3) {
          const a = idx[q] * 3, b = idx[q + 1] * 3, c = idx[q + 2] * 3;
          put((pos[a] + pos[b] + pos[c]) / 3, (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3, (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3);
          for (const [u, v] of [[a, b], [b, c], [c, a]]) {
            const n = Math.floor(Math.hypot(pos[v] - pos[u], pos[v + 2] - pos[u + 2]) / 0.5);
            for (let t = 1; t < n; t++) put(pos[u] + ((pos[v] - pos[u]) * t) / n, pos[u + 1] + ((pos[v + 1] - pos[u + 1]) * t) / n, pos[u + 2] + ((pos[v + 2] - pos[u + 2]) * t) / n);
          }
        }
      }
    }
    return (marks.grid = grid);
  };
  /** Painted pieces of a kind within r of (x, z). */
  const near = (kind, x, z, r) => {
    const g = marks()[kind];
    const out = [];
    for (let i = Math.floor((x - r) / 2); i <= Math.floor((x + r) / 2); i++)
      for (let j = Math.floor((z - r) / 2); j <= Math.floor((z + r) / 2); j++)
        for (const m of g.get(i * 100003 + j) ?? []) if (Math.hypot(m[0] - x, m[2] - z) <= r) out.push(m);
    return out;
  };
  const names = (d, id) => [...new Set(d.JX.shapes[id].mouths.map((m) => d.edges[m.line].name || d.edges[m.line].cls))].join(' / ');

  window.__checkThroughLines = (all = false) => {
    const d = globalThis.__osm;
    const bad = [];
    let n = 0;
    for (const [id, lines] of d.throughLines)
      lines.forEach((ln, li) => {
        let run = 0;
        let worst = null;
        let miss = 0;
        const total = ln.pts.reduce((sum, p, k) => sum + (k ? Math.hypot(p[0] - ln.pts[k - 1][0], p[1] - ln.pts[k - 1][1]) : 0), 0);
        for (let k = 0; k < ln.pts.length; k++) {
          const [x, z] = ln.pts[k];
          if (k) run += Math.hypot(x - ln.pts[k - 1][0], z - ln.pts[k - 1][1]);
          // (Well inside a dash, or anywhere on a solid line.)
          // (A dash cut short by the junction's far edge may be a stub.)
          if (ln.dashed && !(run % 12 > 0.6 && run % 12 < 3.4 && Math.floor(run / 12) * 12 + 3 <= total)) continue;
          if (!ln.dashed && (k === 0 || k === ln.pts.length - 1)) continue;
          n++;
          // (Each painted piece against the paving right under it.)
          const got = near(ln.kind, x, z, 0.75).map((m) => m[1] - (d.paveY(id, m[0], m[2]) + 0.09));
          if (got.some((h) => h > 0.005 && h < 0.08)) continue;
          miss++;
          if (!worst) worst = { x: +x.toFixed(1), z: +z.toFixed(1), why: got.length ? `painted ${Math.min(...got.map(Math.abs)).toFixed(3)} m off the paving's top` : 'not painted' };
        }
        if (miss) bad.push({ junction: id, roads: names(d, id), line: li, kind: ln.kind, missing: miss, of: ln.pts.length, ...worst });
      });
    bad.sort((p, q) => q.missing - p.missing);
    return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40) };
  };

  window.__checkThroughJoins = (all = false) => {
    const d = globalThis.__osm;
    const bad = [];
    let n = 0;
    for (const [id, lines] of d.throughLines)
      lines.forEach((ln, li) => {
        const N = ln.pts.length - 1;
        [[ln.pts[0], ln.pts[1]], [ln.pts[N], ln.pts[N - 1]]].forEach(([p, q], w) => {
          // Outward from the junction, along the line's own direction.
          const l = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
          const tx = (p[0] - q[0]) / l, tz = (p[1] - q[1]) / l;
          const reach = ln.dashed ? 13 : 1.5;
          // The road must have a line of its own to meet: room for one
          // before its far end, and no other road, island or junction lying
          // over the spot (lines are cleared there on purpose).
          const line = ln.ends[w] >> 1, end = ln.ends[w] & 1;
          const stops = d.markStops(line);
          const far = d.throughEnd(line, 1 - end) ? (end ? d.JX.trimA[line] : d.JX.trimB[line]) : stops[1 - end];
          const free = d.ELEN[line] - (end ? d.JX.trimB[line] : d.JX.trimA[line]) - far;
          if (free < reach + 4.5) return;
          const P = d.EP[line];
          let kn = 0;
          P.forEach((q, k) => {
            if (Math.hypot(q[0] - p[0], q[1] - p[1]) < Math.hypot(P[kn][0] - p[0], P[kn][1] - p[1])) kn = k;
          });
          const y = d.hasProfile[line] ? d.deckY(line)[kn] : NaN;
          for (let s = 0.5; s <= reach + 3; s += 0.5) if (!d.lineOpen(line, p[0] + tx * s, p[1] + tz * s, y)) return;
          n++;
          const got = near(ln.kind, p[0] + (tx * reach) / 2, p[1] + (tz * reach) / 2, reach / 2 + 1).some((m) => {
            const along = (m[0] - p[0]) * tx + (m[2] - p[1]) * tz;
            const across = Math.abs((m[0] - p[0]) * tz - (m[2] - p[1]) * tx);
            return along > 0.05 && along < reach && across < 0.3 + 0.1 * along;
          });
          if (!got) bad.push({ junction: id, roads: names(d, id), line: li, kind: ln.kind, road: line, end, x: +p[0].toFixed(1), z: +p[1].toFixed(1), over: 1 });
        });
      });
    return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40) };
  };

  window.__checkThroughEdges = (all = false) => {
    const d = globalThis.__osm;
    const bad = [];
    let n = 0;
    for (const pr of d.throughPairs) {
      const sh = d.JX.shapes[pr.id];
      const M = sh.mouths;
      const R = sh.ring;
      const at = (p) => R.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-4);
      for (const [ia, ib] of [[pr.a, pr.b], [pr.b, pr.a]]) {
        const A = M[ia], B = M[ib];
        // The outline from A's left corner round (counter-clockwise) to B's right.
        const i0 = at(A.left), i1 = at(B.right);
        if (i0 < 0 || i1 < 0) continue;
        const seg = [R[i0]];
        for (let k = i0; k !== i1 && seg.length <= R.length; ) seg.push(R[(k = (k + 1) % R.length)]);
        // (Closed: no other mouth opens onto that stretch.)
        if (seg.length > R.length || M.some((m, q) => q !== ia && q !== ib && seg.some((p) => Math.hypot(p[0] - m.q[0], p[1] - m.q[1]) < m.half + 0.5))) continue;
        n++;
        const dirs = [[-A.t[0], -A.t[1]]];
        for (let j = 0; j + 1 < seg.length; j++) {
          const l = Math.hypot(seg[j + 1][0] - seg[j][0], seg[j + 1][1] - seg[j][1]);
          if (l > 0.05) dirs.push([(seg[j + 1][0] - seg[j][0]) / l, (seg[j + 1][1] - seg[j][1]) / l]);
        }
        dirs.push(B.t);
        let turn = 0;
        for (let j = 0; j + 1 < dirs.length; j++) turn = Math.max(turn, (Math.acos(Math.max(-1, Math.min(1, dirs[j][0] * dirs[j + 1][0] + dirs[j][1] * dirs[j + 1][1]))) * 180) / Math.PI);
        if (turn > 10) bad.push({ junction: pr.id, roads: names(d, pr.id), x: +A.left[0].toFixed(1), z: +A.left[1].toFixed(1), turnDeg: +turn.toFixed(1), over: +(turn - 10).toFixed(1) });
      }
    }
    bad.sort((p, q) => q.over - p.over);
    return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40) };
  };

  window.__checkGiveWays = (all = false) => {
    const d = globalThis.__osm;
    const bad = [];
    let n = 0;
    for (const g of d.giveWays) {
      const m = d.JX.shapes[g.id].mouths.find((q) => q.line === g.line && q.end === g.end);
      let why = null;
      for (const [x, z] of g.dashes) {
        n++;
        const top = d.surfaceAt(x, z);
        const got = near('white', x, z, 0.35);
        const across = Math.abs((x - m.q[0]) * g.left[0] + (z - m.q[1]) * g.left[1]);
        const out = (x - m.q[0]) * m.t[0] + (z - m.q[1]) * m.t[1];
        if (!got.some((p) => p[1] - top > 0.09 && p[1] - top < 0.2)) why = got.length ? 'not on the road surface' : 'not painted';
        else if (across > m.half - 0.3) why = 'beyond the road edge';
        else if (out < 0.3 || out > 2) why = 'not just short of the junction';
        if (why) break;
      }
      if (why) bad.push({ junction: g.id, road: d.edges[g.line].name || d.edges[g.line].cls, line: g.line, x: +g.dashes[0][0].toFixed(1), z: +g.dashes[0][1].toFixed(1), why, over: 1 });
    }
    return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40) };
  };
})();
