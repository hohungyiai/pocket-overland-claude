// The nose bench's pictures: views of every case in cases.json, for
// /mnt/project-files/tools/reviewer/shoot.cjs (--course noses).
//   node tools/noses/spots.cjs [ids,...] > spots.json
// Per case: from above (30 m, cut 4 m over the road: no tree crowns), and
// from four sides 18 m off, 5 m up, cut 7 m over the road; and from the
// driver's seat where the user stood (case.car).
const fs = require('node:fs');
const path = require('node:path');
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));
const pick = process.argv[2] ? new Set(process.argv[2].split(',')) : null;
const out = [];
for (const c of cases) {
  if (pick && !pick.has(c.id)) continue;
  out.push({ id: `${c.id}-top`, x: c.x, z: c.z, view: 'top', span: 30, clip: 4 });
  for (const [k, dx, dz] of [['ne', 1, -1], ['se', 1, 1], ['sw', -1, 1], ['nw', -1, -1]])
    out.push({ id: `${c.id}-${k}`, x: c.x, z: c.z, view: 'driver', from: [c.x + dx * 12.7, c.z + dz * 12.7], eye: 5, fov: 55, clip: 7 });
  if (c.car) out.push({ id: `${c.id}-car`, x: c.x, z: c.z, view: 'driver', from: c.car, eye: 1.4, fov: 60 });
}
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
