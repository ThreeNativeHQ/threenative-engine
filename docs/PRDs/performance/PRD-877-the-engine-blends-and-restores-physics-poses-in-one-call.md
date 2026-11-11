# PRD-877 — The engine blends and restores physics poses in one call

**Status:** PARTIAL — Phase 1 landed (the meter only, no behaviour change). Phase 2 waits on the measure lane's sizing gate.
**Priority:** P1 — pose history, blend and restore run in JavaScript for every tracked body on every tick and every render, which PRD-828 names as the largest JavaScript block left on the stress-lab frame (Phases 1-3 open).
**Complexity:** 6 (MEDIUM) — 6-10 implementation files (2), state that must survive a throw and an untrack during a draw (+2), one build boundary: the engine bindings serve web Wasm and native V8 (+2). Risk override: none.
**Owner:** João
**Depends on:** None. It is the first slice of [PRD-765](../engine-performance-architecture-2026-10-28/PRD-765-presentation-interpolates-physics-poses-in-bulk.md) and needs no PRD-763.

Executor: read [EXECUTION-ORDER.md](./EXECUTION-ORDER.md) first. Its rules and commands apply to every box here.

## Context

`PhysicsInterpolation` (`packages/core/src/interpolation.ts:34`) keeps, for each tracked `Object3D`, a previous pose, a
current pose and a saved pose as JavaScript `Vector3` and `Quaternion` objects. The camera is tracked too
(`packages/core/src/game-startup.ts:208`). Per tracked object it does:

| When | Code | Work per object |
| --- | --- | --- |
| Each fixed tick, before physics | `beginTick` (`interpolation.ts:87-92`) | 7 reads from the object, 7 writes to `previous` |
| Each fixed tick, after physics | `endTick` (`:94-99`) | 7 reads, 7 writes to `current` |
| Each render, before the draw | `render` (`:101-131`) | an `equals` check against `current`, a save (7 reads), `lerpVectors` (3 writes), `slerpQuaternions` (4 writes plus a JavaScript Euler sync of 3 writes) |
| Each render, after the draw | the `finally` block (`:132-146`) | an `equals` check, 7 writes and `recompose` when the pose changed |

On the owned engine these reads and writes are direct `HEAPF64` accesses through accessors, not engine calls. So the
bridge census does not show this cost. The debug counter `sharedTransformWrites`
(`packages/three-native/src/browser-backend.ts:392-410`) does.

How large it is, honestly: PRD-828 gives two readings that it does not reconcile. Its profile row P7 reads 0.48 ms a
frame (3.3%), and its follow-up 7 says "about 1.2 ms a frame", for 300 bodies. Phase 1 measures it before any engine code.

The contracts that must hold (each has a case in `packages/core/__tests__/loop-interpolation.spec.ts`, 7 cases):

1. A render callback reads the blended pose from the object's own `position` and `quaternion`.
2. After `render` returns or throws, the object holds the solved pose again.
3. A pose that changed outside the fixed update is a discontinuity: that object resets and does not blend (`:118-123`).
4. `alpha === 1`, a disabled interpolation and a paused game draw the solved pose and touch nothing (`:113`).
5. Tracking is reference-counted (`:47-72`), and an object untracked during the draw is still restored.
6. A teleport calls `reset` (`packages/physics/src/RigidBody3D.ts:162`, `CharacterBody3D.ts:382`, `VehicleBody3D.ts:212`).

The engine already writes a pose correctly from C++ in `PhysicsSync::writeTransforms`
(`packages/runtime-native/src/engine/world/physics_sync.cpp:112-115`): `prepareLocalTransformWrite()`, `position.set`,
`quaternion.set` (which keeps the Euler in step), `markLocalTransformDirty()`.

The engine already exposes engine-internal methods that take a list of objects and work on both hosts through the
registry: `__bandRigs` and `__tnGuardWatch` (`packages/runtime-native/src/engine/abi/bindings_scene.cpp:426-470`). Core
detects one with `typeof candidate?.__bandRigs === "function"` (`packages/core/src/render-camera-cull.ts:251`). A native
V8 case calls one at `packages/runtime-native/tests/native-engine/v8_adapter_test.cpp:1299`. This PRD copies that pattern.
It adds no new ABI export.

