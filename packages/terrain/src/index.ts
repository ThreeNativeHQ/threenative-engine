export { Terrain, TerrainEvaluator } from "./core/terrain.js";
export type { OperationOptions, LayerPatch, PatchCommand } from "./core/terrain.js";
export { Mask, MATERIAL_IDS } from "./core/masks.js";
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
