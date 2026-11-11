# PRD-876 — A draw is ready before the frame that first shows it

**Status:** PARTIAL — Phase 1 landed (the two counters and the unregistered case). Phase 2 waits on the measure lane's sizing gate and on PR #659.
**Priority:** P1 — the last camera-turn hitch on the Strata forest is a plan spike of about 10 ms in one frame, from programs and pipelines made the frame a mesh is first seen, and no counter reports it (Phases 1-3 open).
**Complexity:** 6 (MEDIUM) — 6-10 implementation files (2), renderer cache state across frames (+2), one build boundary: the C++ engine serves native and web Wasm (+2). Risk override: none.
**Owner:** João
**Depends on:** None to start Phase 1. Phase 2 edits `renderer/render_database.cpp` and `renderer/renderer_frame.cpp`, so it starts after PR #659 (`perf/stress-lab-audit`, PRD-871) merges. It takes over [PRD-573](./PRD-573-unreal-class-performance-in-release-cycles.md) Phase v2.4 box 3.

Executor: read [EXECUTION-ORDER.md](./EXECUTION-ORDER.md) first. Its rules and commands apply to every box here.
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

- [ ] AC-1 [local, measure lane]: On the Strata forest turn, `head` against `develop`, two runs per arm: synchronous pipeline creates in the turn fall to 0, program builds in the turn fall to 0, frames over 20 ms in the turn do not increase, the time from navigation to reveal is within 5% of develop, and a fresh visual judge reads NEUTRAL or IMPROVEMENT on four turn poses. proof: `TN_FRAME_BUDGET.counters.engine` rows plus the judge verdict — Evidence: pending.
- [ ] AC-2 [local]: `pnpm parity` reports the same rows as develop. proof: `pnpm parity` — Evidence: pending.

## Blocked on

- Phase 2 start — unblocked when PR #659 merges, because both edit `renderer/render_database.cpp` and `renderer/renderer_frame.cpp`.

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
- [x] With debug counters on, the first frame that draws a new mesh counts 1 synchronous pipeline create and 1 program build, and the next frame counts 0 of each. With `compileAsync` first, the draw frame counts 0 synchronous creates. proof: a new case `sync_creates_counted` in `renderer_caches_test.cpp`, registered in `NativeEngine.cmake`, `ctest -R '^native_engine_renderer_pipeline_'`. — Result (2026-11-10): green, with one number corrected by the run. The draw frame counts **2** synchronous pipeline creates, not 1: a draw is recorded in more than one pass and needs a pipeline per pass, so the count is a property of the frame's pass list rather than a constant. The case therefore asserts the invariant that matters — non-zero on the first draw frame and exactly zero added on the next — and `program builds` was 1 as written. The `compileAsync`-first arm counts 0 creates on its draw frame, as written. Red first: with the `pipelineSyncCreates` line removed from `PipelineCache::get`, `CHECK(lazy.first.creates >= 1)` fails; restored, `PASS sync_creates_counted`. `ctest -R '^native_engine_renderer_pipeline_'`: 9 of 9 passed, exit 0 (7 before, plus this case and `compile_reaches_off_screen`).
  Step 4 also landed: `compile_reaches_off_screen` was in `TN_TEST_MAIN` but no ctest entry named it; registered in the `foreach` list it **passes**, so nothing needed leaving out.
  Build note for the next executor: the count cannot be read from `build/tn-linux`. The native-engine test tree is configured only under `-DTN_ENGINE_ONLY=ON` (`CMakeLists.txt:787-790`), so the command in EXECUTION-ORDER.md against `build/tn-linux` finds no such target. Use `cmake -S . -B build/tn-engine-only -G Ninja -DCMAKE_BUILD_TYPE=Release -DTN_ENGINE_ONLY=ON -DMYSTRAL_USE_DAWN=ON` and `--target tn-native-engine-renderer-caches-test` in that directory.

**Sizing gate (measure lane, before Phase 2):** on the forest turn with `?tnDebug=1`, record `pipelineSyncCreates`, `programBuilds` and `pipelineCreateMicros` for each frame of the turn, and the per-frame growth of `programKeyBuilds` on a still camera. Write the numbers under `## Decisions`. If the turn shows 0 synchronous creates and 0 program builds, the spike has another cause: set this PRD to `DEFERRED` and stop.

