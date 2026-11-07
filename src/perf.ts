// Tap the fps label to open a frame-timing graph. Each bar is one frame:
// height = frame time (the dashed line is 16.7 ms, i.e. 60 fps), orange =
// a frame that ran no physics step, red = a frame over 25 ms (a visible hitch).
export class PerfOverlay {
  private times = new Float32Array(180);
  private steps = new Uint8Array(180);
  private i = 0;
  private hitches: number[] = [];
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private label: HTMLElement;
  visible = false;

  constructor(parent: HTMLElement, toggle: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'perf';
    this.canvas.width = 360;
    this.canvas.height = 100;
    this.ctx = this.canvas.getContext('2d')!;
    this.label = document.createElement('div');
    this.label.className = 'perf-label';
    parent.append(this.canvas, this.label);
    toggle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.visible = !this.visible;
      this.canvas.style.display = this.label.style.display = this.visible ? 'block' : 'none';
    });
    if (new URLSearchParams(location.search).has('debug')) toggle.dispatchEvent(new PointerEvent('pointerdown'));
  }

  record(dtMs: number, physicsSteps: number, now: number) {
    this.times[this.i] = dtMs;
    this.steps[this.i] = physicsSteps;
    this.i = (this.i + 1) % this.times.length;
    if (dtMs > 25) this.hitches.push(now);
    while (this.hitches.length && now - this.hitches[0] > 10000) this.hitches.shift();
    if (this.visible) this.draw();
  }

  private draw() {
    const { ctx, canvas } = this;
    const n = this.times.length;
    const w = canvas.width / n;
    const scale = canvas.height / 50; // 50 ms full height
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(20,28,30,0.6)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    let worst = 0;
    for (let k = 0; k < n; k++) {
      const idx = (this.i + k) % n;
      const t = this.times[idx];
      worst = Math.max(worst, t);
      ctx.fillStyle = t > 25 ? '#ff5a4f' : this.steps[idx] === 0 ? '#ffb347' : '#9fe0a8';
      const h = Math.min(canvas.height, t * scale);
      ctx.fillRect(k * w, canvas.height - h, Math.max(1, w - 0.5), h);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    const y = canvas.height - 16.7 * scale;
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
    ctx.setLineDash([]);
    this.label.textContent = `worst ${worst.toFixed(0)} ms · hitches (>25 ms) in last 10 s: ${this.hitches.length}`;
  }
}
