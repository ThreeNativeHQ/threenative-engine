import { CODECS, isRecord } from "./compile-rows.js";
import type { IAssetTargets } from "./compile-types.js";
import {
  LIGHTMAP_CONFIG_KEYS,
  MODELS_CONFIG_KEYS,
  MODEL_PASS_KEYS,
  MODEL_QUANTIZE_KEYS,
  MODEL_VIRTUAL_COUNT_KEYS,
  MODEL_VIRTUAL_KEYS,
} from "./config-keys.js";
import { resolveImageQualityFloor } from "./image-quality.js";
import { isLodPreset } from "./lod/generate.js";
import type {
  IModelLodOptions,
  IModelLodOverride,
  IModelLodRuntimeOptions,
  LodMinTrianglesScope,
  LodPreset,
} from "./lod/generate.js";
import type { IModelCompactInstanceOptions, IModelCompactOptions } from "./passes/compact.js";
import type { ILightmapPassOptions } from "./passes/lightmap.js";
import { TEXTURE_SIZE_SLOTS } from "./passes/model-textures.js";
import type { TextureMaxSize } from "./passes/model-textures.js";
import type {
  IModelPassOptions,
  IModelPassesOptions,
  IModelQuantizeOptions,
  IModelSimplifyOptions,
  IModelTextureOverride,
  IModelTexturesOptions,
  IModelVirtualOptions,
} from "./passes/model.js";
import type { ITextureOverride, ITexturePassOptions } from "./passes/texture.js";

export function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`TN_ASSETS_CONFIG_INVALID: ${label} must be a non-empty string.`);
  }
  return value;
}

export const TARGET_KEYS: readonly string[] = [
  "maxMaterials",
  "maxTriangles",
  "maxTextureDimension",
];

export function positiveTarget(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `TN_ASSETS_CONFIG_INVALID: assets.targets.${label} must be a positive integer.`,
    );
  }
  return value;
}

export function validateTargets(raw: unknown): IAssetTargets {
  if (!isRecord(raw)) {
    throw new Error("TN_ASSETS_CONFIG_INVALID: assets.targets must be an object.");
  }
  for (const key of Object.keys(raw)) {
    if (!TARGET_KEYS.includes(key)) {
      throw new Error(`TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.targets.${key} is not recognised.`);
    }
  }
  return {
    ...(raw.maxMaterials === undefined
      ? {}
      : { maxMaterials: positiveTarget(raw.maxMaterials, "maxMaterials") }),
    ...(raw.maxTriangles === undefined
      ? {}
      : { maxTriangles: positiveTarget(raw.maxTriangles, "maxTriangles") }),
    ...(raw.maxTextureDimension === undefined
      ? {}
      : { maxTextureDimension: positiveTarget(raw.maxTextureDimension, "maxTextureDimension") }),
  };
}

export function textureQuality(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 255) {
    throw new Error(`TN_ASSETS_CONFIG_INVALID: ${label} must be an integer between 1 and 255.`);
  }
  return value;
}

export function validateTextureOverrides(raw: unknown): readonly ITextureOverride[] {
  if (!Array.isArray(raw)) {
    throw new Error("TN_ASSETS_CONFIG_INVALID: assets.textures.overrides must be an array.");
  }
  return raw.map((item, index): ITextureOverride => {
    if (!isRecord(item)) {
      throw new Error(
        `TN_ASSETS_CONFIG_INVALID: assets.textures.overrides[${String(index)}] must be an object.`,
      );
    }
    for (const key of Object.keys(item)) {
      if (key !== "glob" && key !== "codec" && key !== "quality") {
        throw new Error(
          `TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.textures.overrides.${key} is not recognised.`,
        );
      }
    }
    const glob = nonEmptyString(item.glob, `assets.textures.overrides[${String(index)}].glob`);
    if (!CODECS.includes(item.codec as string)) {
      throw new Error(
        `TN_ASSETS_CONFIG_INVALID: assets.textures.overrides[${String(index)}].codec must be one of ${CODECS.join(", ")}; received '${String(item.codec)}'.`,
      );
    }
    return {
      codec: item.codec as ITextureOverride["codec"],
      glob,
      ...(item.quality === undefined
        ? {}
        : {
            quality: textureQuality(
              item.quality,
              `assets.textures.overrides[${String(index)}].quality`,
            ),
          }),
    };
  });
}

