import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';

// A tile's build, written down as plain data: the meshes it draws and the
// solid shapes the car meets, in the order it made them. The builders hand
// everything to a TileRecorder instead of to the scene and the physics
// world; when the tile is done, `replay` turns the record into scene objects
// and colliders. Plain data (typed arrays, numbers, names) is what can be
// sent from a background worker, so the builders can later run there
// without the game's frames waiting on them, or on the browser's clear-ups
// of what they throw away. (Plan "Build the map in the background", 27 Nov.)
//
// Materials and geometries that many tiles share (the road's asphalt, a
// tree's shape) go by name: the course names each one once (`share`), and
// a record carries only the name.

/** A collider's description: Rapier's own ColliderDesc calls, kept as data. */
export type ColShape =
  | { s: 'cuboid'; hx: number; hy: number; hz: number }
  | { s: 'cylinder'; hh: number; r: number }
  | { s: 'heightfield'; nrows: number; ncols: number; heights: Float32Array; scale: { x: number; y: number; z: number } }
  | { s: 'trimesh'; pos: Float32Array; idx: Uint32Array };

export class ColDesc {
  t: [number, number, number] | null = null;
  r: [number, number, number, number] | null = null;
  f: number | null = null;
  constructor(public shape: ColShape) {}
  setTranslation(x: number, y: number, z: number) {
    this.t = [x, y, z];
    return this;
  }
  setRotation(q: { x: number; y: number; z: number; w: number }) {
    this.r = [q.x, q.y, q.z, q.w];
    return this;
  }
  setFriction(f: number) {
    this.f = f;
    return this;
  }
}

/** Collider descriptions, called as RAPIER.ColliderDesc is. */
export const CD = {
  cuboid: (hx: number, hy: number, hz: number) => new ColDesc({ s: 'cuboid', hx, hy, hz }),
  cylinder: (hh: number, r: number) => new ColDesc({ s: 'cylinder', hh, r }),
  heightfield: (nrows: number, ncols: number, heights: Float32Array, scale: { x: number; y: number; z: number }) => new ColDesc({ s: 'heightfield', nrows, ncols, heights, scale: { ...scale } }),
  trimesh: (pos: Float32Array, idx: Uint32Array) => new ColDesc({ s: 'trimesh', pos, idx }),
};

type AttrRec = { name: string; array: THREE.TypedArray; itemSize: number; normalized: boolean };
/** A geometry made for one tile: its attributes and index, as arrays. */
export type GeoRec = { attrs: AttrRec[]; index: Uint32Array | Uint16Array | null; groups: { start: number; count: number; materialIndex?: number }[] };

/** What a tile's meshes are tagged with, for the course's own upkeep (see `onTag`). */
export type TileTag = Record<string, unknown>;

export type ObjRec = {
  kind: 'mesh' | 'inst';
  /** Its own geometry, or the name of a shared one. */
  geo: GeoRec | string;
  mat: string;
  cast: boolean;
  recv: boolean;
  coverable: boolean;
  /** Position, quaternion and scale, where not the identity. */
  pos: [number, number, number] | null;
  quat: [number, number, number, number] | null;
  scale: [number, number, number] | null;
  /** Instanced: how many, each one's matrix and colour, and the bounding sphere worked out for them. */
  count?: number;
  matrices?: Float32Array;
  colors?: Float32Array | null;
  sphere?: [number, number, number, number] | null;
  tag?: TileTag;
};

/** One step of a tile's build, in order: a mesh added, a fixed body made, a collider on one. */
export type Op = { op: 'add'; obj: ObjRec } | { op: 'body' } | { op: 'col'; body: number; desc: ColDesc };

/** A fixed body a builder asked for: which record, and which body in it. */
export type BodyRef = { rec: TileRecorder | null; i: number };

/** Add a collider to a body (or nothing, for a body from a build that is thrown away). */
export const collide = (desc: ColDesc, body: BodyRef | null) => body?.rec?.collide(desc, body);

