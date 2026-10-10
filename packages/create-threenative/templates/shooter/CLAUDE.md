<!-- Generated mirror of AGENTS.md. Do not edit; edit AGENTS.md. -->

# AGENTS.md — __PROJECT_NAME__ first-person town firefight

Instructions for the AI agent in this game. `CLAUDE.md` mirrors this file; edit `AGENTS.md`.

## Ownership

ThreeNative owns bootstrap, renderer, fixed-step loop, input, loading, physics bindings, and the state bridge. This repository owns the town, the soldiers, the rifle, the HUD and the look; `src/game.ts` is
portable, `src/main.ts` is the web-only React mount. The render camera also skips an object that projects under **0.5 px** in it; `renderer.minimumProjectedPixels` raises that threshold (`false` disables the cut, not the count) and `alwaysRender(object)` exempts an object, while camera-attached objects and shadow casters are kept. The engine also owns the per-frame world-matrix walk, and by default it does not descend into a hidden subtree — so a game that reads a hidden object's `matrixWorld` directly must use `getWorldPosition` (or call `object.updateWorldMatrix(true, false)`) first; `renderer.matrixWorld: "all"` restores three's every-node walk, and `TN_PROJECTION` reports the visited-node count either way.

## Start every change

1. **Critical planning gate:** invoke `threenative-capabilities` before `prd-creator`. Search
   `engine_search_capabilities` for the full request and each concrete mechanic, inspect matches
   with `engine_capability_detail`, and record a capability or no-match for the plan. Apply the `ponytail` ladder before writing code; never hand-write what the capability search already installs.
2. Then invoke `prd-creator`. Draft the plan around those capabilities and binding constraints,
   direct the user to review it, and wait for explicit approval plus an instruction to implement.
3. Treat returned constraints as binding. `@threenative/physics/navigation` is browser-only WASM;
   use the direct physics queries already in this kit instead of a navmesh or distance scan.
4. If a build, import, device, or blank frame fails, run `npx threenative doctor` and
   `npx @threenative/playtest doctor`; missing observations are not zero.
For *"a bullet passes through a wall"*, `RigidBody3D` defaults to continuous collision; `continuousCollision` is the named per-body override, and `body.continuousCollision` reports the effective setting on web/native.

## When the framework blocks you, write plain Three.js