/** `"none"` disables the built-in texture pass; an object configures it; absent means defaults. */
export function parseTexturesConfig(raw: unknown): ITexturePassOptions | undefined {
  if (raw === undefined) return {};
  if (raw === "none") return undefined;
  if (!isRecord(raw)) {
    throw new Error('TN_ASSETS_CONFIG_INVALID: assets.textures must be "none" or an object.');
  }
  for (const key of Object.keys(raw)) {
    if (key !== "maxSize" && key !== "quality" && key !== "overrides" && key !== "floor") {
      throw new Error(`TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.textures.${key} is not recognised.`);
    }
  }
  return {
    ...(raw.floor === undefined ? {} : { floor: resolveImageQualityFloor(raw.floor) }),
    ...(raw.maxSize === undefined
      ? {}
      : {
          maxSize: parseTextureMaxSize(raw.maxSize, "assets.textures.maxSize", positiveTextureSize),
        }),
    ...(raw.quality === undefined
      ? {}
      : { quality: textureQuality(raw.quality, "assets.textures.quality") }),
    ...(raw.overrides === undefined ? {} : { overrides: validateTextureOverrides(raw.overrides) }),
  };
}

export function parseTextureMaxSize(
  value: unknown,
  label: string,
  validate: (value: unknown, label: string) => number,
): TextureMaxSize {
  if (!isRecord(value)) return validate(value, label);
  return Object.fromEntries(
    Object.entries(value).map(([slot, cap]) => {
      if (!TEXTURE_SIZE_SLOTS.has(slot))
        throw new Error(
          `TN_ASSETS_CONFIG_INVALID: ${label}.${slot} must name a glTF texture slot.`,
        );
      return [slot, validate(cap, `${label}.${slot}`)];
    }),
  );
}

export function positiveTextureSize(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 4) {
    throw new Error(`TN_ASSETS_CONFIG_INVALID: ${label} must be a positive integer of at least 4.`);
  }
  return value;
}

/** `"none"` disables the built-in model pass; an object configures it; absent means defaults. */
export type ParsedModelsConfig = Omit<IModelPassOptions, "sharedImages"> & {
  readonly sharedImages: boolean;
};

export function parseModelsConfig(raw: unknown): ParsedModelsConfig | undefined {
  if (raw === undefined) return { sharedImages: true };
  if (raw === "none") return undefined;
  if (!isRecord(raw)) {
    throw new Error('TN_ASSETS_CONFIG_INVALID: assets.models must be "none" or an object.');
  }
  for (const key of Object.keys(raw)) {
    if (!MODELS_CONFIG_KEYS.includes(key)) {
      throw new Error(`TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.models.${key} is not recognised.`);
    }
  }
  // The sub-pass switches and bit depths are validated by the pass itself, which owns their
  // vocabulary; a malformed value surfaces as TN_ASSETS_CONFIG_* when the registry is built.
  const passes = raw.passes === undefined ? {} : parseModelPasses(raw.passes);
  const quantize = raw.quantize === undefined ? {} : parseModelQuantize(raw.quantize);
  const compact = raw.compact === undefined ? undefined : parseModelCompact(raw.compact);
  const lightmap = raw.lightmap === undefined ? undefined : parseLightmap(raw.lightmap);
  const simplify = raw.simplify === undefined ? undefined : parseModelSimplify(raw.simplify);
  const textures = raw.textures === undefined ? undefined : parseModelTextures(raw.textures);
  const virtual = raw.virtual === undefined ? undefined : parseModelVirtual(raw.virtual);
  if (raw.sharedImages !== undefined && typeof raw.sharedImages !== "boolean") {
    throw new Error("TN_ASSETS_CONFIG_INVALID: assets.models.sharedImages must be a boolean.");
  }
  return {
    sharedImages: raw.sharedImages !== false,
    ...(compact === undefined ? {} : { compact }),
    ...(lightmap === undefined ? {} : { lightmap }),
    ...(Object.keys(passes).length === 0 ? {} : { passes }),
    ...(Object.keys(quantize).length === 0 ? {} : { quantize }),
    ...(simplify === undefined ? {} : { simplify }),
    ...(textures === undefined ? {} : { textures }),
    ...(virtual === undefined ? {} : { virtual }),
  };
}

