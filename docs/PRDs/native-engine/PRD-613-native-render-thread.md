# PRD-613 — Native render thread: cull, project and encode leave the main thread

**Status:** PARTIAL
**Priority:** P1 — the largest measured lever for PRD-610's 2x to 3x bar: render prepare and encode cost 1.65 / 2.89 / 4.41 ms of the native main thread per frame on Midway, and no box below is done.
**Complexity:** 7 (HIGH)
**Owner:** João
**Depends on:** PRD-610 (the matched yardstick, AC-15; this PRD delivers PRD-610 AC-16)

Complexity: 7 → HIGH (11+ implementation files: 3, new render-thread system: +2, concurrency and object lifetime across threads: +2); risk override: none.

## Context

PRD-610 sets the owner bar: the native desktop player is 2x to 3x faster than three.js in Chromium on Midway. The matched yardstick (PRD-610 AC-15) measures main-thread CPU per frame in 1,000-tick fixed-step windows at three poses. Pair 1 at engine `e3271a19c` (parity PASS, Xvfb, CPU and instructions only):

| Pose | three.js | native main thread | of which render (`renderCpuMs`) | render wall: prepare / encode+submit |
|---|---|---|---|---|
| takeoff | 9.09 ms | 7.31 ms | 1.65 ms | 1.33 / 0.41 ms |
| cockpit | 9.55 ms | 9.07 ms | 2.89 ms | 3.49 / 1.18 ms |
| rear gunner | 14.35 ms | 10.95 ms | 4.41 ms | 4.54 / 1.67 ms |

Chromium splits this work across the renderer main thread, the compositor and the GPU process. The native player runs it all on one thread. Present already runs on the `GpuThread` (old PRD-610 AC-9, −19% main-thread CPU).

A main-thread `perf record` (cycles:u, IPC 0.64, L1d miss rate 6.9%) puts `RenderDatabase::project` at 6.7%, `ProjectedCull::apply` 3.7%, `boundingSphereOf` 1.7%, `findRecord` 1.6%, `renderPrepared` 1.1% and `GeometryCache::sync` 1.0% of samples. Placement screens (one CCD, no SMT sharing) and the HUD snapshot mode did not move cycles, so the cost is the main thread's own work, not interference.

Package rule (`packages/runtime-native/AGENTS.md`): the JavaScript runtime that owns `THREE.Scene` also owns the renderer, and the `Object3D` tree is never mirrored across threads. Heavy systems use batched transfer surfaces. A per-frame packet of draw data is a batched transfer surface, not a mirrored tree.

Known hazards: encode syncs a live `BufferStore` and clears its update ranges (`renderer/renderer.cpp`, `renderer/geometry_cache.cpp`); `DrawItem.material` points to database-owned params (`renderer/render_database.cpp`); `cmake/CheckNoBlockingWaits.cmake` allows only the `GpuThread` join.

### Stage 0 split (2026-10-14)

`TN_RENDER_PREPARE_SPLIT=1` (diagnostic, off by default) adds the render phases to `TN_PLAYER_FRAME`. Two screens (`s0-split-2`, `s0-split-3`) ran on a loaded host (load 9 to 27 from other sessions), so absolute times read about 1.5x to 2x high; the shares and counts hold. In-window medians, wall ms per frame, takeoff / cockpit / rear gunner:

| Phase inside `database.render` | takeoff | cockpit | rear gunner |
|---|---|---|---|
| GPU-joint prep | 0.10 | 0.09 | 0.09 |
| Scene prepare (`RenderDatabase::prepare`: matrix 0.04 to 0.14, project 1.50 to 1.82, batch, other) | 1.85 | 2.25 | 3.05 |
| **Ocean reflection pass** (`renderReflections`) | 0.85 | 2.67 | 4.32 |
| of which reflection prepare / encode | 0.43 / 0.30 | 0.57 / **1.96** | 1.44 / 2.24 |
| Main encode and submit | 0.87 | 2.09 | 3.13 |
| Draw items main / reflection | 43 / 5 | 158 / 8 | 352 / 202 |
| Geometry bytes uploaded per frame | 0 | 576,000 | 576,000 |

