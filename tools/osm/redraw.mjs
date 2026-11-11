#!/usr/bin/env node
// Road redraw (trial): decides what the road network should be before the
// game builds it. Reads a map the importer wrote and writes another in the
// same format, so the builder needs to know nothing about it.
//
//   node tools/osm/redraw.mjs <in.json> <out.json> [--box x0,x1,z0,z1] [--steps lanes]
//
// Steps (each can be left out, to measure what it buys):
//   lanes  service lanes that lead nowhere are dropped. A service lane is
//          kept only where it is the quickest way between two roads: a run
//          of lanes between two proper roads that is shorter than 2/3 of
//          the way round by those roads. Car park aisles, driveways and
//          loops off one street go.
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
  console.error('usage: redraw.mjs <in.json> <out.json> [--box x0,x1,z0,z1] [--steps lanes]');
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
const outEdges = edges.map(({ len, ...e }) => ({ ...e, a: idFor(e.a), b: idFor(e.b) }));
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
