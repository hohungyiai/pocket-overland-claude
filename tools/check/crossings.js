// In-page checks (run with ?debug) on zebra crossings and traffic lights. Called from tools/check/run.cjs.
(() => {
  const d = () => globalThis.__osm;
  const inside = (ring, x, z) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i];
      const [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  const drawn = (line, seg, u) => {
    const { ECUM, JX } = d();
    if (JX.internal[line]) return false;
    const c = ECUM[line];
    const s = c[seg] + (c[seg + 1] - c[seg]) * u;
    return s >= JX.trimA[line] && s <= c[c.length - 1] - JX.trimB[line];
  };

  /** A crossing lies on its own road only: not across another road or into a junction. */
  window.__checkCrossings = () => {
    const D = d();
    const bad = [];
    let n = 0;
    for (const cr of D.crossings) {
      const left = [-cr.t[1], cr.t[0]];
      for (const a of [-1, 0, 1])
        for (const b of [-1, -0.5, 0, 0.5, 1]) {
          const x = cr.c[0] + cr.t[0] * a * (D.CROSS_W / 2) + left[0] * b * (cr.half - 0.4);
          const z = cr.c[1] + cr.t[1] * a * (D.CROSS_W / 2) + left[1] * b * (cr.half - 0.4);
          n++;
          let over = 0;
          D.roads.each(x, z, 16, (i, seg, u, dd) => {
            if (i === cr.line || D.isDeck[i] || !drawn(i, seg, u)) return;
            over = Math.max(over, D.halfNear(i, seg, u) - 0.3 - dd);
          });
          for (const s of D.JX.shapes) if (Math.hypot(x - s.centre[0], z - s.centre[1]) < s.radius && inside(s.ring, x, z)) over = Math.max(over, 0.01);
          if (over > 0) bad.push({ road: D.edges[cr.line].name || D.edges[cr.line].cls, x: Math.round(x), z: Math.round(z), over: +over.toFixed(2) });
        }
    }
    bad.sort((a, b) => b.over - a.over);
    return { samples: n, bad: bad.length, worst: bad.slice(0, 12) };
  };

  /** No traffic light pole stands on a road, a path or in a junction. */
  window.__checkLightPoles = () => {
    const D = d();
    const bad = [];
    let n = 0;
    for (const cr of D.crossings) {
      if (!cr.light) continue;
      const [x, z] = cr.light;
      n++;
      let over = 0;
      D.roads.each(x, z, 16, (i, seg, u, dd) => {
        if (D.elevated[i] || !drawn(i, seg, u)) return;
        over = Math.max(over, D.halfNear(i, seg, u) + 0.2 - dd);
      });
      for (const s of [...D.JX.shapes, ...D.JX.fills]) if (Math.hypot(x - s.centre[0], z - s.centre[1]) < s.radius && inside(s.ring, x, z)) over = Math.max(over, 0.01);
      if (over > 0) bad.push({ road: D.edges[cr.line].name || D.edges[cr.line].cls, x: Math.round(x), z: Math.round(z), over: +over.toFixed(2) });
    }
    bad.sort((a, b) => b.over - a.over);
    return { samples: n, bad: bad.length, worst: bad.slice(0, 12) };
  };

  /**
   * A junction's yellow box lies on its paving: every piece of its outline
   * and its X on the asphalt (not on a kerb, a verge or another road's
   * lines), a hair above it.
   */
  window.__checkYellowBoxes = (all = false) => {
    const D = d();
    const F = window.__finishIndex();
    const pts = [];
    let n = 0;
    for (const k of D.farTiles()) {
      const r = D.tileAccs(k).box;
      if (!r) continue;
      const { pos, idx } = r;
      for (let q = 0; q < idx.length; q += 3) {
        const a = idx[q] * 3, b = idx[q + 1] * 3, c = idx[q + 2] * 3;
        const x = (pos[a] + pos[b] + pos[c]) / 3;
        const y = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3;
        const z = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
        n++;
        const h = F.asphaltAt(x, z, y, 0.6);
        // (On the asphalt, 0.02 to 0.2 m over it; no kerb or other line there.)
        const off = h !== h ? 1 : y - h < 0.02 ? 0.02 - (y - h) : y - h > 0.2 ? y - h - 0.2 : 0;
        const other = F.lineAt(x, z, y, 0.3);
        if (off > 0 || other) pts.push({ x: +x.toFixed(1), z: +z.toFixed(1), y: +y.toFixed(1), value: +Math.max(off, other ? 0.01 : 0).toFixed(2), on: other ?? (h !== h ? 'no asphalt' : 'height') });
      }
    }
    const bad = F.places(pts, 3);
    return { samples: n, bad: bad.length, boxes: D.yBoxes.length, worst: all ? bad : bad.slice(0, 20), unit: 'm' };
  };
})();
