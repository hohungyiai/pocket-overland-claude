// Map-wide checks on the built game (run `npm run build` first, then `npm run check`).
// Starts a preview server, loads Pasir Ris & Tampines with ?debug in headless
// Chromium, and runs each check script against the live road plan.
// Exits non-zero if any check fails, so it can gate a build.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require('playwright');

const PORT = 4179;
const DEPS = { 'drive.js': ['seams.js'], 'lanes.js': ['seams.js'], 'gores.js': ['seams.js'], 'routes.js': ['bot.js'] };
const CHECKS = [
  // [name, file, function, limit on the worst sample (m), known spots]
  // A check with known spots passes while it finds no more than that many:
  // a ratchet, lowered as they are fixed, until it reaches 0.
  ['Ground never rises above a road', 'ground.js', '__checkGround', 0],
  ['No pier stands on a road', 'piers.js', '__checkPiers', 0],
  // (Known: the Tampines Viaduct over the Upper Changi Rd North slip road, held
  // 0.7 m low so the slip road beside it is climbable from a standstill.)
  ['At least 4.8 m headroom under every road above', 'headroom.js', '__checkHeadroom', 0, 1],
  ['Ground never shows through a junction', 'junctions.js', '__checkJunctionGround', 0, 1],
  ['No two junctions overlap', 'junctions.js', '__checkJunctionOverlap', 0],
  ['No kerb across a road', 'junctions.js', '__checkKerbAcross', 0],
  ['Junctions stay on their roads', 'junctions.js', '__checkJunctionSpill', 0],
  ['Crossings lie on their own road', 'crossings.js', '__checkCrossings', 0],
  ['No traffic light on a road or in a junction', 'crossings.js', '__checkLightPoles', 0],
  ['No gap in any road (seams, wedges)', 'seams.js', '__checkSeams', 0, 29],
  ['No step where road pieces meet', 'seams.js', '__checkSteps', 0],
  ['No stray kerb or road marking inside a junction', 'stray.js', '__checkStray', 0],
  ['The car rides on the road you see', 'ride.js', '__checkRide', 0],
  // Drivable from a standstill: 60% of what the car can do (src/limits.ts).
  ['No lip the car can\'t climb', 'drive.js', '__checkLips', 0, 23],
  ['No slope the car can\'t climb', 'drive.js', '__checkGrades', 0, 11],
  ['No side tilt that could tip the car', 'drive.js', '__checkTilt', 0],
  ['The drive bot gets through the hard spots', 'routes.js', '__checkRoutes', 0],
  // (5 left, of 838 before kerbs and lines stopped at other roads: three
  // TPE / Halus Link spots where expressway pieces lie side by side, for the
  // merge rebuild, and one on Tampines Road.)
  ['No kerb or road line across a lane', 'lanes.js', '__checkLanes', 0, 1],
  ['No bite out of a road\'s edge', 'lanes.js', '__checkEdges', 0],
  ['Widths change no faster than 1 m per 20 m', 'lanes.js', '__checkWidths', 0],
  // (79: corners OSM itself draws as a jog, nearly all on service lanes.)
  ['No road jogs sideways (sharp turn and straight back)', 'kinks.js', '__checkKinks', 0, 79],
  ['No gap where two roads split or join', 'gores.js', '__checkGores', 0],
];

(async () => {
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  let failed = false;
  try {
    await new Promise((r) => setTimeout(r, 2500));
    const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const p = await (await b.newContext({ viewport: { width: 640, height: 360 } })).newPage();
    p.on('pageerror', (e) => console.log('page error:', e.message));
    await p.goto(`http://localhost:${PORT}/?course=pasirris&debug`);
    await p.waitForFunction(() => window.game && globalThis.__osm, null, { timeout: 240000 });
    const loaded = new Set();
    // (ONLY=regex runs just the matching checks.)
    const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
    for (const [name, file, fn, limit, known = 0] of CHECKS) {
      if (only && !only.test(name)) continue;
      // (drive.js uses seams.js's road index; routes.js drives with bot.js.)
      for (const f of [...(DEPS[file] ?? []), file]) {
        if (!loaded.has(f)) await p.addScriptTag({ path: path.join(__dirname, f) });
        loaded.add(f);
      }
      const r = await p.evaluate((fn) => window[fn](), fn);
      const worst = r.worst[0]?.over ?? 0;
      const ok = known > 0 ? r.bad <= known : worst <= limit && (limit > 0 || r.bad === 0);
      if (!ok) failed = true;
      const tail = known > 0 ? `(known: ${known}, may not grow)` : `(limit ${limit})`;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${r.bad} of ${r.samples} samples off, worst ${worst} m ${tail}`);
      if (!ok || known > 0) for (const w of r.worst.slice(0, ok ? 3 : 12)) console.log('      ', JSON.stringify(w));
    }
    await b.close();
  } finally {
    server.kill();
  }
  process.exit(failed ? 1 : 0);
})();
