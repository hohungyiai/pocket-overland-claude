// Checks for Pulau Ubin's trails (run `npm run build` first, then
// `node tools/check/ubin.cjs [course] [name...]`, course one of ubintrail
// (Ketam, easy: the default), ubinpuaka (Puaka Hill, medium), ubinchekjawa
// (Chek Jawa, super hard), or "all"). Loads the course in headless
// Chromium and drives the bot (ubin-bot.js) at each obstacle:
//   - each thing it needs (low range, the diff lock, speed) is needed: left
//     out, the bot does not get through, however long it keeps trying,
//   - with the right kit it gets through, on the hard line,
//   - signposted trails: after three tries the way round opens, and the
//     bot gets round it with no kit at all,
//   - the hard trail: its hidden detour is drivable with no kit at all,
//   - the whole trail, start to end, on the hard line, never stuck or tipped.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const PORT = +(process.env.PORT || 4182);
const ROOT = path.join(__dirname, '..', '..');
const COURSES = ['ubintrail', 'ubinpuaka', 'ubinchekjawa'];
const args = process.argv.slice(2);
const courses = args[0] === 'all' ? COURSES : COURSES.includes(args[0]) ? [args[0]] : ['ubintrail'];
const only = args.filter((a) => a !== 'all' && !COURSES.includes(a));

// The kit for an obstacle, from what it needs: the right kit, and each
// kit with one thing left out. (Cruise: how fast the bot drives at it.)
const kitName = (k) => [k.low && 'low range', k.diff && 'the diff lock', k.cruise >= 9 && 'speed', k.off && Math.abs(k.off) < 4 && 'the high line'].filter(Boolean).join(' and ') || 'no kit';
const pace = (o) => (o.needs.speed ? 10 : o.kind === 'climb' ? 5 : o.kind === 'washout' ? 3 : 4);
const kits = (o, room = 150) => {
  const right = { low: !!o.needs.low, diff: !!o.needs.diff, cruise: pace(o) };
  const wrong = [];
  // (A descent needs low range for control, not to get down; an
  // off-camber stretch needs a line, not kit.)
  // Each missing thing is tried twice: at the obstacle's own pace, and
  // charging it after a long, fast run-up (so momentum is no way round).
  const both = (what, kit) => {
    wrong.push([what, kit]);
    wrong.push([`${what}, charging it from ${Math.round(45 + room)} m back`, { ...kit, cruise: kit.low ? 8 : 14, runUp: room }]);
  };
  if (o.needs.low) both('without low range', { ...right, low: false, cruise: Math.max(right.cruise, 6) });
  if (o.needs.diff) both('without the diff lock', { ...right, diff: false });
  if (o.needs.speed) wrong.push(['crawling at it', { ...right, cruise: 4 }]);
  if (o.camber) {
    // A line, not kit: the high side, against the bank. The middle of the
    // track slides you down it, slow or fast.
    const up = o.camber.dir ?? 1;
    right.off = ((o.camber.edge ?? 1) + 1.5) * up;
    both('on the middle of the track', { ...right, off: 0 });
  }
  for (const w of o.closed ?? []) {
    // Closed in: no way round it on the ground either side, even with the
    // right kit (the bog below a ridge or in a valley's ditches holds the
    // car; boulders block it), out to past the outermost closure.
    const off = Math.round(w + 3);
    wrong.push([`round it on the ground ${off} m to its left`, { ...right, off }]);
    wrong.push([`round it on the ground ${off} m to its right`, { ...right, off: -off }]);
  }
  return { right, wrong, none: { low: false, diff: false, cruise: o.needs.speed ? 4 : 6 } };
};

