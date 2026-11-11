# Conventions every kit applies

Each convention is on by default, has a named override on the same object, and reports when it is
overridden. The kit `AGENTS.md` lists the ones that kit applies; this page holds the detail, one
anchor per registry row (`conventions.json`).

<a id="look"></a>
## Look

Default: filmic curve, metered auto exposure. Override: `tonemapMode: "aces"`; `autoExposureEnabled: false` + `exposure`. Reports: TN_WORLD_ENVIRONMENT.

The default look is `tonemapMode: "filmic"` with metered auto exposure. Lights are in lux, as in Unreal (EV100 exposure): the sun is 6 lux, and while the meter is off the fixed `exposure` is 2.4. `tonemapMode: "aces"` and `autoExposureEnabled: false` with a fixed `exposure` are the overrides. Set `tonemapMode: "aces"` to choose ACES, or `autoExposureEnabled: false` with a fixed `exposure` to choose manual exposure, on the same quality preset; the render log reports the override. The filmic curve and metered auto exposure are on by default here. Set `tonemapMode: "aces"` or `autoExposureEnabled: false` with a fixed `exposure` on the same preset to override the curve or the meter.

<a id="ao-indirect"></a>
## Ambient occlusion

Default: darkens indirect light only; the sun keeps its light. Override: `gtaoIndirectOnly: false` (whole frame); `gtaoEnabled: false`. Reports: TN_WORLD_ENVIRONMENT.

The contact occlusion (`gtaoEnabled`, on at `high` and `medium`) darkens only the light that reaches a surface from around it: sky, ambient, environment and baked irradiance. A sunlit crease keeps its sunlight, as in Unreal 5.8.3. The owned engine writes each draw's indirect diffuse light to its `indirectDiffuse` target, and the stage takes the occlusion off that share. Set `gtaoIndirectOnly: false` on the quality preset to multiply the whole frame instead. `engine: "threejs"` has no such target, so it needs `gtaoRadius` and multiplies the whole frame.

<a id="quality"></a>
## Quality tier

Default: GPU class picks `high`, `medium` or `low`. Override: `setupPost(..., { tier: "low" })`. Reports: TN_QUALITY_TIER.

Anti-aliasing is core's: 4x MSAA on `high`, SMAA on `medium` and `low`; `temporalAA: true` is the named opt-in. `src/render/exposure.ts` is optional game policy; pass it as `exposurePolicy` in `quality.ts` to use it. `src/render/quality.ts` owns `low`, `medium`, `high`; the GPU family from `ctx.renderer.gpuClass` sets the start (`discrete` `high`, `integrated` and `mobile-high` `medium`, other phones `low`); `isMobile()` chooses `low`, otherwise `high` when the family is `unknown`; override with `setupPost(..., { tier: "low" })`. The native production collector's explicit `--hosted-software` profile selects the existing `low` preset only when no tier override is passed; `TN_QUALITY_TIER` reports `source=hosted-software`. `high` draws 4x MSAA and `medium` and `low` SMAA; `temporalAA: true` is the named opt-in. Unknown tiers throw and `TN_QUALITY_TIER` reports the source. Quality tiers live in `src/render/quality.ts`: `low`, `medium`, `high`; the GPU family from `ctx.renderer.gpuClass` sets the start (`discrete` `high`, `integrated` and `mobile-high` `medium`, other phones `low`); `isMobile()` chooses `low`, otherwise `high` when the family is `unknown`; override with `setupPost(..., { tier: "low" })`.

<a id="resolution"></a>
## Resolution scale

Default: `"auto"`, 0.85 on mobile-low. Override: numeric `resolutionScale`. Reports: TN_FRAME_BUDGET.

WebGPU reports `TN_GPU_CLASS` once per launch. Automatic `render.resolutionScale` starts at 0.85 for `mobile-low`, otherwise 1; a numeric value pins it.

<a id="frame-budget"></a>
## Budget real time for the look

Default: frame meter and scene verdict on. Override: `frameBudget: false`. Reports: TN_FRAME_BUDGET, TN_SCENE_WARNING.