export const MODEL_COMPACT_KEYS: readonly string[] = [
  "flatten",
  "instance",
  "join",
  "protectedNames",
  "protectedPattern",
];

/**
 * `true`/absent runs every compaction sub-pass with defaults; `false` is the kill switch; an
 * object configures the sub-passes and the protected-node rules. Every key is validated here,
 * because a silently-dropped `protectedNames` is a node the author expected to keep addressable
 * and would not.
 */
export function parseModelCompact(raw: unknown): boolean | IModelCompactOptions {
  if (typeof raw === "boolean") return raw;
  if (!isRecord(raw)) {
    throw new Error(
      "TN_ASSETS_CONFIG_INVALID: assets.models.compact must be a boolean or an object.",
    );
  }
  for (const key of Object.keys(raw)) {
    if (!MODEL_COMPACT_KEYS.includes(key)) {
      throw new Error(
        `TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.models.compact.${key} is not recognised.`,
      );
    }
  }
  for (const key of ["flatten", "join"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") {
      throw new Error(`TN_ASSETS_CONFIG_INVALID: assets.models.compact.${key} must be a boolean.`);
    }
  }
  let instance: boolean | IModelCompactInstanceOptions | undefined;
  if (raw.instance !== undefined) {
    if (typeof raw.instance === "boolean") {
      instance = raw.instance;
    } else if (isRecord(raw.instance)) {
      for (const key of Object.keys(raw.instance)) {
        if (key !== "min")
          throw new Error(
            `TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.models.compact.instance.${key} is not recognised.`,
          );
      }
      if (
        raw.instance.min !== undefined &&
        (typeof raw.instance.min !== "number" ||
          !Number.isSafeInteger(raw.instance.min) ||
          raw.instance.min < 2)
      )
        throw new Error(
          "TN_ASSETS_CONFIG_INVALID: assets.models.compact.instance.min must be an integer of at least 2.",
        );
      instance = raw.instance.min === undefined ? {} : { min: raw.instance.min };
    } else {
      throw new Error(
        "TN_ASSETS_CONFIG_INVALID: assets.models.compact.instance must be a boolean or an object.",
      );
    }
  }
  if (raw.protectedNames !== undefined) {
    if (
      !Array.isArray(raw.protectedNames) ||
      raw.protectedNames.some((name) => typeof name !== "string")
    )
      throw new Error(
        "TN_ASSETS_CONFIG_INVALID: assets.models.compact.protectedNames must be an array of strings.",
      );
  }
  if (raw.protectedPattern !== undefined) {
    if (typeof raw.protectedPattern !== "string")
      throw new Error(
        "TN_ASSETS_CONFIG_INVALID: assets.models.compact.protectedPattern must be a string.",
      );
    try {
      new RegExp(raw.protectedPattern, "iu");
    } catch {
      throw new Error(
        `TN_ASSETS_CONFIG_INVALID: assets.models.compact.protectedPattern is not a valid regular expression: '${raw.protectedPattern}'.`,
      );
    }
  }
  return {
    ...(raw.flatten === undefined ? {} : { flatten: raw.flatten as boolean }),
    ...(instance === undefined ? {} : { instance }),
    ...(raw.join === undefined ? {} : { join: raw.join as boolean }),
    ...(raw.protectedNames === undefined
      ? {}
      : { protectedNames: raw.protectedNames as readonly string[] }),
    ...(raw.protectedPattern === undefined
      ? {}
      : { protectedPattern: raw.protectedPattern as string }),
  };
}

export const MODEL_TEXTURE_KEYS: readonly string[] = ["maxSize", "overrides", "quality", "floor"];

export function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `TN_ASSETS_CONFIG_INVALID: assets.models.textures.${label} must be a positive integer.`,
    );
  }
  return value;
}

