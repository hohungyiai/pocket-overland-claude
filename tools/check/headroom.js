// In-page check (run with ?debug): every road that passes under another road
// (a flyover deck or a raised ramp) has at least 4.8 m of headroom.
window.__checkHeadroom = (NEED = 4.8) => {
  const d = globalThis.__osm;
  const bad = [];
  let samples = 0;
  const yOn = (o, seg, u, x, z) => {
    if (!d.hasProfile[o]) return d.heightAt(x, z);
    const Y = d.deckY(o);
    return Y[seg] + (Y[Math.min(Y.length - 1, seg + 1)] - Y[seg]) * u;
  };
  const meet = (i, o) => {
    const a = d.edges[i], b = d.edges[o];
    return a.a === b.a || a.a === b.b || a.b === b.a || a.b === b.b;
  };
  d.edges.forEach((e, i) => {
    if (!d.hasProfile[i]) return;
    const P = d.EP[i];
    const Y = d.deckY(i);
    // Underside: a deck's slab, or the whole embankment under a ramp.
    const depthAt = () => (d.elevated[i] ? 1.2 : d.isDeck[i] ? 0.6 : Infinity);
    const seen = new Map();
    for (let k = 0; k < P.length; k++) {
      const [x, z] = P[k];
      d.roads.each(x, z, d.EHALF[i] + 12, (o, seg, u, dd) => {
        if (o === i || meet(i, o)) return;
        // (A joined line is as wide as it is drawn at this place, not its widest.)
        if (dd > d.halfNear(i, k, 0) + d.halfNear(o, seg, u) - 0.3) return;
        const yl = yOn(o, seg, u, x, z);
        if (Y[k] - yl < 0.6) return; // level with it, or o goes over i
        samples++;
        const clear = Y[k] + 0.09 - Math.min(depthAt(k), Y[k] + 0.09 - yl) - yl;
        const over = +(NEED - clear).toFixed(2);
        if (over <= 0) return;
        const prev = seen.get(o);
        if (!prev || prev.over < over)
          seen.set(o, { over, top: d.edges[i].name || d.edges[i].cls, under: d.edges[o].name || d.edges[o].cls, kind: d.isDeck[i] ? (d.elevated[i] ? 'flyover' : 'low deck') : 'ramp', i, o, x: Math.round(x), z: Math.round(z), gap: +(Y[k] - yl).toFixed(2) });
      });
    }
    bad.push(...seen.values());
  });
  bad.sort((a, b) => b.over - a.over);
  return { samples, bad: bad.length, worst: bad.slice(0, 40) };
};

// No two roads cross at the same height: where roads cross on the map
// without sharing a junction, one must pass over the other.
window.__checkCrossings = () => {
  const d = globalThis.__osm;
  const meet = (i, o) => {
    const a = d.edges[i], b = d.edges[o];
    return a.a === b.a || a.a === b.b || a.b === b.a || a.b === b.b;
  };
  const yOn = (o, seg, u, x, z) => {
    if (!d.hasProfile[o]) return d.heightAt(x, z);
    const Y = d.deckY(o);
    return Y[seg] + (Y[Math.min(Y.length - 1, seg + 1)] - Y[seg]) * u;
  };
  const seen = new Map();
  let samples = 0;
  d.edges.forEach((e, i) => {
    if (!d.hasProfile[i] || (e.lv ?? 0) < 0) return;
    const P = d.EP[i];
    const Y = d.deckY(i);
    for (let k = 0; k < P.length; k++) {
      const [x, z] = P[k];
      d.roads.each(x, z, 2, (o, seg, u, dd) => {
        // (Centre lines within 1 m: the roads run through each other.)
        if (o === i || meet(i, o) || dd > 1 || (d.edges[o].lv ?? 0) < 0) return;
        samples++;
        const gap = Math.abs(Y[k] - yOn(o, seg, u, x, z));
        if (gap >= 0.6) return;
        const key = Math.min(i, o) + ',' + Math.max(i, o);
        if (!seen.has(key)) seen.set(key, { a: e.name || e.cls, b: d.edges[o].name || d.edges[o].cls, i, o, x: Math.round(x), z: Math.round(z), gap: +gap.toFixed(2), over: 1 });
      });
    }
  });
  const bad = [...seen.values()];
  return { samples, bad: bad.length, worst: bad.slice(0, 40) };
};
