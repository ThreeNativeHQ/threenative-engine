# PRD-840 — Platform difference is a value, not a scattered `#ifdef`

**Status:** IN PROGRESS (phases 1-3 done; acceptance open)
**Priority:** P1 — open Phase 1 removes 3 `__EMSCRIPTEN__` forks that make web and native draw different pictures, so a renderer fix proven on desktop never runs on web.
**Complexity:** 7 (HIGH); risk override: changes the draw order and batching on web and native, so the owner's visual-judge rule and web/native parity apply
**Owner:** ThreeNative maintainers
**Depends on:** None
**Batch:** [Untangle report, 2026-11-06](README.md) — N3

## Context

Report ids H3, H2, H6, H4. There are 27 `__EMSCRIPTEN__` sites in 9 engine files.

| Problem | Where |
| --- | --- |
| Opaque draws sort by depth on web and by state on native | `packages/runtime-native/src/engine/renderer/renderer.cpp:3142` |
| `batchSlot` returns the last group every web frame. The batched draw key differs per platform. | `packages/runtime-native/src/engine/renderer/render_database.cpp:1434,1535` |
| Features compiled out on web: `stablePasses_`, `setStablePasses`, `setStableRows`, slot map | `renderer.h:854,865,1457`, `render_database.h:230` |
| `renderer.cpp` is 7 102 lines, and `renderPrepared` alone is 2 743 (`:3291-6033`). `renderer.h` exposes about 1 200 public lines. | `renderer/renderer.cpp`, `renderer/renderer.h:365` |
| Renderer link list written twice for two exclusive builds | `cmake/NativeEngineCore.cmake:173`, `cmake/NativeEngine.cmake:55` |
| 31 env flags read ad hoc, some once and some per frame. 7 of them pick which arm renders. | `renderer.cpp:319-326`, `render_database.cpp:1223,1921`, `projection/plan.h:102-109` |

## Solution

`struct RenderFeatures { bool stablePasses, stateSortFirst, batchSlotReuse, recordCauseHashes; }` is
set once at construction from the host. The fields stay `constexpr`-foldable where a build pins them.
`#ifdef` remains only for code that cannot compile on a platform: threads, POSIX clock, error scopes.
One `engine/foundation/flags.h` declares each `TN_*` flag as read-once or per-frame. One CMake
function owns the renderer link line. Then `renderer.cpp` splits by concern (material, program,
shadow, output) behind `renderer_internal.h`, and a per-frame struct carries the locals that
`renderPrepared` shares.

## Acceptance Criteria

- [ ] AC-1 [local]: Web and native conformance stay green. proof: `pnpm parity`
- [ ] AC-2 [local]: The visual judge returns NEUTRAL or better on the starter, web and native, same pose. proof: judge verdict on this box
- [ ] AC-3 [local]: The starter frame time does not regress on web or native. proof: `pnpm bench:engines` paired A/B

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Render features | `web_host.cpp` and `player/run.cpp` construct the renderer | Render-semantics `#ifdef` deleted | Phase 1 |

## Decisions and corrections

- Decision, 2026-11-08 (lead): the host sets `RenderFeatures` once at construction (`wasm/web_host.cpp`, `player/run.cpp`). Each host passes the value its platform uses today: web keeps depth-first opaque sort, last-group `batchSlot` and no stable passes, and native keeps its values. The pictures and the frame cost do not move in this PRD. A change of web to the native choices, or the reverse, is a separate measured change with its own perf A/B and visual judge. The fields stay `constexpr`-foldable where a build pins them, so the Wasm hot path pays no branch cost. `#ifdef __EMSCRIPTEN__` stays only where code cannot compile on a platform.
- Correction, 2026-11-08: the Solution's `stateSortFirst` is the existing `stableRows` choice. Only the retained rows sort by state, so the field keeps the name that `setStableRows` and `TN_STABLE_ROWS` already use. The risk override in the header no longer applies: by the decision above, this PRD changes no draw order and no batching on either platform.

## Execution Phases