Findings:

- The ocean's planar reflection (`WaterSurface3D`, `reflection: {resolutionScale: .5, layers: 1 << REFLECTED_LAYER}` in the game) is the largest render phase at cockpit and rear gunner: about half of the render wall. The layer mask reaches the native reflection camera (`three-native/src/reflector.ts` runs the `getVirtualCamera` wrapper once against the engine camera).
- At cockpit the reflection pass encodes 8 draw items in about 2 ms (loaded). That cost is per pass, not per object. A call-graph profile names it before any lever is built.
- Batched members are 26 / 27 / 13 of 43 / 158 / 352 draws, so the plain-opaque compact lane that stage 2 targets is a small share at cockpit and rear gunner.
- Consequence for the plan: the reflection pass cannot take the inline fallback. It moves to the render thread with the main pass, and the per-pass reflection cost is a lever in its own right.

## Solution

A second `GpuThread` instance is the render thread (created beside the existing one in `player/run.cpp`). It adds no new class, condition variable or join, so `cmake/CheckNoBlockingWaits.cmake` needs no waiver.

- **Baton rule.** After the main thread waits on the render thread and then the `GpuThread`, both are idle. Only in that window does main touch the `Renderer`, `GpuResources`, `GeometryCache`, `PipelineCache` and the queue: geometry and canvas-texture sync, handle resolve, the retire drain. Then it posts packet N. While the render thread runs, main touches none of them. One frame is in flight in total.
- **Frame packet, no mirrored tree.** Main keeps the traversal, LOD, skeleton update, shadow-camera update, `onBeforeRender` callbacks and `ProjectedCull::apply` (about 0.3 ms; it writes JS-visible `visible`). The draw data that main already writes (`items_`, `Record::Draw`, skinned palettes, batch stores, lights, camera state, shadow frustums) becomes two ping-pong sets selected by frame parity, so stage 1 copies nothing. Stage 2 adds a flat per-frame `MeshRef` array (about 190 B per visible plain opaque mesh) with per-frame deduped `GeometryInfo` and `MaterialSnap` tables. The packet has no parent or child links and no JS-owned pointers, and nothing mutates it after the post.
- **Render thread job.** Apply deltas (output, sample count, size, overlay), then the reflection passes (their prepare runs on main with the scene prepare; their encode runs here), then resolve (cull, batch, sort, fog and environment), encode, prepare the blit, post present to the `GpuThread`, and mail `lastFrame_`, diagnostics and `renderThreadCpuMs` back. Encode exceptions are caught and rethrown at the next handoff.
- **Lifetime.** One mutex guards `GpuResources::Shared` (`destroy`, `submit`, completion). A `shared_ptr<Packet>` holds CPU references and is retired by a final `GpuThread` job; its destructor only queues objects for main to drop, because the last reference to an `Object3D`-adjacent object must die on main.
- **Inline fallback.** The first frame, resize, held renders, `tn.renderTarget`, `readTarget`, `readFrame` and `compileAsync` wait for both threads and take today's inline path. A diagnostic counts fallbacks; Midway must show zero in steady state.
- **Switch.** `TN_RENDER_THREAD=0|1`, default on once Phase 3 passes.
- **Hooks.** `renderCpuMs` becomes main-thread only (the KPI). `renderEncodeMs`, `renderThreadCpuMs` and `renderer.info.render` arrive from the mailbox one frame late, as `gpuThreadCpuMs` does today. Screenshots and readbacks post after encode N on the render thread, so they still read frame N.

