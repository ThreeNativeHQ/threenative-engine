# PRD-502 — Handles keep identity and aliases (N04b)

**Status:** PROPOSED
**Priority:** P2 — Wave 2: the handle and identity model every binding reads; 5 open boxes.
**Complexity:** 4 — the handle and identity model every binding and engine module reads
**Owner:** João
**Work package:** N04 — [lifetime and numerics](README.md), [native-engine batch](../README.md)
**Depends on:** [PRD-500](../PRD-500-n03-api-catalog-binding-abi-and-version-protocol.md)

## Context

§6.1 requires public identity and aliasing to survive: `mesh.position` returns the same logical vector across repeated access. A retained vector stays valid when internal storage grows and never points at a different mesh. Handles carry type/context identity and a generation, checked at every external boundary. Raw pointers to movable storage are never exposed. §6.2 separates stable public records from packed execution arrays (transforms, bounds, draw records), which are derived from those records. The host already has a checked-handle precedent for GPU objects in `packages/runtime-native/src/webgpu/checked_handle.cpp`. The engine handles follow its generation-check idea without sharing its storage.

## Solution

1. **Handle table** (proposed: `packages/runtime-native/src/engine/foundation/handles.{h,cpp}`). Slots are generational, with a free list and reuse only after a generation bump. A handle is `{type, context, index, generation}`, as fixed by [PRD-500](../PRD-500-n03-api-catalog-binding-abi-and-version-protocol.md).
2. **Sub-object identity**: owned value members (`position`, `quaternion`, `scale`, `matrix`, `matrixWorld`, `up`) are addressable as `(owner handle, member id)`. Repeated access returns the same logical object, and writes through either alias are visible to both. Adapters cache one wrapper per logical identity.
3. **Packed data** is derived: public records own state, dense arrays are rebuilt or patched from explicit dirty marks, and hot loops resolve handles once outside the inner loop (§6.2).
4. **Diagnostics**: a stale-generation, wrong-type or wrong-context handle returns `TN_HANDLE_STALE`, `TN_HANDLE_TYPE` or `TN_HANDLE_CONTEXT`.

## Out of scope

- When an unreferenced object is reclaimed: [PRD-503](PRD-503-n04c-unreachable-cycles-are-reclaimed.md).
- Typed-array views over attributes and `.elements`: [PRD-504](PRD-504-n04d-buffers-cross-the-abi-with-an-owner.md).

## Execution Phases

#### Phase 1: Generational handles
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/foundation/handles.{h,cpp}`, `packages/runtime-native/tests/native-engine/handles_test.cpp`
- [ ] A freed slot reused for a new object rejects the old handle with `TN_HANDLE_STALE`. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_handles_generation`
- [ ] Handles from another context or of another type are rejected with their named codes. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_handles_identity`

#### Phase 2: Member aliases survive growth
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/foundation/members.{h,cpp}`
- [ ] Repeated `position` access on one object yields the same identity, and a write through one alias is read through the other. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_alias_identity`
- [ ] A retained member alias still refers to its own object after 100,000 more objects force the storage to grow. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_alias_growth`
- [ ] The alias fixtures adapted from the reference runner pass through the differential runner. proof: `pnpm parity -- --suite native-engine-alias`
