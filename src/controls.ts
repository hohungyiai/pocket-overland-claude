import { clamp } from './noise';
import type { DriveInput } from './vehicle';

// Two analog thumb zones (see the design doc):
//  - left half: touch anywhere, drag sideways to steer (relative to where the
//    thumb landed, so there is no wheel graphic to miss)
//  - right half: touch anywhere, drag up for throttle, down for brake/reverse
// Keyboard (WASD / arrows) is there for development and desktop players.

interface Stick {
  id: number;
  x0: number;
  y0: number;
  value: number;
  knob: HTMLElement;
  base: HTMLElement;
}

export class Controls {
  readonly input: DriveInput = { steer: 0, throttle: 0 };
  private steerStick: Stick | null = null;
  private pedalStick: Stick | null = null;
  private keys = new Set<string>();
  private keySteer = 0;
  private keyThrottle = 0;
  /** True once the player has touched or pressed anything. */
  used = false;

  constructor(
    private zone: HTMLElement,
    private ui: { steerBase: HTMLElement; steerKnob: HTMLElement; pedalBase: HTMLElement; pedalKnob: HTMLElement },
  ) {
    zone.addEventListener('pointerdown', this.onDown);
    zone.addEventListener('pointermove', this.onMove);
    zone.addEventListener('pointerup', this.onUp);
    zone.addEventListener('pointercancel', this.onUp);
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.key.toLowerCase());
      this.used = true;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private onDown = (e: PointerEvent) => {
    this.used = true;
    const left = e.clientX < window.innerWidth / 2;
    const stick: Stick = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      value: 0,
      base: left ? this.ui.steerBase : this.ui.pedalBase,
      knob: left ? this.ui.steerKnob : this.ui.pedalKnob,
    };
    if (left && !this.steerStick) this.steerStick = stick;
    else if (!left && !this.pedalStick) this.pedalStick = stick;
    else return;
    this.zone.setPointerCapture(e.pointerId);
    stick.base.style.display = 'block';
    stick.base.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    stick.knob.style.transform = 'translate(0px, 0px)';
    e.preventDefault();
  };

  private onMove = (e: PointerEvent) => {
    const range = Math.min(window.innerWidth, window.innerHeight) * 0.18;
    if (this.steerStick?.id === e.pointerId) {
      const dx = clamp(e.clientX - this.steerStick.x0, -range, range);
      this.steerStick.value = dx / range;
      this.steerStick.knob.style.transform = `translate(${dx}px, 0px)`;
    } else if (this.pedalStick?.id === e.pointerId) {
      const dy = clamp(e.clientY - this.pedalStick.y0, -range, range);
      this.pedalStick.value = -dy / range;
      this.pedalStick.knob.style.transform = `translate(0px, ${dy}px)`;
    }
  };

  private onUp = (e: PointerEvent) => {
    for (const key of ['steerStick', 'pedalStick'] as const) {
      const s = this[key];
      if (s?.id === e.pointerId) {
        s.base.style.display = 'none';
        this[key] = null;
      }
    }
  };

  update(dt: number) {
    const k = this.keys;
    const kl = k.has('a') || k.has('arrowleft');
    const kr = k.has('d') || k.has('arrowright');
    const ku = k.has('w') || k.has('arrowup');
    const kd = k.has('s') || k.has('arrowdown');
    // Ramp keyboard input so it behaves a little like a thumb.
    const ramp = (cur: number, target: number, rate: number) =>
      cur + clamp(target - cur, -rate * dt, rate * dt);
    this.keySteer = ramp(this.keySteer, (kr ? 1 : 0) - (kl ? 1 : 0), 3.5);
    this.keyThrottle = ramp(this.keyThrottle, (ku ? 1 : 0) - (kd ? 1 : 0), 2.5);

    const touchSteer = this.steerStick?.value ?? 0;
    const touchPedal = this.pedalStick?.value ?? 0;
    // Small dead zone, then a gentle curve for fine control near centre.
    const shape = (v: number) => {
      const a = Math.max(0, Math.abs(v) - 0.06) / 0.94;
      return Math.sign(v) * (0.35 * a + 0.65 * a * a);
    };
    this.input.steer = clamp(shape(touchSteer) + this.keySteer, -1, 1);
    this.input.throttle = clamp(shape(touchPedal) + this.keyThrottle, -1, 1);
  }
}
