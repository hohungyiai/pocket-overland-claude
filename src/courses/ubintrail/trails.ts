import type { TrailDef } from './trail';

// Pulau Ubin's three trails, easy to super hard. Positions are metres from
// the map's origin (x east, z south), on the real lanes, tracks and paths.

/** Easy: the jetty, round Ketam Quarry, to the Endut Senin camp site. One skill per obstacle, a signposted way round each. */
export const KETAM: TrailDef = {
  id: 'ketam',
  name: 'Pulau Ubin: Ketam Trail',
  grade: 'easy',
  waypoints: [
    [1640, 830], // Ubin Jetty
    [-60, 60], // Puaka Bridge
    [-250, -700], // Jalan Wat Siam, north
    [-1055, -115], // the shore below Ketam Quarry
    [-560, -125], // Ketam Trail, back towards Jalan Wat Siam
    [-60, 60], // Puaka Bridge again
    [-177, 300], // Endut Senin camp site
  ],
  obstacles: [
    { kind: 'climb', label: 'Steep climb', at: [-420, -575], len: 80, needs: { low: true } },
    { kind: 'washout', label: 'Washout', at: [-1370, -560], len: 60, needs: { low: true, diff: true } },
    { kind: 'sand', label: 'Soft sand', at: [-1080, -175], len: 90, needs: { speed: true } },
  ],
  wayRound: 'gate',
  end: { label: 'Endut Senin camp site', sign: ['Endut Senin', 'Campsite'], camp: { id: 'ubin-endut-senin', label: 'Endut Senin camp site' } },
  startSign: ['Pulau Ubin', 'Ketam Trail → 7 km'],
  hardWay: 'Endut Senin, the hard way all through. Make camp when you are ready.',
  finish: 'Endut Senin camp. Make camp when you are ready.',
};

/**
 * Medium: over Puaka Hill. From Jalan Endut Senin along the path round the south
 * of Ubin Quarry (roots and rock, climbing), a loose steep descent to the
 * Sungei Noordin side, round by the lane to Jalan Endut Senin, then up the
 * path to the top of Puaka Hill over rock ledges. The view is the reward.
 * Obstacles chain two skills (low range and the diff lock); the
 * signposted way round still opens after three tries.
 */
