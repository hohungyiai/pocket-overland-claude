// In-page checks (run with ?debug) on the sides of raised roads, as drawn:
// the walls and parapets that stand along them (finish.js indexes them).
//
// __checkOpenEdges: wherever a road's surface stands well above the ground
//   beside it (a deck, a raised road whose bank was cut short, the paving of
//   a joint between them) and nothing drivable carries on past its edge, a
//   parapet stands along that edge. Followed along every raised road and
//   round the outline of every junction and split nose: a deck's fork whose
//   edge was left open, or a parapet that stops short of the joint, shows.
// __checkWallEnds: a wall or parapet beside a road on the ground (its bank)
//   never begins or ends as a square stub standing on the verge: where it
//   stops, it has come down to the ground (or carries straight on into
//   another wall or a bridge's own side).

/** Every upright sheet, bucketed on a 4 m grid: crosses(x0, z0, x1, z1, y) is there one whose top stands at least 0.6 m over y, across that segment? */
window.__sheetIndex = () => {
  if (window.__shIdx) return window.__shIdx;
  const F = window.__finishIndex();
  const C = 4;
  const grid = new Map();
  F.sheets.forEach((s, i) => {
    const x0 = Math.min(s.x0, s.x1), x1 = Math.max(s.x0, s.x1), z0 = Math.min(s.z0, s.z1), z1 = Math.max(s.z0, s.z1);
    for (let a = Math.floor(x0 / C); a <= Math.floor(x1 / C); a++)
      for (let b = Math.floor(z0 / C); b <= Math.floor(z1 / C); b++) {
        const k = a * 100003 + b;
        (grid.get(k) ?? grid.set(k, []).get(k)).push(i);
      }
  });
  const near = (x0, z0, x1, z1) => {
    const out = new Set();
    for (let a = Math.floor(Math.min(x0, x1) / C); a <= Math.floor(Math.max(x0, x1) / C); a++)
      for (let b = Math.floor(Math.min(z0, z1) / C); b <= Math.floor(Math.max(z0, z1) / C); b++) for (const i of grid.get(a * 100003 + b) ?? []) out.add(i);
    return out;
  };
  const cross = (ax, az, bx, bz, cx, cz, dx, dz) => {
    const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
    const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
    const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
    return d1 * d2 <= 0 && d3 * d4 <= 0;
  };
  const crosses = (x0, z0, x1, z1, y) => {
    for (const i of near(x0, z0, x1, z1)) {
      const s = F.sheets[i];
      if (s.hi < y + 0.6 || s.lo > y + 0.3) continue;
      if (cross(x0, z0, x1, z1, s.x0, s.z0, s.x1, s.z1)) return true;
    }
    return false;
  };
  return (window.__shIdx = { crosses, near });
};

window.__checkOpenEdges = (all = false) => {
  const d = globalThis.__osm;
  const F = window.__finishIndex();
  const S = window.__sheetIndex();
  const DROP = 1.2; // a fall the car must not go over (a kerb's worth is nothing)
  const pts = [];
  let n = 0;
  // (Something drivable carries on past the edge: another road, a junction, a wedge.)
  const goesOn = (x, z, y) => F.asphaltAt(x, z, y, 0.6) === F.asphaltAt(x, z, y, 0.6);
  const test = (x, z, nx, nz, y, inner) => {
    // (From just inside the edge to a metre past it.)
    const ox = x + nx * 1.0, oz = z + nz * 1.0;
    if (goesOn(ox, oz, y) || goesOn(x + nx * 2, z + nz * 2, y)) return;
    if (y - d.heightAt(ox, oz) < DROP) return;
    n++;
    if (!S.crosses(x - nx * inner, z - nz * inner, ox, oz, y)) pts.push({ x: +x.toFixed(1), z: +z.toFixed(1), y: +y.toFixed(1), value: +(y - d.heightAt(ox, oz)).toFixed(2) });
  };
  F.walk(1, (i, s, x, z, tx, tz, y, half) => {
    if (!d.hasProfile[i]) return;
    // (Not past the ends of a road the map's box has cut off.)
    if (x < d.WB.minX + 5 || x > d.WB.maxX - 5 || z < d.WB.minZ + 5 || z > d.WB.maxZ - 5) return;
    // (The surface as drawn there: a road held to the ground's tilt is not at its centre height everywhere.)
    for (const sg of [-1, 1]) {
      const nx = -tz * sg, nz = tx * sg;
      const ex = x + nx * half, ez = z + nz * half;
      const ye = F.asphaltAt(ex - nx * 0.2, ez - nz * 0.2, y, 0.6);
      if (ye !== ye) continue;
      test(ex, ez, nx, nz, ye, 0.3);
    }
  });
  // Round every junction's and island's outline (and so every split nose's).
  const polys = [...d.JX.shapes, ...d.JX.fills];
  for (const sh of polys) {
    const ring = sh.ring;
    for (let a = 0; a < ring.length; a++) {
      const p = ring[a], q = ring[(a + 1) % ring.length];
      const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (L < 0.2) continue;
      const tx = (q[0] - p[0]) / L, tz = (q[1] - p[1]) / L;
      for (let t = 0.5; t < L; t += 1) {
        const x = p[0] + tx * t, z = p[1] + tz * t;
        if (x < d.WB.minX + 5 || x > d.WB.maxX - 5 || z < d.WB.minZ + 5 || z > d.WB.maxZ - 5) continue;
        // (Outward: whichever side is not inside the outline.)
        let nx = tz, nz = -tx;
        const inside = (u, v) => {
          let c = false;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
            if (ring[i][1] > v !== ring[j][1] > v && u < ((ring[j][0] - ring[i][0]) * (v - ring[i][1])) / (ring[j][1] - ring[i][1]) + ring[i][0]) c = !c;
          return c;
        };
        if (inside(x + nx * 0.3, z + nz * 0.3)) (nx = -nx), (nz = -nz);
        // (The paving's own height just inside its edge.)
        const y = F.asphaltAt(x - nx * 0.3, z - nz * 0.3, d.surfaceAt(x, z), 99);
        if (y !== y) continue;
        test(x, z, nx, nz, F.asphaltAt(x - nx * 0.3, z - nz * 0.3, y, 0.6), 0.3);
      }
    }
  }
  const bad = F.places(pts, 4);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: 'm' };
};

