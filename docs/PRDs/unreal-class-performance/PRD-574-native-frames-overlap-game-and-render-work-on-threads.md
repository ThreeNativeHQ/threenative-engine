# PRD-574 — Native frames use every core: jobs, then a render thread

**Status:** NOT STARTED
**Priority:** P1 — animation and transforms (about 21% of the Midway frame) run serially on one core, and no render thread exists (Phases 1–3 open).
**Complexity:** 7 (HIGH) — 6–10 engine files (+2), a job system and a render thread are new modules (+2), shared frame data is concurrency (+2), the Android build carries it (+1); risk override: none
**Owner:** João
**Cycle:** v3. Phase 1 opens v3; [PRD-576](./PRD-576-the-engine-renderer-draws-from-the-gpu-scene.md) follows; Phases 2–3 close v3.
**Depends on:** v1 slices 2b, 5 and 6 (engine, renderer, V8 player); [PRD-573](./PRD-573-the-performance-bar-is-a-scorecard-on-named-scenes.md) for the ratios. Phase 2 lands before PRD-576 changes its upload path, so both do not rewrite the same struct.
**Estimate:** Phase 1 ≈ 20–30 h; Phase 2 ≈ 24–32 h; Phase 3 ≈ 20–30 h.

## Context

Layer: engine (cited at `origin/feat/native-engine` `68f4b1f7b`, under `packages/runtime-native/src/engine/`).

- **One thread does all frame work.** The only engine threads are the package-load workers
  (`world/admission/package_loads.h:94`) and the 2 pipeline-compile workers
  (`renderer/pipeline_cache.h:118`). No job system exists. The Wasm build has no threads.
- **Most stage timers exist.** `frameTiming` (`player/run.cpp:299`) emits `gameJsMs`, `renderMs`,
  `cpuFrameMs` and `frameMs`. `RenderDatabase::lastPrepareMs()` (`renderer/render_database.h:67`)
  splits matrices, project, batch and rest. Missing: `renderMs` split into prepare against
  `Renderer::render`, and `perf` reading it.
- **The cut is not where the old PRD put it.** `RenderDatabase::render` (`render_database.cpp:1384`)
  runs `prepare()` (matrices, project, cull, batch; reads the live graph; calls JS `onBeforeRender`)
  and then `Renderer::render`. No record revision or snapshot type exists. `DrawItem`
  (`renderer/renderer.h:68`) holds raw pointers into the live world (buffers, textures, bone
  matrices, morph weights), so a second thread reading them races every animated mesh.
- **Ceiling.** A render thread that owns only `Renderer::render` (21%) cuts the frame at best to
  0.79x; with projection (32%), to 0.68x. Animation and transforms stay on the game thread, so jobs
  come first.

**The six hazards a render thread must fix:**
1. Non-atomic globals `nextObjectId` and `hierarchyRevision` (`scene/object3d.cpp:67-68`) and
   file-scope scratch math objects (`:71-77`).
2. Ownership: if the snapshot holds a `shared_ptr`, the last release can run an `Object3D`
   destructor on the render thread and mutate the game graph.
3. Renderer state set from JS on the game thread: `V8Game::beforeRender` (`player/v8_main.cpp:228`)
   calls `setOutput`, `setSampleCount` and `shadowMapEnabled`; `setPost`, `renderTarget`,
   `readTarget` and `compileAsync` (`:575`) also touch it.
4. `RenderDatabase::renderReflections` (`render_database.cpp:1405`) toggles `material->visible` on
   live materials and renders recursively.
5. Frame loop glue in `run.cpp` (`afterRender`, `frameComplete`, `renderer->poll()`, readbacks,
   presenter pacing) assumes one thread and has no frame-in-flight limit.
6. Android: the surface-released handshake (`run.cpp:260`) and `paceToPresentationCap` (`:525`)
   reset and pace the presenter on the game thread.

### What Unreal does (UE 5.8.3, design reference only)

Game, rendering and optional RHI threads run a frame apart
(`RenderCore/Private/RenderingThread.cpp`; `r.GTSyncType` bounds the lead; `FFrameEndSync`). Work
crosses as `ENQUEUE_RENDER_COMMAND` closures (`RenderCore/Public/RenderingThread.h`). Render
resources release behind a fence. Pose evaluation runs as parallel tasks
(`Engine/Private/Components/SkeletalMeshComponent.cpp:3061`).

