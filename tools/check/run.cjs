// Map-wide checks on the built game (run `npm run build` first, then `npm run check`).
// Starts a preview server, loads Pasir Ris & Tampines with ?debug in headless
// Chromium, and runs each check script against the live road plan.
// Exits non-zero if any check fails, so it can gate a build.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require('playwright');

const PORT = 4179;
const DEPS = { 'drive.js': ['seams.js'], 'ride.js': ['seams.js'], 'lanes.js': ['seams.js'], 'gores.js': ['seams.js'], 'routes.js': ['bot.js'], 'walk.js': ['bot.js'] };
const CHECKS = [
  // [name, file, function, limit on the worst sample (m), known spots]
  // A check with known spots passes while it finds no more than that many:
  // a ratchet, lowered as they are fixed, until it reaches 0.
  // The performance budget (perf.js: the figures and where they come from).
  // First, on the page as a player has it: the other checks leave their
  // own indexes of the whole map in memory, and the browser's clean-up of
  // those lands inside a slice (31 ms alone, 61 ms after one finished-road
  // check, 102 ms after all of them, in a different kind of slice each time).
  ['The game starts within 20 s', 'perf.js', '__checkStart', 0],
  ['No frame draws more than the budget, anywhere on the map', 'perf.js', '__checkDrawn', 0],
  ['No slice of map building holds a frame up for more than 100 ms', 'perf.js', '__checkSlices', 0],
  ['Ground never rises above a road', 'ground.js', '__checkGround', 0],
  ['No pier stands on a road', 'piers.js', '__checkPiers', 0],
  ['At least 4.8 m headroom under every footbridge', 'footbridges.js', '__checkFootHeadroom', 0],
  ['No footbridge pier or stair stands on a road', 'footbridges.js', '__checkFootSupports', 0],
  ['At least 4.8 m headroom under every road above', 'headroom.js', '__checkHeadroom', 0],
  ['A flyover stays up along its whole length', 'dips.js', '__checkDips', 0],
  ['No two roads cross at the same height', 'headroom.js', '__checkCrossings', 0],
  ['No building stands up through a raised road', 'buildings.js', '__checkBuildingsUnderRoads', 0],
  ['No building wall or column stands on a road', 'buildings.js', '__checkBuildingsOnRoads', 0],
  ['Every piece of road surface faces up', 'facing.js', '__checkFacing', 0],
  ['Ground never shows through a junction', 'junctions.js', '__checkJunctionGround', 0],
  // (Known: seven real junctions where five or six roads meet at one point
  // in the map data; the ratchet is there to catch new ones.)
  ['No junction offers more than four ways to go', 'arms.js', '__checkArms', 0, 7],
  ['No two junctions overlap', 'junctions.js', '__checkJunctionOverlap', 0],
  ['No kerb across a road', 'junctions.js', '__checkKerbAcross', 0],
  ['Junctions stay on their roads', 'junctions.js', '__checkJunctionSpill', 0],
  ['No junction is paved more than 5.5 m from its roads, anywhere inside it', 'junctions.js', '__checkJunctionReach', 0, 35],
  ['Crossings lie on their own road', 'crossings.js', '__checkCrossings', 0],
  ['No traffic light on a road or in a junction', 'crossings.js', '__checkLightPoles', 0],
  ['No gap in any road (seams, wedges)', 'seams.js', '__checkSeams', 0, 23],
  ['No step where road pieces meet', 'seams.js', '__checkSteps', 0],
  ['No stray kerb or road marking inside a junction', 'stray.js', '__checkStray', 0],
  ['A through road\'s lines carry on across its junctions', 'through.js', '__checkThroughLines', 0],
  ['A through road\'s lines meet the road\'s own at the junction\'s edge', 'through.js', '__checkThroughJoins', 0],
  ['A through road\'s edge runs on smoothly where nothing joins it', 'through.js', '__checkThroughEdges', 0],
  ['Every road joining a through road has its give-way line', 'through.js', '__checkGiveWays', 0],
  ['The car rides on the road you see', 'ride.js', '__checkRide', 0],
  // Drivable from a standstill: 60% of what the car can do (src/limits.ts).
  ['No lip the car can\'t climb', 'drive.js', '__checkLips', 0, 13],
  ['No slope the car can\'t climb', 'drive.js', '__checkGrades', 0, 4],
  ['No side tilt that could tip the car', 'drive.js', '__checkTilt', 0],
  ['The drive bot gets through the hard spots', 'routes.js', '__checkRoutes', 0],
  ['The drive bot gets round the map on random trips, never stuck or tipped over', 'walk.js', '__checkWalk', 0],
  // (5 left, of 838 before kerbs and lines stopped at other roads: three
  // TPE / Halus Link spots where expressway pieces lie side by side, for the
  // merge rebuild, and one on Tampines Road.)
  ['No kerb or road line across a lane', 'lanes.js', '__checkLanes', 0],
  ['No bite out of a road\'s edge', 'lanes.js', '__checkEdges', 0],
  ['Widths change no faster than 1 m per 20 m (50 m on expressways), through junctions too', 'lanes.js', '__checkWidths', 0],
  // (79: corners OSM itself draws as a jog, nearly all on service lanes.)
  ['No road jogs sideways (sharp turn and straight back)', 'kinks.js', '__checkKinks', 0, 79],
  ['No gap where two roads split or join', 'gores.js', '__checkGores', 0],
  // (120: 69 sides of ground splits still drawn from one point, 51 paved junctions whose outline kinks.)
  ['Where a road splits or two join, its outside edges carry on', 'splits.js', '__checkSplitEdges', 0, 9],
  // The finished road (finish.js): what is drawn, followed along the whole of
  // every road, whatever rule drew it. (Known: counted on the map as it
  // stood when these checks were written.)
  ['A road\'s outside edge never jumps sideways, along its whole length', 'finish.js', '__checkEdgeRuns', 0, 148],
  ['No thin sliver of ground between roads side by side', 'finish.js', '__checkSlivers', 0, 201],
  ['The road is one sheet: no piece lying over another at a different height', 'finish.js', '__checkOneSheet', 0, 198],
  ['Nothing upright stands on a surface you can drive on', 'finish.js', '__checkUprights', 0, 38],
  ['Splits beside a flyover where the builder\'s rules are switched off', 'finish.js', '__checkSwitchedOff', 0, 54],
];

