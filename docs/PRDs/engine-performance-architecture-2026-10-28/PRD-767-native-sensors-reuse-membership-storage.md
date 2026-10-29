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

## Acceptance Criteria

- [ ] AC-1 [local]: Area3D begin/end membership matches the existing contract after sensor movement, sleeping-body overlap, filter edits, removal and reused handles. proof: `pnpm exec vitest run packages/physics/__tests__/area.spec.ts packages/physics/__tests__/native-contract.spec.ts packages/physics/__tests__/plugin-buffer.spec.ts` with lifecycle/resize cases. Evidence: pending.
- [ ] AC-2 [local]: Once capacity is established, steady native membership reads rebuild no collider map and allocate no new pair storage for an unchanged bounded overlap population. proof: extended Rust area tests with allocation/capacity assertions, plus three matched sensor-refresh CPU pairs at Phase 3's populations. Evidence: pending.
- [ ] AC-3 [local]: Linux native Area3D enter/exit events and IDs match the web backend through the real plugin. proof: extended native area parity fixture, `cargo test --manifest-path packages/runtime-native/native/physics/Cargo.toml --lib` and `pnpm --filter @threenative/runtime-native native:physics:parity`. Evidence: pending.

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
- [ ] The Area3D playtest emits correct transitions and meets AC-2 plus the batch native-CPU/frame-p95 adoption bar. proof: AC-3 parity command, desktop physics playtest and three matched sensor-refresh timing pairs; web provides the semantic control. Evidence: pending.
