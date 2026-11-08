# Pocket Overland

A calm, scenic overland driving game for phones, played in the browser. You drive a rugged 4x4 the long way from Singapore toward London, region by region. The design doc lives in the project's Claude Doc ("Pocket Overland — Game Design & Plan").

Two drives so far, picked from the start menu (or with `?course=eastcoast` / `?course=ubin`):

- **East Coast Park**: a stylized ~1.6 km stretch of Singapore's East Coast Park, the first piece of the real journey. Service road, carparks, beach with rock groynes, jogging path, the lagoon and its food village, Bedok Jetty, the East Coast Parkway and Marine Parade's HDB blocks, with ships at anchor in the strait. Camp Areas D and G are marked on the map; the beach sand gets softer toward the water and around Area G. This is the "stylized and dense" half of the art test. The **Stylized / Detailed** button (top right) rebuilds the same park in the higher-detail style at the same spot: textured ground, leaf-card trees, rippled sand, a painted sky with reflections on the water. Add `&style=detailed` to the URL to start in it. The park is alive: traffic on the expressway, a few slow cars on the park road that stop and wait when you're in front of them, and passing showers (wet ground grips a little less). Stop inside **Camp Area G** on the beach and tap **Make camp**: the tent goes up, the evening comes and your journey is saved; **Continue** on the start menu brings you back there.
- **Changi** (same drive, no loading screen): past East Coast Park's east end the road carries on as **Changi Coast Road**, with the sea on one side and the airport fence on the other. Planes come in low over the end of the park to land on the runway behind the fence. The coast turns north round the island's eastern tip and runs west into **Changi Beach Park**: a wide beach, palms and casuarinas, shelters and two carparks. It is compressed (about 3 km of coast for the real 10) and laid out by hand, not from map data. The road currently ends at the far end of the beach park; Changi Village is next.
- **Ubin test track**: the driving prototype, a gravel loop with a climb, rock garden, water crossing, sand wash and off-camber section.

The game never fails you: there's no game over, the car self-rights after a roll, ↺ puts it back on its wheels, and if you sit stuck the HUD suggests low range and the diff lock.

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
| Full map (drive pauses; drag to pan, pinch to zoom) | Tap the minimap | M, Esc to close |
| Back to the menu | ☰ top-left | |

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
| `src/courses/types.ts` | Shared course interface, surfaces and minimap data |
| `src/courses/eastcoast.ts` | East Coast Park: hand-placed anchors (coast, road, carparks, jetty, lagoon, food village, camps) plus seeded detail (trees, shrubs, furniture, HDB blocks). Also builds the shared ground for the whole drive: one height and colour function (East Coast Park blended into Changi over a 40 m seam), sampled into tiles |
| `src/courses/changi.ts` | Changi Coast Road and Changi Beach Park, laid out by distance along a bending coastline: beach, path, road and airport fence widths change along it. Runway, tower, hangars and landing planes |
| `src/world/stream.ts` | Tile streaming: 200 m tiles in three layers (near: plants and colliders; far: detailed ground and roads; horizon: coarse ground and buildings out to the fog), built in small time-sliced steps |
| `src/world/polyline.ts` | Bending lines (coast, roads, fence) with fast nearest-point and offset queries |
| `src/courses/ubin.ts` | Ubin test track: road spline, terrain conformed to the road, surfaces, rocks, water, vegetation |
| `src/minimap.ts` | Heading-up round minimap, pre-painted once from each course's map data |
| `src/courses/detail.ts` | The detailed art style: generated textures (ground, asphalt, water, foliage atlas, facades, sky) and leaf-card plants |
| `src/traffic.ts` | Lane-following traffic; looks are passed in so each art style can supply its own |
| `src/weather.ts` | Passing showers and morning/evening light; scales whatever lighting the style set up |
| `src/camp.ts` | Camps: tent and fire, make/break camp, save and continue |
| `src/fullmap.ts` | Full-screen north-up map opened from the minimap; the place route planning will grow from |
| `src/perf.ts` | Frame-time graph (tap the fps label) |
| `src/controls.ts` | Relative-drag thumb sticks and keyboard input |
| `src/noise.ts` | Seeded random and noise helpers |

For debugging, `window.game` exposes the car, course, controls and physics world in the browser console. For example, `game.car.placeAt(game.course.poseAt(0.3).pos, game.course.poseAt(0.3).yaw)` jumps to the rock garden.

## Not in this prototype yet

audio, the rest of Singapore East, route planning on the map and the expedition loop. See the roadmap in the design doc.
