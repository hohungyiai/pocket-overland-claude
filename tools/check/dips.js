// In-page check (run with ?debug): a flyover stays up. Every flyover deck is
// at least MIN m above the ground along its whole length: it never dips to
// road level and climbs again. (The roads that lead up to it do the
// climbing; the deck itself is all in the air.)
window.__checkDips = (all = false) => {
  const d = globalThis.__osm;
  const MIN = 4.5;
  const bad = [];
  let n = 0;
  d.edges.forEach((e, i) => {
    if (!d.elevated[i]) return;
    const P = d.EP[i];
    const Y = d.deckY(i);
    let low = Infinity, at = 0;
    for (let k = 0; k < P.length; k++) {
      n++;
      const rel = Y[k] - d.baseAt(P[k][0], P[k][1]);
      if (rel < low) (low = rel), (at = k);
    }
    if (low < MIN) bad.push({ road: e.name || e.cls, i, s: Math.round(d.ECUM[i][at]), x: Math.round(P[at][0]), z: Math.round(P[at][1]), height: +low.toFixed(2), over: +(MIN - low).toFixed(2) });
  });
  bad.sort((a, b) => b.over - a.over);
  return { samples: n, bad: bad.length, worst: all ? bad : bad.slice(0, 40) };
};
