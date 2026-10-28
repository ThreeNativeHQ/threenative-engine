/**
 * The `assets.*` key lists this package parses. They live in a module with no imports, so a test
 * in another package can read them without loading the pass chain. The config loader keeps its
 * own copies, and its spec holds the two sets equal.
 */

/** Every `assets.*` key this package parses. The config loader must accept the same set. */
export const ASSETS_CONFIG_KEYS: readonly string[] = [
  "audio",
  "budget",
  "exclude",
  "concurrency",
  "lod",
  "models",
  "nativePackage",
  "source",
  "output",
  "targets",
  "textures",
];

/** Every `assets.models` key this package parses. The config loader must accept the same set. */
export const MODELS_CONFIG_KEYS: readonly string[] = [
  "compact",
  "lightmap",
  "passes",
  "quantize",
  "sharedImages",
  "simplify",
  "textures",
  "virtual",
];

/** Every `assets.models.lightmap` key this package parses. The loader must accept the same set. */
export const LIGHTMAP_CONFIG_KEYS: readonly string[] = ["atlasSize", "padding"];

/** Every `assets.models.passes` key this package parses. The loader must accept the same set. */
export const MODEL_PASS_KEYS: readonly string[] = [
  "dedup",
  "meshopt",
  "prune",
  "quantize",
  "reorder",
  "restTracks",
];

/** Every `assets.models.quantize` key this package parses. The loader must accept the same set. */
export const MODEL_QUANTIZE_KEYS: readonly string[] = ["normalBits", "positionBits", "uvBits"];

/** The `assets.models.virtual` keys that take a positive integer. */
export const MODEL_VIRTUAL_COUNT_KEYS: readonly string[] = [
  "groupSize",
  "maxTriangles",
  "minSourceTriangles",
  "minTriangles",
];

/** Every `assets.models.virtual` key this package parses. The loader must accept the same set. */
export const MODEL_VIRTUAL_KEYS: readonly string[] = [...MODEL_VIRTUAL_COUNT_KEYS, "simplifyRatio"];
