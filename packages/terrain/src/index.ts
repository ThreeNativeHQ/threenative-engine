export { validateBiome } from "./biome/biome.js";
export { BAKE_BIOME_STAGES, bakeBiome } from "./biome/bake-biome.js";
export type { IBakeBiomeOptions, IBakeBiomeStage, IBakedBiome } from "./biome/bake-biome.js";
export { measureBands } from "./biome/bands.js";
export type { IMeasuredBands } from "./biome/bands.js";
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
} from "./biome/biome.js";
export { MATS_FIELD, STAND_FIELD, fieldWeight } from "./population/cover-field.js";
export type { ICoverField } from "./population/cover-field.js";
export { collarSampler, farForestPlacements } from "./package/far-field.js";
export type { IFarFieldOptions } from "./package/far-field.js";
export { orderedScatterRules, scatterProps } from "./population/scatter-ordered.js";
export type {
  CoverFieldName,
  ICoverFieldDrift,
  IOrderedScatter,
  IOrderedScatterField,
  IOrderedScatterRules,
} from "./population/scatter-ordered.js";
export { Terrain, TerrainEvaluator } from "./core/terrain.js";
export type { OperationOptions, LayerPatch, PatchCommand } from "./core/terrain.js";
export { Mask, MATERIAL_IDS } from "./core/masks.js";
export { landform, landformBackdrop, LANDFORMS } from "./ground/presets.js";
export { liftMassif, placeMassif } from "./ground/massif.js";
export type { IMassifPlacement, IMassifTile, IPlaceMassifOptions } from "./ground/massif.js";
export type {
  IBackdropOptions,
  ILandformBackdrop,
  ILandformInfo,
  ILandformOptions,
  LandformKind,
} from "./ground/presets.js";
export { terrainStats } from "./core/stats.js";
export type { ITerrainStats } from "./core/stats.js";
export { grassFieldFromBiome } from "./population/grass-field.js";
export type { IGrassFieldPlacement, IGrassGround } from "./population/grass-field.js";
export {
  sampleHeight,
  gradientAt,
  slopeAtIndex,
  slopeQuantile,
  splinePoints,
} from "./core/math.js";
export { validateDocument, RESOLUTIONS, PARAMS } from "./core/validation.js";
export { bakeMesh, bakeTerrain } from "./package/bake.js";
export { applyPlacementOverrides, validatePlacementOverrides } from "./population/placements.js";
export {
  encodeRAW16,
  decodeRAW16,
  encodeHeightPNG,
  decodeHeightPNG,
  encodeSplatPNGs,
  encodeGLB,
} from "./core/io.js";
export { encodeZIP, makeExport } from "./package/export.js";
export { bakeWorldPackage } from "./package/world-package.js";
export {
  PROP_CELL_SIZE,
  compilePropBuckets,
  decodePropBucket,
  propAssetOf,
  propPackageFile,
  propPackageFiles,
} from "./package/prop-package.js";
export type {
  ICompilePropBucketsOptions,
  IPropBucketEntry,
  IPropBucketKind,
  IPropBucketPackage,
  IPropBucketRecord,
  IPropPackage,
  IPropPackageFiles,
} from "./package/prop-package.js";
export { createSegmentIndex } from "./water/water.js";
export type { ISegmentIndex, IWaterSegment } from "./water/water.js";
export type * from "./core/types.js";
