# PRD-576 — The engine renderer draws from the GPU scene

**Status:** NOT STARTED
**Priority:** P1 — draw order, uniform offsets and batch sizes all change the bundle key, so a moving camera re-records passes, and the shadow, normal and velocity passes encode every draw directly (Phases 1–3 open).
**Complexity:** 5 (MEDIUM) — 1–5 engine files (+1), stable slots and indirect arguments are new renderer state (+2), the same change ships in the Wasm and native builds (+2); risk override: none
**Owner:** João
**Cycle:** v3, after [PRD-574](./PRD-574-native-frames-overlap-game-and-render-work-on-threads.md) Phase 1 and before PRD-574 Phase 2.
**Depends on:** v1 slice 5 (renderer); [PRD-573](./PRD-573-the-performance-bar-is-a-scorecard-on-named-scenes.md) for the ratios; the per-view uniform block is [PRD-578](./PRD-578-the-engine-skips-work-that-did-not-change.md) Phase 2.
**Estimate:** Phase 1 ≈ 6 h; Phase 2 ≈ 16–20 h; Phase 3 ≈ 16–24 h.

## Context

Layer: engine (`packages/runtime-native/src/engine/renderer/`, cited at `origin/feat/native-engine`
`68f4b1f7b`). Decision 12 in `NATIVE-ENGINE-DECISION.md` sets the design: static draws are recorded
once as render bundles; culled instances draw indirectly. Today:

