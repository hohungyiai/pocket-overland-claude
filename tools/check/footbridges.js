// In-page checks (run with ?debug) for footbridges lifted over roads.
// 1. Headroom: every road passing under a lifted footbridge has at least
//    4.8 m clear below its deck.
// 2. Nothing stands on a road: no footbridge pier, and no flight of stairs,
//    comes down onto a road below.
window.__checkFootHeadroom = () => {
  const d = globalThis.__osm;
  const bad = [];
  let n = 0;
  const DEPTH = 0.4; // deck thickness
  d.paths.forEach((p, line) => {
    const top = d.footTop[line];
    if (!(top === top)) return;
    for (const [x, z] of p.pts) {
      d.roads.each(x, z, 24, (i, seg, u, dd) => {
        if (dd > d.halfNear(i, seg, u) + d.PHALF[line]) return;
        const Y = d.hasProfile[i] ? d.deckY(i) : null;
        const y = Y ? Y[seg] + (Y[Math.min(Y.length - 1, seg + 1)] - Y[seg]) * u : d.heightAt(x, z);
        if (y > top) return; // a flyover above the footbridge
        n++;
        const over = 4.8 - (top - DEPTH - y);
        if (over > 0.01) bad.push({ road: d.edges[i].name || d.edges[i].cls, i, path: line, x: Math.round(x), z: Math.round(z), over: +over.toFixed(2) });
      });
    }
  });
  bad.sort((a, b) => b.over - a.over);
  return { samples: n, bad: bad.length, worst: bad.slice(0, 12) };
};
window.__checkFootSupports = () => {
  const d = globalThis.__osm;
  const bad = [];
  let n = 0;
  const onRoad = (x, z, top, r, what) => {
    n++;
    d.roads.each(x, z, 24, (i, seg, u, dd) => {
      const Y = d.hasProfile[i] ? d.deckY(i) : null;
      const y = Y ? Y[seg] + (Y[Math.min(Y.length - 1, seg + 1)] - Y[seg]) * u : d.heightAt(x, z);
      if (y >= top - 1) return;
      const over = d.halfNear(i, seg, u) + r - dd;
      if (over > 0) bad.push({ what, road: d.edges[i].name || d.edges[i].cls, i, x: Math.round(x), z: Math.round(z), over: +over.toFixed(2) });
    });
  };
  for (const q of d.footPiers) onRoad(q.x, q.z, q.top, 0.3, 'pier');
  for (const s of d.footStairs) {
    const run = Math.hypot(s.x1 - s.x0, s.z1 - s.z0);
    for (let t = 0; t <= run; t += 1) onRoad(s.x0 + ((s.x1 - s.x0) * t) / run, s.z0 + ((s.z1 - s.z0) * t) / run, s.top, 1.1, 'stairs');
  }
  bad.sort((a, b) => b.over - a.over);
  return { samples: n, bad: bad.length, worst: bad.slice(0, 12) };
};
