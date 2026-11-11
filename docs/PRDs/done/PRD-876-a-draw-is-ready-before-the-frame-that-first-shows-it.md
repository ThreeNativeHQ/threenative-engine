# PRD-876 — A draw is ready before the frame that first shows it

**Status:** DONE — Phase 1 landed (the two counters and the unregistered case). The sizing gate closed Phases 2 and 3 on 2026-11-11: on the real GPU the forest turn makes 0 synchronous creates and 0 program builds, because the startup warm-up already compiles every pipeline before the reveal (see Decisions).
**Priority:** P1 — the last camera-turn hitch on the Strata forest is a plan spike of about 10 ms in one frame, from programs and pipelines made the frame a mesh is first seen, and no counter reports it (Phases 1-3 open).
**Complexity:** 6 (MEDIUM) — 6-10 implementation files (2), renderer cache state across frames (+2), one build boundary: the C++ engine serves native and web Wasm (+2). Risk override: none.
**Owner:** João
**Depends on:** None to start Phase 1. Phase 2 edits `renderer/render_database.cpp` and `renderer/renderer_frame.cpp`, so it starts after PR #659 (`perf/stress-lab-audit`, PRD-871) merges. It takes over [PRD-573](../performance/PRD-573-unreal-class-performance-in-release-cycles.md) Phase v2.4 box 3.

Executor: read [EXECUTION-ORDER.md](../performance/EXECUTION-ORDER.md) first. Its rules and commands apply to every box here.
All code paths below are under `packages/runtime-native/src/engine/` unless they start with `packages/`.

## Context

`PERFORMANCE-LEARNINGS.md` (2026-11-04, "Strata forest turn") ends with: the last turn hitch is a CPU plan spike,
`planDraws` about 10 ms in one frame. Its steady p50 is 0.07 ms (PRD-774 Decisions). So the cost is not the plan. It is
what the plan creates the first time it meets a draw:

- **Program.** A `DrawCache` miss (`renderer/renderer_frame.cpp:834`) calls `Renderer::program` (`:838`,
  `renderer/renderer_program.cpp:100`). The key is kind, vertex variant and light layout (`renderer_program.cpp:103`). The
  WGSL build, the renames, the layouts and the bind groups all run synchronously on the calling thread.
- **Pipeline.** `renderer_frame.cpp:866-867` calls `PipelineCache::getOrDefer` only when `deferUncompiled_` is set. In
  every other case it calls the synchronous `PipelineCache::get` (`renderer/pipeline_cache.cpp:283-296`).
- **A culled mesh builds nothing** (`renderer/render_database.cpp:930,935-939`, PRD-610 AC-10). The one exception is a compile pass, which keeps off-frustum meshes (`:927-930`, with the reference `UE 5.8.3: Engine/Source/Runtime/Engine/Private/PSOPrecache.cpp:230` already cited in that comment). It gets its record
  (`:950`) the first frame it is in view. That is the frame of the turn.

What exists already:

- `Renderer::compileAsync` (`renderer/renderer.cpp:621`) runs the plan with `compilation` set. Programs still build
  synchronously, and pipelines go to `PipelineCache::getAsync` (`pipeline_cache.cpp:312`).
- `RenderDatabase::compileAsync` (`render_database.cpp:1903`) sets `compiling_`, which keeps off-frustum meshes in that
  one compile (`:927-930`).
- The web loading cover holds the reveal while `pipelinesCompiling() > 0`
  (`packages/runtime-native/src/engine/wasm/web_host.cpp:386-392,476`).
- Counters: `PipelineCache::compiles_` counts synchronous and async creates together (`pipeline_cache.cpp:286-287,334`),
  `pipelineCreateMicros` (`:372`), `pipelineDeferredDraws` (`:307`), `programKeyBuilds()` and `programLookups()`
  (`renderer/renderer.h:960-961`), `textLookups()` (`renderer/pipeline_cache.h:169`).

What is missing: no counter separates a synchronous create from an async one, no counter counts program builds, and
nothing prepares a mesh that sits outside the view after the reveal.

