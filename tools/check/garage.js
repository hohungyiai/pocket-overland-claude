// In-page check (run with ?debug): the garage bays (src/garage.ts) lie on a
// road the car can drive along, wholly on its paving, and a car parked in
// the bay is offered the garage.
window.__checkGarageBay = () => {
  const g = window.game;
  const d = globalThis.__osm;
  const bad = [];
  const BAY_W = 3.4;
  const BAY_L = 6.5;
  for (const b of g.garages.here) {
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
    if (g.garages.at(b.x, b.z)?.id !== b.id) bad.push({ garage: b.id, field: 'a car in the bay is not offered the garage', over: 1 });
  }
  return { samples: g.garages.here.length * 6, bad: bad.length, worst: bad };
};
