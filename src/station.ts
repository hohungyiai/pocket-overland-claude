import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Station } from './fuel';

// Petrol stations as places: a paved forecourt at the height of the lane
// that leads onto it (with its own kerb where it meets the ground), a
// canopy on posts over a pump island, and a sign with the brand by the way
// in. The forecourt's outline comes from the map (tools/osm/import.mjs);
// the lane in is a road like any other.

type R = typeof RAPIER_NS;

/** How far a road's surface lies above the ground beside it (osmcity: UNDER + ROAD_LIFT), less 1 cm so the lane draws over the forecourt where they meet. */
const TOP = 0.2;
const CANOPY_H = 5.2;

const BRANDS: Record<string, { bg: string; fg: string; band?: string }> = {
  Shell: { bg: '#f7d117', fg: '#d8262b' },
  Esso: { bg: '#ffffff', fg: '#d8262b', band: '#1d3f8f' },
  SPC: { bg: '#d8262b', fg: '#ffffff' },
  Sinopec: { bg: '#ffffff', fg: '#e0601b' },
  Caltex: { bg: '#d8262b', fg: '#ffffff' },
};
const brandOf = (name: string) => BRANDS[name] ?? { bg: '#23353b', fg: '#ffffff' };

export const inRing = (x: number, z: number, P: [number, number][]) => {
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [ax, az] = P[i];
    const [bx, bz] = P[j];
    if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) c = !c;
  }
  return c;
};

