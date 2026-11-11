#!/usr/bin/env node
// Road redraw (trial): decides what the road network should be before the
// game builds it. Reads a map the importer wrote and writes another in the
// same format, so the builder needs to know nothing about it.
//
//   node tools/osm/redraw.mjs <in.json> <out.json> [--box x0,x1,z0,z1] [--steps lanes,corners,pair,join]
//
// Steps (each can be left out, to measure what it buys):
//   lanes  service lanes that lead nowhere are dropped. A service lane is
//          kept only where it is the quickest way between two roads: a run
//          of lanes between two proper roads that is shorter than 2/3 of
//          the way round by those roads. Car park aisles, driveways and
//          loops off one street go.
//   corners  a short slip road that only cuts the corner of a junction (its
//          two ends are joined by two other short roads through one
//          joint) is folded into the junction: the junction gives the
//          turn, and the slip road's own joints stop cutting the roads
//          beside it into pieces. And a narrow one-way lane that leaves a
//          road and rejoins the same road further on, running alongside
//          it (a bus bay, a filter lane), is dropped: the road beside it
//          is the way through.
//   pair   the two sides of a dual carriageway that run close together
//          (one-way, same name and level, opposite ways, no more than 10 m
//          of median between them) become one two-way road down the
//          middle, `med` metres of median inside its width. Each joint on
//          one side gets its opposite number on the other (the far side
//          is cut there if it has none), the two are drawn together into
//          one joint in the middle, and whatever joined either side now
//          joins the one road. Expressways and slip roads stay as drawn.
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
  console.error('usage: redraw.mjs <in.json> <out.json> [--box x0,x1,z0,z1] [--steps lanes,corners,pair,join]');
  process.exit(1);
}

const M = JSON.parse(fs.readFileSync(IN, 'utf8'));
const lenOf = (pts) => {
  let l = 0;
  for (let k = 0; k + 1 < pts.length; k++) l += Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
  return l;
};
const report = { in: { pieces: M.edges.length, joints: M.junctions.length } };
let edges = M.edges.map((e) => ({ ...e, pts: e.pts.map((p) => [...p]), len: lenOf(e.pts) }));
/** Where each joint is (pairing moves some and adds others). */
const pos = M.junctions.map((p) => [...p]);
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

// ---------- corners ----------
if (steps.has('corners')) {
  const SHORT = 60;
  const at = new Map();
  for (const e of edges) for (const j of [e.a, e.b]) (at.get(j) ?? at.set(j, []).get(j)).push(e);
  const other = (e, j) => (e.a === j ? e.b : e.a);
  const gone = new Set();
  for (const e of edges) {
    if (!/_link$/.test(e.cls) || !e.one || e.len > SHORT || e.a === e.b) continue;
    // The way round: one joint, a short road each side of it, on the slip road's level.
    const round = (at.get(e.a) ?? []).some(
      (f) =>
        f !== e && !gone.has(f) && f.len <= SHORT && (f.lv ?? 0) === (e.lv ?? 0) &&
        (at.get(other(f, e.a)) ?? []).some((g) => g !== e && g !== f && !gone.has(g) && g.len <= SHORT && (g.lv ?? 0) === (e.lv ?? 0) && other(g, other(f, e.a)) === e.b),
    );
    if (round) gone.add(e);
  }
  // Lanes alongside: a run of narrow one-way pieces of a named road,
  // between two joints that wider pieces of the same road also join, in
  // about the same distance.
  const seen = new Set();
  let beside = 0;
  const live = (j) => (at.get(j) ?? []).filter((f) => !gone.has(f));
  for (const e of edges) {
    if (seen.has(e) || gone.has(e) || !e.one || !e.name || e.w > 7 || e.a === e.b) continue;
    const like = (f) => f.name === e.name && !!f.one && (f.lv ?? 0) === (e.lv ?? 0);
    const run = [e];
    const ends = [e.a, e.b];
    for (const k of [0, 1]) {
      for (let last = e; ; ) {
        const l = live(ends[k]);
        const next = l.find((f) => f !== last);
        if (l.length !== 2 || !next || !like(next) || next.w > 7 || run.includes(next)) break;
        run.push(next);
        ends[k] = other(next, ends[k]);
        last = next;
      }
    }
    for (const f of run) seen.add(f);
    if (ends[0] === ends[1]) continue;
    const len = run.reduce((t, f) => t + f.len, 0);
    const wide = Math.max(...run.map((f) => f.w));
    // The way along the wider pieces of the road.
    const dist = new Map([[ends[0], 0]]);
    const open = [ends[0]];
    while (open.length) {
      const j = open.shift();
      for (const f of live(j)) {
        if (run.includes(f) || !like(f) || f.w <= wide) continue;
        const to = other(f, j);
        const d = dist.get(j) + f.len;
        if (d > len * 1.3 || d >= (dist.get(to) ?? Infinity)) continue;
        dist.set(to, d);
        open.push(to);
      }
    }
    if ((dist.get(ends[1]) ?? Infinity) < len / 1.3) continue;
    if (!dist.has(ends[1])) continue;
    for (const f of run) gone.add(f);
    beside++;
  }
  edges = edges.filter((e) => !gone.has(e));
  report.corners = { folded: gone.size - beside, beside };
}

