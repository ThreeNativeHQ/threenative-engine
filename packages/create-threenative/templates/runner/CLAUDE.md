<!-- Generated mirror of AGENTS.md. Do not edit; edit AGENTS.md. -->

<!-- shared: kit-identity -->
# AGENTS.md — __PROJECT_NAME__ (Endless runner, the runner kit)

Three lanes, a track that builds itself ahead of you, and obstacles that end the run. Routing words: endless-runner. `CLAUDE.md` is a copy of this file.
<!-- /shared -->

<!-- shared: kit-router -->
## Authoring flow

Detail for each step: `threenative-capabilities` skill. Do the steps in order. A step with no result records `none: <reason>`. A blank step blocks the next. A hook blocks the first new file under `src/` until step 3 ran for the current prompt (`TN_DISCOVERY_GATE=off` opts out; Codex needs `/hooks` trust).

1. **Kit** (new game only): `engine_search_capabilities {situation: "<the whole request>", scope: "request"}` returns the matching starter kit first. This folder is already a kit.
2. **Mechanics**: per mechanic, `engine_search_references {situation}`, then `engine_reference_detail` on each hit for pinned constants and feel. To see a mechanic move, `engine_watch_reference {query: "<game> <mechanic>"}` returns a contact sheet of real gameplay. Borrow mechanics only: no code, level layouts, character names or art. Cite `file:line`.
3. **Built-ins**: per mechanic, system or symptom, `engine_search_capabilities {situation, scope: "mechanic"}`; rows answer; `engine_capability_detail` only for omitted symbols. Constraints are binding. `verdict: "none"` means the game writes it in `src/`.
4. **Plan** (new game, or a change to several systems): `prd-creator` with the kit, references and built-ins. With a user, wait for explicit approval, then implement. With no user (`claude -p`, a script), record the plan and assumptions, then continue.
5. **Assets**: `asset_search_sources`, the source's search tool, then `asset_download_file`; record source and licence in `CREDITS.md`. Nothing fits: `sculpt_plan`. A rigged GLB: `animation_inspect` (`threenative-assets` skill).
6. **Build**: gameplay in `src/`, look in `src/render/` (`threenative-context` and `threenative-ui` skills). For parallel work, give each subagent one area and its files, then integrate.
7. **Prove**: one fail-closed playtest per mechanic, then `pnpm test` (`threenative-playtest` skill). A fresh judge compares a `--browser-recipe webgpu --headed` capture to the reference image (`threenative-visuals` skill; `node_modules/create-threenative/agent-docs/references/dream-loop.md`).
8. **Report**: the `pnpm dev` URL, `TN_FRAME_BUDGET`, `TN_SCENE_WARNING`, `TN_RENDER_PROJECTION`, and each skipped step with its reason.

A change to an existing game repeats steps 2-3 for that change, then steps 5-8.
<!-- /shared -->

<!-- shared: kit-mcp -->
## MCP servers

`.mcp.json` wires six servers, and a session started in this folder loads them. Their tools can show as deferred: load them with `ToolSearch` `select:` plus the exact names, for example `select:mcp__threenative-engine__engine_search_capabilities,mcp__threenative-engine__engine_capability_detail,mcp__threenative-engine__engine_search_references,mcp__threenative-engine__engine_reference_detail,mcp__threenative-engine__engine_watch_reference`. A session started outside this folder runs `node node_modules/@threenative/core/mcp/call.mjs <server> <tool> '<json>'`; `call.mjs <server>` lists that server's tools.

- `threenative-engine`: before any new mechanic, helper or render stage, and on a slow frame or a wrong image. `engine_search_capabilities`, `engine_capability_detail`, `engine_search_references`, `engine_reference_detail`, `engine_watch_reference`.
- `threenative-assets`: a texture, HDRI, sound or model. `asset_search_sources`, `asset_download_file`, `audio_search_assets`, `mesh_optimize`.
- `threenative-sculpt`: a bespoke mesh or character from a reference image. `sculpt_plan`, `sculpt_spec_gate`, `sculpt_compare`, `sculpt_pass_gate`.
- `threenative-animation`: a rigged GLB with a held prop, foot slide or loop seam. `animation_inspect`, `animation_attach`, `animation_verify`.
- `threenative-terrain`: any terrain, from words. `terrain_generate`.
- `threenative-devtools`: after `npx @threenative/playtest trace` names no cause. `performance_start_trace`, `performance_analyze_insight`.
<!-- /shared -->