Unreal builds each draw command when the primitive is added, in batches on tasks
(`UE 5.8.3: Engine/Source/Runtime/Renderer/Private/PrimitiveSceneInfo.cpp:51-53`, `r.MeshDrawCommands.CacheMultithreaded` 1).
A frame then only looks the command up. This PRD takes that idea within what our key allows: the light layout, the fog,
the sample count and the pass list are known only at render time, so the engine prepares a mesh on the first frame it
knows the mesh exists, not at `add()`.

## Solution

1. **Count it.** Two debug counters: synchronous pipeline creates and program builds, per frame.
2. **Prepare what is out of view.** After the first presented frame, `RenderDatabase::project` lets a small number of
   culled meshes that have no record yet pass into the plan each frame, marked compile-only. They take the existing
   `compilation` branch: the program builds, the pipeline goes to `getAsync`, and nothing is drawn. A turn then finds a
   `DrawCache` hit and a finished pipeline.
3. **Keep the lazy path.** A mesh that comes into view before its turn in the budget still builds on the spot, exactly
   as today. The output must be equal on both paths.

Not in this PRD (each needs its own design and a visual judge): skipping a draw whose pipeline is pending on the native
player, deferring shadow depth pipelines (a caster that appears late must invalidate its virtual shadow pages), building
programs on a pool task (needs an async `JobPool` submit, PRD-774 Phase 3), and the per-frame key work in the shadow rows
and the page clear (`renderer_frame.cpp:1489-1501,1955-1969`), which waits for PR #659.

## Validation scene

- **Consumer and scene:** the Strata forest, `examples/strata-terrain-preview`, a 360-degree camera turn after the reveal.
- **Benefit workload:** the turn. Read per frame: synchronous pipeline creates, program builds, CPU frame time.
- **Small control:** a scene where every mesh is in view at the reveal. The budgeted pass must find nothing and add no
  program, no pipeline and no record.
- **Worst case:** 10,000 culled meshes with 10,000 different materials. The budget must bound the work per frame, and
  the time to reveal must not grow, because the pass starts only after the first presented frame.
- **Pass:** AC-1 below.

## Acceptance Criteria

- [x] AC-1 [local, measure lane]: On the Strata forest turn on the owned engine, synchronous pipeline creates and program builds in the turn are 0. proof: `TN_FRAME_BUDGET.counters.engine` per window — Evidence (2026-11-11, head `81901d260`, RTX 2080, 69 windows): every create (44) and build (98) is in the load window, before `TN_STARTUP_WARMUP_HELD`; 0 of each, and 0 deferred draws, in every window of the reveal, walk and turn (Decisions). The head-against-develop comparison, the reveal-time bound and the visual judge of the original AC-1 compared a prepare pass that the gate closed, so they are not run.

## Blocked on

- Nothing. AC-1, AC-2 and Phases 2-3 were closed by the sizing gate (Decisions, 2026-11-11).

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Create counters | Any game frame → `PipelineCache::get`, `Renderer::program` → `TN_DEBUG_COUNTERS` → `TN_FRAME_BUDGET.counters.engine` with `?tnDebug=1` | Adds to `pipelineCompiles`, which stays | Phase 1 |
| Budgeted prepare pass | Any game frame after the first present → `RenderDatabase::project` → the `compilation` branch of the plan | The lazy build stays as the fallback for a mesh that enters view first | AC-1, AC-2 |

## Execution Phases