## Solution

A C++ `PoseHistory` holds the three poses for a list of objects. JavaScript keeps the reference counts and decides when
to call. Five engine-internal methods on one owner `Object3D` that `PhysicsInterpolation` creates and never adds to a scene:

| Method | When JavaScript calls it | What C++ does |
| --- | --- | --- |
| `__tnPoseWatch(objects)` → number | Before the next tick or blend, only when the tracked set changed | Replaces the list. An object that was already watched keeps its three poses. A new object gets previous = current = its pose now. Returns how many objects it accepted. |
| `__tnPoseReset(objects)` | `reset(object)` and a teleport | Sets previous = current = the pose now, for those objects. |
| `__tnPoseTick(phase)` | `beginTick` with phase 0, `endTick` with phase 1 | Phase 0 copies each pose to previous. Phase 1 copies each pose to current. |
| `__tnPoseBlend(alpha)` | `render`, before the draw | For each object: when the pose differs from current, reset that object. Save the pose. Write the lerp and the slerp with the four calls of `physics_sync.cpp:112-115`. Remember this list for the restore. |
| `__tnPoseRestore()` | `render`, in `finally` | For each object of the last blend that still exists: when the pose differs from the saved pose, write the saved pose and mark the transform dirty. |

Rules:

- Objects are held as `std::weak_ptr`. An expired object is skipped, never dereferenced.
- `__tnPoseWatch` is never called between a blend and its restore. JavaScript sets a dirty flag in `track` and in the
  untrack closure, and applies it at the start of the next `beginTick`, `endTick` or `render`.
- JavaScript uses the engine path only when the owner has `__tnPoseWatch` and it returned `objects.length`. In every
  other case (the `engine: "threejs"` override, an object the engine does not back) it keeps today's JavaScript path,
  unchanged. `TN_PHYSICS_INTERPOLATION` gains a field `path: "engine" | "js"`, so the choice is reported.
- The blend uses the engine's own `Vector3::lerpVectors` and `Quaternion::slerpQuaternions`. Values must match the
  JavaScript path within 1e-12.

## Validation scene

- **Consumer and scene:** the stress lab's 300 dynamic bodies, `~/projects/threenative/sandbox/stress-lab`, `main.html?stress`.
- **Benefit workload:** `?stress`, RTX 2080, 1280x720, uncapped.
- **Small control:** a scene with only the camera tracked. One object must cost no more than the JavaScript path: the spec
  asserts at most 4 method calls a frame and no `__tnPoseWatch` call on a frame with no membership change.
- **Worst case:** every body teleports every frame, so every object resets. The engine path must still restore solved poses.
- **Motion:** `packages/create-threenative/templates/kart/playtests/smooth-drive.playtest.json` and
  `examples/native-smoke/playtests/physics.playtest.json` must pass unchanged.
- **Pass:** AC-1 below.

## Acceptance Criteria

- [ ] AC-1 [local, measure lane]: On the stress lab, uncapped pass of one fair window, `head` against `develop`: the summed `interpolation*` debug time falls by at least half, `sharedTransformWrites` from interpolation falls to 0 a frame, CPU frame p50 is lower in both ABBA pairs, frame p95 is no more than 5% worse, and a fresh visual judge reads NEUTRAL or IMPROVEMENT on two recordings per arm of the falling bodies. proof: `pnpm stress:loop fair` ledger rows, `TN_FRAME_BUDGET.counters.engine`, the judge verdict — Evidence: pending.

## Blocked on

- Nothing outside the repository. AC-1 needs a calm host and the measure lane (see EXECUTION-ORDER.md, "Who runs what").

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Engine pose history | Fixed loop → `PhysicsInterpolation.beginTick`/`endTick` (`packages/core/src/loop.ts:430-434,587-590`) and `interpolation.render` (`packages/core/src/game-frame-loop.ts:520`) → `__tnPose*` methods (`abi/bindings_scene.cpp`) | The JavaScript loops stay only for the `engine: "threejs"` override and for an object the engine does not back | AC-1, Phase 3 |

