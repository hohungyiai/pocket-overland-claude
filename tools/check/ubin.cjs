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
const kitName = (k) =>
  ([k.low && 'low range', k.diff && 'the diff lock', k.cruise >= 9 && 'speed', k.off && Math.abs(k.off) < 4 && 'its line'].filter(Boolean).join(' and ') || 'no kit') +
  (k.change ? `, then ${[k.change.low === false && k.low && 'low range', k.change.diff === false && k.diff && 'the diff lock'].filter(Boolean).join(' and ')} out` : '');
// (Cross-axle ditches with the diff locked but in high range want a steady 6: crawling, the hanging wheels stop it.)
const pace = (o) => (o.needs.speed ? 10 : o.kind === 'climb' ? 5 : o.kind === 'washout' ? 3 : o.kind === 'ditches' && !o.needs.low ? 6 : 4);
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
  if (o.camber) {
    // A line, not kit: the high side, against the bank. The middle of the
    // track slides you down it, slow or fast.
    const up = o.camber.dir ?? 1;
    right.off = ((o.camber.edge ?? 1) + 1.5) * up;
    both('on the middle of the track', { ...right, off: 0 });
  }
  if (o.rutted) {
    // Deep ruts: straddle them, wheels on the crown and the bank. In them
    // the belly drags on the crown, slow or fast.
    right.off = 0.86;
    both('down in the ruts', { ...right, off: 0 });
  }
  // (Each missing piece of kit is tried on the line the right kit must
  // take: the camber's high side, astride the ruts. On any other line the
  // car fails anyway, which would hide a kit it can do without.)
  if (o.needs.low) both('without low range', { ...right, low: false, cruise: Math.max(right.cruise, 6) });
  if (o.needs.diff) both('without the diff lock', { ...right, diff: false });
  if (o.needs.speed) wrong.push(['crawling at it', { ...right, cruise: 4 }]);
  if (o.notch) {
    // A V-notch: square in its middle. A metre off it a wheel drops to the
    // crack and the car leans hard on the face, over 35 degrees (or stops),
    // even with all the kit in.
    wrong.push(['a metre off the middle of the notch, all kit in', { ...right, low: true, diff: true, off: (right.off ?? 0) + 1, leans: 35 }]);
    wrong.push(['a metre the other side of the middle of the notch, all kit in', { ...right, low: true, diff: true, off: (right.off ?? 0) - 1, leans: 35 }]);
  }
  const also = [];
  if (o.creek) {
    // A creek with no way round: the right kit gets through at any crawl, not just at one pace.
    for (const c of [1.5, 2, 3]) also.push([`crawling at ${c} m/s`, { ...right, cruise: c }]);
  }
  if (o.kind === 'flooded') {
    // A flooded track (taught alone): crawling through at any steady pace with the kit in gets through
    // (the holes catch a wheel, they do not end the try), and so does a line a little to one side.
    for (const c of [2, 3, 5]) also.push([`crawling through the flood at ${c} m/s`, { ...right, cruise: c }]);
    also.push(['half a metre left through the flood', { ...right, off: (right.off ?? 0) + 0.5 }]);
    also.push(['half a metre right through the flood', { ...right, off: (right.off ?? 0) - 0.5 }]);
  }
  if (o.kind === 'rockbed') {
    // A granite creek bed (taught alone): the kit in and a crawl gets over the rocks.
    for (const c of [2, 3]) also.push([`crawling over the rocks at ${c} m/s`, { ...right, cruise: c }]);
  }
  if (o.bridge) {
    // Square on the planks is a line a careful driver can hold: a quarter metre either side still crosses.
    also.push(['a quarter metre left of the middle of the planks', { ...right, off: (right.off ?? 0) + 0.25 }]);
    also.push(['a quarter metre right of the middle of the planks', { ...right, off: (right.off ?? 0) - 0.25 }]);
  }
  if (o.bridge) {
    // A plank bridge: square on the planks. Half a metre to either side,
    // the wheels drop off them and the car is on its belly, all kit in.
    wrong.push(['half a metre left of the planks, all kit in', { ...right, low: true, diff: true, off: (right.off ?? 0) + 0.5 }]);
    wrong.push(['half a metre right of the planks, all kit in', { ...right, low: true, diff: true, off: (right.off ?? 0) - 0.5 }]);
  }
  for (const w of o.closed ?? []) {
    // Closed in: no way round it on the ground either side, even with the
    // right kit (the bog below a ridge or in a valley's ditches holds the
    // car; boulders block it), out to past the outermost closure.
    const off = Math.round(w + 3);
    wrong.push([`round it on the ground ${off} m to its left`, { ...right, off }]);
    wrong.push([`round it on the ground ${off} m to its right`, { ...right, off: -off }]);
  }
  if (o.then) {
    // A clashing setup: part way along, kit has to come out (low range to
    // carry speed up a dune, the diff lock for a tight turn round rocks).
    // The right kit changes there; keeping it in all the way does not get
    // through.
    const lowOut = o.then.off.includes('low');
    const pace = lowOut ? { cruise: 14 } : { cruise: 2.5, look: 3 };
    const out = Object.fromEntries(o.then.off.map((k) => [k, false]));
    right.change = { s: o.s0 + o.then.at, ...out, ...pace };
    for (const [, kit] of wrong) kit.change = { ...right.change, ...Object.fromEntries(Object.keys(out).map((k) => [k, kit[k]])) };
    wrong.push([`keeping ${o.then.off.map((k) => (k === 'low' ? 'low range' : 'the diff lock')).join(' and ')} in all the way`, { ...right, change: { s: right.change.s, ...pace } }]);
  }
  return { right, wrong, also, none: { low: false, diff: false, cruise: o.needs.speed ? 4 : 6 } };
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
      // The trail is ready to drive soon after the page opens: over a minute
      // of black screen on a phone is no start. (Main loads a trail in
      // 13-17 s here; the limit leaves room for a busy machine.)
      if (want('load')) {
        const lp = await browser.newPage({ viewport: { width: 640, height: 360 } });
        const t0 = Date.now();
        await lp.goto(`http://localhost:${PORT}/?course=${course}&debug`);
        await lp.waitForFunction(() => window.game && window.game.course && window.game.course.trail, null, { timeout: 300000, polling: 100 });
        const secs = (Date.now() - t0) / 1000;
        await lp.close();
        check(`the trail is ready to drive within 35 s of the page opening`, secs <= 35, `(${secs.toFixed(1)} s)`);
      }
      let page = await fresh();
      const info = await page.evaluate(() => {
        const t = window.game.course.trail;
        return { roundKit: t.def.roundKit ?? {}, wayRound: t.def.wayRound, obs: t.obstacles.map((o) => ({ p: o.p, camber: o.parts.find((q) => q.kind === 'camber')?.p ?? null, mixed: o.parts.map((q) => q.kind).join('+'), rutted: o.parts.some((q) => q.kind === 'rutted'), notch: o.parts.some((q) => q.kind === 'notch'), bridge: o.parts.some((q) => q.kind === 'bridge'), creek: o.parts.some((q) => q.kind === 'creek'), flooded: o.parts.some((q) => q.kind === 'flooded'), rockbed: o.parts.some((q) => q.kind === 'rockbed'), closed: o.parts.filter((q) => ['ridge', 'thicket', 'valley'].includes(q.kind)).map((q) => (q.kind === 'thicket' ? (q.p.w ?? 3.4) + 1.6 * ((q.p.rows ?? 2) - 1) : (q.p.w ?? 2.6))), gate: !!o.gate, kind: o.kind, label: o.label, needs: o.needs, then: o.then ?? null, s0: o.s0, s1: o.s1 })), hasCamp: !!t.def.end.camp };
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
      const drive = (pg, s0, s1, kit, extra = {}) => pg.evaluate(([a, b, k]) => window.__ubinKitDrive(a, b, k), [s0, s1, { ...kit, ...extra }]);
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
          if (kit.leans) check(`${o.label}: ${what}, the car leans over ${kit.leans}° or does not get through`, !(r.done && sw.done === 'hard') || r.maxLeanDeg > kit.leans, `(reached ${r.at}/${r.total}, ${r.seconds}s, lean ${r.maxLeanDeg}°, credited: ${sw.done})`);
          else check(`${o.label}: ${what}, the bot does not get through`, !(r.done && sw.done === 'hard'), `(reached ${r.at}/${r.total}, ${r.seconds}s, ${r.stalls} stalls, credited: ${sw.done})`);
          await page.close();
          page = await fresh();
        }
        const right = await drive(page, from, to, K.right, { timeout: 150 });
        const st = (await page.evaluate(() => window.__ubinObstacles()))[i];
        const level = o.kind === 'notch' ? 25 : 90;
        check(`${o.label}: with ${kitName(K.right)} the bot gets through on the hard line${level < 90 ? `, never leaning over ${level}°` : ''}`, right.done && st.done === 'hard' && right.maxLeanDeg < level, `(${right.seconds}s, lean ${right.maxLeanDeg}°, ${st.done}) says: ${JSON.stringify(right.says.map((t) => t[1]))}`);
        await page.close();
        page = await fresh();
        for (const [what, kit] of K.also) {
          const r = await drive(page, from, to, kit, { timeout: 150 });
          const sa = (await page.evaluate(() => window.__ubinObstacles()))[i];
          check(`${o.label}: with ${kitName(K.right)}, ${what}, the bot gets through on the hard line`, r.done && sa.done === 'hard', `(${r.seconds}s, lean ${r.maxLeanDeg}°, reached ${r.at}/${r.total}, ${sa.done})`);
          await page.close();
          page = await fresh();
        }
        if (!o.gate) continue;
        // Tries with no kit, from the run-in each time: the way round
        // opens after the third.
        let st2 = null;
        let openedEarly = false;
        const sayings = [];
        for (let k = 0; k < 5; k++) {
          const t = await drive(page, from, to, K.none, { timeout: 90, giveUp: 5 });
          sayings.push(...t.says.map((x) => x[1]), ...t.tips.map((x) => 'tip: ' + x[1]));
          st2 = (await page.evaluate(() => window.__ubinObstacles()))[i];
          if (st2.open && st2.tries < 3) openedEarly = true;
          if (st2.open) break;
        }
        // (A long stretch can take two tries in one drive: stalled, a little
        // further, stalled again. Opened with fewer than three is the fault.)
        check(`${o.label}: the way round opens after three tries, not before`, st2.open && st2.tries >= 3 && !openedEarly, `(tries ${st2.tries}) ${JSON.stringify([...new Set(sayings)])}`);
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
          const r = await page.evaluate(([l, first]) => window.__ubinKitDrive(l.s0, l.s1, { ...l.kit, timeout: 900, place: first }), [leg, n === 0]);
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
        const clean = said.some((x) => /the hard way/.test(x));
        check('whole trail: start to end on the hard line, never stuck or tipped', ok && st.every((o) => o.done === 'hard') && clean && (!info.hasCamp || !!camp), `(${Math.round(secs / 60)} min of driving, max lean ${lean}°${info.hasCamp ? `, camp: ${camp}` : ''}, end: ${JSON.stringify(said[said.length - 1])})`);
      }
      if (want('drop') && (await page.evaluate(() => window.game.course.trail.obstacles.some((o) => o.drop)))) {
        // Commitment points: past each drop, backing up with low range and
        // the diff lock in does not get back up it; the look spot before it
        // is flat and wide (under 8 degrees along and across, 3 m either
        // side of the line), and the coach speaks there.
        // Each lip is one piece of rock on the ground: its back edge on the
        // ground (within 5 cm), its foot never more than 0.1 m above the
        // ground below the face, its top never under the ground and never
        // stepping more than 0.15 m from one point to the next (every 0.2 m
        // across), and its ends tapered into the ground (within 5 cm).
        const lp = await page.evaluate(() => {
          const c = window.game.course;
          const H = (p) => c.heightAt(p[0], p[1]);
          return c.lips().map((L) => {
            let back = 0, foot = -Infinity, under = 0, step = 0, ends = 0;
            L.forEach((q, k) => {
              back = Math.max(back, Math.abs(q.yBack - H(q.back)));
              foot = Math.max(foot, q.yFoot - H(q.foot));
              under = Math.max(under, H(q.top) - q.yTop);
              // (How far it stands above the ground, point to point: the
              // ground's own slope across a camber or a valley's edge is not a step.)
              if (k) step = Math.max(step, Math.abs(q.yTop - H(q.top) - (L[k - 1].yTop - H(L[k - 1].top))));
            });
            ends = Math.max(Math.abs(L[0].yTop - H(L[0].top)), Math.abs(L[L.length - 1].yTop - H(L[L.length - 1].top)));
            return { n: L.length, back: +back.toFixed(3), foot: +foot.toFixed(3), under: +under.toFixed(3), step: +step.toFixed(3), ends: +ends.toFixed(3) };
          });
        });
        check('every drop has one rock lip on the ground: back and ends flush, foot buried, its height over the ground never stepping over 0.15 m', lp.length > 0 && lp.every((l) => l.back <= 0.05 && l.foot <= 0.1 && l.under <= 0.02 && l.step <= 0.15 && l.ends <= 0.05), `(${JSON.stringify(lp)})`);
        const ds = await page.evaluate(() => window.game.course.trail.obstacles.map((o, i) => (o.drop ? { i, label: o.label } : null)).filter(Boolean));
        for (const { i, label } of ds) {
          await page.close();
          page = await fresh();
          const r = await page.evaluate(async (i) => {
            const g = window.game;
            const t = g.course.trail;
            const o = t.obstacles[i];
            const D = o.drop;
            const wait = (ms) => new Promise((res) => setTimeout(res, ms));
            const run = async (secs) => {
              const until = g.sim.steps + secs * 60;
              for (let k = 0; g.sim.steps < until && k < 30000; k++) await wait(5);
            };
            // The look spot.
            let worst = 0;
            let where = null;
            const [l0, l1] = t.constructor.LOOK;
            for (let s = D.at + l0; s <= D.at + l1 - 1; s += 1)
              for (let d = -3; d <= 2; d += 1) {
                const p = t.route.at(o.s0 + s);
                const at = (s2, d2) => {
                  const q = t.route.at(o.s0 + s2);
                  return g.course.heightAt(q.x + q.tz * d2, q.z - q.tx * d2);
                };
                const m = Math.max(Math.abs(at(s + 1, d) - at(s, d)), Math.abs(at(s, d + 1) - at(s, d)));
                if (m > worst) {
                  worst = m;
                  where = [s - D.at, d];
                }
              }
            // The coach, as the HUD asks it, walking up to the drop.
            const says = [];
            for (let s = D.at - 40; s < D.at + 3; s += 0.5) {
              const p = t.route.at(o.s0 + s);
              const c = g.course.coach({ x: p.x, z: p.z, speed: 3, low: false, diff: false, stuck: 0 });
              if (c?.say) says.push([Math.round(s - D.at), c.say]);
            }
            // Backing up from just past it, all the kit in.
            const own = g.controls.update;
            const was = g.sim.fast;
            g.sim.fast = 400;
            g.controls.update = () => {};
            // (On the hard line: an off-camber shore's high side.)
            const cam = o.parts.find((q) => q.kind === 'camber')?.p;
            const off = cam ? (cam.dir ?? 1) * ((cam.edge ?? 1) + 1.5) : 0;
            const a0 = o.line.at(D.at + 5);
            const a = { x: a0.x + a0.tz * off, z: a0.z - a0.tx * off };
            g.course.prepareAt?.(a.x, a.z);
            g.car.placeAt({ x: a.x, y: g.course.heightAt(a.x, a.z) + 0.3, z: a.z }, Math.atan2(-a0.tz, a0.tx));
            g.controls.input.steer = g.controls.input.throttle = 0;
            await run(2);
            g.car.lowRange = g.car.diffLock = true;
            g.controls.input.throttle = -1;
            let least = Infinity;
            let lastAt = null;
            for (let k = 0; k < 40; k++) {
              await run(0.5);
              const p = g.car.body.translation();
              const n = t.route.nearest(p.x, p.z, 20);
              // (Back up on the track above it: slid off down a bank is not.)
              if (n && Math.abs(n.sd) < 4 && n.s - o.s0 < least) {
                least = n.s - o.s0;
                lastAt = [+n.sd.toFixed(1), +p.y.toFixed(1)];
              }
            }
            g.controls.input.throttle = 0;
            g.controls.update = own;
            g.sim.fast = was;
            return { at: D.at, h: D.h, where, slope: +((Math.atan(worst) * 180) / Math.PI).toFixed(1), says, least: +least.toFixed(1), lastAt };
          }, i);
          const spoke = r.says.some(([s, x]) => s < -2 && /drop ahead/.test(x));
          check(`${label}: past the drop (${r.h} m) backing up with all the kit in does not get back up it onto the track`, r.least > r.at, `(closest ${r.least} m in, the step at ${r.at} m${r.least > r.at ? '' : `, ${JSON.stringify(r.lastAt)} (across, up)`})`);
          check(`${label}: the look spot before the drop is flat and the coach speaks there`, r.slope < 8 && spoke, `(steepest ${r.slope}° at ${JSON.stringify(r.where)} m from the step and the line; said ${JSON.stringify(r.says)})`);
        }
      }
      if (want('ruts') && (await page.evaluate(() => !!window.game.course.dig))) {
        // Ruts: spinning in the mangrove mud with no kit digs the ground
        // under the wheels (slicker), not a car's width beside them; leaving
        // it be, Try again smooths it back.
        await page.close();
        page = await fresh();
        const r = await page.evaluate(async () => {
          const g = window.game;
          const t = g.course.trail;
          const wait = (ms) => new Promise((res) => setTimeout(res, ms));
          const was = g.sim.fast;
          const own = g.controls.update;
          g.sim.fast = 400;
          g.controls.update = () => {};
          const run = async (secs) => {
            const until = g.sim.steps + secs * 60;
            for (let k = 0; g.sim.steps < until && k < 30000; k++) await wait(5);
          };
          try {
            // (In the mud itself, past any flooded mouth to the channel.)
            const o = t.obstacles.find((q) => /mangrove/i.test(q.label));
            const m = o.parts.find((q) => q.kind === 'mud');
            const a = o.line.at(m.from + 20);
            g.course.prepareAt(a.x, a.z);
            g.car.lowRange = false;
            g.car.diffLock = false;
            g.car.placeAt({ x: a.x, y: g.course.heightAt(a.x, a.z) + 0.2, z: a.z }, Math.atan2(-a.tz, a.tx));
            await run(2);
            g.controls.input.throttle = 1;
            g.controls.input.steer = 0;
            await run(5);
            g.controls.input.throttle = 0;
            await run(2);
            const p = g.car.body.translation();
            // Under the wheels: the most worn square within the car's length.
            let under = 0;
            for (let dx = -2.5; dx <= 2.5; dx += 0.25) for (let dz = -1.2; dz <= 1.2; dz += 0.25) under = Math.max(under, g.course.rutAt(p.x + dx, p.z + dz));
            // A car's width beside the line it was on.
            const sx = p.x + a.tz * 3.2;
            const sz = p.z - a.tx * 3.2;
            let beside = 0;
            for (let dx = -2; dx <= 2; dx += 0.25) for (let dz = -0.6; dz <= 0.6; dz += 0.25) beside = Math.max(beside, g.course.rutAt(sx + dx, sz + dz));
            const cells = t.ruts.size;
            const marks = g.scene?.children?.find?.((m) => m.isInstancedMesh && m.renderOrder === 2)?.count ?? null;
            // Try again, as the button does (at normal speed: the HUD offers it).
            g.sim.fast = was;
            const btn = document.getElementById('btn-retry');
            for (let k = 0; k < 300 && btn.hidden; k++) await wait(100);
            const btnShown = !btn.hidden;
            btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            await wait(300);
            return { under: +under.toFixed(2), beside: +beside.toFixed(2), cells, marks, after: t.ruts.size, btnShown };
          } finally {
            g.sim.fast = was;
            g.controls.update = own;
            g.controls.input.throttle = 0;
          }
        });
        check('ruts: spinning digs the ground under the wheels, not beside, and Try again smooths it', r.under >= 0.5 && r.beside === 0 && r.btnShown && r.after === 0, `(${JSON.stringify(r)})`);
      }
      // No winch and no score: driving is the game (the user, 22 Nov).
      {
        const r = await page.evaluate(() => {
          const c = window.game.course;
          return { button: !!document.getElementById('btn-winch'), badge: !!document.getElementById('hud-score'), hooks: ['winchAt', 'penalty', 'score', 'setBest'].filter((k) => k in c), car: 'winch' in window.game.car };
        });
        check('no winch and no score: no Winch button, no score badge, no winch or score on the course or car', !r.button && !r.badge && !r.hooks.length && !r.car, `(${JSON.stringify(r)})`);
      }
      if (want('strip')) {
        // The fine strips (deep ruts, notches, ditches, ledges) are laid over
        // the tiles' ground, which is sunk under their middles. Their edges
        // and ends must sit on the tiles' drawn ground (within 2 cm: no step,
        // gap, flap or slit to see through), and nowhere over or beside a
        // strip may the top ground be a hole (0.3 m under the land).
        const r = await page.evaluate(async () => {
          const g = window.game, c = g.course, fg = c.fineGround;
          if (!fg) return [];
          // Height of a grid mesh laid out as the tiles are (w x h points,
          // two triangles a square split from (i+1, j) to (i, j+1)).
          const tileAt = (m, x, z) => {
            const p = m.geometry.attributes.position.array;
            const st = p[3] - p[0];
            const n = p.length / 3;
            let w = 1;
            while (w < n && p[w * 3 + 2] === p[2]) w++;
            const hh = n / w;
            const fx = (x - p[0]) / st, fz = (z - p[2]) / st;
            const i = Math.min(w - 2, Math.floor(fx)), j = Math.min(hh - 2, Math.floor(fz));
            if (i < 0 || j < 0 || fx > w - 1 || fz > hh - 1) return null;
            const u = fx - i, v = fz - j, Y = (a, b) => p[((j + b) * w + i + a) * 3 + 1];
            return u + v <= 1 ? Y(0, 0) + u * (Y(1, 0) - Y(0, 0)) + v * (Y(0, 1) - Y(0, 0)) : Y(1, 1) + (1 - u) * (Y(0, 1) - Y(1, 1)) + (1 - v) * (Y(1, 0) - Y(1, 1));
          };
          // Triangles of a strip, bucketed by metre, for heights by x, z.
          const bucket = (m) => {
            const p = m.geometry.attributes.position.array, idx = m.geometry.index.array, cells = new Map();
            for (let q = 0; q < idx.length; q += 3) {
              const t = [idx[q] * 3, idx[q + 1] * 3, idx[q + 2] * 3];
              const xs = t.map((k) => p[k]), zs = t.map((k) => p[k + 2]);
              for (let cx = Math.floor(Math.min(...xs)); cx <= Math.floor(Math.max(...xs)); cx++)
                for (let cz = Math.floor(Math.min(...zs)); cz <= Math.floor(Math.max(...zs)); cz++) {
                  const key = cx * 100003 + cz;
                  (cells.get(key) ?? cells.set(key, []).get(key)).push(t);
                }
            }
            return (x, z) => {
              let top = null;
              for (const [a, b, d] of cells.get(Math.floor(x) * 100003 + Math.floor(z)) ?? []) {
                const det = (p[b + 2] - p[d + 2]) * (p[a] - p[d]) + (p[d] - p[b]) * (p[a + 2] - p[d + 2]);
                if (!det) continue;
                const l1 = ((p[b + 2] - p[d + 2]) * (x - p[d]) + (p[d] - p[b]) * (z - p[d + 2])) / det;
                const l2 = ((p[d + 2] - p[a + 2]) * (x - p[d]) + (p[a] - p[d]) * (z - p[d + 2])) / det;
                const l3 = 1 - l1 - l2;
                if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
                const y = l1 * p[a + 1] + l2 * p[b + 1] + l3 * p[d + 1];
                if (top === null || y > top) top = y;
              }
              return top;
            };
          };
          const out = [];
          const strips = c.trail.fineStrips();
          for (let m = 0; m < fg.strips.length; m++) {
            const mesh = fg.strips[m], { o, a, b } = strips[m];
            const mid = c.trail.fineAt(o, (a + b) / 2, 0);
            c.prepareAt(mid.x, mid.z);
            // (No frames in between: the game's own update would stream the
            // ground back around the car.)
            for (let k = 0; k < 300; k++) c.update(performance.now() / 1000, 0, undefined, { x: mid.x, y: c.heightAt(mid.x, mid.z), z: mid.z });
            const tiles = [];
            g.scene.traverse((t) => {
              if (!t.isMesh || t.material !== fg.groundMat) return;
              for (let q = t; q; q = q.parent) if (!q.visible) return;
              tiles.push(t);
            });
            const tileTop = (x, z) => {
              let top = null;
              for (const t of tiles) {
                const y = tileAt(t, x, z);
                if (y !== null && (top === null || y > top)) top = y;
              }
              return top;
            };
            const stripTops = fg.strips.filter((s) => s.visible).map(bucket);
            // Edges and ends.
            const p = mesh.geometry.attributes.position.array, n = p.length / 3;
            let nv = 1;
            while (nv < n && Math.hypot(p[nv * 3] - p[nv * 3 - 3], p[nv * 3 + 2] - p[nv * 3 - 1]) < 1.6) nv++;
            const nu = n / nv;
            let edgeWorst = 0, edgeAt = null, edgeOff = 0, noTile = 0;
            for (let i = 0; i < nu; i++)
              for (let j = 0; j < nv; j++) {
                if (i && i < nu - 1 && j && j < nv - 1) continue;
                const k = (i * nv + j) * 3, y = tileTop(p[k], p[k + 2]);
                if (y === null) { noTile++; continue; }
                const e = Math.abs(p[k + 1] - y);
                if (e > 0.02) edgeOff++;
                if (e > edgeWorst) { edgeWorst = e; edgeAt = [+p[k].toFixed(1), +p[k + 2].toFixed(1)]; }
              }
            // Holes: the top ground over and around the strip.
            let holes = 0, holeAt = null, pts = 0;
            for (let s = a - 3; s <= b + 3; s += 0.5)
              for (let off = -14; off <= 14; off += 0.5) {
                const { x, z } = c.trail.fineAt(o, s, off);
                let top = tileTop(x, z);
                for (const f of stripTops) { const y = f(x, z); if (y !== null && (top === null || y > top)) top = y; }
                if (top === null) continue;
                pts++;
                // (The land there: the lowest of the ground at the point and the
                // tiles' ground points around it, as on a steep slope the strip
                // and the tiles' coarser ground may each lie a little low.)
                const X = Math.floor(x / 2) * 2, Z = Math.floor(z / 2) * 2;
                let ref = c.heightAt(x, z);
                for (let dx = -2; dx <= 4; dx += 2) for (let dz = -2; dz <= 4; dz += 2) ref = Math.min(ref, c.heightAt(X + dx, Z + dz));
                if (top < ref - 0.3) { holes++; holeAt ??= [+x.toFixed(1), +z.toFixed(1), +(top - ref).toFixed(2)]; }
              }
            out.push({ shown: mesh.visible, kind: o.kind, label: o.label, a: Math.round(a), b: Math.round(b), tiles: tiles.length, edges: 2 * (nu + nv) - 4, edgeOff, edgeWorst: +edgeWorst.toFixed(3), edgeAt, noTile, pts, holes, holeAt });
          }
          return out;
        });
        for (const s of r)
          check(`${s.label}: its fine strip (${s.a}-${s.b} m) meets the tiles' ground at every edge and end point within 2 cm, with no hole over or beside it`, s.shown && s.tiles > 0 && !s.noTile && !s.edgeOff && !s.holes && s.pts > 0, `(${JSON.stringify(s)})`);
      }
      if (want('strip')) {
        // Over a fine strip the tiles' ground never shows through it: their
        // coarser triangles' creases would show as dark wedges or pale
        // triangles in the grass beside a stretch. Drawn heights compared
        // every 0.5 m along and 0.125 m across: the tiles' top nowhere over the
        // strip's by more than 1 cm, and in its last half metre (edges and
        // ends, where the two meet level, the same colour) by more than 5 cm.
        const r = await page.evaluate(async () => {
          const g = window.game; const t = g.course.trail; const fg = g.course.fineGround; const R = t.constructor.FINE_RIM;
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const res = [];
          const triH = (ax, az, ay, bx, bz, by, cx, cz, cy, x, z) => {
            const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(d) < 1e-12) return null;
            const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, l3 = 1 - l1 - l2;
            if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) return null; return l1 * ay + l2 * by + l3 * cy;
          };
          const meshH = (m, x, z, bucket) => {
            const key = Math.floor(x) + ',' + Math.floor(z); const list = bucket.get(key); if (!list) return null;
            const P = m.geometry.attributes.position.array; let best = null;
            for (const [a, b, c] of list) { const h = triH(P[a*3], P[a*3+2], P[a*3+1], P[b*3], P[b*3+2], P[b*3+1], P[c*3], P[c*3+2], P[c*3+1], x, z); if (h != null && (best == null || h > best)) best = h; }
            return best;
          };
          const buildBucket = (m) => {
            const P = m.geometry.attributes.position.array; const I = m.geometry.index.array; const B = new Map();
            for (let k = 0; k < I.length; k += 3) { const a = I[k], b = I[k+1], c = I[k+2];
              const xs = [P[a*3], P[b*3], P[c*3]], zs = [P[a*3+2], P[b*3+2], P[c*3+2]];
              for (let X = Math.floor(Math.min(...xs)); X <= Math.floor(Math.max(...xs)); X++) for (let Z = Math.floor(Math.min(...zs)); Z <= Math.floor(Math.max(...zs)); Z++) { const kk = X + ',' + Z; if (!B.has(kk)) B.set(kk, []); B.get(kk).push([a, b, c]); } }
            return B;
          };
          const strips = t.fineStrips();
          for (let si = 0; si < strips.length; si++) {
            const { o, a, b } = strips[si]; const m = fg.strips[si];
            const mid = t.fineAt(o, (a + b) / 2, 0); g.car.placeAt({ x: mid.x + 30, y: g.course.heightAt(mid.x + 30, mid.z) + 1, z: mid.z }, 0); g.course.prepareAt(mid.x, mid.z);
            for (let c = 0; c < 200; c++) g.course.update?.(performance.now() / 1000, 0, undefined, { x: mid.x, y: 0, z: mid.z });
            await wait(1500);
            const tiles = []; g.scene.traverse((q) => { if (q.isMesh && q.material === fg.groundMat && q.visible) { const P = q.geometry.attributes.position.array; if (Math.abs(P[3] - P[0]) <= 2.01) tiles.push(q); } });
            const sb = buildBucket(m); const tb = tiles.map((q) => { q.geometry.computeBoundingBox(); return { q, bb: q.geometry.boundingBox, B: null }; });
            let n = 0, worst = 0, at = null, pts = 0, edgeWorst = 0, edgeAt = null, stand = 0, standWorst = 0, standAt = null;
            // (No strip triangle facing the other way from the rest: a flipped face shows dark.)
            const SP = m.geometry.attributes.position.array, SI = m.geometry.index.array; let up = 0, down = 0, downAt = null;
            for (let k = 0; k < SI.length; k += 3) { const A = SI[k] * 3, B = SI[k + 1] * 3, C = SI[k + 2] * 3;
              const ny = (SP[B + 2] - SP[A + 2]) * (SP[C] - SP[A]) - (SP[B] - SP[A]) * (SP[C + 2] - SP[A + 2]);
              if (Math.abs(ny) < 1e-9) continue; if (ny > 0) up++; else { down++; downAt = [+SP[A].toFixed(1), +SP[A + 2].toFixed(1)]; } }
            const flipped = Math.min(up, down);
            // (Where a strip point lies on the tiles' own ground it is laid on it, lifted
            // at most 6 cm clear of their creases: never a spike or step standing off it.)
            for (let k = 0; k < SP.length; k += 3) { const fi = t.fineIn(o, a, b, SP[k], SP[k + 2]); if (fi && fi.edge > R && fi.end > 3) continue;
              const u2 = SP[k + 1] - fg.tileGround(SP[k], SP[k + 2]); if (u2 > 0.0605) { stand++; if (Math.abs(u2) > standWorst) { standWorst = Math.abs(u2); standAt = [+SP[k].toFixed(1), +SP[k + 2].toFixed(1), +u2.toFixed(3)]; } } }
            for (let s = a; s <= b; s += 0.5) for (let sd = -14; sd <= 14; sd += 0.125) {
              const p = t.fineAt(o, s, sd); const sh = meshH(m, p.x, p.z, sb); if (sh == null) continue;
              for (const T of tb) { if (p.x < T.bb.min.x || p.x > T.bb.max.x || p.z < T.bb.min.z || p.z > T.bb.max.z) continue; if (!T.B) T.B = buildBucket(T.q);
                const th = meshH(T.q, p.x, p.z, T.B); if (th == null) continue; pts++; const d = th - sh; const half = t.fineHalf(o, s, Math.sign(sd) || 1); if (Math.abs(sd) > half) continue; const edge = Math.min(half - Math.abs(sd), s - a, b - s) <= 0.5;
                const where = [+s.toFixed(1), sd, +p.x.toFixed(1), +p.z.toFixed(1), +d.toFixed(3)];
                if (edge) { if (d > edgeWorst) { edgeWorst = d; edgeAt = where; } } else { if (d > 0.01) n++; if (d > worst) { worst = d; at = where; } } 
                // (Where the tiles' ground is not let down at all the strip is the tiles' own
                // ground laid over it, to within 3 cm: nothing standing up off it, as shards or steps.)
              }
            }
            res.push({ label: o.label, a: Math.round(a), b: Math.round(b), tiles: tiles.length, pts, poke: n, worst: +worst.toFixed(3), at, edgeWorst: +edgeWorst.toFixed(3), edgeAt, stand, standWorst: +standWorst.toFixed(3), standAt, flipped, downAt: flipped ? downAt : null });
          }
          return res;
        });
        for (const s of r)
          check(`${s.label}: the tiles' ground never shows through its fine strip (${s.a}-${s.b} m): not over it by 1 cm inside, 5 cm in its last half metre (an end row across a steep bank: the same grass either side); where it lies on the tiles' ground, no point over 6 cm clear of it (no spike); no face flipped`, s.pts > 0 && s.poke === 0 && s.edgeWorst <= 0.05 && s.stand === 0 && s.flipped === 0, `(${JSON.stringify(s)})`);
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
