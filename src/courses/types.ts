import type * as THREE from 'three';

export interface Surface {
  name: string;
  /** Tyre friction coefficient (Rapier friction slip). */
  grip: number;
  /** Rolling resistance, applied as a light per-wheel brake. */
  drag: number;
  /**
   * Off the road (trails only; no road surface sets it). Here the car's
   * differential works as a real one does: with it open, both wheels on an
   * axle get only what the weaker one can grip, so a light or lifted wheel
   * takes the axle's drive away. Locking the diff gives each wheel its own.
   */
  offroad?: boolean;
  /**
   * Off the road only: loose rock and gravel that knocks the front wheels
   * about at speed (0..1). Above a walking pace the steering is jerked off
   * line at random, harder the faster the car goes and the more it is
   * already being steered; slow, it stays calm.
   */
  rough?: number;
  /** Soft ground the tyres sink into: rolling resistance as a share of the wheel's load. */
  sink?: number;
  /** Water to wade through: it holds the car back with the square of its speed (a bow wave), so charging it does not work. */
  wade?: number;
  /** Off the road only: the speed (m/s) below which `wade` does nothing (0 if unset): loose gravel ploughs in only when hit fast. */
  wadeFrom?: number;
}

export const SURFACES = {
  asphalt: { name: 'Asphalt', grip: 1.0, drag: 0.8 },
  gravel: { name: 'Gravel', grip: 0.85, drag: 1.5 },
  dirt: { name: 'Dirt', grip: 0.8, drag: 2 },
  grass: { name: 'Grass', grip: 0.7, drag: 4 },
  rock: { name: 'Rock', grip: 1.05, drag: 1 },
  sand: { name: 'Sand', grip: 0.6, drag: 30 },
  mud: { name: 'Mud', grip: 0.5, drag: 22 },
  water: { name: 'Water', grip: 0.55, drag: 24 },
} satisfies Record<string, Surface>;

export type XZ = [number, number];

/** What the minimap draws, in world metres (x east, z south). */
export interface MapData {
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  background: string;
  areas: { pts: XZ[]; color: string }[];
  lines: { pts: XZ[]; width: number; color: string; closed?: boolean }[];
  pois: { x: number; z: number; label: string; kind?: 'fuel' | 'garage' }[];
  /** Resolution of the pre-painted minimap (default 1 px per metre). */
  pxPerM?: number;
  /** Credit line for the map data, shown on the full map. */
  attribution?: string;
}

export interface Course {
  name: string;
  start: THREE.Vector3;
  startYaw: number;
  heightAt(x: number, z: number): number;
  surfaceAt(x: number, z: number, y: number): Surface;
  zoneAt(x: number, z: number): string | null;
  /** Position (on the ground) and heading of the main road at position t (0..1). */
  poseAt(t: number): { pos: THREE.Vector3; yaw: number };
  /** Position (0..1) of the nearest main-road point. */
  trackT(x: number, z: number): number;
  map: MapData;
  /** True when the course can be built in both art styles. */
  styles?: boolean;
  /** Optional per-frame animation (sea, swaying trees, ships). */
  update?(time: number, dt: number, camera?: { x: number; z: number }, player?: { x: number; z: number }): void;
  /** Nearest safe place to put the car back (on a road, out of the water), if the course knows one. */
  safeSpot?(x: number, z: number): { x: number; z: number; yaw: number } | null;
  /** On or beside a trail obstacle: where to start it again (a little before it, facing along the trail). */
  retryAt?(x: number, z: number): { x: number; z: number; yaw: number; label: string } | null;
  /** Height of whatever the car can stand on at (x, z) near height y: a bridge deck, else the ground. */
  surfaceY?(x: number, z: number, y: number): number;
  /** Load the world around a point right away (before placing the car there). */
  prepareAt?(x: number, z: number): void;
  /** Is the solid ground (and road) under (x, z) built yet? (Courses that stream their tiles.) */
  solidAt?(x: number, z: number): boolean;
  /** Tile streaming counters, for the debug overlay. */
  streamStats?: () => { near: number; far: number; horizon: number; pending: number; maxStepMs: number };
  /**
   * Trail coaching, called a few times a second with the car's state:
   * a tip to show now (after a stall), a message to say once, and the name
   * of the obstacle you are at. (Courses with obstacles.)
   */
  coach?(c: { x: number; z: number; speed: number; low: boolean; diff: boolean; stuck: number }): { tip?: string; say?: string; zone?: string; scored?: { label: string; points: number; best: number } } | null;
  /** The marked tree the winch hooks onto from the car's tow point, the car facing (fx, fz), if any (trails with a winch). */
  winchAt?(x: number, y: number, z: number, fx: number, fz: number, avoid?: { x: number; z: number } | null, kit?: { low: boolean; diff: boolean }): { x: number; y: number; z: number; help?: boolean; to?: { x: number; z: number } } | null;
  /** Winching back from off the track: the car is on it again, so the winch unhooks. */
  winchHome?(x: number, z: number): boolean;
  /** The ground the winch's haul rides on: the ground, or a boulder's top. */
  winchGround?(x: number, z: number): number;
  /** Ground that remembers: how worn by spinning wheels at (x, z), 0..1 (trails with ruts). */
  rutAt?(x: number, z: number): number;
  /** A wheel spinning on soft ground at (x, z) wears it by `amount`. */
  dig?(x: number, z: number, amount: number): void;
  /** Fresh ground again (on Try again). */
  resetRuts?(): void;
  /** Clean-run score: a penalty (winch pull 5, try again 10) on the stretch at (x, z). */
  penalty?(what: 'winch' | 'retry', x: number, z: number): void;
  /** Clean-run score: the stretch being driven and its points so far. */
  score?(): { label: string; points: number; best?: number } | null;
  /** Clean-run score: the bests kept in the save, by stretch label. */
  setBest?(best: Record<string, number>): void;
  /** Petrol stations: where fuel is used and where you fill up (fuel.ts). */
  fuel?: import('../fuel').Station[];
  /** Places where you can make camp (rest and save). */
  camps?: import('../camp').CampSpot[];
  sky: { background: number; fog: number; fogNear: number; fogFar: number };
}
