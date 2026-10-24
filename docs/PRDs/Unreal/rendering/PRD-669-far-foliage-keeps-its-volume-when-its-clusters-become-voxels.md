---
prd_contract: v1
---

# PRD-669 — Far foliage keeps its volume when its clusters become voxels

**Status:** NOT STARTED
**Priority:** P3 — Phase 1 is an unbuilt coverage gate. Far trees draw as octahedral impostors today, and a fresh Unreal project leaves voxels off.
**Complexity:** 7 (HIGH) — 1–5 implementation files (+1), a voxel step inside the cluster bake changes the bake output and its cache version (+2), a brick draw that marches a bit mask is a new GPU path (+2), a visual judge (+1), native proof on the owned host (+1); risk override: none
**Owner:** João
**Depends on:** None. Builds on the cluster DAG bake (`packages/assets/src/virtual/dag.ts`) and `ClusteredMesh`. Uses [PRD-600](PRD-600-a-clustered-mesh-submits-only-the-clusters-the-view-holds.md)'s view-pruned walk when it has shipped (optional). Coordinates with `docs/PRDs/Unreal/shadows/PRD-651-leaves-cast-leaf-shadows-that-sway-near-the-camera.md` (on `origin/feat/unreal-look-epic`), which owns how leaf cards cast.

## Context

**Unreal size.** Voxels live inside Nanite (55,672 lines in the feature map). The runtime part is
about 2,700 lines (`Engine/Shaders/Private/Nanite/Voxel/`, `NaniteSVO.ush`, `Voxel.cpp`, `Voxel.h`),
and the builder adds the voxelize step in `Cluster.cpp` and `ClusterDAG.cpp`. A ThreeNative port is
about 500 TypeScript lines for the bake, about 350 for the draw, and about 250 C++ lines for the
owned host.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **Off in a fresh project.** `r.Nanite.Foliage` and `r.Nanite.AllowVoxels` both default to 0 and
  are read-only (`UE 5.8.3: Engine/Source/Runtime/Engine/Private/Rendering/NaniteResources.cpp:118-134`).
  Voxels are supported only when one of them is set
  (`Engine/Source/Runtime/RenderCore/Private/RenderUtils.cpp:1379-1386`).
- **A mesh opts in by its shape-preservation mode.** The modes are `None`, `PreserveArea` and
  `Voxelize`. The help text says that `Voxelize` keeps the perceived volume of foliage that thins
  out otherwise (`Engine/Source/Runtime/Engine/Classes/Engine/EngineTypes.h:3266-3274`). The
  default is `None`, and `VoxelLevel` defaults to 0 (`EngineTypes.h:3314-3315`, `:3371-3372`).
- **The bake picks voxels per cluster group.** When a group is reduced to its parent level, the
  builder estimates a voxel size from the group area and three quarters of its vertex count. It
  shrinks that size by 0.75 and never lets it fall below the parent error. It then voxelizes the
  children and grows the size by 10% until the voxel and brick counts fit the targets. Voxels
  replace triangles only when the voxel size stays below the error of plain triangle
  simplification (`Engine/Source/Developer/NaniteBuilder/Private/ClusterDAG.cpp:1455-1546`).
- **Voxels pack into bricks.** A brick holds a 64-bit occupancy mask, so one brick is 4×4×4 voxels,
  plus a position and a vertex offset (`Engine/Source/Developer/NaniteBuilder/Private/Cluster.h:295-300`,
  `Cluster.cpp:1604`, `:2157`).
- **The rasterizer traces bricks.** Each covered pixel traces its view ray through the brick mask
  (`Engine/Shaders/Private/Nanite/NaniteRasterizer.usf:51-52`, `:1121-1200`). A brick draw also
  exists as a vertex and pixel shader pair (`Engine/Shaders/Private/Nanite/Voxel/RasterizeBricks.usf:26`, `:150`).

### ThreeNative today

- Far trees draw as engine-baked octahedral impostors. `WorldImpostorBaker` bakes a full-sphere
  view grid (`packages/core/src/render/world-impostor.ts`), and `WorldImpostorSurface` draws it
  (`packages/core/src/render/world-impostor-surface.ts`). `WorldCells` wires both
  (`packages/core/src/world-cells.ts:49-61`). The strata forest turns them on
  (`packages/terrain/starter/forest/world.ts:128-129`).
- An impostor is baked from the full mesh, so it keeps the silhouette by construction. It costs
  atlas memory per species, and it flattens parallax and self-shadowing up close to its band.
- Alpha coverage across mips is held by `mipAlphaTestNode` (`packages/core/src/render/foliage-alpha.ts`,
  `MIP_ALPHA_SCALE` 0.25).
