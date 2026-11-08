// What the car can drive over, and the limits every road is built to.
//
// Measured on the car in src/vehicle.ts by tools/limits/measure.ts (run
// `npm run limits` after changing the car's tuning, and update these):
//  - climb: the steepest slope it drives up from a standstill, in high range
//    (low range manages 23°);
//  - lip: the highest step it climbs from a standstill with its front wheels
//    against it, in high range (low range: 0.52 m);
//  - tilt: parked across a slope it slides sideways at 44° before it tips;
//  - twist: driven flat out along a road whose side tilt swings back and
//    forth, it rolls over once the tilt changes by 0.3 (rise per metre
//    across) within 5 m, the length of the car and a bit.
// Roads keep to 60% of each, so the car always gets over them with room to
// spare (SAFETY).
export const CAR = {
  climbDeg: 19,
  lip: 0.3,
  tiltDeg: 44,
  twist: 0.3,
};
export const SAFETY = 0.6;
const tanDeg = (d: number) => Math.tan((d * Math.PI) / 180);
export const LIMITS = {
  /** Steepest grade along a road (rise per metre, over 5 m). */
  grade: tanDeg(CAR.climbDeg * SAFETY),
  /** Highest sudden step anywhere the car drives (m). */
  lip: CAR.lip * SAFETY,
  /** Steepest side tilt across a road (rise per metre across). */
  tilt: tanDeg(CAR.tiltDeg * SAFETY),
  /** Fastest change of side tilt along a road (per 5 m). */
  twist: CAR.twist * SAFETY,
};
