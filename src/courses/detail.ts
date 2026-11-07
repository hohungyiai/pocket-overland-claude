import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fbm, mulberry32, valueNoise } from '../noise';

// The "detailed" art style: everything here is generated at load time
// (canvas-painted textures, leaf-card foliage, displaced rocks), so the game
// still ships no image files. Courses opt in per element; the stylized look
// stays the default.

export type ArtStyle = 'stylized' | 'detailed';

const canvas = (w: number, h = w) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!] as const;
};

const toTexture = (c: HTMLCanvasElement, srgb: boolean, repeat = true) => {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
};

/** Tileable value noise sampled on a torus so the texture wraps cleanly. */
function tileNoise(u: number, v: number, period: number, seed: number) {
  // Bilinear blend of four offset samples hides the seam.
  const a = valueNoise(u * period, v * period, seed);
  const b = valueNoise((u - 1) * period, v * period, seed);
  const c = valueNoise(u * period, (v - 1) * period, seed);
  const d = valueNoise((u - 1) * period, (v - 1) * period, seed);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

/**
 * Ground detail, one material channel per ground type, used both to vary the
 * albedo and as a bump height. R = grass (short blades and clumps),
 * G = sand (wind ripples and grain), B = paving / hard ground (fine grain).
 */
export function groundDetailTexture() {
  const S = 512;
  const [c, g] = canvas(S);
  const img = g.createImageData(S, S);
  const rand = mulberry32(91);
  const grass = new Float32Array(S * S).fill(0.55);
  // Grass: lots of short strokes, darker at the root, lighter at the tip.
  for (let i = 0; i < 26000; i++) {
    const x0 = rand() * S;
    const y0 = rand() * S;
    const len = 3 + rand() * 7;
    const ang = -Math.PI / 2 + (rand() - 0.5) * 1.2;
    const shade = 0.25 + rand() * 0.75;
    for (let t = 0; t < len; t++) {
      const x = Math.floor(x0 + Math.cos(ang) * t + S) % S;
      const y = Math.floor(y0 + Math.sin(ang) * t + S) % S;
      grass[y * S + x] = shade * (0.6 + 0.4 * (t / len));
    }
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const k = (y * S + x) * 4;
      const clump = tileNoise(u, v, 8, 5);
      img.data[k] = Math.round(255 * Math.min(1, grass[y * S + x] * 0.75 + clump * 0.3));
      // Sand: ripples bent by low noise, plus grain.
      const warp = tileNoise(u, v, 3, 7) * 2.5;
      const ripple = 0.5 + 0.5 * Math.sin((v * 14 + warp) * Math.PI * 2);
      const grain = rand();
      img.data[k + 1] = Math.round(255 * (0.25 + ripple * 0.45 + grain * 0.3));
      // Hard ground: speckle and soft blotches.
      img.data[k + 2] = Math.round(255 * (0.35 + tileNoise(u, v, 16, 9) * 0.35 + rand() * 0.3));
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return toTexture(c, false);
}

/** Asphalt: aggregate grain, a few patches and hairline cracks. Grey, used as a multiplier. */
export function asphaltTexture() {
  const S = 512;
  const [c, g] = canvas(S);
  const img = g.createImageData(S, S);
  const rand = mulberry32(17);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const k = (y * S + x) * 4;
      const blot = tileNoise(u, v, 6, 3);
      const n = 0.62 + blot * 0.2 + (rand() - 0.5) * 0.28;
      const c8 = Math.round(255 * Math.max(0, Math.min(1, n)));
      img.data[k] = img.data[k + 1] = img.data[k + 2] = c8;
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // Repair patches and cracks.
  for (let i = 0; i < 3; i++) {
    g.fillStyle = `rgba(40,40,42,${0.12 + rand() * 0.1})`;
    g.fillRect(rand() * S, rand() * S, 40 + rand() * 90, 30 + rand() * 60);
  }
  g.strokeStyle = 'rgba(25,25,25,0.45)';
  g.lineWidth = 1.2;
  for (let i = 0; i < 6; i++) {
    let x = rand() * S;
    let y = rand() * S;
    g.beginPath();
    g.moveTo(x, y);
    for (let s = 0; s < 14; s++) {
      x += (rand() - 0.5) * 22;
      y += 4 + rand() * 10;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  return toTexture(c, false);
}

/** Rubber running track: fine speckle. */
export function tartanTexture() {
  const S = 256;
  const [c, g] = canvas(S);
  const img = g.createImageData(S, S);
  const rand = mulberry32(23);
  for (let i = 0; i < S * S; i++) {
    const n = 0.72 + (rand() - 0.5) * 0.34;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = Math.round(255 * n);
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return toTexture(c, false);
}

/** Water normal map from a few drifting wave directions (tileable). */
export function waterNormalTexture() {
  const S = 256;
  const [c, g] = canvas(S);
  const img = g.createImageData(S, S);
  const waves = [
    [1, 0, 3, 0.3], [0, 1, 4, 0.2], [1, 1, 5, 0.6], [2, -1, 7, 1.1], [-1, 3, 9, 2.0], [3, 2, 11, 0.4], [5, -3, 13, 2.7],
  ];
  const h = (x: number, y: number) => {
    let s = 0;
    for (const [a, b, amp, ph] of waves) s += Math.sin(((a * x + b * y) / S) * Math.PI * 2 + ph) / amp;
    return s + fbm(x / 22, y / 22, 4, 3) * 0.05;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = h(x + 1, y) - h(x - 1, y);
      const dy = h(x, y + 1) - h(x, y - 1);
      const n = new THREE.Vector3(-dx * 6, -dy * 6, 1).normalize();
      const k = (y * S + x) * 4;
      img.data[k] = Math.round((n.x * 0.5 + 0.5) * 255);
      img.data[k + 1] = Math.round((n.y * 0.5 + 0.5) * 255);
      img.data[k + 2] = Math.round((n.z * 0.5 + 0.5) * 255);
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return toTexture(c, false);
}

// ---------- Foliage atlas ----------
// One 1024 texture, four regions (uv space):
//   broadleaf cluster  u 0-0.5,  v 0.5-1
//   palm frond         u 0.5-1,  v 0.5-1  (rib runs along u)
//   needle cluster     u 0-0.5,  v 0-0.5
//   grass tuft         u 0.5-1,  v 0-0.5  (blades rise from v = 0)
// plus a solid white block for trunks and branches at SOLID_UV.
export const ATLAS = {
  leaf: [0, 0.5, 0.5, 1],
  frond: [0.5, 0.5, 1, 1],
  needle: [0, 0, 0.5, 0.5],
  grass: [0.5, 0, 1, 0.5],
} as const;
type Region = readonly [number, number, number, number];
const SOLID_UV: [number, number] = [0.485, 0.485];

export function foliageAtlas() {
  const S = 1024;
  const [c, g] = canvas(S);
  const rand = mulberry32(7);
  const H = S / 2;
  // Canvas y runs down; uv v runs up. Region origin (top-left) in canvas px:
  const origin = (r: Region): [number, number] => [r[0] * S, (1 - r[3]) * S];

  // Broadleaf cluster: overlapping oval leaves, lighter on top.
  {
    const [ox, oy] = origin(ATLAS.leaf);
    // A shaded core so the middle of each cluster is solid (canopy cores sample it).
    const core = g.createRadialGradient(ox + H / 2, oy + H / 2, 0, ox + H / 2, oy + H / 2, H * 0.3);
    core.addColorStop(0, 'hsl(110, 30%, 34%)');
    core.addColorStop(1, 'hsl(110, 30%, 28%)');
    g.fillStyle = core;
    g.beginPath();
    g.arc(ox + H / 2, oy + H / 2, H * 0.3, 0, Math.PI * 2);
    g.fill();
    for (let i = 0; i < 420; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * H * 0.46;
      const x = ox + H / 2 + Math.cos(a) * r;
      const y = oy + H / 2 + Math.sin(a) * r;
      const l = 38 + rand() * 40 - (y - oy) / H * 18;
      g.fillStyle = `hsl(${95 + rand() * 30}, ${25 + rand() * 20}%, ${l}%)`;
      g.save();
      g.translate(x, y);
      g.rotate(rand() * Math.PI * 2);
      g.beginPath();
      g.ellipse(0, 0, 9 + rand() * 7, 4 + rand() * 3, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }
  // Palm frond: a rib with leaflets that droop and taper toward the tip.
  {
    const [ox, oy] = origin(ATLAS.frond);
    const cy = oy + H / 2;
    g.strokeStyle = 'hsl(60, 30%, 55%)';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(ox + 4, cy);
    g.lineTo(ox + H - 6, cy);
    g.stroke();
    for (let x = 14; x < H - 8; x += 7) {
      const t = x / H;
      const len = (H * 0.46) * Math.sin(Math.min(1, t * 1.15) * Math.PI) * (0.85 + rand() * 0.15);
      for (const s of [-1, 1]) {
        g.strokeStyle = `hsl(${85 + rand() * 20}, ${35 + rand() * 15}%, ${42 + rand() * 22}%)`;
        g.lineWidth = 3.2;
        g.beginPath();
        g.moveTo(ox + x, cy);
        g.quadraticCurveTo(ox + x + len * 0.25, cy + s * len * 0.6, ox + x + len * 0.45, cy + s * len);
        g.stroke();
      }
    }
  }
  // Needle cluster (casuarina): fine drooping strands.
  {
    const [ox, oy] = origin(ATLAS.needle);
    for (let i = 0; i < 900; i++) {
      const x = ox + H * 0.12 + rand() * H * 0.76;
      const y = oy + H * 0.08 + rand() * H * 0.3;
      const len = 30 + rand() * H * 0.45;
      g.strokeStyle = `hsl(${100 + rand() * 25}, ${20 + rand() * 20}%, ${30 + rand() * 25}%)`;
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + (rand() - 0.5) * 30, y + len * 0.5, x + (rand() - 0.5) * 40, Math.min(oy + H - 4, y + len));
      g.stroke();
    }
  }
  // Grass tuft: blades from the bottom edge.
  {
    const [ox, oy] = origin(ATLAS.grass);
    for (let i = 0; i < 140; i++) {
      const x = ox + H * 0.1 + rand() * H * 0.8;
      const base = oy + H - 1;
      const hgt = H * (0.35 + rand() * 0.6);
      const lean = (rand() - 0.5) * H * 0.35;
      g.fillStyle = `hsl(${78 + rand() * 25}, ${30 + rand() * 20}%, ${46 + rand() * 26}%)`;
      g.beginPath();
      g.moveTo(x - 4, base);
      g.quadraticCurveTo(x + lean * 0.3, base - hgt * 0.6, x + lean, base - hgt);
      g.quadraticCurveTo(x + lean * 0.3 + 2, base - hgt * 0.6, x + 4, base);
      g.fill();
    }
  }
  // Solid block for trunks.
  g.fillStyle = '#ffffff';
  g.fillRect(SOLID_UV[0] * S - 16, (1 - SOLID_UV[1]) * S - 16, 32, 32);
  const t = toTexture(c, true, false);
  t.anisotropy = 8;
  return t;
}

// ---------- Geometry helpers (all parts carry position, normal, uv, color) ----------

const paint = (g: THREE.BufferGeometry, hex: number) => {
  const col = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.toArray(arr, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
};

const solidUv = (g: THREE.BufferGeometry) => {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, SOLID_UV[0], SOLID_UV[1]);
  return g;
};

/** A smooth trunk or branch from a to b. */
function limb(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, color: number) {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, 8, 3);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  return solidUv(paint(g, color)).toNonIndexed();
}

/**
 * A leaf card: a quad with its normals bent outward from the canopy centre,
 * so a cloud of cards shades like one soft volume instead of flat planes.
 */
function card(
  centre: THREE.Vector3,
  size: number,
  region: Region,
  canopy: THREE.Vector3,
  rand: () => number,
  upright = false,
) {
  const g = new THREE.PlaneGeometry(size, size);
  if (upright) g.rotateY(rand() * Math.PI);
  else g.rotateX(-Math.PI / 2 + (rand() - 0.5) * 1.6).rotateY(rand() * Math.PI * 2);
  g.translate(centre.x, centre.y, centre.z);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, region[0] + uv.getX(i) * (region[2] - region[0]), region[1] + uv.getY(i) * (region[3] - region[1]));
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nrm = g.attributes.normal as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).sub(canopy).normalize();
    v.y = v.y * 0.6 + 0.4;
    v.normalize();
    nrm.setXYZ(i, v.x, v.y, v.z);
  }
  return cutout(paint(g, 0xffffff).toNonIndexed());
}

const join = (parts: THREE.BufferGeometry[]) => mergeGeometries(parts)!;
const cutout = (g: THREE.BufferGeometry) => ((g.userData.cutout = true), g);

/**
 * Merge a plant into two draw groups: group 0 = opaque parts (trunks, canopy
 * cores), group 1 = alpha-cut leaf cards. Use with a [solid, cutout]
 * material pair so only the cards pay for alpha testing.
 */
function plant(parts: THREE.BufferGeometry[]) {
  const solid = parts.filter((p) => !p.userData.cutout);
  const cards = parts.filter((p) => p.userData.cutout);
  return mergeGeometries([join(solid), join(cards)], true)!;
}

/** Random point inside an ellipsoid, biased to the outer shell. */
function inEllipsoid(rand: () => number, rx: number, ry: number, rz: number) {
  const a = rand() * Math.PI * 2;
  const b = Math.acos(2 * rand() - 1);
  const r = 0.55 + 0.45 * Math.cbrt(rand());
  return new THREE.Vector3(Math.sin(b) * Math.cos(a) * rx * r, Math.cos(b) * ry * r, Math.sin(b) * Math.sin(a) * rz * r);
}

const BARK = 0x5e4a3a;

/**
 * Opaque inner volume of a canopy, textured from the solid middle of the
 * leaf cluster. Gaps between leaf cards then show foliage, not sky, so far
 * fewer (costly, alpha-cut) cards are needed.
 */
function canopyCore(centre: THREE.Vector3, rx: number, ry: number, rz: number, seed: number) {
  const g = new THREE.IcosahedronGeometry(1, 2);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const k = 1 + fbm(v.x * 1.7 + seed, v.z * 1.7 + v.y, seed, 3) * 0.35;
    pos.setXYZ(i, v.x * rx * k, v.y * ry * k, v.z * rz * k);
    // Inner 30% of the leaf region: solid shaded leaves.
    uv.setXY(i, 0.25 + v.x * 0.06, 0.75 + v.z * 0.06);
  }
  g.computeVertexNormals();
  g.translate(centre.x, centre.y, centre.z);
  return paint(g, 0xb8c8b0).toNonIndexed();
}

/** Rain tree: short trunk, spreading branches, wide umbrella canopy. */
export function rainTreeGeo(seed: number) {
  const rand = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const base = new THREE.Vector3(0, 0, 0);
  const fork = new THREE.Vector3(0, 3.2, 0);
  parts.push(limb(base, fork, 0.5, 0.36, BARK));
  const tips: THREE.Vector3[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + rand() * 0.5;
    const tip = new THREE.Vector3(Math.cos(a) * (2.6 + rand()), 5.4 + rand() * 0.8, Math.sin(a) * (2.6 + rand()));
    parts.push(limb(fork, tip, 0.3, 0.12, BARK));
    tips.push(tip);
  }
  const canopy = new THREE.Vector3(0, 6.3, 0);
  parts.push(canopyCore(canopy, 4.4, 1.2, 4.4, seed));
  for (let i = 0; i < 34; i++) {
    const p = inEllipsoid(rand, 5, 1.5, 5).add(canopy);
    parts.push(card(p, 2.8 + rand() * 0.8, ATLAS.leaf, canopy, rand));
  }
  return plant(parts);
}

/** Sea almond: tiered, pagoda-like layers of leaves. */
export function almondGeo(seed: number) {
  const rand = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [limb(new THREE.Vector3(), new THREE.Vector3(0, 7, 0), 0.34, 0.14, BARK)];
  const centre = new THREE.Vector3(0, 5.2, 0);
  [[4.2, 0, 3.9], [3, 0, 5.2], [1.8, 0, 6.4]].forEach(([r, , y]) => {
    parts.push(canopyCore(new THREE.Vector3(0, y, 0), r * 0.85, 0.35, r * 0.85, seed + y));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + rand();
      parts.push(limb(new THREE.Vector3(0, y - 0.4, 0), new THREE.Vector3(Math.cos(a) * r * 0.8, y, Math.sin(a) * r * 0.8), 0.1, 0.05, BARK));
    }
    for (let i = 0; i < Math.round(r * 4); i++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * r;
      const p = new THREE.Vector3(Math.cos(a) * d, y + (rand() - 0.5) * 0.5, Math.sin(a) * d);
      parts.push(card(p, 2.1, ATLAS.leaf, centre, rand));
    }
  });
  return plant(parts);
}

/** Coconut palm: a curved, ringed trunk and arching fronds. */
export function palmGeo(seed: number) {
  const rand = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const lean = 0.6 + rand() * 0.8;
  const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(lean * 0.2, 4.5, 0), new THREE.Vector3(lean, 8.2, 0));
  const trunk = new THREE.TubeGeometry(curve, 14, 0.22, 8, false);
  // Taper and ring the trunk via colour bands.
  const pos = trunk.attributes.position as THREE.BufferAttribute;
  const cols = new Float32Array(pos.count * 3);
  const c1 = new THREE.Color(0x8a7356);
  const c2 = new THREE.Color(0x6f5a43);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    (Math.floor(y * 3) % 2 ? c1 : c2).toArray(cols, i * 3);
    const t = y / 8.2;
    const centre = curve.getPoint(Math.min(1, Math.max(0, t)));
    const s = 1.3 - t * 0.45;
    pos.setX(i, centre.x + (pos.getX(i) - centre.x) * s);
    pos.setZ(i, centre.z + (pos.getZ(i) - centre.z) * s);
  }
  trunk.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  trunk.computeVertexNormals();
  parts.push(solidUv(trunk).toNonIndexed());
  const top = curve.getPoint(1);
  // Fronds: bent strips mapped to the frond region of the atlas.
  const n = 11;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand() * 0.3;
    const len = 4.2 + rand() * 0.8;
    const lift = 0.5 + rand() * 0.5;
    const seg = 6;
    const g = new THREE.PlaneGeometry(len, 1.6, seg, 1);
    g.translate(len / 2, 0, 0);
    g.rotateX(-Math.PI / 2 + (rand() - 0.5) * 0.4);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k);
      const t = x / len;
      p.setY(k, p.getY(k) + lift * Math.sin(t * Math.PI * 0.6) * 2 - t * t * 2.6);
    }
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, ATLAS.frond[0] + uv.getX(k) * 0.5, ATLAS.frond[1] + uv.getY(k) * 0.5);
    g.rotateY(a);
    g.translate(top.x, top.y, top.z);
    g.computeVertexNormals();
    // Fronds read better lit from above than with their true normals.
    const nr = g.attributes.normal as THREE.BufferAttribute;
    for (let k = 0; k < nr.count; k++) nr.setXYZ(k, nr.getX(k) * 0.4, 0.9, nr.getZ(k) * 0.4);
    parts.push(cutout(paint(g, 0xffffff).toNonIndexed()));
  }
  const nuts = new THREE.IcosahedronGeometry(0.5, 1).translate(top.x, top.y - 0.3, top.z);
  parts.push(solidUv(paint(nuts, 0x6b5a2e)).toNonIndexed());
  return plant(parts);
}