`TN_FRAME_BUDGET` reports the actual scale under both policies. The engine warns you before a human does: `TN_SCENE_WARNING` fires when the GPU used under a third of the frame while the JS render phase ran longer than the display's own period, and names the census behind it — objects considered, draws per pass, triangles per draw, shadow-exempt casters. `performance.playtest.json` pins no frame time: the harness holds every tier to 16.7 ms p95 (60 fps) of the engine's own CPU and GPU cost (plus the frame interval on a real display), and a `TN_SCENE_WARNING` or a `TN_RENDER_PROJECTION` decline fails the run, so answer it by cutting unique geometry or materials.

<a id="aa"></a>
## Anti-aliasing

Default: 4x MSAA on `high`, else SMAA. Override: `temporalAA: true`.

<a id="matrix-world"></a>
## World-matrix walk

Default: visible subtrees only. Override: `renderer.matrixWorld: "all"`. Reports: TN_PROJECTION.

The engine also owns the per-frame world-matrix walk, and by default it does not descend into a hidden subtree — so a game that reads a hidden object's `matrixWorld` directly must use `getWorldPosition` (or call `object.updateWorldMatrix(true, false)`) first; `renderer.matrixWorld: "all"` restores three's every-node walk, and `TN_PROJECTION` reports the visited-node count either way.

<a id="projected-cull"></a>
## Projected-pixel cull

Default: under 0.5 px. Override: `minimumProjectedPixels`; `alwaysRender(obj)`. Reports: TN_RENDER_PROJECTION.

The render camera also skips an object that projects under **0.5 px** in it; `renderer.minimumProjectedPixels` raises that threshold (`false` disables the cut, not the count) and `alwaysRender(object)` exempts an object, while camera-attached objects and shadow casters are kept.

<a id="interpolation"></a>
## Physics interpolation

Default: on for bodies and `ctx.camera`. Override: `physicsInterpolation: false`. Reports: TN_PHYSICS_INTERPOLATION.

Physics bodies and `ctx.camera` interpolate between fixed ticks by default; `physicsInterpolation: false` disables it globally, `body.interpolate = false` disables one body, `ctx.interpolate(object)` opts in another transform, and `ctx.resetInterpolation(object)` resets game-driven teleports (`TN_PHYSICS_INTERPOLATION` reports the setting and tracked count).

<a id="continuous"></a>
## Continuous collision

Default: on for `RigidBody3D`. Override: `continuousCollision: false`. Reports: body.continuousCollision.

For *"a bullet passes through a wall"*, `RigidBody3D` defaults to continuous collision; `continuousCollision` is the named per-body override, and `body.continuousCollision` reports the effective setting on web/native.

<a id="loading"></a>
## Loading

Default: `loadAll` keeps order; `addInSlices` attaches in 8 ms slices. Override: `concurrency`, `sliceSize`, `marker: false`. Reports: TN_LOAD_ALL.

Two loading conventions come from `@threenative/core`, not from your own loops: `loadAll(items, load)` fetches six at a time and returns results **in the input's order** (a pool that pushes returns completion order, so a positional pick lands a different asset every load), and `addInSlices(objects, (object) => ctx.add(object))` attaches in 8 ms slices so hundreds of objects never land in one long frame; override `concurrency`/`sliceSize`, pass `while: () => alive` to stop a torn-down scene without throwing, and `marker: false` silences `TN_LOAD_ALL`/`TN_ADD_SLICES` but never the measurement.

<a id="startup"></a>
## Loading curtain

Default: `ctx.startup.hold(label, () => ready)`. Override: reveal on measured readiness only.

Gate the loading curtain on a measured readiness with `ctx.startup.hold(label, () => ready)`: core polls it every rendered frame, so it settles without a physics step.

<a id="asset-cache"></a>
## Asset cache

Default: on, with idle fill. Override: `assets: { cache: false, backgroundFill: false }`. Reports: ctx.assets.cache.

Assets download on demand and stay on disk between web visits: await everything the spawn camera sees before the reveal, and `await ctx.assets.prefetch(["next-level.glb"])` before `ctx.goto` only for what is out of view (a reveal before the visible content loads shows a half-built world); the idle fill downloads the rest after the reveal. Overrides on `defineGame`'s `assets`: `cache: false`, `backgroundFill: false`, both reported on `ctx.assets.cache`; native hosts read installed files.

<a id="asset-cook"></a>
## Asset cook

Default: compact, shared images. Override: `compact: false`; `assets.exclude`; `assets.budget`. Reports: TN_ASSETS_CONFIG.

