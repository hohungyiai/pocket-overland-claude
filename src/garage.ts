import * as THREE from 'three';

// Garages: the game's own garages at real landmarks. Drive into the bay,
// tap "Enter garage", and refuel, wash, plan the trip, back up the journey,
// or make it your home (where a journey starts). Garages along the route
// unlock once you've driven to one and gone in.

export interface GarageSpot {
  id: string;
  name: string;
  /** Which drives (course ids) it stands on. */
  courses: string[];
  /** Middle of the drive-in bay, and the way a car parked in it faces. */
  x: number;
  z: number;
  yaw: number;
  /** Where on the map of Singapore (for choosing home). */
  lat: number;
  lon: number;
  /** Not built yet: listed, greyed out, "as the map grows". */
  later?: boolean;
}

export const GARAGES: GarageSpot[] = [
  // Our Tampines Hub: the bay on the service road along the Hub's north
  // side (today's map), facing east along it.
  { id: 'tampines-hub', name: 'Our Tampines Hub', courses: ['pasirris', 'whole'], x: -790, z: 1479.2, yaw: 0, lat: 1.3527, lon: 103.9403 },
  { id: 'jewel', name: 'Jewel Changi Airport', courses: [], x: 0, z: 0, yaw: 0, lat: 1.3602, lon: 103.9894, later: true },
  { id: 'gardens', name: 'Gardens by the Bay', courses: [], x: 0, z: 0, yaw: 0, lat: 1.2816, lon: 103.8636, later: true },
  { id: 'jurong-lake', name: 'Jurong Lake Gardens', courses: [], x: 0, z: 0, yaw: 0, lat: 1.3383, lon: 103.7292, later: true },
];

export const garageById = (id: string | undefined) => GARAGES.find((g) => g.id === id && !g.later) ?? null;
export const HOME_DEFAULT = 'tampines-hub';

const BAY_W = 3.4; // across
const BAY_L = 6.5; // along

/** The bay, its sign and the garage door, drawn on a course. */
export class Garages {
  readonly here: GarageSpot[];
  private group = new THREE.Group();
  private bays = new Map<string, THREE.Mesh>();
  private settled = new Set<string>();

  constructor(
    scene: THREE.Scene,
    courseId: string,
    private groundY: (x: number, z: number) => number,
  ) {
    this.here = GARAGES.filter((g) => !g.later && g.courses.includes(courseId));
    for (const g of this.here) this.group.add(this.build(g));
    scene.add(this.group);
  }

  /** The garage whose bay the car is in, if any. */
  at(x: number, z: number): GarageSpot | null {
    for (const g of this.here) {
      const c = Math.cos(g.yaw);
      const s = -Math.sin(g.yaw);
      const dx = x - g.x;
      const dz = z - g.z;
      const along = dx * c + dz * s;
      const across = -dx * s + dz * c;
      if (Math.abs(along) < BAY_L / 2 + 1 && Math.abs(across) < BAY_W / 2 + 0.8) return g;
    }
    return null;
  }

  /**
   * Drape each bay on the road surface, 2 cm up, once the road under it is
   * built: top(x, z) gives the height of the road there, or null if not yet.
   */
  settle(top: (x: number, z: number) => number | null) {
    for (const g of this.here) {
      if (this.settled.has(g.id)) continue;
      const bay = this.bays.get(g.id)!;
      const pos = bay.geometry.attributes.position;
      const c = Math.cos(g.yaw);
      const s = Math.sin(g.yaw);
      const ys: number[] = [];
      for (let i = 0; i < pos.count; i++) {
        // (Local x along the bay, z across; the group turns by yaw about y.)
        const lx = pos.getX(i);
        const lz = pos.getZ(i);
        const y = top(g.x + lx * c + lz * s, g.z - lx * s + lz * c);
        if (y === null) break;
        ys.push(y);
      }
      if (ys.length < pos.count) continue;
      const base = bay.parent!.position.y;
      ys.forEach((y, i) => pos.setY(i, y - base + 0.02));
      pos.needsUpdate = true;
      bay.geometry.computeVertexNormals();
      bay.geometry.computeBoundingSphere();
      bay.position.y = 0;
      bay.visible = true;
      this.settled.add(g.id);
    }
  }

  private build(g: GarageSpot) {
    const grp = new THREE.Group();
    const y = this.groundY(g.x, g.z);
    grp.position.set(g.x, y, g.z);
    grp.rotation.y = g.yaw;
    // Bay: an orange outline and a big "GARAGE" across it, painted on the road.
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 256;
    const x = c.getContext('2d')!;
    x.strokeStyle = '#e08a2c';
    x.lineWidth = 16;
    x.strokeRect(10, 10, 492, 236);
    // (Written across the bay, reading upright to a car driving in.)
    x.fillStyle = 'rgba(224,138,44,0.9)';
    x.font = 'bold 54px system-ui, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.save();
    x.translate(150, 128);
    x.rotate(Math.PI / 2);
    x.fillText('GARAGE', 0, 0);
    x.restore();
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    // (Laid flat for now; settle() drapes it on the road once that's built.)
    const bay = new THREE.Mesh(
      new THREE.PlaneGeometry(BAY_L, BAY_W, 8, 4).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    );
    bay.position.y = 0.04;
    bay.receiveShadow = true;
    bay.visible = false;
    this.bays.set(g.id, bay);
    grp.add(bay);
    // Sign over the bay, on the building's side (to its right).
    const sc = document.createElement('canvas');
    sc.width = 1024;
    sc.height = 256;
    const s = sc.getContext('2d')!;
    s.fillStyle = '#23353b';
    s.fillRect(0, 0, 1024, 256);
    s.fillStyle = '#e08a2c';
    s.fillRect(0, 0, 1024, 18);
    s.fillStyle = '#fff';
    s.textAlign = 'center';
    s.font = 'bold 70px system-ui, sans-serif';
    s.fillText('Pocket Overland Garage', 512, 118);
    s.font = '600 58px system-ui, sans-serif';
    s.fillStyle = '#f2d3a8';
    s.fillText(g.name, 512, 205);
    const st = new THREE.CanvasTexture(sc);
    st.anisotropy = 4;
    const board = new THREE.Mesh(new THREE.PlaneGeometry(4, 1), new THREE.MeshStandardMaterial({ map: st, roughness: 0.6 }));
    const back = new THREE.Mesh(new THREE.BoxGeometry(4.1, 1.1, 0.08), new THREE.MeshStandardMaterial({ color: 0x23353b }));
    // (On the Hub's wall beside the bay, facing the road.)
    const side = BAY_W / 2 - 0.2;
    board.position.set(0, 3.4, side - 0.05);
    board.rotation.y = Math.PI;
    back.position.set(0, 3.4, side);
    back.castShadow = true;
    grp.add(board, back);
    return grp;
  }
}