/** Names of the materials and geometries tiles share. */
export class Shared {
  private names = new Map<object, string>();
  private things = new Map<string, THREE.Material | THREE.BufferGeometry>();
  /** Name `thing` (once, at the course's start), and hand it back. */
  share<T extends THREE.Material | THREE.BufferGeometry>(name: string, thing: T): T {
    if (this.things.has(name)) throw new Error(`shared name used twice: ${name}`);
    this.names.set(thing, name);
    this.things.set(name, thing);
    return thing;
  }
  nameOf(thing: object): string {
    const n = this.names.get(thing);
    if (n === undefined) throw new Error('a tile used a material or geometry that is neither its own nor shared');
    return n;
  }
  material(name: string) {
    const m = this.things.get(name);
    if (!(m instanceof THREE.Material)) throw new Error(`no shared material ${name}`);
    return m;
  }
  geometry(name: string) {
    const g = this.things.get(name);
    if (!(g instanceof THREE.BufferGeometry)) throw new Error(`no shared geometry ${name}`);
    return g;
  }
}

const geoRec = (g: THREE.BufferGeometry): GeoRec => {
  const attrs: AttrRec[] = [];
  for (const [name, a] of Object.entries(g.attributes)) {
    if (!(a instanceof THREE.BufferAttribute) || a instanceof THREE.InstancedBufferAttribute) throw new Error(`tile geometry attribute ${name} is not a plain BufferAttribute`);
    attrs.push({ name, array: a.array, itemSize: a.itemSize, normalized: a.normalized });
  }
  if (Object.keys(g.morphAttributes).length) throw new Error('tile geometry with morph attributes');
  const index = g.index ? (g.index.array as Uint32Array | Uint16Array) : null;
  return { attrs, index, groups: g.groups.map((q) => ({ ...q })) };
};

/**
 * The kit a tile's builders are handed: everything they make is written
 * down, in order, and nothing reaches the scene or the physics world until
 * `replay`.
 */
export class TileRecorder {
  ops: Op[] = [];
  /** This tile's own geometries, each written down once (two meshes may draw one). */
  private owned = new Map<THREE.BufferGeometry, GeoRec | null>();
  private bodies = 0;
  constructor(private shared: Shared) {}
  /** A geometry made for this tile alone (recorded with the mesh that draws it). */
  own<T extends THREE.BufferGeometry>(g: T): T {
    this.owned.set(g, null);
    return g;
  }
  /** A mesh (or instanced mesh) of this tile. Horizon ground passes `coverable`: it hides under the detailed ground. */
  add(o: THREE.Object3D, coverable = false, tag?: TileTag) {
    if (!(o instanceof THREE.Mesh) || o.children.length || Array.isArray(o.material)) throw new Error('a tile may add only plain meshes, one material each');
    const inst = o instanceof THREE.InstancedMesh;
    let geo: GeoRec | string;
    if (this.owned.has(o.geometry) && !inst) {
      geo = this.owned.get(o.geometry) ?? geoRec(o.geometry);
      this.owned.set(o.geometry, geo);
    } else geo = this.shared.nameOf(o.geometry);
    const p = o.position, q = o.quaternion, s = o.scale;
    const rec: ObjRec = {
      kind: inst ? 'inst' : 'mesh',
      geo,
      mat: this.shared.nameOf(o.material),
      cast: o.castShadow,
      recv: o.receiveShadow,
      coverable,
      pos: p.x || p.y || p.z ? [p.x, p.y, p.z] : null,
      quat: q.x || q.y || q.z || q.w !== 1 ? [q.x, q.y, q.z, q.w] : null,
      scale: s.x !== 1 || s.y !== 1 || s.z !== 1 ? [s.x, s.y, s.z] : null,
      tag,
    };
    if (o.visible === false || o.renderOrder || !o.frustumCulled || !o.matrixAutoUpdate) throw new Error('a tile mesh with settings the record does not keep');
    if (o instanceof THREE.InstancedMesh) {
      rec.count = o.count;
      rec.matrices = o.instanceMatrix.array as Float32Array;
      rec.colors = o.instanceColor ? (o.instanceColor.array as Float32Array) : null;
      const b = o.boundingSphere;
      rec.sphere = b ? [b.center.x, b.center.y, b.center.z, b.radius] : null;
    }
    this.ops.push({ op: 'add', obj: rec });
  }
  /** A fixed physics body for this tile layer. */
  body(): BodyRef {
    this.ops.push({ op: 'body' });
    return { rec: this, i: this.bodies++ };
  }
  collide(desc: ColDesc, b: BodyRef) {
    if (b.rec !== this) throw new Error("a collider on another tile's body");
    this.ops.push({ op: 'col', body: b.i, desc });
  }
}