/** `"none"` ships every embedded image as authored; an object configures the compression. */
export function parseModelTextures(raw: unknown): IModelTexturesOptions | "none" {
  if (raw === "none") return "none";
  if (!isRecord(raw)) {
    throw new Error(
      'TN_ASSETS_CONFIG_INVALID: assets.models.textures must be "none" or an object.',
    );
  }
  for (const key of Object.keys(raw)) {
    if (!MODEL_TEXTURE_KEYS.includes(key)) {
      throw new Error(
        `TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.models.textures.${key} is not recognised.`,
      );
    }
  }
  return {
    ...(raw.floor === undefined ? {} : { floor: resolveImageQualityFloor(raw.floor) }),
    ...(raw.maxSize === undefined
      ? {}
      : { maxSize: parseTextureMaxSize(raw.maxSize, "maxSize", positiveInteger) }),
    ...(raw.overrides === undefined
      ? {}
      : { overrides: validateModelTextureOverrides(raw.overrides) }),
    ...(raw.quality === undefined
      ? {}
      : { quality: textureQuality(raw.quality, "assets.models.textures.quality") }),
  };
}

export function validateModelTextureOverrides(raw: unknown): readonly IModelTextureOverride[] {
  if (!Array.isArray(raw)) {
    throw new Error("TN_ASSETS_CONFIG_INVALID: assets.models.textures.overrides must be an array.");
  }
  return raw.map((item, index): IModelTextureOverride => {
    const label = `assets.models.textures.overrides[${String(index)}]`;
    if (!isRecord(item)) throw new Error(`TN_ASSETS_CONFIG_INVALID: ${label} must be an object.`);
    for (const key of Object.keys(item)) {
      if (key !== "slot" && key !== "codec") {
        throw new Error(
          `TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.models.textures.overrides.${key} is not recognised.`,
        );
      }
    }
    if (!CODECS.includes(item.codec as string)) {
      throw new Error(
        `TN_ASSETS_CONFIG_INVALID: ${label}.codec must be one of ${CODECS.join(", ")}; received '${String(item.codec)}'.`,
      );
    }
    return {
      codec: item.codec as IModelTextureOverride["codec"],
      slot: nonEmptyString(item.slot, `${label}.slot`),
    };
  });
}

export function parseModelSimplify(raw: unknown): IModelSimplifyOptions {
  if (!isRecord(raw)) {
    throw new Error("TN_ASSETS_CONFIG_INVALID: assets.models.simplify must be an object.");
  }
  for (const key of Object.keys(raw)) {
    if (key !== "error" && key !== "ratio") {
      throw new Error(
        `TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.models.simplify.${key} is not recognised.`,
      );
    }
  }
  if (typeof raw.ratio !== "number" || !(raw.ratio > 0) || raw.ratio > 1) {
    throw new Error(
      "TN_ASSETS_CONFIG_INVALID: assets.models.simplify.ratio must be a number greater than 0 and at most 1.",
    );
  }
  if (raw.error !== undefined && (typeof raw.error !== "number" || raw.error < 0)) {
    throw new Error(
      "TN_ASSETS_CONFIG_INVALID: assets.models.simplify.error must be a non-negative number.",
    );
  }
  return {
    ratio: raw.ratio,
    ...(raw.error === undefined ? {} : { error: raw.error as number }),
  };
}

/**
 * `"none"` ships every primitive as authored; an object moves the cluster bake's thresholds.
 *
 * Every key is validated here rather than deeper in the bake, because a game reaches this through
 * `threenative.config.ts` and a silently-dropped `minSourceTriangles` is a bake that quietly did
 * something other than what the file asked for.
 */
export function parseModelVirtual(raw: unknown): IModelVirtualOptions | "none" {
  if (raw === "none") return "none";
  if (!isRecord(raw)) {
    throw new Error('TN_ASSETS_CONFIG_INVALID: assets.models.virtual must be "none" or an object.');
  }
  for (const key of Object.keys(raw)) {
    if (!MODEL_VIRTUAL_KEYS.includes(key)) {
      throw new Error(
        `TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.models.virtual.${key} is not recognised.`,
      );
    }
  }
  const parsed: Record<string, number> = {};
  for (const key of MODEL_VIRTUAL_COUNT_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `TN_ASSETS_CONFIG_INVALID: assets.models.virtual.${key} must be a positive integer.`,
      );
    }
    parsed[key] = value;
  }
  if (raw.simplifyRatio !== undefined) {
    if (
      typeof raw.simplifyRatio !== "number" ||
      !(raw.simplifyRatio > 0) ||
      !(raw.simplifyRatio < 1)
    )
      throw new Error(
        "TN_ASSETS_CONFIG_INVALID: assets.models.virtual.simplifyRatio must be a number between 0 and 1, exclusive.",
      );
    parsed.simplifyRatio = raw.simplifyRatio;
  }
  return parsed as IModelVirtualOptions;
}

