# Pocket Overland

A calm, scenic overland driving game for phones, played in the browser. You drive a rugged 4x4 the long way from Singapore toward London, region by region. The design doc lives in the project's Claude Doc ("Pocket Overland — Game Design & Plan").

This repo currently holds the **core driving prototype**: one vehicle on a hand-made test course modeled loosely on Pulau Ubin's gravel tracks. It exists to prove the driving feels good on a phone before any world generation is built.

## Run it

```bash
npm install
npm run dev        # serves on your local network (vite --host)
```

Open the printed `Network:` address on your phone (same Wi-Fi) and turn the phone sideways.

Other scripts: `npm run build` (typecheck + production build into `dist/`), `npm run preview`.

### Play it from GitHub Pages

`.github/workflows/pages.yml` builds and deploys every push to `main`. Turn it on once in the repo: **Settings → Pages → Source: GitHub Actions**. The game is then at `https://hohungyiai.github.io/pocket-overland-claude/`. On iPhone, use Share → Add to Home Screen for a real fullscreen view.

## Controls

| | Touch | Keyboard |
| --- | --- | --- |
| Steer | Left half: drag sideways from wherever your thumb lands | A / D or ← / → |
| Throttle / brake / reverse | Right half: drag up to go, down to brake; hold down when stopped to reverse | W / S or ↑ / ↓ |
| Low range (more pulling power, lower top speed) | LOW button | L |
| Diff lock (keeps drive when a wheel lifts) | DIFF button | K |
| Recover (put the car back on its wheels) | ↺ button | R |
| Camera: chase, high, low | Top-right button | C |

Hill-hold is automatic when you're off the pedals. Rolling over self-recovers after two seconds.

## The test course

A gravel loop through low hills with five sections, shown on screen as you reach them:

1. **Steep climb**: up to about 48% grade. Easier in low range.
2. **Rock garden**: rocks on the road; wheels lift, so the diff lock matters.
3. **Quarry crossing**: shallow water with drag and less grip.
4. **Sand wash**: soft sand that saps speed.
5. **Off-camber**: the road leans sideways.

## Code map

| File | What it does |
| --- | --- |
| `src/main.ts` | Renderer, lights, camera modes, HUD, buttons, fixed 60 Hz physics loop |
| `src/vehicle.ts` | The 4x4: Rapier ray-cast vehicle, suspension, engine, low range, open/locked diff, surfaces, self-recovery. Tuning values are in `TUNING` at the top |
| `src/course.ts` | Test course: road spline, terrain conformed to the road, surfaces, rocks, water, vegetation. Render mesh and physics mesh share the same vertices, so there are no seams |
| `src/controls.ts` | Relative-drag thumb sticks and keyboard input |
| `src/noise.ts` | Seeded random and noise helpers |

For debugging, `window.game` exposes the car, course, controls and physics world in the browser console. For example, `game.car.placeAt(game.course.poseAt(0.3).pos, game.course.poseAt(0.3).yaw)` jumps to the rock garden.

## Not in this prototype yet

The art test (stylized-and-dense vs higher detail along an East Coast Park stretch), audio, Singapore East, procedural generation, the route map and the expedition loop. See the roadmap in the design doc.
