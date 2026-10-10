# AGENTS.md — __PROJECT_NAME__ minimal
Instructions for the AI agent in this game. This template has no React or Tailwind.
`CLAUDE.md` mirrors this file; edit `AGENTS.md`.

## Ownership
ThreeNative owns bootstrap, renderer, fixed-step loop, input, loading, physics bindings, and the state store. This repository owns `src/render/`, `src/entities/`, and `src/scenes/`; all are
ordinary user code, and nothing in `@threenative/*` reads or chooses their appearance. The render camera also skips an object that projects under **0.5 px** in it; `renderer.minimumProjectedPixels` raises that threshold (`false` disables the cut, not the count) and `alwaysRender(object)` exempts an object, while camera-attached objects and shadow casters are kept. The engine also owns the per-frame world-matrix walk, and by default it does not descend into a hidden subtree — so a game that reads a hidden object's `matrixWorld` directly must use `getWorldPosition` (or call `object.updateWorldMatrix(true, false)`) first; `renderer.matrixWorld: "all"` restores three's every-node walk, and `TN_PROJECTION` reports the visited-node count either way.

## Start every change
1. **Critical planning gate:** invoke `threenative-capabilities` before `prd-creator`. Search
   `engine_search_capabilities` for the full request and each concrete mechanic, inspect relevant
   matches with `engine_capability_detail`, and record a capability or no-match for the plan. Apply the `ponytail` ladder before writing code; never hand-write what the capability search already installs.
2. Then invoke `prd-creator`. Draft the plan around those capabilities and binding constraints,
   direct the user to review it, and wait for explicit approval plus an instruction to implement it.
3. Treat returned constraints as binding. `@threenative/physics/navigation` is browser-only WASM;
   use portable `ctx`/Three.js for this cross-target template.
4. If a build, import, device, or blank frame fails, run `npx threenative doctor` and
   `npx @threenative/playtest doctor`; missing observations are not zero.
For *"a bullet passes through a wall"*, `RigidBody3D` defaults to continuous collision; `continuousCollision` is the named per-body override, and `body.continuousCollision` reports the effective setting on web/native.

## When the framework blocks you, write plain Three.js

When an `@threenative/*` API is broken, missing, or does not do what you need, replace only that
piece with portable Three.js/plain code. Keep the loop, scenes, input, registry, and playtest
bridge; avoid DOM globals, dynamic `import()`, and raw physics handles. **Report what blocked you**
(API, expectation, result, replacement); never stall the game.

## Workflow skills

- `.agents/skills/prd-creator/SKILL.md` / `.claude/skills/prd-creator/SKILL.md` — game plan and approval gate.
- `.agents/skills/threenative-capabilities/SKILL.md` / `.claude/skills/threenative-capabilities/SKILL.md` — capability search.
- `.agents/skills/threenative-playtest/SKILL.md` / `.claude/skills/threenative-playtest/SKILL.md` — diagnosis and proof.
- `.agents/skills/threenative-assets/SKILL.md` / `.claude/skills/threenative-assets/SKILL.md` — assets and sculpting.
- `.agents/skills/threenative-visuals/SKILL.md` / `.claude/skills/threenative-visuals/SKILL.md` — captures and look.
- `.agents/skills/threenative-performance/SKILL.md` / `.claude/skills/threenative-performance/SKILL.md` — measured budgets.
- `.agents/skills/threenative-ui/SKILL.md` / `.claude/skills/threenative-ui/SKILL.md` — native-safe UI.
- `.agents/skills/threenative-context/SKILL.md` / `.claude/skills/threenative-context/SKILL.md` — portable ctx APIs.
- Confirmed framework bugs: use `file-engine-bug` in `.agents/skills/` or `.claude/skills/` after a minimal repro. A game-side `patches/` fix is temporary: once it is settled, it moves into the engine in one PR. Lazy-first: `.agents/skills/ponytail/SKILL.md` / `.claude/skills/ponytail/SKILL.md` — smallest correct change, and its reuse rung is the capability search above.

## Commands and map

```sh
pnpm dev
pnpm build
pnpm build --target desktop
pnpm test
```

`src/main.ts` boots the canvas; `src/scenes/Play.ts` owns the lifecycle; `src/entities/Player.ts`
drives `assets/mannequin.glb` (Quaternius, CC0) through `SkeletalMesh3D`; the arena is one `Group`
handed to `buildStaticColliders`; `render/camera.ts` follows from `afterPhysics`. No HUD;
`playtests/survives.playtest.json` is the durable smoke proof.

On a touch-primary device (`isMobile() && isTouchscreenAvailable()`), the local
`src/render/touch-controls.ts` adds a left movement stick and a right jump button. The scene
passes its returned input to `Player`; keep the keyboard mapping as the desktop fallback.

