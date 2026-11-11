# PRD-871: The owned engine draws Points

**Status:** NOT STARTED
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

- [ ] Write in this PRD what upstream three `WebGPURenderer` does for `Points`: topology or instanced quads, how `size` and `sizeAttenuation` apply, and which `PointsMaterial` and `PointsNodeMaterial` properties change pixels. proof: file and line citations in `node_modules/three` in this box
- [ ] Write which engine path `Points` reuses (sprite quads, line-list draw, or instanced mesh) and why, with file and line citations in `packages/runtime-native/src/engine/`. proof: the citations in this box
- [ ] A conformance scene `conformance/scenes/shared/points.js` draws a coloured, sized, attenuated point cloud and a `vertexColors` cloud, registered in `packages/runtime-native/conformance/registry.json`. It fails on the engine before the fix. proof: `pnpm parity` output with the failing row in this box

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
