# PRD-523 — The render graph owns passes and history (N14a)

**Status:** PROPOSED
**Priority:** P2 — Wave 5, which CP1 gates: the render graph owns passes and history; 7 open boxes.
**Complexity:** 4 — new native subsystem every advanced pass plugs into; history rules are subtle
**Owner:** João
**Work package:** N14 — [native-engine batch](../README.md)
**Depends on:** [PRD-514 (N09)](../PRD-514-n09-native-renderer-and-standard-materials.md); starts only after [PRD-534 (CP1)](../PRD-534-cp1-the-native-engine-earns-the-port.md) passes

## Context

§10 makes the native render graph the owner of pass dependencies, render targets, compute ordering,
transient resources and history invalidation. Today that mechanism is TypeScript: the render chain in
`packages/core/src/render/chain.ts` orders passes over upstream `RenderPipeline`, and motion vectors
for temporal passes come from `packages/core/src/render/velocity.ts` and
`packages/core/src/render/batched-velocity.ts`. The shader packages from N08b already declare their
pass dependencies and temporal-history requirements (§9.2); nothing native consumes them yet.

## Solution

1. Proposed `packages/runtime-native/src/engine/renderer/graph/`: passes declare reads, writes,
   compute dispatches and history inputs; the graph topologically orders them per render invocation,
   allocates transient targets from a pool keyed by descriptor, and aliases non-overlapping lifetimes.
2. History is a first-class resource with a generation. Camera cut, resize, new object, skeleton
   reuse and LOD transition each invalidate or seed the affected history explicitly (§10); a pass
   that reads an invalid history gets a defined reset input, never stale data from another view.
3. Multiple render calls inside one tick get distinct render ids (§12); history advances per
   presented view, not per call.
4. Cycles, missing producers and format mismatches fail at graph build with named diagnostics.
5. Rollback: the legacy backend keeps `chain.ts`; nothing in it is removed by this PRD.

## Out of scope

- Specific effects: VSM ([PRD-524](PRD-524-n14b-virtual-shadows-run-native.md)), probes
  ([PRD-525](PRD-525-n14c-probes-run-native.md)), post and chains
  ([PRD-526](PRD-526-n14d-post-effects-and-render-chains-run-native.md)).
- Shader package generation (N08b).

## Execution Phases

#### Phase 1: Ordering and transient resources
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/renderer/graph/`, `packages/runtime-native/tests/native-engine/render_graph_*.cpp`
- [ ] Passes declared out of order execute in dependency order, compute before its consumer draw. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_render_graph_order`
- [ ] Transient targets with disjoint lifetimes share one allocation; overlapping ones never do. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_render_graph_aliasing`
- [ ] A cycle or a read with no producer fails graph build with a named diagnostic. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_render_graph_diagnostics`

#### Phase 2: History invalidation
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/renderer/graph/history.cpp`
- [ ] Camera cut and resize each reset the affected history to the defined seed. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_history_cut_resize`
- [ ] A new object, a reused skeleton and an LOD transition each seed previous-frame data instead of reading another object's history. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_history_objects`
- [ ] Two render calls in one tick get distinct render ids and history advances once per presented view. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_history_multi_render`

#### Phase 3: On a GPU
**Status:** NOT STARTED
**Files:** `packages/runtime-native/conformance/registry.json`
- [ ] A temporal fixture through a camera cut shows no ghosting frame after the cut on the native renderer. proof: `pnpm parity` (new case `native-engine-history-cut`)

## Decisions

- The graph is derived per render invocation from native state; it never polls a JavaScript chain (§6.2, §10).
