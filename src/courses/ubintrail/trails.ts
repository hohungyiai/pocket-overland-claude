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
 * Medium: over Puaka Hill. From Puaka Bridge along the path round the south
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
    [-129, 32], // Puaka Bridge
    [356, -120], // the path round the south of the quarry
    [604, 112], // down to the lane
    [321, 379], // Jalan Endut Senin, at the foot of the hill path
    [438, 162], // the top of Puaka Hill
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
    [[438, 162], 34],
  ],
  obstacles: [
    { kind: 'rocks', label: 'Roots and rock', at: [65, 24], len: 190, needs: { diff: true } },
    { kind: 'descent', label: 'Loose descent', at: [480, -102], len: 110, needs: { low: true } },
    { kind: 'summit', label: 'Puaka Hill ledges', at: [369, 231], len: 110, needs: { low: true, diff: true } },
  ],
  wayRound: 'gate',
  end: { label: 'Puaka Hill', sign: ['Puaka Hill', 'Lookout'] },
  startSign: ['Puaka Hill', 'Trail → 2 km'],
  clean: 'Clean run over Puaka Hill: every obstacle on the hard line. The whole island is below you.',
  finish: 'The top of Puaka Hill. The whole island is below you.',
};

/**
 * Super hard: out to Chek Jawa. From the end of the lane on Jalan Durian,
 * the old track east along the south shore: a ford, tidal sand, an
 * off-camber stretch above the water and deep mud at the mangrove edge,
 * each one long, then through the coastal forest to the Chek Jawa shore.
 * No signs and no gate. A longer way exists, inland by Jalan Sam Heng and
 * the old track past Petai and Balai quarries, for whoever finds it.
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
    { kind: 'ford', label: 'Ford', at: [2930, -110], len: 50, needs: { low: true }, p: { depth: 0.9, bank: 3.4, out: 15 } },
    { kind: 'sand', label: 'Tidal sand', at: [3120, -40], len: 140, needs: { speed: true }, p: { tidal: 1, duneH: 2.6, duneFace: 10, dip: 0.35 } },
    { kind: 'camber', label: 'Off-camber shore', at: [3230, 172], len: 150, needs: {}, p: { deg: 17, dir: 1 } },
    { kind: 'mud', label: 'Mangrove mud', at: [3500, 90], len: 190, needs: { low: true, diff: true } },
  ],
  wayRound: 'hidden',
  detour: { waypoints: [[2586, -123], [2122, -210], [2636, -502], [3258, -240], [3688, -14]], skips: [0, 1, 2, 3] },
  end: { label: 'Chek Jawa', sign: ['Chek Jawa', 'Wetlands'] },
  startSign: ['Chek Jawa', 'Old track → 2 km'],
  clean: 'Chek Jawa, the hard way: every obstacle on the hard line. The tide is out and the flats are yours.',
  finish: 'Chek Jawa. The tide is out and the flats are yours.',
};
