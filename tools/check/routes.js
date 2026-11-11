// In-page check (run with ?debug, after bot.js): the drive bot drives a few
// routes that once stopped the car, from a standstill, and must get through.
// (Edge numbers are the road plan's, from the OSM data in data/osm.)
window.__checkRoutes = async () => {
  const ROUTES = [
    // Upper Changi Road North up the slip road onto the Tampines Viaduct (TPE).
    ['Upper Changi Rd North slip road to the TPE viaduct', [[1413, 13, 'end'], [9966, 0, 80]]],
  ];
  const d = globalThis.__osm;
  const bad = [];
  // (These routes are the main map's: another course has no such roads, and the random trips cover it.)
  if ((new URLSearchParams(location.search).get('course') ?? 'pasirris') !== 'pasirris') return { samples: 0, bad: 0, worst: [] };
  for (const [name, route] of ROUTES) {
    const r = await window.__driveRoute(route.map(([i, a, b]) => [i, a === 'end' ? d.ELEN[i] : a, b === 'end' ? d.ELEN[i] : b]), { timeout: 40 });
    if (!r.done) bad.push({ route: name, stuck: r.stuck ?? 'timeout', at: `${r.at} of ${r.total} m`, over: 1 });
  }
  return { samples: ROUTES.length, bad: bad.length, worst: bad };
};