(async () => {
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2500));
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  let course = courses[0];
  const fresh = async () => {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    if (process.env.TUNE) await page.addInitScript((t) => (window.__ubinTune = JSON.parse(t)), process.env.TUNE);
    page.on('pageerror', (e) => console.log('pageerror', e.message));
    await page.goto(`http://localhost:${PORT}/?course=${course}&debug`);
    await page.waitForFunction(() => window.game, null, { timeout: 120000 });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, 'ubin-bot.js'), 'utf8') });
    return page;
  };
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name: `${course}: ${name}`, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${course}: ${name}${detail ? '  ' + detail : ''}`);
  };
  const want = (n) => !only.length || only.some((o) => n.toLowerCase().includes(o.toLowerCase()));
  try {
    for (course of courses) {
      let page = await fresh();
      const info = await page.evaluate(() => {
        const t = window.game.course.trail;
        return { roundKit: t.def.roundKit ?? {}, wayRound: t.def.wayRound, obs: t.obstacles.map((o) => ({ p: o.p, camber: o.parts.find((q) => q.kind === 'camber')?.p ?? null, mixed: o.parts.map((q) => q.kind).join('+'), closed: o.parts.filter((q) => ['ridge', 'thicket', 'valley'].includes(q.kind)).map((q) => (q.kind === 'thicket' ? (q.p.w ?? 3.4) + 1.6 * ((q.p.rows ?? 2) - 1) : (q.p.w ?? 2.6))), gate: !!o.gate, kind: o.kind, label: o.label, needs: o.needs, s0: o.s0, s1: o.s1 })), hasCamp: !!t.def.end.camp };
      });
      console.log(course, 'obstacles', JSON.stringify(info.obs.map((o) => [o.kind, Math.round(o.s0), Math.round(o.s1)])));
      // Water never hangs in the air: every edge point of the ford's water
      // within 0.15 m of the ground under it, and every puddle no more than
      // 0.12 m above the lowest ground at its rim.
      if (want('water')) {
        const w = await page.evaluate(() => {
          const c = window.game.course;
          const { edges, puddles } = c.water?.() ?? { edges: [], puddles: [] };
          let worstE = 0, badE = 0, worstP = 0, badP = 0, at = null;
          for (const e of edges) {
            const gap = e.y - c.heightAt(e.x, e.z);
            if (gap > worstE) { worstE = gap; at = [Math.round(e.x), Math.round(e.z)]; }
            if (gap > 0.15) badE++;
          }
          for (const p of puddles) {
            const gap = p.y - p.lo;
            worstP = Math.max(worstP, gap);
            if (gap > 0.12) badP++;
          }
          return { n: edges.length, badE, worstE, np: puddles.length, badP, worstP, at };
        });
        check('water and puddles sit on the ground, never in the air', w.badE === 0 && w.badP === 0, `(${w.badE} of ${w.n} water edge points over 0.15 m, worst ${w.worstE.toFixed(2)} m at ${w.at}; ${w.badP} of ${w.np} puddles over 0.12 m, worst ${w.worstP.toFixed(2)} m)`);
      }
      const drive = (pg, s0, s1, kit, extra = {}) =>
        pg.evaluate(([a, b, k]) => window.__ubinDrive(window.__ubinRouteOff(a - (k.runUp ?? 0), b, k.off ?? 0), k), [s0, s1, { ...kit, ...extra }]);
      for (let i = 0; i < info.obs.length; i++) {
        const o = info.obs[i];
        if (!want(o.kind) && !want(o.label)) continue;
        // (The start, and the run-up, stay clear of the obstacle before: on
        // a trail of chained stretches there is little room to charge one.)
        const prevEnd = i ? info.obs[i - 1].s1 + 8 : 0;
        const from = Math.max(prevEnd, o.s0 - 45);
        const K = kits(o, Math.max(0, Math.min(150, from - prevEnd)));
        const to = o.s1 + 25;
        // Each thing it needs, left out: no way through, even backing up
        // for more runs at it.
        for (const [what, kit] of K.wrong) {
          const r = await drive(page, from, to, kit, { timeout: 150, reverseAfterStall: 2 });
          const sw = (await page.evaluate(() => window.__ubinObstacles()))[i];
          check(`${o.label}: ${what}, the bot does not get through`, !(r.done && sw.done === 'hard'), `(reached ${r.at}/${r.total}, ${r.seconds}s, ${r.stalls} stalls, credited: ${sw.done})`);
          await page.close();
          page = await fresh();
        }
        // The winch only helps the wheels: each thing it needs left out,
        // hooking up whenever stuck still does not get it through.
        if (want('winch') && (await page.evaluate(() => !!window.game.course.winchAt)))
          for (const [what, kit] of K.wrong.filter(([w]) => !/charging/.test(w))) {
            const r = await drive(page, from, to, kit, { timeout: 150, winch: true });
            const sw = (await page.evaluate(() => window.__ubinObstacles()))[i];
            check(`${o.label}: ${what}, even winching whenever stuck the bot does not get through`, !(r.done && sw.done === 'hard'), `(reached ${r.at}/${r.total}, ${r.seconds}s, ${r.winched ?? 0} winch pulls, credited: ${sw.done})`);
            await page.close();
            page = await fresh();
          }
        const right = await drive(page, from, to, K.right, { timeout: 150 });
        const st = (await page.evaluate(() => window.__ubinObstacles()))[i];
        check(`${o.label}: with ${kitName(K.right)} the bot gets through on the hard line`, right.done && st.done === 'hard', `(${right.seconds}s, lean ${right.maxLeanDeg}°, ${st.done}) says: ${JSON.stringify(right.says.map((t) => t[1]))}`);
        await page.close();
        page = await fresh();
        if (!o.gate) continue;
        // Tries with no kit, from the run-in each time: the way round
        // opens after the third.
        let st2 = null;
        const sayings = [];
        for (let k = 0; k < 5; k++) {
          const t = await drive(page, from, to, K.none, { timeout: 90, giveUp: 5 });
          sayings.push(...t.says.map((x) => x[1]), ...t.tips.map((x) => 'tip: ' + x[1]));
          st2 = (await page.evaluate(() => window.__ubinObstacles()))[i];
          if (st2.open) break;
        }
        check(`${o.label}: the way round opens after three tries, not before`, st2.open && st2.tries === 3, `(tries ${st2.tries}) ${JSON.stringify([...new Set(sayings)])}`);
        const rk = { low: !!info.roundKit.low, diff: !!info.roundKit.diff, cruise: 6 };
        const round = await page.evaluate(([i, k]) => window.__ubinDrive(window.__ubinRound(i), { ...k, timeout: 150 }), [i, rk]);
        const st3 = (await page.evaluate(() => window.__ubinObstacles()))[i];
        check(`${o.label}: the way round gets through with ${kitName(rk)}`, round.done && st3.done === 'round', `(${round.seconds}s, ${st3.done})`);
        await page.close();
        page = await fresh();
      }
      if (info.wayRound === 'hidden' && want('detour')) {
        // The hidden detour: drivable all the way with no kit.
        const r = await page.evaluate(() => {
          const D = window.game.course.trail.detour;
          const pts = [];
          for (let s = 0; s <= D.length; s += 1) {
            const p = D.at(s);
            pts.push([p.x, p.z]);
          }
          return window.__ubinDrive(pts, { low: false, diff: false, cruise: 8, timeout: 900 });
        });
        check('the hidden detour gets through with no kit', r.done, `(${Math.round(r.seconds)}s, lean ${r.maxLeanDeg}°${r.done ? '' : `, stopped at ${r.at}/${r.total} ${JSON.stringify(r.pos)}`})`);
        await page.close();
        page = await fresh();
      }
      if (want('whole')) {
        // The whole trail in legs: cruising between the obstacles, the
        // right kit at each. Never stuck, never tipped.
        const legs = [];
        let s = 0;
        for (const o of info.obs) {
          legs.push({ name: `to the ${o.kind}`, s0: s, s1: o.s0 - 15, kit: { low: false, diff: false, cruise: 9 } });
          legs.push({ name: o.kind, s0: o.s0 - 15, s1: o.s1 + 15, kit: kits(o).right });
          s = o.s1 + 15;
        }
        const L = await page.evaluate(() => window.game.course.trail.route.length);
        legs.push({ name: 'to the end', s0: s, s1: L, kit: { low: false, diff: false, cruise: 9 } });
        let ok = true;
        let secs = 0;
        let lean = 0;
        const said = [];
        for (const [n, leg] of legs.entries()) {
          if (leg.s1 <= leg.s0) continue;
          const r = await page.evaluate(([l, first]) => window.__ubinDrive(window.__ubinRouteOff(l.s0, l.s1, l.kit.off ?? 0), { ...l.kit, timeout: 900, place: first }), [leg, n === 0]);
          secs += r.seconds;
          lean = Math.max(lean, r.maxLeanDeg);
          said.push(...r.says.map((x) => x[1]));
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
        const clean = said.some((x) => /^Clean run|the hard way/.test(x));
        check('whole trail: start to end on the hard line, never stuck or tipped', ok && st.every((o) => o.done === 'hard') && clean && (!info.hasCamp || !!camp), `(${Math.round(secs / 60)} min of driving, max lean ${lean}°${info.hasCamp ? `, camp: ${camp}` : ''}, end: ${JSON.stringify(said[said.length - 1])})`);
      }
      // The winch (trails with marked trees): slid off any stretch into the
      // bog or down the bank, stuck, the winch gets the car back onto the
      // track, and it costs points on the clean-run score.
      if (want('winch') && (await page.evaluate(() => !!window.game.course.winchAt))) {
        await page.close();
        page = await fresh();
        const res = await page.evaluate(async (obs) => {
          const g = window.game;
          const t = g.course.trail;
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const was = g.sim.fast;
          const own = g.controls.update;
          g.sim.fast = 400;
          g.controls.update = () => {};
          const run = async (secs) => {
            const until = g.sim.steps + secs * 60;
            for (let k = 0; g.sim.steps < until && k < 30000; k++) await wait(5);
          };
          const out = [];
          try {
            for (let i = 0; i < t.obstacles.length; i++) {
              const o = t.obstacles[i];
              const len = o.s1 - o.s0;
              const w = obs[i].closed.length ? Math.max(...obs[i].closed.filter((x) => x < 6)) : 3;
              const cam = obs[i].camber;
              // Off each side a few metres (a camber: only down its bank), at three places.
              const sides = cam ? [-(cam.dir ?? 1) * 9] : [w + 4, -(w + 4)];
              for (const f of [0.25, 0.5, 0.75])
                for (const off of sides) {
                  const s = len * f;
                  const a = o.line.at(s);
                  const x = a.x + a.tz * off;
                  const z = a.z - a.tx * off;
                  g.course.prepareAt(x, z);
                  g.car.lowRange = true;
                  g.car.diffLock = true;
                  g.car.winchStalledAt = null;
                  g.car.placeAt({ x, y: g.course.heightAt(x, z) + 0.2, z }, Math.atan2(-a.tz, a.tx));
                  g.controls.input.steer = 0;
                  g.controls.input.throttle = 0;
                  await run(3);
                  const before = o.line.nearest(g.car.body.translation().x, g.car.body.translation().z, 60);
                  const tp = g.car.towPoint;
                  const fw = g.car.mesh.position;
                  let tree = g.course.winchAt(tp.x, tp.y, tp.z, tp.x - fw.x, tp.z - fw.z);
                  const hadTree = !!tree;
                  let secs = 0;
                  const ends = [];
                  // As a player would: hook up, and if it lets go short of
                  // the track, hook up again (up to three pulls).
                  for (let pull = 0; pull < 3 && tree; pull++) {
                    g.car.winch = tree;
                    g.car.winchLastEnd = null;
                    let home = false;
                    // (Checked four times a second, as the game does every frame.)
                    for (let q4 = 0; q4 < 360 && g.car.winch; q4++, secs += 0.25) {
                      await run(0.25);
                      const c = g.car.body.translation();
                      if (g.course.winchHome(c.x, c.z)) { g.car.winch = null; home = true; }
                    }
                    const tn = o.line.nearest(tree.x, tree.z, 60);
                    ends.push((home ? 'home' : g.car.winchLastEnd ?? 'time') + '@' + (tn ? tn.sd.toFixed(1) : '?') + '/' + Math.round((tn?.s ?? 0) - s) + '/' + (tree.help ? 'h' : 'x'));
                    g.car.winch = null;
                    await run(2);
                    if (home) break;
                    const q = g.car.towPoint;
                    const m = g.car.mesh.position;
                    tree = g.course.winchAt(q.x, q.y, q.z, q.x - m.x, q.z - m.z, g.car.winchStalledAt);
                  }
                  const p = g.car.body.translation();
                  const n = o.line.nearest(p.x, p.z, 60);
                  out.push({ i, label: o.label, s: Math.round(s), off, before: before ? +before.sd.toFixed(1) : null, tree: hadTree, ends: ends.join(','), secs: Math.round(secs), sd: n ? +n.sd.toFixed(1) : null, onTrack: !!n && Math.abs(n.sd) < w + 0.5 });
                }
            }
          } finally {
            g.sim.fast = was;
            g.controls.update = own;
          }
          return out;
        }, info.obs);
        const bad = res.filter((r) => !r.onTrack);
        check('stuck off any stretch, the winch gets the car back onto the track', bad.length === 0, `(${res.length - bad.length} of ${res.length} places; slowest ${Math.max(...res.map((r) => r.secs))} s${bad.length ? '; failed: ' + JSON.stringify(bad) : ''})`);
        const sc = await page.evaluate(() => {
          const g = window.game;
          const t = g.course.trail;
          const o = t.obstacles[1];
          for (const q of t.obstacles) { q.scoring = false; q.points = 0; q.done = null; }
          const a = o.line.at(20);
          g.course.coach({ x: a.x, z: a.z, speed: 1, low: true, diff: true, stuck: 0 });
          g.course.penalty('winch', a.x, a.z);
          g.course.penalty('retry', a.x, a.z);
          for (let k = 0; k < 20; k++) g.course.coach({ x: a.x, z: a.z, speed: -1, low: true, diff: true, stuck: 0 });
          return g.course.score();
        });
        check('clean-run score: a winch pull 5, a try again 10, backing up 1', !!sc && sc.points === 16, `(${JSON.stringify(sc)})`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
    server.kill();
  }
  const bad = results.filter((r) => !r.ok).length;
  console.log(`${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})();