## Solution

1. **Jobs first.** A fixed worker pool sized from the core count (inline on Wasm). Mixers evaluate
   as parallel jobs, and independent subtrees update transforms as jobs. JS events (`finished`,
   `loop`) are queued and dispatched after the join. Hazard 1 is fixed here (atomics, per-thread
   scratch).
2. **A frame snapshot, consumed inline.** `prepare()` builds a `FrameSnapshot`: owned copies of bone
   palettes, morph weights and instance data, retained versioned buffers, renderer settings, and a
   deferred-release list drained on the game thread (hazard 2). Renderer settings go through a
   render command queue drained inline (hazard 3). Reflections stay a game-thread pass (hazard 4).
3. **`--render-thread`, opt-in.** A depth-1 frame queue (frame-in-flight limit 1) with fences at
   resize, shutdown and surface loss (hazards 5 and 6). Playtests default to one thread so
   `frameComplete` and diagnostics keep their order. The report states the one-frame input latency.

## Execution Phases

#### Phase 1: Jobs on every core
**Status:** NOT STARTED
**Files:** `src/engine/foundation/` (job pool), `src/engine/animation/mixer.cpp`, `src/engine/scene/object3d.cpp`, `src/engine/player/run.cpp`, `packages/playtest/src/runner/perf.ts`
- [ ] The frame report splits `renderMs` into prepare and `Renderer::render`, `perf` prints the stages, and they sum to the frame CPU within 5%. proof: a red-green case in `packages/playtest/__tests__/perf.spec.ts`, then `perf --executable <player-v8> --target desktop --text`
- [ ] Mixers evaluate as jobs, bit-equal to one thread, and events dispatch after the join. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_skinned_crowd_cpu` with 1 and N workers, then the same ctest under `-fsanitize=thread`, zero reports
- [ ] Independent subtrees update transforms as jobs, bit-equal to one thread, with hazard 1 fixed. proof: `ctest ... -R native_engine_static_transform` and `-R native_engine_scene_revision` with 1 and N workers, under ThreadSanitizer
- [ ] Frame CPU scales sub-linearly with object count against 1 worker in the same run. proof: `pnpm bench:engines --arms native-v8 --workloads skinned-crowd,heterogeneous --objects <sweep>` with both worker counts, ratios with tails and `hostLoad`

#### Phase 2: The renderer reads a frame snapshot
**Status:** NOT STARTED
**Files:** `src/engine/renderer/render_database.{h,cpp}`, `src/engine/renderer/renderer.{h,cpp}`, `src/engine/player/v8_main.cpp`
- [ ] `Renderer::render` reads only a `FrameSnapshot` with a deferred-release list, frames pixel-identical, and copied bytes per frame reported. proof: `ctest ... -R native_engine_batched_vs_unbatched` (worst channel 0) plus a bytes-copied counter case
- [ ] Renderer settings set from JS reach the renderer only through the render command queue. proof: a red-green ctest case (a setting changed between frames applies at the next drain, not mid-frame)

#### Phase 3: An opt-in render thread one frame behind
**Status:** NOT STARTED
**Files:** `src/engine/player/run.{h,cpp}`, `src/engine/renderer/`, `cmake/NativeEngineCore.cmake`
- [ ] `--render-thread` and one-thread players render the same frames to the pixel. proof: `ctest ... -R native_engine_batched_vs_unbatched` in both modes
- [ ] 600 threaded frames with a resize, a device loss and a surface loss in flight run free of data races. proof: the threaded ctest under ThreadSanitizer, zero reports
- [ ] Frame CPU falls against one thread in the same run, with p99 no worse. proof: `pnpm bench:engines --arms native-v8` with both player modes in one invocation on R5 and `heterogeneous`, threaded/one-thread ratio and tails recorded

## Decisions

- 2026-10-11 (epic rewrite): render-thread node release is forbidden (deferred release), so the
  single-thread `raw_` plus `expired()` check in PRD-578 stays valid and the old dependency on
  PRD-578 Phase 1 is dropped.
- The default flips to the render thread on desktop only after the Phase 3 ratio holds; Android
  only after the Pixel 8 run.

## Blocked on

- The Android claim needs the Pixel 8 attached (big and little cores schedule differently).