## This kit

<!-- shared: kit-files -->
Source in `src/`: `conventions.ts`, `entities/`, `game.ts`, `main.ts`, `physics.ts`, `render/`, `scenes/`, `state.ts`, `track.ts`, `ui/`.
5 scenarios in `playtests/`; `playtests/survives.playtest.json` is the smoke proof.
Exposure policy: `src/render/exposure.ts` (`node_modules/create-threenative/agent-docs/references/auto-exposure.md`).
Kit notes: `node_modules/create-threenative/agent-docs/references/kit-runner.md`.
<!-- /shared -->

`src/track.ts` is a ring of six chunks moved and rewritten, never rebuilt: each chunk's obstacle `InstancedMesh` is built once at a fixed slot count and its matrices are rewritten on recycle.
This repository owns the track, runner, obstacles, dust and HUD.

<!-- shared: kit-commands -->
## Commands

```sh
pnpm dev                     # play in the browser
pnpm test                    # typecheck, lint, format, then every playtest
pnpm build --target desktop  # also: web, android, ios
npx threenative doctor       # build, import, device or blank-frame failure
npx threenative doctor --fix # refresh agent files
```
<!-- /shared -->

<!-- shared: kit-conventions -->
## Conventions

Each is on by default with a named override. Detail: `node_modules/create-threenative/agent-docs/references/conventions.md#<id>`.

