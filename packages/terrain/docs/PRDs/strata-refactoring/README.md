# Strata refactoring

**Status:** PARTIAL — 5 of 9 PRDs closed (filed 2026-11-04; PRD-793 to 797 are in `done/`). Open: PRD-791 and PRD-792 (the web and loop playtest box each) and PRD-798 and PRD-799 (the Strata and abyss playtests, and AC-1 of PRD-798 reopened). Per PRD:

- **PRD-791** — code complete and the five-world visual judge passed (AC-4, 2026-11-05); one box stays
  open: the web and loop playtest (loop half green, terrain half red at the engine bundle bug fixed in
  `4103d2508`, waiting for a Wasm build). One data divergence found later: `coastal`'s snow `shedFrom` is `0.16` in the look and `0.04`
  in its biome file; the file's value never reached a pixel and the pair needs a judged decision.
- **PRD-792** — Phase 1 done; Phase 2 done (2026-11-05): the bake writes per-bucket prop packages, the game loads them through `WorldCells`, `propStreaming.ts`/`placements.ts` are deleted. AC-3, the five-world judge, passed (2026-11-05). Open: the web and loop playtest box, same blocker as PRD-791, and AC-2's named residual (the far field and the vista meadow still compile at load).
- **PRD-793** — DONE (2026-11-05), moved to `done/`: all 35 landform×biome pairs cook; `terrain_generate`
  takes `biome` (a starter's name, one of its alias words or an inline spec) with `landform`,
  `sizeMeters`, `seed` and `water`; and `terrain_biome_new` makes and cooks a `savanna` in one call
  that writes only under `<assets.source>/biomes/savanna/` (cook 2 982 ms, under the 3 839 ms forest
  baseline). The sandbox arm and AC-4's judge are done too (the verdict text is in the AC-4 box; no judge report file is stored).
- **PRD-794** — CHARTER line approved (owner, 2026-11-04); `WaterBodies` ships in core and the example uses it. Done 2026-11-05: the water judge passed (AC-3), moved to done/.
- **PRD-795** — DONE (2026-11-05): `HeightfieldCollar` and `surfaceAt` in core, edge/vista/walk green on the owned engine, horizon judge PASS; moved to `done/`.
- **PRD-796** — DONE (2026-11-05): `game.ts` is wiring, every box ticked; moved to `done/`.
- **PRD-797** — DONE by its own boxes: four seams pinned, the `world.ts` ↔ `world-tiles.ts` cycle
  gone, four leaf modules extracted (3 416 → 2 254, AC-1 narrowed to 2 300 by decision), and the
  terrain-splat playtest green on the web lane (2026-11-05: exit 0, 180 frames, 8/8 assertions, real
  Nvidia adapter). The 1 500-line target is the follow-up that splits `TerrainTiles` itself.
- **PRD-798** — Phases 1 and 2 done and the Phase 3 split done: the flag readers and `CellRender` are pinned and both files
  split under the cap. AC-3's abyss half is measured (browser 22 of 23 assertions, native host 21 of
  22). AC-4's forest judge passed. Open: AC-1 (reopened 2026-11-05: existing world specs changed, two of them in assertions), AC-3's Strata half and the Phase 3 playtest box.
- **PRD-799** — Phases 1 and 2 done: two pin specs landed and the five modules are extracted
  (`world-cells.ts` 2 977 → 1 454). AC-3's abyss half is measured on the native host (21 of 22
  assertions; the one red is the network policy, not the world). Open: the Strata half.

## Where the hardcode is (audit of `aa3883d7d` plus the forest lane's uncommitted edits, 2026-11-04)

- **142 world-name comparisons** in `examples/strata-terrain-preview/src/`: `render/pack.ts` 45,
  `render/terrain.ts` 33, `game.ts` 24, `render/propMaterials.ts` 14, `render/scatter.ts` 13,
  `render/biomes.ts` 8, `render/sky.ts` 5. A sixth biome needs a branch in each; a missed branch draws
  another world's fallback without an error.
- **The MCP knows five names.** `TERRAIN_KITS` (`packages/terrain/src/mcp/tools.ts:9`) is a closed
  enum, and `terrain_generate` maps every request to one of the five starter kits. The seven
  `LANDFORMS` (`packages/terrain/src/core/presets.ts:39`) never reach it.
- **The example duplicates the package.** `render/propStreaming.ts` and `render/placements.ts`
  re-implement `bakeWorldPackage`, `placementCells` and `writePlacementRecord`
  (`packages/terrain/src/core/world-package.ts`); `render/scatter.ts` and `render/farForest.ts` keep
  scatter rules as code while `IScatterParams` (`packages/terrain/src/core/types.ts`) exists;
  `world/water.ts` is a linear scan beside `createSegmentIndex`; `render/ocean.ts` and
  `packages/terrain/starter/coastal/sea.ts` differ on 143 lines; `preparePose` re-derives `GroundSnap`.
