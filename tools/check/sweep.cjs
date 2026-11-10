// A look at the road, not a measurement of it: contact sheets of what a
// driver sees at every split and every big junction (and, from above, at
// every place a finished-road check flags). For new ground before it goes
// live: the checks catch the faults they know, a sweep of pictures catches
// the ones nobody has written a check for yet.
//
//   npm run build && node tools/check/sweep.cjs [options]
//     --what splits|junctions|flags   which places (default splits)
//     --box minX,minZ,maxX,maxZ       only places inside this box (new ground)
//     --out dir                       where the sheets go (default sweep/)
//     --max n                         stop after n places
//     --port n                        preview port (default 4181)
//
// Each sheet is 4 x 3 pictures, numbered; sweep.json beside them says where
// each number is on the map.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const arg = (name, dflt) => {
  const k = process.argv.indexOf(`--${name}`);
  return k < 0 ? dflt : process.argv[k + 1];
};
const WHAT = arg('what', 'splits');
const BOX = arg('box', '') ? arg('box').split(',').map(Number) : null;
const OUT = path.resolve(arg('out', 'sweep'));
const MAX = +arg('max', 1e9);
const PORT = +arg('port', 4181);
const COLS = 4, ROWS = 3, W = 480, H = 300;

(async () => {
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore', detached: true });
  try {
    await new Promise((r) => setTimeout(r, 2500));
    const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const p = await (await b.newContext({ viewport: { width: W, height: H } })).newPage();
    p.on('pageerror', (e) => console.log('page error:', e.message));
    await p.goto(`http://localhost:${PORT}/?course=pasirris&debug`);
    await p.waitForFunction(() => window.game && globalThis.__osm, null, { timeout: 400000 });
    if (WHAT === 'flags') await p.addScriptTag({ path: path.join(__dirname, 'finish.js') });
    // The places: where to stand, which way to look, and what it is.
    let spots = await p.evaluate((what) => {
      const d = globalThis.__osm;
      const out = [];
      const end = (i, j, s) => {
        // The point s metres out along road i from its end at junction j, and the way the road runs there (away from j).
        const P = d.EP[i], cum = d.ECUM[i], L = cum[cum.length - 1];
        const fromA = d.edges[i].a === j;
        const at = Math.max(0, Math.min(L, fromA ? s : L - s));
        let k = 0;
        while (k < P.length - 2 && cum[k + 1] <= at) k++;
        const sl = cum[k + 1] - cum[k] || 1, u = (at - cum[k]) / sl, sg = fromA ? 1 : -1;
        return { x: P[k][0] + (P[k + 1][0] - P[k][0]) * u, z: P[k][1] + (P[k + 1][1] - P[k][1]) * u, tx: (sg * (P[k + 1][0] - P[k][0])) / sl, tz: (sg * (P[k + 1][1] - P[k][1])) / sl };
      };
      if (what === 'splits') {
        // From the single road, 30 m back, looking at the split.
        for (const [j, [c]] of d.deckSplits) {
          const a = end(c, j, 30), o = end(c, j, 0);
          out.push({ what: `split j${j} ${d.edges[c].name || d.edges[c].cls}`, x: o.x, z: o.z, from: [a.x, a.z], view: 'driver' });
        }
      } else if (what === 'junctions') {
        // Every junction where four or more roads meet, from its widest road.
        const jE = new Map();
        d.edges.forEach((e, i) => {
          if (d.JX.internal[i]) return;
          for (const j of [e.a, e.b]) (jE.get(j) ?? jE.set(j, []).get(j)).push(i);
        });
        for (const [j, l] of jE) {
          if (l.length < 4) continue;
          const c = l.reduce((m, i) => (d.EHALF[i] > d.EHALF[m] ? i : m), l[0]);
          const a = end(c, j, 35), o = end(c, j, 0);
          out.push({ what: `junction j${j} ${d.edges[c].name || d.edges[c].cls}`, x: o.x, z: o.z, from: [a.x, a.z], view: 'driver' });
        }
      } else {
        for (const [fn, label] of [['__checkEdgeRuns', 'edge jump'], ['__checkSlivers', 'sliver'], ['__checkOneSheet', 'overlap'], ['__checkUprights', 'upright']])
          for (const w of window[fn](true).worst) out.push({ what: `${label} ${w.road ?? ''} ${w.value}`, x: w.x, z: w.z, view: 'top' });
      }
      return out;
    }, WHAT);
    if (BOX) spots = spots.filter((s) => s.x >= BOX[0] && s.z >= BOX[1] && s.x <= BOX[2] && s.z <= BOX[3]);
    spots = spots.slice(0, MAX);
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'sweep.json'), JSON.stringify(spots.map((s, n) => ({ n, sheet: Math.floor(n / (COLS * ROWS)), ...s })), null, 1));
    console.log(`${spots.length} places, ${Math.ceil(spots.length / (COLS * ROWS))} sheets -> ${OUT}`);
    for (let s0 = 0; s0 < spots.length; s0 += COLS * ROWS) {
      const url = await p.evaluate(
        async ([list, n0, COLS, ROWS, W, H]) => {
          const g = window.game, d = globalThis.__osm;
          const sheet = document.createElement('canvas');
          sheet.width = COLS * W;
          sheet.height = ROWS * H;
          const c2 = sheet.getContext('2d');
          const stats = g.course.streamStats();
          for (let q = 0; q < list.length; q++) {
            const s = list[q];
            const y = d.surfaceAt(s.x, s.z);
            // (The car out of the picture; the map built round the place.)
            g.car.placeAt({ x: s.x + 300, y: d.surfaceAt(s.x + 300, s.z) + 0.1, z: s.z }, 0);
            for (let c = 0; c < 400000; c++) {
              g.course.update(performance.now() / 1000, 0, undefined, { x: s.x, y, z: s.z });
              if (!stats.pending) break;
            }
            for (let f = 0; f < 4; f++) await new Promise((r) => requestAnimationFrame(r));
            const cam = g.camera.clone();
            cam.aspect = W / H;
            if (s.view === 'driver') {
              // A little above a driver's eye, so the road ahead reads.
              const fy = d.surfaceAt(s.from[0], s.from[1]);
              cam.fov = 60;
              cam.near = 0.5;
              cam.far = 600;
              cam.position.set(s.from[0], Math.max(fy, y) + 4.5, s.from[1]);
              cam.up.set(0, 1, 0);
              cam.lookAt(s.x + (s.x - s.from[0]) * 0.5, y, s.z + (s.z - s.from[1]) * 0.5);
            } else {
              const span = 40, up = 400;
              cam.fov = (2 * Math.atan(span / 2 / up) * 180) / Math.PI;
              cam.near = 10;
              cam.far = up + 200;
              cam.position.set(s.x, y + up, s.z);
              cam.up.set(0, 0, -1);
              cam.lookAt(s.x, y, s.z);
            }
            cam.updateProjectionMatrix();
            const fog = g.scene.fog;
            g.scene.fog = null;
            g.renderer.render(g.scene, cam);
            g.scene.fog = fog;
            const x = (q % COLS) * W, yy = Math.floor(q / COLS) * H;
            c2.drawImage(g.renderer.domElement, x, yy, W, H);
            c2.fillStyle = 'rgba(0,0,0,0.6)';
            c2.fillRect(x, yy, W, 18);
            c2.fillStyle = '#fff';
            c2.font = '12px sans-serif';
            c2.fillText(`${n0 + q}  ${s.what}  (${Math.round(s.x)}, ${Math.round(s.z)})`, x + 4, yy + 13);
          }
          return sheet.toDataURL('image/jpeg', 0.85);
        },
        [spots.slice(s0, s0 + COLS * ROWS), s0, COLS, ROWS, W, H],
      );
      const file = path.join(OUT, `sheet-${String(s0 / (COLS * ROWS)).padStart(3, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
      console.log(file);
    }
    await b.close();
  } finally {
    try {
      process.kill(-server.pid);
    } catch {}
  }
})();
