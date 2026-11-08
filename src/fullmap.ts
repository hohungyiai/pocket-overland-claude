import type { MapData } from './courses/types';
import { drawMapShapes, paintMap, pxPerM } from './minimap';

// Full-screen, north-up map. Opens from the minimap and pauses the drive
// while it is up. Drag to pan, pinch or scroll to zoom, tap "Back to the
// drive" to close. Kept separate from the minimap so it can grow into route
// planning later (a route layer and waypoints would draw in drawOverlay).

export class FullMap {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = Math.min(window.devicePixelRatio || 1, 2);
  private cx = 0; // world point at the screen centre
  private cz = 0;
  private scale = 1; // css px per metre
  private minScale = 0.1;
  private maxScale = 4;
  private car = { x: 0, z: 0, heading: 0 };
  private pointers = new Map<number, { x: number; y: number }>();
  private dirty = true;
  isOpen = false;

  constructor(parent: HTMLElement, private map: MapData, title: string, private onClose: () => void) {
    this.el = document.createElement('div');
    this.el.id = 'fullmap';
    this.el.innerHTML = `
      <canvas></canvas>
      <div class="fullmap-bar">
        <span class="fullmap-title">${title}</span>
        <button class="btn" data-act="center">Find me</button>
        <button class="btn" data-act="fit">Whole map</button>
        <button class="btn on" data-act="close">Back to the drive</button>
      </div>
      <div class="fullmap-north">N ↑</div>`;
    parent.append(this.el);
    this.canvas = this.el.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;

    this.el.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        if (act === 'close') this.close();
        else if (act === 'fit') this.fit();
        else this.centerOnCar();
      }),
    );

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    c.addEventListener('pointermove', (e) => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      const pts = [...this.pointers.values()];
      if (pts.length === 1) {
        this.cx -= (e.clientX - prev.x) / this.scale;
        this.cz -= (e.clientY - prev.y) / this.scale;
      } else if (pts.length === 2) {
        const other = pts.find((p) => p !== prev)!;
        const before = Math.hypot(prev.x - other.x, prev.y - other.y);
        const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        if (before > 0) this.zoomAt(after / before, (e.clientX + other.x) / 2, (e.clientY + other.y) / 2);
      }
      prev.x = e.clientX;
      prev.y = e.clientY;
      this.dirty = true;
    });
    const up = (e: PointerEvent) => this.pointers.delete(e.pointerId);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      if (this.isOpen && e.key === 'Escape') this.close();
    });
    window.addEventListener('resize', () => this.isOpen && this.resize());
  }

  open(x: number, z: number, heading: number) {
    this.car = { x, z, heading };
    this.isOpen = true;
    this.el.style.display = 'block';
    this.pointers.clear();
    this.resize();
    // Open framed on the car at a scale that shows the area around it.
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, 1));
    this.centerOnCar();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.style.display = 'none';
    this.onClose();
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    const b = this.map.bounds;
    // Smallest zoom shows the whole course with a margin.
    this.minScale = Math.min(w / (b.maxX - b.minX), h / (b.maxZ - b.minZ)) * 0.92;
    this.scale = Math.max(this.scale, this.minScale);
    this.dirty = true;
  }

  private fit() {
    const b = this.map.bounds;
    this.scale = this.minScale;
    this.cx = (b.minX + b.maxX) / 2;
    this.cz = (b.minZ + b.maxZ) / 2;
    this.dirty = true;
  }

  private centerOnCar() {
    this.cx = this.car.x;
    this.cz = this.car.z;
    this.clampView();
    this.dirty = true;
  }

  private zoomAt(f: number, sx: number, sy: number) {
    const next = Math.min(this.maxScale, Math.max(this.minScale, this.scale * f));
    // Keep the world point under the fingers fixed.
    const w = window.innerWidth / 2;
    const h = window.innerHeight / 2;
    const wx = this.cx + (sx - w) / this.scale;
    const wz = this.cz + (sy - h) / this.scale;
    this.scale = next;
    this.cx = wx - (sx - w) / next;
    this.cz = wz - (sy - h) / next;
    this.dirty = true;
  }

  private clampView() {
    const b = this.map.bounds;
    const hw = window.innerWidth / 2 / this.scale;
    const hh = window.innerHeight / 2 / this.scale;
    const clampAxis = (v: number, lo: number, hi: number, half: number) =>
      hi - lo <= half * 2 ? (lo + hi) / 2 : Math.min(hi - half, Math.max(lo + half, v));
    this.cx = clampAxis(this.cx, b.minX, b.maxX, hw);
    this.cz = clampAxis(this.cz, b.minZ, b.maxZ, hh);
  }

  /** Called every frame; only repaints after a pan or zoom. */
  draw() {
    if (!this.isOpen || !this.dirty) return;
    this.dirty = false;
    this.clampView();
    const { ctx, canvas, map, dpr } = this;
    const k = this.scale * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#9fc3d6';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(k, 0, 0, k, canvas.width / 2 - this.cx * k, canvas.height / 2 - this.cz * k);
    if (this.scale <= pxPerM(map) * 1.25) {
      // Zoomed out: the pre-painted map is sharp enough and far quicker.
      ctx.translate(map.bounds.minX, map.bounds.minZ);
      ctx.scale(1 / pxPerM(map), 1 / pxPerM(map));
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(paintMap(map), 0, 0);
    } else drawMapShapes(ctx, map, this.scale);
    this.drawOverlay();
  }

  private toScreen(x: number, z: number): [number, number] {
    const { canvas, dpr } = this;
    const k = this.scale * dpr;
    return [canvas.width / 2 + (x - this.cx) * k, canvas.height / 2 + (z - this.cz) * k];
  }

  private drawOverlay() {
    const { ctx, dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.map.attribution) {
      ctx.font = `${Math.round(10 * dpr)}px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      const w = ctx.measureText(this.map.attribution).width;
      ctx.fillRect(0, this.canvas.height - 16 * dpr, w + 12 * dpr, 16 * dpr);
      ctx.fillStyle = '#333';
      ctx.fillText(this.map.attribution, 6 * dpr, this.canvas.height - 4.5 * dpr);
    }
    ctx.textAlign = 'center';
    ctx.font = `600 ${Math.round(12 * dpr)}px system-ui, sans-serif`;
    for (const p of this.map.pois) {
      const [sx, sy] = this.toScreen(p.x, p.z);
      if (p.label === 'P') {
        const b = 7 * dpr;
        ctx.fillStyle = '#2f6db5';
        ctx.fillRect(sx - b, sy - b, b * 2, b * 2);
        ctx.fillStyle = '#fff';
        ctx.fillText('P', sx, sy + 4.2 * dpr);
        continue;
      }
      ctx.fillStyle = '#1f2a2e';
      ctx.beginPath();
      ctx.arc(sx, sy, 3.5 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 3.5 * dpr;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText(p.label, sx, sy - 7 * dpr);
      ctx.fillText(p.label, sx, sy - 7 * dpr);
    }

    // The car: an arrow pointing the way it faces, with a soft halo.
    const [sx, sy] = this.toScreen(this.car.x, this.car.z);
    ctx.fillStyle = 'rgba(200,119,47,0.25)';
    ctx.beginPath();
    ctx.arc(sx, sy, 18 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.translate(sx, sy);
    // Car forward is (cos h, -sin h) in (x, z); the arrow is drawn pointing -y.
    ctx.rotate(Math.PI / 2 - this.car.heading);
    const a = 10 * dpr;
    ctx.fillStyle = '#c8772f';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, -a);
    ctx.lineTo(a * 0.7, a * 0.7);
    ctx.lineTo(0, a * 0.3);
    ctx.lineTo(-a * 0.7, a * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
