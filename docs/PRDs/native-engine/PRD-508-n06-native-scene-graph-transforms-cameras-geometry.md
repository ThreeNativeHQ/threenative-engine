# PRD-508 — Native scene graph, transforms, cameras and geometry (N06)

**Status:** PROPOSED
**Priority:** P2 — Wave 3: the native scene graph, transforms, cameras and geometry; 7 open boxes.
**Complexity:** 4 — many classes with reference-pinned semantics, but no GPU work and no new dependency
**Owner:** João
**Work package:** N06 — [native-engine batch](README.md)
**Depends on:** [N04 — Lifetime and numerical foundation](N04-lifetime-and-numerics/README.md) (handles, math, buffers); fixtures from [PRD-498 (N01)](PRD-498-n01-baseline-and-differential-fixture-runner.md)

## Context

§6.1 moves the Three-shaped public object model into C++: `Object3D`, `Scene`, `Group`, cameras,
renderable objects, lights, transforms and geometry descriptors. §6.4 pins mutation and query
semantics to `three@0.185.1` (the `catalog:` pin in `pnpm-workspace.yaml`, with
`packages/core/patches/three@0.185.1.patch`): `matrixAutoUpdate`, `matrixWorldAutoUpdate`, explicit
`updateMatrix`/`updateMatrixWorld`/`updateWorldMatrix`, manual matrices, stale reads where the
reference leaves them stale. Today the scene lives in JS inside the host (§3, R1); nothing in
`packages/runtime-native/src/` owns scene state. Materials, textures and shader nodes are
[N08](N08-native-tsl-and-shader-packages/README.md)/[N09](PRD-514-n09-native-renderer-and-standard-materials.md); animation objects are [N11](N11-native-animation/README.md).

## Solution

1. **Classes** (proposed: `packages/runtime-native/src/engine/scene/`,
   `packages/runtime-native/include/threenative/engine/scene.h`): `Object3D`, `Scene`, `Group`,
   `Mesh`, `InstancedMesh`, `Points`, `Line`, `Sprite`, `PerspectiveCamera`,
   `OrthographicCamera`, `ArrayCamera`, the light classes as parameter carriers, `Layers`,
   `BufferGeometry` + the built-in geometry generators (`BoxGeometry`, `SphereGeometry`,
   `PlaneGeometry`, … per the N03 catalog).
2. **Ownership:** stable public records for identity (N04b handles) plus packed transform/bounds
   arrays (§6.2). `mesh.position` is the same logical vector on every access and stays valid when
   storage grows.
3. **Hierarchy semantics:** `add` re-parents (removing from the old parent), `remove` detaches
   without destroying (§7.1), `attach` preserves world transform, `traverse*` order, `getObjectBy*`,
   `added`/`removed`/`childadded`/`childremoved` events in reference order.
4. **Transforms and queries:** dirty-on-write, resolved at the public call or render boundary that
   requires it (§6.4); synchronous `getWorldPosition`, `localToWorld`, `lookAt`, camera
   `updateProjectionMatrix` match the reference bit-for-bit in binary64 or within the documented
   N04a tolerance.
5. **Geometry:** `BufferGeometry` attributes, groups, draw range, `computeBoundingBox/Sphere`,
   `computeVertexNormals`, generator outputs identical to the reference vertex-for-vertex.
6. **Unsupported:** any catalogued member without a native implementation throws
   `TN_NATIVE_UNSUPPORTED <Class>.<member>` at call time and is marked so in the capability manifest.
7. **Rollback:** the legacy JS scene path remains the selected backend; nothing here is reachable
   from a shipped game until [N17](PRD-530-n17-strict-native-typescript-game-packaging.md).

## Out of scope

- Raw `.elements`/attribute array view semantics — [PRD-504 (N04d)](N04-lifetime-and-numerics/PRD-504-n04d-buffers-cross-the-abi-with-an-owner.md).
- Rendering any of it — [PRD-514 (N09)](PRD-514-n09-native-renderer-and-standard-materials.md).
- glTF scene construction — [PRD-515 (N10)](PRD-515-n10-native-gltf-cooked-assets-and-decoders.md).

## Execution Phases

#### Phase 1: Object3D, hierarchy and events
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/scene/object3d.cpp`, `tests/native-engine/scene_hierarchy_test.cpp`
- [ ] Upstream-derived `Object3D` hierarchy tests (add/remove/attach/clear, traversal order, lookup, events) pass against the native implementation. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_scene_hierarchy`
- [ ] Repeated `mesh.position` access yields one logical vector that survives 10,000 sibling insertions. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_scene_alias`

#### Phase 2: Transforms, cameras, synchronous queries
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/scene/transform.cpp`, `camera.cpp`
- [ ] `matrixAutoUpdate`/`matrixWorldAutoUpdate` on/off, manual matrices and stale-read cases match reference fixtures from N01. proof: `node packages/runtime-native/tests/native-engine/differential.mjs --suite transforms`
- [ ] Perspective/orthographic projection, `lookAt`, `getWorld*` and `localToWorld` match the reference within the N04a tolerance. proof: `node packages/runtime-native/tests/native-engine/differential.mjs --suite cameras`

#### Phase 3: Geometry
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/scene/geometry.cpp`, `geometry_generators.cpp`
- [ ] Every catalogued geometry generator emits the reference positions, normals, uvs, index and groups for the fixture parameter sets. proof: `node packages/runtime-native/tests/native-engine/differential.mjs --suite geometry`
- [ ] Bounding box/sphere and `computeVertexNormals` match the reference. proof: `node packages/runtime-native/tests/native-engine/differential.mjs --suite geometry-derived`
- [ ] Calling an uncatalogued member raises `TN_NATIVE_UNSUPPORTED` and the manifest lists it as unsupported. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_unsupported_member`

## Decisions

- **binary64 public math, float32 only on packed GPU paths (§6.3).**
- **No ECS dependency or global template redesign (§6.2).** Scalar, correct, change-tracked first; SIMD after conformance.
