import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';

// Tile streaming. The world is a grid of square tiles; each tile has two
// layers that load and unload on their own:
//   - "far":  cheap, large things you see from a distance (ground, roads,
//             buildings). Kept out to the fog distance so the horizon
//             doesn't change.
//   - "near": the expensive detail and everything solid (trees, grass,
//             furniture, colliders). Kept within a smaller radius.
// Builders are generator functions that yield between steps, so a tile is
// built a slice at a time inside a per-frame time budget, never in one hitch.
// Everything a tile makes is generated from global shape functions and a
// per-tile seed, so a tile rebuilt later is identical.

export const TILE = 200;

export interface TileKit {
  /** Add a mesh (or other object) that belongs to this tile layer. */
  add(o: THREE.Object3D): void;
  /** A geometry made for this tile alone, freed when the tile unloads. */
  own<T extends THREE.BufferGeometry>(g: T): T;
  /** A fixed physics body for this tile layer, removed when it unloads. */
  body(desc?: RAPIER_NS.RigidBodyDesc): RAPIER_NS.RigidBody;
}

export type LayerBuilder = (i: number, j: number, kit: TileKit) => Generator<void, void, void>;

interface Layer {
  objects: THREE.Object3D[];
  geometries: THREE.BufferGeometry[];
  bodies: RAPIER_NS.RigidBody[];
  job: Generator<void, void, void> | null;
}

type LayerName = 'near' | 'far';

export class TileStreamer {
  private loaded = new Map<string, Layer>(); // key: "near:i,j" / "far:i,j"
  private queue: { key: string; layer: LayerName; i: number; j: number; d: number }[] = [];
  /** Built tile counts, for the debug overlay and tests. */
  stats = { near: 0, far: 0, pending: 0, maxStepMs: 0 };

  constructor(
    private scene: THREE.Scene,
    private world: RAPIER_NS.World,
    private RAPIER: typeof RAPIER_NS,
    private builders: Record<LayerName, LayerBuilder>,
    private bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
    private radius: Record<LayerName, number> = { near: 700, far: 1700 },
  ) {}

  private tilesAround(x: number, z: number, r: number) {
    const out: { i: number; j: number; d: number }[] = [];
    const b = this.bounds;
    const i0 = Math.floor((Math.max(b.minX, x - r)) / TILE);
    const i1 = Math.floor((Math.min(b.maxX - 1e-3, x + r)) / TILE);
    const j0 = Math.floor((Math.max(b.minZ, z - r)) / TILE);
    const j1 = Math.floor((Math.min(b.maxZ - 1e-3, z + r)) / TILE);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        // Distance from the point to the tile rectangle.
        const dx = Math.max(i * TILE - x, 0, x - (i + 1) * TILE);
        const dz = Math.max(j * TILE - z, 0, z - (j + 1) * TILE);
        const d = Math.hypot(dx, dz);
        if (d <= r) out.push({ i, j, d });
      }
    }
    return out;
  }

  private kit(layer: Layer): TileKit {
    return {
      add: (o) => {
        layer.objects.push(o);
        this.scene.add(o);
      },
      own: (g) => {
        layer.geometries.push(g);
        return g;
      },
      body: (desc) => {
        const b = this.world.createRigidBody(desc ?? this.RAPIER.RigidBodyDesc.fixed());
        layer.bodies.push(b);
        return b;
      },
    };
  }

  /** Work out what should be loaded around (x, z); queue builds, drop far tiles. */
  private plan(x: number, z: number) {
    const want = new Set<string>();
    this.queue = [];
    for (const layer of ['near', 'far'] as const) {
      // Unload a little beyond the load radius so tiles at the edge don't flicker.
      for (const t of this.tilesAround(x, z, this.radius[layer] + 60)) want.add(`${layer}:${t.i},${t.j}`);
      for (const t of this.tilesAround(x, z, this.radius[layer])) {
        const key = `${layer}:${t.i},${t.j}`;
        const have = this.loaded.get(key);
        if (!have || have.job) this.queue.push({ key, layer, ...t });
      }
    }
    for (const [key, layer] of this.loaded) if (!want.has(key)) this.unload(key, layer);
    // Nearest first; near-layer (solid ground) before far at equal distance.
    this.queue.sort((a, b) => a.d - b.d || (a.layer === 'near' ? -1 : 1));
    this.stats.pending = this.queue.length;
  }

  private unload(key: string, layer: Layer) {
    for (const o of layer.objects) this.scene.remove(o);
    for (const g of layer.geometries) g.dispose();
    for (const b of layer.bodies) this.world.removeRigidBody(b);
    this.loaded.delete(key);
    this.stats[key.startsWith('near') ? 'near' : 'far']--;
  }

  /** Advance builds for up to `budgetMs`. Returns true when nothing is pending. */
  private work(budgetMs: number) {
    const t0 = performance.now();
    while (this.queue.length) {
      const q = this.queue[0];
      let layer = this.loaded.get(q.key);
      if (!layer) {
        layer = { objects: [], geometries: [], bodies: [], job: null };
        layer.job = this.builders[q.layer](q.i, q.j, this.kit(layer));
        this.loaded.set(q.key, layer);
        this.stats[q.layer]++;
      }
      while (layer.job) {
        const s0 = performance.now();
        if (layer.job.next().done) layer.job = null;
        if (budgetMs !== Infinity) this.stats.maxStepMs = Math.max(this.stats.maxStepMs, performance.now() - s0);
        if (performance.now() - t0 > budgetMs) return false;
      }
      this.queue.shift();
      this.stats.pending = this.queue.length;
    }
    return true;
  }

  private lastPlan = { x: Infinity, z: Infinity };
  /** Call every frame with the camera (or car) position. */
  update(x: number, z: number, budgetMs = 3) {
    if (Math.hypot(x - this.lastPlan.x, z - this.lastPlan.z) > 25) {
      this.lastPlan = { x, z };
      this.plan(x, z);
    }
    if (this.queue.length) this.work(budgetMs);
  }

  /** Load everything around (x, z) right now (behind a loading screen). */
  prepare(x: number, z: number) {
    this.lastPlan = { x, z };
    this.plan(x, z);
    this.work(Infinity);
  }

  /** Is the solid ground under (x, z) built yet? */
  solidAt(x: number, z: number) {
    const l = this.loaded.get(`near:${Math.floor(x / TILE)},${Math.floor(z / TILE)}`);
    return !!l && !l.job;
  }
}
