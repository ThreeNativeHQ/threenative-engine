# PRD-577 — Engine pipelines compile off the frame and survive a relaunch

**Status:** PARTIAL — native `compileAsync` builds on a compile pool (ticked); web proof, draw-until-ready, the shipped list and the driver caches are open.
**Priority:** P1 — a missed key still compiles inside a frame, and no engine pipeline persists, so Android first launch keeps the 8 s compile cost the legacy host measured (Phases 1–3 open).
**Complexity:** 4 (MEDIUM) — 1–5 engine files (+1), compile completions are concurrent state (+2), a disk cache crosses the native build (+1); risk override: none
**Owner:** João
**Cycle:** v2. It starts after v1 slices 4 (`src/webgpu/context.cpp`) and 5 (`renderer/pipeline_cache`) are on develop.
**Depends on:** v1 slices 4, 5, 7 and 9 (Android player, for Phase 3). Load rows read [PRD-573](./PRD-573-the-performance-bar-is-a-scorecard-on-named-scenes.md).
**Estimate:** Phase 1 ≈ 8 h; Phase 2 ≈ 8 h; Phase 3 ≈ 10–14 h (two backends).

## Context

Layer: engine. A game cannot compile a pipeline the engine owns. Facts at `origin/feat/native-engine`
`68f4b1f7b` (paths under `packages/runtime-native/src/` unless stated):

- **Off-frame compile exists.** `engine/renderer/pipeline_cache.cpp:191` `getAsync` feeds a 2-thread
  pool (`pipeline_cache.h:118`); only `poll()` on the owner thread adopts results.
  `Renderer::compileAsync` (`renderer.cpp:1653`), `RenderDatabase::compileAsync`
  (`render_database.cpp:1372`) and `V8Game::compileAsync` (`engine/player/v8_main.cpp:575`) are
  wired, and `packages/three-native/src/browser-renderer.ts:324` compiles on the web (review fixes
  `c99149fd3`). The Wasm build compiles synchronously inside `getAsync`.
- **A missed key still costs a frame.** The frame path falls back to a synchronous create
  (`PipelineCache::get`). A game that never calls `compileAsync` gets no off-frame compile. The
  engine reports no synchronous creates per frame; the legacy host did (`pipelineCompileMs` in
  `packages/playtest/src/runner/perf.ts:160`).
- **Persistence already exists on the legacy host for wgpu-native**, the Android backend:
  `src/webgpu/bindings_pipeline_cache.cpp` (a `WGPUPipelineCache` handle),
  `cmake/PipelineCacheIdentity.cmake` (cache identity hashes all sources)
  ([PRD-368](../assets/PRD-368-compiled-pipelines-survive-a-relaunch.md), PARTIAL; Pixel acceptance
  open). PRD-535 deletes that host, so the engine must carry it or Android loses it.
- **Device creation** is in `src/webgpu/context.cpp` (`installDeviceCallbacks` `:348`) and, for the
  Wasm host, `engine/wasm/web_host.cpp`. `engine/renderer/device_state.{h,cpp}` only calls an
  injected `Acquire`, so a cache hook does not go there.
- On a Pixel 8 running Bayview, 105 synchronous creates cost 8,038 ms on the legacy host.

### What Unreal does (UE 5.8.3, design reference only)

Components request pipelines at registration (`Engine/Private/Components/PrimitiveComponent.cpp:5407`
`PrecachePSOs`) with a priority and a per-request boost (`RHI/Public/PipelineStateCache.h:32,92`). A
draw whose precached pipeline is not ready is skipped. A recorded pipeline list
(`RHI/Public/PipelineFileCache.h:314`) ships with the game and precompiles at launch in batches
(`RenderCore/Public/ShaderPipelineCache.h:93`), so the first launch on a player device is warm.

## Solution

1. **No draw waits on a compile.** The engine enqueues missing keys itself when content is added
   or a package loads, with a boost for a key the current frame needs. A draw whose pipeline is
   still compiling is skipped that frame, and the frame report counts skipped draws and synchronous
   creates. `ponytail:` the pool stays a fixed 2 workers, FIFO plus boost, no cancel on teardown.
