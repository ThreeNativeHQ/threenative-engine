# Kit notes: runner

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

This repository owns the track, the runner, the obstacles, the dust, the HUD and the look; `src/game.ts` is portable and React mounts only from `src/main.ts`.


## Start every change

No navmesh is imported, so this kit runs on every target; `@threenative/physics/navigation` would make it web and desktop only. `GPUParticles3D` is WebGPU-only and the dust depends on it.


## Commands and map

`src/track.ts` is a ring of six chunks **moved and rewritten**, never rebuilt: each chunk's obstacle `InstancedMesh` is built once at a fixed slot count and its matrices rewritten on recycle. The obstacle *bodies* are the exception — disposed and recreated, because `RigidBody3D` cannot reposition a fixed body. The runner is not a rigid body — a lane snap and a jump arc feel worse in a solver — but the collision is real: `src/entities/Runner.ts` carries an `Area3D` masked to the obstacle layer and listens for `bodyEntered`, so a hit is an overlap the engine reports, not a hand-kept distance check. Its figure is `assets/mannequin.glb` (the file `minimal` ships) through `SkeletalMesh3D`; `CLIPS` names the four clips it plays. Gravity is zero in `src/game.ts` on purpose; nothing falls. The track comes from `ctx.random`, so `defineGame({ seed })` **is** the level. Register entities with `ctx.entities`; the React HUD reads `GameState`, never an entity. Keep `playtests/survives.playtest.json` as smoke proof, `playtests/stride.playtest.json` bounds the mannequin's `footSlip` at 1 m/s, and keep `streams` honest when chunk recycling changes.


## Portable authoring contracts

The camera reads the runner **after** the step through `afterPhysics` — in the frame function that is 0.4 m of lag at 26 m/s. `CameraShake` returns an offset; `src/render/camera.ts` adds it. `src/render/sky.ts` draws Unreal's default sky (an atmosphere with clouds) as background, environment light and height-fog colour, and `lighting.ts` tints the sun by the air it crosses; `SKY_OPTIONS` takes `sky: "photo"` for `assets/sky.jpg` or `clouds: false`, and `ground: false` once the game has its own global illumination (the sunlit ground under the horizon stands in for the bounce).


## Budget real time for the look

The shared filmic curve and metered exposure come from core through `src/render/quality.ts`. Runner maps logical `high` to core `medium`: the full high chain measured 51.3/52 ms p95 against its 33 ms budget. `TN_RENDER_CHAIN_TIER_OVERRIDE` reports that cap; the curve and meter stay enabled. The authored `gtaoRadius: 0.35` preserves foot contact, and `samples: 4` preserves the Three.js fallback's thin-rail anti-aliasing with SMAA. Runner keeps `ssrEnabled: false` on its rough track to retain the 33 ms p95 budget (real-display observations: 17.0/20.3 ms); `ssrEnabled: true` opts into reflections for a glossy track. Override those on the same quality preset; `tonemapMode: "aces"` and `autoExposureEnabled: false` with fixed `exposure` are explicit alternatives.


## Optional multiplayer transport

Kit facts: `A`/`D` or arrows change lane, `Space` jumps, `R` runs again; touch gets two lane buttons and a stick (flick up to jump). The track is a ring of `RESIDENT_CHUNKS` slices rebuilt by one `build` method in `src/track.ts`, so a long run costs what a short one does, and `defineGame({ seed })` sets the whole level. `assets/sky.jpg` is Poly Haven CC0 and `assets/mannequin.glb` is Quaternius CC0.
