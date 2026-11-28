// The nose bench: the strict nose, wall and island checks on the small
// nose map (?course=noses, tools/noses/cases.json), every spot they find
// given to the case it lies at.
//   npm run build && node tools/noses/run.cjs [--write-baseline] [--out report.json]
// Three runners share the check list (SHARD in tools/check/run.cjs), on
// ports 4371-4373 (or PORT=, PORT+1, PORT+2).
// A case fails when a check finds more spots at it than its baseline
// (tools/noses/baseline.json, from main): every case may only get better.
// A fault case is done when the checks for its fault find nothing there and
// its pictures show it right; a control case (a nose that looks right) must
// not get worse, and what the checks still find there is listed, for the
// checks themselves to be looked at (28 Nov: the kerb-face check finds
// 0.29 m faces at every wide nose on the ground). Spots away from every case
// (on the far parts of the roads kept whole) are listed, but fail nothing:
// the full-map checks own those.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const arg = (n, d) => {
  const k = process.argv.indexOf(`--${n}`);
  return k < 0 ? d : process.argv[k + 1] ?? true;
};
const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));
const BASE = path.join(__dirname, 'baseline.json');
const NEAR = +arg('near', 40);
const SHARDS = +arg('shards', 3);
const PORT = +(process.env.PORT || 4371);
// The nose, wall and island checks (rules S1-S6, B3, N): by their names in run.cjs.
const ONLY =
  process.env.ONLY ||
  'square stub|kerb face stands|crease or step over 2 cm|lawn has no fold|parapet|top edge over a fall|past the kerb|gap|island ends|narrows smoothly|fold into one point|kerb runs|Every kerb|hole in its lawn|one flat lawn|never lower than the road|grass stays inside|stands over a kerb';

// The 200 m tiles within NEAR + 20 m of a case: the checks run there only.
const TILES = [
  ...new Set(
    CASES.flatMap((c) => {
      const r = NEAR + 20, out = [];
      for (let i = Math.floor((c.x - r) / 200); i <= Math.floor((c.x + r) / 200); i++)
        for (let j = Math.floor((c.z - r) / 200); j <= Math.floor((c.z + r) / 200); j++) out.push(`${i},${j}`);
      return out;
    }),
  ),
].join(';');
const runShard = (i) =>
  new Promise((resolve) => {
    const env = { ...process.env, PORT: String(PORT + i), COURSE: 'noses', ALL: '1', LIST: '1', ONLY, TILES: process.env.TILES ?? TILES, SHARD: `${i}/${SHARDS}` };
    const c = spawn('node', [path.join(__dirname, '../check/run.cjs')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('close', (code) => resolve({ out, code }));
  });

(async () => {
  const t0 = Date.now();
  const runs = await Promise.all([...Array(SHARDS).keys()].map(runShard));
  // Each check's line, then its spots one per line.
  const checks = [];
  for (const { out, code } of runs) {
    if (code === 2) {
      console.log(out);
      process.exit(2);
    }
    let cur = null;
    for (const line of out.split('\n')) {
      const m = line.match(/^(PASS|FAIL)  (.+?): (?:(\d+) of (\d+) samples off|the page crashed)/);
      if (m) {
        cur = { name: m[2], bad: m[3] == null ? null : +m[3], samples: +(m[4] ?? 0), s: +(line.match(/\{(\d+) s\}$/)?.[1] ?? 0), spots: [], crashed: m[3] == null };
        checks.push(cur);
      } else if (cur && /^\s+\{/.test(line)) cur.spots.push(JSON.parse(line.trim()));
      else if (/page error/.test(line)) console.log(line);
    }
  }
  const at = (s) => {
    let best = null;
    let bd = NEAR;
    for (const c of CASES) {
      const d = Math.hypot(s.x - c.x, s.z - c.z);
      if (d <= bd) (bd = d), (best = c);
    }
    return best;
  };
  const report = {};
  for (const c of CASES) report[c.id] = {};
  const elsewhere = {};
  for (const ch of checks) {
    if (ch.crashed) continue;
    for (const s of ch.spots) {
      if (s.x == null) continue;
      const c = at(s);
      const r = c ? (report[c.id][ch.name] ??= { n: 0, worst: 0, spots: [] }) : (elsewhere[ch.name] ??= { n: 0, worst: 0, spots: [] });
      r.n++;
      r.worst = Math.max(r.worst, s.over ?? s.value ?? 0);
      if (r.spots.length < 8) r.spots.push(s);
    }
  }
  if (arg('write-baseline')) {
    const b = {};
    for (const [id, r] of Object.entries(report)) b[id] = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.n]));
    fs.writeFileSync(BASE, JSON.stringify(b, null, 1) + '\n');
    console.log(`baseline written: ${BASE}`);
  }
  const base = fs.existsSync(BASE) ? JSON.parse(fs.readFileSync(BASE, 'utf8')) : {};
  let failed = checks.some((c) => c.crashed);
  for (const ch of checks.filter((c) => c.crashed)) console.log(`FAIL  ${ch.name}: the page crashed`);
  for (const c of CASES) {
    const r = report[c.id];
    const b = base[c.id] ?? {};
    const lines = [];
    let bad = false;
    for (const [name, v] of Object.entries(r)) {
      const allowed = b[name] ?? 0;
      const worse = v.n > allowed;
      if (worse) bad = true;
      lines.push(`    ${worse ? 'WORSE' : v.n < allowed ? 'better' : 'held '} ${v.n} (baseline ${allowed}), worst ${v.worst}: ${name}  e.g. ${v.spots.slice(0, 2).map((s) => `${s.x},${s.z}`).join('  ')}`);
    }
    for (const [name, n] of Object.entries(b)) if (!r[name] && n > 0) lines.push(`    better 0 (baseline ${n}): ${name}`);
    if (bad) failed = true;
    console.log(`${bad ? 'FAIL' : 'PASS'}  ${c.id} (${c.status}) ${c.kind}${lines.length ? '' : ': clean'}`);
    for (const l of lines) console.log(l);
  }
  const ew = Object.entries(elsewhere);
  if (ew.length) {
    console.log(`Away from every case (more than ${NEAR} m; the full-map checks own these):`);
    for (const [name, v] of ew) console.log(`    ${v.n}, worst ${v.worst}: ${name}`);
  }
  const out = arg('out');
  if (out && out !== true) fs.writeFileSync(out, JSON.stringify({ report, elsewhere, checks: checks.map(({ spots, ...c }) => c) }, null, 1));
  if (arg('times')) for (const c of checks) console.log(`    ${c.s} s: ${c.name}`);
  console.log(`${checks.length} checks, ${SHARDS} runners, ${Math.round((Date.now() - t0) / 1000)} s`);
  process.exit(failed ? 1 : 0);
})();
