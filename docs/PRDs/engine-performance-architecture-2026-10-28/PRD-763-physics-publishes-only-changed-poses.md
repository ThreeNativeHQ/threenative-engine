# PRD-763 — Physics publishes only changed poses to registered visuals

**Status:** NOT STARTED
**Priority:** P1 — reduce full-world publication and role scans in mostly sleeping worlds.
**Complexity:** 8 (HIGH)
**Owner:** Engine implementation agent
**Depends on:** None
**Progress:** 0%

## Context

Source: proposal 2 in [the investigation](../../../plans/engine-performance-architecture-2026-10-28.md).
Engine layer: `packages/physics/src/plugin.ts:212` and `:219` scan all registered bodies for
kinematics and characters; `:244` requests a full snapshot and `:255` dispatches every row.
`simulation.ts:1467` still visits all bodies despite cached backend pose reads. Native physics
`src/lib.rs:1996` exports all entries. Reducing crossings alone cannot remove full payload work.

Complexity: 8 → HIGH; 6–10 implementation files (+2), changed-stream contract (+2), lifecycle
state (+2), JS/Rust boundary (+2); risk override: none. Effort: 4–7 engineer-days.

## Solution

Index kinematic and character roles at add/remove/restart, inside the existing plugin owner.
Add an internal reusable changed-pose stream to the existing simulation boundary and route the
plugin through it. Preserve `readVisibleTransforms()` as a complete snapshot for diagnostics
and direct clients. Capacity checks and malformed-record validation stay fail-closed.

