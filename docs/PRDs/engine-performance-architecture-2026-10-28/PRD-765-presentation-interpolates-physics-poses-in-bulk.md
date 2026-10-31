# PRD-765 — Presentation interpolates physics poses in bulk

**Status:** NOT STARTED
**Priority:** P2 — reduce repeated presentation pose copies for large interpolated populations.
**Complexity:** 9 (HIGH)
**Owner:** Engine implementation agent
**Depends on:** PRD-763
**Progress:** 0%

## Context

Source: proposal 5 in [the investigation](../../../plans/engine-performance-architecture-2026-10-28.md).
Engine layer: `packages/core/src/interpolation.ts:30` allocates pose history per tracked object;
`:68–79` captures ticks; `:94–125` snapshots participants, saves/writes draw poses and restores
solved poses. Engine math already uses memory views; scalar-access counts are not ABI timings.

Complexity: 9 → HIGH; 11+ likely implementation files (+3), bulk presentation mechanism (+2),
observable draw/simulation state (+2), browser/native boundary (+2); risk override: none.
Effort: 7–15 engineer-days. PRD-763 is an indispensable prerequisite for its reusable pose stream;
762 is independent and not a gating dependency.

## Solution

Keep the existing `PhysicsInterpolation` owner and tracking/reset API. Extend 763's qualified
transform records with previous/current presentation state; pass alpha once to an owned-engine
bulk path. Keep solved poses authoritative for simulation and queries. Keep the current portable
implementation for `engine: "threejs"` and unsupported participants until equivalent.