// ---------- pair ----------
if (steps.has('pair')) {
  const GAP = 10; // widest median two sides may have and still be one road
  const NEAR_END = 6; // a cut this close to a joint uses that joint instead
  const side = (e) => !!e.one && !!e.name && /^(primary|secondary|tertiary|unclassified|residential)$/.test(e.cls);
  const dirAt = (e, k) => {
    const a = e.pts[Math.max(0, Math.min(e.pts.length - 2, k))];
    const b = e.pts[Math.max(1, Math.min(e.pts.length - 1, k + 1))];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  /**
   * The nearest point to p on the other side of e's road: a side of the
   * same name and level running alongside (d is e's direction at p),
   * and squarely across from p, not further along e's own side. Which
   * way each side is drawn is not trusted: the map draws some one-way
   * pieces backwards.
   */
  const across = (p, d, e, not) => {
    let best = null;
    for (const o of edges) {
      if (o === e || !side(o) || o.name !== e.name || (o.lv ?? 0) !== (e.lv ?? 0) || not.has(o) || o.a === o.b) continue;
      const reach = (e.w + o.w) / 2 + GAP;
      let run = 0;
      for (let k = 0; k + 1 < o.pts.length; k++) {
        const [ax, az] = o.pts[k];
        const [bx, bz] = o.pts[k + 1];
        const abx = bx - ax, abz = bz - az;
        const l = Math.hypot(abx, abz);
        if (!l) continue;
        let u = ((p[0] - ax) * abx + (p[1] - az) * abz) / (l * l);
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const q = [ax + abx * u, az + abz * u];
        const dist = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const fwd = Math.abs((q[0] - p[0]) * d[0] + (q[1] - p[1]) * d[1]);
        if (dist >= 2 && dist <= reach && fwd <= 0.5 * dist && (!best || dist < best.dist) && Math.abs(abx * d[0] + abz * d[1]) / l > 0.7) best = { o, k, u, q, dist, s: run + l * u };
        run += l;
      }
    }
    return best;
  };
  /** The joint's roads as [edge, its direction leaving the joint]. */
  const armsAt = (j) => {
    const out = [];
    for (const e of edges) {
      if (e.a === j) out.push([e, dirAt(e, 0)]);
      if (e.b === j) out.push([e, dirAt(e, e.pts.length - 2).map((v) => -v)]);
    }
    return out;
  };
  /** Moves one end of e to c, the shift fading out over its first 30 m, so the line keeps its run. */
  const lead = (e, end, c) => {
    const pts = end ? [...e.pts].reverse() : e.pts.map((p) => [...p]);
    const L = Math.max(4, Math.min(30, e.len / 2));
    const dx = c[0] - pts[0][0], dz = c[1] - pts[0][1];
    const out = [];
    let s = 0;
    for (let k = 0; k < pts.length; k++) {
      if (k) {
        const [ax, az] = pts[k - 1];
        const l = Math.hypot(pts[k][0] - ax, pts[k][1] - az);
        const n = s < L ? Math.max(1, Math.ceil(Math.min(l, L - s) / 5)) : 1;
        const step = Math.min(l, L - s) / n;
        for (let m = 1; m < n || (m === n && step * n < l - 0.01 && s < L); m++) out.push([[ax + ((pts[k][0] - ax) * step * m) / l, az + ((pts[k][1] - az) * step * m) / l], s + step * m]);
        s += l;
      }
      out.push([pts[k], s]);
    }
    const led = out.map(([q, at]) => {
      const t = Math.max(0, 1 - at / L);
      const w = t * t * (3 - 2 * t);
      return [+(q[0] + dx * w).toFixed(1), +(q[1] + dz * w).toFixed(1)];
    });
    e.pts = end ? led.reverse() : led;
  };
  const edges0 = edges.map((e) => ({ ...e, pts: e.pts.map((q) => [...q]) }));
  const pos0 = pos.map((q) => [...q]);
  /**
   * One go at pairing. `held` joints are not drawn to their opposite
   * numbers: the road is cut 30 m from them, in each direction given,
   * and stays two sides up to there. Returns the joints to hold next time.
   */
  const pairOnce = (held) => {
  // A paired road never forks on a bridge: where a held joint's side runs
  // onto one, the road stays two sides to the bridge's far end, and that
  // joint is held too.
  for (const todo = [...held.keys()]; todo.length; ) {
    const j = todo.pop();
    for (const [e, d] of armsAt(j)) {
      if (!side(e) || !(e.lv ?? 0) || !held.get(j).some((h) => h[0] * d[0] + h[1] * d[1] > 0.5)) continue;
      const far = e.a === j ? e.b : e.a;
      const on = e.a === j ? dirAt(e, e.pts.length - 2) : dirAt(e, 0).map((v) => -v);
      const had = held.get(far) ?? [];
      if (had.some((h) => h[0] * on[0] + h[1] * on[1] > 0.5)) continue;
      // (The fork then lies 30 m beyond the bridge's end, or at the next joint if that is nearer than 28 m beyond that.)
      held.set(far, [...had, [...on, 30]]);
      todo.push(far);
    }
  }
  // Joints drawn together.
  const par = new Map();
  const find = (j) => {
    let r = j;
    while (par.has(r)) r = par.get(r);
    while (par.has(j)) {
      const n = par.get(j);
      par.set(j, r);
      j = n;
    }
    return r;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) par.set(a, b);
  };
  const cut = (o, k, u, q) => {
    const n = pos.length;
    pos.push([...q]);
    const head = [...o.pts.slice(0, k + 1), [...q]];
    const tail = [[...q], ...o.pts.slice(k + 1)];
    const rest = { ...o, pts: tail, a: n, len: lenOf(tail) };
    o.pts = head;
    o.b = n;
    o.len = lenOf(head);
    delete o.spans;
    delete rest.spans;
    edges.push(rest);
    return n;
  };
  /** Cuts e `want` metres from its start; the new joint. */
  const cutAtLen = (e, want) => {
    for (let k = 0; k + 1 < e.pts.length; k++) {
      const l = Math.hypot(e.pts[k + 1][0] - e.pts[k][0], e.pts[k + 1][1] - e.pts[k][1]);
      if (want <= l || k === e.pts.length - 2) {
        const u = l ? Math.max(0, Math.min(1, want / l)) : 0;
        return cut(e, k, u, [e.pts[k][0] + (e.pts[k + 1][0] - e.pts[k][0]) * u, e.pts[k][1] + (e.pts[k + 1][1] - e.pts[k][1]) * u]);
      }
      want -= l;
    }
    return e.b;
  };
  /** The nearest point of a line to p: how far, and how far along the line. */
  const nearestOn = (pts, p) => {
    let best = { dist: Infinity, s: 0 };
    let run = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, az] = pts[k];
      const abx = pts[k + 1][0] - ax, abz = pts[k + 1][1] - az;
      const l = Math.hypot(abx, abz);
      if (!l) continue;
      const u = Math.max(0, Math.min(1, ((p[0] - ax) * abx + (p[1] - az) * abz) / (l * l)));
      const dist = Math.hypot(ax + abx * u - p[0], az + abz * u - p[1]);
      if (dist < best.dist) best = { dist, s: run + l * u };
      run += l;
    }
    return best;
  };
  let cuts = 0;
  const done = new Set();
  for (let pass = 0; pass < 6; pass++) {
    const nodes = new Map();
    for (const e of edges) if (side(e)) for (const j of [e.a, e.b]) (nodes.get(j) ?? nodes.set(j, []).get(j)).push(e);
    let any = false;
    for (const [j, list] of nodes) {
      if (done.has(j)) continue;
      done.add(j);
      if (held.has(j)) {
        for (const [e, d] of armsAt(j)) {
          const h = held.get(j).find((h) => h[0] * d[0] + h[1] * d[1] > 0.5);
          if (!side(e) || e.len < 20 || (e.lv ?? 0) || !h) continue;
          if (h[2] && e.len - h[2] < 28) continue;
          const from = h[2] ?? Math.min(30, e.len / 2);
          cutAtLen(e, e.a === j ? from : e.len - from);
          cuts++;
          any = true;
        }
        continue;
      }
      // (Once for each road that has a side here: where two dual roads
      // cross, all four joints of the crossing come together.)
      const seen = new Set();
      for (const e of list) {
        const road = `${e.name}:${e.lv ?? 0}`;
        if (seen.has(road)) continue;
        seen.add(road);
        const d = dirAt(e, e.a === j ? 0 : e.pts.length - 2);
        const hit = across(pos[j], d, e, new Set(list));
        if (!hit) continue;
        const { o, k, u, q, s } = hit;
        let n;
        if (s < NEAR_END) n = o.a;
        else if (o.len - s < NEAR_END) n = o.b;
        else {
          n = cut(o, k, u, q);
          cuts++;
          any = true;
        }
        if (!held.has(n)) union(j, n);
      }
    }
    if (!any) break;
  }
  // (Joints that are a split or a merge as the map has them: three roads, two leaving side by side.)
  const wasSplit = new Set();
  {
    const at = new Map();
    for (const e of edges) {
      (at.get(e.a) ?? at.set(e.a, []).get(e.a)).push(dirAt(e, 0));
      (at.get(e.b) ?? at.set(e.b, []).get(e.b)).push(dirAt(e, e.pts.length - 2).map((v) => -v));
    }
    for (const [j, d] of at) if (d.length === 3 && d.some((u, i) => d.some((v, k) => k > i && u[0] * v[0] + u[1] * v[1] > 0.82))) wasSplit.add(j);
  }
  // Each group of joints becomes one, in the middle of them.
  const groups = new Map();
  for (const j of par.keys()) (groups.get(find(j)) ?? groups.set(find(j), new Set([find(j)])).get(find(j))).add(j);
  const moved = new Map();
  for (const [r, set] of groups) {
    const l = [...set];
    const c = [l.reduce((t, j) => t + pos[j][0], 0) / l.length, l.reduce((t, j) => t + pos[j][1], 0) / l.length];
    for (const j of l) moved.set(j, c);
    pos[r] = c;
  }
  const round = (p) => [+p[0].toFixed(1), +p[1].toFixed(1)];
  /** Roads that ran alongside a side into its joint (slip roads, ramps): [edge, which end, its line from that end as the map had it]. */
  const alongside = [];
  edges = edges.filter((e) => {
    const a = find(e.a), b = find(e.b);
    // (A piece between two joints drawn together is inside the new joint.)
    if (a === b && e.a !== e.b && e.len < 60) return false;
    e.len0 = e.len;
    for (const [end, j] of [[0, e.a], [1, e.b]]) {
      const c = moved.get(j);
      if (!c) continue;
      const at = end ? e.pts.length - 1 : 0;
      // A side of the road, or a road running alongside it (a slip road,
      // a ramp), is led to the joint; a road that meets it is carried on
      // to the joint.
      const d = dirAt(e, end ? e.pts.length - 2 : 0);
      const dx = c[0] - e.pts[at][0], dz = c[1] - e.pts[at][1];
      const far = Math.hypot(dx, dz);
      if (far < 0.05) continue;
      if (side(e)) lead(e, end, c);
      else if (Math.abs(dx * d[0] + dz * d[1]) < 0.6 * far) {
        alongside.push([e, end, end ? [...e.pts].reverse() : e.pts.map((q) => [...q])]);
        lead(e, end, c);
      } else if (end) e.pts.push(round(c));
      else e.pts.unshift(round(c));
    }
    e.a = a;
    e.b = b;
    e.len = lenOf(e.pts);
    return true;
  });
  // Two sides between the same two joints: one road.
  const key = (e) => `${Math.min(e.a, e.b)}:${Math.max(e.a, e.b)}:${e.name}:${e.lv ?? 0}`;
  const byKey = new Map();
  for (const e of edges) if (side(e) && e.a !== e.b) (byKey.get(key(e)) ?? byKey.set(key(e), []).get(key(e))).push(e);
  const along = (pts, len, f) => {
    let want = f * len;
    for (let k = 0; k + 1 < pts.length; k++) {
      const l = Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
      if (want <= l || k === pts.length - 2) {
        const u = l ? Math.min(1, want / l) : 0;
        return [pts[k][0] + (pts[k + 1][0] - pts[k][0]) * u, pts[k][1] + (pts[k + 1][1] - pts[k][1]) * u];
      }
      want -= l;
    }
    return pts[pts.length - 1];
  };
  const gone = new Set();
  let pairs = 0;
  for (const list of byKey.values()) {
    const A = list.find((e) => !gone.has(e));
    const B = list.find((e) => e !== A && !gone.has(e));
    if (!A || !B) continue;
    const back = B.a === A.a ? B.pts : [...B.pts].reverse();
    const n = Math.max(2, Math.ceil(Math.max(A.len, B.len) / 4) + 1);
    const pts = [];
    const gaps = [];
    // The one road's line runs midway between the two centre lines. (Not
    // midway between the outside edges, which differs by a quarter of the
    // difference in width, 0.8 m for a lane: that line would have to
    // swerve wherever a side gains or loses a lane.)
    let left = 0;
    for (let m = 0; m < n; m++) {
      const f = m / (n - 1);
      const p = along(A.pts, A.len, f);
      const q = along(back, B.len, f);
      const far = Math.hypot(q[0] - p[0], q[1] - p[1]);
      pts.push(round([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]));
      if (m > 0 && m < n - 1) gaps.push(far - (A.w + B.w) / 2);
      // (Is B's side to the left of the line, as the builder counts left?)
      if (m === n >> 1) {
        const p2 = along(A.pts, A.len, Math.min(1, f + 0.02)), p1 = along(A.pts, A.len, Math.max(0, f - 0.02));
        left = (p2[1] - p1[1]) * (q[0] - p[0]) - (p2[0] - p1[0]) * (q[1] - p[1]) > 0 ? 1 : -1;
      }
    }
    gaps.sort((x, y) => x - y);
    const med = Math.max(0, +(gaps[gaps.length >> 1] ?? 0).toFixed(1));
    A.pts = pts;
    A.len = lenOf(pts);
    const wA0 = A.w;
    A.w = +(A.w + B.w + med).toFixed(1);
    A.one = 0;
    A.dual = 1;
    // (How far the median lies to the left of the line: towards the narrower side.)
    const mo = +((left * (wA0 - B.w)) / 4).toFixed(1);
    if (mo) A.mo = mo;
    if (med > 0) A.med = med;
    delete A.spans;
    gone.add(B);
    pairs++;
  }
  // A road between two joints that a paired road also joins, in about the
  // same distance, ran between the two sides or along one: it is inside
  // the one road now.
  const twoWays = new Map();
  for (const e of edges) if (e.dual && !gone.has(e)) twoWays.set(`${Math.min(e.a, e.b)}:${Math.max(e.a, e.b)}`, e);
  let inside = 0;
  for (const e of edges) {
    const over = twoWays.get(`${Math.min(e.a, e.b)}:${Math.max(e.a, e.b)}`);
    // (As long as it was before its ends moved; a link across the median is up to the road's width longer.)
    if (!over || e.dual || gone.has(e) || e.a === e.b || (e.lv ?? 0) !== (over.lv ?? 0) || (e.len0 ?? e.len) > over.len * 1.5 + Math.max(5, over.w)) continue;
    gone.add(e);
    inside++;
  }
  edges = edges.filter((e) => !gone.has(e));
  // A slip road that ran alongside one side now starts in the middle of
  // the one road and lies inside it for some way. It meets the road as a
  // side road instead, where it comes clear of the road's edge.
  let met = 0;
  for (const [e, end, line] of alongside) {
    if (gone.has(e) || !edges.includes(e)) continue;
    const g = end ? e.b : e.a;
    const len = lenOf(line);
    const dir = (() => {
      const q = along(line, len, Math.min(1, 15 / len));
      const l = Math.hypot(q[0] - line[0][0], q[1] - line[0][1]) || 1;
      return [(q[0] - line[0][0]) / l, (q[1] - line[0][1]) / l];
    })();
    // The paired road it runs beside, as a line from the joint.
    let P = null;
    for (const [o, d] of armsAt(g)) if (o.dual && o.a !== o.b && d[0] * dir[0] + d[1] * dir[1] > 0.5 && (!P || d[0] * dir[0] + d[1] * dir[1] > P.dot)) P = { o, dot: d[0] * dir[0] + d[1] * dir[1] };
    if (!P) continue;
    const road = P.o.a === g ? P.o.pts : [...P.o.pts].reverse();
    const clear = P.o.w / 2 + e.w / 2 + 1.5;
    let at = null;
    for (let sq = 4; sq < Math.min(len - 8, 200); sq += 2) {
      const q = along(line, len, sq / len);
      const n = nearestOn(road, q);
      if (n.s > P.o.len - 1) break;
      if (n.dist >= clear) {
        at = { sq, q, n };
        break;
      }
    }
    if (!at) continue;
    const sj = at.n.s - 0.6 * at.n.dist;
    let node = g;
    if (P.o.len - sj < 12) node = P.o.a === g ? P.o.b : P.o.a;
    else if (sj >= 12) {
      node = cutAtLen(P.o, P.o.a === g ? sj : P.o.len - sj);
      cuts++;
    }
    const rest = [];
    let run = 0;
    for (let k = 1; k < line.length; k++) {
      run += Math.hypot(line[k][0] - line[k - 1][0], line[k][1] - line[k - 1][1]);
      if (run > at.sq + 1) rest.push(line[k]);
    }
    const pts = [round(pos[node]), round(at.q), ...rest];
    e.pts = end ? pts.reverse() : pts;
    if (end) e.b = node;
    else e.a = node;
    e.len = lenOf(e.pts);
    met++;
  }
  // Where the pairing ends (a side leaves the joint on its own) at a
  // joint drawn together around a split or a merge, the joint has four
  // roads or more where the map had three, two of them side by side: no
  // form the builder draws well. And a joint with no paired road at all
  // is a pinch. Both are held open on the next go.
  const bad = new Map();
  for (const [g, set] of groups) {
    const arms = armsAt(g);
    const twoWay = arms.filter(([e]) => e.dual);
    if (!((arms.length >= 4 && arms.some(([e]) => side(e)) && [...set].some((j) => wasSplit.has(j))) || !twoWay.length)) continue;
    // (Only the map's own joints: a cut's number is not the same joint on the next go.)
    for (const j of set) if (j < pos0.length) bad.set(j, twoWay.map(([, d]) => d));
  }
  // Why the sides still left were not paired (inside the box, if there is one).
  const why = { lone: 0, endsApart: 0, noTwin: 0 };
  const eg = [];
  const inB = (p) => !box || (p[0] >= box[0] && p[0] <= box[1] && p[1] >= box[2] && p[1] <= box[3]);
  for (const e of edges) {
    if (!side(e) || !e.pts.some(inB)) continue;
    const k = e.pts.length >> 1;
    const hit = across(along(e.pts, e.len, 0.5), dirAt(e, Math.max(0, k - 1)), e, new Set());
    const kind = !hit ? 'lone' : !(groups.has(e.a) && groups.has(e.b)) ? 'endsApart' : 'noTwin';
    why[kind]++;
    if (kind !== 'lone') eg.push(`${e.name} lv${e.lv ?? 0} ${Math.round(e.len)}m ${kind} at ${along(e.pts, e.len, 0.5).map(Math.round)} gap ${(hit.dist - (e.w + hit.o.w) / 2).toFixed(1)} | ${e.a}${groups.has(e.a) ? '*' : ''}>${e.b}${groups.has(e.b) ? '*' : ''} [${pos[e.a].map(Math.round)}>${pos[e.b].map(Math.round)}] twin ${hit.o.a}${groups.has(hit.o.a) ? '*' : ''}>${hit.o.b}${groups.has(hit.o.b) ? '*' : ''} [${pos[hit.o.a].map(Math.round)}>${pos[hit.o.b].map(Math.round)}] ${Math.round(hit.o.len)}m one=${hit.o.one}`);
  }
  report.pair = { joints: par.size, cuts, pairs, left: edges.filter(side).length, held: held.size, inside, met, why, eg };
  return bad;
  };
  const held = new Map();
  for (let go = 0; go < 5; go++) {
    const bad = pairOnce(held);
    if (!bad.size || go === 4) break;
    for (const [j, d] of bad) held.set(j, [...(held.get(j) ?? []), ...d]);
    edges = edges0.map((e) => ({ ...e, pts: e.pts.map((q) => [...q]) }));
    pos.length = 0;
    for (const q of pos0) pos.push([...q]);
  }
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
  let turned = 0;
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
      // (The map draws some one-way pieces backwards. At a joint of two
      // pieces of one road, traffic can only pass through: where they meet
      // head on or tail to tail, the shorter is turned to run the way the
      // longer does.)
      if ((p.a === j) === (q.a === j)) {
        const s = p.len <= q.len ? p : q;
        s.pts.reverse();
        [s.a, s.b] = [s.b, s.a];
        if (s.spans) s.spans.reverse();
        turned++;
      }
      if (p.b !== j) [p, q] = [q, p];
      if (p.b !== j || q.a !== j) continue;
    } else {
      for (const [e, end] of [[p, 'b'], [q, 'a']])
        if (e[end] !== j) {
          e.pts.reverse();
          [e.a, e.b] = [e.b, e.a];
          if (e.spans) e.spans.reverse();
          if (e.mo) e.mo = -e.mo;
        }
    }
    if (p.a === q.b && p.a === j) continue;
    // (Whether it is marked as a paired road, and where its median is, go by the longer piece.)
    if (q.len > p.len) for (const k of ['dual', 'mo', 'med']) q[k] ? (p[k] = q[k]) : delete p[k];
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
  report.join = { joined, turned };
}