/** Clip a polygon by one convex cell (Sutherland-Hodgman). */
function clipTo(poly: [number, number][], cell: [number, number][]) {
  let out = poly;
  // (Which side is inside depends on which way round the cell runs.)
  let area = 0;
  for (let i = 0; i < cell.length; i++) {
    const [ax, az] = cell[i];
    const [bx, bz] = cell[(i + 1) % cell.length];
    area += ax * bz - bx * az;
  }
  const inward = Math.sign(area) || 1;
  for (let i = 0; i < cell.length && out.length; i++) {
    const [ax, az] = cell[i];
    const [bx, bz] = cell[(i + 1) % cell.length];
    const side = (p: [number, number]) => inward * ((bx - ax) * (p[1] - az) - (bz - az) * (p[0] - ax));
    const inp = out;
    out = [];
    for (let k = 0; k < inp.length; k++) {
      const p = inp[k];
      const q = inp[(k + 1) % inp.length];
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) out.push(p);
      if (sp >= 0 !== sq >= 0) {
        const t = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return out;
}

function textPanel(lines: { text: string; font: string; y: number }[], w: number, h: number, bg: string, fg: string, band?: string) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d')!;
  x.fillStyle = bg;
  x.fillRect(0, 0, w, h);
  if (band) {
    x.fillStyle = band;
    x.fillRect(0, h - h * 0.12, w, h * 0.12);
  }
  x.fillStyle = fg;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  for (const l of lines) {
    x.font = l.font;
    x.fillText(l.text, w / 2, l.y * h);
  }
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

export class Stations {
  private built = new Set<Station>();
  private waiting = new Set<Station>();
  private mats = {
    slab: new THREE.MeshStandardMaterial({ color: 0x8f918d, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
    kerb: new THREE.MeshStandardMaterial({ color: 0xb9b5ad, roughness: 0.9 }),
    white: new THREE.MeshStandardMaterial({ color: 0xf2f2ef, roughness: 0.7 }),
    post: new THREE.MeshStandardMaterial({ color: 0xd9d9d4, roughness: 0.6 }),
    island: new THREE.MeshStandardMaterial({ color: 0xc9c4ba, roughness: 0.9 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.6 }),
  };

  constructor(
    private scene: THREE.Scene,
    private world: RAPIER_NS.World,
    private R: R,
    readonly stations: Station[],
  ) {}

  /**
   * Build each station once the ground and lanes round it are ready.
   * ground(x, z) is the ground's height as the map gives it; ready(x, z)
   * says the ground (and the lanes) there are built; probe(x, z) is what a
   * ray down meets first there: its height, and whether it is the ground
   * itself (else a road or lane), or null; road(x, z) is the nearest point
   * on a proper road (for where the sign goes).
   */
  settle(
    ground: (x: number, z: number) => number,
    ready: (x: number, z: number) => boolean,
    probe: (x: number, z: number) => { y: number; ground: boolean } | null,
    road: (x: number, z: number) => { x: number; z: number } | null,
  ) {
    for (const s of this.stations) {
      if (this.built.has(s) || !s.pts?.length) continue;
      if (!ready(s.x, s.z) || !s.pts.every(([x, z]) => ready(x, z))) {
        this.waiting.delete(s);
        continue;
      }
      // (Ready since the last call: the physics has stepped since, and its
      // rays meet the ground and lanes just built.)
      if (!this.waiting.has(s)) {
        this.waiting.add(s);
        continue;
      }
      this.built.add(s);
      // The forecourt lies on the ground as built (not as the map first gave
      // it), as high over it as a lane is, and meets each lane flush: where a
      // lane runs it is at the lane's height (1 cm under, so the lane draws on
      // top), rising to it from 1.2 m out.
      const memo = new Map<string, number>();
      const top = (x: number, z: number) => {
        const key = `${x.toFixed(2)},${z.toFixed(2)}`;
        const known = memo.get(key);
        if (known !== undefined) return known;
        const h = ground(x, z);
        // Over the ground's highest point near by (so it never pokes through
        // between the forecourt's corners), and up to any lane near by.
        // (Where a lane runs, just under it: the lane is the way in.)
        const here = probe(x, z);
        if (here && !here.ground && Math.abs(here.y - h) < 0.6) {
          memo.set(key, here.y - 0.01);
          return here.y - 0.01;
        }
        let y = -Infinity;
        let lane = -Infinity;
        let low = -Infinity; // the ground's highest point, close
        for (const [dx, dz] of [[0, 0], [0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8], [1.4, 0], [-1.4, 0], [0, 1.4], [0, -1.4]]) {
          const p = dx === 0 && dz === 0 ? here : probe(x + dx, z + dz);
          if (!p || Math.abs(p.y - h) > 0.6) continue;
          if (p.ground) {
            y = Math.max(y, p.y + TOP);
            if (Math.abs(dx) + Math.abs(dz) < 1) low = Math.max(low, p.y);
          } else lane = Math.max(lane, p.y - 0.01);
        }
        if (y === -Infinity) y = h + TOP;
        // Beside a lane: level with it (so there's no lip where they meet),
        // as long as that keeps clear of the ground.
        if (lane > -Infinity && lane > low + 0.04 && lane > y - 0.4) y = lane;
        memo.set(key, y);
        return y;
      };
      this.build(s, ground, top, road(s.x, s.z));
    }
  }

  private body: RAPIER_NS.RigidBody | null = null;
  private collide(desc: RAPIER_NS.ColliderDesc) {
    this.body ??= this.world.createRigidBody(this.R.RigidBodyDesc.fixed());
    this.world.createCollider(desc, this.body);
  }

  private build(s: Station, ground: (x: number, z: number) => number, top: (x: number, z: number) => number, road: { x: number; z: number } | null) {
    const P = s.pts!;
    const g = new THREE.Group();

    // ---- Forecourt: cut into 1.5 m cells so it follows the ground ----
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of P) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    const C = 1.5;
    const pos: number[] = [];
    for (let cx = Math.floor(minX / C) * C; cx < maxX; cx += C)
      for (let cz = Math.floor(minZ / C) * C; cz < maxZ; cz += C) {
        const part = clipTo(P, [[cx, cz], [cx, cz + C], [cx + C, cz + C], [cx + C, cz]]);
        if (part.length < 3) continue;
        // (Ear-clipped: where the forecourt's outline turns in, a piece of it can be hollow.)
        const tris = THREE.ShapeUtils.triangulateShape(part.map(([x, z]) => new THREE.Vector2(x, z)), []);
        for (const t of tris)
          for (const k of t) {
            const [x, z] = part[k];
            pos.push(x, top(x, z), z);
          }
      }
    // (The clip may come out wound either way: make every triangle face up.)
    for (let i = 0; i < pos.length; i += 9) {
      const ux = pos[i + 3] - pos[i], uz = pos[i + 5] - pos[i + 2];
      const vx = pos[i + 6] - pos[i], vz = pos[i + 8] - pos[i + 2];
      if (uz * vx - ux * vz < 0) {
        for (let k = 0; k < 3; k++) [pos[i + 3 + k], pos[i + 6 + k]] = [pos[i + 6 + k], pos[i + 3 + k]];
      }
    }
    if (pos.length < 9) return;
    const slabGeo = new THREE.BufferGeometry();
    slabGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    slabGeo.computeVertexNormals();
    const slab = new THREE.Mesh(slabGeo, this.mats.slab);
    slab.receiveShadow = true;
    g.add(slab);
    this.collide(
      this.R.ColliderDesc.trimesh(new Float32Array(pos), new Uint32Array(pos.length / 3).map((_, i) => i)).setFriction(1),
    );

    // ---- Its kerb: the slab's edge, down to the ground ----
    const kp: number[] = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[i];
      const b = P[(i + 1) % P.length];
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 1.5));
      for (let k = 0; k < n; k++) {
        const t0 = k / n;
        const t1 = (k + 1) / n;
        const x0 = a[0] + (b[0] - a[0]) * t0, z0 = a[1] + (b[1] - a[1]) * t0;
        const x1 = a[0] + (b[0] - a[0]) * t1, z1 = a[1] + (b[1] - a[1]) * t1;
        const y0 = top(x0, z0), y1 = top(x1, z1);
        const f0 = Math.min(ground(x0, z0) - 0.15, y0 - 0.35), f1 = Math.min(ground(x1, z1) - 0.15, y1 - 0.35);
        kp.push(x0, y0, z0, x1, f1, z1, x1, y1, z1, x0, y0, z0, x0, f0, z0, x1, f1, z1);
      }
    }
    const kerbGeo = new THREE.BufferGeometry();
    kerbGeo.setAttribute('position', new THREE.Float32BufferAttribute(kp, 3));
    kerbGeo.computeVertexNormals();
    const kerbMat = this.mats.kerb.clone();
    kerbMat.side = THREE.DoubleSide;
    g.add(new THREE.Mesh(kerbGeo, kerbMat));

    // ---- Canopy and pump island, along the forecourt's long way ----
    const cx0 = P.reduce((t, p) => t + p[0], 0) / P.length;
    const cz0 = P.reduce((t, p) => t + p[1], 0) / P.length;
    let sxx = 0, szz = 0, sxz = 0;
    for (const [x, z] of P) {
      sxx += (x - cx0) ** 2;
      szz += (z - cz0) ** 2;
      sxz += (x - cx0) * (z - cz0);
    }
    const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    const ux = Math.cos(ang), uz = Math.sin(ang); // along
    const vx = -uz, vz = ux; // across
    let spanU = 0;
    for (const [x, z] of P) spanU = Math.max(spanU, Math.abs((x - cx0) * ux + (z - cz0) * uz));
    const shops = s.shops ?? [];
    const fits = (cx: number, cz: number, L: number, W: number) => {
      for (const su of [-1, -0.5, 0, 0.5, 1])
        for (const sv of [-1, 0, 1]) {
          const x = cx + ux * su * (L / 2 + 1.5) + vx * sv * (W / 2 + 1.5);
          const z = cz + uz * su * (L / 2 + 1.5) + vz * sv * (W / 2 + 1.5);
          if (!inRing(x, z, P)) return false;
          if (shops.some(([bx, bz, br]) => Math.hypot(x - bx, z - bz) < br * 0.8 + 1)) return false;
        }
      return true;
    };
    let canopy: { x: number; z: number; L: number; W: number } | null = null;
    for (let L = Math.min(20, Math.max(10, spanU)); L >= 6 && !canopy; L -= 2)
      for (const W of [9, 7]) {
        if (canopy) break;
        for (let r = 0; r <= 14 && !canopy; r += 2)
          for (let a = 0; a < (r ? 8 : 1); a++) {
            const x = cx0 + r * Math.cos((a * Math.PI) / 4);
            const z = cz0 + r * Math.sin((a * Math.PI) / 4);
            if (fits(x, z, L, W)) {
              canopy = { x, z, L, W };
              break;
            }
          }
      }
    canopy ??= { x: cx0, z: cz0, L: 8, W: 6 };
    s.canopy = canopy;
    const brand = brandOf(s.name);
    const base = top(canopy.x, canopy.z);
    const cg = new THREE.Group();
    cg.position.set(canopy.x, base, canopy.z);
    cg.rotation.y = -ang;
    // Roof: white underneath, the brand's colour round its edge.
    const roof = new THREE.Mesh(new THREE.BoxGeometry(canopy.L, 0.5, canopy.W), this.mats.white);
    roof.position.y = CANOPY_H + 0.25;
    roof.castShadow = true;
    const fasciaMat = new THREE.MeshStandardMaterial({ color: brand.bg === '#ffffff' ? brand.fg : brand.bg, roughness: 0.5 });
    for (const [w, d, x, z] of [
      [canopy.L + 0.2, 0.1, 0, canopy.W / 2],
      [canopy.L + 0.2, 0.1, 0, -canopy.W / 2],
      [0.1, canopy.W, canopy.L / 2, 0],
      [0.1, canopy.W, -canopy.L / 2, 0],
    ]) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(w, 0.75, d), fasciaMat);
      f.position.set(x, CANOPY_H + 0.4, z);
      cg.add(f);
    }
    cg.add(roof);
    // The pump island down the middle, posts at its ends, pumps on it.
    const islandL = Math.max(4, canopy.L - 4);
    const island = new THREE.Mesh(new THREE.BoxGeometry(islandL, 0.25, 1.3), this.mats.island);
    island.position.y = 0.12;
    cg.add(island);
    const pumpTex = textPanel([{ text: s.name === 'Petrol station' ? 'FUEL' : s.name.toUpperCase(), font: 'bold 56px system-ui, sans-serif', y: 0.5 }], 256, 128, brand.bg, brand.fg, brand.band);
    const pumpMat = new THREE.MeshStandardMaterial({ map: pumpTex, roughness: 0.6 });
    const nPumps = islandL >= 10 ? 3 : 2;
    for (let k = 0; k < nPumps; k++) {
      const along = (k - (nPumps - 1) / 2) * (islandL / nPumps);
      const pump = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.7, 0.6), [this.mats.dark, this.mats.dark, this.mats.white, this.mats.dark, pumpMat, pumpMat]);
      pump.position.set(along, 0.25 + 0.85, 0);
      pump.castShadow = true;
      cg.add(pump);
    }
    for (const end of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.45, CANOPY_H, 0.45), this.mats.post);
      post.position.set(end * (islandL / 2 - 0.4), CANOPY_H / 2, 0);
      cg.add(post);
    }
    g.add(cg);
    // (The island and its posts stop the car, as they would.)
    const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -ang);
    this.collide(
      this.R.ColliderDesc.cuboid(islandL / 2, 0.9, 0.65)
        .setTranslation(canopy.x, base + 0.9, canopy.z)
        .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w }),
    );

    // ---- Sign: a tall board by the way in, facing the road ----
    if (road) {
      // The forecourt's edge nearest the road, 1.5 m in.
      let best: [number, number] = P[0];
      let bd = Infinity;
      for (let i = 0; i < P.length; i++) {
        const a = P[i];
        const b = P[(i + 1) % P.length];
        for (let t = 0; t <= 1; t += 0.1) {
          const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
          const d = Math.hypot(x - road.x, z - road.z);
          if (d < bd) [best, bd] = [[x, z], d];
        }
      }
      // (Not where the lane comes in: along the edge to the side of the canopy's line.)
      const dx = cx0 - best[0], dz = cz0 - best[1];
      const dl = Math.hypot(dx, dz) || 1;
      const sx = best[0] + (dx / dl) * 1.5, sz = best[1] + (dz / dl) * 1.5;
      const sy = top(sx, sz);
      const signTex = textPanel(
        [
          { text: s.name === 'Petrol station' ? 'PETROL' : s.name.toUpperCase(), font: 'bold 120px system-ui, sans-serif', y: 0.32 },
          { text: '24 HRS', font: '600 64px system-ui, sans-serif', y: 0.72 },
        ],
        512,
        512,
        brand.bg,
        brand.fg,
        brand.band,
      );
      const board = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 0.35), [this.mats.dark, this.mats.dark, this.mats.dark, this.mats.dark, new THREE.MeshStandardMaterial({ map: signTex }), new THREE.MeshStandardMaterial({ map: signTex })]);
      board.position.set(sx, sy + 4.6, sz);
      // Faces along the road (both sides read), the way such signs stand.
      board.rotation.y = Math.atan2(road.x - sx, road.z - sz) + Math.PI / 2;
      board.castShadow = true;
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.4, 3.5, 0.4), this.mats.dark);
      pole.position.set(sx, sy + 1.75, sz);
      g.add(board, pole);
      this.collide(this.R.ColliderDesc.cuboid(0.2, 1.75, 0.2).setTranslation(sx, sy + 1.75, sz));
    }
    this.scene.add(g);
  }
}
