// In-page checks (run with ?debug): fuel (src/fuel.ts).
// Never stranded: with an empty tank the car still climbs the steepest
// slip road on the map (Upper Changi Road North onto the TPE viaduct),
// at a crawl. And every petrol station can be filled up at: a road runs
// through its forecourt.
window.__checkFuelCrawl = async () => {
  const g = window.game;
  const d = globalThis.__osm;
  if ((new URLSearchParams(location.search).get('course') ?? 'pasirris') !== 'pasirris') return { samples: 0, bad: 0, worst: [] };
  const was = [g.fuel.level, g.car.crawl];
  g.fuel.level = 0;
  // (The drive bot runs the car ahead of the clock, past the frame that sets this.)
  g.car.crawl = 5.5;
  const r = await window.__driveRoute([[1413, 13, d.ELEN[1413]], [9966, 0, 80]], { timeout: 90 });
  [g.fuel.level, g.car.crawl] = was;
  const bad = [];
  if (!r.done) bad.push({ route: 'empty tank up the slip road to the TPE viaduct', stuck: r.stuck ?? 'timeout', at: `${r.at} of ${r.total} m`, over: 1 });
  const top = Math.max(0, ...(r.log ?? []).map((l) => l[4]));
  if (top > 6) bad.push({ field: 'crawl faster than 20 km/h', top, over: +(top - 6).toFixed(2) });
  return { samples: 1, bad: bad.length, worst: bad, note: `top speed ${(top * 3.6).toFixed(0)} km/h` };
};