/** Casuarina: slim trunk, a tall loose cone of drooping needle clusters. */
export function casuarinaGeo(seed: number) {
  const rand = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [limb(new THREE.Vector3(), new THREE.Vector3(0, 10.5, 0), 0.3, 0.06, BARK)];
  const centre = new THREE.Vector3(0, 6.5, 0);
  const cone = new THREE.ConeGeometry(1.6, 7.5, 9, 3).translate(0, 6.8, 0);
  const cuv = cone.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < cuv.count; i++) cuv.setXY(i, 0.25 + (cuv.getX(i) - 0.5) * 0.1, 0.75 + (cuv.getY(i) - 0.5) * 0.1);
  parts.push(paint(cone, 0x9fb09a).toNonIndexed());
  for (let i = 0; i < 30; i++) {
    const y = 2.8 + rand() * 8;
    const r = (1 - (y - 2.8) / 8.5) * 2.2 + 0.3;
    const a = rand() * Math.PI * 2;
    const p = new THREE.Vector3(Math.cos(a) * r * Math.sqrt(rand()), y, Math.sin(a) * r * Math.sqrt(rand()));
    parts.push(card(p, 2.2, ATLAS.needle, centre, rand, true));
  }
  return plant(parts);
}

/** Shrub: a low mound of leaf cards (also used, tinted, for flowering bushes). */
export function shrubGeo(seed: number) {
  const rand = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const centre = new THREE.Vector3(0, 0.2, 0);
  parts.push(canopyCore(new THREE.Vector3(0, 0.55, 0), 0.8, 0.55, 0.8, seed));
  for (let i = 0; i < 9; i++) {
    const p = inEllipsoid(rand, 1, 0.75, 1).add(new THREE.Vector3(0, 0.6, 0));
    parts.push(card(p, 1.1, ATLAS.leaf, centre, rand));
  }
  return plant(parts);
}