- **Four core files near or over 3 000 lines**: `world-tiles.ts` 3 416 (it was 2 880 when PRD-595
  closed its AC-2), `world-cells.ts` 2 977, `world-gpu-scene.ts` 2 895, `world-cell-render.ts` 2 875.
  `CellRender` has no direct unit test.

## What `@threenative/terrain` gains

The package stays authoring and bake only: it runs before play and owns no look. Everything below
is either schema (no values) or bake-time code.

| Abstraction | Today | PRD |
|---|---|---|
| `IBiomeSpec`, `validateBiome` | `BIOMES`, `SCATTER`, `FAR_FOREST_RULES`, species lists and spawn points as code in the example | PRD-791 |
| `IFoliageType`, `IGrassType`, `ILayerInfo`, `IWaterBody` rows | 142 world-name branches | PRD-791 |
| `bakeBiome` | The example's 655-line `scripts/bake.mjs` | PRD-792 |
| Scatter stages `surfaceSample`, `densityFilter`, `selfPrune`, `meshSpawn` | `render/scatter.ts` and `render/farForest.ts` rules; `IScatterParams` unused | PRD-792 |
| `layerWeights(layers, height, slope)` and `measureBiome` on `terrainStats` | `biomeWeights`, `elevationBand`, `measureBiome` in `render/biomes.ts` (the TSL twin stays in the game) | PRD-792 |
| Placement package for the game | Runtime copy in `render/propStreaming.ts` and `render/placements.ts` of `bakeWorldPackage` | PRD-792 |
| Water-body bake: ribbons, lake footprints, ocean level, terrain carve | `render/river.ts` geometry, `world/water.ts`, three starter `water.ts`/`sea.ts` copies | PRD-794 |
| Open `terrain_generate`, new `terrain_biome_new` | `TERRAIN_KITS`, five fixed names | PRD-793 |

Not moved, with the reason:

- **Editor view** (`render/editorView.ts` 1 223, `selection.ts`, `environmentImages.ts`, `imports.ts`):
  it already implements the package's `IEditorView` contract, and its shading is game look. No second
  game mounts the editor. Revisit when a second game or the MCP needs a mountable editor.
- **Mesh preparation** in `render/pack.ts` (`scaleGeometry`, `repairNormals`, centring): asset work,
  so it belongs in `@threenative/assets`, and `preparePose` uses core `GroundSnap` (PRD-792 Phase 2).
- **Materials, TSL, sky, ocean shading, spruce and cover art**: appearance, so they stay in game
  `src/render/` or the copy-out starter files.

## PRDs, in execution order

| Order | Priority | PRD | Outcome |
|---|---|---|---|
| 1 | P1 | [PRD-791](../../../../../docs/PRDs/done/PRD-791-a-biome-is-a-validated-data-file.md) | A biome is one validated `biome.json`, read by the MCP and the game |
| 2 | P1 | [PRD-792](../../../../../docs/PRDs/done/PRD-792-one-bake-for-every-biome.md) | One `bakeBiome` in `@threenative/terrain`; the example stops re-implementing it |
| 3 | P1 | [PRD-793](../../../../../docs/PRDs/done/PRD-793-the-terrain-mcp-answers-any-terrain-request.md) | The MCP takes any landform and biome, and makes a new biome in one call |
| 4 | P2 | [PRD-794](../../../../../docs/PRDs/done/PRD-794-river-lake-and-ocean-are-one-water-body-mechanism.md) | River, lake and ocean are one water-body mechanism |
| 5 | P2 | [PRD-795](../../../../../docs/PRDs/done/PRD-795-the-far-ring-and-ground-queries-read-the-heightfield.md) | The far ring and ground queries read the heightfield, not world names |
| 6 | P2 | [PRD-796](../../../../../docs/PRDs/done/PRD-796-strata-game-ts-is-wiring-not-a-world-switch.md) | Strata `game.ts` is wiring, not a world switch |
| 7 | P2 | [PRD-797](../../../../../docs/PRDs/done/PRD-797-world-tiles-splits-by-seam.md) | `world-tiles.ts` splits by seam |
| 8 | P2 | [PRD-798](PRD-798-world-gpu-scene-and-cell-render-split-with-pins.md) | `world-gpu-scene.ts` and `world-cell-render.ts` split, with `CellRender` pins |
| 9 | P2 | [PRD-799](../../../../../docs/PRDs/done/PRD-799-world-cells-second-split.md) | `world-cells.ts` second split |

PRDs 797 to 799 touch no Strata file and may run in parallel with 791 to 796. PRD-798 and PRD-799
wait for the forest lane to commit its edits to `world-cell-render.ts`, `world-gpu-scene.ts`,
`world-cells.ts` and `world-cell-data.ts`.

## Relation to the Strata epic (PR #483)

- [PRD-790](../P2/PRD-790-a-new-biome-is-a-data-row-and-the-world-streams-past-one-square.md)
  Phase 1 (biome rows, 0 branches, fail-closed field) is the game half of PRD-791. PRD-791 moves the
  schema into `@threenative/terrain` so the MCP can read it; PRD-790 Phase 2 (streaming) and Phase 3
  (a sixth biome) stay there.
