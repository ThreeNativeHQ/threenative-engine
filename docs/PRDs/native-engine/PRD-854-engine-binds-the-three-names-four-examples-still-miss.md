# PRD-854 — The engine binds the three.js names four examples still miss

**Status:** IN PROGRESS
**Priority:** P3 — four examples do not package or run on the owned engine; no shipped kit imports these names
**Complexity:** 6 (MEDIUM-HIGH) — new engine texture and render-target kinds, a TSL adapter change and keyframe track methods, each on V8 and Wasm
**Owner:** unassigned
**Depends on:** PRD-784 P5-9 (the JS-only bindings landed there, [PR #621](https://github.com/ThreeNativeHQ/threenative-engine/pull/621))

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
**Status:** DONE (2026-11-08)
**Files:** `packages/runtime-native/src/adapters/v8/tsl.cpp`, `packages/runtime-native/src/engine/abi/tsl_call.cpp`, `packages/runtime-native/src/engine/abi/bindings_scene.cpp`, `packages/runtime-native/src/engine/player/core-tsl.mjs`, `packages/three-native/src/{browser-tsl,tsl-uniforms,animation-utils,browser-entry}.ts`, `packages/core/src/animation-layers.ts`
- [x] `toReadOnly` accepts a storage texture; prd249 starts on the desktop player. proof: ABI `tsl_storage_texture_read` red (`CHECK failed: readOnly == target`), then green. The shared TSL table now takes `toReadOnly`, `toWriteOnly`, `toReadWrite` and `setSampler(false)` on a storage texture and `.sample(uvec2)` as a texel load, and a kernel that returns its `textureStore` keeps no value. `storage-texture.spec.ts` red (`toReadOnly is not a function`), then green, on the Wasm TSL. The player run found three more stops, each fixed: `compute(node, count)` passed `undefined` as the workgroup size (`core-tsl.mjs`), `uniformArray(...).element(i)` at a Loop index (`tsl-uniforms.spec.ts` red `TN_TSL_UNIFORM_ARRAY`, then green), and the returned store. AC-2: `fluid-field-desktop.playtest.json --target desktop --executable build/tn-engine-ui/tn-native-engine-player-v8` passes, with 0 `TN_TSL` or `TN_NATIVE_UNSUPPORTED` lines. The `settled-native-splat` frame shows both looks with their splats.
- [x] `animation-layers.ts:208` keeps the returned clip; tracks answer `getValueSize` and `setInterpolation`; animation-composition starts. proof: `vq-masked-additive-animation.spec.ts` red (0.2 rad, the override result), then green (0.1 rad). The V8 `skeletal` case is red (`turn.getValueSize is not a function`), then green. It covers the track methods `getValueSize`, `getInterpolation` and `setInterpolation`, the `name` and `values` setters, the clip `blendMode` getter and setter, and `clip.toJSON()`. `animation-utils.spec.ts` covers the shared `track.createInterpolant` port, which core root motion samples. It matches three's own interpolant for linear and discrete keys on all three track types (red: `defineCreateInterpolant is not a function`). `animation-layers.ts` writes the consumed root pose back with `track.values = ...`, because the engine `values` getter returns a copy. AC-2: the desktop player starts and draws the rig with 0 `TN_TSL` or `TN_NATIVE_UNSUPPORTED` lines (`after.png`). Open, outside this box: the browser `composition.playtest.json` run on the desktop target fails 5 assertions: `history.cycles`, `history.exitActions`, `history.exitOwnedBytes`, `history.clipsUnchanged`, and `lowerError` (up to 0.18 against 1e-5). The cause is unverified.

#### Phase 2: Texture and render-target kinds
**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/engine/` (texture and render-target bindings), `core-three.mjs`, `core-webgpu.mjs`, `packages/three-native/src/browser-entry.ts`
- [x] `Storage3DTexture`; prd476 packages and starts. proof: ABI `tsl_storage_texture_3d` red (exit 139), then green. It checks a `uvec3` coordinate, `texture_storage_3d<rgba8unorm, write>` in the WGSL, a 3D binding, `texture3D` on the `Storage3DTexture`, and a refusal of `texture3D` on a 2D `StorageTexture`. The catalog adds the class, and the registry binds it beside `StorageTexture` (3D extents up to 2048). `uvec3` and `uvec4` reach the V8, Wasm and player TSL. The player run found two more stops, each fixed: `toVar(name)` (V8 `tsl_api` red `TN_TSL toVar: expected 0 arguments`, then green; the stale `toVar` check from #605 is corrected in the same case) and `atomicMax`/`atomicMin` (ABI `starter_post_bindings` red, then green: `atomicSub`, `atomicMax`, `atomicMin`, `atomicAnd`, `atomicOr` and `atomicXor` lower to their WGSL builtins). AC-1: the bundler exits 0. AC-2: `fluid-particles-desktop.playtest.json --target desktop` starts and draws the tank with 0 `TN_TSL` or `TN_NATIVE_UNSUPPORTED` lines. A probe game proved the 3D path at the game's volume size (53x42x30): a compute kernel writes the `Storage3DTexture`, and the example's own `water-volume.ts` look draws water from it. The same run of prd249 still passes. Open, outside this box: in the full game the water look draws no water, and `maxSpeed` stays between 2.6 and 18 m/s (the scenario wants 1.0 or less after 832 steps). The solver runs (`peakFrontX` 2.9, `meanCompression` 0.001), so the cause is in the native solver or volume kernels. The cause is unverified. The same commit adds the Phase 1 clip and track members to `catalog.json` and refreshes `native-registry.json`.
- [ ] `CubeCamera`, `CubeRenderTarget`, `RenderTarget3D` and a `three-mesh-bvh/webgpu` facade; prd268 packages and starts. proof: AC-1 and AC-2 for prd268
- [ ] prd493's TSL names: `element`, `instancedBufferAttribute`, `instancedDynamicBufferAttribute`, `positionView`, `transformNormal`, `varyingProperty`. proof: red-green spec, then the bundler on prd493
- [ ] prd493's `three/webgpu` names: `BundleGroup`, `EventNode`, `IndirectStorageBufferAttribute`. proof: red-green spec, then the bundler on prd493
- [ ] `CompressedArrayTexture`, `InstancedInterleavedBuffer` and `TextureUtils`; prd493 packages and starts. proof: AC-1 and AC-2 for prd493

## Decisions

- 2026-11-08 (João): The C++ part of PRD-784 P5-9 moves to this PRD, so PRD-784 closes at 100%.
