# PRD-871: The owned engine draws Points

**Status:** IN PROGRESS
**Priority:** P1 — a game that builds `THREE.Points` does not start on the default web engine (AC-1 open); the owner hit it on 2026-11-10.
**Complexity:** 6 (MEDIUM) — the Wasm/C++ engine draw path (3), the TypeScript binding and catalog (1), conformance on web and native (2); risk override: none
**Owner:** João
**Depends on:** none
**Closes:** [PRD-789](../ecosystem-absorption/PRD-789-the-other-five-ultra-elements-spells-on-our-engine.md) Phase 2 "gap 13" (the engine draws `Points` with a size)

## Problem

Owner, 2026-11-10: a game preview showed `TN_NATIVE_UNSUPPORTED_POINTSMATERIAL: PointsMaterial is not available on the Wasm engine.` and the game did not run.

The owned engine is the default web and desktop engine. It refuses `Points` and `PointsMaterial` on purpose: `packages/three-native/src/browser-entry.ts` wraps both in `refused()`, and `packages/three-native/api/catalog.json` marks them `unsupported` (`TN_NATIVE_UNSUPPORTED_POINTS`, `TN_NATIVE_UNSUPPORTED_POINTSMATERIAL`). Agents write stars, dust, sparks and debug clouds with `THREE.Points` by habit. Each such game fails at its first frame.

The engine already draws the neighbours: `LineSegments` and `Line` (conformance row `29-line-segments`), `Sprite`, `SpriteMaterial` and `SpriteNodeMaterial` (`packages/runtime-native/src/engine/scene/material.cpp`, `nodes.cpp`, `abi/bindings_material.cpp`), and `InstancedMesh`. Reuse those paths. Do not write a second renderer.

## Target behaviour

The same scene draws the same pixels as upstream three's `WebGPURenderer` within the conformance tolerance:

- `new Points(geometry, new PointsMaterial({ color, size, sizeAttenuation, map, vertexColors, transparent, opacity }))`.
- `PointsNodeMaterial` with `colorNode`, `sizeNode` and `opacityNode`, if the catalog lists it.
- A `BufferGeometry` with a `position` attribute, an optional `color` attribute, and `drawRange`.
- A `position` attribute that the game updates each frame (`needsUpdate`).

What upstream does with `size` on WebGPU decides what we do. Read the three.js source in `node_modules/three` (`PointsNodeMaterial`, the WebGPU `Points` render path) first, and write the result in Phase 1. Do not guess it.

A feature upstream supports and this PRD does not ship keeps a named `TN_NATIVE_UNSUPPORTED_*` diagnostic on that one property. It does not refuse the whole class.

## Phases

### Phase 1 — find the upstream contract and the reuse path

- [x] Write in this PRD what upstream three `WebGPURenderer` does for `Points`: topology or instanced quads, how `size` and `sizeAttenuation` apply, and which `PointsMaterial` and `PointsNodeMaterial` properties change pixels. proof: file and line citations in `node_modules/three` in this box
  **Topology is point-list, and a WebGPU point primitive is one pixel.** Citations (`node_modules/.pnpm/three@0.187.0_patch_hash=…/node_modules/three`, three 0.187.0):
  - `src/renderers/webgpu/utils/WebGPUUtils.js:217` — `getPrimitiveTopology`: `if ( object.isPoints ) return GPUPrimitiveTopology.PointList;`. A Points object is a point-list draw, and the WebGPU spec rasterizes every point primitive at 1x1 pixel whatever the material asks for.
  - `src/materials/nodes/PointsNodeMaterial.js:21-33` — the class doc, verbatim: "By rendering point primitives with {@link Points}. Since WebGPU only supports point primitives with a pixel size of `1`, it's not possible to define a size." and "By rendering point primitives with {@link Sprites}. In this case, size is honored".
  - `src/materials/nodes/PointsNodeMaterial.js:56-60` — `sizeNode`'s doc: "this node has no effect when the material is used with {@link Points} and a WebGPU backend. If an application wants to render points with a size larger than 1 pixel, the material should be used with {@link Sprite} and instancing."
  - `src/materials/nodes/PointsNodeMaterial.js:82-88` — `setupPositionView` is `modelViewMatrix.mul( vec3( positionNode || positionLocal ) ).xyz`: the point *is* the vertex, with no quad offsets. `:164-177` — `setupVertex` takes `super.setupVertex(builder)` when `builder.object.isPoints`; the quad-offset path (`setupVertexSprite`, `:90-162`, which applies `sizeNode`, `sizeAttenuation`, `scaleNode` and the viewport divide) only runs for a Sprite.
  - `src/renderers/webgpu/nodes/StandardNodeLibrary.js:84` — `this.addMaterial( PointsNodeMaterial, 'PointsMaterial' );`: on WebGPU a classic `PointsMaterial` is converted to `PointsNodeMaterial`, so the class a game constructs is irrelevant to the draw.
  **So: one pixel per vertex, and `size` / `sizeAttenuation` change no pixel on the Points path.** A sized point cloud upstream is a `Sprite` (an instanced quad, already drawn on this engine through `shader/sprite.cpp`).
  **Which properties do change pixels** — `src/materials/nodes/NodeMaterial.js:819-916` (`setupDiffuseColor`, the only colour path a PointsNodeMaterial has):
  - `materialColor` (`PointsMaterial.color`) multiplied by `vertexColor()` when `vertexColors === true && geometry.hasAttribute('color')` (`:841`); the attribute's rgb, alpha 1 for a 3-component one.
  - `materialOpacity` (`PointsMaterial.opacity`, `:881`), `alphaTest` as a `discard` cutoff (`:884-901`), `alphaHash` (`:905-908`), and the blend/depth state three's render list reads (`transparent`, `blending`, `depthTest`, `depthWrite`).
  - `PointsMaterial.map` and `.alphaMap` **move no pixel on WebGPU**: no `materialMap` accessor exists at all (`src/nodes/accessors/MaterialNode.js:498-812` lists every material accessor; none samples a map), and `PointsNodeMaterial.js` never reads `this.map`. This engine samples a map through its unlit program when the geometry carries `uv`, so a Points draw drops it (below) to draw the frame upstream draws.