#### Phase 2: A culled mesh is prepared inside a per-frame budget
**Status:** NOT STARTED
**Files:** `renderer/render_database.h`, `renderer/render_database.cpp`, `renderer/renderer.h`, `renderer/renderer_frame.cpp`, `packages/runtime-native/tests/native-engine/renderer_caches_test.cpp`, `packages/runtime-native/cmake/NativeEngine.cmake`.
**Implementation:**
1. Write the two tests of this phase first and see them fail.
2. In `renderer/render_database.h` add `constexpr uint32_t kPrepareMeshesPerFrame = 4;` with a comment that the value is proposed, and a named override `void setPrepareBudget(uint32_t meshesPerFrame)` where 0 turns the pass off. The override is reported in `renderInfo` when it is not the default.
3. In `RenderDatabase::project` (`render_database.cpp:893`), at the place where a culled mesh is skipped (`:935-939`): when the first frame has been presented, no `compileAsync` is running, `pipelinesCompiling()` is 0 and the frame's budget is not spent, let a culled mesh that has no record through, and mark its draw compile-only. Count it against the budget.
4. In the plan, `compilation` is one argument for the whole call, and its branch is `if (compilation) { … getAsync … continue; }` (`renderer_frame.cpp:855-859`). Give `DrawItem` a `compileOnly` flag and make that branch run for `compilation || item.compileOnly`. For a compile-only item in a normal frame: the program builds, the pipeline goes to `PipelineCache::getAsync`, and the item is not pushed to `plan`, so no draw call is recorded. Reuse that branch. Do not write a second plan path. Every later pass that walks the items (shadow, velocity, aux) must skip a compile-only item: find them with `rg -n "mainPass" renderer/renderer_frame.cpp`.
   Unverified (2026-11-10): what `getAsync` needs from its returned ticket when no `compileAsync` call holds it. Read `renderer/pipeline_cache.cpp:312-340` first. If a dropped ticket cancels the compile, stop and report.
5. A mesh that enters the view before it was prepared builds on the spot, as today. Do not skip its draw.
- [ ] A scene holds one mesh in view and one behind the camera, each with its own material. After 10 frames the camera turns 180 degrees. The turn frame counts 0 synchronous pipeline creates and 0 program builds. The same test with `setPrepareBudget(0)` counts 1 of each, which is the red state before the change. proof: a new case `turn_finds_prepared_draw` in `renderer_caches_test.cpp`, `ctest -R '^native_engine_renderer_pipeline_'`.
- [ ] A scene with 64 culled meshes of 64 materials prepares at most `kPrepareMeshesPerFrame` records in any one frame, and prepares none before the first presented frame. A scene with every mesh in view prepares none at all. proof: a new case `prepare_budget_bounds_work` in the same file.
- [ ] A frame drawn after the prepare pass has finished is pixel-equal to the same frame with `setPrepareBudget(0)`. proof: a new case that compares the two readbacks in `renderer_caches_test.cpp`, or the nearest existing pixel-golden test extended with the override.

#### Phase 3: Prove it on the forest
**Status:** NOT STARTED
**Files:** `renderer/render_database.h` (the budget value only), this PRD.
**Implementation:** The executor runs the label and parity. The measure lane runs the turn and sets the budget.
- [ ] The whole `native-engine` label is green on the host build. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -L native-engine --output-on-failure`.
- [ ] `kPrepareMeshesPerFrame` is set from the forest: the largest value whose prepare frames stay under 1 ms of added CPU at p95. The value and the readings are in the constant's comment. proof: the turn rows recorded under `## Decisions`.

## Decisions

- 2026-11-10 (Claude, from a read of develop at `d6b1630b8`): the engine prepares on first knowledge, not at `add()`. The program key needs the frame's light layout, fog, sample count and pass list, and none of them exist when a mesh is added.
- 2026-11-10 (Claude): the per-draw `selectiveLights` string (`renderer_frame.cpp:627-646`) is not a box. It returns an empty string at once for a draw with no `lightsNode`, so its cost is unproven. The sizing gate reads `programKeyBuilds` on a still camera, and a box is added only if that number grows each frame.
