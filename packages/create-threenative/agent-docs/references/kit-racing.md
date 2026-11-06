# Kit notes: racing

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

This repository owns the car feel, track, race rules, rescue, HUD, and look; `src/game.ts` is portable and React mounts from `src/main.ts`. A bullet that passes through a wall is not a collider bug: `RigidBody3D` defaults to continuous collision, `continuousCollision` is the named per-body override, and `body.continuousCollision` reports the effective setting on web and native.


## Start every change

`@threenative/physics/navigation` is browser-only WASM; this kit uses `VehicleBody3D` for the cars and `PathFollow3D` for the rival's line, and no navmesh.


## Commands and map

`src/track/Track.ts` owns the circuit, its collision layers and the grid; `Lap.ts` orders `Area3D` gates and counts a lap on the car's **measured** travel direction; `TrackSector.ts` ray-probes the road and rescues from it; `Ranking.ts` ranks route progress. `src/entities/CarBody.ts` builds the one chassis both cars drive — a `VehicleBody3D` whose wheels are read off the four **named** wheel groups in `shapes.ts`. `RacingCar.ts` turns input into `engineForce` / `brake` / `steering` and nothing else; `Rival.ts` is that same car under a pure-pursuit controller at a constant pace. Keep `playtests/survives.playtest.json` as the smoke proof, and on a touch device `src/render/touch-controls.ts` adds the stick and buttons.

**Two things about the vehicle are invisible in the API.** `suspensionStiffness` is a frequency squared, so the strut sags `gravity / (4 * stiffness)` and Godot's default of 20 bottoms it out, and a positive steering angle turns the chassis toward its own `-z` — so the input is negated once and the visual front wheels take that same signed angle. `CarBody.ts` carries every other number.


## Portable authoring contracts

Generated conventions call `normaliseToMetres` for authored vehicle scale; the four `VehicleBody3D` wheels own floor contact, so no car gets `GroundSnap`. `input.vector("move").y` is +up and means throttle, and `+x` is right.

`src/render/sky.ts` draws Unreal's default sky (an atmosphere with clouds: `atmosphere.ts`, `clouds.ts`, `gpuSky.ts`) as background, environment light and height-fog colour, and `lighting.ts` tints the sun at `SUN_DIRECTION` by the air it crosses; `SKY_OPTIONS` takes `sky: "photo"` for `assets/sky.jpg` (Poly Haven, CC0) or `clouds: false`, and `ground: false` once the game has its own global illumination (the sunlit ground under the horizon stands in for the bounce). The shared look comes from core through `src/render/quality.ts`: the filmic curve and metered auto exposure are enabled by default. The bridge flushes about 100 ms; keep speed/lap in state and frame feedback in Three.js. Racing keeps its deliberate gather, SSR and sharpening overrides in `quality.ts`: reflected rough tarmac and sharpening produced unstable speckles/bands, and the game retains its 33 ms / 30 FPS budget. The curve and meter stay enabled. The HUD uses the existing opaque `bg-panel` behind race, position, speed/time/boost and outcome text so a brighter road or sky does not erase the readouts.
