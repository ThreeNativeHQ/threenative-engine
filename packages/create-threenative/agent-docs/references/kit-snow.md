# Kit notes: snow

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

This repository owns the explorer, the boot print, the glade, the weather, the HUD and the look; `src/game.ts` is portable and React mounts from `src/main.ts`.


## Commands and map

The snow is one `SnowField` (`@threenative/core/world`) over one `Heightfield` built in `src/terrain.ts`: indentation, bank, compaction and disturbance composed into the canonical surface that queries, the drawn mesh and the collider all read. Never keep a second height grid. `attachSnowPhysics` (`@threenative/physics`) owns the snow collider: each fixed step it reads the solver's contacts for the ball, crate and log, presses each body's own shape with its solved load, and installs the changed surface before the next step. Call `step` from `afterPhysics`, once; `observe()` reports `colliderError` and `loadProvenance` (load is a solver estimate). A kinematic `CharacterBody3D` makes no contact load, so `src/entities/Explorer.ts` plants `src/render/bootPrint.ts` itself with `snow.stamp`, only while `grounded`. Its capsule stands on a coarse walk surface (`walkSurface` in `src/terrain.ts`), not the 6 cm snow collider: Rapier sweeps a character against every triangle under it, which cost ~0.9 ms a step there.

Look lives in `src/render/`: `snowSurface.ts` (TSL material, compaction view, redraws each `takeDirtyRegions` window, one upload range per row), `weather.ts` (`GPUParticles3D` snowfall and powder), `explorer.ts`, `scenery.ts`, `props.ts`. Tune response with `depth`/`hardness` and the refill in `src/scenes/Snow.ts`. The React HUD reads `GameState` and sends intents; `src/commands.ts` routes panel verbs into the same functions as the keys. Keep `playtests/survives.playtest.json` as smoke proof and `playtests/snow-physics.playtest.json` honest: it proves drop, settle and rolling track. On a touch-primary device (`isMobile() && isTouchscreenAvailable()`), `src/render/touch-controls.ts` adds a left movement stick; keyboard is the desktop fallback.


## Portable authoring contracts

The fixed step is the snow's clock: deposition, footsteps and contacts never read the frame rate. `input.vector("move").y` is +up and means forward; `Snow.ts` turns it into a camera-relative direction.

Snow keeps 4x multisampling: `temporalAA` is off in `quality.ts`, because the engine draws no velocity for the sprite flakes, and tens of thousands of them could trail. The bridge flushes about 100 ms; keep readouts in state and frame feedback in Three.js.


## Budget real time for the look

`npx threenative doctor` repeats the last verdict and the `DEV_MODE=true` chip shows it beside the frame rate; `TN_FRAME_SPANS=1` adds the render phase's own span tree when you need to know which part costs the milliseconds.


## Optional multiplayer transport

`quality.ts` names one cost override, reported as `TN_RENDER_CHAIN_COST_OVERRIDE`: no final gather, SSGI or SSR, no temporal AA or motion blur, no bloom and no local exposure, because the core gather took the performance scenario to 38.8 ms GPU p95 against 16.7 ms, the GPU-computed flakes carry no velocity for either temporal stage, bloom veils the white glade, and local exposure lifts the explorer's shadows and flattens it against the snow. `exposure.ts` keeps core's meter and sets its exposure compensation per weather (`EXPOSURE_BIAS`: +2 stops clear, none in the blizzard, blended on the eased storm level). `Snow.ts` passes `exposureBias(weather.storm)` to `setExposureBias` on the meter that `setupPost` returns each frame, so the snowfield meters white instead of middle grey and the uniform blizzard fog does not wash out.

Kit facts: WASD or arrows walk (Shift runs), drag orbits, scroll zooms; `F` drops the ball, `G` pushes it, `B` blizzard, `C` camera view, `V` compaction view, `P` auto-explore, `R` clears every footprint, `M` sound; on touch the left stick walks. The crunch and wind clips in `assets/` are generated noise: replace either with a recording.
