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

- 2026-11-06 (meshopt slice, PS4 PR #621 — the owner keeps PS4 asset loading in that one PR): meshoptimizer **1.3** (`zeux/meshoptimizer@v1.3`, MIT) is provisioned by `packages/runtime-native/scripts/download-deps.mjs` as the `meshopt` dependency — four files, each pinned in `native-deps.lock.json` by sha256: `meshoptimizer.h` `e3688ef5…531f61b`, `vertexcodec.cpp` `6af26a85…99550f`, `indexcodec.cpp` `2b98ede6…7fff6e`, `vertexfilter.cpp` `780e7f95…ac4ff3` — and compiled as `tn_engine_meshopt` (`cmake/NativeEngineCore.cmake`) into every target the engine builds: desktop (linux/windows/macos), the `wasm` and `wasm-threads` presets, `tn-android` and `tn-ios`. No platform-specific code: the codecs' SIMD is chosen by `__SSE*`/`__ARM_NEON`/`__wasm_simd128__` guards upstream. (`tn-ps4` does not exist in this tree; a PS4 preset inherits the same target the moment it is added, since the library sits in the shared core.) The native glTF loader decodes `EXT_meshopt_compression` (cgltf's parse) and `KHR_meshopt_compression` (cgltf 1.15 ignores it, so the same JSON fields are read from the document) with `meshopt_decodeVertexBuffer` / `meshopt_decodeIndexBuffer` / `meshopt_decodeIndexSequence`, then the spec's `OCTAHEDRAL`, `QUATERNION`, `EXPONENTIAL` and `COLOR` filters. `count * byteStride` is overflow-checked and must equal the parent bufferView's `byteLength` before a byte is decoded, so the decode writes exactly the declared size. Fallback buffers are handled as the extension states: a placeholder buffer with no uri carries no data and the decoded bytes replace it, and `cgltf_buffer_view_data` is never used for a compressed view. Malformed input is `TN_NATIVE_GLTF_MESHOPT_INVALID bufferView <index>: <reason>` — unknown mode/filter, `count * byteStride` mismatch, compressed bytes outside their buffer, or a failed decode — never a crash. Both names left the refused list and stay out of it (Draco, KTX2/Basis and AVIF remain refused by name). `targetDecoders()` now returns `kDecoderMeshopt` wherever `TN_ENGINE_MESHOPT` is defined, so a cooked package may keep meshopt-compressed geometry; the native-engine cook (`bundle-native-engine.mjs`) passes `meshopt: true` for that reason while KTX2 stays `false`, and the decoder matrix prints `meshopt geometry qualified` beside `draco geometry TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED` and `ktx2/basis texture TN_NATIVE_KTX2_UNSUPPORTED`. Proof: `ctest -R native_engine_gltf_meshopt` — `native_engine_gltf_meshopt_decoded`, `native_engine_gltf_meshopt_khr` and `native_engine_gltf_meshopt_malformed` pass against `tests/native-engine/assets/meshopt-compressed.glb` (912 bytes, encoded by the pinned meshoptimizer itself; the fixture carries no fallback data); `native_engine_decoder_matrix` (row `meshopt geometry qualified`), `native_engine_package_sha256`, `native_engine_cooked_package_parse` and `native_engine_gltf_hierarchy` still pass. The three run green again under ASan/UBSan (`-DTN_ENGINE_CORE_ONLY=ON -DTN_ENGINE_SANITIZE=ON`, clang) and as Wasm under node (`build/native-engine-wasm`, the same source pinned for Emscripten): that is the Windows/macOS/Android/iOS claim unproven, those trees were not built here, and nothing in the change is platform-specific. The web engine (`pnpm wasm:build`, `tn-native-engine-web.wasm` 4.0 MB) carries the meshopt loader, and `packages/create-threenative/__tests__/template.spec.ts` passes 58/58 against it; the CI specs that read the edited workflow and dependency files pass 694/694. A malformed meshopt image view no longer reaches `imageFormat` as a null pointer in the job-pool predecode (`native_engine_asset_fuzz_gltf` passes). The decoder-matrix box in phase 3 stays **open**: KTX2 and Draco are still refused, and no Android/iOS device ran this decoder.
- 2026-10-19 (unreal-look epic, PR #541): the engine is now the default web renderer, and its glTF loader still refuses a whole model that uses `KHR_draco_mesh_compression`, `EXT_meshopt_compression`, `KHR_meshopt_compression`, `KHR_texture_basisu` or `EXT_texture_avif` (`TN_NATIVE_GLTF_EXTENSION_UNSUPPORTED`; a test pins this in `gltf_hierarchy_test.cpp`, `4cb3aa03c`). A user model exported with compression therefore fails to load on the web by default, not only on mobile. The web decoder rows of the decoder matrix are user-facing.
- cgltf is parser-only. Construction, extensions, decoding and lifetime stay owned code (§4).
- Existing disabled native glTF files are references, not production code (§11.1).