Estimated main-thread ms removed (takeoff / cockpit / rear gunner), not measured: stage 1 about 0.2 / 0.6 / 1.0; stage 2 about 1.0 / 1.9 / 2.7 cumulative, after a 0.3 to 0.45 ms packet cost. Takeoff is the risk: the matrix walk stays on main. Stage 0 measures it before stage 2 is built. Stage 3 (shadows, skinning, `GpuJointScene` on the render side, −0.1 to −0.3 ms) runs only if stage 2 misses its target, as a follow-up.

Measurement: PRD-610 tier ladder. Tier 0 is a ctest. Tier 1 is one matched native screen (about 4 min). Tier 2 is three alternating pairs with parity PASS and the visual judge. Each stage opens and closes a cycle in the dashboard ledger (`scripts/midway-bench/cycle.ts`).

## Acceptance Criteria

Boxes live under each phase.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Render thread | `player/run.cpp` frame loop → render thread → `GpuThread` | `database.render` on the main thread is removed from the frame loop | Phase 1 to 3 |

## Decisions

- 2026-10-14 (owner): "this shit that's days of work, you have to extract into a separate prd". PRD-610 AC-16 moves here; PRD-610 keeps AC-16 as the consumer box, proved by this PRD.
- 2026-10-15 (resumed evaluation): Stage 1 is implemented at `a57423817`, default off; its acceptance boxes remain open. Fresh exploratory screen `rt-resume-off-1` passes three assertions on NVIDIA RTX 2080, with exactly 1,000 updates/renders per window: main-thread CPU 7.743 / 8.277 / 12.049 ms and instructions 20.482 / 22.748 / 29.980 M per frame (takeoff / cockpit / rear gunner). Binary SHA-256 `2ce82ac2aabbeb195592b3d3b499b113208886d7e2d7292b9de6d87c81247713`, game SHA-256 `e69f72523ba34517466240deb354df5cbae4c5566d981320d3ef984f55fcb709`; raw screen records are under `~/.cache/tmp-tn/screens/`. The old package receipt names the baseline binary, so these screens are not qualified provenance. Candidate comparison, parity, visual review and TSan remain unverified. Read-only review also identified Android presenter/surface destruction before the render-thread fence, including lifecycle suspension; fix and verify that ordering before claiming platform readiness.
- 2026-10-15 (Stage 1 screen closed INCONCLUSIVE): `rt-resume-on-1` also passes all three assertions and exact 1,000-update/render windows. CPU is 9.557 / 11.929 / 14.158 ms (+23.43% / +44.12% / +17.51%); instructions are 20.060 / 21.095 / 27.036 M (-2.06% / -7.27% / -9.82%). The switch is active: render-thread CPU medians are 0.283 / 0.792 / 1.016 ms; cumulative fallback count stays at one, so no additional steady-window fallback occurred. Host load varied, and the cause of the CPU/instruction disagreement remains unproven. Dashboard cycle `prd613-s1-render-thread-resume` is closed; no winner promoted. Diagnose the disagreement before repeating timing. Parity, visual review, TSan and qualified provenance remain open.
- 2026-10-15 (attribution and document checks): main-thread IPC fell from 0.634 / 0.657 / 0.591 to 0.502 / 0.428 / 0.464; game JS CPU medians rose from 4.764 / 4.982 / 6.186 to 6.078 / 7.302 / 7.950 ms. `GpuThread::wait` parks on a condition variable, so busy polling is not the cause. Existing `SCREEN_TASKSET` controls only a shared process-tree mask, not separate main/HUD/render-worker placement; prior coarse placement screens do not isolate the new worker. Documentation validation passes: `pnpm check:docs`, the six required prose-lane suites (264 tests), `pnpm prd:progress` (1/8 boxes), and `git diff --check`. No native rebuild or TSan run is claimed.
- 2026-10-26 (resumed, branch `prd-613-render-thread`): the Stage 1 code reached `develop` through #493. The 2026-10-15 screens ran before `ThreadPlacement` (`66b51e3af`, always on since 2026-10-16), so the worker then shared cores with the game thread. The Stage 1 lever is measured again with placement on before any Stage 2 work. The old lane scratchpad (`ac15-pair.sh`, `cmp.py`, `screen-direct.sh`) did not survive the 2026-10-21 reboot; the screens now run through `scripts/midway-bench/flight.sh desktop` with `MIDWAY_MATCHED_CPU=1`.