export const PUAKA: TrailDef = {
  id: 'puaka',
  name: 'Pulau Ubin: Puaka Hill',
  grade: 'medium',
  paths: true,
  waypoints: [
    [-44, 105], // off Jalan Endut Senin, where the path round the quarry starts
    [356, -120], // the path round the south of the quarry
    [604, 112], // down to the lane
    [321, 379], // Jalan Endut Senin, at the foot of the hill path
    [453, 166], // the top of Puaka Hill
  ],
  profile: [
    [[21, 70], 0],
    [[87, -26], 3],
    [[229, -68], 14],
    [[356, -120], 22],
    [[480, -102], 22],
    [[547, -62], 2],
    [[606, 14], 0],
    [[318, 356], 0],
    [[351, 237], 3],
    [[407, 197], 8],
    [[452, 168], 34],
  ],
  obstacles: [
    // (Boulders close in either side of each stretch: no driving round on the grass.)
    { kind: 'rocks', label: 'Roots and rock', at: [65, 24], len: 190, needs: { diff: true }, mix: [{ kind: 'rocks', from: 0, to: 190 }, { kind: 'thicket', from: 0, to: 190 }] },
    // (Fallen logs on the path south of the quarry: the diff lock, and a crawl.)
    {
      kind: 'logs',
      label: 'Fallen logs',
      at: [280, -83],
      len: 60,
      needs: { diff: true },
      mix: [
        { kind: 'logs', from: 0, to: 60 },
        { kind: 'thicket', from: 0, to: 60, p: { w: 4.6 } },
      ],
    },
    // (Control, not kit: low range makes it easier, but the brakes get you down too.)
    { kind: 'descent', label: 'Loose descent', at: [480, -102], len: 110, needs: {}, mix: [{ kind: 'descent', from: 0, to: 110 }, { kind: 'thicket', from: 0, to: 110 }] },
    // Four short lessons on the way round to the hill path, one new kind of
    // ground each, as Chek Jawa mixes them (boulders either side: no
    // driving round them on the grass).
    {
      kind: 'ditches',
      label: 'Cross-axle ditches',
      at: [599, 8],
      len: 65,
      needs: { diff: true },
      mix: [
        { kind: 'ditches', from: 0, to: 65, p: { depth: 0.55, period: 6.5 } },
        { kind: 'thicket', from: 0, to: 65 },
      ],
    },
    {
      kind: 'rutted',
      label: 'Deep ruts',
      at: [596, 218],
      len: 60,
      needs: {},
      mix: [
        { kind: 'rutted', from: 0, to: 60, p: { depth: 0.75 } },
        { kind: 'thicket', from: 0, to: 60 },
      ],
    },
    {
      kind: 'notch',
      label: 'Granite notch',
      at: [561, 332],
      len: 45,
      needs: {},
      // (A line, not kit: nothing stops you in the middle, so no way round.)
      round: false,
      mix: [
        { kind: 'notch', from: 0, to: 45, p: { bend: 0.5 } },
        { kind: 'thicket', from: 0, to: 45, p: { w: 5.4 } },
      ],
    },
    {
      kind: 'falls',
      label: 'Rock waterfall',
      at: [467, 397],
      len: 45,
      needs: { low: true, diff: true },
      mix: [
        { kind: 'climb', from: 0, to: 45, p: { h: 5, up: 15, top: 6 } },
        { kind: 'falls', from: 4, to: 26, p: { ledgeH: 0.5, every: 3.5 } },
        { kind: 'thicket', from: 0, to: 45 },
      ],
    },
    // (Two more on the way to the hill path: a creek channel, then a plank bridge.)
    {
      kind: 'creek',
      label: 'Creek channel',
      at: [398, 396],
      len: 46,
      needs: { low: true, diff: true },
      mix: [
        { kind: 'creek', from: 0, to: 30 },
        { kind: 'thicket', from: 0, to: 46, p: { w: 4.6 } },
      ],
    },
    {
      kind: 'bridge',
      label: 'Plank bridge',
      at: [316, 344],
      len: 30,
      needs: {},
      // (A line, not kit: no way round.)
      round: false,
      mix: [
        { kind: 'bridge', from: 0, to: 30 },
        { kind: 'thicket', from: 0, to: 30, p: { w: 4.6 } },
      ],
    },
    // (No way round the last climb: the top is the point. The tips say what it needs.)
    {
      kind: 'summit',
      label: 'Puaka Hill ledges',
      at: [369, 231],
      len: 85,
      needs: { low: true, diff: true },
      round: false,
      mix: [
        { kind: 'summit', from: 0, to: 85, p: { ledgeH: 0.3, humpH: 0.45 } },
        { kind: 'thicket', from: 0, to: 85 },
      ],
    },
  ],
  wayRound: 'gate',
  // (The ways round climb the hill too: low range, but no diff lock.)
  roundKit: { low: true },
  end: { label: 'Puaka Hill', sign: ['Puaka Hill', 'Lookout'] },
  startSign: ['Puaka Hill', 'Trail → 2 km'],
  hardWay: 'Over Puaka Hill the hard way. The whole island is below you.',
  finish: 'The top of Puaka Hill. The whole island is below you.',
};

/**
 * Super hard: out to Chek Jawa. From the end of the lane on Jalan Durian,
 * the old track east along the south shore to Punai Hut, then through the
 * coastal forest to the Chek Jawa shore. Six long stretches, each mixing
 * two or three kinds of ground, so the drive changes under you as you go:
 * granite first (a boulder garden, a bending V-notch, a rock waterfall);
 * a ford with a soft sand bed straight into a loose, rocky climb and a
 * scree descent; a long climb over loose gravel, rock and ledges; an
 * off-camber bench above the sea with mud ruts along its high side;
 * mangrove mud running into tidal sand; and past Punai Hut the old
 * laterite track (deep ruts, cross-axle ditches, a slippery red climb).
 * No signs and no gate. A longer way exists, inland by Jalan Sam Heng and
 * the old track past Petai and Balai quarries to Punai Hut, for whoever
 * finds it; the laterite track after it has no way round (it is the way
 * to Chek Jawa).
 */