## Portable authoring contracts

Leave `assets` absent: the cook selects target-decodable passes, with `models.sharedImages: true` deduplicating images. `sharedImages: false` embeds duplicate copies; `models.compact` (default `{ flatten: true, join: true, instance: true }`) flattens the scene graph, merges primitives by material and batches a mesh shared by several nodes as `EXT_mesh_gpu_instancing` — all lossless, keeping any node matching `protectedPattern` (or named in `protectedNames`), an animation target, or a skin joint individually addressable; `compact: false` ships the scene graph as authored. `models: "none"` / `textures: "none"` / `audio: "none"` skip those passes and report uncooked bytes. Android/iOS currently skip compression and model dedupe. `assets.exclude` defaults to `[]`; source-relative globs (for example `["unused/**"]`) omit matching files and report saved bytes. `assets.budget` accepts `{ uncooked?: number | "none", total?: number | "none" }`, default `{ uncooked: 64_000_000, total: "none" }`: only bytes left uncooked where cooking was possible count toward `uncooked`. A number sets that ceiling; `"none"` disables both gates. Either disabled gate still reports bytes. Automatic texture cooking retains unaligned source images unchanged and reports `block-size`; those bytes still count toward the uncooked budget. An explicit compression codec override must satisfy four-pixel block alignment; `codec: "none"` opts out. Cooking never silently resizes an image to fix alignment.

Relative look capture: a binding with `pointerRelative: true` captures the canvas on click by default; set `captureOnClick: false` and call `ctx.input.captureMouse()` from your own gesture to opt out. Desktop mode precedence is CLI (`--windowed`, `--maximized`, `--fullscreen`) over `display.fullscreen` over `window.maximized`; with both false, `window.width`/`height` size the normal window.
Scenes use `load`, `enter`, `update`, `exit`, `render`; physics nodes are Godot-named and disposable.
Generated conventions call `GroundSnap` for floor contact and `normaliseToMetres` for authored model scale.
`input.vector("move").y` is +up, so forward uses one explicit `-move.y` conversion. Rigged assets: put a `.glb` in `assets/`, await `ctx.assets.model("hero.glb")` in `Scene.load()`, then drive
`AnimationPlayer` beside its entity. `ctx.goto(name)` rebuilds without resetting game state; from
a frame function `goto` and then `return`; `ctx.state.set({ /* copy this game's initial-state shape */ })`
is a partial patch. `game.goto("<scene-name>")` also rebuilds the scene, but it resets the game's
state. Seeded randomness is deterministic only when `defineGame({ seed })` is configured.

`src/render/sky.ts` makes `assets/sky.jpg` (Poly Haven, CC0) background, environment light and fog
colour (re-aim `SUN_DIRECTION` when you swap it); WebGPU adds a `VirtualShadowNode`. Imported foliage (Fab/Megascans cutouts) draws with its own albedo, normal map and alpha cutoff under the environment light `sky.ts` makes — never tint it, fake its emission or flatten its normals to make up for missing light; `TN_UNLIT_FOLIAGE` names cutout materials drawn with no environment. `src/render/quality.ts` owns `low`, `medium`, `high`; `isMobile()`
chooses `low`, otherwise `high`; override with `setupPost(..., { tier: "low" })`. Unknown tiers
throw and `TN_QUALITY_TIER` reports the source. `pnpm test` proves behavior, never the look.

When an animation looks wrong, measure it before rewriting it. `clipPoseError` scores a
retargeted clip against its source per bone in degrees — whole quaternions relative to each rig's
own bind pose, so the two rigs' bind conventions cancel and a limb rolled about its own axis is
caught where a bone-direction check reads zero. `clipTrackBindings` names tracks that bind nothing
(the `<bone>.undefined` failure that plays the bind pose instead of the animation),
`clipBoneCoverage` names bones the clip does not drive and which therefore keep the previous
clip's pose, and `boneContact` reports in metres whether a named bone reaches the prop it is
supposed to be touching. Two loading conventions come from `@threenative/core`, not from your own loops: `loadAll(items, load)` fetches six at a time and returns results **in the input's order** (a pool that pushes returns completion order, so a positional pick lands a different asset every load), and `addInSlices(objects, (object) => ctx.add(object))` attaches in 8 ms slices so hundreds of objects never land in one long frame; override `concurrency`/`sliceSize`, pass `while: () => alive` to stop a torn-down scene without throwing, and `marker: false` silences `TN_LOAD_ALL`/`TN_ADD_SLICES` but never the measurement. Gate the loading curtain on a measured readiness with `ctx.startup.hold(label, () => ready)`: core polls it every rendered frame, so it settles without a physics step.

## Budget real time for the look

Reference-driven authoring starts at `node_modules/create-threenative/agent-docs/references/dream-loop.md`.

