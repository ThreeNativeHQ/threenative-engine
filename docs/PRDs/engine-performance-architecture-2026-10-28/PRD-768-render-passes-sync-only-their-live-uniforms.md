# PRD-768 — Render passes synchronize only their live uniforms

**Status:** NOT STARTED
**Priority:** P3 — scope low-confidence uniform scanning work to the pass that consumes it.
**Complexity:** 8 (HIGH)
**Owner:** Engine implementation agent
**Depends on:** None
**Progress:** 0%

## Context

Source: uniform follow-up in [the investigation](../../../plans/engine-performance-architecture-2026-10-28.md).
Engine layer: `packages/three-native/src/tsl-uniforms.ts:223` scans global callback and object
collections on sync. `browser-entry.ts:231/238` invokes sync during render preparation. Native
`packages/runtime-native/src/engine/player/core-tsl.mjs:18` instantiates the same `liveUniforms`
implementation, so fix that shared owner rather than creating separate native callback logic.
FRAME callbacks and unchanged lane writes already deduplicate. The historical 0.08–0.15 ms
once-per-frame extraction size is small and does not establish a current per-pass bottleneck.

Complexity: 8 → HIGH; 6–10 implementation files (+2), pass/uniform ownership contract (+2),
graph/lifetime state (+2), Wasm/native boundary (+2); risk override: none.
Effort: 2–4 engineer-days. Lowest-priority slice; fresh sizing may decline it.

## Solution

Associate live uniform nodes with already prepared pass/material/compute owners. Route existing
sync entry points through the owner's reachable set, retiring global scans only where ownership
is known correct. Shared uniforms may have several owners. Unprepared/unsupported graphs keep
a correctness-first fallback whose cost is counted; no silent missed update is acceptable.

