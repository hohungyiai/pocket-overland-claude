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
//   another wall or a bridge's own side, or ends flush with a road's
//   surface that carries on past it).

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
  // Every upright sheet's ends, and how many sheets share each. (Its top
  // there from the triangle's own corners at that end: a long sheet's top
  // can slope from one end to the other.)
  const key = (x, z) => `${Math.round(x * 20)},${Math.round(z * 20)}`;
  const ends = new Map();
  for (const k of d.farTiles()) {
    const r = d.tileAccs(k).deck;
    if (!r) continue;
    const { pos, idx } = r;
    for (let q = 0; q < idx.length; q += 3) {
      const v = [idx[q] * 3, idx[q + 1] * 3, idx[q + 2] * 3];
      const det = (pos[v[1] + 2] - pos[v[2] + 2]) * (pos[v[0]] - pos[v[2]]) + (pos[v[2]] - pos[v[1]]) * (pos[v[0] + 2] - pos[v[2] + 2]);
      if (Math.abs(det) > 1e-4) continue;
      let best = 0, e0 = 0;
      for (let e = 0; e < 3; e++) {
        const p = v[e], n = v[(e + 1) % 3];
        const l = Math.hypot(pos[n] - pos[p], pos[n + 2] - pos[p + 2]);
        if (l > best) (best = l), (e0 = e);
      }
      if (best < 0.3) continue;
      const ys = v.map((p) => pos[p + 1]);
      if (Math.max(...ys) - Math.min(...ys) < 0.02) continue;
      for (const p of [v[e0], v[(e0 + 1) % 3]]) {
        const x = pos[p], z = pos[p + 2];
        // (The corners of this triangle standing at that end.)
        const at = v.filter((u) => Math.abs(pos[u] - x) < 1e-3 && Math.abs(pos[u + 2] - z) < 1e-3).map((u) => pos[u + 1]);
        const kk = key(x, z);
        const o = ends.get(kk) ?? { x, z, lo: Infinity, hi: -Infinity, n: 0 };
        o.n++;
        o.lo = Math.min(o.lo, ...at);
        o.hi = Math.max(o.hi, ...at);
        ends.set(kk, o);
      }
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
    // (Where it stops at a road's surface, flush with it: the wall's top is
    // that road's edge, and the road carries on past its end.)
    let flush = false;
    for (const [dx, dz] of [[0, 0], [0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4]]) {
      const h = F.asphaltAt(o.x + dx, o.z + dz, o.hi, 0.35);
      if (h === h && o.hi - h < 0.25) flush = true;
    }
    if (flush) continue;
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

// __checkBanks: a raised road (one with a height of its own, not a flyover
// deck) keeps the bank planned for it. The finished ground 1 to 2 m out from
// its edge lies no more than 10 cm below the planned bank (the smooth ground
// with its embankments, surfaceAt, but no higher than the road, sealed 12 cm
// under it as beside every road) wherever nothing else is there to cut it:
// no other road or junction within sealing reach. (The ground sealed under a
// road was held to the height of every piece of that road in reach, so on a
// climbing road the pieces a few metres back down the slope cut its own bank
// into a retaining wall: a kerb raised well above the road.)
window.__checkBanks = (all = false) => {
  const d = globalThis.__osm;
  const F = window.__finishIndex();
  const REACH = 9; // a road's sealing reach past its edge (SEAL + 2 + a margin)
  const shapes = [...d.JX.shapes, ...d.JX.fills];
  const ringD = (ring, x, z) => {
    let inside = false, best = Infinity;
    for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
      const [xa, za] = ring[a], [xb, zb] = ring[b];
      if ((za > z) !== (zb > z) && x < ((xb - xa) * (z - za)) / (zb - za) + xa) inside = !inside;
      const dx = xb - xa, dz = zb - za, L = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - xa) * dx + (z - za) * dz) / L));
      best = Math.min(best, Math.hypot(xa + dx * t - x, za + dz * t - z));
    }
    return inside ? 0 : best;
  };
  const pts = [];
  let n = 0;
  d.edges.forEach((e, i) => {
    if (!d.hasProfile[i] || d.elevated[i] || d.isDeck[i] || d.JX.internal[i]) return;
    const P = d.EP[i], cum = d.ECUM[i], len = cum[cum.length - 1];
    const [ta, tb] = d.trims(i);
    let k = 0;
    for (let s = (ta || 0) + 1; s <= len - (tb || 0) - 1; s += 2) {
      while (k < P.length - 2 && cum[k + 1] <= s) k++;
      const L = cum[k + 1] - cum[k] || 1, u = (s - cum[k]) / L;
      const tx = (P[k + 1][0] - P[k][0]) / L, tz = (P[k + 1][1] - P[k][1]) / L;
      const cx = P[k][0] + (P[k + 1][0] - P[k][0]) * u, cz = P[k][1] + (P[k + 1][1] - P[k][1]) * u;
      const half = d.halfAtE(i, k);
      const Y = d.deckY(i);
      for (const sg of [-1, 1]) {
        for (const o of [1, 2]) {
          const x = cx + tz * sg * (half + o), z = cz - tx * sg * (half + o);
          // (Nothing else in reach: no other road, no junction.)
          let other = false;
          let near = null;
          // (Another limb of the same road, further along it, counts as another road.)
          d.roads.each(x, z, 30, (line, seg, uu, dd) => {
            if (line === i && (!near || dd < near.dd)) near = { seg, uu, dd };
            if (other || d.elevated[line] || dd >= d.halfAtE(line, seg) + REACH) return;
            const C = d.ECUM[line];
            if (line !== i || Math.abs(C[seg] + (C[seg + 1] - C[seg]) * uu - s) >= 2 * (half + REACH)) other = true;
          });
          if (other || !near) continue;
          // (The road's own height as drawn at its edge, at its point nearest here.)
          const A = P[near.seg], B = P[near.seg + 1];
          const px = A[0] + (B[0] - A[0]) * near.uu, pz = A[1] + (B[1] - A[1]) * near.uu;
          const hn = d.halfAtE(i, near.seg), ex = (x - px) / near.dd, ez = (z - pz) / near.dd;
          const ye = F.asphaltAt(px + ex * (hn - 0.3), pz + ez * (hn - 0.3), Y[near.seg] + (Y[near.seg + 1] - Y[near.seg]) * near.uu + 0.09, 1);
          if (ye !== ye) continue;
          if (shapes.some((sh) => Math.hypot(x - sh.centre[0], z - sh.centre[1]) < sh.radius + REACH + 2 && ringD(sh.ring, x, z) < REACH)) continue;
          n++;
          // (The bank as planned, but never above the road: where the hills
          // stand higher, the ground is cut down to the road on purpose.
          // Sealed, it lies UNDER below the road's own height, 0.21 m below
          // its drawn surface.)
          const want = Math.min(d.surfaceAt(x, z), ye - 0.09) - 0.12;
          const cut = want - d.heightAt(x, z);
          if (cut > 0.1) pts.push({ road: e.name || e.cls, i, x: +x.toFixed(1), z: +z.toFixed(1), value: +cut.toFixed(2) });
        }
      }
    }
  });
  const bad = F.places(pts, 6);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40), unit: 'm' };
};