Leave `assets` absent: the cook selects target-decodable passes, with `models.sharedImages: true` deduplicating images. `sharedImages: false` embeds duplicate copies; `models.compact` (default `{ flatten: true, join: true, instance: true }`) flattens the scene graph, merges primitives by material and batches a mesh shared by several nodes as `EXT_mesh_gpu_instancing` — all lossless, keeping any node matching `protectedPattern` (or named in `protectedNames`), an animation target, or a skin joint individually addressable; `compact: false` ships the scene graph as authored. `models: "none"` / `textures: "none"` / `audio: "none"` skip those passes and report uncooked bytes. `assets.exclude` defaults to `[]`; source-relative globs (for example `["unused/**"]`) omit matching files and report saved bytes. `assets.budget` accepts `{ uncooked?: number | "none", total?: number | "none" }`, default `{ uncooked: 64_000_000, total: "none" }`: only bytes left uncooked where cooking was possible count toward `uncooked`. Automatic texture cooking retains unaligned source images unchanged and reports `block-size`; those bytes still count toward the uncooked budget. Recipes in the installed create-threenative: `node_modules/create-threenative/agent-docs/references/assertion-reference.md`, `node_modules/create-threenative/agent-docs/references/build-profiles.md`, `node_modules/create-threenative/agent-docs/references/capability-reference.md`, `node_modules/create-threenative/agent-docs/references/capture-the-frame.md`, `node_modules/create-threenative/agent-docs/references/creating-creatures.md`, `node_modules/create-threenative/agent-docs/references/ctx-cookbook.md`, `node_modules/create-threenative/agent-docs/references/debug-surface.md`, `node_modules/create-threenative/agent-docs/references/finding-assets.md`, `node_modules/create-threenative/agent-docs/references/gameplay-recipes.md`, `node_modules/create-threenative/agent-docs/references/menu-screens.md`, `node_modules/create-threenative/agent-docs/references/mobile-memory-budget.md`, `node_modules/create-threenative/agent-docs/references/performance-basics.md`, `node_modules/create-threenative/agent-docs/references/rigging-characters.md`, `node_modules/create-threenative/agent-docs/references/sculpt-from-a-reference.md`, `node_modules/create-threenative/agent-docs/references/trace-a-slow-frame.md`, `node_modules/create-threenative/agent-docs/references/visual-baseline.md`, and `node_modules/create-threenative/agent-docs/references/webview-ui.md`.

<a id="animation-rate"></a>
## Animation rate

Default: `updateRate: "auto"`. Override: `updateRate: 1`. Reports: updateRateReport.

`updateRate: "auto"` is the default and follows measured camera policy; `updateRate: 1` is full evaluation, another positive safe integer names a frame interval, and `updateRateReport` shows the effective rate, override status and latest evaluation; one-shots/fades, public mixer listeners/speed overrides, root-motion `AnimationComposer`, automatic camera-ray targets and camera-parented rigs stay full-rate.

<a id="stride-sync"></a>
## Stride sync

Default: on. Override: `strideSync: false`.

<a id="ground-snap"></a>
## Feet on the floor

Default: `GroundSnap`. Override: `enabled: false`.

Generated conventions call `GroundSnap` for floor contact and `normaliseToMetres` for authored model scale.

<a id="attach"></a>
## Held prop

Default: `attachToBone`. Override: a portable `Bone` named `RightHand`.

<a id="scale"></a>
## One metre is one metre

Default: `normaliseToMetres`. Override: per-call options.

<a id="rigged"></a>
## Rigged assets

Default: `.glb` in `assets/`; `AnimationPlayer` drives clips. Override: `ctx.assets.model("hero.glb")` in `Scene.load()`.

Rigged assets: put a `.glb` in `assets/`, await `ctx.assets.model("hero.glb")` in `Scene.load()`, then drive `AnimationPlayer` beside its entity.

<a id="clip-conformance"></a>
## Clip conformance

Default: measure a clip before rewriting it. Override: `clipPoseError`; `clipTrackBindings`; `clipBoneCoverage`. Reports: boneContact.

