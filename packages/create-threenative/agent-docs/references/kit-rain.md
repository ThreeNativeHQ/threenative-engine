# Kit notes: rain

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

ThreeNative owns bootstrap, renderer, fixed-step loop, input, loading, audio lifetimes, and the state bridge. This repository owns the coastal storm: weather presets and easing, the fly camera, the shaders, lightning, sound design and the interface; `src/game.ts` is portable and React mounts from `src/main.ts`.


## Commands and map

`src/state.ts` owns weather validation, the four presets, easing (τ 0.67 s), the flash envelope and the `distance / 343` thunder delay; `src/scenes/Boot.ts` runs the simulation clock, auto-strikes (gated on cloud cover above 0.35) and publishes everything the UI reads. The coast, clouds, rain and bloom/grade are shaders generated from `tools/tempest-*.frag` by `node tools/generate-shaders.mjs`; edit the `.frag`, never a generated `*-shader.ts`. Their named colours and lights live in `src/render/palette.ts`, `sky.ts`, `lighting.ts` and `materials.ts`, the bolt in `lightning.ts`. The coast is one ray-marched screen quad, so it is marked with `alwaysRender`; so are the rain and the bolt, whose quads are projected by their own vertex stage. Sound is three clips baked by `tools/make-storm-audio.mjs` and played through `AudioBus` in `src/audio/storm.ts`; audio starts on a gesture, and pause, mute and tab visibility each hold it. `safe` gates every strike at one door, and `prefers-reduced-motion` turns it on at boot; `state.reducedMotion` publishes that answer for playtests. Keep `playtests/survives.playtest.json` as smoke proof, and `storm`, `lightning`, `reduced-motion` and `tiers` honest when you change what they assert. To build a game on the storm, keep its rules in a plain module and wire them in `src/scenes/Boot.ts`: `strike()` is the one door every strike passes (its distance and thunder delay are in scope), the frame function runs per-step rules after the camera moves, and the round's state is a `GameState` field the UI reads; `Billboard3D` turns world markers to the camera.


## Portable authoring contracts

One world unit is one metre; the camera starts at `(1.8, 2.85, 18)` and `src/render/camera.ts` owns its clamps and speeds; manual input cancels the cinematic orbit. There is no walking actor, weapon or agent here to ground, bind or navigate. `input.vector("move").y` is +up and means forward; use one explicit `-move.y` conversion.

`src/render/quality.ts` owns `low`, `medium`, `high` (the engine chain: no built-in stage at any tier); the GPU family from `ctx.renderer.gpuClass` sets the start (`discrete` `high`, `integrated` and `mobile-high` `medium`, other phones `low`); `isMobile()` chooses `low`, otherwise `high` when the family is `unknown`; override with `setupPost(..., { tier: "low" })`. Rain keeps 4x multisampling: `temporalAA` is off in `quality.ts`, because the study draws its own single post pass. The player's four tiers are `STUDY_TIERS` in the same file. The bridge flushes about 100 ms; a control flushes it at once.


## Budget real time for the look

`npx threenative doctor` repeats the last verdict and the `DEV_MODE=true` chip shows it beside the frame rate; `TN_FRAME_SPANS=1` adds the render phase's own span tree when you need to know which part costs the milliseconds.


## Optional multiplayer transport

Backlight exception: this storm raymarches custom shader lighting in `src/render/lighting.ts`; standard-material `rimGain`/`fillGain` conversion is unqualified. Preserve its authored flash rim and sky fill. The cloud render-target radiance is unknown until sampled; do not claim an environment contribution from `scene.environment`.

This kit keeps both: the storm's own post pass draws bloom, grade, vignette, lens beads and dither (every built-in stage is off, named in `quality.ts`), and the core filmic curve and metered exposure do the tone map. `exposure.ts` caps the meter at +0.8 stop so the storm stays dark, and `postprocessing.ts` scales the weather exposure by 0.85 and `clouds.ts` the flash light on the clouds by 0.3 so the filmic shoulder keeps the bolt visible.
