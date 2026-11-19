// Saving: the journey is kept on the phone all the time, and can be backed
// up as a short save code (copy it, or share it to WhatsApp or Notes) and
// restored from one. Nothing leaves the phone: no accounts, no server.
//
// The browser can still lose what it stores (a private tab closing, site
// data being cleared, iPhone Safari clearing a website it hasn't seen for
// about a week), so the game says so plainly before a drive whenever that
// can happen, and offers a backup after long drives.

/** Where the car was left on one drive. */
export interface Spot {
  x: number;
  z: number;
  y?: number;
  yaw: number;
  label: string;
  camp?: string;
  style?: string;
  savedAt: number;
}

export interface Journey {
  /** Which drive (course id) and where the car is. */
  course: string;
  x: number;
  z: number;
  yaw: number;
  /** Height of the car, so a car saved on a bridge deck comes back on it. */
  y?: number;
  /** Where that is, for the Continue button: a camp, a road, a park. */
  label: string;
  style?: string;
  /** Camp the car is parked in, if it was saved at camp. */
  camp?: string;
  /** Metres driven in all. */
  odo: number;
  /** Fuel left, 0..1. */
  fuel?: number;
  /** Dust and mud on the car, 0..1. */
  dust?: number;
  /** Home garage id and the garages reached. */
  home?: string;
  garages?: string[];
  /** Where the car was left on each drive, so trying another drive never
   * loses your place on this one (the fields above are the latest). */
  spots?: Record<string, Spot>;
  /** When saved (ms since 1970). */
  savedAt: number;
  /** Distance and time at the last backup (save code made). */
  backupOdo: number;
  backupAt: number;
}

const KEY = 'pocket-overland-save';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Cleans a stored or decoded save; also reads the older camp-only save. */
export function normalise(s: unknown): Journey | null {
  if (!s || typeof s !== 'object') return null;
  const o = s as Record<string, unknown>;
  if (typeof o.course !== 'string' || typeof o.x !== 'number' || typeof o.z !== 'number') return null;
  const j: Journey = {
    course: o.course,
    x: num(o.x),
    z: num(o.z),
    yaw: num(o.yaw),
    label: typeof o.label === 'string' ? o.label : '',
    odo: Math.max(0, num(o.odo)),
    savedAt: num(o.savedAt, Date.now()),
    backupOdo: Math.max(0, num(o.backupOdo)),
    backupAt: num(o.backupAt),
  };
  if (typeof o.y === 'number' && Number.isFinite(o.y)) j.y = o.y;
  if (typeof o.style === 'string') j.style = o.style;
  if (typeof o.camp === 'string') j.camp = o.camp;
  if (typeof o.fuel === 'number') j.fuel = Math.min(1, Math.max(0, o.fuel));
  if (typeof o.dust === 'number') j.dust = Math.min(1, Math.max(0, o.dust));
  if (typeof o.home === 'string') j.home = o.home;
  if (Array.isArray(o.garages)) j.garages = o.garages.filter((g): g is string => typeof g === 'string');
  j.spots = {};
  if (o.spots && typeof o.spots === 'object')
    for (const [k, v] of Object.entries(o.spots as Record<string, Record<string, unknown>>)) {
      if (!v || typeof v.x !== 'number' || typeof v.z !== 'number') continue;
      const sp: Spot = { x: v.x, z: v.z, yaw: num(v.yaw), label: typeof v.label === 'string' ? v.label : '', savedAt: num(v.savedAt) };
      if (typeof v.y === 'number') sp.y = v.y;
      if (typeof v.camp === 'string') sp.camp = v.camp;
      if (typeof v.style === 'string') sp.style = v.style;
      j.spots[k] = sp;
    }
  // (The latest drive's spot is always among them, from older saves too.)
  j.spots[j.course] ??= spotOf(j);
  return j;
}

export const spotOf = (j: Journey): Spot => {
  const s: Spot = { x: j.x, z: j.z, yaw: j.yaw, label: j.label, savedAt: j.savedAt };
  if (j.y !== undefined) s.y = j.y;
  if (j.camp) s.camp = j.camp;
  if (j.style) s.style = j.style;
  return s;
};

export function loadJourney(): Journey | null {
  try {
    return normalise(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return null;
  }
}

export function saveJourney(j: Journey): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(j));
    return true;
  } catch {
    return false;
  }
}

// ---------- Can this tab keep progress? ----------