// ---------- Choosing home: a small map of Singapore and the list ----------

// A rough outline of the island (lon, lat), for the picker's little map.
const SG: [number, number][] = [
  [103.64, 1.32], [103.66, 1.29], [103.7, 1.27], [103.76, 1.27], [103.81, 1.26], [103.84, 1.265], [103.87, 1.275],
  [103.9, 1.295], [103.94, 1.305], [103.98, 1.315], [104.02, 1.33], [104.035, 1.36], [104.0, 1.385], [103.96, 1.39],
  [103.92, 1.41], [103.89, 1.425], [103.84, 1.44], [103.8, 1.46], [103.77, 1.45], [103.73, 1.44], [103.69, 1.43],
  [103.66, 1.4], [103.64, 1.36],
];

export function homePicker(parent: HTMLElement, current: string | undefined, onPick: (g: GarageSpot) => void, onClose: () => void) {
  const el = document.createElement('div');
  el.className = 'panel';
  const W = 300;
  const H = 150;
  const px = (lon: number) => ((lon - 103.62) / (104.05 - 103.62)) * W;
  const py = (lat: number) => H - ((lat - 1.24) / (1.48 - 1.24)) * H;
  const outline = SG.map(([lo, la]) => `${px(lo).toFixed(1)},${py(la).toFixed(1)}`).join(' ');
  const dots = GARAGES.map(
    (g) =>
      `<g class="${g.later ? 'later' : 'open'}"><circle cx="${px(g.lon).toFixed(1)}" cy="${py(g.lat).toFixed(1)}" r="${g.later ? 4 : 6}"/></g>`,
  ).join('');
  el.innerHTML = `
    <div class="panel-card home">
      <h2>Choose your home garage</h2>
      <p class="small">Your journey starts here, and you can always come back to refuel, wash the car, plan a trip and back up.</p>
      <div class="home-body">
      <svg viewBox="0 0 ${W} ${H}" class="sgmap" aria-hidden="true"><polygon points="${outline}"/>${dots}</svg>
      <div class="garage-list">${GARAGES.map(
        (g) => `<button class="garage-row" data-id="${g.id}" ${g.later ? 'disabled' : ''}><b>${g.name}</b><span>${g.later ? 'As the map grows' : g.id === current ? 'Your home' : 'East Singapore · open now'}</span></button>`,
      ).join('')}</div>
      </div>
      <div class="panel-buttons"><button class="btn" data-a="close">Cancel</button></div>
    </div>`;
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    if (b.dataset.a === 'close') {
      el.remove();
      onClose();
      return;
    }
    const g = garageById(b.dataset.id);
    if (g) {
      el.remove();
      onPick(g);
    }
  });
  parent.append(el);
  return el;
}

/** The garage's own menu. Returns the panel; actions are handled by the caller. */
export function garagePanel(
  parent: HTMLElement,
  g: GarageSpot,
  state: { fuel: number | null; dust: number; home: boolean },
  on: (action: 'refuel' | 'wash' | 'plan' | 'backup' | 'home' | 'leave') => void,
) {
  const el = document.createElement('div');
  el.className = 'panel';
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const row = (a: string, title: string, sub: string, disabled = false) =>
    `<button class="garage-row" data-a="${a}" ${disabled ? 'disabled' : ''}><b>${title}</b><span>${sub}</span></button>`;
  const render = () => {
    el.innerHTML = `
    <div class="panel-card garage">
      <h2>${g.name} Garage</h2>
      <div class="garage-list">
        ${state.fuel === null ? '' : row('refuel', 'Refuel', state.fuel > 0.98 ? 'Tank full' : `Tank ${pct(state.fuel)}: fill it up`, state.fuel > 0.98)}
        ${row('wash', 'Wash', state.dust < 0.05 ? 'Clean' : 'Wash off the dust and mud', state.dust < 0.05)}
        ${row('plan', 'Plan the trip', 'The map, with petrol stations and how far your tank goes')}
        ${row('backup', 'Back up your journey', 'A save code to keep somewhere safe')}
        ${row('home', state.home ? 'Your home garage' : 'Make this home', state.home ? 'Your journey starts here' : 'Start your journeys from here', state.home)}
        ${row('kit', 'Fit or swap kit', 'Coming soon', true)}
      </div>
      <div class="panel-buttons"><button class="btn primary" data-a="leave">Drive out</button></div>
    </div>`;
  };
  render();
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('button')?.dataset.a as Parameters<typeof on>[0] | undefined;
    if (!a) return;
    if (a === 'leave') el.remove();
    on(a);
  });
  parent.append(el);
  return { el, update: (s: Partial<typeof state>) => (Object.assign(state, s), render()) };
}
