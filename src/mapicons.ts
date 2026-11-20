// Small map badges drawn on the minimap and the full map.

/** A petrol pump badge centred at (x, y), s = half its size in pixels. */
export function drawPump(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, glow = false) {
  ctx.save();
  if (glow) {
    ctx.fillStyle = 'rgba(200,119,47,0.35)';
    ctx.beginPath();
    ctx.arc(x, y, s * 2.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#2e7d4f';
  ctx.beginPath();
  ctx.roundRect(x - s, y - s, s * 2, s * 2, s * 0.35);
  ctx.fill();
  // The pump: a body with a window, and a hose curling off its side.
  ctx.fillStyle = '#fff';
  ctx.fillRect(x - s * 0.55, y - s * 0.6, s * 0.75, s * 1.25);
  ctx.fillStyle = '#2e7d4f';
  ctx.fillRect(x - s * 0.42, y - s * 0.45, s * 0.49, s * 0.3);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(1, s * 0.16);
  ctx.beginPath();
  ctx.moveTo(x + s * 0.2, y - s * 0.3);
  ctx.lineTo(x + s * 0.55, y - s * 0.1);
  ctx.lineTo(x + s * 0.55, y + s * 0.45);
  ctx.stroke();
  ctx.restore();
}

/** A garage badge: an orange roof over a door, centred at (x, y). */
export function drawGarage(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.save();
  ctx.fillStyle = '#c8772f';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(1, s * 0.22);
  ctx.beginPath();
  ctx.moveTo(x - s, y - s * 0.15);
  ctx.lineTo(x, y - s * 1.05);
  ctx.lineTo(x + s, y - s * 0.15);
  ctx.lineTo(x + s * 0.8, y + s);
  ctx.lineTo(x - s * 0.8, y + s);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.fillRect(x - s * 0.42, y + s * 0.05, s * 0.84, s * 0.95);
  ctx.fillStyle = '#c8772f';
  for (let i = 0; i < 3; i++) ctx.fillRect(x - s * 0.42, y + s * (0.22 + i * 0.26), s * 0.84, s * 0.07);
  ctx.restore();
}