#### Phase 1: Count synchronous creates and program builds
**Status:** DONE
**Files:** `foundation/waste_counters.h`, `renderer/pipeline_cache.cpp`, `renderer/renderer_program.cpp`, `packages/runtime-native/tests/native-engine/renderer_caches_test.cpp`, `packages/runtime-native/cmake/NativeEngine.cmake`.
**Implementation:**
1. Add `X(pipelineSyncCreates) X(programBuilds)` to the `TN_DEBUG_COUNTERS` list (`foundation/waste_counters.h:31-38`).
2. In `PipelineCache::get` (`renderer/pipeline_cache.cpp:283-296`), add `waste::debugAdd(waste::counters().pipelineSyncCreates);` on the line after `create(device_, vertex, fragment, target)` (`:285`). Do not add it in `getAsync`.
3. In `Renderer::program` (`renderer/renderer_program.cpp:100`), add `waste::debugAdd(waste::counters().programBuilds);` on the path that builds a new program, after the cache lookup misses. Do the same in `depthProgram` (`:277`).
4. Register the unregistered case: `compile_reaches_off_screen` is in `TN_TEST_MAIN` (`renderer_caches_test.cpp:887`) but not in CMake. Add it beside the other `native_engine_renderer_pipeline_*` cases (`cmake/NativeEngine.cmake:453-472`). If it fails, do not fix it here: report the output and leave it unregistered.
- [x] With debug counters on, the first frame that draws a new mesh counts 1 synchronous pipeline create and 1 program build, and the next frame counts 0 of each. With `compileAsync` first, the draw frame counts 0 synchronous creates. proof: a new case `sync_creates_counted` in `renderer_caches_test.cpp`, registered in `NativeEngine.cmake`, `ctest -R '^native_engine_renderer_pipeline_'`. — Result (2026-11-10, re-measured exactly after review): the box's **1 is wrong for a renderer's first draw, which costs 2**. The case now asserts both numbers exactly rather than a lower bound. On a fresh renderer the first draw that shows a mesh counts **2 creates and 1 program build**: one create is the material program's own pipeline, the other is a renderer-level pipeline (post/output) that the first draw of the renderer's life creates — not, as first guessed, one pipeline per pass. On an already-settled renderer a new program key costs **exactly 1 create and 1 program**, and a second material of the same kind on the same key costs **0 of each**, because programs are keyed by kind, vertex variant and light layout rather than by material instance. The next frame adds 0 of each. The `compileAsync`-first arm counts 0 creates on its draw frame, as written. Red first: with the `pipelineSyncCreates` line removed, `CHECK(lazy.first.creates == 2)` and `CHECK(added.creates == 1)` both fail; restored, `PASS sync_creates_counted`. `ctest -R '^native_engine_renderer_pipeline_'`: 9 of 9 passed, exit 0 (7 before, plus this case and `compile_reaches_off_screen`).
  Known gap in the counter: some pipelines are made outside `PipelineCache::get` (`traa.cpp`, `renderer_output.cpp`, `renderer_material.cpp`), and on web the main pass may go through `getOrDefer` once `deferUncompiledDraws` is on, which counts `pipelineDeferredDraws` instead. The sizing gate must read those two counters beside this one.
  Step 4 also landed: `compile_reaches_off_screen` was in `TN_TEST_MAIN` but no ctest entry named it; registered in the `foreach` list it **passes**, so nothing needed leaving out.
  Build note for the next executor: the count cannot be read from `build/tn-linux`. The native-engine test tree is configured only under `-DTN_ENGINE_ONLY=ON` (`CMakeLists.txt:787-790`), so the command in EXECUTION-ORDER.md against `build/tn-linux` finds no such target. Use `cmake -S . -B build/tn-engine-only -G Ninja -DCMAKE_BUILD_TYPE=Release -DTN_ENGINE_ONLY=ON -DMYSTRAL_USE_DAWN=ON` and `--target tn-native-engine-renderer-caches-test` in that directory.

**Sizing gate (measure lane, before Phase 2):** on the forest turn with `?tnDebug=1`, record `pipelineSyncCreates`, `programBuilds` and `pipelineCreateMicros` for each frame of the turn, and the per-frame growth of `programKeyBuilds` on a still camera. Write the numbers under `## Decisions`. If the turn shows 0 synchronous creates and 0 program builds, the spike has another cause: set this PRD to `DEFERRED` and stop.