#### Phase 1: `RenderFeatures` and flags
**Status:** DONE (2026-11-08)
**Files:** `renderer/renderer.h`, `renderer.cpp`, `render_database.{h,cpp}`, `wasm/web_host.cpp`, `player/run.cpp`, new `foundation/flags.h`.

- [x] No `__EMSCRIPTEN__` decides sort order, batching or pass stability, and each choice reads `features()`. proof: `rg -n '__EMSCRIPTEN__' packages/runtime-native/src/engine/renderer` lists only compile-only sites, plus `pnpm native:build` (desktop and Wasm)
  - 2026-11-08: new `renderer/render_features.h` holds `RenderFeatures {stablePasses, stableRows, batchSlotReuse, recordCauseHashes}` with `native()` and `web()`. `Renderer` and `RenderDatabase` take it at construction and read it through `features()`. `web_host.cpp` passes `RenderFeatures::web()`, and `player/run.cpp` passes `native()` with its `TN_STABLE_PASSES`/`TN_STABLE_ROWS` A/B knobs. Child renderers and nested databases take their parent's value. `setStablePasses`, `setStableRows`, the stable-pass members and the batch slot map now compile on both builds. The web engine pins its value at compile time (CMake `TN_RENDER_FEATURES_PIN_WEB`), so each choice folds and a host that asks a pinned build for other features fails with `TN_RENDER_FEATURES_PINNED`.
  - `rg` result, 12 sites, all compile-only: `pipeline_cache.h:7,37,192` and `pipeline_cache.cpp:50,78,336` (the compile worker threads, which the single-thread web build cannot start), `pipeline_cache.cpp:400,469,488` (the browser's error scopes and async pipeline API), `render_database.cpp:1123,1556` (cache prefetch hints: Wasm has no prefetch instruction), `renderer.cpp:3089` (the POSIX thread CPU clock; Phase 3 moved it to `renderer_internal.h:423`).
  - Builds: `pnpm native:build` exit 0. `cmake --build build/tn-engine-ui --target tn-native-engine-player-v8` (engine player, the renderer's native build) exit 0. `pnpm wasm:build` exit 0 for both web engines. Web engine size: base 4 012 076 bytes, after 4 014 559 bytes (+2 483, under the 4 194 304 budget).
  - Focused native tests, exit 0 each: renderer `camera_turn_records`, `coplanar_keeps_winner`, `cull_keeps_main_bundle`; render database `stable_passes_match_direct`, `camera_cull_keeps_bundle`, `batch_caches_stay_put`, `batch_keeps_member_id`, `batched_vs_unbatched`.
- [x] Every `TN_*` engine flag is read through `flags.h`, and a spec enumerates them. proof: `pnpm exec vitest run scripts/__tests__/ablation-flags-never-ship.spec.ts` extended
  - 2026-11-08: `engine/foundation/flags.h` declares 33 flags, each `Read::Once` (the first read holds for the process) or `Read::Live` (each call reads again). `flags::read<F>()` and `flags::once<F>()` `static_assert` the declared kind. No flag changed its default or its read cadence. The 7 `Once` flags were already cached at their single call site.
  - The spec enumerates the 33 flags, fails when any file under `src/engine/` other than `flags.h` calls `getenv`, and fails when a flag is read through the wrong kind. Result: 8 passed. Red: an added `std::getenv("TN_X")` in `renderer/compute.cpp` failed 1 test, and `TN_PROGRAM_PROBES` declared `Live` failed 2 tests. Both mutations were reverted.

#### Phase 2: One CMake link line
**Status:** DONE (2026-11-08)
**Files:** `cmake/NativeEngineCore.cmake`, `cmake/NativeEngine.cmake`.

- [x] One `tn_engine_renderer_target` function, and a configure check compares both builds' `LINK_LIBRARIES`. proof: `pnpm native:build` plus the Wasm configure
  - 2026-11-08: `cmake/NativeEngineCore.cmake` owns `TN_ENGINE_RENDERER_LINK_LIBRARIES` and `tn_engine_renderer_target(<backend libraries>)`. The browser build calls it with no backend, and `NativeEngine.cmake` passes `tn_host_services` and its WebGPU backend. The two builds are exclusive, so one configure cannot read the other's target. The check is deferred to the end of each configure: it fails with `TN_RENDERER_LINK_DRIFT` when the target links anything but the shared line plus the backend that the build named.
  - Proof: the engine-player configure (`cmake --preset tn-linux -B build/tn-engine-ui -DTN_ENGINE_ONLY=ON -DTN_ENGINE_PLAYER=ON -DTN_ENGINE_PLAYER_UI_OVERLAY=ON`) exit 0, `pnpm native:build` exit 0, and `pnpm wasm:build` (the `wasm` and `wasm-threads` configures) exit 0. Red: an added `target_link_libraries(tn_engine_renderer PUBLIC tn_engine_visibility)` at the end of `NativeEngine.cmake` failed the configure with `TN_RENDERER_LINK_DRIFT`. The mutation was reverted.

#### Phase 3: Split `renderer.cpp`
**Status:** DONE (2026-11-08)
**Files:** `renderer/renderer.cpp` → `renderer_material.cpp`, `renderer_program.cpp`, `renderer_shadow.cpp`, `renderer_output.cpp`, new `renderer_internal.h`; `renderer.h`.

- [x] No renderer TU is over 3 000 lines, and `renderer.h` keeps only host-facing calls and value types. proof: `wc -l packages/runtime-native/src/engine/renderer/*.cpp` plus `pnpm native:verify:desktop`
  - 2026-11-08: a script moved each definition unchanged by concern (a line multiset check: every source line of the old file is in the new files, and only the file headers, the namespace lines and an `inline` on each shared helper are new). `renderer.cpp` 1 317 lines (construction, child renderers, GPU joints, draw order, `render()`, `encodeFrame`), `renderer_frame.cpp` 2 754 (`renderPrepared`, whole), `renderer_material.cpp` 1 027 (material textures, samplers, PMREM bake), `renderer_output.cpp` 892, `renderer_program.cpp` 428, `renderer_shadow.cpp` 170. `renderer_internal.h` (588) holds the includes, the file-local helpers (still one internal copy per TU), `cpuMetersOn` as one `inline` variable, and the frame's private structs. The largest renderer TU is 2 754 lines. All five files are in `TN_ENGINE_RENDERER_SOURCES`, and `scripts/check-source-list.mjs` passes.
  - Builds and tests: engine-player build exit 0, with no warning from a renderer file. `pnpm wasm:build` exit 0: the web engine is 4 018 577 bytes (base 4 012 076, +6 501, under the 4 194 304 budget). `ctest -R 'native_engine_(renderer|traa|render)_'` 146/146 passed, which includes the render-driver pixel suites. `ctest -L native-engine` 642/647 passed. The 5 failures (`target_graph`, `v8_tsl_api`, `player_imports`, `player_compute_ops`, `player_gpu_stages`) also fail on the base build of the same configure, so the split did not cause them. `packages/runtime-native/__tests__/native-engine-game-spans.spec.ts` now reads `renderer.cpp` and `renderer_frame.cpp`: 7 passed, and the old spec fails 1 test on the split.
  - `pnpm native:verify:desktop` exit 0 (audio, stability, core, physics, contracts, loading, UI frame, 9/9 discovery tests), and `pnpm native:build` exit 0 after the split. Both build and run the legacy `mystral` host, which compiles no file of the owned renderer (`build/tn-linux/compile_commands.json` names none). The engine-player build, the ctest runs above and the AC rows prove the renderer. `pnpm quality` exit 0, but it scans only `.ts` and `.tsx` files (`scripts/check-quality.ts`), so `wc -l` is the C++ proof.
  - Correction, 2026-11-08 (`renderer.h`): the header keeps the class's private members. C++ needs them in the class, and a pimpl adds one indirection on each member access in the frame, which is a rewrite with a perf risk. The public section also serves `RenderDatabase` and the native tests. So `renderer.h` changes only by the Phase 1 calls. `renderPrepared` moves whole, so no locals cross a TU and the per-frame struct of the Solution is not needed: `FrameJob` already carries the state that the frame hands to `encodeFrame`.