`clipPoseError` scores a retargeted clip against its source per bone in degrees — whole quaternions relative to each rig's own bind pose, so the two rigs' bind conventions cancel and a limb rolled about its own axis is caught where a bone-direction check reads zero. `clipTrackBindings` names tracks that bind nothing (the `<bone>.undefined` failure that plays the bind pose instead of the animation), `clipBoneCoverage` names bones the clip does not drive and which therefore keep the previous clip's pose, and `boneContact` reports in metres whether a named bone reaches the prop it is supposed to be touching.

<a id="rough-diffuse"></a>
## Rough diffuse

Default: on. Override: `material.roughDiffuse = false`.

<a id="unlit-foliage"></a>
## Unlit foliage

Default: warns. Override: `material.userData.tnUnlitOk = true`. Reports: TN_UNLIT_FOLIAGE.

Imported foliage (Fab/Megascans cutouts) draws with its own albedo, normal map and alpha cutoff under the environment light `sky.ts` makes — never tint it, fake its emission or flatten its normals to make up for missing light; `TN_UNLIT_FOLIAGE` names cutout materials drawn with no environment. Imported foliage (Fab/Megascans cutouts) draws with its own albedo, normal map and alpha cutoff under the scene's environment light — never tint it, fake its emission or flatten its normals to make up for missing light; `TN_UNLIT_FOLIAGE` names cutout materials drawn with no environment.

<a id="backlight"></a>
## Material backlight

Default: none, as in stock Unreal. Override: `rimGain`; `fillGain`.

Material backlighting lives in `src/render/lighting.ts`: named `rimGain` and `fillGain` controls preserve the authored palette; `materialLighting.ts` reports `TN_ENVIRONMENT_CONTRIBUTION`.

<a id="env-contribution"></a>
## Environment contribution

Default: reported even at zero. Override: `environmentSampling`. Reports: TN_ENVIRONMENT_CONTRIBUTION.

<a id="shadows"></a>
## Shadows

Default: soft by source radius. Override: `penumbraScale`; `VirtualShadowNode` options. Reports: TN_SHADOW_TIER.

<a id="pointer-look"></a>
## Pointer look

Default: captures the canvas on click. Override: `captureOnClick: false` + `ctx.input.captureMouse()`.

Relative look capture: a binding with `pointerRelative: true` captures the canvas on click by default; set `captureOnClick: false` and call `ctx.input.captureMouse()` from your own gesture to opt out.

<a id="static"></a>
## Static scenery

Default: unwritten transforms stay cheap. Override: `markStatic(root)`; `invalidateStatic(obj)`. Reports: TN_RENDERLIST_VALIDATE.

So do not touch a transform you do not need to — that is worth ~7 ms where `markStatic(root)`, which additionally composes a never-moving subtree once, measured 0.009 ms. Use it for scenery you are sure of, and `invalidateStatic(object)` to announce a write inside one; it deletes matrix arithmetic, not the walk. `TN_RENDERLIST_VALIDATE=1` recomputes every world matrix the long way each frame and throws on the first that disagrees, which is how you prove a freeze did not leave something stale on screen.

<a id="spans"></a>
## Frame spans

Default: off. Override: `TN_FRAME_SPANS=1`. Reports: TN_FRAME_SPANS.

`npx threenative doctor` repeats the last verdict and the `DEV_MODE=true` chip shows it on screen (it draws the verdict alone — no frame rate, which reads throttled under a compositor or a virtual display; see `agent-docs/references/performance-basics.md`); `TN_FRAME_SPANS=1` adds the render phase's own span tree when you need to know which part costs the milliseconds.

<a id="spells"></a>
## Spells

Default: every factory ships a stock look. Override: per-call options on `@threenative/core/spells`.

<a id="net"></a>
## Multiplayer

Default: none; unsupported transport rejects. Override: `connect` from `@threenative/core/net` with four limits. Reports: TN_NET_UNAVAILABLE.

For online play only, import `connect` from `@threenative/core/net` with an HTTPS URL and nonempty identity credential; configure `connectTimeoutMs`, `maxReliableMessageBytes`, `maxQueuedReliableBytes`, and `maxQueuedDatagrams` (10s/65,536/1 MiB/256), use `reliable-ordered` for ordered reliable messages and bounded `unreliable` datagrams that may drop, and keep serialization, replication, prediction, interpolation, snapshots and rejoin in this game's `src/` and server. There is no fallback: unsupported WebTransport/native rejects with `TN_NET_UNAVAILABLE`; reference Go server: `packages/runtime-native/examples/webtransport/server`.

