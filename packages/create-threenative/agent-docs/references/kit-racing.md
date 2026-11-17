# Kit notes: racing

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

This repository owns the car feel, track, race rules, rescue, HUD, and look; `src/game.ts` is portable and React mounts from `src/main.ts`. A bullet that passes through a wall is not a collider bug: `RigidBody3D` defaults to continuous collision, `continuousCollision` is the named per-body override, and `body.continuousCollision` reports the effective setting on web and native.


## Start every change

`@threenative/physics/navigation` is browser-only WASM; this kit uses `VehicleBody3D` for the cars and `PathFollow3D` for the rival's line, and no navmesh.


## Commands and map

`src/track/Track.ts` owns the circuit, its collision layers and the grid; `Lap.ts` orders `Area3D` gates and counts a lap on the car's **measured** travel direction; `TrackSector.ts` ray-probes the road and rescues from it; `Ranking.ts` ranks route progress. `src/entities/CarBody.ts` builds the one chassis both cars drive — a `VehicleBody3D` whose wheels are read off the four **named** wheel groups in `shapes.ts`. `RacingCar.ts` turns input into `engineForce` / `brake` / `steering` and nothing else; `Rival.ts` is that same car under a pure-pursuit controller, five of them on a staggered six-car grid (`GRID_SLOTS` in `circuit.ts`), each at its own constant pace from `RIVALS`, the player last. `Drift.ts` is the drift: Shift with the wheel turned at speed kicks the tail out, full lock above `DRIFT.looseSpeed` lets it go by itself, and both lower the rear grip through `VehicleBody3D.setWheelFrictionSlip`. `Nitro.ts` is the tank Space burns, filled by driving and about four times faster by drifting. `gauges.ts` is the gearbox readout — six bands, and Need for Speed: Most Wanted's capped needle fall with a 55/45 blend — and `audio/engine.ts` is the car's sound over one `AudioBus`: the bed pitched from that needle, the tyre squeal opened by the slip angle, a burst on the nitro button. Controls: WASD or arrows drive, Shift drifts and brakes, Space is nitro, P is the autopilot, R restarts. Keep `playtests/survives.playtest.json` as the smoke proof, and on a touch device `src/render/touch-controls.ts` adds the stick and buttons.

**Two things about the vehicle are invisible in the API.** `suspensionStiffness` is a frequency squared, so the strut sags `gravity / (4 * stiffness)` and Godot's default of 20 bottoms it out, and a positive steering angle turns the chassis toward its own `-z` — so the input is negated once and the visual front wheels take that same signed angle. `CarBody.ts` carries every other number.


## Portable authoring contracts

Generated conventions call `normaliseToMetres` for authored vehicle scale; the four `VehicleBody3D` wheels own floor contact, so no car gets `GroundSnap`. `input.vector("move").y` is +up and means throttle, and `+x` is right.

`src/render/sky.ts` draws Unreal's default sky (an atmosphere with clouds: `atmosphere.ts`, `clouds.ts`, `gpuSky.ts`) as background, environment light and height-fog colour, and `lighting.ts` tints the sun at `SUN_DIRECTION` by the air it crosses; `SKY_OPTIONS` takes `sky: "photo"` for `assets/sky.jpg` (Poly Haven, CC0) or `clouds: false`, and `ground: false` once the game has its own global illumination (the sunlit ground under the horizon stands in for the bounce). The shared look comes from core through `src/render/quality.ts`: the filmic curve and metered auto exposure are enabled by default. The bridge flushes about 100 ms; keep speed/lap in state and frame feedback in Three.js. Racing keeps its deliberate gather, SSR and sharpening overrides in `quality.ts`: reflected rough tarmac and sharpening produced unstable speckles/bands, and the game retains its 33 ms / 30 FPS budget. The curve and meter stay enabled. The HUD uses the existing opaque `bg-panel` behind race, position, speed/time/gear and revs/nitro and outcome text so a brighter road or sky does not erase the readouts; a banked drift's score pops up under it for 1.6 s, keyed on `driftsBanked` so two identical scores in a row still count as two, and counted in **game** seconds by `DRIFT.popupSeconds` — the drift owns that clock and publishes it as `driftPopup`, so a pause freezes the popup instead of ageing it while the car stands still.

**Sound is authored, not licensed.** `tools/make-racing-audio.mjs` bakes `assets/engine-loop.wav`, `tyre-squeal.wav` and `nitro-burst.wav` from maths — an engine bed pitched live from 0.62× to 2.05× has to be tonal and exactly periodic, which a recording is not — and `CREDITS.md` records why no downloaded clip fits. Both beds are declared loops with `crossFadeMs: 0` in `threenative.config.ts`, so the asset pass measures their seams and fails the build on a click. One named native gap: the host binds a source's `playbackRate` as a passive parameter, so on native the bed plays at rate 1 with the same volume, squeal and burst. `node tools/make-racing-audio.mjs --check` re-bakes and compares against the committed bytes.