When an `@threenative/*` API is broken, missing, or does not do what you need, replace only that
piece with portable Three.js. Keep the loop, scenes, input, registry, and playtest bridge; avoid DOM
globals, dynamic `import()`, and raw physics handles. **Report what blocked you** (API, expectation,
result, replacement); never stall the game.

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
pnpm typecheck
```

Contract: a 105-second round in a procedurally built 84 m waterfront town; 12 hits completes it, zero
health or an expired clock fails it, Enter restarts. Mouse looks, WASD or arrows move, Space or left
click fires, F or right click aims, R reloads, shift sprints, ctrl/C crouches. `src/render/town.ts`
owns the layout — blocks, quay, pier, raised decks, routes, spawns — and every solid in it is both a
collider and a raycast target. `src/entities/` owns the fight: `FpsPlayer` moves, `Rifle` fires and
zeroes, `Enemy` patrols, hears, sees and shoots back, `Target` scores the plates. `src/scenes/Play.ts`
wires them and `src/ui/Hud.tsx` is the only HUD. `playtests/survives.playtest.json` is the durable
smoke proof. The soldiers are `assets/mannequin-combat.glb` (Quaternius UAL, CC0); the hands in
`assets/player-viewmodel.glb` are "Animated FPS hands (rifle animation pack)" by Cransh,
CC-BY-4.0 — https://sketchfab.com/3d-models/animated-fps-hands-rifle-animation-pack-5f2d0ed780a94724b36ab505f7564057.

## Portable authoring contracts

Leave `assets` absent: the cook selects target-decodable passes, and `models.compact` (default `{ flatten: true, join: true, instance: true }`) flattens the scene graph losslessly while keeping any node matching `protectedPattern` or `protectedNames`, an animation target, or a skin joint individually addressable; `compact: false` ships it as authored. `models`/`textures`/`audio`: `"none"` skip those passes and report uncooked bytes, and a codec override must satisfy four-pixel block alignment — `codec: "none"` opts out. `assets.exclude` (source-relative globs) omits files and reports saved bytes. `assets.budget` accepts `{ uncooked?: number | "none", total?: number | "none" }`, default `{ uncooked: 64_000_000, total: "none" }`: only bytes left uncooked where cooking was possible count, an unaligned source image is retained unchanged and still counted, and cooking never resizes one to fix alignment. Android/iOS skip compression and dedupe.
Relative look capture: a binding with `pointerRelative: true` captures the canvas on click by default; set `captureOnClick: false` and call `ctx.input.captureMouse()` from your own gesture to opt out. Desktop mode precedence is CLI (`--windowed`, `--maximized`, `--fullscreen`) over `display.fullscreen` over `window.maximized`; with both false, `window.width`/`height` size the normal window.
First person, four rules: place the camera in the plugin hook after the physics step, never at the end of the frame function, or the eye sits one step behind the body and shots land in the floor on the deck stairs; start every shot at `player.aimRay()`, where the crosshair is, and let `Rifle.converge` lean the weapon to meet it; the trigger takes `pressed` and `justPressed`, because the cooldown makes the cadence and the edge catches a click the harness delivers no other way; `src/render/scale.ts` is the only size table.

Scenes use `load`, `enter`, `update`, `exit`, `render`; physics nodes are Godot-named and disposable. Rigged assets: put a `.glb` in `assets/`, await `ctx.assets.model("hero.glb")` in `Scene.load()`, size it with `normaliseToMetres` at a named joint, drive `AnimationPlayer` beside its entity, and reach a held prop with `attachToBone`. `input.vector("move").y` is +up, so forward uses one explicit `-move.y`. `ctx.goto(name)` rebuilds without resetting game state (from a frame function, `goto` then `return`); `ctx.state.set({ … })` is a partial patch; `game.goto()` rebuilds and resets. Seeded randomness needs `defineGame({ seed })`.
`src/render/sky.ts` makes `assets/sky.jpg` (Poly Haven, CC0) background, environment light and fog colour (re-aim `SUN_DIRECTION` when you swap it); `src/render/quality.ts` owns `low`, `medium`, `high`; `isMobile()` picks `low`, otherwise `high`; override with `setupPost(..., { tier: "low" })`. Unknown tiers throw, `TN_QUALITY_TIER` reports the source, and the bridge flushes about 100 ms — keep score/phase in state, feedback in Three.js. Imported foliage (Fab/Megascans cutouts) draws with its own albedo, normal map and alpha cutoff under the environment light `sky.ts` makes — never tint it, fake its emission or flatten its normals to make up for missing light; `TN_UNLIT_FOLIAGE` names cutout materials drawn with no environment.

When an animation looks wrong, measure it before rewriting it: `clipPoseError` scores a retargeted clip per bone in degrees relative to each rig's own bind pose, `clipTrackBindings` names tracks that bind nothing (the `<bone>.undefined` failure that plays the bind pose), `clipBoneCoverage` names bones the clip does not drive, and `boneContact` reports whether a bone reaches its prop. A soldier reads as a soldier only when every AI state picks a clip that names the action — patrol and chase `Rifle_Walk`, standing aim `Rifle_Idle`, firing `Rifle_Shoot`, crouch `Rifle_Crouch_To_Idle`/`Rifle_Crouch_Walk` (the six `Rifle_*` clips are Mixamo rifle clips retargeted onto the mannequin, and `RIFLE_HOLD` in `Enemy.ts` turns the rifle to each; the soldier's `rightHandContact`/`leftHandContact` are `boneContact` metres, held under 0.05), hit `Rifle_Hit`, dead `Death01` — crossfaded, feet snapped to the floor, body turned into the direction of travel or aim, and tinted so he does not vanish into the white first-person hands.
Two loading conventions come from `@threenative/core`, not from your own loops: `loadAll(items, load)` fetches six at a time and returns results **in the input's order** (a pool that pushes returns completion order, so a positional pick lands a different asset every load), and `addInSlices(objects, (object) => ctx.add(object))` attaches in 8 ms slices so hundreds of objects never land in one long frame; override `concurrency`/`sliceSize`, pass `while: () => alive` to stop a torn-down scene without throwing, and `marker: false` silences `TN_LOAD_ALL`/`TN_ADD_SLICES` but never the measurement. Gate the loading curtain on a measured readiness with `ctx.startup.hold(label, () => ready)`: core polls it every rendered frame, so it settles without a physics step.

## Budget real time for the look — see `node_modules/create-threenative/agent-docs/references/dream-loop.md`

Open a capture after visual changes; a scenario with no assertions or missing observations fails. The engine warns you before a human does: `TN_SCENE_WARNING` fires when the GPU used under a third of the frame while the JS render phase ran longer than the display's own period, and names the census behind it — objects considered, draws per pass, triangles per draw, shadow-exempt casters. It is a scene-shape verdict, so answer it by moving the draw and object counts, not the engine: read the bucket census before promising a merge. `npx threenative doctor` repeats the last verdict; `TN_FRAME_SPANS=1` adds the render phase's own span tree. The cheapest static object is one whose transform you never write: measured on 1,561 objects, leaving them alone costs 10.10 ms of render phase against 17.45 ms when the game rewrites every transform each frame, because three skips the per-object binding update when nothing changed. So do not touch a transform you do not need to — that is worth ~7 ms where `markStatic(root)`, which additionally composes a never-moving subtree once, measured 0.009 ms. Use it for scenery you are sure of, and `invalidateStatic(object)` to announce a write inside one; it deletes matrix arithmetic, not the walk. `TN_RENDERLIST_VALIDATE=1` recomputes every world matrix the long way each frame and throws on the first that disagrees, which is how you prove a freeze did not leave something stale on screen.

For terrain generation or editing, read `node_modules/create-threenative/agent-docs/references/terrain-authoring.md`; install optional `@threenative/terrain`, bake before play, and own its appearance in `src/render/`; test water proximity with its `createSegmentIndex` and steep ground with `slopeQuantile`, never a per-point scan or fixed degrees. Recipes in the installed create-threenative: `node_modules/create-threenative/agent-docs/references/assertion-reference.md`, `node_modules/create-threenative/agent-docs/references/build-profiles.md`, `node_modules/create-threenative/agent-docs/references/capability-reference.md`, `node_modules/create-threenative/agent-docs/references/capture-the-frame.md`, `node_modules/create-threenative/agent-docs/references/creating-creatures.md`, `node_modules/create-threenative/agent-docs/references/ctx-cookbook.md`, `node_modules/create-threenative/agent-docs/references/debug-surface.md`, `node_modules/create-threenative/agent-docs/references/finding-assets.md`, `node_modules/create-threenative/agent-docs/references/gameplay-recipes.md`, `node_modules/create-threenative/agent-docs/references/menu-screens.md`, `node_modules/create-threenative/agent-docs/references/mobile-memory-budget.md`, `node_modules/create-threenative/agent-docs/references/performance-basics.md`, `node_modules/create-threenative/agent-docs/references/rigging-characters.md`, `node_modules/create-threenative/agent-docs/references/sculpt-from-a-reference.md`, `node_modules/create-threenative/agent-docs/references/trace-a-slow-frame.md`, `node_modules/create-threenative/agent-docs/references/visual-baseline.md`, and `node_modules/create-threenative/agent-docs/references/webview-ui.md`. On a touch-primary device, `src/entities/TouchControls.ts` adds a movement stick, a look stick, and fire, aim, reload and crouch pads; the stick pushed to its rim sprints.
## Optional multiplayer transport
For online play only, import `connect` from `@threenative/core/net` with an HTTPS URL and nonempty identity credential; configure `connectTimeoutMs`, `maxReliableMessageBytes`, `maxQueuedReliableBytes`, and `maxQueuedDatagrams` (10s/65,536/1 MiB/256), use `reliable-ordered` for ordered reliable messages and bounded `unreliable` datagrams that may drop, and keep serialization, replication, prediction, interpolation, snapshots and rejoin in this game's `src/` and server. There is no fallback: unsupported WebTransport/native rejects with `TN_NET_UNAVAILABLE`; reference Go server: `packages/runtime-native/examples/webtransport/server`.
Material backlighting lives in `src/render/lighting.ts`: named `rimGain` and `fillGain` controls preserve the authored palette; `materialLighting.ts` reports `TN_ENVIRONMENT_CONTRIBUTION`. Admission is limited to high hardware desktop WebGPU; mobile/software/WebGL/native retain original materials. Existing authored fill stays authoritative.
`src/render/exposure.ts` owns optional adaptation (`enabled: false`); `autoExposure.ts` meters even when disabled. Recipe: `node_modules/create-threenative/agent-docs/references/auto-exposure.md`. Fog is height fog: `HEIGHT_FOG` in `src/render/heightFog.ts` (`density`, `heightFalloff`, `fogHeight`, `maxOpacity`, `startDistance`, `sunExponent`, `sunStartDistance`, `cutoffDistance`) is added to the `FogExp2` distance term on `scene.fogNode` and never replaces it, so a streaming fog `far` still holds.
