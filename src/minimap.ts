import type { MapData } from './courses/types';

// A small round minimap, heading-up: the map turns as you turn, the car
// arrow always points up. The whole course is painted once into an
// off-screen canvas; each frame just draws a rotated window of it.
// Tap it to open the full map (see fullmap.ts).

export const PX_PER_M = 1; // resolution of the pre-painted map

export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;
  private zoom = 0.42; // screen px per metre
  private size = 0;
  private dpr = Math.min(window.devicePixelRatio || 1, 2);

  constructor(parent: HTMLElement, private map: MapData, onTap: () => void) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'minimap';
    parent.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      onTap();
    });
    this.base = paintMap(map);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize() {
    this.size = Math.round(Math.min(150, Math.max(104, Math.min(window.innerWidth, window.innerHeight) * 0.36)));
    this.canvas.style.width = this.canvas.style.height = `${this.size}px`;
    this.canvas.width = this.canvas.height = Math.round(this.size * this.dpr);
  }

  /** heading: yaw in radians as used by the car (0 = facing +x / east). */
  draw(x: number, z: number, heading: number) {
    const { ctx, canvas, map } = this;
    const S = canvas.width;
    const r = S / 2;
    const k = this.zoom * this.dpr;
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, r - 2 * this.dpr, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = map.background;
    ctx.fillRect(0, 0, S, S);
    // Rotate so the car's forward direction points up the screen.
    // Car forward in map space is (cos h, -sin h) in (x, z); "up" is (0, -1).
    ctx.translate(r, r);
    ctx.rotate(-Math.PI / 2 + heading);
    ctx.scale(k, k);
    ctx.translate(-(x - map.bounds.minX) * PX_PER_M, -(z - map.bounds.minZ) * PX_PER_M);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.base, 0, 0);
    ctx.restore();

    // Landmark labels stay upright.
    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, r - 2 * this.dpr, 0, Math.PI * 2);
    ctx.clip();
    ctx.font = `600 ${Math.round(9.5 * this.dpr)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    const cos = Math.cos(-Math.PI / 2 + heading);
    const sin = Math.sin(-Math.PI / 2 + heading);
    for (const p of map.pois) {
      const dx = (p.x - x) * k;
      const dz = (p.z - z) * k;
      const sx = r + dx * cos - dz * sin;
      const sy = r + dx * sin + dz * cos;
      if (Math.hypot(sx - r, sy - r) > r - 8 * this.dpr) continue;
      if (p.label === 'P') {
        // Carparks: a small blue "P" badge instead of a text label.
        const b = 5.5 * this.dpr;
        ctx.fillStyle = '#2f6db5';
        ctx.fillRect(sx - b, sy - b, b * 2, b * 2);
        ctx.fillStyle = '#fff';
        ctx.fillText('P', sx, sy + 3.3 * this.dpr);
        continue;
      }
      ctx.fillStyle = '#1f2a2e';
      ctx.beginPath();
      ctx.arc(sx, sy, 2.6 * this.dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 3 * this.dpr;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.strokeText(p.label, sx, sy - 5 * this.dpr);
      ctx.fillText(p.label, sx, sy - 5 * this.dpr);
    }
    ctx.restore();

    // Car arrow and ring.
    ctx.fillStyle = '#c8772f';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5 * this.dpr;
    const a = 7 * this.dpr;
    ctx.beginPath();
    ctx.moveTo(r, r - a);
    ctx.lineTo(r + a * 0.7, r + a * 0.7);
    ctx.lineTo(r, r + a * 0.3);
    ctx.lineTo(r - a * 0.7, r + a * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(r, r, r - 2 * this.dpr, 0, Math.PI * 2);
    ctx.lineWidth = 3 * this.dpr;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();
  }
}

/** Paint a whole course map once, PX_PER_M canvas px per metre, for the minimap. */
export function paintMap(map: MapData): HTMLCanvasElement {
  const { bounds } = map;
  const c = document.createElement('canvas');
  c.width = Math.ceil((bounds.maxX - bounds.minX) * PX_PER_M);
  c.height = Math.ceil((bounds.maxZ - bounds.minZ) * PX_PER_M);
  const g = c.getContext('2d')!;
  g.scale(PX_PER_M, PX_PER_M);
  g.translate(-bounds.minX, -bounds.minZ);
  drawMapShapes(g, map, PX_PER_M);
  return c;
}

/**
 * Draw the map's areas and lines in world metres (x right, z down = north up).
 * The caller sets the transform; `scale` is screen px per metre, used to keep
 * thin lines visible when zoomed far out.
 */
export function drawMapShapes(g: CanvasRenderingContext2D, map: MapData, scale: number) {
  const { bounds, areas, lines } = map;
  g.fillStyle = map.background;
  g.fillRect(bounds.minX, bounds.minZ, bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  for (const a of areas) {
    g.fillStyle = a.color;
    g.beginPath();
    a.pts.forEach(([x, z], i) => (i ? g.lineTo(x, z) : g.moveTo(x, z)));
    g.closePath();
    g.fill();
  }
  g.lineCap = g.lineJoin = 'round';
  for (const l of lines) {
    // Dark casing under each line so roads read against grass.
    const w = Math.max(l.width, 2.2 / scale);
    for (const [lw, color] of [[w + Math.max(3, 2 / scale), 'rgba(0,0,0,0.25)'], [w, l.color]] as const) {
      g.strokeStyle = color;
      g.lineWidth = lw;
      g.beginPath();
      l.pts.forEach(([x, z], i) => (i ? g.lineTo(x, z) : g.moveTo(x, z)));
      if (l.closed) g.closePath();
      g.stroke();
    }
  }
}