2. **A shipped pipeline list.** The player writes the keys a run used. The cook step ships the list
   with the build. Launch submits it to the pool before the first frame. Keys are deterministic
   (WGSL ids, PRD-511), so the list works on Dawn and wgpu with or without a driver cache.
3. **Driver caches behind one interface.** Dawn: a blob cache hooked in `src/webgpu/context.cpp`.
   wgpu-native: the engine `PipelineCache` passes a `WGPUPipelineCache` handle, reusing PRD-368's
   identity and qualify-before-ingest logic. Every cache key includes adapter, driver and the
   engine/WGSL generator version.

## Execution Phases

#### Phase 1: No draw waits on a compile
**Status:** PARTIAL
**Files:** `src/engine/renderer/pipeline_cache.{h,cpp}`, `src/engine/renderer/renderer.cpp`, `src/engine/player/run.cpp`, `packages/playtest/src/runner/perf.ts`, `tests/native-engine/renderer/`
- [x] On native desktop, `compileAsync` builds every missing pipeline on a compile pool, and the next `render` compiles zero pipelines. proof: red-green `native_engine_renderer_pipeline_compile_async` (baseline failed, modified passes on Dawn Null), 2026-10-09; next render creates 0, an unseen material uses the synchronous fallback. On `feat/native-engine`; reaches develop with slice 5.
- [ ] On the web, `compileAsync` builds every missing pipeline through the async entry, and the next frame compiles none. proof: `ctest --test-dir packages/runtime-native/build/wasm -R native_engine_wasm_browser_backend` executed in a browser (the GPU-stubbed facade case passes 4/4; browser execution is open)
- [ ] The engine enqueues keys for added content without a `compileAsync` call, and a draw with a pending pipeline is skipped, not compiled in-frame. proof: a red-green case in `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_renderer_pipeline_cache` (synchronous creates after the first present = 0)
- [ ] The frame report carries synchronous creates and skipped draws per frame, and `perf` reads them. proof: a red-green case in `packages/playtest/__tests__/perf.spec.ts`, then `perf --executable <player> --target desktop --text` on `heterogeneous`
- [ ] Skipped draws pass the visual judge, and Midway's native page reaches `ready` sooner than its base build. proof: a fresh judge subagent on headed `--browser-recipe webgpu` captures of first frames; `pnpm profile:wasm-page -- --url <this build> --control <base> --load --gpu-calls` with `ready` ratio below 1.0

#### Phase 2: A shipped pipeline list
**Status:** NOT STARTED
**Files:** `src/engine/renderer/pipeline_cache.{h,cpp}`, `src/engine/player/`, the cook step in `packages/assets/`
- [ ] The player writes the used key list, the cook step ships it, and a launch with the list compiles zero pipelines inside frames. proof: a red-green case in `ctest ... -R native_engine_renderer_pipeline_cache`, then `perf --executable <player> --target desktop --text` with first-frame synchronous creates 0

#### Phase 3: Driver caches persist on Dawn and wgpu
**Status:** NOT STARTED
**Files:** `src/webgpu/context.cpp`, `src/engine/renderer/pipeline_cache.{h,cpp}`, `cmake/PipelineCacheIdentity.cmake`
- [ ] A second desktop launch on Dawn reads pipelines from the blob cache, and a changed driver or generator key misses cleanly. proof: a red-green case with a fake blob store counting load and store calls, then two `perf --executable` launches on a real adapter
- [ ] The engine on wgpu-native persists pipelines through `WGPUPipelineCache`, and a corrupt cache still launches. proof: a red-green case reusing PRD-368's corrupt-cache contract, then two launches of the Android engine player on the emulator with the second launch's compile count lower

## Decisions

- 2026-10-11 (epic rewrite): the scorecard run (old Phase 3) rides with PRD-573 Phase 3.

## Blocked on

- Dawn's blob cache API is unverified in the pinned Dawn headers. Phase 3 box 1 reads them first.
- Android second-launch compile milliseconds need the Pixel 8 attached (PRD-327's pre-registered
  25% rule). The emulator holds the compile-count claim.