## Execution Phases

#### Phase 1: Measure the cost and pin the contracts
**Status:** DONE
**Files:** `packages/core/src/interpolation.ts`, `packages/core/__tests__/loop-interpolation.spec.ts`.
**Implementation:**
1. In `interpolation.ts`, import `measureDebug` from `./profiling/debug-telemetry.js`. Use it exactly as `packages/core/src/game-frame-loop.ts:882` does. Wrap the body of `beginTick` and of `endTick` (names `interpolationTick`), the blend loop before `draw()` (name `interpolationBlend`) and the restore loop in `finally` (name `interpolationRestore`). Do not wrap `draw()` itself.
2. Change no behaviour in this phase.
- [x] With debug telemetry on, one tick and one render of 100 tracked objects report the three `interpolation*` entries, and with it off they report none. The 7 existing cases still pass. proof: a new case in `packages/core/__tests__/loop-interpolation.spec.ts`, `pnpm exec vitest run packages/core/__tests__/loop-interpolation.spec.ts packages/core/__tests__/debug-telemetry.spec.ts` — Result (2026-11-10): the new case `reports the three regions for one tick and one render of 100 objects, and none with telemetry off` failed first (`AssertionError: expected undefined to be 2`) and passes after; `pnpm exec vitest run` over both files: 2 files, 39 tests passed, exit 0. The 7 pre-existing cases are 14 tests (one `it.each` of 4) and all still pass. Regions are `interpolationTick` (entered twice: `beginTick` then `endTick`), `interpolationBlend` and `interpolationRestore`; `draw()` itself is not wrapped. `pnpm typecheck` exit 0, `pnpm lint` exit 0.

**Sizing gate (measure lane, before Phase 2):** on `?stress&tnDebug=1`, read the p50 of the three entries summed, and `sharedTransformWrites`. Record them under `## Decisions`. Below 0.3 ms a frame, set this PRD to `DEFERRED` with the number and stop. The 0.3 ms floor is a proposal (2026-11-10), not a measurement.

#### Phase 2: The pose history in C++
**Status:** built and proven, one step blocked on drift that predates this PRD (see below).
**Files:** new `packages/runtime-native/src/engine/scene/pose_history.h` and `pose_history.cpp` (add the `.cpp` to the engine source list in `packages/runtime-native/cmake/NativeEngineCore.cmake`, beside `animation/tick_batch.cpp` near line 125), `packages/runtime-native/src/engine/abi/bindings_scene.cpp`, new `packages/runtime-native/tests/native-engine/scene/pose_history_test.cpp` (an existing case `native_engine_skinned_pose_history` is a different thing, the bone palette history; register the new one as `native_engine_physics_pose_history` the way `native_engine_animation_tick_batch` is registered near line 945), `packages/runtime-native/native-registry.json` (regenerated, not hand-edited).
**Implementation:**
1. Run `engine_search_capabilities` for "interpolation" and "pose" first (AGENTS.md rule 1). If the engine already has a pose history, stop and report.
2. Write `pose_history_test.cpp` first, with the cases of the two boxes below. See it fail to link.
3. `PoseHistory`: a `std::vector<std::weak_ptr<Object3D>>`, three `std::vector<double>` of 7 values per object (previous, current, saved), and the list of the last blend. Methods `watch`, `reset`, `tick(phase)`, `blend(alpha)`, `restore()` as in the Solution table. `blend` rejects an alpha that is not finite or is outside 0 to 1 by throwing, as the JavaScript does.
4. In `bindings_scene.cpp`, add the five `b.methods["__tnPose…"]` entries beside `__tnGuardWatch` (`:453`). Keep one `PoseHistory` per owner object with the same side-table pattern that `sourceGuardOf` uses. Read object lists with `refsOf` and `objectArg`, as `__bandRigs` does (`:428-433`).
5. Regenerate the registry: build `tn-native-engine-registry-dump` and run it with `--check native-registry.json` (`NativeEngineCore.cmake:911-919` shows the exact invocation). Commit the regenerated file.
**Step 5 is blocked, and not by this change.** `tn-native-engine-registry-dump --out` rewrites
`packages/three-native/api/native-registry.json` with 375 insertions and **9,471 deletions**, and it
does that on the bindings **as they stand at HEAD too** — regenerating with my five `__tnPose*`
methods stashed produced the identical 9,846-line diff. So the committed snapshot is stale
repo-wide and `native_engine_registry_snapshot` is red before this PRD touches it. Committing a
9,471-line deletion to "fix" it would delete entries nothing in this worktree can account for, so
the file is left untouched and the drift is reported instead of papered over. The five methods are
bound and build (`tn_engine_abi` exits 0); they are simply not in the snapshot yet.

