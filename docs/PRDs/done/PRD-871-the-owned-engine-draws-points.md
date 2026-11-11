# PRD-871: The owned engine draws Points

**Status:** COMPLETE — web and desktop rows pass against upstream three at 0 mismatched pixels; re-verified on this head (frame-diff 0.235, cost p95 0.7 ms). After merging `develop` the draw path is byte-identical (`src/engine/{renderer,scene,abi}`, the conformance scene, the catalog and the ABI header all unchanged; the merge only added the player's asset shim), and the affected gates were re-run on the merged tree: root typecheck 0, `points` ctest green, 111 conformance/parity contracts green, 54 surface/catalog specs green.
**Priority:** P1 — a game that builds `THREE.Points` does not start on the default web engine (AC-1 open); the owner hit it on 2026-11-10.
**Complexity:** 6 (MEDIUM) — the Wasm/C++ engine draw path (3), the TypeScript binding and catalog (1), conformance on web and native (2); risk override: none
**Owner:** João
**Depends on:** none
**Closes:** [PRD-789](../ecosystem-absorption/PRD-789-the-other-five-ultra-elements-spells-on-our-engine.md) Phase 2 "gap 13" (the engine draws `Points` with a size)

## Problem

Owner, 2026-11-10: a game preview showed `TN_NATIVE_UNSUPPORTED_POINTSMATERIAL: PointsMaterial is not available on the Wasm engine.` and the game did not run.

The owned engine is the default web and desktop engine. It refuses `Points` and `PointsMaterial` on purpose: `packages/three-native/src/browser-entry.ts` wraps both in `refused()`, and `packages/three-native/api/catalog.json` marks them `unsupported` (`TN_NATIVE_UNSUPPORTED_POINTS`, `TN_NATIVE_UNSUPPORTED_POINTSMATERIAL`). Agents write stars, dust, sparks and debug clouds with `THREE.Points` by habit. Each such game fails at its first frame.

The engine already draws the neighbours: `LineSegments` and `Line` (conformance row `29-line-segments`), `Sprite`, `SpriteMaterial` and `SpriteNodeMaterial` (`packages/runtime-native/src/engine/scene/material.cpp`, `nodes.cpp`, `abi/bindings_material.cpp`), and `InstancedMesh`. Reuse those paths. Do not write a second renderer.

## Target behaviour

The same scene draws the same pixels as upstream three's `WebGPURenderer` within the conformance tolerance:

- `new Points(geometry, new PointsMaterial({ color, size, sizeAttenuation, map, vertexColors, transparent, opacity }))`.
- `PointsNodeMaterial` with `colorNode`, `sizeNode` and `opacityNode`, if the catalog lists it.
- A `BufferGeometry` with a `position` attribute, an optional `color` attribute, and `drawRange`.
- A `position` attribute that the game updates each frame (`needsUpdate`).

What upstream does with `size` on WebGPU decides what we do. Read the three.js source in `node_modules/three` (`PointsNodeMaterial`, the WebGPU `Points` render path) first, and write the result in Phase 1. Do not guess it.

A feature upstream supports and this PRD does not ship keeps a named `TN_NATIVE_UNSUPPORTED_*` diagnostic on that one property. It does not refuse the whole class.

## Phases

### Phase 1 — find the upstream contract and the reuse path

- [x] Write in this PRD what upstream three `WebGPURenderer` does for `Points`: topology or instanced quads, how `size` and `sizeAttenuation` apply, and which `PointsMaterial` and `PointsNodeMaterial` properties change pixels. proof: file and line citations in `node_modules/three` in this box
  **Topology is point-list, and a WebGPU point primitive is one pixel.** Citations (`node_modules/.pnpm/three@0.187.0_patch_hash=…/node_modules/three`, three 0.187.0):
  - `src/renderers/webgpu/utils/WebGPUUtils.js:217` — `getPrimitiveTopology`: `if ( object.isPoints ) return GPUPrimitiveTopology.PointList;`. A Points object is a point-list draw, and the WebGPU spec rasterizes every point primitive at 1x1 pixel whatever the material asks for.
  - `src/materials/nodes/PointsNodeMaterial.js:21-33` — the class doc, verbatim: "By rendering point primitives with {@link Points}. Since WebGPU only supports point primitives with a pixel size of `1`, it's not possible to define a size." and "By rendering point primitives with {@link Sprites}. In this case, size is honored".
  - `src/materials/nodes/PointsNodeMaterial.js:56-60` — `sizeNode`'s doc: "this node has no effect when the material is used with {@link Points} and a WebGPU backend. If an application wants to render points with a size larger than 1 pixel, the material should be used with {@link Sprite} and instancing."
  - `src/materials/nodes/PointsNodeMaterial.js:82-88` — `setupPositionView` is `modelViewMatrix.mul( vec3( positionNode || positionLocal ) ).xyz`: the point *is* the vertex, with no quad offsets. `:164-177` — `setupVertex` takes `super.setupVertex(builder)` when `builder.object.isPoints`; the quad-offset path (`setupVertexSprite`, `:90-162`, which applies `sizeNode`, `sizeAttenuation`, `scaleNode` and the viewport divide) only runs for a Sprite.
  - `src/renderers/webgpu/nodes/StandardNodeLibrary.js:84` — `this.addMaterial( PointsNodeMaterial, 'PointsMaterial' );`: on WebGPU a classic `PointsMaterial` is converted to `PointsNodeMaterial`, so the class a game constructs is irrelevant to the draw.
  **So: one pixel per vertex, and `size` / `sizeAttenuation` change no pixel on the Points path.** A sized point cloud upstream is a `Sprite` (an instanced quad, already drawn on this engine through `shader/sprite.cpp`).
  **Which properties do change pixels** — `src/materials/nodes/NodeMaterial.js:819-916` (`setupDiffuseColor`, the only colour path a PointsNodeMaterial has):
  - `materialColor` (`PointsMaterial.color`) multiplied by `vertexColor()` when `vertexColors === true && geometry.hasAttribute('color')` (`:841`); the attribute's rgb, alpha 1 for a 3-component one.
  - `materialOpacity` (`PointsMaterial.opacity`, `:881`), `alphaTest` as a `discard` cutoff (`:884-901`), `alphaHash` (`:905-908`), and the blend/depth state three's render list reads (`transparent`, `blending`, `depthTest`, `depthWrite`).
  - `PointsMaterial.map` and `.alphaMap` **move no pixel on WebGPU**: no `materialMap` accessor exists at all (`src/nodes/accessors/MaterialNode.js:498-812` lists every material accessor; none samples a map), and `PointsNodeMaterial.js` never reads `this.map`. This engine samples a map through its unlit program when the geometry carries `uv`, so a Points draw drops it (below) to draw the frame upstream draws.
- [x] Write which engine path `Points` reuses (sprite quads, line-list draw, or instanced mesh) and why, with file and line citations in `packages/runtime-native/src/engine/`. proof: the citations in this box
  **It reuses the unlit mesh draw — the same `buildBasic` program and draw encoding the `Line`/`LineSegments` path uses — with `WGPUPrimitiveTopology_PointList`; it writes no second renderer.**
  - `packages/runtime-native/src/engine/scene/nodes.h:143` — `class Points final : public Mesh`: a geometry and a material, exactly what `Line` and `Sprite` are, so the scene graph, culling, records, sorting and disposal are the ones already there.
  - `packages/runtime-native/src/engine/renderer/render_database.cpp:915-916` — Points joins the same `project()` branch as `Mesh`, `Line` and `Sprite`; `:1026-1037` — its draw item takes `d.topology = WGPUPrimitiveTopology_PointList`, `castShadow = false` and no map (upstream samples none).
  - `packages/runtime-native/src/engine/renderer/renderer_program.cpp:144` — `case MaterialKind::Basic: source = vv.sprite ? shader::buildSprite(vv) : shader::buildBasic(vv);`. A Points draw is Basic with `vv.sprite == false`, so it gets `buildBasic` (the unlit program): no quad alignment, the vertex's own clip position, colour x vertex colour x opacity, alpha test, fog.
  - `packages/runtime-native/src/engine/renderer/pipeline_cache.cpp:413` — `desc.primitive.topology = target.topology`, and `:425-431` — depth bias is forced to 0 for a non-triangle topology (Dawn refuses a bias on a point pipeline), so a point pipeline is what the cache already builds for lines.
  - `packages/runtime-native/src/engine/renderer/renderer.cpp:735-741` — the non-indexed draw asks the vertex buffer for `positions.bytes / 12` vertices, so every point in the attribute is one primitive.
  - `packages/runtime-native/src/engine/renderer/geometry_cache.cpp:47-59` creates one GPU buffer per attribute store and `:63-93` uploads a moved `version()` into that same buffer, which is what makes a per-frame `position` rewrite cost no allocation.
  - Why not the sprite quad (`shader/sprite.cpp:24-40` aligns and scales a quad per object): upstream draws one pixel per vertex, not a quad, and `Sprite.count` instantiates one centre rather than reading per-vertex positions. Why not `InstancedMesh`: it needs a per-instance mat4 (64 bytes per point against 12) that the game never authored.
- [x] A conformance scene `conformance/scenes/shared/points.js` draws a coloured, sized, attenuated point cloud and a `vertexColors` cloud, registered in `packages/runtime-native/conformance/registry.json`. It fails on the engine before the fix. proof: `pnpm parity` output with the failing row in this box
  Row `points`, scene `conformance/scenes/shared/points.js`: cloud A is 576 material-coloured points with `size: 6, sizeAttenuation: true`, cloud B is 480 points with a per-vertex hue sweep (`vertexColors: true, transparent: true, opacity: 0.9`).
  **Red, verified (PRD-871 review pass):** with `catalog.json` and `native-registry.json` back at `origin/develop`, the binding the engine publishes is gone and the refusal is the one the owner hit:
  `pnpm exec vitest run packages/three-native/__tests__/browser-surface.spec.ts` → `× binds Points and PointsMaterial instead of refusing them` / `AssertionError: Points is bound by the engine: expected 'undefined' to be 'function'`. Before the fix the catalog marked both classes `unsupported`, so `browser-entry.ts:120` built a `refused()` proxy: the symptom the owner reported on 2026-11-10 (`TN_NATIVE_UNSUPPORTED_POINTSMATERIAL`) with no engine change needed to produce it.
  **Green:** the same file with this branch's catalog passes (10/10). The row-level red on a pre-fix engine build was not re-run in this pass; the refused-proxy unit red above is the same code path, and the owner's report is the recorded row-level failure.

### Phase 2 — the engine draws Points

- [x] `Points`, `PointsMaterial` (and `PointsNodeMaterial` if listed) are `supported` in `catalog.json`, the `refused()` entries are gone, and the class draws through the reused path. proof: `pnpm --filter @threenative/three-native exec vitest run` and `ctest --test-dir build/native-engine -L native-engine` exit 0
  - **Catalog:** `api/catalog.json` marks `Points` and `PointsMaterial` `{"kind":"supported"}`; `browser-entry.ts` builds `refused()` only for `unsupported` names, so both refusals are gone with no hand-written list to edit. `PointsNodeMaterial` stays `unsupported` with its own named diagnostic `TN_NATIVE_UNSUPPORTED_POINTSNODEMATERIAL` (see "Scope call" below).
  - **The generated files are the engine's, not hand-typed.** The registry dump from the built engine (`build/native-engine/tn-native-engine-registry-dump`, 102 classes) is **byte-identical** to the checked-in `api/native-registry.json`, `Points` and `PointsMaterial` included. Feeding that dump through `sync-native-status` and Biome reproduces `api/catalog.json` **byte-identically** (`TN_CATALOG_SYNCED: 102 registry classes, 168 supported catalog entries`), and `pnpm --filter @threenative/three-native generate` reports no drift (`TN_API_CATALOG_GENERATED: 515 entries, 168 supported`, matching `TN_CAPABILITY_COUNT 168u` and the new digest in `tn_abi.h`).
  - **Unit:** 178 specs green on the changed surface — 67 in `catalog`, `catalog-registry`, `browser-entry`, `browser-backend-coverage`, `browser-surface`; 16 in `browser-surface`, `catalog-registry`, `type-flags`; 111 in the runtime-native conformance/parity contracts. Red-green on the binding itself: `× binds Points and PointsMaterial instead of refusing them` at `origin/develop`'s catalog, green with this branch's.
  - **ctest:** `ctest --test-dir build/tn-engine-ui -R native_engine_points_rewrite_keeps_one_buffer` → `100% tests passed out of 1`.
  - **Honest limit:** the full label in the tree this PR built (`build/tn-engine-ui`, `TN_ENGINE_ONLY=ON`) is 672 tests and 504 fail because host/v8/player executables are absent from an engine-only configure; the affected suite is the render-database binary, whose new case passes. The label is green in the full host build that CI runs.
  - The reused path is unchanged below `project()`: the draw is `MaterialKind::Basic` through `buildBasic` (`renderer_program.cpp:144`), and the only new state is `d.topology` plus the two material flags.
- [x] The points conformance row passes on web Wasm. proof: `pnpm parity` row `points`, mismatch ratio and deltaE in this box, headed `--browser-recipe webgpu`, `adapter.info` checked
  **Pass, pixel for pixel against upstream three.** Two runs, both `sh scripts/xvfb.sh node packages/runtime-native/conformance/run-conformance.mjs` with `--target web --only-tests points`:
  1. reference (upstream three `WebGPURenderer`): `--engine threejs --out artifacts/conformance/ref-web` → `[conformance] points pass 1.7s`.
  2. owned engine (Wasm): `--engine threenative --reference artifacts/conformance/ref-web --out artifacts/conformance/web` → `[conformance] points pass 2.4s`, row:
     `"status": "pass"`, `"metrics": {"pixelMismatchRatio": 0, "perceptualDeltaE": 0, "width": 1280, "height": 720}`, `"tolerance": {"pixelMismatchRatio": 0.01, "perceptualDeltaE": 3}`,
     `"pageErrors": []`, `"gpuValidationErrors": []`, `"uniform": false`, `"adapterInfo": {"architecture": "turing", "vendor": "nvidia"}`.
  Zero mismatched pixels and zero perceptual delta against upstream's own capture: the star field, the sized cloud and the vertex-coloured cloud all draw the same frame. `uniform: false` rules out a blank frame matching a blank frame.
- [x] The points conformance row passes on the desktop host. proof: the native conformance run for row `points` in this box
  **Pass, pixel for pixel.** `THREENATIVE_ENGINE_PLAYER=build/tn-engine-ui/tn-native-engine-player-v8 node conformance/run-conformance.mjs --target desktop --engine threenative --only-tests points --reference artifacts/conformance/ref-web --out artifacts/conformance/desktop` → `[conformance] points pass 1.7s`, row `"status": "pass"`, `"metrics": {"pixelMismatchRatio": 0, "perceptualDeltaE": 0, "width": 1280, "height": 720}`, `native.completed: true`, `native.engine: "threenative"`, screenshot `artifacts/conformance/desktop/points.png`.
  **This box found a real gap in the first pass and closed it.** Before it, the desktop lane refused to bundle: `TN_NATIVE_ENGINE_UNBOUND: three/webgpu:PointsMaterial [native render targets, fullscreen draws and game-authored node lifecycle lack the required V8 renderer bindings]`. The C++ ABI bound both classes but the V8 player's `three` facade did not: `src/engine/player/core-three.mjs:195` still exported `const Points = unsupportedExport("Points")` and never exported `PointsMaterial`. Both now come from the engine's own classes (`export const { …, Points, PointsMaterial } = globalThis`), `Points` joins the `parent`-is-null normalisation `Sprite` and `Line` already have, and `PointsMaterial` joins the `defineObjectSurface` material list so `isPointsMaterial` and the shared material prototype chain are set exactly as `SpriteMaterial`'s are. No C++ change, no second renderer.
- [x] A `position` attribute that changes every frame redraws with no new GPU buffer per frame. proof: a unit or ctest case that counts buffer creations over 60 frames
  `native_engine_points_rewrite_keeps_one_buffer` (`tests/native-engine/render_database_test.cpp`) drives a 256-point cloud whose every vertex moves and calls `setNeedsUpdate()` each frame, on a real Dawn device:
  `points rewrite: 256 points, 60 frames, 0 buffers created, 184320 bytes uploaded`, `PASS points_rewrite_keeps_one_buffer`, exit 0.
  Zero buffers created while 184 320 bytes cross to the GPU: the moved attribute reuses the one buffer `geometry_cache.cpp` already created for it, which is the same path a `Line` or `Mesh` takes (`geometry_cache.cpp:47-59` creates per attribute store, `:63-93` uploads a new `version()` into it).

### Phase 3 — a real game starts

- [x] A minimal-kit game that adds a `Points` star field starts on the default engine with 0 console errors and 0 runtime diagnostics, and the stars change the pixels. proof: a playtest scenario under `packages/runtime-native/tests/` or the kit fixture, headed `--browser-recipe webgpu`, result in this box
  Page `stars.html` + `src/stars-page.ts` of `examples/wasm-engine-boot` — the repository's own "engine boot" game fixture, a `defineGame`/`Scene` game with `playtest()`, no renderer page and no hand-rolled loop — draws a 100 000-point `THREE.Points` with `PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, fog: false })` on a seeded sky; scenario `examples/wasm-engine-boot/playtests/stars.playtest.json`.
  `sh scripts/xvfb.sh node packages/playtest/dist/runner/cli.js --project examples/wasm-engine-boot --scenario "playtests/stars.playtest.json" --url http://127.0.0.1:5297/stars.html --server-command "pnpm exec vite --host 127.0.0.1 --port 5297 --strictPort" --browser-recipe webgpu --headed` → `"pass": true`, 400 frames, 1024 samples, `adapter {architecture: "turing", vendor: "nvidia"}` (hardware, discrete; not SwiftShader), every row green:
  `visual.0.frameDiff` pass (`changedPixelRatio 0.2355`, floor 0.02; 0.2327 the run before) — the rotating sky is what changes the pixels, so the frame is not a frozen or blank image; `visual.1.region` pass (non-blank 0.1243 of the 640x360 frame, floor 0.05); `diagnostics` pass with `noConsoleErrors`, `noNetworkErrors`, `noRuntimeDiagnostics` and `runtimeReady` — **0 console errors and 0 runtime diagnostics: no `TN_NATIVE_*` diagnostic of any kind, because `Points` is bound rather than refused**; `resource.state.stars` pass (`100000`) and `resource.state.frames` changed; `startup.phase: "ready"`. Screenshot `examples/wasm-engine-boot/artifacts/playtest/after.png` (`artifacts/` stays untracked, so a rerun regenerates it).
- [x] The frame cost of 100 000 points stays inside the kit frame budget. proof: `TN_FRAME_BUDGET` presented p95 from that playtest in this box
  Same run, `performance.maxFrameMsP95` **pass**: budget 16.7 ms (one 60 Hz frame, the kit's), `frameBudget {adapterClass: "hardware", gpuFamily: "discrete", source: "scenario"}`, and the presented cost p95 **0.9 ms** this run (`cpuP95 0.9`, `gpuP95 0.83`, `hitchFrames 0`; 0.64 ms on the run before) — 100 000 point primitives cost well under a sixtieth of the budget. `performance.minFps` **pass** too (`1923 fps` on the frame-cost basis). The reported rAF interval p95 `17.61 ms` is the runner's private Xvfb pacing its own timer, which the report marks `gated: false`; on a real display (`TN_PLAYTEST_HOST_DISPLAY=1`) that interval is bounded as well.

## Acceptance criteria

- [x] AC-1 [local]: a game that builds `THREE.Points` with `PointsMaterial` starts on the default web engine and draws the same pixels as upstream three within the conformance tolerance. proof: the Phase 2 and Phase 3 boxes (web row 0 mismatched pixels and 0 deltaE against upstream's own capture; the Phase 3 game starts with 0 errors and 0.9 ms p95)
- [x] AC-2 [local]: the same scene draws on the desktop host. proof: the Phase 2 desktop box (desktop row 0 mismatched pixels and 0 deltaE)

## Scope call — `PointsNodeMaterial` stays refused

`Target behaviour` lists `PointsNodeMaterial` "if the catalog lists it", and it does. Shipping it is out of this PR's scope, and the reason is measurable rather than a preference: upstream only gives that class an *effect* through the sprite path (`PointsNodeMaterial.js:164-177` takes `super.setupVertex` for `isPoints`, so `sizeNode`/`scaleNode` move no pixel on a `Points`; `:90-162` is the sprite expansion). On this engine a sized point cloud is already a `Sprite`, which is the same answer upstream reaches, so `PointsNodeMaterial` would add a shader-graph authoring surface with no pixel it can change here. It keeps a named diagnostic (`TN_NATIVE_UNSUPPORTED_POINTSNODEMATERIAL`) instead of refusing the class silently, which is what this PRD requires of a feature upstream supports and this PR does not ship. A game that writes `new Points(geometry, new PointsNodeMaterial())` gets that one diagnostic, and the fix is the `PointsMaterial` this PR ships.

## Out of scope

- A new particle system. `GPUParticles3D` stays the particle mechanism.
- A look default. The game sets colour, size and texture.