## Execution Phases

### Phase 1 — Measure, then encode on the render thread

**Status:** IN PROGRESS
**Files:** `player/run.cpp`, `renderer/gpu_resources.{h,cpp}`, `renderer/render_database.{h,cpp}`, `renderer/renderer.cpp`, `tests/native-engine/render_thread_order_test.cpp`

- [x] **Stage 0 split.** One matched run logs the prepare split per pose (matrix walk, project, batch, other), the plain-opaque share of draws and the geometry bytes uploaded per frame, and the numbers land in this PRD. proof: matched native screen with `database.profiling` on — screens `s0-split-2` and `s0-split-3` (`TN_RENDER_PREPARE_SPLIT=1`), table in Context; loaded host, so shares only; the batched-member count stands in for the plain-opaque share.
- [x] **Order ctest.** Frame N encodes only frame N's packet; a live mutation of transform, material colour, attribute bytes or a uniform node after the post does not reach frame N; at most one frame in flight; a test hook that aliases live data goes red. proof: `ctest -R native_engine_render_thread_order`, plus a ThreadSanitizer build of that test — 2026-10-26 at `4d858296d`: Release `ctest -R native_engine_render_thread` 4/4 pass (order, uniform_order, reflection_order, baton). TSan (`-fsanitize=thread`, RelWithDebInfo, `TN_ENGINE_ONLY=ON`) 4/4 pass with 0 warnings on Mesa lavapipe 26.2.4 (`VK_ICD_FILENAMES`), suppressing only `libvulkan_lvp.so` and its `libLLVM.so.23.1`; the NVIDIA ICD crashes TSan's `calloc` interceptor inside `libnvidia-glcore` driver threads. Alias control: one local line in `Renderer::encodeFrame` that re-syncs each planned draw's live position store turns `order` red (5 failed `frame == expected[k]` checks); reverted, 4/4 green.
- [ ] **Stage 1 lever.** With `TN_RENDER_THREAD=1`, main-thread CPU per frame drops at all three poses against `TN_RENDER_THREAD=0`, every on-run below every off-run, parity PASS. proof: two alternating matched native screens per arm, `cmp.py`

### Phase 2 — Cull, batch and sort on the render thread

**Status:** NOT STARTED
**Files:** `renderer/render_database.{h,cpp}` (`project`, the compact lane, `addBatchMesh`, `batch`), `renderer/renderer.cpp`, `tests/native-engine/render_packet_parity_test.cpp`

- [ ] **Packet parity ctest.** Draw items built from the packet on the render side equal the inline items, in order, on the existing `prepare` corpus. proof: `ctest -R native_engine_render_packet_parity`
- [ ] **Stage 2 lever.** Main-thread CPU per frame drops by at least 1.0 ms at takeoff, cockpit and rear gunner against `TN_RENDER_THREAD=0`, parity PASS. proof: two alternating matched native screens per arm, `cmp.py`

### Phase 3 — Qualification

**Status:** NOT STARTED

- [ ] **Steady state has no fallback.** The fallback diagnostic reads zero after the first frame on all three Midway poses. proof: matched native run, `TN_PLAYER_FRAME` fallback counter
- [ ] **Three pairs.** Main-thread CPU per frame falls by at least 1.0 ms at all three poses, three alternating pairs, parity PASS in every run. proof: `ac15-pair.sh` with `TN_RENDER_THREAD=1` against the PRD-610 baseline pairs
- [ ] **Pixels unchanged.** A fixed-step capture of A1, A2 (off, off) and B (on) per pose gives diff(A, B) no larger than diff(A1, A2), and the visual judge returns NEUTRAL or better. proof: capture pair per pose, visual-judge subagent verdict
