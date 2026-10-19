# PRD-515 — Native glTF, cooked assets and decoders (N10)

**Status:** PROPOSED
**Priority:** P2 — Wave 3: glTF ingest, the cooked package format and the decoders; 7 open boxes.
**Complexity:** 4 — parser reuse, but scene construction, a cooked package format and decoder qualification are all new and face untrusted input
**Owner:** João
**Work package:** N10 — [native-engine batch](README.md)
**Depends on:** [PRD-508 (N06)](PRD-508-n06-native-scene-graph-transforms-cameras-geometry.md), [PRD-509 (N07)](PRD-509-n07-gpu-resources-presentation-and-device-loss.md)

## Context

§11.1 asks for cgltf to parse glTF/GLB, with scene, material and animation construction written in C++. Build-time cooking produces versioned packages with manifests, hashes, decoder requirements, upload sizes and bounded streaming admission. No JS `GLTFLoader` runs at runtime. Today cgltf is compiled in (`packages/runtime-native/src/utils/cgltf_impl.cpp`). The deprecated native loader `packages/runtime-native/src/gltf/gltf_loader.cpp` stays disabled and is reference material only (`packages/runtime-native/AGENTS.md`, R1). Cooking lives in `packages/assets/src/` (`gltf-io.ts`, `compile.ts`, `world/`). Mobile decoder refusals (`TN_NATIVE_KTX2_UNSUPPORTED`, `TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED`) are documented in `packages/runtime-native/AGENTS.md` and stay until a native decoder passes on the exact artifact and hardware.

## Solution

1. **Parser boundary.** cgltf only parses. Proposed `packages/runtime-native/src/engine/assets/gltf/` builds N06 nodes, meshes and geometry, standard materials (N09), textures (N07) and animation clips (N11a) through the native public API, in the reference `GLTFLoader` hierarchy and naming.
2. **Cooked package.** Proposed `packages/runtime-native/src/engine/assets/package/` reads a versioned binary package: a manifest with a format version, per-entry SHA-256, decoder requirements, GPU upload sizes and dependencies. `packages/assets` emits it as an additional output of its existing pass chain. A version or hash mismatch is rejected before load (§8.2).
3. **Async semantics.** IO completions go onto the engine event queue and reach the game thread at defined boundaries (§11.1). The engine core has no Promise. Cancelling a load never frees a resource that is still in use (§12).
4. **Decoders.** Only qualified decoders are added. meshoptimizer is reused if a native copy is already provisioned (§4). KTX2/Basis and Draco stay refused with the existing codes until each passes on the target artifact. An unsupported extension fails with `TN_NATIVE_GLTF_EXTENSION_UNSUPPORTED` naming it.
5. **Untrusted input.** Every offset, length, stride and accessor bound is checked before access (§7.2). The glTF and package readers get fuzz targets (§17).
6. **Rollback.** The legacy backend keeps the upstream JS `GLTFLoader`.

## Out of scope

- Streaming admission, world packages and budgets: [N13](N13-native-streaming-and-world/README.md)
- Animation evaluation of the loaded clips: [N11](N11-native-animation/README.md)
- Material shading parity: [PRD-514 (N09)](PRD-514-n09-native-renderer-and-standard-materials.md)

## Execution Phases

#### Phase 1: glTF to a native scene
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/assets/gltf/`, `packages/runtime-native/tests/native-engine/assets/`
- [ ] The glTF sample corpus loads into a native hierarchy whose names, transforms, materials and clip list match the reference `GLTFLoader` dump. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_gltf_hierarchy`
- [ ] A loaded model renders and matches the upstream capture of the same file. proof: `pnpm parity` case `native-engine-gltf-model`

#### Phase 2: Cooked packages without JS
**Status:** NOT STARTED
**Files:** `packages/assets/src/` (package emitter); proposed `packages/runtime-native/src/engine/assets/package/`
- [ ] `packages/assets` emits a native package with a manifest, per-entry hashes, decoder requirements and upload sizes. proof: `pnpm exec vitest run packages/assets/__tests__/native-package.spec.ts`
- [ ] A packaged game loads its cooked assets in a native-engine build whose engine targets link no JS engine. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_cooked_package_load`
- [ ] A hash or version mismatch is rejected before load with a stable error code. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_cooked_package_reject`

#### Phase 3: Malformed data and the decoder matrix
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/tests/fuzz/gltf_fuzz.cpp`, `packages/runtime-native/tests/fuzz/package_fuzz.cpp`
- [ ] The glTF and package fuzz targets run under ASan/UBSan for the CI budget with no crash or sanitizer report. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_asset_fuzz`
- [ ] The decoder matrix test records every format as qualified or refused per target, and the refusal codes stay in force on mobile. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_decoder_matrix`

## Blocked on

- Qualifying a mobile KTX2 or Draco decoder needs the physical Android device run on the exact installed artifact (owner attaches the device).

## Decisions

- cgltf is parser-only. Construction, extensions, decoding and lifetime stay owned code (§4).
- Existing disabled native glTF files are references, not production code (§11.1).