window.__checkWallEnds = (all = false) => {
  const d = globalThis.__osm;
  const F = window.__finishIndex();
  // Every upright sheet's ends, and how many sheets share each.
  const key = (x, z) => `${Math.round(x * 20)},${Math.round(z * 20)}`;
  const ends = new Map();
  for (const s of F.sheets) {
    if (s.hi - s.lo < 0.02) continue;
    for (const [x, z] of [[s.x0, s.z0], [s.x1, s.z1]]) {
      const k = key(x, z);
      const o = ends.get(k) ?? { x, z, lo: s.lo, hi: s.hi, n: 0 };
      o.n++;
      o.lo = Math.min(o.lo, s.lo);
      o.hi = Math.max(o.hi, s.hi);
      ends.set(k, o);
    }
  }
  // (A sheet's triangles meet at their shared corners: an end that only one
  // sheet triangle touches, two at most for a quad's two halves, with no
  // other sheet within 0.7 m at its top, is where a wall stops.)
  const S = window.__sheetIndex();
  const pts = [];
  let n = 0;
  for (const o of ends.values()) {
    if (o.n > 2) continue;
    // (On the ground's roads only: a flyover's parapet ends at its deck's end, on purpose.)
    const r = d.roads.nearest ? d.roads.nearest(o.x, o.z, 8) : null;
    if (r && d.isDeck[r.line]) continue;
    if (o.x < d.WB.minX + 5 || o.x > d.WB.maxX - 5 || o.z < d.WB.minZ + 5 || o.z > d.WB.maxZ - 5) continue;
    n++;
    const top = o.hi - d.heightAt(o.x, o.z);
    if (top < 0.3) continue;
    let cont = false;
    for (const i of S.near(o.x - 0.7, o.z - 0.7, o.x + 0.7, o.z + 0.7)) {
      const s = F.sheets[i];
      const dx = s.x1 - s.x0, dz = s.z1 - s.z0, L2 = dx * dx + dz * dz || 1;
      const u = Math.max(0, Math.min(1, ((o.x - s.x0) * dx + (o.z - s.z0) * dz) / L2));
      const px = s.x0 + dx * u, pz = s.z0 + dz * u;
      const dd = Math.hypot(px - o.x, pz - o.z);
      if (dd > 0.02 && dd < 0.7 && s.hi > o.hi - 0.35) {
        cont = true;
        break;
      }
      // (Or the same line of wall carries on past this end, the next piece.)
      if (dd <= 0.02 && Math.min(Math.hypot(s.x0 - o.x, s.z0 - o.z), Math.hypot(s.x1 - o.x, s.z1 - o.z)) > 0.02 && s.hi > o.hi - 0.35) {
        cont = true;
        break;
      }
    }
    if (cont) continue;
    pts.push({ x: +o.x.toFixed(1), z: +o.z.toFixed(1), y: +o.hi.toFixed(1), value: +top.toFixed(2) });
  }
  const bad = F.places(pts, 3);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: 'm' };
};
