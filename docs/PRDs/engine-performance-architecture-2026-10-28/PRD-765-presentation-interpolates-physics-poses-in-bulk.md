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

## Acceptance Criteria

- [ ] AC-1 [local]: Draw callbacks observe the incumbent interpolated pose while simulation/query state is restored on return or throw, including hierarchy and lifecycle changes. proof: `pnpm exec vitest run packages/core/__tests__/loop-interpolation.spec.ts packages/physics/__tests__/interpolation.spec.ts` extended through the real frame loop. Evidence: pending.
- [ ] AC-2 [local]: For 1,000/10,000 tracked participants, the owned path removes at least half the per-render JS pose writes/copies and improves interpolation CPU beyond paired-run noise without hidden fallback work. proof: instrumented loop tests and real frame-loop profiling, with actual crossings recorded separately. Evidence: pending.
- [ ] AC-3 [local]: Linux native draws the same interpolated motion and exposes the same callback poses as browser reference at 30/60/120 Hz presentation over fixed 60 Hz simulation. proof: extend the existing native-smoke physics-desktop playtest and owned-engine interpolation conformance, with the fresh visual verdict required by Phase 3. Evidence: pending.

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
- [ ] Mixed-rate motion meets AC-2's CPU/copy bar and the batch frame-p95 bar with NEUTRAL or IMPROVEMENT visual verdicts. proof: browser and Linux desktop physics playtests at 30/60/120 Hz, three matched performance pairs and two headed visual runs per arm. Evidence: pending.
