// In-page check (run with ?debug): no pier (MRT viaduct or flyover) stands on a road or path below it.
window.__checkPiers = () => {
  const d = globalThis.__osm;
  const bad = [];
  const piers = d.piers();
  const R = 0.7; // half a pier's width
  for (const p of piers) {
    d.roads.each(p.x, p.z, 24, (i, seg, u, dd) => {
      if (i === p.self) return;
      // Only roads the pier would pass through (on the ground, or a lower deck).
      const y = d.hasProfile[i] ? (() => { const Y = d.deckY(i); return Y[seg] + (Y[Math.min(Y.length - 1, seg + 1)] - Y[seg]) * u; })() : d.heightAt(p.x, p.z);
      if (y >= p.top - 1) return;
      const over = d.EHALF[i] + R - dd;
      if (over > 0) bad.push({ kind: p.kind, road: d.edges[i].name || d.edges[i].cls, x: Math.round(p.x), z: Math.round(p.z), over: +over.toFixed(2) });
    });
  }
  bad.sort((a, b) => b.over - a.over);
  return { samples: piers.length, bad: bad.length, worst: bad.slice(0, 12) };
};
