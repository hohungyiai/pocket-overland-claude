#!/usr/bin/env node
// Road redraw (trial): decides what the road network should be before the
// game builds it. Reads a map the importer wrote and writes another in the
// same format, so the builder needs to know nothing about it.
//
//   node tools/osm/redraw.mjs <in.json> <out.json> [--box x0,x1,z0,z1] [--steps lanes,join]
//
// Steps (each can be left out, to measure what it buys):
//   lanes  service lanes that lead nowhere are dropped. A service lane is
//          kept only where it is the quickest way between two roads: a run
//          of lanes between two proper roads that is shorter than 2/3 of
//          the way round by those roads. Car park aisles, driveways and
//          loops off one street go.
//   join   where the same road simply carries on through a joint (same
//          class, name, level and direction, nothing else joining), its
//          two pieces become one line, eased through the joint. Where the
//          two differ in width (a lane more or less, never more than
//          double), the line carries its widths along it as `ws`:
//          [fraction of its length where a width starts, width].
//
// --box keeps only the roads (and the buildings, paths and land) that
// touch a box in game metres: a trial area.
//
// Map data © OpenStreetMap contributors, ODbL 1.0.

import fs from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => {
  const k = args.indexOf(`--${name}`);
  return k >= 0 ? args.splice(k, 2)[1] : null;
};
const box = flag('box')?.split(',').map(Number) ?? null;
const steps = new Set((flag('steps') ?? '').split(',').filter(Boolean));
const [IN, OUT] = args;
if (!IN || !OUT) {
  console.error('usage: redraw.mjs <in.json> <out.json> [--box x0,x1,z0,z1] [--steps lanes,join]');
  process.exit(1);
}

const M = JSON.parse(fs.readFileSync(IN, 'utf8'));
const lenOf = (pts) => {
  let l = 0;
  for (let k = 0; k + 1 < pts.length; k++) l += Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
  return l;
};
const report = { in: { pieces: M.edges.length, joints: M.junctions.length } };
let edges = M.edges.map((e) => ({ ...e, len: lenOf(e.pts) }));
const isLane = (e) => e.cls === 'service';

// ---------- lanes ----------
if (steps.has('lanes')) {
  const N = M.junctions.length;
  const roadAt = Array.from({ length: N }, () => []); // proper roads at each joint
  const laneAt = Array.from({ length: N }, () => []);
  edges.forEach((e, i) => {
    const at = isLane(e) ? laneAt : roadAt;
    at[e.a].push(i);
    if (e.b !== e.a) at[e.b].push(i);
  });
  /** Shortest way from a to b over the edges `at` lists, no longer than `cap`; the edges used, or null. */
  const way = (at, a, b, cap, allow) => {
    const dist = new Map([[a, 0]]);
    const via = new Map();
    const open = [[0, a]];
    while (open.length) {
      let m = 0;
      for (let k = 1; k < open.length; k++) if (open[k][0] < open[m][0]) m = k;
      const [d, j] = open.splice(m, 1)[0];
      if (d > (dist.get(j) ?? Infinity)) continue;
      if (j === b) {
        const used = [];
        for (let n = b; n !== a; ) {
          const i = via.get(n);
          used.push(i);
          n = edges[i].a === n ? edges[i].b : edges[i].a;
        }
        return { len: d, used };
      }
      for (const i of at[j]) {
        if (allow && !allow.has(i)) continue;
        const to = edges[i].a === j ? edges[i].b : edges[i].a;
        const nd = d + edges[i].len;
        if (nd > cap || nd >= (dist.get(to) ?? Infinity)) continue;
        dist.set(to, nd);
        via.set(to, i);
        open.push([nd, to]);
      }
    }
    return null;
  };
  // Runs of lanes: lanes joined through joints no proper road touches.
  const run = new Int32Array(edges.length).fill(-1);
  const runs = [];
  edges.forEach((e, i) => {
    if (!isLane(e) || run[i] >= 0) return;
    const id = runs.length;
    const list = [];
    const stack = [i];
    run[i] = id;
    while (stack.length) {
      const k = stack.pop();
      list.push(k);
      for (const j of [edges[k].a, edges[k].b]) {
        if (roadAt[j].length) continue;
        for (const o of laneAt[j])
          if (run[o] < 0) {
            run[o] = id;
            stack.push(o);
          }
      }
    }
    runs.push(list);
  });
  const keep = new Set();
  let through = 0;
  for (const list of runs) {
    const allow = new Set(list);
    const ends = [...new Set(list.flatMap((i) => [edges[i].a, edges[i].b]))].filter((j) => roadAt[j].length);
    for (let p = 0; p < ends.length; p++)
      for (let q = p + 1; q < ends.length; q++) {
        const by = way(laneAt, ends[p], ends[q], Infinity, allow);
        if (!by) continue;
        // Quicker than going round by the roads (which may not connect at all)?
        if (way(roadAt, ends[p], ends[q], by.len * 1.5)) continue;
        through++;
        for (const i of by.used) keep.add(i);
      }
  }
  const before = edges.filter(isLane).length;
  edges = edges.filter((e, i) => !isLane(e) || keep.has(i));
  report.lanes = { runs: runs.length, lanes: before, kept: keep.size, dropped: before - keep.size, through };
}

