# Kit notes: action-rpg

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

This repository owns the dungeon, combat, stats, inventory, persistence, and every visual decision; `src/game.ts` stays portable and `src/main.ts` is the web-only React mount.


## Start every change

`@threenative/physics/navigation` is a browser-only WASM boundary here; use returned subpaths, and `attachToBone` for the blade in `hand_r`. Spells: keys cast `@threenative/core/spells` factories (`createFireball`, `createThunderstrike`, `createGlacialSpike`) through one `SpellWorld` and a `CastPool`; update both each frame. Change a spell only through the named overrides on its factory call. Damage, mana, cooldowns and targets stay in the game: read `cast.pos` and `cast.phase`. `reducedFlashes` caps flashes (WCAG 2.3.1).


## Workflow skills

This template pins `engine: "threejs"` in `threenative.config.ts` because the native engine does not bind some of its imports yet. The pin keeps upstream Three.js on web and the legacy host on desktop.


## Commands and map

Controls: WASD/arrows move; Space/F attacks; E casts Arcane Surge; Shift rolls; Q/U equips or unequips; P/L tests inventory; T defeats the visible enemy; C/R checkpoints; H/X damage or defeat. Three rooms lead through two doorways to a boss win or zero-health loss. `StatBlock.ts` and `Inventory.ts` are game-owned; use `intersectShape` for range, `intersectRay` for line of sight.

Every figure is `assets/mannequin-combat.glb` — hero, raiders and boss alike — instanced through `SkeletalMesh3D` in `src/entities/Fighter.ts`: `requiredClips` fails the load by name, `normaliseToMetres(model, { axis: "height", metres: 1.545 })` puts the `Head` joint where a 1.8 m capsule expects it, hostiles are the same rig in a red-orange material, and the boss the same rig at 1.3x. Actions play the file's own clips — `Sword_Attack`, `Spell_Simple_Shoot`, `Punch_Jab`, `Hit_Chest`, `Death01`, `PickUp_Table`, `Roll` — and a corpse keeps its entity registered so its death clip finishes. `src/scenes/Play.ts` wires the loop and hands each room `Group` from `src/render/dungeon.ts` to `buildStaticColliders`; `src/entities/` owns gameplay, `src/render/` the look, `src/ui/` React, and `state.ts` publishes JSON-safe health, room and inventory. Keep `playtests/survives.playtest.json` as the smoke proof and update the other scenarios with gameplay. The state bridge flushes about 100 ms, so per-frame feedback stays in scene-owned Three.js.

On a touch-primary device, `src/render/touch-controls.ts` adds a left movement stick, attack and Arcane Surge buttons; keyboard controls remain available on desktop.


## Portable authoring contracts

Scenes use `load`, `enter`, `update`, `exit`, `render`; physics nodes are Godot-named and disposable; generated conventions call `GroundSnap` for floor contact, `normaliseToMetres` for authored model scale, and `attachToBone` for held props. Register testable entities with `ctx.entities`; `input.vector("move").y` is +up, so forward uses one explicit `-move.y` conversion. Rigged assets: put a `.glb` in `assets/`, await `ctx.assets.model("hero.glb")` in `Scene.load()`, instance with `SkeletalMesh3D` to clone safely and validate clips, then call `character.update(dt)` from the owning scene's `update(dt)`. `attachToBone` re-parents a game-owned mesh to a named joint, so the hand moves the sword in every clip for free; the model faces +Z, so `facingVector` is `(sin, 0, cos)` of `figure.rotation.y`. `game.goto("<scene-name>")` also rebuilds the scene, but resets the game's state.

`AnimationPlayer` re-times a looping clip to the ground the body covers so feet do not skate — in-place clips too, off a planted foot; a speed past what the clip carries is **clamped at 3x**, so set it near `player.stride.clipGroundSpeed`. `strideSync: false` opts out, `maxFootSlide` bounds it. `clipPoseError` scores a retarget against its source per bone in degrees — whole quaternions relative to each rig's bind pose, so bind conventions cancel and an axis-rolled limb is caught where a bone-direction check reads zero. `clipTrackBindings` names tracks that bind nothing (`<bone>.undefined`, which plays the bind pose), `clipBoneCoverage` names bones the clip does not drive, which keep the previous clip's pose, and `boneContact` reports in metres whether a bone reaches its prop.


## Budget real time for the look

`src/render/` is yours to edit and is where the base look lives: the prototype test scene, a metre grid in world UVs over a light floor and a dark structure, `palette.ts`'s five roles with exactly one saturated `accent` for anything you can touch, Unreal's default sky behind everything (`sky.ts`; `SKY_OPTIONS` takes `sky: "photo"` for the photograph), and bevelled `RoundedBoxGeometry` sunk by its bevel radius. Torch point lights are the only warm light. `quality.ts` defines `low`, `medium`, and `high`; the GPU family from `ctx.renderer.gpuClass` sets the start (`discrete` `high`, `integrated` and `mobile-high` `medium`, other phones `low`); `isMobile()` chooses `low`, otherwise `high` when the family is `unknown`, and `setupPost(..., { tier: "low" })` is the named override — unknown tiers throw and `TN_QUALITY_TIER` reports the source. The shared look comes from core through `src/render/quality.ts`, and `neutralLook` there names this kit's overrides: ACES at a fixed `exposure` of `0.62 * Math.PI` (0.62 was picked under a 6 x pi sun) with the kit's bloom and occlusion, the neutral look the owner chose over core's filmic curve and metered exposure (delete a line to take core's value back). `src/render/exposure.ts` holds this game's meter policy (`maxStops` 0.3, `minStops` -2, so shaded walls keep their depth). The preset also names one cost override, `finalGatherMethod: "none"` with `ssgiEnabled: false` and `ssrEnabled: false`, because the volumetric atmosphere already owns the frame (the render log reports it as `TN_RENDER_CHAIN_COST_OVERRIDE`). Set `tonemapMode: "aces"` to choose ACES, or `autoExposureEnabled: false` with a fixed `exposure` to choose manual exposure, on the same quality preset. VFX appearance belongs in `src/render/vfx.ts`: keep its TSL material, geometry, colour, blend, curves, timing and capacity there; gameplay creates `GPUParticles3D` once, adds it with `ctx.add`, and calls `emitParticle({ count, origin })` from the real attack, hit or Arcane Surge path. A burst gets its own world-space ring slots, so an older burst keeps flying; `process` reads age from `buffers.births`. An emitter the camera cannot see for a second pauses by default: it stops simulating and drawing, and a burst that expires meanwhile stays gone. `onCull` in `vfx.ts` also takes `"clear"` (restart on return); `graceSeconds: Infinity` disables the cull for one emitter.

A scenario with no assertions or missing observations fails; keep the durable smoke proof and open a capture.
