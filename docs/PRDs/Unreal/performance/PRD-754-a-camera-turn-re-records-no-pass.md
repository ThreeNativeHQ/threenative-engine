# PRD-754 — A camera turn re-records no pass

**Status:** DEFERRED (2026-10-28): Phase 2 and the judge are done; the Phase 3 CPU gate fails (recording CPU falls 77% on Midway native and 55% on the shooter web turn, the gate asks 80%). Revisit condition under `## Blocked on`.
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

**Status:** DONE (2026-10-27): the web shooter's ceiling is above the gate, so the PRD goes on.

- [x] The frame report splits `renderMs` into prepare and `Renderer::render`, and counts bundle rebuilds by cause (order, uniform offset, visible count, other) and direct encodes by pass. `perf` prints stages that sum to frame CPU within 5%. proof: a red-green `perf.spec.ts` case; a native Midway run and a web shooter run with the counts recorded here
  result: cacb23cac and 162093baf (`perf.spec.ts` PRD-754 case red without the parser, green with it). Midway native
  flight (`flight-bench-desktop.playtest.json`, player at 1c730892e, `TN_STABLE_PASSES=0`, load 60): `perf` prints
  "frame CPU 93.146 = game JS 75.080 + render prepare 11.258 + render encode 6.146 + other 0.662 (the three stages
  cover 99.3%)"; main rebuilds over 2538 frames: 663 order, 0 uniform offset, 144 visible count, 6 other; shadow
  passes 73.4 direct-encoded draws a frame. Shooter web (sandbox `--genre fps --template shooter`, NVIDIA Turing,
  6 s mouse sweep, 2 runs): rebuilds 68 and 54 visible count, 0 and 2 order, 19 and 6 other, of 105 and 66 frames
- [x] The ceiling is recorded: CPU per frame spent in recording and encode on Midway and the shooter, native and web, during a scripted camera turn. If it is below 0.5 ms per frame on both games, the PRD stops and moves to Deferred with that number. proof: the Phase 1 counters with `profile:wasm-page --cpu-work` and the native frame report
  result: Midway native, recording plus shadow encode in render-thread CPU time (`CLOCK_THREAD_CPUTIME_ID`):
  **0.328 ms a frame** (0.164 recording + 0.163 shadow encode; p50 0.185, p95 0.927), below the gate. Shooter web,
  the Wasm wall meter scaled by the game worker's CPU/wall ratio from a Chrome trace of the turn (`tdur`/`dur` of its
  top-level tasks): **0.85 and 1.16 ms a frame** ((1.021 + 0.521) x 0.553 and (3.094 + 0.367) x 0.335, load 62),
  above it. Not run: `profile:wasm-page --cpu-work`, which has no camera-turn input (see Decisions); the Midway web
  and shooter native cells (the shooter web cell already clears the gate)

### Phase 2: Stable recorded passes

**Status:** DONE (2026-10-28) at a9caf82d3.

- [x] The shadow, normal and velocity passes replay bundles, pixel-identical to direct encode. proof: red-green `native_engine_batched_vs_unbatched`; `profile:wasm-page --gpu-calls` ratio below 1.0
  result: `native_engine_render_database_stable_passes_match_direct` (7790 covered pixels, 0 differ; the shadow pass
  records 5 draws, then 0) and `camera_cull_keeps_bundle` (normal and velocity passes 0 bytes differ, a second lap
  records 0 aux draws stable against 100 direct), red before bcf00660c and green after; `batched_vs_unbatched` stays
  green (0 differ). `profile:wasm-page --gpu-calls` on the shooter (sandbox at 7f78a57f4, NVIDIA Turing, load 44):
  about 46 WebGPU calls a frame knob on against about 184 knob off, ratio 0.25
