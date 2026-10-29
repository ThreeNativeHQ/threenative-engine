# PRD-762 — Only actuated bodies clear forces after a fixed step

**Status:** NOT STARTED
**Priority:** P1 — remove unnecessary force-reset work without changing one-step force semantics.
**Complexity:** 5 (MEDIUM)
**Owner:** Engine implementation agent
**Depends on:** None
**Progress:** 0%

## Context

Source: proposal 1 in [the investigation](../../../plans/engine-performance-architecture-2026-10-28.md).
Engine layer: `packages/physics/src/simulation.ts:1332` owns portable force writers; `:1457`
resets forces and torques on every dynamic body after a solve. Native
`packages/runtime-native/native/physics/src/lib.rs:1204` visits every entry. The investigation
counted 3,000 force resets and 3,000 torque resets for 1,000 unforced sleeping dynamics over
three web ticks; this is historical operation evidence, not a candidate speedup.

Complexity: 5 → MEDIUM; 1–5 implementation files (+1), state/lifetime (+2), JS/Rust boundary
(+2); risk override: none. Estimated effort: 1–2 engineer-days, plus required platform runs.

## Solution

Retain one deduplicated actuated-body collection in each simulation. Mark successful force and
force-at-point writers, including forces applied by buoyancy/vehicles where applicable; reset
both force and induced torque once after that body's solve. Remove destroyed bodies and clear
state on world disposal/restart. Preserve finite-vector/dynamic-body validation and the existing
one-fixed-step force behavior. Failed input must not corrupt the tracking collection.

Audit raw-world/raw-body escape hatches before selecting the collection mechanism. Raw forces
must retain incumbent one-step clearing: intercept their reachable writers or retain an explicit,
conservative compatibility path for exposed raw worlds. A portable-only list is insufficient.
Keep impulses separate from persistent forces. Reuse current counters, counting actual force
and torque calls separately where necessary. Apply [the batch execution contract](README.md#execution-contract).

## Validation scene — Debris actuation yard

**Proposed fixture:** extend `examples/native-smoke/src/physics.ts` with a selectable debris
yard; add `examples/native-smoke/playtests/perf-actuation.playtest.json` and a desktop variant
through the same harness. These are planned additions. Use the real `rapier()` plugin and
RigidBody3D force methods, deterministic non-overlapping cube positions, a fixed overhead camera,
cheap unchanged materials, zero gravity for the sparse-force isolation window and 60 Hz physics.
Run on browser WebGPU and Linux native separately; browser is the primary crossing-cost subject.

| Variant | Population and action | Purpose |
| --- | --- | --- |
| Benefit | 10,000 dynamic bodies, 100 distinct force recipients each tick; repeat at 1,000 | Prove sparse actuation saves total frame CPU |
| Sleeping | 10,000 explicitly sleeping dynamics, no forces | Prove the no-force path does no reset work |
| Saturated | Same population, every body receives force and off-center torque | Expose collection/dedup overhead when nothing can be skipped |
| Compatibility | 100 bodies, mixed portable/raw writers, repeated writes to the same IDs | Include the raw compatibility path in the cost and correctness result |

Replay sparse forces for 120 ticks, stop all forcing for 120, then apply off-center forces for
120; include a collision/gravity segment after isolation. Check observed pose/angular velocity
against the baseline: force stops accumulating on the next solve, sleeping bodies stay asleep
until actuated, and both torque and force reset once. Exercise removal of a marked recipient
before solve and disposal/recreation between timing windows. Do not add artificial waits inside
the solve or change render population between arms.

**Net gain:** meet [the scene gate](README.md#validation-scenes-and-net-gain-gate) on the benefit
variant using whole-frame CPU work, including tracking, raw compatibility and all physics/render
work. Report solver CPU, reset calls, frame work/presentation p50/p95 and allocation/memory as
separate rows. Saturated and compatibility variants must pass the overhead controls; fewer
Wasm calls with unchanged or slower whole-frame CPU is not acceptance.

## Acceptance Criteria

- [ ] AC-1 [local]: Portable and raw force/force-at-point callers retain one-step force and torque behavior, including removal before solve. proof: `pnpm exec vitest run packages/physics/__tests__/actuation.spec.ts packages/physics/__tests__/crossings.spec.ts packages/physics/__tests__/buoyancy.spec.ts packages/physics/__tests__/vehicle-body.spec.ts` with new cases. Evidence: pending.
- [ ] AC-2 [local]: At 10,000 dynamics with 100 distinct portable force recipients, the optimized path makes exactly 100 force resets and 100 torque resets per tick; zero recipients make zero resets. proof: extended `crossings.spec.ts` and Phase 3 paired profiling against the full-reset control. Evidence: pending.
- [ ] AC-3 [local]: Linux native force behavior matches the web contract through the existing physics seam. proof: `cargo test --manifest-path packages/runtime-native/native/physics/Cargo.toml --test actuation` and `pnpm --filter @threenative/runtime-native native:physics:parity`. Evidence: pending.

- [ ] AC-4 [local]: Debris actuation yard demonstrates a net whole-frame CPU gain on the browser benefit workload while its sleeping, saturated and raw-access controls meet the scene gate. proof: proposed `perf-actuation` playtests, three matched baseline/candidate timing pairs per variant, AC-1/3 correctness and the scene's resource checks; report desktop independently. Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| One-step actuation | `simulation.ts:1332` force writers → `plugin.ts:235` solve → web/native resets | Replace unconditional reset loop; preserve raw compatibility | AC-1, AC-3 |
| Work proportional to actuation | Real `rapier()` plugin ticks in debris playtest → reset counters and CPU | Reuse existing engine counters | AC-2, Phase 3 |

## Execution Phases

### Phase 1: Size force clearing and preserve actuation semantics

**Status:** NOT STARTED
**Files:** `packages/physics/__tests__/{crossings,actuation}.spec.ts`; native `tests/actuation.rs`.
**Implementation:** Extend actual plugin/backend tests for zero/sparse/full actuation, repeated
force writes, off-center torque, sleeping bodies, disposal and raw access. Pin the control.
- [ ] Reproduce unconditional reset counts and record CPU sizing for sleeping and active debris before optimizing. proof: extended `crossings.spec.ts` plus existing engine-cost profiling on the controlled debris workload. Evidence: pending.

### Phase 2: Clear only actuated bodies on both backends

**Status:** NOT STARTED
**Files:** `packages/physics/src/simulation.ts`; native physics `src/lib.rs` and focused tests.
**Implementation:** Keep tracking in the existing simulation owner and cover every force writer.
- [ ] Web tracking skips unforced resets while preserving raw access and validation. proof: AC-1 focused Vitest command, red→green for the new count/behavior cases. Evidence: pending.
- [ ] Native tracking preserves actuation and removes unnecessary resets inside Rust. proof: AC-3 commands with sparse/full/removed-recipient cases. Evidence: pending.

### Phase 3: Qualify debris workloads through the plugin

**Status:** NOT STARTED
**Files:** Extend `examples/native-smoke/playtests/physics.playtest.json` and its physics fixture
with sleeping/active debris and sparse off-center forces; keep desktop coverage in the existing
physics-desktop scenario. Reuse existing counters; add no benchmark service.
- [ ] Debris actuation yard proves AC-2 and AC-4 through the real plugin without changing force behavior. proof: proposed `perf-actuation` scenarios through the existing CLI, browser and desktop separately, with the validation scene's matched timing and resource checks. Evidence: pending.
