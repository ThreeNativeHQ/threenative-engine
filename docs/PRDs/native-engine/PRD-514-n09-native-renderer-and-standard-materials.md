# PRD-514 — Native renderer and standard materials (N09)

**Status:** PROPOSED
**Priority:** P2 — Wave 4: the first C++ renderer and the standard materials; 8 open boxes.
**Complexity:** 5 — first C++ renderer in the repo; reads native scene state and draws standard materials against a pinned reference
**Owner:** João
**Work package:** N09 — [native-engine batch](README.md)
**Depends on:** [PRD-508 (N06)](PRD-508-n06-native-scene-graph-transforms-cameras-geometry.md), [PRD-509 (N07)](PRD-509-n07-gpu-resources-presentation-and-device-loss.md), [N08 shader packages](N08-native-tsl-and-shader-packages/README.md)

## Context

§10 asks for a renderer that reads native state and keeps persistent renderable, material and resource records, invalidated by revision rather than rediscovered every frame. The first path is opaque, alpha-masked and transparent rendering, camera and layer selection, ordinary shadows, geometry and material updates, resize and readback. §9.3 pins PBR equations, lighting units, colour conversion, tonemapping, alpha, normals and material defaults to the pinned `three@0.185.1` reference. The behaviour to preserve today lives in `packages/core/src/renderer.ts` (the renderer interface, §3 R3), `packages/core/src/renderer-config.ts`, `packages/core/src/render-camera-cull.ts` and `packages/core/src/render/material-key.ts`. The JS frame-op stream and its replay belong to the legacy backend (§10), not this renderer.

## Solution

1. **Render database derived from the native graph.** Proposed: `packages/runtime-native/src/engine/renderer/`. It keeps one record per renderable, material instance and GPU resource, keyed by the N04 handle. It updates from N06 revision counters and never polls a JS scene. The public object graph stays the only source of truth (§5, §6.2).
2. **First pass set.** Opaque front-to-back, alpha-masked (alpha test plus the reference's alpha-to-coverage rule), and transparent back-to-front with the reference's sort keys and `renderOrder`. Camera `layers` and `visible` are applied. Every `render(scene, camera)` call gets its own render ID (§6.4, §12).
3. **Ordinary shadows.** Directional, spot and point shadow maps, with the reference's bias, `castShadow`/`receiveShadow` and shadow-camera semantics. Virtual shadows belong to PRD-524.
4. **Standard materials.** `MeshBasicMaterial`, `MeshLambertMaterial`, `MeshPhongMaterial`, `MeshStandardMaterial` and `MeshPhysicalMaterial` (the subset the representative games need, §9.3) compile through the N08 shader-package path. Advanced material features nobody has ported fail with `TN_NATIVE_MATERIAL_UNSUPPORTED` naming the property. They never fall back silently to a simpler shader.
5. **Resize and readback** go through the N07 surface and readback services. `renderer.ts` keeps its behaviours (compile, readback, output graph, timing) as a binding consumer, and `ctx.renderer.raw` returns this compatible renderer object, covering the public fields templates read (`toneMapping`, `toneMappingExposure`, `shadowMap`); renderer-private fields and the raw GPU device are named unsupported (owner decision 7, [PRD-497](PRD-497-n00-architecture-decision-and-compatibility-inventory.md)).
6. **Rollback.** The legacy upstream `WebGPURenderer` backend stays selectable. A native-engine artifact never falls back to it (§1).

## Out of scope

- Batching, instancing, culling and LOD eligibility: [PRD-519 (N12)](PRD-519-n12-native-batching-visibility-lod-gpu-scene.md)
- Render graph, temporal history and post chains: [N14](N14-native-render-chain-and-advanced-visuals/README.md)
- Skinned and morphed draws: [N11](N11-native-animation/README.md)
- Shader IR and package generation: [N08](N08-native-tsl-and-shader-packages/README.md)

## Execution Phases

#### Phase 1: Opaque scene from native state
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/renderer/`, `packages/runtime-native/tests/native-engine/renderer/`
- [ ] Render records update only from revision changes: an unchanged scene rebuilds zero records across 300 frames. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_renderer_invalidation`
- [ ] A lit opaque `MeshStandardMaterial` scene matches the pinned upstream reference capture within the documented tolerance. proof: `pnpm parity` case `native-engine-standard-lit`
- [ ] Resize and readback return the new extent and a non-blank frame on the native host. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_renderer_resize_readback`

#### Phase 2: Alpha, transparency, cameras and layers
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/renderer/passes/`
- [ ] Alpha-masked and transparent objects sort and blend as the reference does, `renderOrder` included. proof: `pnpm parity` case `native-engine-alpha-transparency`
- [ ] Two cameras with different `layers`, rendered in one tick, each see only their layer and get distinct render IDs. proof: `pnpm parity` case `native-engine-multi-camera-layers`

#### Phase 3: Shadows and the standard material set
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/renderer/shadows/`, `packages/runtime-native/src/engine/renderer/materials/`
- [ ] Directional, spot and point shadow maps match the reference capture. proof: `pnpm parity` case `native-engine-ordinary-shadows`
- [ ] Each of the five standard materials matches its reference fixture, and an unported property is rejected with `TN_NATIVE_MATERIAL_UNSUPPORTED`. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_standard_materials`
- [ ] Geometry and material edits between frames show up on the next render with no stale records. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_renderer_updates`

## Decisions

- JS WebGPU frame-op serialization and replay stays in the legacy backend and is not part of native submission (§10).
- Better visual defaults are separate opt-in changes, never part of the parity comparison (§9.3).