/** Grass tuft: three crossed upright cards. */
export function grassTuftGeo() {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const g = new THREE.PlaneGeometry(0.9, 0.55);
    g.translate(0, 0.27, 0);
    g.rotateY((i / 3) * Math.PI);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, ATLAS.grass[0] + uv.getX(k) * 0.5, ATLAS.grass[1] + uv.getY(k) * 0.5);
    const nr = g.attributes.normal as THREE.BufferAttribute;
    for (let k = 0; k < nr.count; k++) nr.setXYZ(k, 0, 1, 0);
    parts.push(paint(g, 0xffffff).toNonIndexed());
  }
  return join(parts);
}

/** A rounded, lumpy boulder with darker crevices baked into vertex colour. */
export function boulderGeo(seed: number) {
  const g = new THREE.IcosahedronGeometry(1, 3);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const cols = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  const base = new THREE.Color(0x8b857c);
  const dark = new THREE.Color(0x4f4a44);
  const moss = new THREE.Color(0x6f7a52);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = fbm(v.x * 1.3 + seed, v.y * 1.3 + v.z * 0.7, 31 + seed, 4);
    const r = 1 + n * 0.28;
    pos.setXYZ(i, v.x * r * 1.1, v.y * r * 0.8, v.z * r);
    c.copy(base).lerp(dark, Math.max(0, -n) * 1.6);
    if (v.y > 0.4) c.lerp(moss, (v.y - 0.4) * 0.5);
    c.toArray(cols, i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * Patch a ground material so its detail texture and bump follow the ground
 * type, worked out from the vertex colour (green = grass, sandy = sand,
 * grey = paving). The geometry needs uvs in world metres / scale.
 */
export function patchGroundMaterial(m: THREE.MeshStandardMaterial) {
  const weights = /* glsl */ `
    vec3 groundWeights() {
      vec3 c = vColor.rgb;
      float grass = smoothstep(0.03, 0.12, c.g - c.r);
      float sand = smoothstep(0.1, 0.2, c.r - c.b) * (1.0 - grass);
      return vec3(grass, sand, max(0.0, 1.0 - grass - sand));
    }
    float groundH(vec2 uv) {
      return dot(texture2D(map, uv).rgb, groundWeights()) + 0.5 * dot(texture2D(map, uv * 0.21 + 0.37).rgb, groundWeights());
    }`;
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <bumpmap_pars_fragment>',
        weights + '\n' + THREE.ShaderChunk.bumpmap_pars_fragment.replace(/texture2D\( bumpMap, ([^)]*)\)\.x/g, 'groundH($1)'),
      )
      .replace(
        '#include <map_fragment>',
        `{
          vec3 w = groundWeights();
          float d = dot(texture2D(map, vMapUv).rgb, w);
          float big = dot(texture2D(map, vMapUv * 0.21 + 0.37).rgb, w);
          diffuseColor.rgb *= 0.55 + 0.5 * d + 0.22 * big;
        }`,
      );
  };
}

