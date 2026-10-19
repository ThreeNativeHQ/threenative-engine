# PRD-521 — WorldCells and WorldTiles run native (N13b)

**Status:** PROPOSED
**Priority:** P2 — Wave 5, which CP1 gates: WorldCells and WorldTiles run native; 6 open boxes.
**Complexity:** 5 — the largest framework subsystem to port (cells, tiles, chunk merging, terrain, GPU-scene residency), with a deep spec suite to keep
**Owner:** João
**Work package:** N13 — [native-engine batch](../README.md) · [N13 umbrella](README.md)
**Depends on:** [PRD-520 (N13a)](PRD-520-n13a-bounded-streaming-admission-and-io-events.md), [PRD-519 (N12)](../PRD-519-n12-native-batching-visibility-lod-gpu-scene.md)

## Context

§11.3 says WorldCells, WorldTiles and GPU-scene streaming cannot stay hidden TypeScript engine implementations in a native-engine build. The required systems are ported and their TS packages become bindings. Today: `packages/core/src/world-cells.ts` (merged chunk groups, the 4 MiB first-draw cap, chain LOD, shadow prewarm), `packages/core/src/world-tiles.ts` (tiles, colliders, admission), `packages/core/src/world-gpu-scene.ts` (placement buffer and residency), `packages/core/src/world-package.ts` (`world.json` v1 manifest), `packages/core/src/world.ts` and `world-heightmap.ts` (the shared height buffer), and `packages/core/src/world-terrain-splat.ts`. Specs: `packages/core/__tests__/world-*.spec.ts`. The cooker is `packages/assets/src/world/`. §3 (R4) notes that per-object refresh, WorldCells streaming and shadow work are measured costs today.

## Solution

1. **World package reader.** The `world.json` v1 contract is validated natively with the same error codes as `world-validate.ts`. Cooked world content comes from the N10 package format.
2. **Cells and tiles.** Proposed `packages/runtime-native/src/engine/world/cells/` and `.../tiles/`. Residency by camera distance, chunk merging under the byte cap, chain LOD and shadow prewarm are ported rule for rule. Admission goes through PRD-520.
3. **Terrain and heights.** One native height buffer serves world queries, rendered geometry and the Rapier heightfield (N15). Its sample version bumps on `updateHeights`.
4. **GPU-scene residency.** The placement buffer is written natively when residency changes. Selection runs on the PRD-519 GPU kernel.
5. **Bindings.** `world-cells.ts`, `world-tiles.ts` and `world-gpu-scene.ts` become thin binding glue in the native profile, and the legacy backend keeps the TS (rollback). A native-engine build that reaches a TS world algorithm fails the artifact inspection (§15.2).

## Out of scope

- Virtual shadows and probes inside the world: [N14](../N14-native-render-chain-and-advanced-visuals/README.md)
- The end-to-end walk and memory proof: [PRD-522 (N13c)](PRD-522-n13c-a-world-loads-walks-and-unloads-without-growth.md)

## Execution Phases

#### Phase 1: Package and terrain
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/world/package/`, `.../terrain/`
- [ ] Native `world.json` validation accepts and rejects the `world-package.spec.ts` fixtures with the same codes. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_world_package`
- [ ] Native height sampling matches `world-heightmap.spec.ts` fixtures, and `updateHeights` bumps the sample version. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_world_heights`

#### Phase 2: Cells and tiles
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/world/cells/`, `.../tiles/`
- [ ] Residency, chunk merge under the byte cap and chain LOD decisions match the `world-cells*.spec.ts` fixtures. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_world_cells`
- [ ] Tile admission and collider placement match the `world-terrain-tiles.spec.ts` and `world-tiles-cost.spec.ts` fixtures. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_world_tiles`

#### Phase 3: GPU-scene residency and bindings
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/src/engine/world/gpu_scene/`; `packages/core/src/world-cells.ts`, `world-tiles.ts`, `world-gpu-scene.ts` (binding glue)
- [ ] The placement buffer after a scripted camera path matches the `world-gpu-scene.spec.ts` reference. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_world_gpu_scene`
- [ ] The native-engine artifact inspection finds no TS world implementation reachable from the world fixture. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_strict_artifact_inspect`
