# PRD-767 — Native sensors reuse collider indices and membership storage

**Status:** NOT STARTED
**Priority:** P2 — remove repeated native sensor indexing and allocation while preserving overlap events.
**Complexity:** 5 (MEDIUM)
**Owner:** Engine implementation agent
**Depends on:** None
**Progress:** 0%

## Context

Source: sensor follow-up in [the investigation](../../../plans/engine-performance-architecture-2026-10-28.md).
Engine layer: `packages/runtime-native/native/physics/src/lib.rs:1336` rebuilds a collider→body
HashMap and allocates a pair Vec in `area_intersections()`; `:2090` exposes the bulk read.
The plugin already retains membership buffers and dispatches events. The source investigation
did not measure sensor CPU or a candidate optimization.

Complexity: 5 → MEDIUM; 1–5 implementation files (+1), collider/event lifecycle state (+2),
native physics boundary (+2); risk override: none. Effort: 2–4 engineer-days.

## Solution

Retain collider→body membership at body creation/removal and reuse area-intersection scratch
storage in the existing Simulation owner. Reuse that map for collision transitions where it is
the same mapping, rather than maintaining a second index. Preserve caller buffer validation,
capacity retry behavior and current begin/end event semantics. Clear/reset all retained state on
world disposal and restart; collider handle reuse must not inherit stale body IDs.

Keep overlap evaluation intact in this slice. New/moved sensors, sleeping occupants, body
teleports, mask changes and removal still refresh membership correctly. Defer change-epoch
skipping until separately measured; removing map rebuilds and per-read pair allocation is the
bounded outcome. Web remains the semantic oracle, with native CPU savings reported separately.
Apply [the batch execution contract](README.md#execution-contract).

## Validation scene — Trigger warehouse

**Proposed fixture:** extend `examples/native-smoke/src/physics.ts` with a scripted conveyor
warehouse and add `examples/native-smoke/playtests/perf-sensor-membership.playtest.json` plus
a desktop variant. Use actual Area3D nodes, physics bodies, native plugin reads and enter/exit
callbacks. Fixed overhead camera and cheap crate visuals stay identical between arms. Linux
native is the performance subject; browser runs the same replay as a semantic oracle only.

| Variant | Population and action | Purpose |
| --- | --- | --- |
| Benefit | 10,000 residents, 100 sensors, fixed sparse overlap count; repeat at 1,000/10 | Prove retained indices/storage reduce complete native frame work |
| Dense | Same residents/sensors, sensors covering many crates | Expose pair-storage growth and callback/membership cost |
| No sensor | 10,000 bodies, zero sensors | Charge retained collider-index overhead even when unused |
| Small/churn | 100 bodies and 10 sensors; remove/recreate bodies and sensors every 60 ticks | Expose mutation, filter and handle-reuse costs |

Script conveyor motion through known sensors, stop crates until asleep, move sensors over the
sleepers, change masks, teleport crates and remove/re-add a body. Assert sorted observed
memberships and ordered enter/exit transitions against expected scripted state and the web
oracle, including no duplicate events. Compare dense overlap as its own variant with fixed
expected membership; do not change overlaps between baseline/candidate to reduce work. Pre-grow
capacity identically, then test a separate growth event. Run ten full warehouse dispose/recreate
cycles to expose stale handles and retained allocations.

**Net gain:** meet [the scene gate](README.md#validation-scenes-and-net-gain-gate) using complete
native CPU frame work on the sparse benefit variant, including map mutation, overlap queries,
pair copying, JS event dispatch and rendering. Report refresh CPU, map rebuilds, allocations,
pair capacities, retained memory and frame/presentation p50/p95. Dense, zero-sensor and small/churn
variants must pass overhead limits. Zero steady allocations alone cannot establish a speedup.

## Acceptance Criteria

- [ ] AC-1 [local]: Area3D begin/end membership matches the existing contract after sensor movement, sleeping-body overlap, filter edits, removal and reused handles. proof: `pnpm exec vitest run packages/physics/__tests__/area.spec.ts packages/physics/__tests__/native-contract.spec.ts packages/physics/__tests__/plugin-buffer.spec.ts` with lifecycle/resize cases. Evidence: pending.
- [ ] AC-2 [local]: Once capacity is established, steady native membership reads rebuild no collider map and allocate no new pair storage for an unchanged bounded overlap population. proof: extended Rust area tests with allocation/capacity assertions, plus three matched sensor-refresh CPU pairs at Phase 3's populations. Evidence: pending.
- [ ] AC-3 [local]: Linux native Area3D enter/exit events and IDs match the web backend through the real plugin. proof: extended native area parity fixture, `cargo test --manifest-path packages/runtime-native/native/physics/Cargo.toml --lib` and `pnpm --filter @threenative/runtime-native native:physics:parity`. Evidence: pending.

- [ ] AC-4 [local]: Trigger warehouse demonstrates a net whole-frame native CPU gain for sparse membership while dense, zero-sensor and small/churn controls pass the scene gate. proof: proposed `perf-sensor-membership` desktop playtests, three matched timing pairs per variant, observed Area3D transitions and lifecycle/resource checks; web supplies the semantic oracle. Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Sensor membership | Native `lib.rs:2090` bulk read → `:1336` overlaps → plugin membership events | Replace transient map/pair allocation; retain actual overlap evaluation | AC-1–3 |
| Collider identity | Existing native body add/remove → retained collider index | One lifetime-owned map; clear on disposal | AC-1, AC-2 |

## Execution Phases

### Phase 1: Reproduce membership behavior and size allocations

**Status:** NOT STARTED
**Files:** Existing physics area/native-contract tests; native `src/lib.rs` test module and
`tests/parity.rs`. Use real Simulation reads rather than a mocked map helper.
- [ ] Native membership tests establish current allocation/CPU cost and cover sleeping occupants, moved/new sensors and mask edits before reuse. proof: focused area Vitest tests, Rust area tests and baseline sensor-refresh profiling. Evidence: pending.

### Phase 2: Retain collider indices and reusable pair storage

**Status:** NOT STARTED
**Files:** Native physics `src/lib.rs` and its existing tests; seam adapter only if borrowing or
capacity handling requires a corresponding change.
**Implementation:** Make storage simulation-owned without losing pairs across failed reads;
retain the current validated FFI output contract.
- [ ] Collider registration/removal keeps the retained index correct through restart and handle reuse. proof: new Rust lifecycle cases and existing collision-event tests in `cargo test --manifest-path packages/runtime-native/native/physics/Cargo.toml --lib`. Evidence: pending.
- [ ] Area reads reuse capacity while preserving membership, validation and retry behavior. proof: AC-1/2 cases, red→green for allocation and buffer retry assertions. Evidence: pending.

### Phase 3: Qualify native membership through Area3D

**Status:** NOT STARTED
**Files:** Extend existing native-smoke physics fixtures/scenarios with many triggers and
explicit enter/exit observations; reuse the physics desktop runner.
**Implementation:** Measure 1,000/10,000 bodies against 10/100 sensors, both sparse and dense
overlap; hold overlap counts stable for allocation assertions and include a growth transition.
- [ ] Trigger warehouse proves AC-2 and AC-4 with correct Area3D transitions and bounded retained storage. proof: proposed sensor-membership desktop playtest, AC-3 parity and matched whole-frame/control timings; browser supplies the semantic control. Evidence: pending.