export type StorageHealth = {
  /** Writing and reading back works at all. */
  works: boolean;
  /** Playing from the home screen (installed), where storage is safest. */
  installed: boolean;
  /** The browser promised to keep the storage (persistent storage). */
  persisted: boolean;
  ios: boolean;
};

export function isInstalled() {
  return (
    matchMedia('(display-mode: standalone)').matches ||
    matchMedia('(display-mode: fullscreen)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export async function checkStorage(): Promise<StorageHealth> {
  let works = false;
  try {
    const probe = `pocket-overland-probe-${Math.random()}`;
    localStorage.setItem(probe, '1');
    works = localStorage.getItem(probe) === '1';
    localStorage.removeItem(probe);
  } catch {
    works = false;
  }
  let persisted = false;
  try {
    persisted = (await navigator.storage?.persisted?.()) ?? false;
    // Ask once per visit; browsers decide (Chrome grants it to sites you
    // use often or installed; Safari mostly to home-screen apps).
    if (!persisted && works) persisted = (await navigator.storage?.persist?.()) ?? false;
  } catch {
    persisted = false;
  }
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return { works, installed: isInstalled(), persisted, ios };
}

/** The plain warning for this tab, or null when progress is as safe as a browser allows. */
export function storageWarning(h: StorageHealth): { level: 'none' | 'risk'; text: string; short: string } | null {
  if (!h.works)
    return {
      level: 'none',
      text: "This tab can't keep your progress. When you close it, your drive is gone. Back up with a save code, or open the game in a normal tab.",
      short: "This tab can't keep your progress: when you close it, your drive is gone. Back up with a save code (menu ☰).",
    };
  if (h.installed && h.persisted) return null;
  if (h.installed) return null; // home-screen games keep their storage
  return {
    level: 'risk',
    text: h.ios
      ? 'Your journey is kept in this browser only: a private tab, clearing website data or a week away can wipe it. To keep it safe, tap Share, then “Add to Home Screen”, or back up with a save code.'
      : 'Your journey is kept in this browser only: a private tab or clearing site data can wipe it. To keep it safe, install the game (browser menu, “Add to Home screen”), or back up with a save code.',
    short: h.ios
      ? 'Your journey is kept in this browser only and can be wiped. Add to Home Screen, or back up with a save code.'
      : 'Your journey is kept in this browser only and can be wiped. Install the game, or back up with a save code.',
  };
}

// ---------- Save codes ----------
// "PO1-" + base64url of a compact JSON array, with a 4-character check so
// a mistyped or cut-off code is refused rather than half loaded. Dashes and
// spaces are only for reading and are ignored when pasted back.

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const PREFIX = 'PO1';

function check(s: string) {
  // FNV-1a, 24 bits, as 4 base64url characters.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h &= 0xffffff;
  return [18, 12, 6, 0].map((sh) => ALPHA[(h >> sh) & 63]).join('');
}

const toB64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64 = (b64: string) => {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

const r1 = (v: number) => Math.round(v * 10) / 10;

export function encodeCode(j: Journey): string {
  const arr = [
    j.course,
    r1(j.x),
    r1(j.z),
    Math.round(j.yaw * 1000) / 1000,
    j.label,
    j.style === 'stylized' ? 1 : 0,
    j.camp ?? '',
    Math.round(j.odo),
    j.fuel === undefined ? -1 : Math.round(j.fuel * 1000) / 1000,
    j.home ?? '',
    j.garages ?? [],
    Math.round(j.savedAt / 1000),
    j.y === undefined ? null : r1(j.y),
    Math.round((j.dust ?? 0) * 100) / 100,
  ];
  const body = toB64(JSON.stringify(arr));
  return `${PREFIX}-${body}.${check(body)}`;
}

/** The save in a code, or null when the code is not a whole, valid one. */
export function decodeCode(code: string): Journey | null {
  const m = code.replace(/\s+/g, '').match(/PO1-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{4})/);
  if (!m || check(m[1]) !== m[2]) return null;
  try {
    const a = JSON.parse(fromB64(m[1]));
    if (!Array.isArray(a) || a.length < 12) return null;
    const j = normalise({
      course: a[0],
      x: a[1],
      z: a[2],
      yaw: a[3],
      label: a[4],
      style: a[5] ? 'stylized' : 'detailed',
      camp: a[6] || undefined,
      odo: a[7],
      fuel: a[8] >= 0 ? a[8] : undefined,
      home: a[9] || undefined,
      garages: a[10],
      savedAt: a[11] * 1000,
      y: a[12] ?? undefined,
      dust: a[13] ?? 0,
    });
    if (j) {
      // A restored code counts as backed up where it was made.
      j.backupOdo = j.odo;
      j.backupAt = Date.now();
    }
    return j;
  } catch {
    return null;
  }
}

export function restoreLink(code: string) {
  return `${location.origin}${location.pathname}#restore=${code}`;
}

export const describe = (j: Journey) =>
  [
    j.label || 'On the road',
    // (Nothing about distance before any is driven, e.g. a save from before the odometer.)
    ...(j.odo >= 50 ? [`${(j.odo / 1000).toFixed(j.odo < 10000 ? 1 : 0)} km driven`] : []),
    `saved ${new Date(j.savedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`,
  ].join(' · ');

// ---------- Backup panel ----------
// One panel for "Back up your journey" (copy, share, link) and for
// restoring from a pasted code. Works upright and sideways.

export function backupPanel(parent: HTMLElement, j: Journey, onDone: (backedUp: boolean) => void) {
  const code = encodeCode(j);
  const el = document.createElement('div');
  el.className = 'panel';
  el.innerHTML = `
    <div class="panel-card">
      <h2>Back up your journey</h2>
      <p>${esc(describe(j))}</p>
      <p class="small">Keep this code somewhere safe, like a WhatsApp chat to yourself or your Notes. Paste it into “Restore from a save code” to carry on, on this phone or another.</p>
      <textarea readonly rows="3" class="code"></textarea>
      <div class="panel-buttons">
        <button class="btn primary" data-a="share">Share</button>
        <button class="btn" data-a="copy">Copy</button>
        <button class="btn" data-a="close">Done</button>
      </div>
      <p class="small status" aria-live="polite"></p>
    </div>`;
  const ta = el.querySelector('textarea')!;
  ta.value = code;
  const status = el.querySelector('.status')!;
  let backedUp = false;
  const shareBtn = el.querySelector<HTMLButtonElement>('[data-a=share]')!;
  if (!navigator.share) shareBtn.hidden = true;
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('click', async (e) => {
    const a = (e.target as HTMLElement).closest('button')?.dataset.a;
    if (a === 'copy') {
      try {
        await navigator.clipboard.writeText(code);
        status.textContent = 'Copied. Paste it somewhere you keep things.';
        backedUp = true;
      } catch {
        ta.focus();
        ta.select();
        status.textContent = 'Select the code and copy it.';
      }
    } else if (a === 'share') {
      try {
        await navigator.share({ title: 'Pocket Overland save', text: `My Pocket Overland journey (${describe(j)}). Save code:\n${code}\n\nOr open: ${restoreLink(code)}` });
        status.textContent = 'Shared.';
        backedUp = true;
      } catch {
        /* cancelled */
      }
    } else if (a === 'close') {
      el.remove();
      onDone(backedUp);
    }
  });
  parent.append(el);
  return el;
}

export function restorePanel(parent: HTMLElement, prefill: string, known: (course: string) => boolean, onRestore: (j: Journey) => void, onClose: () => void) {
  const el = document.createElement('div');
  el.className = 'panel';
  el.innerHTML = `
    <div class="panel-card">
      <h2>Restore from a save code</h2>
      <p class="small">Paste the code you saved. It starts with PO1-.</p>
      <textarea rows="3" class="code" placeholder="PO1-…" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>
      <p class="found"></p>
      <div class="panel-buttons">
        <button class="btn primary" data-a="restore" disabled>Restore</button>
        <button class="btn" data-a="close">Cancel</button>
      </div>
    </div>`;
  const ta = el.querySelector('textarea')!;
  const found = el.querySelector('.found')!;
  const go = el.querySelector<HTMLButtonElement>('[data-a=restore]')!;
  let j: Journey | null = null;
  const read = () => {
    j = ta.value.trim() ? decodeCode(ta.value) : null;
    const drive = !j || known(j.course);
    found.textContent = !drive
      ? 'That code is for a drive this version of the game doesn’t have.'
      : j
        ? describe(j)
        : ta.value.trim()
          ? "That code isn't complete or has a typo. Paste the whole code."
          : '';
    if (!drive) j = null;
    go.disabled = !j;
  };
  ta.value = prefill;
  ta.addEventListener('input', read);
  read();
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('button')?.dataset.a;
    if (a === 'restore' && j) onRestore(j);
    else if (a === 'close') {
      el.remove();
      onClose();
    }
  });
  parent.append(el);
  return el;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