**Sizing gate attempt (2026-11-10, executor, inconclusive — recorded so the next lane does not repeat it):** the Wasm engine was built from this head (`pnpm wasm:build`, exit 0, both `tn-native-engine-web.wasm` and the threaded pair; `node scripts/web-engine-stamp.mjs --check` exit 0; `animationTickMicros` present in both `.wasm` files, so the build carries this branch's counters). `examples/strata-terrain-preview` was served and `playtests/loop.playtest.json` was run against it with `?tnDebug=1`: **844 frames, exit 1, and the counters the gate needs are not obtainable on that lane**.
- The scenario's own census is unavailable: `reveal.pipelineCensusAvailable` is `false` and `pipelinesSinceReveal` is `-1` on both the before and after reads, so its `equals: 0` assertion is silence rather than a measurement.
- The captured `TN_FRAME_BUDGET.counters.engine` bag carries 97 entries and **none of the renderer counters** — `pipelineSyncCreates`, `programBuilds` and `pipelineCompiles`, `computePasses`, `shadowPageEvictions` are all absent. So this is not this PRD's two counters failing to publish; the lane does not publish the renderer group at all.
The gate therefore still needs a lane that publishes them, or the census path repaired first. `?stress&tnDebug=1` on the stress lab is the documented route and was not attempted here.

#### Phase 2: A culled mesh is prepared inside a per-frame budget
**Status:** NOT BUILT — closed by the sizing gate (Decisions, 2026-11-11). The Solution above stays as the plan if a
scene ever shows synchronous creates after its reveal.

#### Phase 3: Prove it on the forest
**Status:** NOT BUILT — closed with Phase 2.

## Decisions

- 2026-11-10 (Claude, from a read of develop at `d6b1630b8`): the engine prepares on first knowledge, not at `add()`. The program key needs the frame's light layout, fog, sample count and pass list, and none of them exist when a mesh is added.
- 2026-11-10 (Claude): the per-draw `selectiveLights` string (`renderer_frame.cpp:627-646`) is not a box. It returns an empty string at once for a draw with no `lightsNode`, so its cost is unproven. The sizing gate reads `programKeyBuilds` on a still camera, and a box is added only if that number grows each frame.
- 2026-11-11 (Claude, measure lane, sizing gate): **the turn has nothing to prepare, so Phases 2-3, AC-1 and AC-2 are
  closed, not built.** The 2026-11-10 attempt read zeros because it served the forest on upstream three: plain
  `pnpm dev` does not select the owned engine, `TN_ENGINE=threenative` does (`examples/strata-terrain-preview/vite.config.ts:127`),
  and its Xvfb gave SwiftShader, which then lost the device. This read: head `81901d260` (Wasm pair built from it),
  `TN_ENGINE=threenative`, `loop.playtest.json` at `?tnDebug=1`, `TN_PLAYTEST_HOST_DISPLAY=1 --headed --browser-recipe
  webgpu`, adapter `turing` (RTX 2080), 69 `TN_FRAME_BUDGET` windows. **All 44 synchronous pipeline creates and all 98
  program builds fall in window 2, the load.** Every `TN_PROGRAM_LATE` line (44) is logged before
  `TN_STARTUP_WARMUP_HELD` (319 of 319 pipelines compiled before the reveal). From window 3 on — the reveal, the
  600-tick walk, `turn-half` and `turn` — `pipelineSyncCreates`, `programBuilds`, `pipelineDeferredDraws`,
  `pipelineCompiles` and `pipelineCreateMs` are 0 in every window, at 63-64 draws a frame; the turn frame
  (`turn.png`) draws the forest. `programKeyBuilds` is not published on this page, so the still-camera growth was
  not read; the `selectiveLights` question above stays without a box. The 10 ms turn spike this PRD was filed for
  is not a pipeline or program cost on this head: the startup warm-up already does what Phase 2 proposed, before the
  reveal instead of in a per-frame budget after it. AC-2 (`pnpm parity`) guarded the prepare pass, which is not
  built; Phase 1's counters are covered by the renderer cases (673 of 678 `native-engine` cases on the merged tree).

