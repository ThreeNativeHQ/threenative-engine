# PRD-524 — Virtual shadows run native (N14b)

**Status:** PROPOSED
**Priority:** P2 — Wave 5, which CP1 gates: virtual shadows run native; 5 open boxes.
**Complexity:** 4 — port of a paged shadow system with GPU feedback
**Owner:** João
**Work package:** N14 — [native-engine batch](../README.md)
**Depends on:** [PRD-523 (N14a)](PRD-523-n14a-the-render-graph-owns-passes-and-history.md), [PRD-519 (N12)](../PRD-519-n12-native-batching-visibility-lod-gpu-scene.md)

## Context

§11.3 names virtual shadows among the systems that cannot stay a hidden TypeScript implementation in
a native-engine build. Today they live in `packages/core/src/render/virtual-shadow.ts` and
`packages/core/src/render/virtual-shadow-pages.ts`. Ordinary shadows are N09's; this is the paged
virtual shadow map path, which depends on native visibility (N12) to decide which casters render into
which pages.

## Solution

1. Port page allocation, page-request feedback, caching and invalidation into proposed
   `packages/runtime-native/src/engine/renderer/shadows/virtual/`, with the page table and physical
   atlas registered as render-graph resources (N14a).
2. Caster selection per page uses N12 visibility records; moving casters and TSL vertex deformation
   (N08c) invalidate the pages they touch.
3. The public configuration surface stays the one the TS system exposes today; any field the native
   port does not support is a named unsupported diagnostic, never silently ignored.
4. Rollback: the legacy backend keeps the TS implementation.

## Out of scope

- Ordinary shadow maps (N09). Probes ([PRD-525](PRD-525-n14c-probes-run-native.md)).

## Execution Phases

#### Phase 1: Page logic without a GPU
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/renderer/shadows/virtual/`, `packages/runtime-native/tests/native-engine/vsm_*.cpp`
- [ ] Page requests from a recorded feedback buffer allocate the same page set as the TS reference. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_vsm_pages` against fixtures from `pnpm exec vitest run packages/core/__tests__/virtual-shadow*.spec.ts`
- [ ] A moving caster invalidates only the pages its bounds cover. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_vsm_invalidation`

#### Phase 2: Rendered parity
**Status:** NOT STARTED
**Files:** `packages/runtime-native/conformance/registry.json`
- [ ] A VSM fixture scene renders shadows within tolerance of the legacy backend's output. proof: `pnpm parity` (new case `native-engine-vsm`)
- [ ] A deformed caster casts its deformed shadow into virtual pages. proof: `pnpm parity` (new case `native-engine-vsm-deformation`)
- [ ] A camera cut reseeds the page cache with no stale-page frame. proof: `pnpm parity` (new case `native-engine-vsm-cut`)

## Blocked on

- Shadow-cost comparison on physical Android hardware: needs the owner's attached device (§15.3).
