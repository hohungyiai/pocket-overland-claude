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

window.__checkStations = () => {
  const g = window.game;
  const d = globalThis.__osm;
  const bad = [];
  const stations = g.course.fuel ?? [];
  for (const s of stations) {
    let nearest = Infinity;
    d.roads.each(s.x, s.z, s.r + 40, (i, seg, u, dd) => {
      nearest = Math.min(nearest, dd - d.halfNear(i, seg, u));
    });
    // The fill-up zone reaches r + 6 m from the middle: a road's paving must be inside it.
    const over = nearest - (s.r + 6);
    if (over > 0) bad.push({ station: s.name, x: s.x, z: s.z, over: +over.toFixed(1) });
  }
  if (!stations.length) bad.push({ field: 'no petrol stations on the map', over: 1 });
  return { samples: stations.length, bad: bad.length, worst: bad };
};