export function parseModelLod(raw: unknown): boolean | IModelLodOptions | "none" {
  if (raw === "none" || typeof raw === "boolean") return raw;
  if (!isRecord(raw)) {
    throw new Error(
      'TN_ASSETS_CONFIG_INVALID: assets.lod must be a boolean, "none", or an object.',
    );
  }
  const allowed = ["enabled", "generation", "overrides", "preset", "runtime"];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new Error(`TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.lod.${key} is not recognised.`);
    }
  }
  const generation = (value: unknown, label: string): IModelLodOptions["generation"] => {
    if (!isRecord(value)) throw new Error(`TN_ASSETS_CONFIG_INVALID: ${label} must be an object.`);
    const allowed = [
      "errorTargets",
      "join",
      "maxLevels",
      "minSaving",
      "minTriangles",
      "minTrianglesScope",
    ];
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        throw new Error(`TN_ASSETS_CONFIG_UNKNOWN_KEY: ${label}.${key} is not recognised.`);
      }
    }
    if (
      value.maxLevels !== undefined &&
      (!Number.isSafeInteger(value.maxLevels) ||
        (value.maxLevels as number) < 1 ||
        (value.maxLevels as number) > 8)
    ) {
      throw new Error(
        `TN_ASSETS_CONFIG_INVALID: ${label}.maxLevels must be an integer between 1 and 8.`,
      );
    }
    if (
      value.minTriangles !== undefined &&
      (!Number.isSafeInteger(value.minTriangles) || (value.minTriangles as number) <= 0)
    ) {
      throw new Error(
        `TN_ASSETS_CONFIG_INVALID: ${label}.minTriangles must be a positive integer.`,
      );
    }
    if (
      value.minTrianglesScope !== undefined &&
      value.minTrianglesScope !== "primitive" &&
      value.minTrianglesScope !== "asset"
    ) {
      throw new Error(
        `TN_ASSETS_CONFIG_INVALID: ${label}.minTrianglesScope must be "primitive" or "asset".`,
      );
    }
    if (
      value.minSaving !== undefined &&
      (typeof value.minSaving !== "number" ||
        !Number.isFinite(value.minSaving) ||
        value.minSaving < 0 ||
        value.minSaving >= 1)
    ) {
      throw new Error(
        `TN_ASSETS_CONFIG_INVALID: ${label}.minSaving must be a finite number in [0, 1).`,
      );
    }
    if (value.join !== undefined && typeof value.join !== "boolean") {
      throw new Error(`TN_ASSETS_CONFIG_INVALID: ${label}.join must be a boolean.`);
    }
    if (value.errorTargets !== undefined) {
      const targets = value.errorTargets;
      if (!Array.isArray(targets) || targets.length === 0 || targets.length > 16) {
        throw new Error(
          `TN_ASSETS_CONFIG_INVALID: ${label}.errorTargets must be 1 to 16 geometric-error targets.`,
        );
      }
      let previous = -1;
      for (const target of targets) {
        if (typeof target !== "number" || !Number.isFinite(target) || target <= 0) {
          throw new Error(
            `TN_ASSETS_CONFIG_INVALID: ${label}.errorTargets must be positive finite numbers.`,
          );
        }
        if (target <= previous) {
          throw new Error(
            `TN_ASSETS_CONFIG_INVALID: ${label}.errorTargets must increase strictly.`,
          );
        }
        previous = target;
      }
    }
    return {
      ...(value.errorTargets === undefined ? {} : { errorTargets: value.errorTargets as number[] }),
      ...(value.join === undefined ? {} : { join: value.join as boolean }),
      ...(value.maxLevels === undefined ? {} : { maxLevels: value.maxLevels as number }),
      ...(value.minSaving === undefined ? {} : { minSaving: value.minSaving as number }),
      ...(value.minTriangles === undefined ? {} : { minTriangles: value.minTriangles as number }),
      ...(value.minTrianglesScope === undefined
        ? {}
        : { minTrianglesScope: value.minTrianglesScope as LodMinTrianglesScope }),
    };
  };
  const presetValue = (value: unknown, label: string): LodPreset => {
    if (!isLodPreset(value)) {
      throw new Error(
        `TN_ASSETS_CONFIG_INVALID: ${label} must be one of aggressive, balanced, quality.`,
      );
    }
    return value;
  };
  const runtimeValue = (value: unknown, label: string): IModelLodRuntimeOptions => {
    if (!isRecord(value)) throw new Error(`TN_ASSETS_CONFIG_INVALID: ${label} must be an object.`);
    for (const key of Object.keys(value)) {
      if (key !== "hysteresis" && key !== "maxPixelError") {
        throw new Error(`TN_ASSETS_CONFIG_UNKNOWN_KEY: ${label}.${key} is not recognised.`);
      }
    }
    if (
      value.maxPixelError !== undefined &&
      (typeof value.maxPixelError !== "number" ||
        !Number.isFinite(value.maxPixelError) ||
        value.maxPixelError <= 0)
    ) {
      throw new Error(
        `TN_ASSETS_CONFIG_INVALID: ${label}.maxPixelError must be a positive finite number.`,
      );
    }
    if (
      value.hysteresis !== undefined &&
      (typeof value.hysteresis !== "number" ||
        !Number.isFinite(value.hysteresis) ||
        value.hysteresis < 0 ||
        value.hysteresis >= 0.5)
    ) {
      throw new Error(
        `TN_ASSETS_CONFIG_INVALID: ${label}.hysteresis must be a finite number in [0, 0.5).`,
      );
    }
    return {
      ...(value.maxPixelError === undefined
        ? {}
        : { maxPixelError: value.maxPixelError as number }),
      ...(value.hysteresis === undefined ? {} : { hysteresis: value.hysteresis as number }),
    };
  };
  const override = (value: unknown, label: string): boolean | IModelLodOverride => {
    if (typeof value === "boolean") return value;
    if (!isRecord(value)) throw new Error(`TN_ASSETS_CONFIG_INVALID: ${label} must be an object.`);
    for (const key of Object.keys(value)) {
      if (key !== "enabled" && key !== "generation" && key !== "preset" && key !== "runtime") {
        throw new Error(`TN_ASSETS_CONFIG_UNKNOWN_KEY: ${label}.${key} is not recognised.`);
      }
    }
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
      throw new Error(`TN_ASSETS_CONFIG_INVALID: ${label}.enabled must be a boolean.`);
    }
    return {
      ...(value.enabled === undefined ? {} : { enabled: value.enabled as boolean }),
      ...(value.generation === undefined
        ? {}
        : { generation: generation(value.generation, `${label}.generation`) }),
      ...(value.preset === undefined
        ? {}
        : { preset: presetValue(value.preset, `${label}.preset`) }),
      ...(value.runtime === undefined
        ? {}
        : { runtime: runtimeValue(value.runtime, `${label}.runtime`) }),
    };
  };
  const overrides: Record<string, boolean | IModelLodOverride> = {};
  if (raw.overrides !== undefined) {
    if (!isRecord(raw.overrides))
      throw new Error("TN_ASSETS_CONFIG_INVALID: assets.lod.overrides must be an object.");
    for (const [key, value] of Object.entries(raw.overrides))
      overrides[key] = override(value, `assets.lod.overrides['${key}']`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new Error("TN_ASSETS_CONFIG_INVALID: assets.lod.enabled must be a boolean.");
  }
  return {
    ...(raw.enabled === undefined ? {} : { enabled: raw.enabled as boolean }),
    ...(raw.generation === undefined
      ? {}
      : { generation: generation(raw.generation, "assets.lod.generation") }),
    ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
    ...(raw.preset === undefined ? {} : { preset: presetValue(raw.preset, "assets.lod.preset") }),
    ...(raw.runtime === undefined
      ? {}
      : { runtime: runtimeValue(raw.runtime, "assets.lod.runtime") }),
  };
}