Preserve FRAME once-per-frame semantics, RENDER frequency and render-camera context, including
observable callback side effects. Do not stop callbacks merely because a node is off-pass unless
that behavior is compatible with the current contract. Prefer scoping value extraction first if
callback side effects require global dispatch. Preserve in-place Color/Vector edits, shared nodes,
graph rebuilds, render-target swaps, compute dispatch, disposal and nested reflection cameras.
Reuse weak-reference lifetime handling and unchanged-write suppression. No per-game manual
uniform-owner registration and no new shader graph format.
Apply [the batch execution contract](README.md#execution-contract).

## Validation scene — Live-uniform post gallery

**Proposed fixture:** extend the existing native-smoke game with a post gallery using the shipped
pass/material/uniform APIs; add `examples/native-smoke/playtests/perf-pass-uniforms.playtest.json`
and a desktop variant. Reuse auto-exposure/post-chain fixtures for realistic target swaps and
sailing's nested-reflection camera behavior. The gallery renders colored/moving reference panels
through ten real prepared render-target passes; do not benchmark `sync()` without drawing.
Use 1,000 live vector/color uniforms partitioned evenly across passes, fixed 640×360 output and
cheap shaders so GPU shading does not hide the CPU question. Verify the actual limiting stage.

| Variant | Population and action | Purpose |
| --- | --- | --- |
| Benefit | Ten passes; each owns a disjoint 10% of uniforms, all live values edited in place | Prove extraction savings survive complete frame CPU |
| Single pass | All 1,000 uniforms owned by one pass | Charge ownership machinery where global scanning was sufficient |
| Shared | Ten passes, every uniform shared by every pass | Expose worst-case owner lookup/dedup overhead |
| Churn/mixed | Rebuild/dispose one pass every 60 ticks; share 20% of nodes; include compute and a nested camera | Preserve lifetime, fallback and camera/dispatch semantics |

Replay in-place vector/color edits, FRAME/RENDER callbacks, ping-pong target swaps and camera
changes. Observe callback count/order/side effects and rendered/readback panel values through
the real render loop. Compare with the incumbent implementation in separate correctness runs.
Include a reachable unsupported/unprepared graph to charge the compatibility fallback. Time
pass rebuilds separately, and dispose/recreate the gallery ten times; count live owners and
retained memory to catch ownership leaks. Keep pass count, shader output and draws identical
between arms; removing output work to reduce uniform visits invalidates the comparison.

**Net gain:** meet [the scene gate](README.md#validation-scenes-and-net-gain-gate) using whole
CPU frame work on the disjoint-owner variant, including owner preparation/lookup, callbacks,
value extraction, native submission, graph maintenance and rendering. Report actual writes and
crossings separately from scans; retain GPU/presentation timings to detect shifted work. Single,
shared and churn/mixed variants must pass overhead controls. Require a fresh visual judge for
the gallery and real post-chain scenes. If savings remain below noise, defer this slice.

## Acceptance Criteria

- [ ] AC-1 [local]: Public uniform callbacks and in-place values reach the correct pass with incumbent frame/render frequency, side effects and camera context. proof: `pnpm exec vitest run packages/three-native/__tests__/tsl-uniforms.spec.ts packages/three-native/__tests__/pass-node.spec.ts` extended through render preparation. Evidence: pending.
- [ ] AC-2 [local]: In ten prepared passes with 10% disjoint uniform ownership per pass, eligible value-extraction visits fall at least 80% versus global scanning; callback work and fallback cost are reported separately. proof: extended uniform cost cases and three matched real post-chain CPU profiling pairs; batch frame-p95 bar applies. Evidence: pending.
- [ ] AC-3 [local]: Linux owned-engine post rendering preserves live uniform changes, target swaps and reflection-camera values. proof: extend `packages/runtime-native/tests/native-engine/material_uniforms_test.cpp`, run focused `native_engine_material_uniforms` CTests and the real native post-chain playtest in Phase 3. Evidence: pending.

- [ ] AC-4 [local]: Live-uniform post gallery demonstrates a net whole-frame CPU gain for disjoint ownership while single-pass, shared and churn/fallback controls pass the scene gate. proof: proposed `perf-pass-uniforms` playtests on browser and Linux desktop, three matched timing pairs per variant, real callback/readback assertions, resource checks and visual verdicts. Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Browser live values | `browser-entry.ts:231/238` render hook → `tsl-uniforms.ts:223` sync | Owner-scoped eligible extraction; retain semantic callback dispatch | AC-1, AC-2 |
| Native live values | `runtime-native/src/engine/player/core-tsl.mjs:18` shared live-uniform owner → active render/compute pass | Reuse shared sync and existing native submission | AC-3 |

## Execution Phases

### Phase 1: Size pass-local work and lock update semantics

**Status:** NOT STARTED
**Files:** Existing uniform/pass-node tests, real post-chain fixtures and current profiling.
**Implementation:** Separate callbacks, value extraction, actual writes and ABI crossings;
include shared nodes, side effects and multiple cameras before selecting eligible work.
- [ ] Real multi-pass sizing establishes removable work and compatibility tests for the exact callback contract. proof: AC-1 focused tests and baseline post-chain timings; record a decline under Decisions if work is below measurement noise. Evidence: pending.

### Phase 2: Route synchronization through live pass owners

**Status:** NOT STARTED
**Files:** `packages/three-native/src/tsl-uniforms.ts`, existing browser render/TSL preparation,
`packages/runtime-native/src/engine/player/core-tsl.mjs` and focused tests. C++ uniform name-hash
tests are regression coverage; they do not replace execution through this shared JS sync path.
**Implementation:** Derive ownership automatically at preparation, invalidate on graph changes,
and remove disposed owners. Keep validation and visible fallback accounting.
- [ ] Prepared browser passes scope eligible extraction without changing callback semantics or dropping in-place edits. proof: AC-1/2 uniform and pass-node cases, red→green for visit counts and graph edits. Evidence: pending.
- [ ] Native consumers preserve values and owner lifetime under render-target/compute changes. proof: AC-3 focused native tests plus real post-chain dispatch. Evidence: pending.

### Phase 3: Qualify post chains and uniform lifetime

**Status:** NOT STARTED
**Files:** Extend existing post-chain/auto-exposure conformance scenes and playtest scenarios;
reuse sailing for nested reflection-camera coverage rather than inventing another renderer demo.
- [ ] Live-uniform post gallery proves AC-2 and AC-4, with real post chains preserving in-place edits, target swaps and nested-camera appearance. proof: proposed gallery/post-chain playtests, matched whole-frame/control measurements and NEUTRAL or IMPROVEMENT visual verdicts on browser and Linux desktop. Evidence: pending.
