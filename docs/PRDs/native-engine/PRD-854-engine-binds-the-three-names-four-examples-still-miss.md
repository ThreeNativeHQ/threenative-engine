# PRD-854 — The engine binds the three.js names four examples still miss

**Status:** NOT STARTED
**Priority:** P3 — four examples do not package or run on the owned engine; no shipped kit imports these names
**Complexity:** 6 (MEDIUM-HIGH) — new engine texture and render-target kinds, a TSL adapter change and keyframe track methods, each on V8 and Wasm
**Owner:** unassigned
**Depends on:** [PRD-784](../done/PRD-784-ps4-feasibility-experiments.md) P5-9 (the JS-only bindings landed there)

## Context

PRD-784 P5-9 bound every name that a JS port over existing engine classes covers: `EdgesGeometry`, `Box2`, `AnimationUtils`, `CCDIKSolver`, `DataArrayTexture`, `viewportCoordinate`, the typed buffer attributes and the constants. The owner moved the rest here (2026-11-08, option 1), because each item needs C++ engine work. `bundle-native-engine.mjs` refuses these names with `TN_NATIVE_ENGINE_UNBOUND`:

- `examples/prd476-fluid-particles`: `three/webgpu:Storage3DTexture`.
- `examples/prd493-terrain-splat`: 12 names, including `CompressedArrayTexture` and `InstancedInterleavedBuffer` (full list: run the bundler on the example).
- `examples/prd268-probe-volume`: `CubeCamera`, `CubeRenderTarget`, `RenderTarget3D`, `three-mesh-bvh/webgpu`.

Two examples package and then stop at run time on the desktop V8 player:

- `examples/prd249-fluid-field`: `TN_TSL toReadOnly: toReadOnly requires a storage buffer`. The V8 TSL adapter accepts `toReadOnly` only on storage buffers, not on `storageTexture(...)` (`adapters/v8/tsl.cpp:304`).
- `examples/animation-composition`: `clip.toJSON is not a function`, then keyframe track `getValueSize` and `setInterpolation`. Also `packages/core/src/animation-layers.ts:208` drops the clip that `AnimationUtils.makeClipAdditive` returns. On the engine that call returns a new clip, so the layer is not additive.

`Int16BufferAttribute` stays unbound: the engine stores an Int16Array as float32, so a normalized Int16 attribute reads wrong on the GPU.

## Acceptance Criteria

- [ ] AC-1 [local]: `bundle-native-engine.mjs --engine native --game-runtime v8` exits 0 for the five examples above. — proof: the bundler command per example.
- [ ] AC-2 [local, desktop]: each of the five examples starts and draws on the desktop V8 player, with no `TN_NATIVE_UNSUPPORTED` or `TN_TSL` error. — proof: the player log and a non-blank screenshot per example.

## Execution Phases

#### Phase 1: Run-time fixes for the two examples that already package
**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/engine/adapters/v8/tsl.cpp`, `packages/core/src/animation-layers.ts`, the keyframe track bindings
- [ ] `toReadOnly` accepts a storage texture; prd249 starts on the desktop player. proof: red-green spec, then AC-2 for prd249
- [ ] `animation-layers.ts:208` keeps the returned clip; tracks answer `getValueSize` and `setInterpolation`; animation-composition starts. proof: red-green spec, then AC-2 for animation-composition

#### Phase 2: Texture and render-target kinds
**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/engine/` (texture and render-target bindings), `core-three.mjs`, `core-webgpu.mjs`, `packages/three-native/src/browser-entry.ts`
- [ ] `Storage3DTexture`; prd476 packages and starts. proof: AC-1 and AC-2 for prd476
- [ ] `CubeCamera`, `CubeRenderTarget`, `RenderTarget3D` and a `three-mesh-bvh/webgpu` facade; prd268 packages and starts. proof: AC-1 and AC-2 for prd268
- [ ] `CompressedArrayTexture`, `InstancedInterleavedBuffer` and the rest of prd493's names; prd493 packages and starts. proof: AC-1 and AC-2 for prd493

## Decisions

- 2026-11-08 (João): The C++ part of PRD-784 P5-9 moves to this PRD, so PRD-784 closes at 100%.