- [x] For 3 objects over 2 ticks: after `blend(0.25)` each object holds the lerp and slerp of its two poses within 1e-12, its Euler matches its quaternion, and its local transform is marked dirty. After `restore()` each holds its solved pose bit-equal. A pose changed between the tick and the blend makes that one object reset and not blend. proof: `ctest -R native_engine_physics_pose_history` — **100% passed**. The case compares against poses snapshotted before the blend, not against the live objects `blend` overwrites; that mistake in the first draft made the test measure the result against itself. Writing it caught a real bug: the reset path kept a stale `latest`, so the next tick blended from a pose the body had already left (expected 109.5, got 61). `latest` now rebases on where the body actually is.
- [x] `watch` with one object added keeps the history of the two that stay. An object destroyed between `blend` and `restore` is skipped with no crash. `blend(1.5)` and `blend(NaN)` throw. The case runs clean under `TN_ENGINE_SANITIZE`. proof: `ctest -R native_engine_physics_pose_history` in the normal and the sanitizer build — **100% passed in both**, no ASan or UBSan report. The full `native-engine` label is **293/293** in `build/native-engine`, up from 292 with this case added.

#### Phase 3: Core uses it, on both hosts
**Status:** IN PROGRESS. The core engine path and the V8 host case are done and proven; the
both-paths run of the seven cases and the two playtests are open.
**Files:** `packages/core/src/interpolation.ts`, `packages/core/__tests__/loop-interpolation.spec.ts`, `packages/runtime-native/tests/native-engine/v8_adapter_test.cpp`.
**Implementation:**
1. `PhysicsInterpolation` creates one owner `Object3D` lazily. It picks the engine path as the Solution rules say, and reports `path` in `TN_PHYSICS_INTERPOLATION`.
2. On the engine path, `beginTick`, `endTick`, `render` and `reset` each make one method call, plus `__tnPoseWatch` only when the dirty flag is set. The reference counts, the `enabled` and `alpha === 1` early return, and the `try`/`finally` shape stay in JavaScript.
3. Keep the JavaScript loops as the other path. Do not delete them.
- [ ] The 7 existing cases of `loop-interpolation.spec.ts` pass on both paths: once as today, and once with a fake owner that implements the five methods over plain arrays and records each call. On the fake-owner run, a frame with no membership change makes exactly 4 calls (tick 0, tick 1, blend, restore) and 0 writes to any tracked object's `position` or `quaternion` from JavaScript. Write this run first and see it fail. proof: `pnpm exec vitest run packages/core/__tests__/loop-interpolation.spec.ts packages/physics/__tests__/interpolation.spec.ts`.
  **Partly done, not ticked.** The seven cases still pass (20/20 across this spec and
  `packages/physics/__tests__/interpolation.spec.ts`), and a new `fakePoseOwner` run proves the two
  numbers the box asks for: a frame with no membership change makes exactly
  `[tick:0, tick:1, blend, restore]` — no watch — and a spy owner that writes nothing proves no
  JavaScript touched a tracked transform, because the body would have moved if it had. The report
  carries `"path":"engine"` and the engine and JavaScript paths reach the same pose. What is **not**
  done is running all seven existing cases a *second* time through the fake owner: the run added is
  three cases beside them, not a parameterized second pass. Several of the seven assert JavaScript-
  only behaviour (the recompose hook, untouched matrix caches), so that pass needs the fake to
  emulate the C++ writes rather than spy on them. Until that exists this box stays open.
