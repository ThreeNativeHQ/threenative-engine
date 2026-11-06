# Kit notes: kart

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Overview

Eight toy karts race three laps of Clover Cup, a figure-8 course with a bridge over its own underpass, a creek, a kicker jump and four boost pads. The feel is a 1990s kart racer's: a throttle that ramps, a hop that turns into a power-slide, wiggles against the slide that charge a mini-turbo through three spark colours, grass at x0.70 speed, walls that bounce, item boxes with a roulette weighted by place (burr, acorn, nitro can), seven CPU drivers on a rubber band, a 3-2-1 countdown with a rocket start, a minimap and a finish screen. Every model and texture is procedural — no mesh, image or animation file: keep `assets/` absent (the scaffold spec checks it) and build every look in code in `src/render/`.


## Ownership

ThreeNative owns bootstrap, renderer, fixed-step loop, input, loading, the state bridge, the particle and shadow systems (`GPUParticles3D`, the renderer's shadow map), and the look's render chain (`WorldEnvironment` from `@threenative/core`: the filmic tone curve and metered auto exposure). This repository owns the course, the kart's feel, the CPU drivers, the items, the race rules, the HUD, the chase camera, and the scene's own sky, sun and materials; `src/game.ts` is portable and React mounts from `src/main.ts`. `ctx.camera` interpolates between fixed ticks by default; `ctx.interpolate(object)` opts in another transform and `ctx.resetInterpolation(object)` resets a game-driven teleport.


## Start every change

This kit carries no physics package: a kart lives in track space (a place along the course's centre line plus metres right of it), so walls, surfaces, jumps and the lap counter are plain arithmetic on `src/track/Course.ts` and run the same on every target. `@threenative/physics/navigation` is browser-only WASM and the CPUs need none: they follow the centre line on a lane.


## Commands and map

`src/entities/Kart.ts` owns the feel: `KART_FEEL` is the one table of metres, seconds and ticks (24 m/s 150cc top speed, a throttle that gains less in each tenth of its range, the 0.35 m hop, the 28% drift floor, mini-turbo stages, 80-tick pad and nitro boosts, grass and water drag), each value cited to the MK64 decompilation it was read from; change a number there and the course's pads, jump and walls change their meaning. `Kart.step(input, dt)` is the whole model and reads the same `IKartInput` from the keyboard, the touch layout or a `Driver` (`src/entities/Driver.ts`, the CPU and the player's autopilot on `KeyP`: a look-ahead point on a lane, a lift in tight corners, a power-slide through long bends, the rubber band's `catchingUp` and `coasting`). `src/track/Course.ts` builds the closed centre line one sample per metre, the surfaces by lateral offset, the 11 m walls, the bridge, the jump, the pads, the boxes and the checkpoints; read the road height with `course.heightAt(index, x, z)`, never a fixed y. `src/track/Race.ts` is the lap rule (lap −1 on the grid, a lap only after every checkpoint in order, a backwards crossing takes it back, the −3..+6 index window) and the ranking; `src/entities/Items.ts` the roulette curve by place and the burr and acorn; `src/scenes/Race.ts` registers every kart (`player`, `cpu.1`..`cpu.7`), every pooled item (`burr.0`.., `acorn.0`..), `course`, `effects` and `race` in `load()` so a scenario's `setup.place` reaches them, then runs the countdown, the karts, the boxes, the hits, the finish and the HUD state. `src/render/` is ordinary Three.js and every model in the game: `course.ts` (terrain, road ribbons, kerbs, toy-block walls, bridge, gantry, trees), `kart.ts` (eight original liveries), `items.ts`, `camera.ts` (the chase camera), `effects.ts` (every particle look and the `BURSTS` table, fired through pooled `GPUParticles3D` emitters), `skids.ts`, `sky.ts` and `lighting.ts`; `src/ui/Hud.tsx` is the one HUD. `playtests/` holds one scenario per mechanic (`drift`, `surfaces`, `wall`, `items`, `laps`, `race`) plus `performance`; keep `playtests/survives.playtest.json` as smoke proof (the kart on the road, the core look, the course relief) and `touch-controls.ts`/`touch-layout.ts` aligned with the native playtest.

Play gates: `playtests/explore.playtest.json` drives 7200 ticks of seeded random input and fails on any page error. A new key binding joins `explore`'s `move` or `actions` in the same change.


## Portable authoring contracts

No model here is imported, so there is no authored scale to normalise: the generated scale-and-snap conventions do not apply to this template. Steering is the x of `input.vector("move")` with no keys on its up and down, because a vector is normalised and W held with D would cut the steer to 0.71; the left stick still feeds it. Rigged assets: put a `.glb` in `assets/`, await `ctx.assets.model("driver.glb")` in `Scene.load()`, then drive `AnimationPlayer` beside its entity.

`src/render/sky.ts` builds the sky from `palette.ts` and uses it as both background and environment light, and `lighting.ts` aims the one authored sun and follows the player's kart so its shadow stays sharp. No material backlighting ships: as in a stock Unreal scene, the sun, the sky light and each material's own colour are the whole light. The look's chain is core's, not vendored: `src/render/postprocessing.ts` calls `new WorldEnvironment(qualityPreset(tier))`, and `qualityPreset` in `src/render/quality.ts` is the `@threenative/core` preset plus this game's overrides, each with its reason — it starts empty, so the game gets the stock Unreal 5.8.3 look (`TN_WORLD_ENVIRONMENT` reports the filmic curve and `TN_AUTO_EXPOSURE` the meter), metered at 0 EV by the starter kits' shared `src/render/kitExposure.ts`. Pin `tonemapMode: "aces"`, or `autoExposureEnabled: false` with a fixed `exposure`, there and only there, and say why. `low` casts no shadows; `medium` and `high` draw one 2048² map that follows the player's kart (`lighting.ts`).