// ---------- roads ----------
// A road is one line through every place a smaller road meets it. Where a
// side road meets a road that carries straight on (three pieces at a joint,
// two of them one road), the two are marked as through ends (`ta`, `tb`):
// the builder then lays them as one unbroken strip and ends the side road at
// its edge, instead of cutting all three back to a patch of paving.
if (steps.has('roads')) {
  const FAST = /^(motorway|trunk)|_link$/;
  const at = new Map();
  for (const e of edges) {
    if (e.a === e.b) continue;
    for (const j of [e.a, e.b]) (at.get(j) ?? at.set(j, []).get(j)).push(e);
  }
  // Heading out of the joint along a piece, taken 10 m along it (20 m on an expressway).
  const head = (e, j, far = 10) => {
    const pts = e.a === j ? e.pts : [...e.pts].reverse();
    let run = 0;
    let k = 0;
    while (k + 1 < pts.length - 1 && run < far) {
      run += Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
      k++;
    }
    const q = pts[Math.max(1, k)];
    const l = Math.hypot(q[0] - pts[0][0], q[1] - pts[0][1]) || 1;
    return [(q[0] - pts[0][0]) / l, (q[1] - pts[0][1]) / l];
  };
  const widthAt = (e, j) => (e.spans ? (e.a === j ? e.spans[0][1] : e.spans[e.spans.length - 1][1]) : e.w);
  const sameRoad = (p, q) => (p.name ? p.name === q.name : !q.name && p.cls === q.cls);
  const deg = (c) => (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
  let tees = 0;
  let slips = 0;
  const pairs = [];
  const why = {};
  const no = (k) => (why[k] = (why[k] ?? 0) + 1);
  // First, at each joint of three or four pieces: the pair that carries
  // straight on, and the roads that meet it.
  const MINLEN = 8;
  const ORDER = { service: 0, unclassified: 1, residential: 1, tertiary: 2, secondary: 3, primary: 4, trunk: 5, motorway: 6 };
  const RANK = (cls) => ORDER[cls.replace(/_link$/, '')] ?? 0;
  const cand = new Map();
  for (const [j, l] of at) {
    if (l.length !== 3 && l.length !== 4) continue;
    if (l.some((e) => (e.lv ?? 0) !== 0)) { no('level'); continue; }
    const h10 = l.map((e) => head(e, j, 10)), h20 = l.map((e) => head(e, j, 20));
    let best = null;
    for (let x = 0; x < l.length; x++)
      for (let y = x + 1; y < l.length; y++) {
        const p = l[x], q = l[y];
        const sides = l.filter((_, k) => k !== x && k !== y);
        // An expressway carries on past the slip road that leaves or joins
        // it: the same rule, but the slip road comes away at a narrow angle,
        // and the carriageway may lose or gain its lane there. (Only an
        // expressway's own carriageway so far: where one slip road leaves
        // another, the junction is still shaped as before.)
        const fast = FAST.test(p.cls) || FAST.test(q.cls);
        // (A slip road carries on the same way past another that leaves or joins it.)
        if (fast && (l.length !== 3 || !FAST.test(p.cls) || !FAST.test(q.cls) || /_link$/.test(p.cls) !== /_link$/.test(q.cls))) continue;
        const h = fast ? h20 : h10;
        // p and q: one road carrying straight on. (Whichever way each piece
        // is drawn: the map draws some one-way pieces backwards.)
        const turn = deg(-(h[x][0] * h[y][0] + h[x][1] * h[y][1]));
        if (turn > (fast ? 15 : 25) || !sameRoad(p, q) || (p.one ?? 0) !== (q.one ?? 0) || !!p.dual !== !!q.dual) continue;
        const wp = widthAt(p, j), wq = widthAt(q, j);
        const narrow = Math.min(wp, wq);
        // (No more than twice as wide one side as the other: turning lanes added at a crossing taper in along the road.)
        if (Math.max(wp, wq) > (fast ? 1.6 : 2) * narrow + 0.01 || Math.min(p.len, q.len) < (fast ? 20 : MINLEN)) continue;
        let ok = true;
        const short = [];
        for (const sd of sides) {
          const z = l.indexOf(sd);
          // The side road comes in across it, and is no wider.
          const cut = Math.min(deg(h[z][0] * h[x][0] + h[z][1] * h[x][1]), deg(h[z][0] * h[y][0] + h[z][1] * h[y][1]));
          // (A link that comes in square is a side road like any other: the
          // few metres across a divider for turning back, not a slip road.)
          const slip = FAST.test(sd.cls) && !(/_link$/.test(sd.cls) && !fast && cut >= 40);
          // (One side of a divided road is half of its road.)
          if ((fast && !slip && !/_link$/.test(p.cls)) || cut < (slip ? 6 : 40) || sd.w > (p.one && !fast ? 2 : 1) * Math.max(wp, wq) + 0.5) ok = false;
          // (A slip road is narrower than the road it leaves at every point.
          // One as wide that comes away at a narrow angle is not a side road:
          // the road forks there, and neither branch carries on.)
          // (And long enough to have come clear of the road: the wedge between
          // the two is paved until they are 1.8 m apart.)
          else if (slip && (sd.len < Math.min(30, (Math.max(wp, wq) / 2 + sd.w / 2 + 1.8) / Math.sin((cut * Math.PI) / 180) + 4) || sd.w > narrow + 0.5 || (sd.w > 0.8 * narrow && cut < 20))) ok = false;
          // (A few metres of road: an opening in a divider, or a stub with just room for its corners. See below.)
          else if (!slip && sd.len < 15) sd.len < 4 ? (ok = false) : short.push({ sd, room: sd.len >= Math.max(wp, wq) + 1 });
          if (!ok) break;
        }
        if (!ok) continue;
        // (Two roads meeting it: one from each side.)
        if (sides.length === 2) {
          const sg = sides.map((sd) => Math.sign(h[x][0] * h[l.indexOf(sd)][1] - h[x][1] * h[l.indexOf(sd)][0]));
          if (!sg[0] || sg[0] === sg[1]) continue;
        }
        // (Of two slip roads leaving one another, the wider carries on.)
        // (Where two roads cross, the bigger road carries on: by its class,
        // then by how straight it runs.)
        const key = turn - (fast ? narrow : 0) - 100 * Math.min(RANK(p.cls), RANK(q.cls));
        if (!best || key < best.key) best = { p, q, sides, short, key, fast };
      }
    if (!best) {
      no(l.some((e) => FAST.test(e.cls)) && !l.every((e) => FAST.test(e.cls)) ? 'fast' : 'shape');
      if (process.env.ROADS_DEBUG) {
        const [dx, dz] = process.env.ROADS_DEBUG.split(',').map(Number);
        if (Math.hypot(pos[j][0] - dx, pos[j][1] - dz) < 400)
          console.error(pos[j].map(Math.round).join(','), l.map((e) => `${e.name ?? e.cls}/${e.one ?? 0}/${e.dual ? 'D' : ''}/w${widthAt(e, j)}/len${Math.round(e.len)}`).join(' | '));
      }
      continue;
    }
    cand.set(j, best);
  }
  // An opening in a divider: a few metres of road between the two sides of
  // a divided road. Each side carries on past it only if the other does
  // too (the opening is then paved between the two, with no road of its
  // own). A short stub to anywhere else needs room for its corners beyond
  // the road's edge; without it the junction is left as before.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [j, c] of cand) {
      // (And a piece of the road itself shorter than 20 m carries on at
      // both its ends, or at neither: a junction shaped the old way at its
      // far end would cut it back further than it is long.)
      const far = (e) => cand.get(e.a === j ? e.b : e.a);
      const chain = [c.p, c.q].every((e) => e.len >= 20 || [far(e)?.p, far(e)?.q].includes(e));
      if (chain && c.short.every(({ sd, room }) => room || far(sd)?.sides.includes(sd))) continue;
      cand.delete(j);
      no(chain ? 'short' : 'chain');
      changed = true;
    }
  }
  let openings = 0;
  for (const [j, c] of cand) {
    for (const e of [c.p, c.q]) e.a === j ? (e.ta = 1) : (e.tb = 1);
    pairs.push([j, c.p, c.q, c.sides]);
    tees++;
    if (c.fast) slips++;
    openings += c.short.filter(({ sd }) => cand.get(sd.a === j ? sd.b : sd.a)?.sides.includes(sd)).length / 2;
  }
  // A road onto its bridge and off it: two pieces of one road at a joint
  // where only the level changes. Marked the same way, so its lines and its
  // place on the map carry through.
  let ramps = 0;
  for (const [j, l] of at) {
    if (l.length !== 2) continue;
    const [p, q] = l;
    if ((p.lv ?? 0) === (q.lv ?? 0) || p.cls !== q.cls || !sameRoad(p, q) || (p.one ?? 0) !== (q.one ?? 0) || !!p.dual !== !!q.dual) continue;
    // (Not a bridge a few metres long over a drain: the road either side of it follows the ground.)
    if (Math.min(p.len, q.len) < 20) continue;
    const hp = head(p, j, 20), hq = head(q, j, 20);
    if (deg(-(hp[0] * hq[0] + hp[1] * hq[1])) > 15) continue;
    for (const e of [p, q]) e.a === j ? (e.ta = 1) : (e.tb = 1);
    pairs.push([j, p, q, []]);
    ramps++;
  }
  // The two pieces are one curve through the joint: eased over the 12 m
  // either side of it (the importer smoothed each piece on its own), with
  // the joint, and the side road's end, moved onto the curve.
  // (To the centimetre: at the 2 m spacing of an eased line, rounding to
  // 0.1 m alone turns the line a few degrees left and right at every point.)
  const r1 = (p) => [+p[0].toFixed(2), +p[1].toFixed(2)];
  let moved = 0;
  for (const [j, p, q, sides] of pairs) {
    const P = p.b === j ? p.pts : [...p.pts].reverse(); // into the joint
    const Q = q.a === j ? q.pts : [...q.pts].reverse(); // out of it
    // (A point 12 m from the joint on each side bounds the eased stretch.)
    const cutAt = (pts, d) => {
      // pts run away from the joint: [kept near part incl. the new point, far part]
      let run = 0;
      for (let n = 0; n + 1 < pts.length; n++) {
        const sl = Math.hypot(pts[n + 1][0] - pts[n][0], pts[n + 1][1] - pts[n][1]);
        if (run + sl >= d) {
          const u = (d - run) / (sl || 1);
          const x = [pts[n][0] + (pts[n + 1][0] - pts[n][0]) * u, pts[n][1] + (pts[n + 1][1] - pts[n][1]) * u];
          return [[...pts.slice(0, n + 1), x], pts.slice(n + 1)];
        }
        run += sl;
      }
      return null;
    };
    const cp = cutAt([...P].reverse(), Math.min(12, p.len * 0.45));
    const cq = cutAt(Q, Math.min(12, q.len * 0.45));
    if (!cp || !cq) continue;
    // One curve from the point 12 m before the joint to the point 12 m after
    // it, leaving each the way its piece runs there (corner cutting only
    // rounds the metre or two beside a corner: the turn stayed at the joint).
    const headAt = (near, far) => {
      // (The piece's direction at the cut: on from it, over 2 m or more.)
      const o = near[near.length - 1];
      for (const x of far) if (Math.hypot(x[0] - o[0], x[1] - o[1]) >= 2) return [x[0] - o[0], x[1] - o[1]];
      const b = near[near.length - 2];
      return [o[0] - b[0], o[1] - b[1]];
    };
    const A = cp[0][cp[0].length - 1], B = cq[0][cq[0].length - 1];
    const span = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const unit = (v) => v.map((c) => (c / (Math.hypot(v[0], v[1]) || 1)) * span);
    const tA = unit(headAt(cp[0], cp[1])).map((c) => -c); // toward the joint
    const tB = unit(headAt(cq[0], cq[1])); // away from it
    const eased = [];
    const steps = Math.max(4, Math.ceil(span / 2));
    for (let n = 0; n <= steps; n++) {
      const u = n / steps, u2 = u * u, u3 = u2 * u;
      const h = [2 * u3 - 3 * u2 + 1, u3 - 2 * u2 + u, -2 * u3 + 3 * u2, u3 - u2];
      eased.push([h[0] * A[0] + h[1] * tA[0] + h[2] * B[0] + h[3] * tB[0], h[0] * A[1] + h[1] * tA[1] + h[2] * B[1] + h[3] * tB[1]]);
    }
    // The joint goes to the nearest point of the eased line (added to it).
    let m = 0, bd = Infinity, bx = null;
    for (let n = 0; n + 1 < eased.length; n++) {
      const dx = eased[n + 1][0] - eased[n][0], dz = eased[n + 1][1] - eased[n][1];
      const u = Math.max(0, Math.min(1, ((pos[j][0] - eased[n][0]) * dx + (pos[j][1] - eased[n][1]) * dz) / (dx * dx + dz * dz || 1)));
      const x = [eased[n][0] + dx * u, eased[n][1] + dz * u];
      const d = Math.hypot(x[0] - pos[j][0], x[1] - pos[j][1]);
      if (d < bd) (bd = d), (m = n), (bx = x);
    }
    const at = r1(bx);
    const far = (pts) => pts.filter((x) => Math.hypot(x[0] - at[0], x[1] - at[1]) > 1).map(r1);
    const P2 = [...cp[1].reverse(), ...far(eased.slice(0, m + 1)), at];
    const Q2 = [at, ...far(eased.slice(m + 1)), ...cq[1]];
    p.pts = p.b === j ? P2 : P2.reverse();
    q.pts = q.a === j ? Q2 : Q2.reverse();
    moved = Math.max(moved, bd);
    pos[j] = [...at];
    for (const sd of sides) {
      if (sd.a === j) sd.pts[0] = [...at];
      if (sd.b === j) sd.pts[sd.pts.length - 1] = [...at];
    }
    for (const e of [p, q, ...sides]) e.len = lenOf(e.pts);
  }
  // A paired road's painted median keeps its place through the joint: where
  // the two pieces have it at different offsets or widths, it eases from one
  // to the other across the joint (1 m sideways in 40 m), as knots [fraction
  // along the piece, offset, width] (`ms`).
  const knots = new Map();
  for (const [j, p, q] of pairs) {
    if (!p.dual || !q.dual) continue;
    // (Offsets are to the left of each piece as drawn: taken here along p into the joint and on out along q.)
    const sp = p.b === j ? 1 : -1, sq = q.a === j ? 1 : -1;
    const vp = [sp * (p.mo ?? 0), p.med ?? 0], vq = [sq * (q.mo ?? 0), q.med ?? 0];
    const diff = Math.max(Math.abs(vp[0] - vq[0]), Math.abs(vp[1] - vq[1]) / 2);
    if (diff < 0.05) continue;
    const mid = [(vp[0] + vq[0]) / 2, (vp[1] + vq[1]) / 2];
    for (const [e, sgn] of [[p, sp], [q, sq]]) {
      const T = Math.min(0.45 * e.len, Math.max(12, diff * 20));
      (knots.get(e) ?? knots.set(e, []).get(e)).push({ atA: e.a === j, T, v: [sgn * mid[0], mid[1]] });
    }
  }
  for (const [e, l] of knots) {
    const own = [e.mo ?? 0, e.med ?? 0];
    const ms = [];
    const a = l.find((k) => k.atA), b = l.find((k) => !k.atA);
    if (a) ms.push([0, ...a.v], [+(a.T / e.len).toFixed(3), ...own]);
    else ms.push([0, ...own]);
    if (b) ms.push([+(1 - b.T / e.len).toFixed(3), ...own], [1, ...b.v]);
    else ms.push([1, ...own]);
    e.ms = ms.map(([f, mo, med]) => [f, +mo.toFixed(2), +med.toFixed(2)]);
  }
  report.roads = { tees, slips, ramps, openings, why, moved: +moved.toFixed(2), medians: knots.size };
}

