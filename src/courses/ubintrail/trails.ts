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
  clean: 'Clean run: every obstacle on the hard line. Make camp when you are ready.',
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
    { kind: 'rocks', label: 'Roots and rock', at: [65, 24], len: 190, needs: { diff: true } },
    // (Control, not kit: low range makes it easier, but the brakes get you down too.)
    { kind: 'descent', label: 'Loose descent', at: [480, -102], len: 110, needs: {} },
    // (No way round the last climb: the top is the point. The tips say what it needs.)
    { kind: 'summit', label: 'Puaka Hill ledges', at: [369, 231], len: 85, needs: { low: true, diff: true }, round: false, p: { ledgeH: 0.3, humpH: 0.45 } },
  ],
  wayRound: 'gate',
  // (The ways round climb the hill too: low range, but no diff lock.)
  roundKit: { low: true },
  end: { label: 'Puaka Hill', sign: ['Puaka Hill', 'Lookout'] },
  startSign: ['Puaka Hill', 'Trail → 2 km'],
  clean: 'Clean run over Puaka Hill: every obstacle on the hard line. The whole island is below you.',
  finish: 'The top of Puaka Hill. The whole island is below you.',
};

/**
 * Super hard: out to Chek Jawa. From the end of the lane on Jalan Durian,
 * the old track east along the south shore to Punai Hut, then through the
 * coastal forest to the Chek Jawa shore. Four long stretches, each mixing
 * two or three kinds of ground, so the drive changes under you as you go:
 * a ford with a soft sand bed straight into a loose, rocky climb and a
 * scree descent; a long climb over loose gravel, rock and ledges; an
 * off-camber bench above the sea with mud ruts along its high side; and
 * mangrove mud running into tidal sand. No signs and no gate. A longer
 * way exists, inland by Jalan Sam Heng and the old track past Petai and
 * Balai quarries, for whoever finds it.
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
      kind: 'ford',
      label: 'Ford and loose climb',
      nice: 'Across the ford, up the loose climb and down the far side.',
      at: [2770, -131],
      len: 280,
      needs: { low: true },
      mix: [
        { kind: 'sand', from: 0, to: 70, p: { dip: 0.3, duneH: 0 } },
        { kind: 'ford', from: 0, to: 70, p: { depth: 0.9, bank: 3.4, out: 15 } },
        { kind: 'rocks', from: 100, to: 190, p: { humpH: 0.15 } },
        { kind: 'climb', from: 50, to: 200, p: { h: 9, up: 32, top: 35 } },
        { kind: 'descent', from: 150, to: 280, p: { rut: 0.3 } },
      ],
    },
    {
      kind: 'summit',
      label: 'Rock and ledges',
      nice: 'Over the rock and the ledges. That was a proper climb.',
      at: [3075, -60],
      len: 280,
      needs: { low: true, diff: true },
      mix: [
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
      len: 210,
      needs: { diff: true },
      mix: [
        { kind: 'camber', from: 0, to: 210, p: { deg: 30, bench: 5, edge: 1, width: 3.2, dir: 1 } },
        { kind: 'mud', from: 25, to: 185, p: { shift: 2.5, rut: 0.25, hole: 0.45 } },
      ],
    },
    {
      kind: 'mud',
      label: 'Mangrove mud and tidal sand',
      nice: 'Through the mangrove mud and over the tidal sand.',
      at: [3501, 79],
      len: 210,
      needs: { low: true, diff: true },
      mix: [
        { kind: 'mud', from: 0, to: 120, p: { rut: 0.3, hole: 0.5 } },
        { kind: 'sand', from: 100, to: 210, p: { tidal: 1, duneH: 2.6, duneFace: 10, dip: 0.35 } },
      ],
    },
  ],
  wayRound: 'hidden',
  detour: { waypoints: [[2586, -123], [2122, -210], [2636, -502], [3258, -240], [3688, -14]], skips: [0, 1, 2, 3] },
  end: { label: 'Chek Jawa', sign: ['Chek Jawa', 'Wetlands'] },
  startSign: ['Chek Jawa', 'Old track → 2 km'],
  clean: 'Chek Jawa, the hard way: every obstacle on the hard line. The tide is out and the flats are yours.',
  finish: 'Chek Jawa. The tide is out and the flats are yours.',
};
