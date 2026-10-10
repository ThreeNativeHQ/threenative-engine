# PRD-577 — Engine pipelines compile off the frame and survive a relaunch

**Status:** IN PROGRESS
**Priority:** P1 — the engine's `compileAsync()` compiles nothing, so every pipeline compiles inside a frame (Phase 1 implementation landed; GPU/browser proof open), and no engine pipeline persists across launches (Phase 2 open).
**Complexity:** 4 (MEDIUM) — 1–5 engine files (+1), a compile pool and async completions are concurrent state (+2), a disk cache crosses the native build (+1); risk override: none
**Owner:** João
**Depends on:** None for Phase 1. Phase 3 reads [PRD-573](./PRD-573-the-performance-bar-is-a-scorecard-on-named-scenes.md).
**Estimate:** Phase 1 ≈ 8 h: the web half 4–6 h, the native desktop half **4 h (quick win)**; Phase 2 ≈ 6–8 h; Phase 3 ≈ 2 h of runs.

## Context

Layer: engine (`packages/runtime-native/src/engine/renderer/` and the web backend in
`packages/three-native/src/` on `origin/feat/native-engine`). A game cannot compile a pipeline the
engine owns, so the engine must do it.

Facts read 2026-10-09 at `76989167f`:

- `compileAsync()` in `packages/three-native/src/browser-renderer.ts:321` returns
  `Promise.resolve()` and compiles nothing. Its comment says the V8 player does the same.
- `PipelineCache` (`src/engine/renderer/pipeline_cache.h:51`) builds a pipeline on first request,
  synchronously, and keeps it in memory only. Nothing in `src/engine/` calls an async pipeline
  entry or writes a pipeline to disk.
- The epic brief counts 65 async pipeline compiles on the three.js Midway page during load and 0 on
  the native page. Midway's `enter` is 0.96–1.09x of three.js and `ready` 0.73–1.05x.
- The legacy host solved the same problem for its JS-owned path
  ([PRD-327](../performance/critical/PRD-327-first-use-pipeline-compilation-leaves-the-main-loop.md),
  [PRD-387](../performance/critical/PRD-387-shader-variants-are-prepared-off-frame-and-bounded.md),
  [PRD-339](../performance/critical/PRD-339-the-compile-walk-leaves-the-main-thread.md)):
  `src/webgpu/bindings_pipelines.cpp:50-64` compiles on a 2-thread host pool, because
  `wgpuDeviceCreateRenderPipelineAsync` is `unimplemented!()` on wgpu-native (the Android backend)
  and both backends' devices are internally synchronized (`src/webgpu/bindings_state.h:462-468`).
  On a Pixel 8 running Bayview, synchronous first-use compiles cost 8,038 ms across 105 pipelines
  (same comment). [PRD-535](../native-engine/PRD-535-n21-the-js-engine-is-deleted.md) deletes
  that host path, so the engine needs its own.
- Upload bytes at `ready` (242.6 MB native against 114.8 MB three.js) belong to PRD-553 and are not
  in scope here. Texture residency belongs to [PRD-VQ-10](../performance/PRD-VQ-10-texture-mip-residency.md),
  and GPU-ready ASTC to PRD-568.

### What Unreal does (UE 5.8.3, design reference only)

- The pipeline file cache records every pipeline state a run used, and the next launch precompiles
  that list in batches before or during loading
  (`Engine/Source/Runtime/RHI/Public/PipelineFileCache.h:314` `FPipelineFileCacheManager`,
  `Engine/Source/Runtime/RenderCore/Public/ShaderPipelineCache.h`).
- Asset loading runs on its own thread with dependency-ordered packages
  (`Engine/Source/Runtime/CoreUObject/Private/Serialization/AsyncLoading2.cpp`, `FAsyncLoadingThread2`).

## Solution

1. **`compileAsync` compiles.** It walks the scene the way `render` does, collects the pipeline keys
   that are missing from `PipelineCache`, and resolves when all of them exist. On the web,
   each key goes through `wgpuDeviceCreateRenderPipelineAsync` (the browser's
   `createRenderPipelineAsync`). On native, each key goes to a small compile pool that calls the
   synchronous create, the same design the legacy host proved on wgpu-native. The frame path keeps
   its synchronous fallback for a key that `compileAsync` did not see or that is still compiling.
   When a draw races an in-flight compile, its synchronous pipeline remains cached and fulfills the
   speculative ticket. Queued work skips fulfilled tickets; already-active work releases its late
   result without changing that ticket, the cache entry or the compile count. `compiles()` counts
   that key once; two physical creates can overlap to keep the draw correct.
   Failed speculative tickets reject independently, and shutdown cancels queued work after joining
   the two active workers. Speculative Wasm shader validation is captured in an error scope, so it
   cannot latch the host's global device failure. Shadow-map changes invalidate the next frame's
   bind groups. The Wasm compile walk uses a separate database, preserving the render scene's records.
   Browser `initTexture()` calls the host's renderer upload path and submits generated mipmaps before
   its promise resolves; repeated calls at the same texture version upload no bytes.