- [x] Write which engine path `Points` reuses (sprite quads, line-list draw, or instanced mesh) and why, with file and line citations in `packages/runtime-native/src/engine/`. proof: the citations in this box
  **It reuses the unlit mesh draw — the same `buildBasic` program and draw encoding the `Line`/`LineSegments` path uses — with `WGPUPrimitiveTopology_PointList`; it writes no second renderer.**
  - `packages/runtime-native/src/engine/scene/nodes.h:143` — `class Points final : public Mesh`: a geometry and a material, exactly what `Line` and `Sprite` are, so the scene graph, culling, records, sorting and disposal are the ones already there.
  - `packages/runtime-native/src/engine/renderer/render_database.cpp:915-916` — Points joins the same `project()` branch as `Mesh`, `Line` and `Sprite`; `:1026-1037` — its draw item takes `d.topology = WGPUPrimitiveTopology_PointList`, `castShadow = false` and no map (upstream samples none).
  - `packages/runtime-native/src/engine/renderer/renderer_program.cpp:144` — `case MaterialKind::Basic: source = vv.sprite ? shader::buildSprite(vv) : shader::buildBasic(vv);`. A Points draw is Basic with `vv.sprite == false`, so it gets `buildBasic` (the unlit program): no quad alignment, the vertex's own clip position, colour x vertex colour x opacity, alpha test, fog.
  - `packages/runtime-native/src/engine/renderer/pipeline_cache.cpp:413` — `desc.primitive.topology = target.topology`, and `:425-431` — depth bias is forced to 0 for a non-triangle topology (Dawn refuses a bias on a point pipeline), so a point pipeline is what the cache already builds for lines.
  - `packages/runtime-native/src/engine/renderer/renderer.cpp:735-741` — the non-indexed draw asks the vertex buffer for `positions.bytes / 12` vertices, so every point in the attribute is one primitive.
  - `packages/runtime-native/src/engine/renderer/geometry_cache.cpp:47-59` creates one GPU buffer per attribute store and `:63-93` uploads a moved `version()` into that same buffer, which is what makes a per-frame `position` rewrite cost no allocation.
  - Why not the sprite quad (`shader/sprite.cpp:24-40` aligns and scales a quad per object): upstream draws one pixel per vertex, not a quad, and `Sprite.count` instantiates one centre rather than reading per-vertex positions. Why not `InstancedMesh`: it needs a per-instance mat4 (64 bytes per point against 12) that the game never authored.
- [x] A conformance scene `conformance/scenes/shared/points.js` draws a coloured, sized, attenuated point cloud and a `vertexColors` cloud, registered in `packages/runtime-native/conformance/registry.json`. It fails on the engine before the fix. proof: `pnpm parity` output with the failing row in this box
  Row `points`, scene `conformance/scenes/shared/points.js`: cloud A is 576 material-coloured points with `size: 6, sizeAttenuation: true`, cloud B is 480 points with a per-vertex hue sweep (`vertexColors: true, transparent: true, opacity: 0.9`). Before the engine fix, with `catalog.json` and `native-registry.json` at `HEAD`:
  `sh scripts/xvfb.sh node packages/runtime-native/conformance/run-conformance.mjs --target web --engine threenative --only-tests points` → `points fail 1.2s` (summary pass 0, fail 1, blocked 154), `browser.error` = `TN_NATIVE_UNSUPPORTED_POINTSMATERIAL: PointsMaterial is not available on the Wasm engine.`, `adapterInfo` `{architecture: turing, vendor: nvidia}`.

### Phase 2 — the engine draws Points

- [ ] `Points`, `PointsMaterial` (and `PointsNodeMaterial` if listed) are `supported` in `catalog.json`, the `refused()` entries are gone, and the class draws through the reused path. proof: `pnpm --filter @threenative/three-native exec vitest run` and `ctest --test-dir build/native-engine -L native-engine` exit 0
- [ ] The points conformance row passes on web Wasm. proof: `pnpm parity` row `points`, mismatch ratio and deltaE in this box, headed `--browser-recipe webgpu`, `adapter.info` checked
- [ ] The points conformance row passes on the desktop host. proof: the native conformance run for row `points` in this box
- [ ] A `position` attribute that changes every frame redraws with no new GPU buffer per frame. proof: a unit or ctest case that counts buffer creations over 60 frames

### Phase 3 — a real game starts

- [ ] A minimal-kit game that adds a `Points` star field starts on the default engine with 0 console errors and 0 runtime diagnostics, and the stars change the pixels. proof: a playtest scenario under `packages/runtime-native/tests/` or the kit fixture, headed `--browser-recipe webgpu`, result in this box
- [ ] The frame cost of 100 000 points stays inside the kit frame budget. proof: `TN_FRAME_BUDGET` presented p95 from that playtest in this box

## Acceptance criteria

- [ ] AC-1 [local]: a game that builds `THREE.Points` with `PointsMaterial` starts on the default web engine and draws the same pixels as upstream three within the conformance tolerance. proof: the Phase 2 and Phase 3 boxes
- [ ] AC-2 [local]: the same scene draws on the desktop host. proof: the Phase 2 desktop box

## Out of scope

- A new particle system. `GPUParticles3D` stays the particle mechanism.
- A look default. The game sets colour, size and texture.
