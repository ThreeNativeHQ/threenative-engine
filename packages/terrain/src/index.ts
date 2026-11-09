export { validateBiome } from "./core/biome.js";
export { BAKE_BIOME_STAGES, bakeBiome } from "./core/bake-biome.js";
export type { IBakeBiomeOptions, IBakeBiomeStage, IBakedBiome } from "./core/bake-biome.js";
export { measureBands } from "./core/bands.js";
export type { IMeasuredBands } from "./core/bands.js";
export type {
  CoverGround,
  IBiomeSpec,
  IBiomeWaterBody,
  ICoverDriftRow,
  ICoverSpec,
  IFarFieldRule,
  IFoliageType,
  IGrassType,
  ILayerInfo,
  ISpawnSpec,
  IUnderstoreySpec,
} from "./core/biome.js";
export { MATS_FIELD, STAND_FIELD, fieldWeight } from "./core/cover-field.js";
export type { ICoverField } from "./core/cover-field.js";
export { collarSampler, farForestPlacements } from "./core/far-field.js";
export type { IFarFieldOptions } from "./core/far-field.js";
export { orderedScatterRules, scatterProps } from "./core/scatter-ordered.js";
export type {
  CoverFieldName,
  ICoverFieldDrift,
  IOrderedScatter,
  IOrderedScatterField,
  IOrderedScatterRules,
} from "./core/scatter-ordered.js";
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
export {
  PROP_CELL_SIZE,
  compilePropBuckets,
  decodePropBucket,
  propAssetOf,
  propPackageFile,
  propPackageFiles,
} from "./core/prop-package.js";
export type {
  ICompilePropBucketsOptions,
  IPropBucketEntry,
  IPropBucketKind,
  IPropBucketPackage,
  IPropBucketRecord,
  IPropPackage,
  IPropPackageFiles,
} from "./core/prop-package.js";
export { createSegmentIndex } from "./core/water.js";
export type { ISegmentIndex, IWaterSegment } from "./core/water.js";
export type * from "./core/types.js";
