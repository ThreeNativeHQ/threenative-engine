# PRD-500 — API catalog, binding ABI and version protocol (N03)

**Status:** PROPOSED
**Priority:** P1 — Wave 1: the binding ABI and version protocol every adapter and engine module reads; 7 open boxes.
**Complexity:** 5 — the one contract every adapter, generator and engine module depends on
**Owner:** João
**Work package:** N03 — [native-engine batch](README.md)
**Depends on:** [PRD-497](PRD-497-n00-architecture-decision-and-compatibility-inventory.md)

## Context

§8.1 asks for one machine-readable catalog of the supported Three-shaped surface. It records classes, constructors, inheritance, fields, methods, overloads, defaults, enums, lifetime and mutability annotations, async behaviour, callback signatures and capability status. Declarations, AOT wrappers, the optional V8 bindings, docs and ABI tests are all generated from it. §8.2 fixes the boundary: a versioned C ABI with fixed-width fields, opaque typed handles, explicit buffer descriptors, callback-plus-context pairs, status codes and owned diagnostic strings, with no STL and no exceptions. Four versions are kept separate: engine ABI, compatibility contract, serialized scene and shader package. Mismatches are rejected before a game starts.

The repo's existing capability surface is `packages/create-threenative/capabilities.json`. The catalog must agree with what that advertises for the native profile (§8.1: published types and runtime capabilities agree). §17 asks for fuzzing on ABI inputs.

## Solution

1. **Catalog** (proposed: `packages/three-native/api/catalog.json` with a schema). It is hand-curated from the pinned reference and seeded from the N00 inventory. Each entry carries a capability status: `supported`, `partial(<named gaps>)` or `unsupported(<diagnostic code>)`.
2. **Generators** (proposed: `packages/three-native/scripts/generate.ts`) emit `generated/*.d.ts`, the C header `packages/runtime-native/include/threenative/abi/tn_abi.h`, and ABI conformance tests. Generation adapts names and shapes; it implements no algorithm (§8.3).
3. **ABI rules**: handles are `{type, context, index, generation}` structs. JS-facing adapters never carry them as plain numbers (§8.2). Every entry point returns a status code plus an owned diagnostic. Buffer descriptors state owner, length, stride, scalar type and mutability, with full ownership semantics in [PRD-504](N04-lifetime-and-numerics/PRD-504-n04d-buffers-cross-the-abi-with-an-owner.md).
4. **Version handshake**: the four version numbers plus the capability set are checked at load. A mismatch fails with a named code before any game code runs.
5. **Fuzzing**: a libFuzzer target feeds random handles, descriptors and strings through the ABI dispatch. It runs under the sanitizer label from [PRD-499](PRD-499-n02-the-host-links-without-a-js-engine.md).

## Out of scope

- Handle storage, aliasing and reclamation: [N04](N04-lifetime-and-numerics/README.md).
- AOT wrapper compilation: [N05](N05-native-typescript-qualification/README.md). V8 wrappers: [PRD-531](PRD-531-n18-v8-game-runtime-adapter.md).

## Execution Phases

#### Phase 1: The catalog exists and generates declarations
**Status:** NOT STARTED
**Files:** proposed `packages/three-native/api/{catalog.json,catalog.schema.json}`, `packages/three-native/scripts/generate.ts`, `packages/three-native/__tests__/catalog.spec.ts`
- [ ] The schema rejects an entry with no capability status and an overload set with ambiguous signatures. proof: red-green `pnpm exec vitest run packages/three-native/__tests__/catalog.spec.ts`
- [ ] Generated declarations for the seed classes (Object3D, Scene, Mesh, Vector3, Matrix4) typecheck the §2.2 sample program. proof: `pnpm --filter @threenative/three-native generate && pnpm typecheck`
- [ ] Every catalog entry marked `supported` for the native profile also appears in the native section of `capabilities.json`, and nothing else does. proof: `pnpm exec vitest run packages/three-native/__tests__/catalog-capabilities.spec.ts`

#### Phase 2: The C ABI and version handshake
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/include/threenative/abi/tn_abi.h`, `packages/runtime-native/src/engine/abi/`, `packages/runtime-native/tests/native-engine/abi_test.cpp`
- [ ] The generated header compiles as C11 and contains no STL types. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_abi_c11`
- [ ] A module built against a different engine-ABI, contract, scene or shader-package version is rejected with its named code before start. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_abi_version`
- [ ] A stale-generation or wrong-type handle returns a status code, never a crash. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_abi_handles`

#### Phase 3: The ABI survives hostile input
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/tests/native-engine/fuzz_abi.cpp`
- [ ] The ABI fuzzer runs 10 minutes under ASan/UBSan with no finding. proof: `pnpm --filter @threenative/runtime-native native:test:asan -- --fuzz native_engine_fuzz_abi --max-total-time=600`

## Decisions

- No C++ exceptions or STL containers cross the ABI; JS numbers never carry raw 64-bit handles (§8.2). Fixed by the proposal.
