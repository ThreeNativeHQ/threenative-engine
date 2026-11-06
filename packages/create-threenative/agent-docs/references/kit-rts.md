# Kit notes: rts

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

ThreeNative owns bootstrap, renderer, fixed-step loop, input, loading, and the state bridge. This repository owns the rules in `src/sim/`, every visible choice in `src/render/`, the scene in `src/scenes/`, and the HUD in `src/ui/`; `src/game.ts` is portable and React mounts from `src/main.ts`. Nothing in `@threenative/*` reads or chooses their appearance, and this kit loads no physics plugin: `src/sim/` does its own collision and A*, which is what makes a match replayable and headless-testable.


## Start every change

`@threenative/physics/navigation` is browser-only WASM; use portable `ctx`/Three.js for this cross-target template.


## Commands and map

`src/sim/` is the whole ruleset — terrain, A*, economy, construction, production, combat, vision and a four-state AI — plain TypeScript with no renderer import, so it runs headless in `pnpm test` and replays from a seed. `src/scenes/Play.ts` steps it on a 0.05 s accumulator inside the engine's frame and reads every gesture through `ctx.input`; `src/render/` draws it (terrain displaced by the simulation's own `terrainHeight`, instanced models per (type, team), selection rings and health bars, fog of war in the terrain material); `src/ui/` is the HUD, the minimap and the command panel, where every order starts as a named intent the scene resolves. `playtests/survives.playtest.json` is the durable smoke proof; `rts-orders`, `rts-build`, `rts-train`, `rts-attack`, `rts-ai-attack`, `rts-pause`, `rts-zoom` and `performance` are the rest.


## Portable authoring contracts

A scene that returns a frame function from `enter()` gets that function instead of `update()`, and it runs on the fixed step, not once per drawn frame: put per-frame work there, and do not expect a variable frame delta.

This kit authors `renderer.resolutionScale: 1` to keep thin infantry, bars and rings at full resolution; use `"auto"` to restore the engine scaler. This readability policy is not an autoscaler fix or a proven FPS gain. `src/render/sky.ts` makes `assets/sky.jpg` (Poly Haven, CC0) the background and sets the fog colour (re-aim `SUN_DIRECTION` when you swap it, and re-tune the fog density: it is set for a 224 m map); there is no environment light, AstraCraft lights with a hemisphere, and `lighting.ts` sizes the sun's shadow window to the frame every frame. The rig is wider than the map at its widest zoom, so `terrain.ts` draws a plain under it (grow it with `ZOOM_RANGE.far` or the horizon goes with it). The battlefield look follows AstraCraft (PRD-765): `ground.ts` paints roads, aprons and pools into one CPU `DataTexture` (no DOM canvas, so it runs native), `environment.ts` puts a mesa on every `game.obstacles` rock plus rubble, scrub and props, one instanced or merged mesh per family. Every model is a custom TSL material, so an instanced batch's geometry is what you see — change `render/models.ts`, not the material. The shared look comes from core through `src/render/quality.ts`; this kit overrides it with `tonemapMode: "aces"`, `autoExposureEnabled: false` and `exposure: 1.02`, the AstraCraft reference look; delete those three keys to return to core's filmic curve and metered exposure. The HUD styles live in `src/style.css` under `.astra-hud`; instanced dark ring and bar backing keeps faction cues legible. Like AstraCraft it has no bloom (`bloomEnabled: false`) and no local exposure, a cosine-fourth vignette (`vignetteAmount: 0.4`), and no camera motion blur. AstraCraft colours are legacy linear values: `legacyColor` in `palette.ts` reads them. Anti-aliasing is core's: 4x MSAA on `high`, SMAA on `medium` and `low`, so units stay sharp while the camera pans. `temporalAA: true` and `motionBlurEnabled: true` are the named opt-ins. `pnpm test` proves behavior, never the look.


## Budget real time for the look

It is a scene-shape verdict, so answer it by moving the draw and object counts, not the engine. `npx threenative doctor` repeats the last verdict; `TN_FRAME_SPANS=1` adds the render phase's own span tree. The cheapest static object is one whose transform you never write, so do not touch a transform you do not need to; `markStatic(root)` freezes a subtree that is sure of and `invalidateStatic(object)` announces a write inside one. The terrain here is the one such subtree. The battlefield's other cost is its *materials*: every distinct material configuration compiles at boot, and boot is what a commander waits through.


## Optional multiplayer transport

`src/render/exposure.ts` supplies the enabled game-owned meter policy through `exposurePolicy` in `quality.ts`.
