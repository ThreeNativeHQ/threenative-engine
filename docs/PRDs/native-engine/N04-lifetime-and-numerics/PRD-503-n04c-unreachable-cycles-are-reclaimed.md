# PRD-503 — Unreachable cycles are reclaimed (N04c)

**Status:** PROPOSED
**Priority:** P2 — Wave 2: the tracing reachability layer over the engine schema; 7 open boxes.
**Complexity:** 5 — a tracing reachability layer over the engine schema, with safe points and deferred GPU destruction
**Owner:** João
**Work package:** N04 — [lifetime and numerics](README.md), [native-engine batch](../README.md)
**Depends on:** [PRD-502](PRD-502-n04b-handles-keep-identity-and-aliases.md)

## Context

§7.1 separates three things: `scene.remove(mesh)` detaches and does not destroy; disposing a GPU resource is not destroying its public object; shared materials and geometry stay shared. Strong reference counting on both parent and child edges leaks cycles, so the graph needs a reachability layer. Its roots are active scenes, native owners, language wrappers and pending callbacks; its edges are parent/child and the other observable links. Unreachable cycles are reclaimed at defined safe points, and GPU destruction waits until the device has finished using the resource. Adapters must take part in the protocol: rooting every callback forever is not acceptable (§7.1). The work is benchmarked, not claimed GC-free.

## Solution

1. **Schema-driven tracer** (proposed: `packages/runtime-native/src/engine/foundation/reachability.{h,cpp}`). Each engine type declares its observable edges from the catalog annotations. A mark phase from the roots runs at safe points (between frames, or on explicit `collect()` in tests) under a work budget.
2. **Root API** in the ABI: `tn_root_acquire` and `tn_root_release` for wrappers and callbacks. A weak-wrapper hook lets an adapter report wrapper reachability, so cross-language cycles can be collected (consumed by [PRD-506](../N05-native-typescript-qualification/PRD-506-n05b-three-imports-bind-natively-and-callbacks-are-reclaimed.md) and [PRD-531](../PRD-531-n18-v8-game-runtime-adapter.md)).
3. **Deferred GPU destruction**: a reclaimed object's GPU resources go to a per-device-generation queue that is drained only after the submission that last used them completes. `dispose()` releases GPU resources and leaves the public object alive.
4. **Accounting**: live-object counts per type, reclaimed counts and pause time per safe point, published through telemetry.

## Out of scope

- Buffer views and leases: [PRD-504](PRD-504-n04d-buffers-cross-the-abi-with-an-owner.md).
- Device-loss rebuild of destroyed resources: [PRD-509](../PRD-509-n07-gpu-resources-presentation-and-device-loss.md).

## Execution Phases

#### Phase 1: Detach, dispose and destroy are distinct
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/foundation/reachability.{h,cpp}`, `packages/runtime-native/tests/native-engine/lifetime_test.cpp`
- [ ] A removed mesh still held by a root survives a collection; once unrooted it is reclaimed at the next safe point. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_lifetime_detach`
- [ ] Disposing a shared material leaves every mesh using it alive and keeps it shared. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_lifetime_shared`

#### Phase 2: Cycles and callbacks
**Status:** NOT STARTED
**Files:** same, plus proposed `packages/runtime-native/src/engine/abi/roots.cpp`
- [ ] A parent/child cycle and a userData cycle with no root are both reclaimed. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_lifetime_cycles`
- [ ] A callback whose captured wrapper is the only path back to its owner is reclaimed once the adapter reports the wrapper unreachable. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_lifetime_callback_cycle`

#### Phase 3: GPU destruction is deferred and budgeted
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/foundation/deferred_destroy.cpp`
- [ ] A reclaimed buffer is not released before the submission that used it completes, and is released after. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_lifetime_deferred_gpu`
- [ ] 1,000 create/attach/detach/unroot cycles of a 10,000-object scene end with zero leaked objects under ASan, and per-safe-point pause time is reported. proof: `pnpm --filter @threenative/runtime-native native:test:asan -- -R native_engine_lifetime_soak`
- [ ] Reclamation and deferred destruction run to completion on one thread with no worker, the Wasm single-thread fallback (owner decision 4). proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_reclaim_single_thread`