// ---------- box ----------
const inBox = box ? (p) => p[0] >= box[0] && p[0] <= box[1] && p[1] >= box[2] && p[1] <= box[3] : () => true;
const near = box ? (p) => p[0] >= box[0] - 150 && p[0] <= box[1] + 150 && p[1] >= box[2] - 150 && p[1] <= box[3] + 150 : () => true;
if (box) edges = edges.filter((e) => e.pts.some(inBox));
// (A road marked as carrying straight on past a joint needs both its pieces: the box may have taken one.)
{
  const marks = new Map();
  for (const e of edges) {
    if (e.ta) marks.set(e.a, (marks.get(e.a) ?? 0) + 1);
    if (e.tb) marks.set(e.b, (marks.get(e.b) ?? 0) + 1);
  }
  for (const e of edges) {
    if (e.ta && marks.get(e.a) !== 2) delete e.ta;
    if (e.tb && marks.get(e.b) !== 2) delete e.tb;
  }
}

// ---------- write ----------
// Joints no road uses any more are dropped, and the rest renumbered.
const idOf = new Map();
const junctions = [];
const idFor = (j) => {
  if (!idOf.has(j)) {
    idOf.set(j, junctions.length);
    junctions.push(pos[j].map((v) => +v.toFixed(1)));
  }
  return idOf.get(j);
};
const outEdges = edges.map(({ len, len0, spans, ...e }) => {
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
if (!args.includes('--quiet')) console.log(JSON.stringify(report, null, 1));