<a id="desktop-mode"></a>
## Desktop window

Default: CLI, then `display.fullscreen`, then `window.maximized`. Override: `--windowed`; `--maximized`; `--fullscreen`.

Desktop mode precedence is CLI (`--windowed`, `--maximized`, `--fullscreen`) over `display.fullscreen` over `window.maximized`; with both false, `window.width`/`height` size the normal window.

<a id="cpu-priority"></a>
## CPU priority

Default: game threads first. Override: `display.priority: "normal"`. Reports: TN_PROCESS_PRIORITY.

A shipped native game asks the OS for more CPU than other programs: its game, render and present threads take a higher priority (desktop nice -10, Android nice -4 plus an ADPF hint session) and its own background work (shader compiles, workers, HUD processes) yields. It needs no admin rights; a refused raise is reported, not fatal. `TN_PROCESS_PRIORITY` states what the OS applied. Set `display.priority: "normal"` only when the user asks for the OS default; the web build ignores it.

<a id="terrain"></a>
## Terrain

Default: authored in the game. Override: optional `@threenative/terrain`; `references/terrain-authoring.md`.

For terrain generation or editing, read `node_modules/create-threenative/agent-docs/references/terrain-authoring.md`; install optional `@threenative/terrain`, bake before play, and own its appearance in `src/render/`; test water proximity with its `createSegmentIndex` and steep ground with `slopeQuantile`, never a per-point scan or fixed degrees.

<a id="navigation"></a>
## Navigation

Default: none; browser-only WASM. Override: import `@threenative/physics/navigation` on purpose.

This kit needs no navmesh and imports none, so it runs on every target; adding `@threenative/physics/navigation` would make it web and desktop only.

<a id="gamepad"></a>
## Controller

Default: W3C standard mapping on every pad, radial dead zone `0.2`, and a button press or a decisive stick move claims which pad is read. Override: `gamepadDeadZone: 0` for raw axes. Reports: TN_GAMEPAD.

A game binds standard indices and nothing else: `buttons: [0]` is the south face button on an Xbox pad, an 8BitDo and a Steam Deck, `buttons: [6, 7]` are the triggers, and `ctx.input.vector("move")` reads the left stick. A pad the browser reports without a mapping is normalized from a vendor:product row in `@threenative/core`; a pad nothing knows is ignored and reported once as `TN_GAMEPAD … unmapped`, never read with raw indices, because raw index 0 fires whatever action that device happened to number 0. One pad at a time is read, and it is the one the player last claimed: a button press, or a stick travelling past half tilt. A stick resting past the dead zone claims nothing, and one jittering across it claims nothing either, so a worn pad left on the couch, an idle wheel or a paired-but-idle dongle cannot take the input — at boot or in the middle of a move. The claimed pad keeps the slot while idle, which is what lets its releases be read; a pad that disappears or turns unmapped hands over. At `gamepadDeadZone: 0` a noisy stick does produce claims, which is what raw axes mean. Both sticks carry the radial dead zone: a stick resting at `0.08` reads zero, and one past the zone is rescaled so full tilt is still `1`.

<a id="move-axis"></a>
## Move input

Default: `input.vector("move").y` is +up. Override: one explicit `-move.y` conversion.

`input.vector("move").y` is +up, so forward uses one explicit `-move.y` conversion.

<a id="scene-change"></a>
## Scene change

Default: `ctx.goto(name)` keeps state. Override: `game.goto(name)` resets state.

`ctx.goto(name)` rebuilds without resetting game state; from a frame function `goto` and then `return`; `ctx.state.set({ /* copy this game's initial-state shape */ })` is a partial patch. `game.goto("<scene-name>")` also rebuilds the scene, but it resets the game's state.

<a id="seed"></a>
## Randomness

Default: unseeded. Override: `defineGame({ seed })`.

Seeded randomness is deterministic only when `defineGame({ seed })` is configured.

<a id="engine"></a>
## Engine

Default: owned C++ engine. Override: `engine: "threejs"` only when the user asks. Reports: TN_NATIVE_ENGINE_UNBOUND.

Engine: The owned C++ engine is the default for a new game: the Wasm engine on web and the engine player on desktop. `engine: "threejs"` switches to upstream Three.js only when the user asks for it; it is never a fix for a build error.

<a id="engine-catalog"></a>
## Refused imports

