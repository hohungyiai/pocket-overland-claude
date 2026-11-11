// In-page checks (run with ?debug) on the shaped junctions. Called from tools/check/run.cjs.
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
  const ringDist = (ring, x, z) => {
    let best = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, az] = ring[j];
      const abx = ring[i][0] - ax;
      const abz = ring[i][1] - az;
      let u = ((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz || 1);
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      best = Math.min(best, Math.hypot(ax + abx * u - x, az + abz * u - z));
    }
    return best;
  };
  const near = (shapes) => {
    const g = new Map();
    for (const s of shapes) {
      const k = Math.floor(s.centre[0] / 100) * 100003 + Math.floor(s.centre[1] / 100);
      (g.get(k) ?? g.set(k, []).get(k)).push(s);
    }
    return (x, z) => {
      const out = [];
      const i = Math.floor(x / 100);
      const j = Math.floor(z / 100);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) out.push(...(g.get((i + a) * 100003 + j + b) ?? []));
      return out;
    };
  };
  // Is road `line` drawn at this point of segment seg (not cut away inside a junction)?
  const drawn = (line, seg, u) => {
    const { ECUM, JX, edges } = d();
    if (JX.internal[line]) return false;
    const c = ECUM[line];
    const s = c[seg] + (c[seg + 1] - c[seg]) * u;
    return s >= JX.trimA[line] && s <= c[c.length - 1] - JX.trimB[line];
  };

  /** No two junctions overlap. */
  window.__checkJunctionOverlap = () => {
    const { JX } = d();
    const nb = near(JX.shapes);
    const bad = [];
    let n = 0;
    for (const s of JX.shapes)
      for (const [x, z] of s.ring) {
        n++;
        for (const o of nb(x, z)) {
          if (o === s || Math.hypot(x - o.centre[0], z - o.centre[1]) > o.radius) continue;
          if (inside(o.ring, x, z)) {
            const over = ringDist(o.ring, x, z);
            if (over > 0.3) bad.push({ x: Math.round(x), z: Math.round(z), over: +over.toFixed(2) });
          }
        }
      }
    bad.sort((a, b) => b.over - a.over);
    return { samples: n, bad: bad.length, worst: bad.slice(0, 12) };
  };

  /** No kerb runs across a road that is drawn there. */
  window.__checkKerbAcross = () => {
    const { JX, roads, EHALF, edges, isDeck } = d();
    const bad = [];
    let n = 0;
    for (const s of JX.shapes)
      for (const F of s.kerbs)
        for (let q = 0; q < F.length; q++) {
          const a = F[Math.max(0, q - 1)];
          const b = F[Math.min(F.length - 1, q + 1)];
          const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          // The kerb's middle, just outside the junction's edge.
          const x = F[q][0] + ((b[1] - a[1]) / tl) * 0.05;
          const z = F[q][1] - ((b[0] - a[0]) / tl) * 0.05;
          n++;
          roads.each(x, z, 16, (line, seg, u, dd) => {
            const over = d().halfNear(line, seg, u) - 0.3 - dd;
            if (over > 0 && !isDeck[line] && drawn(line, seg, u)) bad.push({ road: edges[line].name || edges[line].cls, x: Math.round(x), z: Math.round(z), over: +over.toFixed(2) });
          });
        }
    bad.sort((a, b) => b.over - a.over);
    return { samples: n, bad: bad.length, worst: bad.slice(0, 12) };
  };

  /** A junction stays on its roads: every point of its edge is within a corner's reach of one. */
  window.__checkJunctionSpill = () => {
    const { JX, roads, EHALF } = d();
    const bad = [];
    let n = 0;
    for (const s of JX.shapes)
      for (const [x, z] of s.ring) {
        n++;
        let best = Infinity;
        roads.each(x, z, 30, (line, seg, u, dd) => (best = Math.min(best, dd - d().halfNear(line, seg, u))));
        const over = best - 5.5; // as far as a junction may reach (SPILL in src/world/junctions.ts)
        if (over > 0) bad.push({ x: Math.round(x), z: Math.round(z), over: +over.toFixed(2) });
      }
    bad.sort((a, b) => b.over - a.over);
    return { samples: n, bad: bad.length, worst: bad.slice(0, 12) };
  };

  /** The ground never shows through a junction. */
  window.__checkJunctionGround = () => {
    const D = d();
    const S = 4, X0 = -3600, Z0 = -3600;
    const at = (i, j) => D.heightAt(X0 + i * S, Z0 + j * S);
    const meshAt = (x, z) => {
      const fx = (x - X0) / S, fz = (z - Z0) / S;
      const i = Math.floor(fx), j = Math.floor(fz);
      const u = fx - i, v = fz - j;
      if (u + v <= 1) return at(i, j) + (at(i + 1, j) - at(i, j)) * u + (at(i, j + 1) - at(i, j)) * v;
      return at(i + 1, j + 1) + (at(i, j + 1) - at(i + 1, j + 1)) * (1 - u) + (at(i + 1, j) - at(i + 1, j + 1)) * (1 - v);
    };
    const bad = [];
    let n = 0;
    // (A paved island sits level with the roads round it.)
    // (Each junction's paving as drawn: a paved island level with the roads
    // round it, a junction among ramps blended between their heights.)
    const top = (s, x, z) => (s.fillOf !== undefined ? D.fillTop(s.fillOf, x, z) : D.jTop(s.shapeOf, x, z));
    for (const s of [...D.JX.shapes.map((sh, k) => ({ ...sh, shapeOf: k })), ...D.JX.fills.map((f, k) => ({ ...f, fillOf: k }))]) {
      const [cx, cz] = s.centre;
      for (const [px, pz] of s.ring)
        for (const t of [0, 0.2, 0.5, 0.8, 0.97]) {
          const x = cx + (px - cx) * t;
          const z = cz + (pz - cz) * t;
          if (Math.abs(x) > 3596 || Math.abs(z) > 3596) continue;
          n++;
          const over = meshAt(x, z) - (top(s, x, z) + 0.09) - 0.02;
          if (over > 0) bad.push({ x: Math.round(x), z: Math.round(z), over: +over.toFixed(2) });
        }
    }
    bad.sort((a, b) => b.over - a.over);
    return { samples: n, bad: bad.length, worst: bad.slice(0, 12) };
  };

  /**
   * A junction is paved where its roads run, and a corner's reach beyond:
   * nowhere does its paving lie more than 5.5 m from the edge of a road that
   * meets there (SPILL in src/world/junctions.ts). Asked of the whole
   * paving on a 1 m grid, not of the outline's corners: a straight side
   * between two mouths has no corner in its middle, and the ground three
   * roads enclose (a traffic island) lies inside every side.
   */
  window.__checkJunctionReach = (all = false, REACH = 5.5) => {
    const { JX, roads, EHALF, halfAtE, edges } = d();
    const bad = [];
    let n = 0;
    for (let k = 0; k < JX.shapes.length; k++) {
      const s = JX.shapes[k];
      const own = new Set([...s.mouths.map((m) => m.line), ...s.internal]);
      const reach = 40;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [x, z] of s.ring) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
      let worst = 0, wx = 0, wz = 0, deep = 0;
      for (let x = Math.floor(x0) + 0.5; x < x1; x++)
        for (let z = Math.floor(z0) + 0.5; z < z1; z++) {
          if (!inside(s.ring, x, z)) continue;
          n++;
          // (A road counts at its width where the point is: widths taper.)
          let best = Infinity;
          roads.each(x, z, reach, (line, seg, _u, dd) => {
            if (own.has(line)) best = Math.min(best, dd - Math.max(halfAtE(line, seg), halfAtE(line, seg + 1)));
          });
          if (best > REACH) deep++;
          if (best > worst) {
            worst = best;
            wx = x;
            wz = z;
          }
        }
      if (worst > REACH) {
        const road = edges[s.mouths.reduce((m, q) => (q.half > m.half ? q : m), s.mouths[0]).line];
        bad.push({ road: road.name || road.cls, shape: k, x: wx, z: wz, m2: deep, over: +(worst === Infinity ? 99 : worst - REACH).toFixed(2) });
      }
    }
    bad.sort((a, b) => b.over - a.over);
    return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40) };
  };
})();