export const CHEK_JAWA: TrailDef = {
  id: 'chekjawa',
  name: 'Pulau Ubin: Chek Jawa',
  grade: 'hard',
  paths: true,
  waypoints: [
    [2586, -123], // the end of the lane on Jalan Durian
    [3209, 171], // the south shore
    [3688, -14], // Punai Hut
    [3934, 18], // the Chek Jawa shore, where the boardwalk starts
  ],
  obstacles: [
    {
      // (Granite: a boulder garden, up a bending V-notch, then a rock waterfall.)
      kind: 'falls',
      label: 'Granite notch and waterfall',
      nice: 'Through the boulders, up the notch and the waterfall. Granite all the way.',
      at: [2641, -100],
      len: 130,
      needs: { low: true, diff: true },
      mix: [
        { kind: 'thicket', from: 0, to: 130, p: { w: 5.4 } },
        { kind: 'rocks', from: 0, to: 40, p: { humpH: 0.55 } },
        { kind: 'notch', from: 36, to: 86, p: { bend: 0.45, ends: 12 } },
        { kind: 'climb', from: 70, to: 130, p: { h: 6, up: 26, top: 12 } },
        { kind: 'falls', from: 78, to: 112, p: { ledgeH: 0.5, every: 3.5 } },
      ],
    },
    {
      kind: 'ford',
      label: 'Valley ford and loose climb',
      nice: 'Through the valley ford, up the loose climb and out.',
      at: [2770, -131],
      len: 280,
      needs: { low: true },
      // (Down a rock step into the valley, looked at from the rim.)
      drop: { at: 16, h: 1.3, until: 130, back: 30 },
      mix: [
        // (Down in a narrow valley: the ford at the bottom, the loose climb up
        // its floor, a boggy ditch at the foot of each wall, boulders on the rim.)
        { kind: 'valley', from: 0, to: 280, p: { w: 2.6, depth: 4, ends: 25, endOut: 50 } },
        { kind: 'thicket', from: 0, to: 280, p: { w: 8.6, rows: 4 } },
        { kind: 'sand', from: 30, to: 100, p: { dip: 0.3, duneH: 0 } },
        { kind: 'ford', from: 30, to: 100, p: { depth: 0.9, bank: 3.4, out: 15 } },
        { kind: 'rocks', from: 130, to: 220, p: { humpH: 0.15 } },
        { kind: 'climb', from: 80, to: 230, p: { h: 9, up: 32, top: 35 } },
        { kind: 'descent', from: 170, to: 240, p: { rut: 0.3 } },
      ],
    },
    {
      kind: 'summit',
      label: 'Rock and ledges',
      nice: 'Over the rock and the ledges. That was a proper climb.',
      at: [3075, -60],
      len: 280,
      needs: { low: true, diff: true },
      // (Off the top, a ledge down onto the ridge, seen from the flat shelf above it.)
      drop: { at: 160, h: 1, until: 278, back: 30 },
      mix: [
        { kind: 'ridge', from: 0, to: 280, p: { w: 2.6, drop: 3.5 } },
        { kind: 'climb', from: 0, to: 280, p: { h: 11, up: 45, top: 90 } },
        { kind: 'rocks', from: 20, to: 160, p: { humpH: 0.5 } },
        { kind: 'summit', from: 40, to: 150, p: { ledgeH: 0.3, every: 9 } },
      ],
    },
    {
      // (A line and kit: the high side, against the bank, through the ruts.)
      kind: 'camber',
      label: 'Muddy off-camber shore',
      nice: 'Along the muddy shore without sliding off. Good line.',
      at: [3253, 176],
      len: 236,
      needs: { diff: true },
      // (Down off the top of the bank onto the bench.)
      drop: { at: 16, h: 0.9, until: 232, back: 34 },
      mix: [
        { kind: 'camber', from: 0, to: 192, p: { deg: 30, bench: 5, edge: 1, width: 3.2, dir: 1 } },
        { kind: 'mud', from: 25, to: 185, p: { shift: 2.5, rut: 0.25, hole: 0.45 } },
        // (Then rock spurs off the bank: a tight left and right between them.)
        { kind: 'thicket', from: 186, to: 236, p: { w: 4.6, rows: 2, jink: 2.6, period: 18, square: 1.6, in: 10 } },
      ],
      then: { at: 186, off: ['diff'], say: 'Rocks and a tight turn ahead: DIFF off, or the front will not turn in.' },
    },
    {
      kind: 'mud',
      label: 'Mangrove mud and tidal sand',
      nice: 'Through the mangrove mud and over the tidal sand.',
      at: [3501, 79],
      len: 210,
      needs: { low: true, diff: true },
      // (Off the firm sand, down into the mud channel.)
      drop: { at: 16, h: 1, until: 128, back: 28 },
      mix: [
        // (Soft bog either side of the ruts.)
        { kind: 'ridge', from: 0, to: 210, p: { w: 2.5, drop: 1, run: 2 } },
        { kind: 'mud', from: 0, to: 100, p: { rut: 0.3, hole: 0.5 } },
        // (Mangrove trunks fallen across the ruts.)
        { kind: 'logs', from: 20, to: 84, p: { period: 9, r: 0.2 } },
        // (Then a firm run-up, and a tall, steep tidal dune: low range
        // cannot carry the speed over it.)
        { kind: 'sand', from: 96, to: 135, p: { firm: 1, grip: 0.75, drag: 1, sink: 0, duneH: 0, dip: 0.05 } },
        { kind: 'sand', from: 130, to: 210, p: { tidal: 1, duneH: 4.5, duneFace: 9, dip: 0.2 } },
      ],
      then: { at: 100, off: ['low'], say: 'Firm sand ahead: LOW off now, and build up speed for the dune.' },
    },
    {
      // (Past Punai Hut, the old laterite track: deep ruts, cross-axle
      // ditches, then a slippery red climb.)
      kind: 'ditches',
      label: 'Laterite ruts and ditches',
      nice: 'Over the ruts, across the ditches and up the red clay. Chek Jawa is close.',
      at: [3698, -2],
      len: 200,
      needs: { low: true, diff: true },
      mix: [
        { kind: 'thicket', from: 0, to: 200, p: { w: 4.2 } },
        { kind: 'rutted', from: 0, to: 76, p: { depth: 0.85 } },
        { kind: 'ditches', from: 74, to: 102, p: { depth: 0.55, period: 6.5 } },
        { kind: 'climb', from: 118, to: 200, p: { h: 8, up: 24, top: 25, wet: 1 } },
        // (Steps the rain has cut in the clay: crawled one corner at a time.)
        { kind: 'falls', from: 122, to: 146, p: { ledgeH: 0.35, every: 4, clay: 1 } },
      ],
    },
    {
      // (The last stretch before the shore: down into a creek and up out,
      // then straight onto a plank bridge over a gully.)
      kind: 'creek',
      label: 'Creek and plank bridge',
      nice: 'Through the creek and over the planks. The shore is right there.',
      at: [3860, 32],
      len: 62,
      needs: { low: true, diff: true },
      mix: [
        { kind: 'thicket', from: 0, to: 62, p: { w: 4.6 } },
        { kind: 'creek', from: 0, to: 28 },
        { kind: 'bridge', from: 32, to: 60 },
      ],
    },
  ],
  wayRound: 'hidden',
  detour: { waypoints: [[2586, -123], [2122, -210], [2636, -502], [3258, -240], [3688, -14]], skips: [0, 1, 2, 3, 4] },
  end: { label: 'Chek Jawa', sign: ['Chek Jawa', 'Wetlands'] },
  startSign: ['Chek Jawa', 'Old track → 2 km'],
  hardWay: 'Chek Jawa, the hard way. The tide is out and the flats are yours.',
  finish: 'Chek Jawa. The tide is out and the flats are yours.',
  ruts: true,
};
