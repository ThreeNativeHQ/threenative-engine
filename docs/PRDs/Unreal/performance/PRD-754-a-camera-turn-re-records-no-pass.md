# PRD-754 — A camera turn re-records no pass

**Status:** NOT STARTED
**Priority:** P1 — in a game the camera moves every frame. Today a camera turn changes the opaque draw order, which changes the bundle key, so the main pass records its render bundle again. The shadow, normal and velocity passes encode directly every frame. The same C++ renderer runs on desktop and in the web Wasm engine, where each encode call is also a JS-to-WebGPU call.
**Complexity:** 7 (HIGH) — renderer, render database and projection batch stores (+3), a new draw order and persistent uniform slots (+2), indirect draws and pixel parity across four passes (+2); risk override: none
**Owner:** João
**Parent:** [PRD-573](../../performance/PRD-573-unreal-class-performance-in-release-cycles.md), Phase v3.2 ("Recorded passes survive camera motion"). This PRD carries the v3.2 boxes; PRD-573 points here. Lane of PR #574 (`pr563-followup`).
**Depends on:** none. Related: PRD-753 (batch keys from a change set), [PRD-752](../../performance/PRD-752-web-games-run-in-a-worker-so-the-page-cannot-stall-them.md) phase 4 (job pool; lane `lane/pr574-threads`).

**Update rule:** this PRD has no PR of its own. Its commits land on `lane/perf-stable-passes` and merge into PR #574. Tick each box, with its result, in the commit that proves it.

## Problem

From PRD-573 v3.2, line numbers re-checked on `pr563-followup` at 6ddf30cab:

- The bundle key is built from the planned draws (`packages/runtime-native/src/engine/renderer/renderer.cpp:3836-3856`), and the main bundle is recorded again when the key differs (`renderer.cpp:4092-4123`).
- `Renderer::sortDraws` (`renderer.cpp:2355`) sorts opaque draws by the clip-space depth of each object origin (three's `painterSortStable`). A camera turn changes that order, so it changes the key.
- Uniform offsets follow plan order, and batch stores are sized by the visible count (`render_database.cpp`, see PRD-573 v3.2). A culling change therefore also changes the key.
- The shadow, normal and velocity passes encode directly, with no bundle (PRD-573 v3.2; re-verify the current lines).

No one has measured this cost yet. Phase 1 sizes it before any change (repository rule: size a lever before you code it).

## What Unreal does (UE 5.8.3)

Unreal caches draw commands that do not depend on the view. A view change only selects which cached commands draw and how many instances each draws.

- The opaque (base pass) sort key is state first: masked, then pixel shader hash, then vertex shader hash. It has no distance field. Only translucent draws sort by distance. `UE 5.8.3: Engine/Source/Runtime/Renderer/Public/MeshPassProcessor.h:1536` (`FMeshDrawCommandSortKey`, the `BasePass` and `Translucent` layouts).
- The base pass key is computed once, when the command is cached. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/BasePassRendering.cpp:329-333` (`CalculateBasePassMeshStaticSortKey`).
- A cached command holds no per-object uniform offset. Each instance reads its object data through a primitive id. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/MeshDrawCommands.cpp:483` (`BuildMeshDrawCommandPrimitiveIdBuffer`).
- Visibility writes instance counts into an indirect-arguments buffer, five words per draw, so the commands stay fixed while visibility changes. `UE 5.8.3: Engine/Source/Runtime/Renderer/Public/InstanceCulling/InstanceCullingContext.h:34-37,92,135`.
- Both mechanisms are on by default. `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/SceneRendering.cpp:277` (`r.MeshDrawCommands.UseCachedCommands`), `:293` (`r.MeshDrawCommands.DynamicInstancing`).

Borrow the design only. Do not copy Unreal code (licence rule: [`../README.md`](../README.md)).

## Goal

On an opaque scene, a camera turn and a culling change record no bundle again, in all four passes. Pixels stay identical to today.

### Phase 1: Size it

**Status:** NOT STARTED

- [ ] The frame report splits `renderMs` into prepare and `Renderer::render`, and counts bundle rebuilds by cause (order, uniform offset, visible count, other) and direct encodes by pass. `perf` prints stages that sum to frame CPU within 5%. proof: a red-green `perf.spec.ts` case; a native Midway run and a web shooter run with the counts recorded here
- [ ] The ceiling is recorded: CPU per frame spent in recording and encode on Midway and the shooter, native and web, during a scripted camera turn. If it is below 0.5 ms per frame on both games, the PRD stops and moves to Deferred with that number. proof: the Phase 1 counters with `profile:wasm-page --cpu-work` and the native frame report

### Phase 2: Stable recorded passes

**Status:** NOT STARTED

- [ ] The shadow, normal and velocity passes replay bundles, pixel-identical to direct encode. proof: red-green `native_engine_batched_vs_unbatched`; `profile:wasm-page --gpu-calls` ratio below 1.0
- [ ] Opaque draws sort state first (pipeline, then material, then geometry), and each record keeps a persistent uniform slot. A camera turn on an opaque scene rebuilds nothing. proof: red-green `native_engine_batched_vs_unbatched`; the Phase 1 rebuild counter at zero over a scripted turn; `--gpu-time` ratio at most 1.0 (state-first order can cost overdraw: the depth prepass must hold it)
- [ ] Batch stores keep their capacity, and draws use `drawIndexedIndirect` (`firstInstance` 0). A culling turn rebuilds nothing, `info.render` matches, and CPU falls on Chrome. proof: `native_engine_camera_cull`; `profile:wasm-page --cpu-work` ratio below 1.0

### Phase 3: Prove it on games

**Status:** NOT STARTED

- [ ] Midway native and the shooter on web: CPU per frame falls by at least the Phase 1 ceiling minus 20%, with frame p50 and p95 no worse. Paired A/B from one code state with a knob, three runs per arm, host load recorded. proof: `scripts/midway-bench/flight.sh` and `profile:wasm-page` pairs
- [ ] A fresh visual judge returns NEUTRAL or IMPROVEMENT on BEFORE/AFTER frames of Midway and the shooter (`--browser-recipe webgpu`, `adapter.info` checked, two runs per arm). proof: the verdict in this box and images on PR #574

## Done when

Every box is ticked, `PERFORMANCE-LEARNINGS.md` has the lever entry (keep or reject), PRD-573 v3.2 points here with the result, and the file moves to `docs/PRDs/done/` in the commit that finishes it.

## Decisions

(none yet)

## Blocked on

(none)