export function parseLightmap(raw: unknown): ILightmapPassOptions {
  if (!isRecord(raw)) {
    throw new Error("TN_ASSETS_CONFIG_INVALID: assets.models.lightmap must be an object.");
  }
  for (const key of Object.keys(raw)) {
    if (!LIGHTMAP_CONFIG_KEYS.includes(key)) {
      throw new Error(
        `TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.models.lightmap.${key} is not recognised.`,
      );
    }
  }
  if (!Number.isSafeInteger(raw.atlasSize) || (raw.atlasSize as number) <= 0) {
    throw new Error(
      "TN_ASSETS_CONFIG_INVALID: assets.models.lightmap.atlasSize must be a positive integer.",
    );
  }
  if ((raw.atlasSize as number) % 4 !== 0) {
    throw new Error(
      "TN_ASSETS_CONFIG_INVALID: assets.models.lightmap.atlasSize must be a multiple of 4.",
    );
  }
  if (!Number.isSafeInteger(raw.padding) || (raw.padding as number) <= 0) {
    throw new Error(
      "TN_ASSETS_CONFIG_INVALID: assets.models.lightmap.padding must be a positive integer.",
    );
  }
  return { atlasSize: raw.atlasSize as number, padding: raw.padding as number };
}

export function parseModelPasses(raw: unknown): IModelPassesOptions {
  if (!isRecord(raw)) {
    throw new Error("TN_ASSETS_CONFIG_INVALID: assets.models.passes must be an object.");
  }
  for (const key of Object.keys(raw)) {
    if (!MODEL_PASS_KEYS.includes(key)) {
      throw new Error(
        `TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.models.passes.${key} is not recognised.`,
      );
    }
    if (typeof raw[key] !== "boolean") {
      throw new Error(`TN_ASSETS_CONFIG_INVALID: assets.models.passes.${key} must be a boolean.`);
    }
  }
  return raw as IModelPassesOptions;
}

