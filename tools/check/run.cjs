// Map-wide checks on the built game (run `npm run build` first, then `npm run check`).
// Starts a preview server, loads Pasir Ris & Tampines with ?debug in headless
// Chromium, and runs each check script against the live road plan.
// Exits non-zero if any check fails, so it can gate a build.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require('playwright');

const PORT = 4179;
const DEPS = { 'fuel.js': ['bot.js'], 'edges.js': ['finish.js'], 'crossings.js': ['finish.js'], 'paths.js': ['finish.js'], 'marks.js': ['finish.js', 'edges.js'], 'drive.js': ['seams.js'], 'ride.js': ['seams.js'], 'lanes.js': ['seams.js'], 'gores.js': ['seams.js'], 'routes.js': ['bot.js'], 'walk.js': ['bot.js'], 'outline.js': ['finish.js'], 'watertight.js': ['finish.js'] };
const CHECKS = [
  // [name, file, function, limit on the worst sample (m), known spots]
  // A check with known spots passes while it finds no more than that many:
  // a ratchet, lowered as they are fixed, until it reaches 0. Known spots
  // given as { course: n } hold for that course only (0 on the others).
  // The performance budget (perf.js: the figures and where they come from).
  // First, on the page as a player has it: the other checks leave their
  // own indexes of the whole map in memory, and the browser's clean-up of
  // those lands inside a slice (31 ms alone, 61 ms after one finished-road
  // check, 102 ms after all of them, in a different kind of slice each time).
  ['The game starts within 25 s (user\'s hold, 23 Nov; back to 20 s)', 'perf.js', '__checkStart', 0],
  // Saving (save.ts): codes round-trip, a damaged code is refused, the autosave holds the car's spot.
  ['A save code gives back the same journey, and a damaged or cut-short code is refused', 'save.js', '__checkSaveCodes', 0],
  ['The autosave keeps the car\'s spot, and your place on other drives', 'save.js', '__checkAutosave', 0.5],
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
  ['No junction offers more than four ways to go', 'arms.js', '__checkArms', 0, { pasirris: 7, whole: 4 }],
  ['No two junctions overlap', 'junctions.js', '__checkJunctionOverlap', 0],
  ['No kerb across a road', 'junctions.js', '__checkKerbAcross', 0],
  ['Junctions stay on their roads', 'junctions.js', '__checkJunctionSpill', 0],
  ['No junction is paved more than 5.5 m from its roads, anywhere inside it', 'junctions.js', '__checkJunctionReach', 0, { pasirris: 35, whole: 16 }],
  ['Crossings lie on their own road', 'crossings.js', '__checkCrossings', 0],
  ['No traffic light on a road or in a junction', 'crossings.js', '__checkLightPoles', 0],
  ['A junction\'s yellow box lies on its paving', 'crossings.js', '__checkYellowBoxes', 0],
  ['A footpath lies on the grass, never under it or folded over itself', 'paths.js', '__checkPaths', 0],
  ['No gap in any road (seams, wedges)', 'seams.js', '__checkSeams', 0, { pasirris: 22, whole: 6 }],
  ['No step where road pieces meet', 'seams.js', '__checkSteps', 0],
  ['No stray kerb or road marking inside a junction', 'stray.js', '__checkStray', 0],
  ['A through road\'s lines carry on across its junctions', 'through.js', '__checkThroughLines', 0],
  ['A through road\'s lines meet the road\'s own at the junction\'s edge', 'through.js', '__checkThroughJoins', 0],
  ['A through road\'s edge runs on smoothly where nothing joins it', 'through.js', '__checkThroughEdges', 0],
  ['Every road joining a through road has its give-way line', 'through.js', '__checkGiveWays', 0],
  ['The car rides on the road you see', 'ride.js', '__checkRide', 0],
  // Drivable from a standstill: 60% of what the car can do (src/limits.ts).
  ['No lip the car can\'t climb', 'drive.js', '__checkLips', 0, { pasirris: 13, whole: 5 }],
  ['No slope the car can\'t climb', 'drive.js', '__checkGrades', 0, { pasirris: 4 }],
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
  ['No road jogs sideways (sharp turn and straight back)', 'kinks.js', '__checkKinks', 0, { pasirris: 78, whole: 11, trial: 1 }],
  ['No gap where two roads split or join', 'gores.js', '__checkGores', 0],
  // (120: 69 sides of ground splits still drawn from one point, 51 paved junctions whose outline kinks.)
  ['Where a road splits or two join, its outside edges carry on', 'splits.js', '__checkSplitEdges', 0, { pasirris: 8, whole: 4 }],
  // The finished road (finish.js): what is drawn, followed along the whole of
  // every road, whatever rule drew it. (Known: counted on the map as it
  // stood when these checks were written.)
  ['A road\'s outside edge never jumps sideways, along its whole length', 'finish.js', '__checkEdgeRuns', 0, { pasirris: 147, whole: 13 }],
  // (201 to 213, the user's call on 16 Nov: thin medians on today's map
  // now end in a rounded point and are counted in more pieces, their total
  // length down from 444 m to 400 m.)
  ['No thin sliver of ground between roads side by side', 'finish.js', '__checkSlivers', 0, { pasirris: 191, whole: 16, trial: 1 }],
  ['The road is one sheet: no piece lying over another at a different height', 'finish.js', '__checkOneSheet', 0, { pasirris: 197, whole: 29, trial: 7 }],
  ['Nothing upright stands on a surface you can drive on', 'finish.js', '__checkUprights', 0, { pasirris: 21 }],
  ['Splits beside a flyover where the builder\'s rules are switched off', 'finish.js', '__checkSwitchedOff', 0, { pasirris: 54, whole: 9, trial: 1 }],
  // The sides of raised roads (edges.js): a parapet wherever the road's edge
  // drops away, and walls that end by coming down to the ground, not as a
  // square stub. (Known: counted on today's map when these were written.)
  ['A raised road\'s edge never drops away with no parapet', 'edges.js', '__checkOpenEdges', 0, { pasirris: 14, whole: 5, trial: 1 }],
  ['A wall beside a road never ends as a square stub on the verge', 'edges.js', '__checkWallEnds', 0, { pasirris: 33, whole: 37, trial: 4 }],
  ['The ground beside a raised road keeps its bank: the road never cuts it away', 'edges.js', '__checkBanks', 0],
  // (Roads as one line: where the map marks a road as carrying straight on
  // past a side road, nothing of the joint may show. No marks, nothing to test.)
  ['A road is one strip past a side road: no cut, step, turn or break in its kerb and lines', 'finish.js', '__checkOneStrip', 0],
  // (Kerbs and markings as one line, as the road is: read off the drawn
  // meshes. Redrawn maps only: today's map keeps its old lines until the
  // redrawn map replaces it.)
  ['An edge line never jumps sideways or breaks off and starts again', 'marks.js', '__checkEdgeBreaks', 0],
  ['Every kerb has its edge line beside it, but at a mouth, crossing or gore', 'marks.js', '__checkKerbLines', 0],
  ['Every marking lies on the surface drawn under it, never more than 1 cm under it', 'marks.js', '__checkMarkDepth', 0],
  // (A count that may only go down: 233 when it was written, the live build 262. The user's call, 2026-11-16: fixed in the next round.)
  ['Every marking lies on the surface drawn under it, never more than 4 cm up off it', 'marks.js', '__checkMarkFloat', 0, { whole: 231, trial: 31 }],
  ['Every island ends in a small rounded point: no square end, no spike, no crossing kerbs, no wall standing at its point', 'marks.js', '__checkNoses', 0],
  ['Every island narrows smoothly to its point: no corner of its outline turns more than 4 deg within 10 m of it', 'marks.js', '__checkNoseCorners', 0],
  // (The user's rules 1 and 2 at every point, 18 Nov.)
  ['Two roads at different heights never fold into one point: at every point, the paving either side within 0.3 m of one height', 'marks.js', '__checkTipSteps', 0],
  ['A kerb runs wherever an edge line has ground beyond it', 'marks.js', '__checkKerbBeside', 0],
  // (The road's outline as drawn, outline.js: the rules from feedback 8.)
  ['No uncovered gap inside the road: no crack between pieces of its surface', 'outline.js', '__checkGaps', 0],
  ['Every kerb runs on unbroken, its whole width showing: no step, gap or fragment over 2 cm', 'outline.js', '__checkKerbLoops', 0],
  ['No wall or parapet stands more than 2 cm out past the kerb beside it', 'outline.js', '__checkUprightsInKerb', 0],
  // (The user's rule, 18 Nov: a bridge's parapets begin where the ground drops.)
  ['A parapet stands only where the ground beside it falls away: none on an island or verge level with the road', 'outline.js', '__checkParapetDrop', 0],
  // (A count that may only go down: 23 when it was written, most where two roads at different heights fold into one nose. The user's call, 2026-11-17: fixed in the next round with the floating lines.)
  // (The user's slip-road rules S3-S5, 19 Nov, read off the finished
  // meshes: no edge of a road, kerb or island's lawn over a fall without a
  // face down to what lies below, and no ground standing over a kerb or a
  // wall's top. Counts that may only go down, the user's calls on 20 Nov:
  // today's map, built the old way, at what it has (05:29 UTC); the
  // redrawn maps' few left (roads overlapping a lower one at a ramp's
  // edge, a lane's end by the Tampines Hub garage, the trial map's cut end
  // of a viaduct) held at a count too, for the next changes to fix (08:44).
  // An island with both kerbs at one level built as main builds it, two
  // halves of lawn meeting in its middle, their hidden gaps over a fall
  // held at main's count too, the user's call on 21 Nov (23:06 UTC), for
  // the next change, one sheet of lawn kerb to kerb, to fix. Held again at
  // 263 and 29, more islands on main's lawn, the user's call on 22 Nov
  // (09:22 UTC).)
  ['Every top edge over a fall has a face down to what lies below: no slit, no square wall end, no floating lawn', 'watertight.js', '__checkWatertight', 0, { pasirris: 881, whole: 43, trial: 13 }],
  ['The ground never stands over a kerb, a road\'s edge or a wall\'s top beside it', 'watertight.js', '__checkGroundOverTops', 0, { pasirris: 4, whole: 1 }],
  // (The whole map's held at 31, the user's call on 24 Nov (00:27 UTC):
  // ten more with the one-sheet lawn, 0.1 to 2.4 cm low; may only go down.)
  ['An island is never lower than the road beside it: every kerb 3 cm over the road, the island level with its top', 'outline.js', '__checkIslandTops', 0, { whole: 31, trial: 6 }],
  // (The reviewer's and feedback thread's rule, 20 Nov. The user held today's
  // dips and holes, and the top-edge count's six small lips in those holes,
  // at a count that may only go down (21 Nov), for a follow-up to fix. Its
  // holes at main's count once its lawn is main's again (23:06 UTC), 762
  // with more islands on main's lawn (22 Nov, 09:22 UTC).)
  // (The trial map's held at 15, the user's call on 23 Nov (08:21 UTC): the one-sheet lawn eases gently down to a footpath crossing an island, where main stepped down to it; a follow-up builds the step.)
  // (The whole map's held at 336, the user's call on 24 Nov (00:27 UTC):
  // most the same easing to footpaths as the trial map's, 14 where the
  // lawn slopes from both kerbs down to the ground at an island's open
  // end; the follow-up's level lawn fixes both. May only go down.) At
  // 338 by the user's call on 24 Nov (21:54 UTC), with the shared median's
  // level lawn: two places 1.5 and 0.8 cm past the tolerance.
  // (Lowered with the one-sheet lawn, 24 Nov: the top-edge, hole and
  // lawn-in-kerbs counts to what it has, 53/15, 229/6 and 5/0; the
  // top-edge and fold counts to 50/14 and 538/70 with the shared median's.)
  ['An island with both kerbs at one level is one flat lawn kerb to kerb: no fold, crease, trench, spike or step', 'outline.js', '__checkLevelIslands', 0, { whole: 338, trial: 15 }],
  ['An island with both kerbs at one level has no hole in its lawn', 'outline.js', '__checkLevelIslandHoles', 0, { whole: 229, trial: 6 }],
  // (The reviewer's rule, 21 Nov. The user held its places at today's count,
  // 21 Nov, 11 of the whole map's 12 on main before it; may only go down.)
  // (The user's pick, 22 Nov: each island's lawn one sheet. Zero, on every map.)
  ['An island\'s lawn is one sheet: it meets the next tile\'s lawn at the tile\'s border, at the same height', 'outline.js', '__checkLawnSeams', 0],
  // (Held at the one-sheet lawn's count, the user's call on 23 Nov (23:56
  // UTC): steep ground beside ramps, kerb-height drops where kerbs end at
  // paths, high islands between ramps, none seen at eye level; main's own
  // lawn has 56 and 696 by this check. May only go down; follow-ups fix.)
  ['An island\'s lawn has no fold: no crease over 30 degrees between neighbouring pieces, none steeper than 40 degrees', 'outline.js', '__checkLawnFolds', 0, { whole: 532, trial: 70 }],
  ['An island\'s grass stays inside its kerbs: no lawn more than 5 cm out over a road', 'outline.js', '__checkLawnInIsland', 0, { whole: 5 }],
  // (Last: these move the car.)
  // Fuel (fuel.ts): never stranded, and every station can be filled up at.
  ['Every petrol station is a place: a paved, solid forecourt a road runs onto and its lanes end on, clear of public roads, and the pump works only on it', 'fuel.js', '__checkStations', 0],
  ['With an empty tank the car still climbs the steepest slip road, at a crawl', 'fuel.js', '__checkFuelCrawl', 0],
  // Garages (garage.ts).
  ['Every garage bay lies wholly on a road, clear overhead and paved on its approach, and a car in it is offered the garage', 'garage.js', '__checkGarageBay', 0],
];