(async () => {
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  let failed = false;
  try {
    await new Promise((r) => setTimeout(r, 2500));
    const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const p = await (await b.newContext({ viewport: { width: 640, height: 360 } })).newPage();
    p.on('pageerror', (e) => console.log('page error:', e.message));
    const t0 = Date.now();
    await p.goto(`http://localhost:${PORT}/?course=pasirris&debug`);
    await p.waitForFunction(() => window.game && globalThis.__osm, null, { timeout: 240000 });
    // (How long the game took to start, for the performance budget.)
    await p.evaluate((ms) => (window.__startMs = ms), Date.now() - t0);
    const loaded = new Set();
    // (ONLY=regex runs just the matching checks.)
    const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
    for (const [name, file, fn, limit, known = 0] of CHECKS) {
      if (only && !only.test(name)) continue;
      // (drive.js uses seams.js's road index; routes.js and walk.js drive with bot.js.)
      for (const f of [...(DEPS[file] ?? []), file]) {
        if (!loaded.has(f)) await p.addScriptTag({ path: path.join(__dirname, f) });
        loaded.add(f);
      }
      const r = await p.evaluate((fn) => window[fn](), fn);
      const worst = r.worst[0]?.over ?? 0;
      const ok = known > 0 ? r.bad <= known : worst <= limit && (limit > 0 || r.bad === 0);
      if (!ok) failed = true;
      const tail = known > 0 ? `(known: ${known}, may not grow)` : `(limit ${limit})`;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${r.bad} of ${r.samples} samples off, worst ${worst} ${r.unit ?? 'm'} ${tail}${r.note ? ` [${r.note}]` : ''}`);
      if (!ok || known > 0) for (const w of r.worst.slice(0, ok ? 3 : 12)) console.log('      ', JSON.stringify(w));
    }
    await b.close();
  } finally {
    server.kill();
  }
  process.exit(failed ? 1 : 0);
})();
