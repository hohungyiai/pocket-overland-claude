# Nose test bench

A small map with one of each kind of island end ("nose") from the redrawn
map, and every real nose fault found so far, so a nose change is proven in
minutes before it touches the full maps. It adds to the full-map checks
(`npm run check`), never replaces them.

- `cases.json`: the cases. `status` is `fault` (a fault to fix), `check` (to
  confirm) or `control` (looks right; must stay so). Add every new nose fault
  here with its coordinates and the user's car spot (`car`) where known.
- `npm run maps:noses` (part of `npm run maps`) cuts `public/maps/noses.json`
  from the full map: every road within 75 m of a case, kept whole along its
  line, with the roads at its joints, so the roads are shaped exactly as on
  the full map. Play it at `?course=noses`.
- `node tools/noses/run.cjs` (after `npm run build`): the nose, wall and
  island checks (rules S1-S6, B3, N), zero tolerance, three runners at once,
  on the tiles about the cases only (about 6 minutes). Each spot found goes
  to the case it lies at; a case fails if it gets worse than
  `baseline.json` (main's counts). `--write-baseline` resets the baseline,
  only when a fix lands on main.
- Pictures: `node tools/noses/spots.cjs > spots.json`, render with
  `/mnt/project-files/tools/reviewer/shoot.cjs --course noses`, then
  `python3 tools/noses/sheet.py SHOTS OUT [--before MAIN_SHOTS]` for one sheet
  per case (from above, the user's seat, and four sides).