// Every petrol station is a place you can drive into and fill up at, and
// only there: its forecourt is built (paved, solid, flush with the lane
// onto it: no step anywhere on it), a road or lane runs onto it, it stays
// clear of the kerbed roads beside it, and the pump works on the forecourt
// and nowhere off it.
window.__checkStations = async () => {
  const g = window.game;
  const d = globalThis.__osm;
  const bad = [];
  const stations = g.course.fuel ?? [];
  let samples = 0;
  const inRing = (x, z, P) => {
    let c = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const [ax, az] = P[i];
      const [bx, bz] = P[j];
      if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) c = !c;
    }
    return c;
  };
  let gapDir = [1, 0];
  const gap = (x, z, P) => {
    let best = Infinity;
    for (let i = 0; i < P.length; i++) {
      const [ax, az] = P[i];
      const [bx, bz] = P[(i + 1) % P.length];
      const dx = bx - ax;
      const dz = bz - az;
      const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      const d = Math.hypot(ax + dx * u - x, az + dz * u - z);
      if (d < best) {
        best = d;
        gapDir = [dx, dz];
      }
    }
    return best;
  };
  const deg = new Map();
  for (const e of d.edges) for (const j of [e.a, e.b]) deg.set(j, (deg.get(j) ?? 0) + 1);
  for (const s of stations) {
    const P = s.pts;
    if (!P?.length) {
      bad.push({ station: s.name, sx: Math.round(s.x), x: s.x, z: s.z, field: 'no forecourt outline', over: 1 });
      continue;
    }
    // Drive up to it (the car on the road beside it), and let it build
    // once the ground and lanes round it are.
    const sp = g.course.safeSpot(s.x, s.z);
    g.course.prepareAt?.(s.x, s.z);
    g.car.placeAt({ x: sp.x, y: g.course.surfaceY(sp.x, sp.z, 999), z: sp.z }, sp.yaw);
    const ready = (x, z) => !g.course.solidAt || g.course.solidAt(x, z);
    for (const t0 = performance.now(); !P.every(([x, z]) => ready(x, z)) && performance.now() - t0 < 90000; ) await new Promise((r) => setTimeout(r, 50));
    g.world.step();
    for (let k = 0; k < 2; k++) g.stations.settle(
      (x, z) => g.course.heightAt(x, z),
      ready,
      (x, z) => {
        const hit = g.world.castRay(new g.RAPIER.Ray({ x, y: g.course.heightAt(x, z) + 6, z }, { x: 0, y: -1, z: 0 }), 12, true, undefined, undefined, undefined, g.car.body);
        return hit ? { y: g.course.heightAt(x, z) + 6 - hit.timeOfImpact, ground: hit.collider.shape.type === g.RAPIER.ShapeType.HeightField } : null;
      },
      (x, z) => g.course.safeSpot?.(x, z) ?? null,
    );
    if (!s.canopy) {
      bad.push({ station: s.name, sx: Math.round(s.x), x: s.x, z: s.z, field: 'forecourt never built', over: 1 });
      continue;
    }
    // (One physics step: rays only meet what the world has taken in.)
    g.world.step();
    const c = s.canopy;
    const ang = Math.atan2(...(() => { // (the canopy's long way, as station.ts worked it out)
      let sxx = 0, szz = 0, sxz = 0;
      const cx = P.reduce((t, p) => t + p[0], 0) / P.length;
      const cz = P.reduce((t, p) => t + p[1], 0) / P.length;
      for (const [x, z] of P) { sxx += (x - cx) ** 2; szz += (z - cz) ** 2; sxz += (x - cx) * (z - cz); }
      const a = 0.5 * Math.atan2(2 * sxz, sxx - szz);
      return [Math.sin(a), Math.cos(a)];
    })());
    const underIsland = (x, z) => {
      const u = (x - c.x) * Math.cos(ang) + (z - c.z) * Math.sin(ang);
      const v = -(x - c.x) * Math.sin(ang) + (z - c.z) * Math.cos(ang);
      return Math.abs(u) < c.L / 2 + 0.5 && Math.abs(v) < 1.5;
    };
    let onRoad = 0;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of P) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    for (let x = minX + 1; x < maxX; x += 3)
      for (let z = minZ + 1; z < maxZ; z += 3) {
        if (!inRing(x, z, P)) continue;
        // (Not right at the edge: the kerb's own 1 m.)
        if (P.some((p, i) => { const q = P[(i + 1) % P.length]; const dx = q[0] - p[0], dz = q[1] - p[1]; const u = Math.max(0, Math.min(1, ((x - p[0]) * dx + (z - p[1]) * dz) / (dx * dx + dz * dz || 1))); return Math.hypot(p[0] + dx * u - x, p[1] + dz * u - z) < 1; })) continue;
        samples++;
        const y0 = g.course.heightAt(x, z);
        // Paved.
        const surf = g.course.surfaceAt?.(x, z, y0)?.name;
        if (surf && surf !== 'Asphalt') bad.push({ station: s.name, sx: Math.round(s.x), x: +x.toFixed(1), z: +z.toFixed(1), field: `surface is ${surf}`, over: 1 });
        // Solid, nothing standing on it, and flush: no step where a lane
        // runs onto it (the height never jumps 3 cm in 10 cm: a slope, never a lip).
        const onShop = (px, pz) => (s.shops ?? []).some(([bx, bz, br]) => Math.hypot(px - bx, pz - bz) < br + 1);
        if (!underIsland(x, z) && !onShop(x, z)) {
          const topAt = (px, pz) => {
            const hit = g.world.castRay(new g.RAPIER.Ray({ x: px, y: y0 + 12, z: pz }, { x: 0, y: -1, z: 0 }), 20, true, undefined, undefined, undefined, g.car.body);
            return hit ? y0 + 12 - hit.timeOfImpact : -Infinity;
          };
          const top = topAt(x, z);
          // (Against the ground as built, under it: the map's own height can
          // stand a little off that, here and there.)
          let gy = y0;
          g.world.intersectionsWithRay(new g.RAPIER.Ray({ x, y: y0 + 12, z }, { x: 0, y: -1, z: 0 }), 20, true, (hit) => {
            if (hit.collider.shape.type === g.RAPIER.ShapeType.HeightField) gy = y0 + 12 - hit.timeOfImpact;
            return true;
          });
          const off = top - (gy + 0.2);
          if (off < -0.12 || off > 0.6) bad.push({ station: s.name, sx: Math.round(s.x), x: +x.toFixed(1), z: +z.toFixed(1), field: off > 0 ? 'something stands on the forecourt' : 'no solid forecourt', over: +Math.min(9, Math.abs(off)).toFixed(2) });
          else
            for (const [dx, dz] of [[0.1, 0], [-0.1, 0], [0, 0.1], [0, -0.1]]) {
              if (underIsland(x + dx, z + dz) || onShop(x + dx, z + dz) || !inRing(x + dx, z + dz, P)) continue;
              const next = topAt(x + dx, z + dz);
              if (next - (y0 + 0.2) > 0.6) continue; // (the sign's post)
              const step = Math.abs(next - top);
              if (step > 0.03) {
                bad.push({ station: s.name, sx: Math.round(s.x), x: +x.toFixed(1), z: +z.toFixed(1), field: 'a step in the forecourt (where a lane meets it?)', over: +Math.min(9, step).toFixed(2) });
                break;
              }
            }
        }
        // The pump works here.
        if (g.fuel.at(x, z) !== s) bad.push({ station: s.name, sx: Math.round(s.x), x: +x.toFixed(1), z: +z.toFixed(1), field: 'no pump on the forecourt', over: 1 });
        // A road or lane runs onto it.
        d.roads.each(x, z, 12, (i, seg, u, dd) => {
          if (dd < d.halfNear(i, seg, u)) onRoad++;
        });
      }
    // (Or a lane's middle runs inside it, along its edge.)
    for (const e of d.edges)
      for (let k = 0; !onRoad && k + 1 < e.pts.length; k++) {
        const [ax, az] = e.pts[k];
        const [bx, bz] = e.pts[k + 1];
        if (Math.hypot(ax - s.x, az - s.z) > s.r + 200) break;
        const n = Math.ceil(Math.hypot(bx - ax, bz - az));
        for (let t = 0; t <= n && !onRoad; t++) if (inRing(ax + ((bx - ax) * t) / n, az + ((bz - az) * t) / n, P)) onRoad++;
      }
    if (!onRoad) bad.push({ station: s.name, sx: Math.round(s.x), x: s.x, z: s.z, field: 'no road or lane runs onto the forecourt', over: 1 });
    // A lane that comes to it crosses onto it and ends on it (or goes on to a
    // road): never a stub past its edge, nor a run along the outside of it.
    for (const e of d.edges) {
      if (e.cls !== 'service' || !e.pts.some((p) => Math.hypot(p[0] - s.x, p[1] - s.z) < s.r + 60)) continue;
      let onIt = false;
      for (let k = 0; !onIt && k + 1 < e.pts.length; k++) {
        const [ax, az] = e.pts[k];
        const [bx, bz] = e.pts[k + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az)));
        for (let t = 0; t <= n && !onIt; t++) {
          const x = ax + ((bx - ax) * t) / n;
          const z = az + ((bz - az) * t) / n;
          if (inRing(x, z, P) || gap(x, z, P) <= e.w / 2 + 4) onIt = true;
        }
      }
      if (!onIt) continue;
      // ...and never runs along the outside of its edge: it crosses it.
      let along = 0;
      for (let k = 0; k + 1 < e.pts.length; k++) {
        const [ax, az] = e.pts[k];
        const [bx, bz] = e.pts[k + 1];
        const L = Math.hypot(bx - ax, bz - az);
        const n = Math.max(1, Math.ceil(L * 2));
        for (let t = 0; t < n; t++) {
          const x = ax + ((bx - ax) * t) / n;
          const z = az + ((bz - az) * t) / n;
          samples++;
          // (Alongside: running with its edge, not across it, with the lane's
          // side over the edge or less than 1.5 m of grass from it. Any lane:
          // a station's own, or one passing by.)
          const g = gap(x, z, P);
          const gd = [...gapDir];
          let mouth = false; // (where it meets a public road: its mouth, not a run beside the forecourt)
          d.roads.each(x, z, 20, (i, seg, u, dd) => {
            if (d.edges[i].cls !== 'service' && dd < d.halfNear(i, seg, u) + e.w / 2 + 2) mouth = true;
          });
          // (On it, the forecourt is drawn over the lane; only a side of the
          // lane hanging out past its kerb shows.)
          const nx = -(bz - az) / (L || 1);
          const nz = (bx - ax) / (L || 1);
          const hangs = [1, -1].some((k) => {
            const sx = x + nx * k * (e.w / 2);
            const sz = z + nz * k * (e.w / 2);
            return !inRing(sx, sz, P) || gap(sx, sz, P) < 0.5;
          });
          const near = !mouth && (inRing(x, z, P) ? g < e.w / 2 + 1 && hangs : g <= e.w / 2 + 1.5);
          const cos = Math.abs(gd[0] * (bx - ax) + gd[1] * (bz - az)) / ((Math.hypot(...gd) || 1) * (L || 1));
          if (near && cos > 0.87) {
            along += L / n;
            if (along > 6) {
              bad.push({ station: s.name, sx: Math.round(s.x), x: +x.toFixed(1), z: +z.toFixed(1), field: 'a lane runs along its edge, partly or wholly off it', over: +along.toFixed(1) });
              along = -Infinity;
            }
          } else if (along !== -Infinity) along = 0;
        }
      }
      for (const [j, p] of [[e.a, e.pts[0]], [e.b, e.pts[e.pts.length - 1]]]) {
        samples++;
        if (deg.get(j) === 1 && !inRing(p[0], p[1], P) && gap(p[0], p[1], P) < 15)
          bad.push({ station: s.name, sx: Math.round(s.x), x: +p[0].toFixed(1), z: +p[1].toFixed(1), field: 'a lane near it dead-ends off it', over: 1 });
      }
    }
    // Off the forecourt: no pump, and no forecourt over a kerbed road's paving.
    for (let a = 0; a < 360; a += 5)
      for (let r = 2; r < s.r + 20; r += 1.5) {
        const x = s.x + r * Math.cos((a * Math.PI) / 180);
        const z = s.z + r * Math.sin((a * Math.PI) / 180);
        let kerbed = false;
        d.roads.each(x, z, 20, (i, seg, u, dd) => {
          if (dd < d.halfNear(i, seg, u) && d.edges[i].cls !== 'service' && !d.edges[i].lv) kerbed = true;
        });
        if (!kerbed) continue;
        samples++;
        if (inRing(x, z, P)) bad.push({ station: s.name, sx: Math.round(s.x), x: +x.toFixed(1), z: +z.toFixed(1), field: 'forecourt over a public road', over: 1 });
        if (g.fuel.at(x, z)) bad.push({ station: s.name, sx: Math.round(s.x), x: +x.toFixed(1), z: +z.toFixed(1), field: 'pump works on a public road', over: 1 });
      }
  }
  if (!stations.length) bad.push({ field: 'no petrol stations on the map', over: 1 });
  // (One line per station and fault is plenty.)
  const seen = new Set();
  const worst = bad.filter((b) => { const k = `${b.station}|${b.sx}|${b.field}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { samples, bad: bad.length, worst };
};
