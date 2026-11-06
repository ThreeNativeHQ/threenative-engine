import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { type IAssetCompileOptions, compileAssets } from "../src/index.js";

/**
 * Every message the `assets.*` config parser can throw, one row per case, pinned exactly.
 *
 * `threenative.config.ts` is the author-facing surface, and a dropped or reworded message is a
 * game that fails its build with no idea which key it wrote wrong. The table is the contract; a
 * split of the file that owns these throws must not change one character of it (PRD-804 AC-1).
 */
interface IConfigErrorCase {
  readonly config?: unknown;
  readonly message: string;
  readonly name: string;
}

const CODEC_LIST = "etc1s, none, uastc";

const CONFIG_ERRORS: readonly IConfigErrorCase[] = [
  // The `assets` block itself.
  {
    config: 3,
    message: "TN_ASSETS_CONFIG_INVALID: assets must be an object when declared.",
    name: "rejects a non-object assets block",
  },
  {
    config: { bogus: 1 },
    message: "TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.bogus is not recognised.",
    name: "rejects an unknown assets key",
  },
  {
    config: { exclude: "unused/**" },
    message: "TN_ASSETS_CONFIG_INVALID: assets.exclude must be an array of non-empty glob strings.",
    name: "rejects a non-array exclude",
  },
  {
    config: { exclude: [""] },
    message: "TN_ASSETS_CONFIG_INVALID: assets.exclude must be an array of non-empty glob strings.",
    name: "rejects an empty glob in exclude",
  },
  {
    config: { source: "" },
    message: "TN_ASSETS_CONFIG_INVALID: assets.source must be a non-empty string.",
    name: "rejects an empty source",
  },
  {
    config: { output: "" },
    message: "TN_ASSETS_CONFIG_INVALID: assets.output must be a non-empty string.",
    name: "rejects an empty output",
  },
  {
    config: { nativePackage: "yes" },
    message: "TN_ASSETS_CONFIG_INVALID: assets.nativePackage must be a boolean.",
    name: "rejects a non-boolean nativePackage",
  },

  // assets.targets
  {
    config: { targets: "big" },
    message: "TN_ASSETS_CONFIG_INVALID: assets.targets must be an object.",
    name: "rejects a non-object targets block",
  },
  {
    config: { targets: { maxBones: 8 } },
    message: "TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.targets.maxBones is not recognised.",
    name: "rejects an unknown targets key",
  },
  {
    config: { targets: { maxMaterials: 0 } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.targets.maxMaterials must be a positive integer.",
    name: "rejects a non-positive maxMaterials",
  },
  {
    config: { targets: { maxTriangles: 1.5 } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.targets.maxTriangles must be a positive integer.",
    name: "rejects a fractional maxTriangles",
  },
  {
    config: { targets: { maxTextureDimension: -4 } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.targets.maxTextureDimension must be a positive integer.",
    name: "rejects a negative maxTextureDimension",
  },

  // assets.textures
  {
    config: { textures: 3 },
    message: 'TN_ASSETS_CONFIG_INVALID: assets.textures must be "none" or an object.',
    name: "rejects a non-object textures block",
  },
  {
    config: { textures: { maxDimension: 512 } },
    message: "TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.textures.maxDimension is not recognised.",
    name: "rejects an unknown textures key",
  },
  {
    config: { textures: { quality: 0 } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.textures.quality must be an integer between 1 and 255.",
    name: "rejects a texture quality below 1",
  },
  {
    config: { textures: { maxSize: 3 } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.textures.maxSize must be a positive integer of at least 4.",
    name: "rejects a texture maxSize below 4",
  },
  {
    config: { textures: { maxSize: { baseColorTexture: 2 } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.textures.maxSize.baseColorTexture must be a positive integer of at least 4.",
    name: "rejects a per-slot texture maxSize below 4",
  },
  {
    config: { textures: { maxSize: { woodGrainTexture: 512 } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.textures.maxSize.woodGrainTexture must name a glTF texture slot.",
    name: "rejects a per-slot texture maxSize that is not a glTF slot",
  },
  {
    config: { textures: { overrides: {} } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.textures.overrides must be an array.",
    name: "rejects a non-array textures overrides",
  },
  {
    config: { textures: { overrides: [1] } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.textures.overrides[0] must be an object.",
    name: "rejects a non-object texture override",
  },
  {
    config: { textures: { overrides: [{ codec: "etc1s", glob: "*", slot: "baseColorTexture" }] } },
    message: "TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.textures.overrides.slot is not recognised.",
    name: "rejects an unknown texture override key",
  },
  {
    config: { textures: { overrides: [{ codec: "etc1s", glob: "" }] } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.textures.overrides[0].glob must be a non-empty string.",
    name: "rejects an empty texture override glob",
  },
  {
    config: { textures: { overrides: [{ codec: "bc7", glob: "*" }] } },
    message: `TN_ASSETS_CONFIG_INVALID: assets.textures.overrides[0].codec must be one of ${CODEC_LIST}; received 'bc7'.`,
    name: "rejects an unknown texture override codec",
  },
  {
    config: { textures: { overrides: [{ codec: "etc1s", glob: "*", quality: 0 }] } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.textures.overrides[0].quality must be an integer between 1 and 255.",
    name: "rejects a texture override quality below 1",
  },

  // assets.models, the block itself.
  {
    config: { models: 3 },
    message: 'TN_ASSETS_CONFIG_INVALID: assets.models must be "none" or an object.',
    name: "rejects a non-object models block",
  },
  {
    config: { models: { bogus: true } },
    message: "TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.models.bogus is not recognised.",
    name: "rejects an unknown models key",
  },
  {
    config: { models: { sharedImages: "yes" } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.models.sharedImages must be a boolean.",
    name: "rejects a non-boolean sharedImages",
  },

  // assets.models.passes
  {
    config: { models: { passes: 3 } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.models.passes must be an object.",
    name: "rejects a non-object models.passes",
  },
  {
    config: { models: { passes: { decimate: true } } },
    message: "TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.models.passes.decimate is not recognised.",
    name: "rejects an unknown models.passes key",
  },
  {
    config: { models: { passes: { dedup: 3 } } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.models.passes.dedup must be a boolean.",
    name: "rejects a non-boolean models.passes switch",
  },

  // assets.models.quantize
  {
    config: { models: { quantize: 3 } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.models.quantize must be an object.",
    name: "rejects a non-object models.quantize",
  },
  {
    config: { models: { quantize: { colourBits: 8 } } },
    message: "TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.models.quantize.colourBits is not recognised.",
    name: "rejects an unknown models.quantize key",
  },
  {
    config: { models: { quantize: { positionBits: 32 } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.models.quantize.positionBits must be an integer between 1 and 16 bits.",
    name: "rejects a quantize depth above 16 bits",
  },

  // assets.models.compact
  {
    config: { models: { compact: "yes" } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.models.compact must be a boolean or an object.",
    name: "rejects a non-boolean models.compact",
  },
  {
    config: { models: { compact: { joins: true } } },
    message: "TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.models.compact.joins is not recognised.",
    name: "rejects an unknown models.compact key",
  },
  {
    config: { models: { compact: { flatten: "yes" } } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.models.compact.flatten must be a boolean.",
    name: "rejects a non-boolean compact.flatten",
  },
  {
    config: { models: { compact: { join: "yes" } } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.models.compact.join must be a boolean.",
    name: "rejects a non-boolean compact.join",
  },
  {
    config: { models: { compact: { instance: 3 } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.models.compact.instance must be a boolean or an object.",
    name: "rejects a non-boolean compact.instance",
  },
  {
    config: { models: { compact: { instance: { batch: 4 } } } },
    message:
      "TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.models.compact.instance.batch is not recognised.",
    name: "rejects an unknown compact.instance key",
  },
  {
    config: { models: { compact: { instance: { min: 1 } } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.models.compact.instance.min must be an integer of at least 2.",
    name: "rejects a compact.instance below 2",
  },
  {
    config: { models: { compact: { protectedNames: [1] } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.models.compact.protectedNames must be an array of strings.",
    name: "rejects non-string compact.protectedNames",
  },
  {
    config: { models: { compact: { protectedPattern: 5 } } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.models.compact.protectedPattern must be a string.",
    name: "rejects a non-string compact.protectedPattern",
  },
  {
    config: { models: { compact: { protectedPattern: "(" } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.models.compact.protectedPattern is not a valid regular expression: '('.",
    name: "rejects an uncompilable compact.protectedPattern",
  },

  // assets.models.lightmap
  {
    config: { models: { lightmap: 3 } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.models.lightmap must be an object.",
    name: "rejects a non-object models.lightmap",
  },
  {
    config: { models: { lightmap: { atlasSize: 1024, padding: 2, samples: 4 } } },
    message: "TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.models.lightmap.samples is not recognised.",
    name: "rejects an unknown models.lightmap key",
  },
  {
    config: { models: { lightmap: { atlasSize: 0, padding: 2 } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.models.lightmap.atlasSize must be a positive integer.",
    name: "rejects a non-positive lightmap atlasSize",
  },
  {
    config: { models: { lightmap: { atlasSize: 6, padding: 2 } } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.models.lightmap.atlasSize must be a multiple of 4.",
    name: "rejects a lightmap atlasSize that is not a multiple of 4",
  },
  {
    config: { models: { lightmap: { atlasSize: 1024, padding: 0 } } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.models.lightmap.padding must be a positive integer.",
    name: "rejects a non-positive lightmap padding",
  },

  // assets.models.simplify
  {
    config: { models: { simplify: 3 } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.models.simplify must be an object.",
    name: "rejects a non-object models.simplify",
  },
  {
    config: { models: { simplify: { ratio: 0.5, tolerance: 0.1 } } },
    message: "TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.models.simplify.tolerance is not recognised.",
    name: "rejects an unknown models.simplify key",
  },
  {
    config: { models: { simplify: { ratio: 2 } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.models.simplify.ratio must be a number greater than 0 and at most 1.",
    name: "rejects a simplify ratio above 1",
  },
  {
    config: { models: { simplify: { error: -1, ratio: 0.5 } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.models.simplify.error must be a non-negative number.",
    name: "rejects a negative simplify error",
  },

  // assets.models.textures
  {
    config: { models: { textures: 3 } },
    message: 'TN_ASSETS_CONFIG_INVALID: assets.models.textures must be "none" or an object.',
    name: "rejects a non-object models.textures",
  },
  {
    config: { models: { textures: { codec: "etc1s" } } },
    message: "TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.models.textures.codec is not recognised.",
    name: "rejects an unknown models.textures key",
  },
  {
    config: { models: { textures: { quality: 0 } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.models.textures.quality must be an integer between 1 and 255.",
    name: "rejects a models texture quality below 1",
  },
  {
    config: { models: { textures: { maxSize: 0 } } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.models.textures.maxSize must be a positive integer.",
    name: "rejects a models texture maxSize of 0",
  },
  {
    config: { models: { textures: { maxSize: { baseColorTexture: 0 } } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.models.textures.maxSize.baseColorTexture must be a positive integer.",
    name: "rejects a per-slot models texture maxSize of 0",
  },
  {
    config: { models: { textures: { overrides: {} } } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.models.textures.overrides must be an array.",
    name: "rejects a non-array models texture overrides",
  },
  {
    config: { models: { textures: { overrides: [1] } } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.models.textures.overrides[0] must be an object.",
    name: "rejects a non-object models texture override",
  },
  {
    config: { models: { textures: { overrides: [{ codec: "etc1s", quality: 40, slot: "x" }] } } },
    message:
      "TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.models.textures.overrides.quality is not recognised.",
    name: "rejects an unknown models texture override key",
  },
  {
    config: { models: { textures: { overrides: [{ codec: "bc7", slot: "baseColorTexture" }] } } },
    message: `TN_ASSETS_CONFIG_INVALID: assets.models.textures.overrides[0].codec must be one of ${CODEC_LIST}; received 'bc7'.`,
    name: "rejects an unknown models texture override codec",
  },
  {
    config: { models: { textures: { overrides: [{ codec: "etc1s", slot: "" }] } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.models.textures.overrides[0].slot must be a non-empty string.",
    name: "rejects an empty models texture override slot",
  },

  // assets.models.virtual
  {
    config: { models: { virtual: 3 } },
    message: 'TN_ASSETS_CONFIG_INVALID: assets.models.virtual must be "none" or an object.',
    name: "rejects a non-object models.virtual",
  },
  {
    config: { models: { virtual: { minTriangls: 4 } } },
    message: "TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.models.virtual.minTriangls is not recognised.",
    name: "rejects an unknown models.virtual key",
  },
  {
    config: { models: { virtual: { minSourceTriangles: 0 } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.models.virtual.minSourceTriangles must be a positive integer.",
    name: "rejects a non-positive models.virtual count",
  },
  {
    config: { models: { virtual: { simplifyRatio: 1 } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.models.virtual.simplifyRatio must be a number between 0 and 1, exclusive.",
    name: "rejects a models.virtual simplifyRatio of 1",
  },

  // assets.lod
  {
    config: { lod: 3 },
    message: 'TN_ASSETS_CONFIG_INVALID: assets.lod must be a boolean, "none", or an object.',
    name: "rejects a non-boolean assets.lod",
  },
  {
    config: { lod: { kur: 1 } },
    message: "TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.lod.kur is not recognised.",
    name: "rejects an unknown assets.lod key",
  },
  {
    config: { lod: { enabled: 3 } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.lod.enabled must be a boolean.",
    name: "rejects a non-boolean lod.enabled",
  },
  {
    config: { lod: { generation: 3 } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.lod.generation must be an object.",
    name: "rejects a non-object lod.generation",
  },
  {
    config: { lod: { generation: { bvh: 1 } } },
    message: "TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.lod.generation.bvh is not recognised.",
    name: "rejects an unknown lod.generation key",
  },
  {
    config: { lod: { generation: { maxLevels: 9 } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.lod.generation.maxLevels must be an integer between 1 and 8.",
    name: "rejects a lod maxLevels above 8",
  },
  {
    config: { lod: { generation: { minTriangles: 0 } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.lod.generation.minTriangles must be a positive integer.",
    name: "rejects a non-positive lod minTriangles",
  },
  {
    config: { lod: { generation: { minTrianglesScope: "mesh" } } },
    message:
      'TN_ASSETS_CONFIG_INVALID: assets.lod.generation.minTrianglesScope must be "primitive" or "asset".',
    name: "rejects an unknown lod minTrianglesScope",
  },
  {
    config: { lod: { generation: { minSaving: 1 } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.lod.generation.minSaving must be a finite number in [0, 1).",
    name: "rejects a lod minSaving of 1",
  },
  {
    config: { lod: { generation: { join: "yes" } } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.lod.generation.join must be a boolean.",
    name: "rejects a non-boolean lod.generation.join",
  },
  {
    config: { lod: { generation: { errorTargets: [] } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.lod.generation.errorTargets must be 1 to 16 geometric-error targets.",
    name: "rejects an empty errorTargets list",
  },
  {
    config: { lod: { generation: { errorTargets: [0.5, 0] } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.lod.generation.errorTargets must be positive finite numbers.",
    name: "rejects a non-positive error target",
  },
  {
    config: { lod: { generation: { errorTargets: [0.5, 0.5] } } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.lod.generation.errorTargets must increase strictly.",
    name: "rejects repeated error targets",
  },
  {
    config: { lod: { preset: "max" } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.lod.preset must be one of aggressive, balanced, quality.",
    name: "rejects an unknown lod preset",
  },
  {
    config: { lod: { runtime: 3 } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.lod.runtime must be an object.",
    name: "rejects a non-object lod.runtime",
  },
  {
    config: { lod: { runtime: { budget: 1 } } },
    message: "TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.lod.runtime.budget is not recognised.",
    name: "rejects an unknown lod.runtime key",
  },
  {
    config: { lod: { runtime: { maxPixelError: 0 } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.lod.runtime.maxPixelError must be a positive finite number.",
    name: "rejects a non-positive lod maxPixelError",
  },
  {
    config: { lod: { runtime: { hysteresis: 0.5 } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.lod.runtime.hysteresis must be a finite number in [0, 0.5).",
    name: "rejects a lod hysteresis of 0.5",
  },
  {
    config: { lod: { overrides: [] } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.lod.overrides must be an object.",
    name: "rejects a non-object lod.overrides",
  },
  {
    config: { lod: { overrides: { chair: 3 } } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.lod.overrides['chair'] must be an object.",
    name: "rejects a non-object lod override",
  },
  {
    config: { lod: { overrides: { chair: { enabled: 3 } } } },
    message: "TN_ASSETS_CONFIG_INVALID: assets.lod.overrides['chair'].enabled must be a boolean.",
    name: "rejects a non-boolean lod override enabled",
  },
  {
    config: { lod: { overrides: { chair: { generation: 3 } } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.lod.overrides['chair'].generation must be an object.",
    name: "rejects a non-object lod override generation",
  },
  {
    config: { lod: { overrides: { chair: { preset: "max" } } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.lod.overrides['chair'].preset must be one of aggressive, balanced, quality.",
    name: "rejects an unknown lod override preset",
  },
  {
    config: { lod: { overrides: { chair: { runtime: { hysteresis: 1 } } } } },
    message:
      "TN_ASSETS_CONFIG_INVALID: assets.lod.overrides['chair'].runtime.hysteresis must be a finite number in [0, 0.5).",
    name: "rejects a lod override hysteresis of 1",
  },
  {
    config: { lod: { overrides: { chair: { bvh: 1 } } } },
    message: "TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.lod.overrides['chair'].bvh is not recognised.",
    name: "rejects an unknown lod override key",
  },
];

/** The message `compileAssets` threw, or a failure naming the config it wrongly accepted. */
async function configError(config: unknown): Promise<string> {
  const cwd = await makeTempDir("threenative-compile-config-");
  try {
    await compileAssets({ config, cwd } as unknown as IAssetCompileOptions);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`compileAssets accepted ${JSON.stringify(config)}`);
}

describe("compileAssets config errors", () => {
  // The audit that filed this table counted 59 invalid-config throws in the parser. A rewrite
  // that quietly drops the checks it cannot be bothered to move shrinks this list.
  it("pins at least the 59 config errors the parser declares", () => {
    expect(CONFIG_ERRORS.length).toBeGreaterThanOrEqual(59);
  });

  it.each(CONFIG_ERRORS)("should throw the pinned message when it $name", async (row) => {
    expect(await configError(row.config)).toBe(row.message);
  });
});
