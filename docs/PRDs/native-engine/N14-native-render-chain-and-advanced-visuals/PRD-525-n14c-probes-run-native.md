# PRD-525 — Probes run native (N14c)

**Status:** PROPOSED
**Priority:** P2 — Wave 5, which CP1 gates: probes run native; 5 open boxes.
**Complexity:** 3 — one TS system to port onto the render graph
**Owner:** João
**Work package:** N14 — [native-engine batch](../README.md)
**Depends on:** [PRD-523 (N14a)](PRD-523-n14a-the-render-graph-owns-passes-and-history.md)

## Context

§11.3 lists probe systems among the framework systems that must execute natively in a native-engine build.
The current implementation is `packages/core/src/render/probe-volume.ts`. Probe capture and update are
render-graph passes with history (an accumulated irradiance volume), so they wait on N14a.

## Solution

1. Port probe placement, capture scheduling, update budget and sampling data layout into proposed
   `packages/runtime-native/src/engine/renderer/probes/`; the volume is a render-graph history
   resource.
2. Static-scene probes can be baked at build time into the cooked package (N10) and loaded without
   recapture; dynamic updates obey a per-frame budget.
3. Probe sampling in materials stays a TSL node compiled through N08; the look remains game-authored.
4. Rollback: the legacy backend keeps `probe-volume.ts`.

## Out of scope

- Environment-map filtering for standard PBR (N08c / N09).

## Execution Phases

#### Phase 1: Placement and scheduling
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/renderer/probes/`, `packages/runtime-native/tests/native-engine/probes_*.cpp`
- [ ] Probe placement and update order match the TS reference for the same volume description. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_probe_schedule`
- [ ] Updates never exceed the configured per-frame budget. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_probe_budget`

#### Phase 2: Rendered parity and cooking
**Status:** NOT STARTED
**Files:** `packages/runtime-native/conformance/registry.json`
- [ ] A probe-lit fixture matches the legacy backend within tolerance after convergence. proof: `pnpm parity` (new case `native-engine-probes`)
- [ ] A baked probe volume loads from a cooked package and renders without recapture. proof: `pnpm parity` (new case `native-engine-probes-baked`)
- [ ] Moving a light invalidates and reconverges the affected probes with no stale frame. proof: `pnpm parity` (new case `native-engine-probes-relight`)
