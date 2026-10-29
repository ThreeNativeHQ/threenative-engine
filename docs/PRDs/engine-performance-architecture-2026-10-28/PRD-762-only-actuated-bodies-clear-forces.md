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

## Acceptance Criteria

- [ ] AC-1 [local]: Portable and raw force/force-at-point callers retain one-step force and torque behavior, including removal before solve. proof: `pnpm exec vitest run packages/physics/__tests__/actuation.spec.ts packages/physics/__tests__/crossings.spec.ts packages/physics/__tests__/buoyancy.spec.ts packages/physics/__tests__/vehicle-body.spec.ts` with new cases. Evidence: pending.
- [ ] AC-2 [local]: At 10,000 dynamics with 100 distinct portable force recipients, the optimized path makes exactly 100 force resets and 100 torque resets per tick; zero recipients make zero resets. proof: extended `crossings.spec.ts` and Phase 3 paired profiling against the full-reset control. Evidence: pending.
- [ ] AC-3 [local]: Linux native force behavior matches the web contract through the existing physics seam. proof: `cargo test --manifest-path packages/runtime-native/native/physics/Cargo.toml --test actuation` and `pnpm --filter @threenative/runtime-native native:physics:parity`. Evidence: pending.

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
- [ ] The debris playtest preserves motion while matched 1,000/10,000-body runs meet AC-2 and the batch CPU/frame-p95 adoption bar. proof: existing playtest CLI on the physics scenarios, browser and desktop separately, plus three profiling pairs per workload. Evidence: pending.