Define publication and acknowledgement so retries, small buffers and multiple readers cannot
lose changes. Include initial registration, teleport, wake, final sleep pose, external writes,
reparenting and an edited sleeping visual that still needs physics-authoritative correction.
Do not equate unchanged backend pose with an unchanged visual. Bodies outside the visual registry
continue simulating; raw and direct backend clients keep their current contracts. Reuse resting
pose caching. A backend scan may remain; measure scanned bodies separately from published rows.
The new seam is the prerequisite for 765, not a second physics framework.
Apply [the batch execution contract](README.md#execution-contract).

## Validation scene — Sleeping warehouse

**Proposed fixture:** extend `examples/native-smoke/src/physics.ts` with a warehouse of fixed
shelves, sleeping dynamic crates, kinematic carts and characters. Add
`examples/native-smoke/playtests/perf-pose-publication.playtest.json` with a desktop variant.
Use real plugin registration/step/application and visible Object3D transforms, not a direct
serializer benchmark. Freeze camera, cheap geometry/materials, 60 Hz physics and 60 Hz render
cadence; use the same resident/visible population in both arms. Browser and Linux desktop are
separate measured targets.

| Variant | Population and action | Purpose |
| --- | --- | --- |
| Benefit | 10,000 residents; 1% change poses each tick; repeat at 1,000 | Prove publication savings survive total frame work |
| Fully resting | Same residents after initial publication; no moving poses | Expose residual dirty detection/scan cost |
| Fully active | Same residents, 100% moving; include a 10% intermediate case | Bound delta bookkeeping overhead at high change rates |
| Small/churn | 100 bodies; register, teleport, reparent and remove a fixed subset every 60 ticks | Expose index lifecycle and discontinuity overhead |

The replay moves carts/characters, wakes 20 crates, teleports 10, edits 10 sleeping visuals and
returns them to physics authority, then removes/re-adds bodies. Assert actual visible poses
against the full-snapshot oracle after each transition; read a complete diagnostic snapshot
outside the timing window to prove compatibility. Run a forced small-buffer/retry case outside
steady-state timing and verify no lost pose. Offscreen residents retain the same simulation
activity in both arms. Compare role visits, backend scans, reads, rows/bytes and sync CPU without
claiming that the entire backend became proportional to changes.

**Net gain:** meet [the scene gate](README.md#validation-scenes-and-net-gain-gate) on the 1%
variant using whole-frame CPU, including backend detection, transport, authoritative visual
correction, interpolation and rendering. Fully active and small/churn variants are overhead
controls. Match final poses and require the batch visual judge; fewer published bytes alone
cannot pass. Report browser and Linux desktop gains independently.

## Acceptance Criteria

- [ ] AC-1 [local]: Registered visuals receive every authoritative transition without stale sleeping edits, lost resize retries or lifecycle leaks; full snapshot callers still receive all valid bodies. proof: `pnpm exec vitest run packages/physics/__tests__/transform-sync-cost.spec.ts packages/physics/__tests__/crossings.spec.ts packages/physics/__tests__/plugin-buffer.spec.ts packages/physics/__tests__/interpolation.spec.ts` with transition cases. Evidence: pending.
- [ ] AC-2 [local]: After initial publication, 10,000 residents with 1% pose changes publish at most the changed rows plus explicitly counted discontinuities, removing at least 90% of full-snapshot publication bytes. proof: extended `transform-sync-cost.spec.ts` and Phase 3 profiling; backend scans reported separately. Evidence: pending.
- [ ] AC-3 [local]: Linux native changed-stream transitions preserve the full-snapshot and plugin contract. proof: extend `packages/physics/__tests__/native-contract.spec.ts`, native parity cases and `pnpm --filter @threenative/runtime-native native:physics:parity`. Evidence: pending.

- [ ] AC-4 [local]: Sleeping warehouse demonstrates a net whole-frame CPU gain for 1% changing residents while resting, fully active and small/churn controls pass the scene gate. proof: proposed `perf-pose-publication` playtests on browser and Linux desktop, with three matched timing pairs per variant, pose-oracle checks, resource checks and a visual verdict. Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Role selection | `plugin.ts:157` registration → `:212` step input | Replace two full role scans with lifecycle indices | Phase 1 |
| Changed publication | `plugin.ts:244` read → `:255` node apply | Plugin uses delta stream; public full snapshot retained | AC-1–3 |

## Execution Phases

### Phase 1: Index body roles through their lifetime

**Status:** NOT STARTED
**Files:** `packages/physics/src/plugin.ts`; existing plugin/transform-sync tests.
**Implementation:** Maintain roles through add/remove, disposal and restart; preserve area inputs.
- [ ] Kinematic/character input selection visits the indexed roles and produces the incumbent records across lifecycle transitions. proof: `pnpm exec vitest run packages/physics/__tests__/plugin.spec.ts packages/physics/__tests__/transform-sync-cost.spec.ts packages/physics/__tests__/scene-restart-determinism.spec.ts` with role-visit assertions. Evidence: pending.

### Phase 2: Publish changed poses through the existing bulk boundary

**Status:** NOT STARTED
**Files:** Physics `simulation.ts`, `plugin.ts`, native seam adapters and Rust `src/lib.rs`;
existing buffer/native-contract/parity tests. Final adapter paths must be resolved before editing.
**Implementation:** Version the internal record contract coherently across both backends; do not
silently change full snapshots. Preserve synchronization and interpolation reset semantics.
- [ ] Web plugin consumes changed rows without losing transitions or authoritative visual correction. proof: AC-1 focused tests, red→green for delta delivery and retry cases. Evidence: pending.
- [ ] Native publication implements the same changed-stream ownership and validation. proof: AC-3 native contract and parity runs. Evidence: pending.

### Phase 3: Qualify synchronization and sleeping-world scaling

**Status:** NOT STARTED
**Files:** Existing native-smoke physics fixtures/scenarios; extend the existing cost observations.
**Implementation:** Exercise 0%, 1%, 10%, 100% moving residents at 1,000 and 10,000 bodies,
including teleports, wake/sleep, visual edits and disposal; preserve render work.
- [ ] Sleeping warehouse proves AC-2 and AC-4 while preserving pose transitions and appearance. proof: proposed `perf-pose-publication` playtests through the existing CLI on browser and Linux desktop, matched scene timings and NEUTRAL or IMPROVEMENT visual judging. Evidence: pending.