Default: refused `three` imports fail at their line. Override: `createEngineCatalogPlugin({ mode: "warn" })`. Reports: TN_ENGINE_CATALOG.

Refused imports: `createEngineCatalogPlugin()` in `vite.config.ts` reads every `import { … } from "three"`, `"three/webgpu"` and `"three/tsl"` in game source. When the installed Wasm engine refuses a name, the dev overlay and `threenative build` fail at that import line with the code the page would throw at first use (`TN_NATIVE_UNCATALOGUED_<NAME>`, or the catalog entry's own diagnostic). Pick a bound class instead: `engine_search_capabilities` names it. `mode: "warn"` reports instead of failing and prints `TN_ENGINE_CATALOG: warn`. Under `engine: "threejs"` the check is off and prints `TN_ENGINE_CATALOG: off (engine threejs)`. Member and argument gaps of a `partial` entry stay runtime diagnostics.

<a id="general"></a>
## Other portable contracts

### Ownership

ThreeNative owns bootstrap, renderer, fixed-step loop, input, loading, physics bindings, and the state bridge.

### Workflow skills

Confirmed framework bugs: use `file-engine-bug` in `.agents/skills/` or `.claude/skills/` after a minimal repro. A game-side `patches/` fix is temporary: once it is settled, it moves into the engine in one PR. A native build names each unbound import with `TN_NATIVE_ENGINE_UNBOUND`. Android and iOS use the legacy host. This template runs on it: `threenative.config.ts` names no `engine`.

### Portable authoring contracts

Android/iOS currently skip compression and model dedupe. A number sets that ceiling; `"none"` disables both gates. Either disabled gate still reports bytes. An explicit compression codec override must satisfy four-pixel block alignment; `codec: "none"` opts out. Cooking never silently resizes an image to fix alignment. Scenes use `load`, `enter`, `update`, `exit`, `render`; physics nodes are Godot-named and disposable. That smoke tier is not physical performance evidence and does not change an ordinary desktop run. Unknown tiers throw. Keep state values human-readable; the bridge flushes about 100 ms and per-frame feel stays in scene-owned Three.js. When an animation looks wrong, measure it before rewriting it. Scenes use `load`, `enter`, `update`, `exit`, `render`.

### Budget real time for the look

It has Unreal's bloom with no threshold (`unrealBloomEnabled`), local exposure (`localExposureEnabled`, off on `low`), a cosine-fourth vignette (`vignetteAmount: 0.4`) and no camera motion blur (`motionBlurEnabled: true` is the opt-in). The grade is neutral and the frame has no film grain. Each stage has a named override: `unrealBloomEnabled: false` returns to Three's `BloomNode` (`bloomStrength`, `bloomRadius`, `bloomThreshold`), and `vignetteAmount: 0` removes the vignette. For a colour grade or grain, add the starter's `grade.ts` and `public/grade.cube`, then set `gradeIntensity` and `grainIntensity`. It is a scene-shape verdict, so answer it by moving the draw and object counts, not the engine: read the bucket census before promising a merge. The cheapest static object is one whose transform you never write: measured on 1,561 objects, leaving them alone costs 10.10 ms of render phase against 17.45 ms when the game rewrites every transform each frame, because three skips the per-object binding update when nothing changed. Reference-driven authoring starts at `node_modules/create-threenative/agent-docs/references/dream-loop.md`. Open a capture after visual changes. A scenario with no assertions or missing observations fails. Edit `src/render/` directly; `postprocessing.ts` reports stages but decides no game colour. A scenario with no assertions or missing observations fails; open a real capture.

### Optional multiplayer transport

Admission is limited to high hardware desktop WebGPU; mobile/software/WebGL/native retain original materials. Existing authored fill stays authoritative. Core owns adaptation and its readback. Recipe: `node_modules/create-threenative/agent-docs/references/auto-exposure.md`. Fog is height fog: `HEIGHT_FOG` in `src/render/heightFog.ts` (`density`, `heightFalloff`, `fogHeight`, `maxOpacity`, `startDistance`, `sunExponent`, `sunStartDistance`, `cutoffDistance`) is added to the `FogExp2` distance term on `scene.fogNode` and never replaces it, so a streaming fog `far` still holds. Core supplies Unreal filmic and metered defaults through `WorldEnvironment` and `qualityPreset`.
