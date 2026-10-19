# PRD-520 — Bounded streaming admission and IO events (N13a)

**Status:** PROPOSED
**Priority:** P2 — Wave 5, which CP1 gates: bounded streaming admission and IO events; 5 open boxes.
**Complexity:** 3 — an engine event queue plus a frame-budgeted admission scheduler, both with existing TS references
**Owner:** João
**Work package:** N13 — [native-engine batch](../README.md) · [N13 umbrella](README.md)
**Depends on:** [PRD-515 (N10)](../PRD-515-n10-native-gltf-cooked-assets-and-decoders.md); starts only after [PRD-534 (CP1)](../PRD-534-cp1-the-native-engine-earns-the-port.md) passes

## Context

§11.1 asks for native IO completions to enter an engine event queue and reach the game thread at specified boundaries. §12's frame admits bounded streaming work before building the render snapshot. §12 also requires cancellation without freeing in-use resources, and no completion callback after its world is destroyed. Today: `packages/core/src/streaming.ts` (`loadAll`, `addInSlices`, `DEFAULT_CONCURRENCY = 6`) and the per-frame admission allowance in `packages/core/src/world-tiles.ts`. Frame attribution comes from `packages/core/src/frame-budget.ts`. Specs: `packages/core/__tests__/streaming.spec.ts`, `world-cells-admission.spec.ts`.

## Solution

1. **Engine event queue.** Proposed `packages/runtime-native/src/engine/world/events/`. IO, decode and GPU-upload completions are posted from worker threads. They are drained on the game thread at the frame boundary §12 defines, in posting order per source. The core has no Promise. The language adapter maps completions to its async form (§11.1).
2. **Admission scheduler.** Proposed `packages/runtime-native/src/engine/world/admission/`. Each frame gets a millisecond and byte allowance. Each unit of admission work (decode, upload, instantiate) is charged against it. Work that would overrun waits for the next frame. Concurrency defaults to today's `DEFAULT_CONCURRENCY`. The allowance is measured and reported through frame-budget telemetry (auto by default, with a named override).
3. **Cancellation and teardown.** A cancelled request releases its lease only after any GPU use completes (§7.1). Destroying a world drops its pending completions, and no callback runs afterwards (§12).
4. **Failure.** A failed load produces an error with code, subsystem, resource identity and recovery class (§12). It is never a silent hole.

## Out of scope

- Cell and tile residency policy: [PRD-521 (N13b)](PRD-521-n13b-worldcells-and-worldtiles-run-native.md)
- The end-to-end world fixture: [PRD-522 (N13c)](PRD-522-n13c-a-world-loads-walks-and-unloads-without-growth.md)

## Execution Phases

#### Phase 1: The event queue
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/world/events/`, `packages/runtime-native/tests/native-engine/world/`
- [ ] Completions posted from worker threads are delivered on the game thread at the frame boundary, in per-source order. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_event_queue` (also under TSan)
- [ ] After a world is destroyed, none of its pending completion callbacks run. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_event_queue_teardown`

#### Phase 2: Budgeted admission and cancellation
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/world/admission/`
- [ ] Admission work per frame stays within the allowance, and overflow is deferred, matching `world-cells-admission.spec.ts` fixtures. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_admission_budget`
- [ ] Cancelling an in-flight load frees nothing the GPU still uses, as ASan and the lease audit both show. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_admission_cancel`
- [ ] A failed load reports a stable code, the resource identity and a recovery class. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_admission_failure`