- **The main pass replays a bundle, but the key moves.** The key (`renderer.cpp:2702-2722`) lists
  pipeline, bind groups, `vertexOffset`, `fragmentOffset`, instance count and each buffer handle,
  in plan order. Three things change it every time the camera moves:
  1. **Order.** `Renderer::sortDraws` (`renderer.cpp:1621`) sorts opaques by clip-space depth
     (three's `painterSortStable`) and transparents back to front. Swapping two neighbours rebuilds.
  2. **Offsets.** `frameUniforms_` is packed in plan order (`renderer.cpp:2088-2090`). One draw
     culled in or out moves every later offset.
  3. **Batch sizes.** `RenderDatabase::batch` (`render_database.cpp:893`) sizes each batch store to
     the visible members, so handle, size and instance count change with the frustum.
- **Other passes encode directly.** Shadow (`renderer.cpp:2693`), normal (`:2784`) and velocity
  (`:2813`) encode every planned draw with no bundle. With TRAA or SSGI on, normal and velocity
  double the direct calls.
- **Stats ride with the bundle.** `mainBundleStats_` (`renderer.cpp:2747-2752`) supplies three's
  `info.render` draws and triangles. Indirect counts need a per-frame recount.
- **The GPU-scene kernel is not wired to the renderer.** `world/gpu_scene/cull_kernel` is used only
  by its test. Its args word 4 is the region start (a non-zero `firstInstance`, `gpu_scene.h:112`),
  which needs the optional `indirect-first-instance` feature; `wasm/web_host.cpp:136` requests only
  timestamps.
- No rebuild counter exists. `scripts/profile-wasm-page.ts` has a `--gpu-calls` census. The epic
  counts about 1160 WebGPU calls per frame on native Midway; the split is unmeasured.

Occlusion stays declined ([PRD-489](../done/PRD-489-gpu-scene-occlusion-culling.md)). Cluster LOD
belongs to [PRD-519](../native-engine/PRD-519-n12-native-batching-visibility-lod-gpu-scene.md).

### What Unreal does (UE 5.8.3, design reference only)

Mesh draw commands are cached when a primitive enters the scene (`Renderer/Private/PrimitiveSceneInfo.cpp:583`)
and sorted by pipeline and state, with distance a late key (`MeshDrawCommands.cpp:276`; translucent
keys patched per frame, `:164`). Instance counts come from GPU culling as indirect draws
(`InstanceCulling/InstanceCullingContext.cpp:1523,1531`). Primitive data stays resident and only dirty
ranges upload (`GPUScene.cpp:769`).

## Solution

1. **Count, then bundle the depth-only passes.** Rebuilds with their cause, and direct encodes by
   pass, go in `FrameStats`. Shadow, normal and velocity passes replay bundles under the main
   pass's key rule; viewport and page clear stay outside.
2. **Stable order and stable slots.** Opaques sort by (render order, pipeline, state bucket), with
   distance as a late key. Each record keeps a persistent uniform slot, so a culled draw moves no
   other offset. Transparents stay outside the static bundle and keep back-to-front order.
3. **Visibility is data.** Batch stores keep a high-water capacity with visible instances packed
   first. Each bundle draw is `drawIndexedIndirect` with CPU-written counts and `firstInstance` 0;
   instance data stays in vertex buffers bound by offset (web limits: no storage buffers in the
   vertex stage assumed). `info.render` is recounted per frame. `ponytail:` a culled draw still
   replays one command; the GPU kernel writing the counts is a later decision, not a phase.

## Execution Phases

#### Phase 1: Counters, and bundles for the depth-only passes
**Status:** NOT STARTED
**Files:** `src/engine/renderer/renderer.{h,cpp}`, `src/engine/wasm/web_host.cpp` (`_tnw_web_frame`), `tests/native-engine/renderer/`
- [ ] The frame report carries bundle rebuilds by cause and direct encodes by pass, and Midway's values over a scripted camera turn are recorded here. proof: a red-green case in `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_batched_vs_unbatched` (rebuilds 0 on a still frame, 1 after a draw is added), then `pnpm profile:wasm-page -- --url <native Midway> --control <three.js Midway> --gpu-calls --json`
- [ ] Shadow, normal and velocity passes replay bundles and render the same frame. proof: the same ctest with a shadow light and TRAA on: worst channel 0, direct encodes 0 in those passes on the second still frame
- [ ] WebGPU calls per frame fall on Midway. proof: `pnpm profile:wasm-page -- --url <this build> --control <base> --gpu-calls` with the calls ratio below 1.0 (a counter gate)

#### Phase 2: Stable order and stable slots
**Status:** NOT STARTED
**Files:** `src/engine/renderer/renderer.{h,cpp}`, `src/engine/renderer/render_database.{h,cpp}`
- [ ] A 90-degree camera turn over 60 frames on an opaque-only scene rebuilds no bundle, and a transparent case rebuilds only the transparent list. proof: red-green cases in `ctest ... -R native_engine_batched_vs_unbatched`
- [ ] The state-first order passes the visual judge, and GPU time is no worse. proof: a fresh judge subagent on headed `--browser-recipe webgpu` captures of R5 and Midway; `pnpm profile:wasm-page -- --url <this build> --control <base> --gpu-time` ratio at most 1.0

#### Phase 3: Indirect counts on capacity-stable stores
**Status:** NOT STARTED
**Files:** `src/engine/renderer/renderer.{h,cpp}`, `src/engine/renderer/render_database.cpp`, `src/engine/renderer/visibility/camera_cull.cpp`
- [ ] A turning camera with culling rebuilds no bundle, frames equal the direct path, and `info.render` draws and triangles equal the direct path's. proof: red-green cases in `ctest ... -R native_engine_batched_vs_unbatched` and `-R native_engine_camera_cull`
- [ ] Indirect draws cost less CPU than direct draws on Chrome, with p99 no worse. proof: `pnpm profile:wasm-page -- --url <this build> --control <base> --cpu-work --gpu-calls` on Midway and `pnpm bench:engines --arms native-v8` on R5, ratios below 1.0 with tails

## Decisions

- 2026-10-11 (epic rewrite): this PRD owns the persistent per-record slot; PRD-578 owns the
  per-view uniform block.
- The state-first order departs from three's `painterSortStable` for opaques. Transparent order
  stays three's.
- GPU-written arguments (the old Phase 3) are filed again only if CPU cull and project stay at 8% or
  more of the frame after Phase 3. That needs the kernel to write `firstInstance` 0.
- Dawn and browsers validate indirect arguments; Phase 3 box 2 proves the net CPU gain, not only
  fewer rebuilds.

## Blocked on

- An Android draw-time claim needs the Pixel 8 attached. The emulator (`--target android`) holds the
  counter claims first.