- [PRD-591](../P2/PRD-591-the-preview-stops-reimplementing-engine-mechanisms.md)
  AC-4 (measured height bands) feeds the band fields of `ILayerInfo`.
- [PRD-595](../P2/PRD-595-world-cells-splits-by-seam-and-survives-a-race-fuzz.md)
  did the first `world-cells.ts` split; PRD-799 is the second and waits for its AC-3.

## Names borrowed from Unreal

Names only, plus the data layout where a row says so. This batch ports no Unreal feature, so the
feature map is unchanged. ThreeNative drops the `U`/`A`/`F` prefix and adds `I` to interfaces. Godot
stays the only source of node names; these are data and mechanism names.

| ThreeNative name | Unreal reference | Lives in |
|---|---|---|
| `IBiomeSpec`, `validateBiome` | PCG Biome Core, "PCG Biome Creation Tool": `UE 5.8.3: Engine/Plugins/Experimental/PCGBiomeCore/PCGBiomeCore.uplugin:6` | `@threenative/terrain` |
| `IFoliageType` (species, density, slope and height intervals, collision) | `UFoliageType`: `UE 5.8.3: Engine/Source/Runtime/Foliage/Public/FoliageType.h:105`; `Density` `:151`, `GroundSlopeAngle` `:240`, `Height` `:244`, `BodyInstance` `:375` | `@threenative/terrain` |
| `IGrassType` (ground cover per layer) | `ULandscapeGrassType`: `UE 5.8.3: Engine/Source/Runtime/Landscape/Classes/LandscapeGrassType.h:171`; `GrassDensity` `:45`, `StartCullDistance` `:59` | `@threenative/terrain` |
| `ILayerInfo` (height and slope band of one ground layer) | `ULandscapeLayerInfoObject`: `UE 5.8.3: Engine/Source/Runtime/Landscape/Classes/LandscapeLayerInfoObject.h:59` | `@threenative/terrain` |
| Scatter stages `surfaceSample`, `densityFilter`, `selfPrune`, `meshSpawn` | PCG elements `UPCGDensityFilterSettings` (`Engine/Plugins/PCG/Source/PCG/Public/Elements/PCGDensityFilter.h:10`), `UPCGSelfPruningSettings` (`PCGSelfPruning.h:127`), `UPCGStaticMeshSpawnerSettings` (`PCGStaticMeshSpawner.h:27`), and `PCGSurfaceSampler.h` | `@threenative/terrain` bake |
| `IWaterBody` (`river`, `lake`, `ocean`), `WaterBodies` | `AWaterBody` `WaterBodyActor.h:47`, `AWaterBodyRiver` `WaterBodyRiverActor.h:28`, `AWaterBodyLake` `WaterBodyLakeActor.h:33`, `AWaterBodyOcean` `WaterBodyOceanActor.h:30`, carve curve `FWaterCurveSettings` `WaterBodyComponent.h:597` (all `UE 5.8.3: Engine/Plugins/Experimental/Water/Source/Runtime/Public/`) | schema in `@threenative/terrain`, query in `@threenative/core/world` |
| `Heightfield.surfaceAt` (triangle-exact, same as the collider) | `ULandscapeHeightfieldCollisionComponent`: `UE 5.8.3: Engine/Source/Runtime/Landscape/Classes/LandscapeHeightfieldCollisionComponent.h:41` | `@threenative/core/world` |
| `HeightfieldCollar` (the far ring past the playable square) | `ALandscapeMeshProxyActor`: `UE 5.8.3: Engine/Source/Runtime/Landscape/Classes/LandscapeMeshProxyActor.h:11`; `UHLODLayer`: `Engine/Source/Runtime/Engine/Public/WorldPartition/HLOD/HLODLayer.h:53` | `@threenative/core/world` |
| `world-tile-lod.ts`, `world-tile-stitch.ts` | `FLandscapeRenderSystem`: `UE 5.8.3: Engine/Source/Runtime/Landscape/Public/LandscapeRender.h:448`; `ULandscapeComponent`: `Engine/Source/Runtime/Landscape/Classes/LandscapeComponent.h:431` | `packages/core/src/` |
| `world-gpu-culling` pieces of `WorldGpuScene` | `FGPUScene`: `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/GPUScene.h:218`; `FInstanceCullingContext`: `Engine/Source/Runtime/Renderer/Public/InstanceCulling/InstanceCullingContext.h:75` | `packages/core/src/` |
| `world-cell-residency.ts`, follow source | `UWorldPartitionRuntimeCell`: `UE 5.8.3: Engine/Source/Runtime/Engine/Public/WorldPartition/WorldPartitionRuntimeCell.h:236`; `FWorldPartitionStreamingSource`: `WorldPartitionStreamingSource.h:341` | `packages/core/src/` |