2. **The native cache persists.** Dawn's blob cache (load and store callbacks on device creation)
   writes compiled pipelines under the player's cache directory, keyed by adapter and driver.
   A wgpu-native build records `persistent: false` and works as today.
3. **Recorded pipelines precompile at launch.** The engine writes the key list a run used, and the
   next launch submits that list to the pool before the first frame. This is the pipeline file
   cache idea, in our own code.

## Execution Phases

#### Phase 1: `compileAsync` compiles on web and native
**Status:** IN PROGRESS
**Files:** `packages/three-native/src/browser-renderer.ts`, `src/engine/renderer/pipeline_cache.{h,cpp}`, `src/engine/wasm/web_host.cpp`, `tests/native-engine/renderer/` (pipeline cache test)
- [x] **[QW ≤4 h]** On native desktop, `compileAsync` builds every missing pipeline on a compile pool, and the next `render` compiles zero pipelines. proof: red-green case in `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_renderer_pipeline_cache` (`compiles()` unchanged across the first render after `compileAsync`). Verified 2026-10-09 in this task’s `build/tn-linux-engine` with `ctest -L native-engine -R pipeline`: baseline `native_engine_renderer_pipeline_compile_async` failed; modified case passes on Dawn Null with no GPU. Both pipeline cases pass; the next render creates 0 pipelines, and an unseen material still uses the synchronous fallback.
- [ ] On the web, `compileAsync` builds every missing pipeline through the async entry, and the first frame after it compiles zero pipelines. proof: red-green case in `ctest --test-dir packages/runtime-native/build/wasm -R native_engine_wasm_browser_backend`. Implementation and requested GPU-stubbed facade proof verified 2026-10-09: baseline 4 failures, modified 4 passes; 1/2/3-argument calls await all creates and the next frame creates none. `tn-native-engine-web` builds using the available async API. This box remains open for actual Wasm/browser execution, excluded by this task’s no-browser/no-GPU rule.
  Review repairs verified 2026-10-10: 8/8 focused native/source CTest cases, 130/130 package Vitest tests (excluding `run-native.spec.ts`), tsc and touched-file Biome passed; native and Wasm rebuilt. Covers shadow invalidation across render/compile/render, isolated failures, queue cancellation, synchronous ticket adoption, catch-all rejection and texture upload. Wasm host database/error-scope contracts are source-tested; browser/GPU runtime proof remains open. Command results are in `PROGRESS-577.md`.
- [ ] Midway's native page reaches `ready` sooner against its own base build, frames pixel-identical. proof: `pnpm profile:wasm-page -- --url <native Midway, this build> --control <native Midway, base build> --load --gpu-calls` with subject/control `ready` below 1.0 and at least 1 async compile counted on the subject

#### Phase 2: Native pipelines survive a relaunch
**Status:** NOT STARTED
**Files:** `src/engine/renderer/device_state.{h,cpp}`, `src/engine/renderer/pipeline_cache.{h,cpp}`, `src/engine/player/`
- [ ] A second launch on Dawn reads every pipeline from the blob cache, and a changed driver key misses cleanly. proof: red-green case in `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_renderer_pipeline_cache` (cache hits equal pipeline count on the second device)
- [ ] The recorded key list precompiles before the first frame on the second launch, so the first frame compiles zero pipelines. proof: `node packages/playtest/dist/runner/cli.js perf --executable <native player> --target desktop --text` run twice, the second run's first-frame compile count 0

#### Phase 3: The load gain is measured on the scorecard
**Status:** NOT STARTED
**Files:** `docs/verification/runtime-perf-state.md`
- [ ] Cold and warm native desktop launches of `heterogeneous` report first-frame time against the base build in one load window. proof: `pnpm bench:engines -- --arms native --workloads heterogeneous` on both builds, ratio recorded with load average

## Blocked on

- Android uses wgpu-native, which has no blob cache in the same form (unverified). A persistent cache claim on Android needs a design check and the Pixel 8. Unblocked when João attaches the device.
