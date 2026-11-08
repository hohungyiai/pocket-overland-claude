import type * as THREE from 'three';

export interface Surface {
  name: string;
  /** Tyre friction coefficient (Rapier friction slip). */
  grip: number;
  /** Rolling resistance, applied as a light per-wheel brake. */
  drag: number;
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
  pois: { x: number; z: number; label: string }[];
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
  /** Load the world around a point right away (before placing the car there). */
  prepareAt?(x: number, z: number): void;
  /** Tile streaming counters, for the debug overlay. */
  streamStats?: () => { near: number; far: number; horizon: number; pending: number; maxStepMs: number };
  /** Places where you can make camp (rest and save). */
  camps?: import('../camp').CampSpot[];
  sky: { background: number; fog: number; fogNear: number; fogFar: number };
}
