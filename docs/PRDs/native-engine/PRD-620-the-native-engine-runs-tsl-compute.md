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
- [ ] AC-1 [local]: `instancedArray(Float32Array, "vec3")` and `instancedArray(count, type)` construct storage on V8 and Wasm. proof: native-engine ctest + vitest.
- [ ] AC-2 [local]: a `Fn().compute(n)` kernel that writes storage runs through `renderer.compute`, and a render material reads the written values in the same frame. proof: GPU ctest with a pixel or readback assertion.
- [ ] AC-3 [local]: `renderer.getArrayBufferAsync` returns the written bytes; atomics (`atomicAdd`, `atomicStore`, `atomicLoad`) give the exact expected counts. proof: GPU ctest.
- [ ] AC-4 [local]: the starter (cloth and temporal rejection) and snow run on native desktop and web with their pins removed; playtests pass; a fresh visual judge returns NEUTRAL or IMPROVEMENT against legacy. proof: template playtests, judge verdict.

## Execution Phases
#### Phase 1: storage and dispatch
**Status:** NOT STARTED
**Files:** `src/engine/shader/graph/*`, `src/engine/renderer/*`, `src/engine/abi/bindings_*.cpp`, `src/adapters/v8/tsl.cpp`, `src/engine/player/core-tsl.mjs`, `packages/three-native/src/*` (Wasm facade).
**Verification:** AC-1, AC-2.
#### Phase 2: readback and atomics
**Status:** NOT STARTED
**Verification:** AC-3.
#### Phase 3: templates
**Status:** NOT STARTED
**Verification:** AC-4.
