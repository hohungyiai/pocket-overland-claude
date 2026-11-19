// In-page check (run with ?debug): the garage bays (src/garage.ts) lie on a
// road the car can drive along, wholly on its paving, and a car parked in
// the bay is offered the garage. Nothing stands over it or its approach.
window.__checkGarageBay = async () => {
  const g = window.game;
  const d = globalThis.__osm;
  const bad = [];
  const BAY_W = 3.4;
  const BAY_L = 6.5;
  for (const b of g.garages.here) {
    g.course.prepareAt?.(b.x, b.z);
    g.car.placeAt({ x: b.x - 40 * Math.cos(b.yaw), y: g.course.surfaceY(b.x - 40 * Math.cos(b.yaw), b.z + 40 * Math.sin(b.yaw), 999), z: b.z + 40 * Math.sin(b.yaw) }, b.yaw);
    for (const t0 = performance.now(); g.course.solidAt && !g.course.solidAt(b.x, b.z) && performance.now() - t0 < 90000; ) await new Promise((r) => setTimeout(r, 50));
    // (One physics step: rays only meet what the world has taken in.)
    g.world.step();
    // Every corner and the middle of the bay on a road's paving.
    const c = Math.cos(b.yaw);
    const s = Math.sin(b.yaw);
    for (const [u, v] of [[0, 0], [-BAY_L / 2, -BAY_W / 2], [BAY_L / 2, -BAY_W / 2], [-BAY_L / 2, BAY_W / 2], [BAY_L / 2, BAY_W / 2]]) {
      const x = b.x + u * c + v * s;
      const z = b.z - u * s + v * c;
      let inside = -Infinity;
      d.roads.each(x, z, 20, (i, seg, uu, dd) => {
        inside = Math.max(inside, d.halfNear(i, seg, uu) - dd);
      });
      if (inside < 0) bad.push({ garage: b.id, corner: [u, v], x: +x.toFixed(1), z: +z.toFixed(1), over: +(-inside).toFixed(2) });
    }
    // Nothing standing over the bay or the 15 m of road leading into it (a
    // tree, a post): a ray down meets the road first.
    for (let u = -BAY_L / 2 - 15; u <= BAY_L / 2; u += 1.5)
      for (const v of [-BAY_W / 2 + 0.3, 0, BAY_W / 2 - 0.3]) {
        const x = b.x + u * c + v * s;
        const z = b.z - u * s + v * c;
        const y0 = g.course.heightAt(x, z);
        const hit = g.world.castRay(new g.RAPIER.Ray({ x, y: y0 + 12, z }, { x: 0, y: -1, z: 0 }), 20, true, undefined, undefined, undefined, g.car.body);
        const top = hit ? y0 + 12 - hit.timeOfImpact : -Infinity;
        if (top === -Infinity) bad.push({ garage: b.id, field: 'no ground under the bay', x: +x.toFixed(1), z: +z.toFixed(1), over: 1 });
        else if (top - y0 > 0.6) bad.push({ garage: b.id, field: 'something stands over the bay or its approach', x: +x.toFixed(1), z: +z.toFixed(1), over: +(top - y0).toFixed(2) });
        else if (Math.abs(g.course.surfaceAt?.(x, z, y0)?.name === 'Asphalt' ? 0 : 1)) bad.push({ garage: b.id, field: 'the bay or its approach is not paved', x: +x.toFixed(1), z: +z.toFixed(1), over: 1 });
      }
    if (g.garages.at(b.x, b.z)?.id !== b.id) bad.push({ garage: b.id, field: 'a car in the bay is not offered the garage', over: 1 });
  }
  return { samples: g.garages.here.length * 6, bad: bad.length, worst: bad };
};