// ---------- join ----------
if (steps.has('join')) {
  /** Corner cutting (Chaikin), ends kept. */
  const ease = (pts, rounds) => {
    for (let r = 0; r < rounds; r++) {
      const out = [pts[0]];
      for (let k = 0; k + 1 < pts.length; k++) {
        const [ax, az] = pts[k];
        const [bx, bz] = pts[k + 1];
        out.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25], [ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
      }
      out.push(pts[pts.length - 1]);
      pts = out;
    }
    return pts;
  };
  const round = (p) => [+p[0].toFixed(1), +p[1].toFixed(1)];
  const same = (a, b) =>
    a.cls === b.cls && (a.name ?? '') === (b.name ?? '') && (a.lv ?? 0) === (b.lv ?? 0) && (a.one ?? 0) === (b.one ?? 0) && Math.max(a.w, b.w) <= 2 * Math.min(a.w, b.w);
  /** The widths along an edge, as [length, width] spans from its start. */
  const spans = (e) => e.spans ?? [[e.len, e.w]];
  const at = new Map();
  const add = (j, e) => (at.get(j) ?? at.set(j, new Set()).get(j)).add(e);
  for (const e of edges) {
    add(e.a, e);
    add(e.b, e);
  }
  const gone = new Set();
  let joined = 0;
  const todo = [...at.keys()];
  while (todo.length) {
    const j = todo.pop();
    const l = [...(at.get(j) ?? [])];
    if (l.length !== 2) continue;
    let [p, q] = l;
    if (p.a === p.b || q.a === q.b || !same(p, q)) continue;
    // p runs into the joint and q out of it. A one-way road keeps its
    // direction, so two that meet head on (or tail to tail) are not one road.
    if (p.one) {
      if (p.b !== j) [p, q] = [q, p];
      if (p.b !== j || q.a !== j) continue;
    } else {
      for (const [e, end] of [[p, 'b'], [q, 'a']])
        if (e[end] !== j) {
          e.pts.reverse();
          [e.a, e.b] = [e.b, e.a];
          if (e.spans) e.spans.reverse();
        }
    }
    if (p.a === q.b && p.a === j) continue;
    // Eased over the 12 m either side of the joint.
    const k = p.pts.length - 1;
    const pts = [...p.pts, ...q.pts.slice(1)];
    const reach = (from, step) => {
      let run = 0;
      let n = from;
      while (n + step >= 0 && n + step < pts.length && run < 12) {
        run += Math.hypot(pts[n + step][0] - pts[n][0], pts[n + step][1] - pts[n][1]);
        n += step;
      }
      return n;
    };
    const k0 = reach(k, -1);
    const k1 = reach(k, 1);
    p.pts = [...pts.slice(0, k0), ...ease(pts.slice(k0, k1 + 1), 2).map(round), ...pts.slice(k1 + 1)];
    if (p.w !== q.w || p.spans || q.spans) {
      const l = [...spans(p), ...spans(q)];
      // (Spans of one width run together.)
      p.spans = l.reduce((o, sp) => (o.length && o[o.length - 1][1] === sp[1] ? ((o[o.length - 1][0] += sp[0]), o) : (o.push([...sp]), o)), []);
      p.w = Math.max(...p.spans.map((sp) => sp[1]));
      if (p.spans.length === 1) delete p.spans;
    }
    at.get(q.b).delete(q);
    at.get(q.b).add(p);
    at.delete(j);
    p.b = q.b;
    p.len = lenOf(p.pts);
    gone.add(q);
    joined++;
    todo.push(p.a, p.b);
  }
  edges = edges.filter((e) => !gone.has(e));
  report.join = { joined };
}

// ---------- box ----------
const inBox = box ? (p) => p[0] >= box[0] && p[0] <= box[1] && p[1] >= box[2] && p[1] <= box[3] : () => true;
const near = box ? (p) => p[0] >= box[0] - 150 && p[0] <= box[1] + 150 && p[1] >= box[2] - 150 && p[1] <= box[3] + 150 : () => true;
if (box) edges = edges.filter((e) => e.pts.some(inBox));

// ---------- write ----------
// Joints no road uses any more are dropped, and the rest renumbered.
const idOf = new Map();
const junctions = [];
const idFor = (j) => {
  if (!idOf.has(j)) {
    idOf.set(j, junctions.length);
    junctions.push(M.junctions[j]);
  }
  return idOf.get(j);
};
const outEdges = edges.map(({ len, spans, ...e }) => {
  const o = { ...e, a: idFor(e.a), b: idFor(e.b) };
  if (spans) {
    const all = spans.reduce((t, sp) => t + sp[0], 0);
    let run = 0;
    o.ws = spans.map(([l, w]) => {
      const f = +(run / all).toFixed(4);
      run += l;
      return [f, w];
    });
  }
  return o;
});
const touches = (o) => (o.pts ? o.pts.some(near) : near([o.x, o.z]));
const out = {
  ...M,
  junctions,
  edges: outEdges,
  paths: M.paths.filter(touches),
  areas: M.areas.filter(touches),
  waterways: M.waterways.filter(touches),
  rail: M.rail.filter(touches),
  stations: M.stations.filter(touches),
  buildings: M.buildings.filter(touches),
};
fs.writeFileSync(OUT, JSON.stringify(out));
const deg = new Map();
for (const e of outEdges) for (const j of [e.a, e.b]) deg.set(j, (deg.get(j) ?? 0) + 1);
report.out = {
  pieces: outEdges.length,
  lanes: outEdges.filter(isLane).length,
  km: +(edges.reduce((s, e) => s + e.len, 0) / 1000).toFixed(1),
  joints: junctions.length,
  carriesOn: [...deg.values()].filter((d) => d === 2).length,
  junctions: [...deg.values()].filter((d) => d >= 3).length,
  buildings: out.buildings.length,
  paths: out.paths.length,
};
console.log(JSON.stringify(report, null, 1));