- [x] Opaque draws sort state first (pipeline, then material, then geometry), and each record keeps a persistent uniform slot. A camera turn on an opaque scene rebuilds nothing. proof: red-green `native_engine_batched_vs_unbatched`; the Phase 1 rebuild counter at zero over a scripted turn; `--gpu-time` ratio at most 1.0 (state-first order can cost overdraw: the depth prepass must hold it)
  result: on an opaque scene, `camera_cull_keeps_bundle`'s scripted lap records 0 draws stable against 57 direct
  (red before bcf00660c). On the games at a9caf82d3, order rebuilds fall from about 600 a Midway flight and 70-74 a web
  turn to 0; a draw seen for the first time records alone in a delta bundle (`cull_keeps_main_bundle` first-seen arm:
  1 row recorded, 0 differ), so 7-8 re-sorts a flight and 1 a web turn remain. GPU: `profile:wasm-page` has no
  `--gpu-time`, so the Midway pairs' GPU timer stands in (see Decisions): p50 10.83 ms off against 10.82 ms on, ratio
  1.00 (mean ratio 1.015, inside the 8.8-11.9 ms run spread). Judge NEUTRAL (Phase 3)
- [x] Batch stores keep their capacity, and draws use `drawIndexedIndirect` (`firstInstance` 0). A culling turn rebuilds nothing, `info.render` matches, and CPU falls on Chrome. proof: `native_engine_camera_cull`; `profile:wasm-page --cpu-work` ratio below 1.0
  result: `native_engine_renderer_cull_keeps_main_bundle` (opaque arm: a cull and the draw's return record 0, 0 differ,
  draws and triangles equal to direct encode) and `native_engine_camera_cull` pass. Chrome, the shooter in its worker
  at a9caf82d3 (3 pairs, load 11-16, NVIDIA Turing): recording CPU of the turn 0.299/0.334/0.318 ms knob off against
  0.143/0.159/0.131 ms on, ratio 0.45; `--gpu-calls` ratio 0.25. `--cpu-work` reads the page main thread only, so the
  worker meter stands in (see Decisions)

### Phase 3: Prove it on games

**Status:** DEFERRED (2026-10-28): the CPU fall is below the gate; frame p50/p95 and the judge pass.

- [ ] Midway native and the shooter on web: CPU per frame falls by at least the Phase 1 ceiling minus 20%, with frame p50 and p95 no worse. Paired A/B from one code state with a knob, three runs per arm, host load recorded. proof: `scripts/midway-bench/flight.sh` and `profile:wasm-page` pairs
  result (gate FAILS, Deferred): recording plus shadow encode CPU per frame at a9caf82d3, knob off then on, 3 pairs.
  Midway native flight (load 5-21): 0.132/0.126/0.152 against 0.030/0.033/0.031 ms, a 77% fall (pairs 77/74/80%);
  frame p50 47.7 against 47.6 ms and p95 59.0 against 55.7 ms, no worse. Shooter web camera turn (Wasm meter, load
  11-16): 0.299/0.334/0.318 against 0.143/0.159/0.131 ms, a 55% fall (pairs 52/52/59%). The gate asks 80%. What is left
  knob on: Midway 0.017 ms of shadow pass setup and about 0.007 ms of transparent re-sorts, which the knob-off arm pays
  too, and 0.007 ms of row checks; on the web, a pass that records about 119 draws on a third of the turn frames
  (aux or velocity; native holds it) and the row checks in Wasm. Earlier builds: 63% and 59% at 7f78a57f4
