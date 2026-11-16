// Checks for the Pulau Ubin trail (run `npm run build` first, then
// `node tools/check/ubin.cjs [name...]`). Loads ?course=ubintrail in headless
// Chromium and drives the bot (ubin-bot.js) at each obstacle:
//   - with the wrong kit it does not get through (the obstacle teaches),
//   - with the right kit it does, on the hard line,
//   - after three tries the way round opens, and the bot gets round it
//     with no kit at all,
//   - the whole trail from the jetty to the camp, on the hard line.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const PORT = 4182;
const ROOT = path.join(__dirname, '..', '..');
const only = process.argv.slice(2);

const KIT = {
  climb: { wrong: { low: false, diff: false, cruise: 6 }, right: { low: true, diff: false, cruise: 5 } },
  // (In this car's physics low range does most of the work here; the diff
  // lock makes it smoother and quicker. High range with an open diff stops.)
  washout: { wrong: { low: false, diff: false, cruise: 6 }, right: { low: true, diff: true, cruise: 3 } },
  // (Sand teaches momentum: crawl and you dig in, at any gear.)
  sand: { wrong: { low: false, diff: false, cruise: 4 }, right: { low: false, diff: false, cruise: 10 } },
};

(async () => {
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2500));
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const fresh = async () => {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    if (process.env.TUNE) await page.addInitScript((t) => (window.__ubinTune = JSON.parse(t)), process.env.TUNE);
    page.on('pageerror', (e) => console.log('pageerror', e.message));
    await page.goto(`http://localhost:${PORT}/?course=ubintrail&debug`);
    await page.waitForFunction(() => window.game, null, { timeout: 120000 });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, 'ubin-bot.js'), 'utf8') });
    return page;
  };
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  };
  const want = (n) => !only.length || only.some((o) => n.includes(o));
  try {
    let page = await fresh();
    const obs = await page.evaluate(() => window.__ubinObstacles());
    console.log('obstacles', JSON.stringify(obs));
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      if (!want(o.kind)) continue;
      const stretch = (s0, s1) => page.evaluate(([a, b]) => window.__ubinRoute(a, b), [s0, s1]);
      const run = (pts, opts) => page.evaluate(([p, k]) => window.__ubinDrive(p, k), [pts, opts]);
      const pts = await stretch(o.s0 - 45, o.s1 + 25);
      const wrong = await run(pts, { ...KIT[o.kind].wrong, timeout: 120 });
      check(`${o.kind}: the wrong kit does not get through`, !wrong.done, `(reached ${wrong.at}/${wrong.total}, ${wrong.seconds}s) tips: ${JSON.stringify(wrong.tips.map((t) => t[1]))}`);
      await page.close();
      page = await fresh();
      const right = await page.evaluate(([p, k]) => window.__ubinDrive(p, k), [await page.evaluate(([a, b]) => window.__ubinRoute(a, b), [o.s0 - 45, o.s1 + 25]), { ...KIT[o.kind].right, timeout: 120 }]);
      const st = (await page.evaluate(() => window.__ubinObstacles()))[i];
      check(`${o.kind}: the right kit gets through on the hard line`, right.done && st.done === 'hard', `(${right.seconds}s, lean ${right.maxLeanDeg}°, ${st.done}) says: ${JSON.stringify(right.says.map((t) => t[1]))}`);
      await page.close();
      page = await fresh();
      // Tries with the wrong kit, from the run-in each time: the way round
      // opens after the third.
      let st2 = null;
      const sayings = [];
      for (let k = 0; k < 5; k++) {
        const t = await page.evaluate(([p, kit]) => window.__ubinDrive(p, kit), [await page.evaluate(([a, b]) => window.__ubinRoute(a, b), [o.s0 - 45, o.s1 + 25]), { ...KIT[o.kind].wrong, timeout: 90, giveUp: 5 }]);
        sayings.push(...t.says.map((x) => x[1]), ...t.tips.map((x) => 'tip: ' + x[1]));
        st2 = (await page.evaluate(() => window.__ubinObstacles()))[i];
        if (st2.open) break;
      }
      check(`${o.kind}: the way round opens after three tries, not before`, st2.open && st2.tries === 3, `(tries ${st2.tries}) ${JSON.stringify([...new Set(sayings)])}`);
      const round = await page.evaluate(([i]) => window.__ubinDrive(window.__ubinRound(i), { low: false, diff: false, cruise: 6, timeout: 150 }), [i]);
      const st3 = (await page.evaluate(() => window.__ubinObstacles()))[i];
      check(`${o.kind}: the way round gets through with no kit`, round.done && st3.done === 'round', `(${round.seconds}s, ${st3.done})`);
      await page.close();
      page = await fresh();
    }
    if (want('whole')) {
      // The whole trail, jetty to camp, in legs: cruising between the
      // obstacles, the right kit at each. Never stuck, never tipped.
      const legs = await page.evaluate(() => {
        const t = window.game.course.trail;
        const L = t.route.length;
        const out = [];
        let s = 0;
        for (const o of t.obstacles) {
          out.push({ name: `to the ${o.kind}`, s0: s, s1: o.s0 - 15, kit: { low: false, diff: false, cruise: 9 } });
          const k = { climb: { low: true, diff: false, cruise: 5 }, washout: { low: true, diff: true, cruise: 3 }, sand: { low: false, diff: false, cruise: 10 } }[o.kind];
          out.push({ name: o.kind, s0: o.s0 - 15, s1: o.s1 + 15, kit: k });
          s = o.s1 + 15;
        }
        out.push({ name: 'to camp', s0: s, s1: L, kit: { low: false, diff: false, cruise: 9 } });
        return out;
      });
      let ok = true;
      let secs = 0;
      let lean = 0;
      for (const [n, leg] of legs.entries()) {
        const r = await page.evaluate(([l, first]) => window.__ubinDrive(window.__ubinRoute(l.s0, l.s1), { ...l.kit, timeout: 900, place: first }), [leg, n === 0]);
        secs += r.seconds;
        lean = Math.max(lean, r.maxLeanDeg);
        if (!r.done) {
          ok = false;
          console.log('  leg', leg.name, 'failed', JSON.stringify({ at: r.at, total: r.total, pos: r.pos, stuck: r.stuck, tipped: r.tipped, timeout: r.timeout }));
          break;
        }
      }
      const st = await page.evaluate(() => window.__ubinObstacles());
      const camp = await page.evaluate(() => {
        const p = window.game.car.body.translation();
        return window.game.camps?.at(p.x, p.z)?.label ?? null;
      });
      check('whole trail: jetty to camp on the hard line, never stuck or tipped', ok && st.every((o) => o.done === 'hard') && !!camp, `(${Math.round(secs / 60)} min of driving, max lean ${lean}°, camp: ${camp})`);
    }
  } finally {
    await browser.close();
    server.kill();
  }
  const bad = results.filter((r) => !r.ok).length;
  console.log(`${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})();