Render callbacks currently see interpolated Object3D values. Preserve that observable contract
through the existing binding/memory-view design; matrices alone do not satisfy it. If preserving
it eliminates the measured gain, decline this optimization rather than silently changing callback
semantics. Preserve hierarchy/local transforms, quaternion interpolation, external edits/teleport
resets, alpha=0/1, disabled interpolation, duplicate references, scene changes/untracking during
draw and restoration after a thrown draw. A failed draw must leave simulation state correct.
Retire the old per-body write/restore loop on the qualified owned-engine path; do not keep it
running underneath the bulk path. Apply [the batch execution contract](README.md#execution-contract).

## Validation scene — Mixed-rate motion hall

**Proposed fixture:** extend the existing native-smoke physics fixture with rows of moving
crates on rotating parent platforms and add
`examples/native-smoke/playtests/perf-presentation-interpolation.playtest.json` plus a desktop
variant. Use real tracked physics bodies, the fixed game loop, scene render callbacks and the
owned renderer. Baseline must already include qualified PRD-763, so only bulk interpolation
differs between arms. Render the same objects/materials/camera and hold simulation at 60 Hz.

| Variant | Population and action | Purpose |
| --- | --- | --- |
| Benefit | 10,000 tracked participants; 120 Hz presentation over 60 Hz simulation | Expose repeated draw-pose work; repeat at 1,000 |
| Mixed rates | Same motion at 30 and 60 Hz presentation; include fully sleeping population | Verify phase/history behavior and bound non-benefit work |
| Disabled/small | Existing named interpolation override disabled; separately 100 participants at 60 Hz | Charge registration/transport overhead where interpolation saves little |
| Lifecycle | Same motion with teleport, parent movement, untracking and scene changes | Include resets and ownership churn without corrupting solved state |

A fixed replay translates and rotates participants; render callbacks sample their local/world
poses while fixed-step queries sample solved poses. At known ticks teleport a subset, change a
parent, unregister during draw, throw once from draw, recover and switch scenes. Compare actual
observations against the incumbent interpolation path, including alpha=0/1. Run exception/oracle
checks outside steady-state windows; measure lifecycle spikes separately. Use a 120 Hz capable
target or the existing runner's explicit presentation stepping; record achieved cadence. A
60 Hz run cannot claim the 120 Hz variant. If explicit stepping replaces wall-clock presentation,
claim frame-work savings only and keep real-time motion qualification separate.

**Net gain:** meet [the scene gate](README.md#validation-scenes-and-net-gain-gate) on complete
CPU frame work in the benefit variant, including 763 transport, native history updates, callback
visibility and rendering; report GPU frame time to expose work shifted to shaders. Disabled,
small and mixed-rate controls must pass overhead limits. Require NEUTRAL or IMPROVEMENT on
matched motion sequences; fewer JS pose writes cannot excuse a slower frame or changed motion.

## Acceptance Criteria

- [ ] AC-1 [local]: Draw callbacks observe the incumbent interpolated pose while simulation/query state is restored on return or throw, including hierarchy and lifecycle changes. proof: `pnpm exec vitest run packages/core/__tests__/loop-interpolation.spec.ts packages/physics/__tests__/interpolation.spec.ts` extended through the real frame loop. Evidence: pending.
- [ ] AC-2 [local]: For 1,000/10,000 tracked participants, the owned path removes at least half the per-render JS pose writes/copies and improves interpolation CPU beyond paired-run noise without hidden fallback work. proof: instrumented loop tests and real frame-loop profiling, with actual crossings recorded separately. Evidence: pending.
- [ ] AC-3 [local]: Linux native draws the same interpolated motion and exposes the same callback poses as browser reference at 30/60/120 Hz presentation over fixed 60 Hz simulation. proof: extend the existing native-smoke physics-desktop playtest and owned-engine interpolation conformance, with the fresh visual verdict required by Phase 3. Evidence: pending.

- [ ] AC-4 [local]: Mixed-rate motion hall demonstrates a net whole-frame CPU gain on the achieved 120 Hz benefit variant while other rates, disabled interpolation and lifecycle controls pass the scene gate. proof: proposed `perf-presentation-interpolation` playtests, three matched timing pairs per variant, observed cadence/pose checks, resource checks and a fresh motion visual verdict; report browser/native separately. Evidence: pending.

## Blocked on

- PRD-763's qualified changed-pose ownership/transport contract must land before Phase 2; unblocked by the implementing agent completing [PRD-763](PRD-763-physics-publishes-only-changed-poses.md). Phase 1 remains doable.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Draw interpolation | Fixed loop → `interpolation.ts:68/75/82` → render callbacks and owned renderer | Bulk owned path; legacy Three.js implementation retained | AC-1, AC-2 |
| Pose transport | Qualified 763 changed stream → previous/current presentation buffers → one alpha | Reuse physics transport; preserve authoritative simulation state | AC-3 |

## Execution Phases

### Phase 1: Lock observable interpolation semantics

**Status:** NOT STARTED
**Files:** Existing loop/physics interpolation specs and native-smoke physics fixtures.
**Implementation:** Pin solved/draw pose observations, throws, parent mutations and scene switches;
size copying and crossings on moving and sleeping populations before designing bindings.
- [ ] Real loop tests expose callback/restoration contracts and baseline copy/CPU cost for AC-1/2. proof: focused interpolation specs and matched fixed-loop profiling at 1,000/10,000 participants. Evidence: pending.

### Phase 2: Route the owned renderer through bulk presentation state

**Status:** NOT STARTED
**Files:** Core `interpolation.ts` and existing loop wiring, 763 physics record seams,
owned-engine presentation/matrix owner and browser/native bindings identified before editing.
**Implementation:** Preserve callbacks via current bindings; reject invalid alpha and malformed
records; synchronize lifetime/reset handling across transport and draw ownership.
- [ ] Browser owned-engine draw consumes bulk history while preserving solved/draw semantics. proof: AC-1 loop tests and AC-2 count cases, red→green. Evidence: pending.
- [ ] Native presentation implements equivalent callback visibility and exception-safe restoration. proof: focused native contracts through the actual frame loop and AC-3 desktop scenario. Evidence: pending.

### Phase 3: Qualify motion and cost on both owned-engine targets

**Status:** NOT STARTED
**Files:** Existing physics/interpolation scenarios, including teleport and mid-draw scene changes.
- [ ] Mixed-rate motion hall proves AC-2 and AC-4 while preserving callback and solved-pose behavior. proof: proposed interpolation playtests at achieved 30/60/120 Hz, matched timing/control runs and NEUTRAL or IMPROVEMENT motion verdicts on browser and Linux desktop. Evidence: pending.