/** Scroll two layers of a water normal map so the surface glints and drifts. */
export function patchWaterMaterial(m: THREE.MeshStandardMaterial, time: { value: number }) {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.uniforms.uTime = time;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
        `vec3 mapN = normalize(
            (texture2D( normalMap, vNormalMapUv + vec2(uTime * 0.011, uTime * 0.006) ).xyz * 2.0 - 1.0) +
            (texture2D( normalMap, vNormalMapUv * 0.43 + vec2(-uTime * 0.004, uTime * 0.009) ).xyz * 2.0 - 1.0));`,
      );
  };
}

/**
 * Equirectangular sky with a warm horizon, soft sun glow and a band of
 * cumulus; used as the background and (prefiltered) as the reflection
 * environment, so water and car paint pick up the sky.
 */
export function skyTexture(sunDir: THREE.Vector3) {
  const W = 1024;
  const H = 512;
  const [c, g] = canvas(W, H);
  const grad = g.createLinearGradient(0, 0, 0, H / 2);
  grad.addColorStop(0, '#5d93c7');
  grad.addColorStop(0.6, '#93badb');
  grad.addColorStop(1, '#cfdde4');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H / 2);
  const low = g.createLinearGradient(0, H / 2, 0, H);
  low.addColorStop(0, '#d9e2df');
  low.addColorStop(1, '#8fa3a8');
  g.fillStyle = low;
  g.fillRect(0, H / 2, W, H / 2);
  // Sun position on the equirect.
  const lon = Math.atan2(sunDir.z, sunDir.x);
  const lat = Math.asin(sunDir.y);
  const sx = ((lon / (Math.PI * 2)) + 0.5) * W;
  const sy = (0.5 - lat / Math.PI) * H;
  const glow = g.createRadialGradient(sx, sy, 0, sx, sy, 140);
  glow.addColorStop(0, 'rgba(255,250,230,1)');
  glow.addColorStop(0.08, 'rgba(255,244,214,0.9)');
  glow.addColorStop(1, 'rgba(255,240,210,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);
  // Clouds: clusters of soft puffs sitting just above the horizon.
  const rand = mulberry32(5);
  for (let i = 0; i < 38; i++) {
    const cx = rand() * W;
    const cy = H / 2 - 18 - rand() * 90;
    const size = 18 + rand() * 30;
    for (let k = 0; k < 9; k++) {
      const px = cx + (rand() - 0.5) * size * 3;
      const py = cy + (rand() - 0.7) * size * 0.8;
      const r = size * (0.5 + rand() * 0.6);
      const puff = g.createRadialGradient(px, py, 0, px, py, r);
      puff.addColorStop(0, 'rgba(255,255,255,0.75)');
      puff.addColorStop(0.6, 'rgba(250,250,252,0.35)');
      puff.addColorStop(1, 'rgba(240,244,248,0)');
      g.fillStyle = puff;
      for (const dx of [-W, 0, W]) {
        g.beginPath();
        g.arc(px + dx, py, r, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Richer facade for the HDB blocks: window frames, ledges, AC units, laundry poles. Also a bump map. */
export function facadeTexture() {
  const S = 256;
  const [c, g] = canvas(S);
  const rand = mulberry32(13);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, S, S);
  const floorH = S / 4;
  for (let f = 0; f < 4; f++) {
    const y = f * floorH;
    // Ledge / corridor slab line.
    g.fillStyle = '#cfcfcf';
    g.fillRect(0, y + floorH - 8, S, 8);
    g.fillStyle = '#e9e9e9';
    g.fillRect(0, y + floorH - 10, S, 2);
    for (const x0 of [12, 140]) {
      // Window with frame and mullions.
      g.fillStyle = '#5f6e78';
      g.fillRect(x0, y + 14, 100, 30);
      g.fillStyle = rand() < 0.3 ? '#93a4ae' : '#7a8b95';
      g.fillRect(x0 + 3, y + 17, 94, 24);
      g.fillStyle = '#e8e8e8';
      for (let m = 1; m < 4; m++) g.fillRect(x0 + m * 25, y + 14, 3, 30);
      // AC unit and laundry pole on some bays.
      if (rand() < 0.5) {
        g.fillStyle = '#d4d4d4';
        g.fillRect(x0 + 104, y + 30, 16, 12);
      }
      if (rand() < 0.4) {
        g.fillStyle = '#8a8a8a';
        g.fillRect(x0 + 10, y + 44, 80, 2);
        for (let k = 0; k < 4; k++) {
          g.fillStyle = ['#c0504d', '#4f81bd', '#f4f4f4', '#9bbb59'][Math.floor(rand() * 4)];
          g.fillRect(x0 + 14 + k * 18 + rand() * 6, y + 46, 9, 10);
        }
      }
    }
  }
  const t = toTexture(c, true);
  t.anisotropy = 8;
  return t;
}