(async () => {
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  let failed = false;
  try {
    await new Promise((r) => setTimeout(r, 2500));
    // (Room for the whole map's lawn: each check reads every tile's meshes, and at the default heap the page ran out at the island checks.)
    const launch = () => chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--js-flags=--max-old-space-size=8192'] });
    let b = await launch();
    // (A page of its own, in a context of its own: closing the context ends
    // the renderer and frees all its memory, which a reload did not. And a
    // browser afresh if the crash took the browser down with it, as the
    // whole map's fold check did on 24 Nov.)
    const open = async () => {
      if (!b.isConnected()) b = await launch();
      const q = await (await b.newContext({ viewport: { width: 640, height: 360 } })).newPage();
      q.on('pageerror', (e) => console.log('page error:', e.message));
      return q;
    };
    let p = await open();
    const t0 = Date.now();
    await p.goto(`http://localhost:${PORT}/?course=${process.env.COURSE || 'pasirris'}&debug`);
    await p.waitForFunction(() => window.game && globalThis.__osm, null, { timeout: 240000 });
    // (How long the game took to start, for the performance budget.)
    await p.evaluate((ms) => (window.__startMs = ms), Date.now() - t0);
    const loaded = new Set();
    // (ONLY=regex runs just the matching checks.)
    const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
    const course = process.env.COURSE || 'pasirris';
    const FRESH = new Set(['__checkWatertight', '__checkIslandTops', '__checkLevelIslands', '__checkLevelIslandHoles', '__checkLawnSeams', '__checkLawnFolds', '__checkLawnInIsland']);
    for (const [name, file, fn, limit, knownAt = 0] of CHECKS) {
      const known = typeof knownAt === 'number' ? knownAt : knownAt[course] ?? 0;
      if (only && !only.test(name)) continue;
      // (The island and lawn checks on a fresh page: every check before them
      // leaves its own index of the whole map in memory, and with the
      // whole map's lawn one sheet the page ran out at the first of them.
      // The top-edge check reads every lawn too, and the page ran out there
      // on 23 Nov, so it starts a fresh page as well. On 24 Nov the page ran
      // out at the flat-island check after the top-edge one, so each of the
      // lawn checks now gets a fresh page of its own.)
      const fresh = async () => {
        await p.context().close().catch(() => {});
        p = await open();
        await p.goto(`http://localhost:${PORT}/?course=${course}&debug`);
        await p.waitForFunction(() => window.game && globalThis.__osm, null, { timeout: 240000 });
        loaded.clear();
      };
      if (FRESH.has(fn) && loaded.size) await fresh();
      // (drive.js uses seams.js's road index; routes.js and walk.js drive with bot.js.)
      for (const f of [...(DEPS[file] ?? []), file]) {
        if (!loaded.has(f)) await p.addScriptTag({ path: path.join(__dirname, f) });
        loaded.add(f);
      }
      // (A page that runs out of memory fails its check, and the run goes on
      // on a fresh page, so one crash doesn't hide every check after it.)
      let r;
      try {
        r = await p.evaluate((fn) => window[fn](), fn);
      } catch (e) {
        failed = true;
        console.log(`FAIL  ${name}: the page crashed (${String(e.message).split('\n')[0]})`);
        await fresh();
        continue;
      }
      const worst = r.worst[0]?.over ?? 0;
      const ok = known > 0 ? r.bad <= known : worst <= limit && (limit > 0 || r.bad === 0);
      if (!ok) failed = true;
      const tail = known > 0 ? `(known: ${known}, may not grow)` : `(limit ${limit})`;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${r.bad} of ${r.samples} samples off, worst ${worst} ${r.unit ?? 'm'} ${tail}${r.note ? ` [${r.note}]` : ''}`);
      if (!ok || known > 0) for (const w of r.worst.slice(0, process.env.ALL ? Infinity : ok ? 3 : 12)) console.log('      ', JSON.stringify(w));
    }
    await b.close();
  } finally {
    server.kill();
  }
  process.exit(failed ? 1 : 0);
})();