Open a capture after visual changes. A scenario with no assertions or missing observations fails. The engine warns you before a human does: `TN_SCENE_WARNING` fires when the GPU used under a third of the frame while the JS render phase ran longer than the display's own period, and names the census behind it — objects considered, draws per pass, triangles per draw, shadow-exempt casters. It is a scene-shape verdict, so answer it by moving the draw and object counts, not the engine: read the bucket census before promising a merge. `npx threenative doctor` repeats the last verdict and the `DEV_MODE=true` chip shows it on screen (it draws the verdict alone — no frame rate, which reads throttled under a compositor or a virtual display; see `agent-docs/references/performance-basics.md`); `TN_FRAME_SPANS=1` adds the render phase's own span tree when you need to know which part costs the milliseconds. The cheapest static object is one whose transform you never write: measured on 1,561 objects, leaving them alone costs 10.10 ms of render phase against 17.45 ms when the game rewrites every transform each frame, because three skips the per-object binding update when nothing changed. So do not touch a transform you do not need to — that is worth ~7 ms where `markStatic(root)`, which additionally composes a never-moving subtree once, measured 0.009 ms. Use it for scenery you are sure of, and `invalidateStatic(object)` to announce a write inside one; it deletes matrix arithmetic, not the walk. `TN_RENDERLIST_VALIDATE=1` recomputes every world matrix the long way each frame and throws on the first that disagrees, which is how you prove a freeze did not leave something stale on screen.

For terrain generation or editing, read `node_modules/create-threenative/agent-docs/references/terrain-authoring.md`; install optional `@threenative/terrain`, bake before play, and own its appearance in `src/render/`; test water proximity with its `createSegmentIndex` and steep ground with `slopeQuantile`, never a per-point scan or fixed degrees. Recipes in the installed create-threenative: `node_modules/create-threenative/agent-docs/references/assertion-reference.md`, `node_modules/create-threenative/agent-docs/references/build-profiles.md`, `node_modules/create-threenative/agent-docs/references/capability-reference.md`, `node_modules/create-threenative/agent-docs/references/capture-the-frame.md`, `node_modules/create-threenative/agent-docs/references/creating-creatures.md`, `node_modules/create-threenative/agent-docs/references/ctx-cookbook.md`, `node_modules/create-threenative/agent-docs/references/debug-surface.md`, `node_modules/create-threenative/agent-docs/references/finding-assets.md`, `node_modules/create-threenative/agent-docs/references/gameplay-recipes.md`, `node_modules/create-threenative/agent-docs/references/menu-screens.md`, `node_modules/create-threenative/agent-docs/references/mobile-memory-budget.md`, `node_modules/create-threenative/agent-docs/references/performance-basics.md`, `node_modules/create-threenative/agent-docs/references/rigging-characters.md`, `node_modules/create-threenative/agent-docs/references/sculpt-from-a-reference.md`, `node_modules/create-threenative/agent-docs/references/trace-a-slow-frame.md`, `node_modules/create-threenative/agent-docs/references/visual-baseline.md`, and `node_modules/create-threenative/agent-docs/references/webview-ui.md`.
## Optional multiplayer transport
For online play only, import `connect` from `@threenative/core/net` with an HTTPS URL and nonempty identity credential; configure `connectTimeoutMs`, `maxReliableMessageBytes`, `maxQueuedReliableBytes`, and `maxQueuedDatagrams` (10s/65,536/1 MiB/256), use `reliable-ordered` for ordered reliable messages and bounded `unreliable` datagrams that may drop, and keep serialization, replication, prediction, interpolation, snapshots and rejoin in this game's `src/` and server. There is no fallback: unsupported WebTransport/native rejects with `TN_NET_UNAVAILABLE`; reference Go server: `packages/runtime-native/examples/webtransport/server`.
Material backlighting lives in `src/render/lighting.ts`: named `rimGain` and `fillGain` controls preserve the authored palette; `materialLighting.ts` reports `TN_ENVIRONMENT_CONTRIBUTION`. Admission is limited to high hardware desktop WebGPU; mobile/software/WebGL/native retain original materials. Existing authored fill stays authoritative.
`src/render/exposure.ts` owns optional adaptation (`enabled: false`); `autoExposure.ts` meters even when disabled. Recipe: `node_modules/create-threenative/agent-docs/references/auto-exposure.md`. Fog is height fog: `HEIGHT_FOG` in `src/render/heightFog.ts` (`density`, `heightFalloff`, `fogHeight`, `maxOpacity`, `startDistance`, `sunExponent`, `sunStartDistance`, `cutoffDistance`) is added to the `FogExp2` distance term on `scene.fogNode` and never replaces it, so a streaming fog `far` still holds.
