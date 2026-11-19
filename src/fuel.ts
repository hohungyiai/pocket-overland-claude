// Fuel as trip planning: the HUD shows how far the tank will take you, the
// map shows the real petrol stations, and an empty tank never strands you:
// the car carries on at a crawl to the nearest station. Mistakes cost time.

import type { Surface } from './courses/types';

export interface Station {
  name: string;
  x: number;
  z: number;
  /** How far the forecourt reaches from its middle (m). */
  r: number;
}

/** How far a full tank goes, in game km on easy roads (the user's choice). */
export const TANK_KM = 60;
/** Top speed with an empty tank (m/s, about 20 km/h): slow, but it climbs. */
export const CRAWL_SPEED = 5.5;
/** A metre climbed burns what this many metres on the flat do. */
const CLIMB = 10;

/** How much harder than easy tarmac a surface is on fuel. */
const surfaceCost = (s: Surface) => (s.drag >= 20 ? 1.8 : s.drag >= 1.5 ? 1.25 : 1);

export class Fuel {
  /** 0 (empty) .. 1 (full). */
  level: number;
  /** Recent cost per metre against easy tarmac (for the range). */
  private recent = 1;
  /** The pump is running: litres flowing in until full. */
  filling = false;

  constructor(
    readonly stations: Station[],
    level = 1,
  ) {
    this.level = Math.min(1, Math.max(0, level));
  }

  /** True where fuel is used: only on maps that have stations to fill up at. */
  get used() {
    return this.stations.length > 0;
  }

  get empty() {
    return this.used && this.level <= 0;
  }

  /** Burn fuel for a stretch driven: metres along, metres climbed, the ground, low range. */
  burn(metres: number, climbed: number, surface: Surface, low: boolean) {
    if (!this.used || metres <= 0) return;
    const k = surfaceCost(surface) * (low ? 1.6 : 1);
    const cost = metres * k + Math.max(0, climbed) * CLIMB;
    // The range follows the last kilometre or so of driving.
    const a = Math.min(1, metres / 800);
    this.recent += (cost / metres - this.recent) * a;
    this.level = Math.max(0, this.level - cost / (TANK_KM * 1000));
  }

  /** km left at the way you've been driving lately. */
  get rangeKm() {
    return (this.level * TANK_KM) / Math.max(1, this.recent);
  }

  nearest(x: number, z: number): { station: Station; dist: number } | null {
    let best: { station: Station; dist: number } | null = null;
    for (const s of this.stations) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (!best || d < best.dist) best = { station: s, dist: d };
    }
    return best;
  }

  /** The station whose forecourt the car is on, if any. */
  at(x: number, z: number): Station | null {
    for (const s of this.stations) if (Math.hypot(s.x - x, s.z - z) < s.r + 6) return s;
    return null;
  }

  /** Pump fuel in for dt seconds (a full tank takes about 4 s). Returns true once full. */
  pump(dt: number) {
    this.level = Math.min(1, this.level + dt / 4);
    return this.level >= 1;
  }
}

export const distText = (m: number) => (m < 950 ? `${Math.max(50, Math.round(m / 50) * 50)} m` : `${(m / 1000).toFixed(1)} km`);