/** A kit whose work is thrown away (a build run again only for what it works out). */
export const nullKit = {
  own: <T>(g: T) => g,
  add: () => {},
  body: (): BodyRef => ({ rec: null, i: -1 }),
  collide: () => {},
} as unknown as TileRecorder;

/** What a replayed tile made, for unloading it later. */
export type Made = { objects: THREE.Object3D[]; coverable: THREE.Object3D[]; geometries: THREE.BufferGeometry[]; bodies: RAPIER_NS.RigidBody[] };

const geometryOf = (r: GeoRec) => {
  const g = new THREE.BufferGeometry();
  for (const a of r.attrs) g.setAttribute(a.name, new THREE.BufferAttribute(a.array, a.itemSize, a.normalized));
  if (r.index) g.setIndex(new THREE.BufferAttribute(r.index, 1));
  for (const q of r.groups) g.addGroup(q.start, q.count, q.materialIndex);
  return g;
};

const colliderOf = (RAPIER: typeof RAPIER_NS, d: ColDesc) => {
  const sh = d.shape;
  const c =
    sh.s === 'cuboid'
      ? RAPIER.ColliderDesc.cuboid(sh.hx, sh.hy, sh.hz)
      : sh.s === 'cylinder'
        ? RAPIER.ColliderDesc.cylinder(sh.hh, sh.r)
        : sh.s === 'heightfield'
          ? RAPIER.ColliderDesc.heightfield(sh.nrows, sh.ncols, sh.heights, sh.scale)
          : RAPIER.ColliderDesc.trimesh(sh.pos, sh.idx);
  if (d.t) c.setTranslation(d.t[0], d.t[1], d.t[2]);
  if (d.r) c.setRotation({ x: d.r[0], y: d.r[1], z: d.r[2], w: d.r[3] });
  if (d.f !== null) c.setFriction(d.f);
  return c;
};

/**
 * Make a tile's record real: its meshes into the scene, its bodies and
 * colliders into the physics world, in the order the builders made them.
 * `onTag` hears of each tagged mesh as it is made.
 */
export function replay(
  ops: Op[],
  shared: Shared,
  scene: THREE.Scene,
  world: RAPIER_NS.World,
  RAPIER: typeof RAPIER_NS,
  hidden: boolean,
  onTag: ((o: THREE.Mesh, tag: TileTag) => void) | undefined,
  made: Made,
) {
  const bodies: RAPIER_NS.RigidBody[] = [];
  const geos = new Map<GeoRec, THREE.BufferGeometry>();
  for (const op of ops) {
    if (op.op === 'body') {
      const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      bodies.push(b);
      made.bodies.push(b);
    } else if (op.op === 'col') world.createCollider(colliderOf(RAPIER, op.desc), bodies[op.body]);
    else {
      const r = op.obj;
      let geo: THREE.BufferGeometry;
      if (typeof r.geo === 'string') geo = shared.geometry(r.geo);
      else if (geos.has(r.geo)) geo = geos.get(r.geo)!;
      else {
        geo = geometryOf(r.geo);
        geos.set(r.geo, geo);
        made.geometries.push(geo);
      }
      const mat = shared.material(r.mat);
      let o: THREE.Mesh;
      if (r.kind === 'inst') {
        const im = new THREE.InstancedMesh(geo, mat, 0);
        im.count = r.count!;
        im.instanceMatrix = new THREE.InstancedBufferAttribute(r.matrices!, 16);
        if (r.colors) im.instanceColor = new THREE.InstancedBufferAttribute(r.colors, 3);
        if (r.sphere) im.boundingSphere = new THREE.Sphere(new THREE.Vector3(r.sphere[0], r.sphere[1], r.sphere[2]), r.sphere[3]);
        o = im;
      } else o = new THREE.Mesh(geo, mat);
      o.castShadow = r.cast;
      o.receiveShadow = r.recv;
      if (r.pos) o.position.set(r.pos[0], r.pos[1], r.pos[2]);
      if (r.quat) o.quaternion.set(r.quat[0], r.quat[1], r.quat[2], r.quat[3]);
      if (r.scale) o.scale.set(r.scale[0], r.scale[1], r.scale[2]);
      if (r.coverable) {
        made.coverable.push(o);
        if (hidden) o.visible = false;
      }
      made.objects.push(o);
      scene.add(o);
      if (r.tag) onTag?.(o, r.tag);
    }
  }
}