- The cluster DAG bake simplifies by position only (`packages/assets/src/virtual/dag.ts`). A
  foliage asset that goes through it loses leaves at coarse levels. No foliage asset uses
  `ClusteredMesh` today.

## Solution

| Unreal part | ThreeNative module | Layer |
| --- | --- | --- |
| Voxel-or-triangle choice per group (`ClusterDAG.cpp:1455-1546`) | the same rule in `buildClusterDag`, behind a `shapePreservation: "voxelize"` bake option | assets bake |
| Bricks, 64-bit masks (`Cluster.h:295-300`) | a brick table in the baked cluster file: position, two 32-bit mask words, an average base colour per voxel taken from the source texture | assets bake |
| Brick trace (`NaniteRasterizer.usf:1121-1200`) | one instanced box per brick. The fragment stage marches the 4×4×4 mask and writes depth | core mechanism, `packages/core/src/clustered-mesh.ts` |
| Shading | the game's material lights the voxel colour through a TSL `colorNode` the template passes | template look |

- **Auto by default.** The voxel size, the level where voxels start and the brick budget come from
  the bake rule above. The bake turns voxels on for an asset that its import marks as foliage
  (alpha-cut leaves). A named `shapePreservation` override turns it on or off per asset. The bake
  report names the choice and the reason.
- **The impostor path stays.** This PRD does not remove impostors. Phase 1 decides which far
  representation a foliage asset should use.

Risks:

- A brick draw writes depth from the fragment stage. That disables early depth test for those
  fragments. Phase 3 measures the cost.
- Voxel colour from an averaged texture can shift hue. The visual judge checks it.

## Acceptance Criteria

- [ ] AC-1 [local]: At the far band of the strata forest, the voxel fir is judged NEUTRAL or IMPROVEMENT against the impostor fir, and it keeps at least 95% of the full mesh's screen coverage. proof: headed `--browser-recipe webgpu` captures, before and after, two runs each, fresh visual-judge subagent — Evidence: pending.
- [ ] AC-2 [local]: The voxel far band costs no more GPU time than the impostor band at 1080p on the RTX 2080 browser WebGPU lane. proof: `node packages/playtest/dist/runner/cli.js perf`, voxel against impostor — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Voxel clusters | `packages/terrain/starter/forest/world.ts` fir → bake with `shapePreservation: "voxelize"` → `ClusteredMesh` brick draw | Candidate to replace the impostor band for firs only if AC-1 and AC-2 pass. Otherwise impostors stay | Phase 1, AC-1 |

## Decisions

- 2026-10-21 (filing): Deferred, not declined, under the owner rule of 2026-10-21. Voxels are off in a fresh Unreal 5.8.3 project, and impostors already keep far silhouettes. The revisit condition is a Phase 1 coverage loss above 5% for impostors or for the cluster DAG, or a game that draws dense foliage through `ClusteredMesh`.

## Execution Phases

#### Phase 1: Measure far coverage before building voxels
**Status:** NOT STARTED
**Files:** `examples/strata-terrain-preview/scripts/foliage-coverage.ts` (new), `packages/assets/src/virtual/dag.ts` (read-only use)
- [ ] One fir renders at 8 distances as the full mesh, the impostor and the cluster DAG cut, and the script prints the screen coverage of each against the full mesh. proof: `pnpm --filter strata-terrain-preview exec tsx scripts/foliage-coverage.ts`.
- [ ] The gate verdict is written under `## Decisions`: continue only if the impostor or the cluster cut loses more than 5% coverage at any distance. proof: the Phase 1 table in this PRD.

#### Phase 2: The bake makes bricks
**Status:** NOT STARTED
**Files:** `packages/assets/src/virtual/dag.ts`, `packages/assets/__tests__/virtual-dag.spec.ts`
- [ ] A group takes voxels only when the voxel size stays below the triangle error, and the size starts at the area rule and grows by 10% until the counts fit. proof: `pnpm exec vitest run packages/assets/__tests__/virtual-dag.spec.ts`.
- [ ] Bricks round-trip through the baked file with their masks and colours, and the bake cache version moves. proof: `pnpm exec vitest run packages/assets/__tests__/virtual-dag.spec.ts`.

#### Phase 3: Bricks draw on the web and the owned host
**Status:** NOT STARTED
**Files:** `packages/core/src/clustered-mesh.ts`, `packages/core/__tests__/clustered-mesh.spec.ts`, `packages/runtime-native/conformance/scenes/shared/voxel-bricks.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The brick march hits the same voxels as a CPU reference for 64 fixed rays. proof: `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts`.
- [ ] The far fir renders as voxels on browser WebGPU. proof: AC-1 visual judge and AC-2 perf run.
- [ ] The desktop host draws the brick fixture within the conformance tolerance. proof: `pnpm parity --target desktop --only-tests voxel-bricks`.
