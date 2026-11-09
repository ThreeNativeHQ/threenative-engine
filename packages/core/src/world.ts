export * from "./world-heightfield.js";

export { HeightfieldCollar } from "./world-collar.js";
export type {
  IHeightfieldCollarOptions,
  IHeightfieldCollarQuad,
  IHeightfieldCollarSite,
  IHeightfieldCollarWalk,
} from "./world-collar.js";

export {
  WATER_RIBBON_REACH,
  WaterBodies,
  lakeReach,
  waterlineRadius,
} from "./world-water-bodies.js";
export type {
  IWaterBodiesOptions,
  IWaterCurrent,
  IWaterFootprint,
  IWaterLake,
  IWaterOcean,
  IWaterRibbon,
  WaterBodyKind,
} from "./world-water-bodies.js";
export { lakeSurfaceGeometry, riverRibbonGeometry } from "./world-river-ribbon.js";
export type { ILakeSurfaceOptions, IRiverRibbonOptions } from "./world-river-ribbon.js";

export { TerrainTiles } from "./world-tiles.js";
export type {
  IAdmissionBudget,
  IWorldTileColliderInput,
  IWorldTilesTopologyObservation,
} from "./world-tiles.js";

export {
  TERRAIN_VALIDATE_FLAG,
  TERRAIN_VALIDATE_MARKER,
  terrainValidationRequested,
} from "./world-validate.js";

export { getWorldCapabilities } from "./world-capabilities.js";
export type { IWorldCapabilities } from "./world-capabilities.js";

export { cellPlacements, validateWorldPackage } from "./world-package.js";
export type {
  IWorldAsset,
  IWorldAssetBounds,
  IWorldAssetLod,
  IWorldCell,
  IWorldCellProxy,
  IWorldExtent,
  IWorldPackage,
  IWorldPackageError,
  IWorldPackageValidationOptions,
  IWorldRun,
  IWorldTerrain,
  WorldPackageErrorCode,
} from "./world-package.js";

export { SnowField, snowDiscFootprint } from "./snow-field.js";
export type {
  ISnowContact,
  ISnowFieldOptions,
  ISnowFieldSample,
  ISnowFootprint,
  ISnowFootprintSample,
} from "./snow-field.js";

export { heightSamplerFromHeightmap, loadWorldHeightmap } from "./world-heightmap.js";
export { applyTerrainSurface, loadTerrainSplat } from "./world-terrain-splat.js";
export {
  bakedFractalNoise,
  bakedNoise,
  NOISE_PERIOD,
  NOISE_TEXELS,
  noiseVolume,
} from "./world-noise.js";
export type {
  ILoadTerrainSplatOptions,
  ITerrainSplatLayer,
  ITerrainSplatMaskedLayer,
  ITerrainSplatTable,
  ITerrainSplatWeightContext,
  ITerrainSplatSampleContext,
  ITerrainSplatSample,
  ITerrainSplatMaterialContext,
} from "./world-terrain-splat.js";

export { WorldCells } from "./world-cells.js";
export { instanceRandom } from "./render/world-impostor-surface.js";
export type {
  IShadowRegion,
  IWorldCellsBudget,
  IWorldCellsFollow,
  IWorldCellsLoadOptions,
  IWorldCellsStats,
  IWorldCellsTerrainOptions,
  IWorldRegionReadiness,
} from "./world-cells.js";
export type { IWorldGpuFrameValidation } from "./world-gpu-scene.js";