- [x] A fresh visual judge returns NEUTRAL or IMPROVEMENT on BEFORE/AFTER frames of Midway and the shooter (`--browser-recipe webgpu`, `adapter.info` checked, two runs per arm). proof: the verdict in this box and images on PR #574
  result: NEUTRAL on both games, no criterion fails, judged twice by fresh read-only Opus subagents with criteria
  written before the AFTER frames: at 7f78a57f4 and again at a9caf82d3 (the delta bundle draws first-seen rows last;
  the judge checked newly visible objects for z-fighting). Shooter web (headed, `--browser-recipe webgpu`,
  `adapter.info` nvidia turing), poses spawn, turned, turned-far, after; Midway native (Dawn/Vulkan, same GPU), poses
  takeoff, cockpit, reargun; two runs per arm. Mean |diff| BEFORE-AFTER at a9caf82d3: 0.20-0.63 (shooter) and 0.00-0.01
  (Midway) against BEFORE-BEFORE 0.24-0.66 and 0.00-0.63. Images: `~/.cache/tmp-tn/prd754/judge/sheets/`; posting them
  on the follow-up PR waits for its branch (the #574 lead names it after the merge)

## Done when

Every box is ticked, `PERFORMANCE-LEARNINGS.md` has the lever entry (keep or reject), PRD-573 v3.2 points here with the result, and the file moves to `docs/PRDs/done/` in the commit that finishes it.

## Decisions

- 2026-10-27 (lane): the recording meters read render-thread CPU time on Linux (wall time elsewhere). On this host
  (load 50 to 80) the wall meter read Midway at 2.18 ms a frame against 0.33 ms of CPU time.
- 2026-10-27 (lane): the web ceiling uses a Chrome trace of the worker thread instead of `profile:wasm-page --cpu-work`,
  because the profiler samples a still page and the box needs a camera turn. The Wasm meter is wall time, so it is
  scaled by the worker's measured CPU/wall ratio over the same turn (assumes preemption spreads evenly over the frame).
- 2026-10-27 (lane): state-first order sorts by kind, side, material, geometry and id, as a proxy for pipeline, then
  material, then geometry: the pipeline is resolved after the sort. A frame with an opaque draw that does not write
  depth or colour keeps three's depth order, since only then does order change a pixel.
- 2026-10-27 (lane): the Phase 2 proofs name `native_engine_batched_vs_unbatched` and `native_engine_camera_cull`, which
  test batching and culling, not recording. The red-green proofs are the cases written for it beside them:
  `stable_passes_match_direct`, `camera_cull_keeps_bundle` and `cull_keeps_main_bundle`; the named cases stay green.
- 2026-10-27 (lane): transparent draws do not keep rows. Their back-to-front order moves with the camera, and kept
  transparent rows cost as much as they saved (native shooter, 608 of 717 draws transparent: 0.151 ms on against
  0.153 ms off). They record a second bundle keyed as direct encode keys them, so they never record more than the knob
  off. UE 5.8.3 also re-sorts translucent draws each frame by view (`UpdateTranslucentMeshSortKeys`,
  `Engine/Source/Runtime/Renderer/Private/MeshDrawCommands.cpp:164,1149`).
- 2026-10-27 (lane): the knob stays on by default (`TN_STABLE_PASSES=0`, `?tnStablePasses=0` turn it off). The CPU of a
  turn falls on both games and the judge is NEUTRAL; the open risk is the web frame p50 read 1.10x and 1.19x under
  Xvfb on a loaded host, for the owner to weigh with the quiet-host pairs.
- 2026-10-28 (lane): two proof tools named here do not exist or cannot see the game. `profile:wasm-page` has no
  `--gpu-time`, so the Midway A/B pairs' GPU timer (`TN_PLAYER_GPU_TIMING`, the same runs) gives the GPU ratio, and
  `--cpu-work` reads the page main thread (the PRD-752 worker KPI), so the worker's own recording meter over the
  scripted turn gives the Chrome CPU ratio, as Phase 1 sized it.
- 2026-10-28 (lane): rows seen for the first time follow the sorted rows in a delta bundle per pass; a full sort waits
  until they outgrow a quarter of the rows. Opaque order is free under the state-first rule already (same depth test);
  UE 5.8.3 caches a mesh draw command when its primitive is added and does not rebuild the others.
- 2026-10-27 (lane): the Midway judge frames are native desktop (the arm the Midway CPU claim covers), not
  `--browser-recipe webgpu`; the shooter frames are the browser arm.

## Blocked on

- The Phase 3 CPU gate (80%) is Deferred at 77% (Midway native) and 55% (shooter web turn). Revisit when (a) the web
  pass that still records about 119 draws on a third of the turn frames is found (aux or velocity; it holds on native),
  and (b) shadow pass setup (0.017 ms a Midway frame, both arms) or the translucent re-sort has its own lever (UE 5.8.3
  re-sorts translucency every frame too). Then rerun the Phase 3 pairs with `ab-midway.sh` and the turn probe.
