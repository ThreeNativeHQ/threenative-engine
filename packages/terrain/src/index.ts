export { validateBiome } from "./core/biome.js";
export { BAKE_BIOME_STAGES, bakeBiome } from "./core/bake-biome.js";
export type { IBakeBiomeOptions, IBakeBiomeStage, IBakedBiome } from "./core/bake-biome.js";
export { measureBands } from "./core/bands.js";
export type { IMeasuredBands } from "./core/bands.js";
export type {
  IBiomeSpec,
  IBiomeWaterBody,
  IFarFieldRule,
  IFoliageType,
  IGrassType,
  ILayerInfo,
  ISpawnSpec,
} from "./core/biome.js";
export { Terrain, TerrainEvaluator } from "./core/terrain.js";
export type { OperationOptions, LayerPatch, PatchCommand } from "./core/terrain.js";
export { Mask, MATERIAL_IDS } from "./core/masks.js";
export { landform, landformBackdrop, LANDFORMS } from "./core/presets.js";
export type {
  IBackdropOptions,
  ILandformBackdrop,
  ILandformInfo,
  ILandformOptions,
  LandformKind,
} from "./core/presets.js";
export { terrainStats } from "./core/stats.js";
export type { ITerrainStats } from "./core/stats.js";
export {
  sampleHeight,
  gradientAt,
  slopeAtIndex,
  slopeQuantile,
  splinePoints,
} from "./core/math.js";
export { validateDocument, RESOLUTIONS, PARAMS } from "./core/validation.js";
export { bakeMesh, bakeTerrain } from "./core/bake.js";
export { applyPlacementOverrides, validatePlacementOverrides } from "./core/placements.js";
export {
  encodeRAW16,
  decodeRAW16,
  encodeHeightPNG,
  decodeHeightPNG,
  encodeSplatPNGs,
  encodeGLB,
} from "./core/io.js";
export { encodeZIP, makeExport } from "./core/export.js";
export { bakeWorldPackage } from "./core/world-package.js";
export { createSegmentIndex } from "./core/water.js";
export type { ISegmentIndex, IWaterSegment } from "./core/water.js";
export type * from "./core/types.js";