- [x] The native V8 host calls the same five methods and gets the same poses. proof: a new case `pose_history` in `v8_adapter_test.cpp`, written like the `__bandRigs` checks (`:1299`) and added to the `foreach(case …)` list in `packages/runtime-native/cmake/NativeEngineAdapters.cmake:73`, then `ctest -R native_engine_v8_pose_history` on the host build (target `tn-native-engine-v8-test`). — **100% passed**, 16 checks inside the case. The configure that defines the target is the documented `-DTN_ENGINE_ONLY=ON -DTN_ENGINE_PLAYER=ON -DMYSTRAL_USE_V8=ON -DMYSTRAL_USE_QUICKJS=OFF`; `MYSTRAL_USE_V8=ON` alone defines no target. The case compares the blended position and quaternion against three's own `lerpVectors` and `slerpQuaternions` computed in the host, checks the restore is exact, checks a `__tnPoseReset` teleport does not blend across the gap, and checks `blend(1.5)` and `blend(NaN)` throw into JavaScript. It first failed on `ok:33` against the engine's `ok:16` — my assertion count was wrong, not the engine.
- [ ] `examples/native-smoke/playtests/physics.playtest.json` and `packages/create-threenative/templates/kart/playtests/smooth-drive.playtest.json` pass on a page built from the head, and the page logs `TN_PHYSICS_INTERPOLATION` with `"path":"engine"`. proof: the playtest command in EXECUTION-ORDER.md.

## Decisions

- 2026-11-10 (**solo read, not the fair-window protocol**): the sizing gate clears, so Phase 2 is a go. On the stress lab at `main.html?stress&tnDebug=1`, 1280x720, over one 113-sample window, `TN_FRAME_BUDGET.counters.engine` p50 per frame was `interpolationTickMs` 0.22, `interpolationBlendMs` 0.42 and `interpolationRestoreMs` 0.41 — **1.05 ms a frame summed**, against the gate's 0.3 ms floor, so this PRD is not `DEFERRED`. `sharedTransformWrites` p50 was **11,189** writes a frame. `interpolationTickCalls` p50 6 and the blend/restore calls p50 1 confirm the meters fire on the real frame rather than reading zero in silence.
  How this reading was taken, stated plainly because it is weaker than the runbook's: a single window, not an ABBA pair, and the load was not gated before the window (the 1-minute load read 5.84 just after it, under the runbook's 12, but it was not asserted at the start). It is a one-sided test — the reading is 3.5x the floor, so a noisy host cannot move it across — but it is not a fair window and must not be quoted as one. The lane installed `core` and `runtime-native` from this branch's head (both verified in the installed tree before the run: `interpolationTick` present in `core/dist`, `animationTickMicros`/`pipelineSyncCreates` present in both `.wasm` files).
  Two things this run also proved about the harness, which cost most of the time: `pnpm --filter <pkg> build` before `pnpm pack` ships a **stale** package — it clobbered the deliberate `pnpm wasm:build` output and a fresh `core` dist, so the lab silently ran an engine without these counters until the packs were made without that step. Anyone repeating this must verify the *installed* tree, not the worktree.
  The same run read the other two gates for free: `pipelineSyncCreates` p50 0 and `programBuilds` p50 0 in the settled window (they fire during load instead — the page logged `TN_PROGRAM_LATE` for several programs, which is PRD-876's subject), and the animation tick measures 1.25 ms p50 by `animationTickMs`.

- 2026-11-10 (Claude, from a read of develop at `d6b1630b8`): engine-internal registry methods, not a new `tn_*` ABI export. The `tn_anim_tick` export still has no native V8 executor (PRD-828, Decisions of 2026-11-07), and a registry method works on both hosts with one binding.
- 2026-11-10 (Claude): the history lives on an owner object that core creates, not on the scene. A scene can change during a draw, and the restore must still reach the objects of the blend.
- 2026-11-10 (Claude): the physics plugin's own `applyTransform` loop (`packages/physics/src/plugin.ts:288`) is out of scope. PRD-763 and PRD-765 own it.
