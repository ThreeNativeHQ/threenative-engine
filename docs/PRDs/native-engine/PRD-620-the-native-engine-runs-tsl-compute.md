# PRD-620 — The native engine runs TSL compute

**Status:** IN PROGRESS
**Priority:** P0 — PRD-617 is a v1 release blocker, and the starter and snow templates cannot leave their legacy pins until AC-1 to AC-4 pass.
**Complexity:** 7 (HIGH)
**Owner:** PRD-617 lanes (Codex arm on `prd617/post-bindings`, GPU proof by the coordinator's worker)
**Depends on:** PRD-617

## Context
On 2026-10-15 the starter booted on the native engine desktop player and then failed with `TN_TSL instancedArray: expected a finite number`. `packages/runtime-native/src/engine/` has no general compute path. The only compute is the GPUParticles kernel. The starter uses TSL compute in two places: core `SoftBody3D` (pennant cloth: `instancedArray(TypedArray, type)`, `Fn(...)().compute(n)`, `renderer.compute`, `renderer.getArrayBufferAsync`) and `temporalRejectionCounter` (`.compute(n)`, `atomicAdd`/`atomicStore`, readback). Snow uses atomics and compute too. PRD-617 round 3 already lowers atomic statements to WGSL that Tint accepts. Dispatch and readback do not exist.

## Solution
Use the upstream three.js API only (`instancedArray`, `storage`, `Fn().compute(count, workgroupSize)`, `renderer.compute` / `computeAsync`, `renderer.getArrayBufferAsync(attribute)`). Lower the compute node graph through the existing shader graph to a WGSL compute entry point. Allocate read-write storage buffers for `instancedArray` / `StorageBufferAttribute`, bind them to compute and render reads, queue dispatches in renderer order before the frame's render passes, and read back by a mapped staging copy that resolves the returned promise. The same code serves the V8 player and the Wasm web engine.

## Acceptance Criteria
- [x] AC-1 [local]: `instancedArray(Float32Array, "vec3")` and `instancedArray(count, type)` construct storage on V8 and Wasm. proof: native-engine ctest + vitest. Passed: see Phase 1.
- [x] AC-2 [local]: a `Fn().compute(n)` kernel that writes storage runs through `renderer.compute`, and a render material reads the written values in the same frame. proof: GPU ctest with a pixel or readback assertion.
- [x] AC-3 [local]: `renderer.getArrayBufferAsync` returns the written bytes; atomics (`atomicAdd`, `atomicStore`, `atomicLoad`) give the exact expected counts. proof: GPU ctest.
- [ ] AC-4 [local]: the starter (cloth and temporal rejection) and snow run on native desktop and web with their pins removed; playtests pass; a fresh visual judge returns NEUTRAL or IMPROVEMENT against legacy. proof: template playtests, judge verdict.

## Execution Phases
#### Phase 1: storage and dispatch
**Status:** DONE
**Files:** `src/engine/shader/graph/*`, `src/engine/renderer/*`, `src/engine/abi/bindings_*.cpp`, `src/adapters/v8/tsl.cpp`, `src/engine/player/core-tsl.mjs`, `packages/three-native/src/*` (Wasm facade).
- [x] Storage constructs and a compute kernel writes it before the frame's render reads it (AC-1, AC-2). proof: native-engine ctest + vitest.
  Result 2026-10-15: V8 player `native_engine_player_compute` passes (instancedArray count and typed-array forms, padded vec3, a vertex-stage `positionNode` read, a render-target read and a main-frame read of kernel output, in the same frame as the dispatch); red before the work was `COMPUTE_ERROR TN_TSL instancedArray: expected a finite number`. Wasm facade: `packages/three-native/__tests__/storage.spec.ts` (7 tests) and the browser page `examples/wasm-engine-boot/compute.html`, whose 9 component assertions pass on an NVIDIA Turing adapter. `ctest -L native-engine` 400/400, three-native vitest 161/161.
#### Phase 2: readback and atomics
**Status:** DONE
- [x] `getArrayBufferAsync` returns the written bytes and atomics give exact counts (AC-3). proof: GPU ctest.
  Result 2026-10-15: `native_engine_player_compute` reads 256 floats, a padded vec3 buffer and a uint buffer back exactly, and 1000 threads count `[334,1000]` twice (a reset in its own dispatch between rounds). The same bytes come back on the Wasm page. `getArrayBufferAsync` takes no target, an ArrayBuffer target or a ReadbackBuffer, and refuses an offset or count that is not a multiple of 4. The WGSL is accepted by Dawn (desktop player) and by Chrome's Tint (Wasm page).
Recovery verification 2026-10-15, source `687729c5a`: product desktop player rebuilt with physics and UI overlay enabled; Wasm rebuilt (3,567,874 bytes). `native_engine_player_compute`, `native_engine_player_compute_ops`, `native_engine_player_ui_overlay` and `native_engine_player_real_input_ui`: 4/4 passed. Starter/snow gameplay and visual acceptance remain unverified.

Integer-uniform review repair 2026-10-15: accepted `uniform(value, "int"/"uint")` could neither reassign `.value` nor upload to render materials, and float-backed snapshots lost integers above `2^24`. Red: the real C ABI regression failed creation precision, reassignment and invalid-range rejection. Numeric uniform snapshots now retain doubles until the existing shared layout writer uploads f32/i32/u32 words; f32 setters retain their previous rounding. Green: five CPU ABI cases (uniform values, TSL calls, effect parameters, starter post bindings, authored output), exact uint-max/int-min upload words, rejected fractional/out-of-range/nonfinite integer values without mutation, f32 rounding/negative-zero upload bits, focused TS tests 19/19 and three-native typecheck. Changed compute/render/post sources and V8 adapter test compile in temporary CPU objects; shared CMake products remain untouched. The extended public compute/render reassignment and pixel assertions require the coordinated desktop/Wasm rebuild and remain unrun.

#### Phase 3: templates
**Status:** IN PROGRESS
- [ ] Starter and snow pass their playtests on native desktop and web, judged NEUTRAL or better (AC-4). proof: template playtests + judge.
  Recovery failure 2026-10-15: actual Snow web and desktop runs reached `TN_NATIVE_SHADER_INVALID builtin instanceIndex: not available in this stage`. Snow reads both particle storage attributes and `instanceIndex` in its fragment color. The shared fix chooses vertex versus instance storage indices, carries attribute values through vertex-to-fragment varyings, links sprite graphs through the mesh linker, and emits flat integer varyings. Red: CPU public-ABI index/fragment compilation failed and the two facade attribute tests failed. Green: the CPU ABI regression passes (including real BufferAttribute storage through mesh/sprite compilation), storage/browser-tsl vitest 19/19, and three-native typecheck. The extended `native_engine_player_compute_ops` pixel/readback regression, rebuilt desktop/Wasm gameplay and visual acceptance remain unrun; AC-4 stays open.

2026-10-15: Starter web startup failed with `TN_START_FAILED` at the SoftBody3D node-material guard on the discrete NVIDIA/Turing adapter. The browser facade omitted concrete node-material identity; the native-facade SoftBody regression reproduced the error, then passed after the shared type-flag repair. Focused checks: three-native suite plus core SoftBody, 205 tests passed; three-native/core TypeScript checks passed. Browser startup replay, snow, and the visual judge remain pending; AC-4 stays open.

Regression portability: the SoftBody suite passed 23/23 from both repository root and `packages/core` (focused package-local Vitest include configuration); its catalog path now resolves from the test module.