export function parseModelQuantize(raw: unknown): IModelQuantizeOptions {
  if (!isRecord(raw)) {
    throw new Error("TN_ASSETS_CONFIG_INVALID: assets.models.quantize must be an object.");
  }
  for (const key of Object.keys(raw)) {
    if (!MODEL_QUANTIZE_KEYS.includes(key)) {
      throw new Error(
        `TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.models.quantize.${key} is not recognised.`,
      );
    }
    // Depths low enough to visibly warp a model are accepted, not rejected: the pass's own
    // self-verification fails the build naming the drift instead of a config rule guessing.
    if (
      typeof raw[key] !== "number" ||
      !Number.isSafeInteger(raw[key]) ||
      (raw[key] as number) < 1 ||
      (raw[key] as number) > 16
    ) {
      throw new Error(
        `TN_ASSETS_CONFIG_INVALID: assets.models.quantize.${key} must be an integer between 1 and 16 bits.`,
      );
    }
  }
  return raw as IModelQuantizeOptions;
}

/**
 * The effective `models.textures` for a target after capability filtering.
 *
 * A target with the KTX2 decoder keeps the configured compression. Without one, an explicitly
 * declared `maxSize` still has to reach the artifact, so the pass resizes embedded images to
 * PNG instead of encoding them; `"none"`, absent, and a config with no cap keep shipping the
 * authored bytes exactly as before. The per-slot overrides ride along for the same reason they do
 * on the standalone path: a `codec: "none"` slot is a project asking for its authored bytes, and a
 * cap is a decision about the project's *other* textures.
 */
export function embeddedTexturesFor(
  configured: IModelTexturesOptions | "none" | undefined,
  ktx2: boolean,
  astc = false,
  webp = false,
): { readonly textures?: IModelTexturesOptions | "none" } {
  if (astc && configured !== "none") return { textures: { ...configured, astc: true } };
  // A target whose runtimes all decode WebP keeps an authored WebP a KTX2 cannot undercut (PRD-867).
  if (ktx2) return webp && configured !== "none" ? { textures: { ...configured, webp: true } } : {};
  if (configured !== undefined && configured !== "none" && configured.maxSize !== undefined) {
    return {
      textures: {
        decoderFree: true,
        maxSize: configured.maxSize,
        ...(configured.overrides === undefined ? {} : { overrides: configured.overrides }),
      },
    };
  }
  return { textures: "none" as const };
}