- **Look** `#look`: filmic curve, metered auto exposure. Override: `tonemapMode: "aces"`; `autoExposureEnabled: false` + `exposure`. Marker: `TN_WORLD_ENVIRONMENT`.
- **Ambient occlusion** `#ao-indirect`: darkens indirect light only, not the sun. Override: `gtaoIndirectOnly: false`; `gtaoEnabled: false`. Marker: `TN_WORLD_ENVIRONMENT`.
- **Quality tier (`src/render/quality.ts`)** `#quality`: GPU class picks `high`, `medium` or `low`. Override: `setupPost(..., { tier: "low" })`. Marker: `TN_QUALITY_TIER`.
- **Resolution scale** `#resolution`: `"auto"`, 0.85 on mobile-low. Override: numeric `resolutionScale`. Marker: `TN_FRAME_BUDGET`.
- **Budget real time for the look** `#frame-budget`: frame meter and scene verdict on. Override: `frameBudget: false`. Marker: `TN_FRAME_BUDGET`, `TN_SCENE_WARNING`.
- **World-matrix walk** `#matrix-world`: visible subtrees only. Override: `renderer.matrixWorld: "all"`. Marker: `TN_PROJECTION`.
- **Projected-pixel cull** `#projected-cull`: under 0.5 px. Override: `minimumProjectedPixels`; `alwaysRender(obj)`. Marker: `TN_RENDER_PROJECTION`.
- **Physics interpolation** `#interpolation`: on for bodies and `ctx.camera`. Override: `physicsInterpolation: false`. Marker: `TN_PHYSICS_INTERPOLATION`.
- **Continuous collision** `#continuous`: on for `RigidBody3D`. Override: `continuousCollision: false`. Marker: `body.continuousCollision`.
- **Loading** `#loading`: `loadAll` keeps order; `addInSlices` attaches in 8 ms slices. Override: `concurrency`, `sliceSize`, `marker: false`. Marker: `TN_LOAD_ALL`.
- **Loading curtain** `#startup`: `ctx.startup.hold(label, () => ready)`. Override: reveal on measured readiness only.
- **Asset cache** `#asset-cache`: on, with idle fill. Override: `assets: { cache: false, backgroundFill: false }`. Marker: `ctx.assets.cache`.
- **Asset cook** `#asset-cook`: compact, shared images. Override: `compact: false`; `assets.exclude`; `assets.budget`. Marker: `TN_ASSETS_CONFIG`.
- **Animation rate** `#animation-rate`: `updateRate: "auto"`. Override: `updateRate: 1`. Marker: `updateRateReport`.
- **Feet on the floor** `#ground-snap`: `GroundSnap`. Override: `enabled: false`.
- **One metre is one metre** `#scale`: `normaliseToMetres`. Override: per-call options.
- **Rigged assets** `#rigged`: `.glb` in `assets/`; `AnimationPlayer` drives clips. Override: `ctx.assets.model("hero.glb")` in `Scene.load()`.
- **Clip conformance** `#clip-conformance`: measure a clip before rewriting it. Override: `clipPoseError`; `clipTrackBindings`; `clipBoneCoverage`. Marker: `boneContact`.
- **Unlit foliage** `#unlit-foliage`: warns. Override: `material.userData.tnUnlitOk = true`. Marker: `TN_UNLIT_FOLIAGE`.
- **Material backlight** `#backlight`: none, as in stock Unreal. Override: `rimGain`; `fillGain`.
- **Environment contribution** `#env-contribution`: reported even at zero. Override: `environmentSampling`. Marker: `TN_ENVIRONMENT_CONTRIBUTION`.
- **Pointer look** `#pointer-look`: captures the canvas on click. Override: `captureOnClick: false` + `ctx.input.captureMouse()`.
- **Static scenery** `#static`: unwritten transforms stay cheap. Override: `markStatic(root)`; `invalidateStatic(obj)`. Marker: `TN_RENDERLIST_VALIDATE`.
- **Frame spans** `#spans`: off. Override: `TN_FRAME_SPANS=1`. Marker: `TN_FRAME_SPANS`.
- **Multiplayer** `#net`: none; unsupported transport rejects. Override: `connect` from `@threenative/core/net` with four limits. Marker: `TN_NET_UNAVAILABLE`.
- **Desktop window** `#desktop-mode`: CLI, then `display.fullscreen`, then `window.maximized`. Override: `--windowed`; `--maximized`; `--fullscreen`.
- **CPU priority** `#cpu-priority`: game threads first. Override: `display.priority: "normal"`. Marker: `TN_PROCESS_PRIORITY`.
- **Terrain** `#terrain`: authored in the game. Override: optional `@threenative/terrain`; `references/terrain-authoring.md`.
- **Navigation** `#navigation`: none; browser-only WASM. Override: import `@threenative/physics/navigation` on purpose.
- **Controller** `#gamepad`: W3C standard mapping on every pad, radial dead zone `0.2`, and the pad that last moved is the one read. Override: `gamepadDeadZone: 0` for raw axes. Marker: `TN_GAMEPAD`.
- **Move input** `#move-axis`: `input.vector("move").y` is +up. Override: one explicit `-move.y` conversion.
- **Scene change** `#scene-change`: `ctx.goto(name)` keeps state. Override: `game.goto(name)` resets state.
- **Randomness** `#seed`: unseeded. Override: `defineGame({ seed })`.
- **Engine** `#engine`: owned C++ engine. Override: `engine: "threejs"` only when the user asks. Marker: `TN_NATIVE_ENGINE_UNBOUND`.
- **Refused imports** `#engine-catalog`: refused `three` imports fail at their line. Override: `createEngineCatalogPlugin({ mode: "warn" })`. Marker: `TN_ENGINE_CATALOG`.
<!-- /shared -->

<!-- shared: kit-stuck -->
## When the framework blocks you, write plain Three.js

When an `@threenative/*` API is broken, missing, or does not do what you need, replace only that piece with portable Three.js/plain code. Keep the loop, scenes, input, registry, and playtest bridge; avoid DOM globals, dynamic `import()`, and raw physics handles. **Report what blocked you** (API, expectation, result, replacement); do not stall the game.

## Stuck

`npx threenative doctor`, then `npx @threenative/playtest doctor`; a missing observation is not zero. A confirmed engine bug: `file-engine-bug` skill. Smallest correct change: `ponytail` skill. Slow frame: `threenative-performance` skill.
<!-- /shared -->
