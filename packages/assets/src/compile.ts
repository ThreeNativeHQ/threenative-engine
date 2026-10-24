import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { assertBudget, measureBudget, parseBudget } from "./budget.js";
import type { IAssetBudget, IAssetRuntimeDecoderCapabilities } from "./budget.js";
import {
  ASSETS_CONFIG_KEYS,
  LIGHTMAP_CONFIG_KEYS,
  MODELS_CONFIG_KEYS,
  MODEL_PASS_KEYS,
  MODEL_QUANTIZE_KEYS,
  MODEL_VIRTUAL_COUNT_KEYS,
  MODEL_VIRTUAL_KEYS,
} from "./config-keys.js";
import {
  type IModelDedupeSummary,
  formatModelDedupe,
  groupModelSources,
} from "./content/model-dedupe.js";
import { formatHealthReport, runHealthReport } from "./health.js";
import type { IAssetHealthInput, IAssetHealthReport } from "./health.js";
import { readTextureQuality, resolveImageQualityFloor } from "./image-quality.js";
import {
  type IModelLodOptions,
  type IModelLodOverride,
  type IModelLodRuntimeOptions,
  type LodMinTrianglesScope,
  type LodPreset,
  isLodPreset,
  resolveLodPolicy,
} from "./lod/generate.js";
import {
  type INativePackageEntry,
  NATIVE_PACKAGE_NAME,
  NativeEntryKind,
  WGPU_TEXTURE_FORMAT_RGBA8_UNORM,
  writeNativePackage,
} from "./native-package.js";
import { applyPasses } from "./pass-chain.js";
import type { IAppliedPasses, IPassTiming } from "./pass-chain.js";
import { parseAudioConfig } from "./passes/audio-config.js";
import type { IAudioOverride, IAudioPassOptions } from "./passes/audio-config.js";
import { audioPass } from "./passes/audio.js";
import {
  BLENDER_IMPORT_PASS,
  blenderImportPass,
  needsBlenderImport,
} from "./passes/blender-import.js";
import type {
  IModelCompactInstanceOptions,
  IModelCompactOptions,
  IModelCompactSummary,
} from "./passes/compact.js";
import { decodeImageBytes } from "./passes/decode-image.js";
import { globMatch } from "./passes/glob.js";
import { createLightmapPass } from "./passes/lightmap.js";
import type { ILightmapPassOptions } from "./passes/lightmap.js";
import { TEXTURE_SIZE_SLOTS, type TextureMaxSize } from "./passes/model-textures.js";
import { modelPass } from "./passes/model.js";
import type {
  IModelPassOptions,
  IModelPassesOptions,
  IModelQuantizeOptions,
  IModelSimplifyOptions,
  IModelTextureOverride,
  IModelTexturesOptions,
  IModelVirtualOptions,
} from "./passes/model.js";
import { createSharedImageStore, unpackGlb } from "./passes/shared-images.js";
import { texturePass, textureResizePass } from "./passes/texture.js";
import type { ITextureOverride, ITexturePassOptions, TextureSkipReason } from "./passes/texture.js";
import { parsePng } from "./png.js";
import {
  formatAudioSizes,
  formatBudget,
  formatModelSizes,
  formatPassCosts,
  formatSkippedCompression,
  formatTextureQualityTotals,
  formatTextureRungs,
  formatTextureSizes,
} from "./report.js";
import type {
  IAudioRow,
  IEmbeddedTextureRow,
  ILodJoinedGroupRow,
  ILodJoinedRow,
  ILodRow,
  IMaterialsRow,
  IModelSizeRow,
  IPassCostAssetRow,
  IPassCostRow,
  ISimplifyRow,
  ISkippedCompressionRow,
  ISkippedReportRow,
  ITextureSizeRow,
  PassCostStatus,
} from "./report.js";
import { createPassPool, resolveConcurrency } from "./worker-pool.js";
import type { PassSpec } from "./worker-protocol.js";
import {
  applyProxiesToWorld,
  cookWorldProxies,
  formatWorldHlod,
  readWorldPackage,
} from "./world/proxy.js";

export type AssetKind = "audio" | "model" | "other" | "texture";

/** Budgets a project declares for its assets; exceeding one fails the build. */
export interface IAssetTargets {
  readonly maxMaterials?: number;
  readonly maxTriangles?: number;
  readonly maxTextureDimension?: number;
}

/**
 * What a pass produced for one input. A plain `Buffer` return keeps the identity semantics;
 * the richer shape lets a pass rename the output extension and declare manifest fields for
 * the input it transformed (the KTX2 pass records `format` and `transcodeTargets`).
 */
export interface IAssetPassOutput {
  readonly auxiliaryOutputs?: readonly IAssetAuxiliaryOutput[];
  readonly buffer: Buffer;
  /** Extra manifest fields merged into the entry for the input this output came from. */
  readonly entry?: Readonly<Record<string, unknown>>;
  /** Replaces the source extension in the content-addressed output name when set. */
  readonly outputExtension?: string;
}

export interface IAssetAuxiliaryOutput {
  readonly buffer: Buffer;
  readonly extension: string;
  /** Manifest array receiving this output, for example `lightmaps`. */
  readonly manifestField: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * An output the pass already content-addressed itself, relative to the output root — the
   * shared image several models reference by the same relative URL. Absent means the compile
   * names it `<stem>.<role>.<digest><extension>` beside the input's own output.
   */
  readonly outputPath?: string;
  /** Stable filename segment, for example `lightmap`. */
  readonly role: string;
}

export interface IAssetPass {
  /** Deterministic settings that change output bytes; omitted for identity/default passes. */
  readonly cacheKey?: string;
  /** True when this pass's emitted output requires a runtime decoder unavailable on mobile. */
  readonly needsRuntimeDecoder?: boolean;
  readonly name: string;
  /**
   * Input kinds whose bytes this pass can change. The compile hashes only the passes that can
   * change an asset into that asset's digest, so a model-only option edit does not rename every
   * texture. `undefined` (the default for a caller-supplied pass) means any kind, which stays
   * conservative: an unknown pass can change every asset.
   */
  readonly appliesTo?: readonly AssetKind[];
  /**
   * JSON-serializable snapshot of every option that changes this pass's output. Part of the
   * compile cache key: without it, editing a config value (texture quality, quantize bits, an
   * override's codec) leaves the pass name and input hash untouched and the stale output is
   * re-served forever. `undefined` for passes without options.
   */
  readonly configuration?: Readonly<Record<string, unknown>>;
  apply(
    input: Buffer,
    logicalPath: string,
  ): Buffer | IAssetPassOutput | Promise<Buffer | IAssetPassOutput>;
}

export interface IAssetSourceConfig {
  readonly budget?: Partial<IAssetBudget> | number | "none";
  /** Source-relative globs omitted from the build; excluded bytes are always reported. */
  readonly exclude?: readonly string[];
  /**
   * Audio conditioning: an object of options, or the string `"none"` to ship every clip exactly
   * as committed. Absent means conditioning runs with defaults. See `passes/audio-config.ts` for
   * how a game declares which clips loop, which are positional, and what a clip is for.
   */
  readonly audio?: IAudioConfig | "none";
  /**
   * The bound on how many workers a bake may use. A direct `concurrency` option overrides it;
   * absent means the driver's default (cores - 1, bounded by ~2 GB of memory a worker, at most 12). CI boxes and laptops differ, and
   * a 6.8 GB pack does not get to decide the machine's fate.
   */
  readonly concurrency?: number;
  /**
   * Model optimization: an object of options, or the string `"none"` to ship every model
   * exactly as committed. Absent means optimization runs with defaults.
   */
  readonly models?: IModelsConfig | "none";
  /**
   * Automatic discrete LOD (`assets.lod`): a boolean kill switch/enable, an object carrying the
   * resolved generation policy, or `"none"`. Absent means this phase generates nothing; the
   * default-on decision is a later phase (PRD-377 §8).
   */
  readonly lod?: boolean | IModelLodOptions | "none";
  /**
   * Also writes the native cooked package (`<output>/native/assets.tnpk`, TNPK v1) beside the
   * existing outputs: one Buffer entry per cooked binary buffer and one Texture entry per cooked
   * PNG or JPEG (decoded to RGBA8). Mesh, material and scene entries are out of scope until their
   * native loaders land.
   * Absent means off, so a web-only project pays nothing.
   */
  readonly nativePackage?: boolean;
  readonly output?: string;
  readonly source?: string;
  readonly targets?: IAssetTargets;
  /**
   * Texture compression: an object of options, or the string `"none"` to ship every texture
   * exactly as committed. Absent means compression runs with defaults.
   */
  readonly textures?: ITexturesConfig | "none";
}

export interface IModelsConfig {
  /**
   * Lossless scene-graph compaction (flatten → instance → join) against one protected-node set.
   * Default true ({@link IModelCompactOptions}); `false` ships the scene graph as authored.
   */
  readonly compact?: boolean | IModelCompactOptions;
  /** Generate standard TEXCOORD_1 lightmap UVs. Absent means no lightmap pass. */
  readonly lightmap?: ILightmapPassOptions;
  readonly passes?: IModelPassesOptions;
  readonly quantize?: IModelQuantizeOptions;
  /**
   * Write each distinct embedded image once under `shared/images/` and reference it from every
   * model that carries it, instead of embedding a copy in each. A marketplace pack's eight pines
   * stop shipping eight copies of the same bark map, and a rebuild reuses last build's encodes.
   * Default true: the served GLB references files beside it, which a host must serve. False
   * keeps each model self-contained and reports the duplicated embedded-image byte cost.
   */
  readonly sharedImages?: boolean;
  /** LOD simplification. Absent means none: it is the one lossy stage, and it is opt-in. */
  readonly simplify?: IModelSimplifyOptions;
  /**
   * Compression of the images embedded in a model, or the string `"none"` to ship them
   * exactly as authored. Absent means compression runs with defaults.
   */
  readonly textures?: IModelTexturesOptions | "none";
  /**
   * Cluster-DAG bake for virtual geometry, or `"none"` to ship every primitive as authored.
   * Absent means the bake runs with defaults, which clusters any primitive of 65,536 triangles
   * or more and leaves everything below it byte-identical.
   */
  readonly virtual?: IModelVirtualOptions | "none";
}

export interface IAudioConfig {
  readonly normalise?: "ceiling" | "peak";
  readonly overrides?: readonly IAudioOverride[];
  readonly peakDb?: number;
  readonly quality?: number;
  readonly seamMaxRatio?: number;
}

export interface ITexturesConfig {
  readonly floor?: ITexturePassOptions["floor"];
  readonly maxSize?: TextureMaxSize;
  readonly overrides?: readonly ITextureOverride[];
  readonly quality?: number;
}

export interface IAssetCompileOptions {
  readonly concurrency?: number;
  readonly config?: IAssetSourceConfig;
  readonly cwd?: string;
  /** Includes the machine-readable health report on the result. */
  readonly health?: boolean;
  readonly output?: string;
  /**
   * Replaces the built-in pass registry when provided; left undefined, the built-in
   * registry (the KTX2 texture pass) runs unless `config.textures` is `"none"`.
   */
  readonly passes?: readonly IAssetPass[];
  /**
   * The order inputs are processed in, which under a scheduler is the order their work
   * completes. `"sorted"` (the default) is the documented behaviour; `"reversed"` exists for
   * the determinism gate, which must be able to run the same inputs through the driver in a
   * different completion order and compare every emitted byte. It is a test seam, not a
   * project setting, and a game config never carries it.
   */
  readonly processingOrder?: "reversed" | "sorted";
  /**
   * The conservative default decoder policy: web/desktop keep the existing loaders;
   * Android/iOS stay decoder-free until their packaged loaders are qualified. A V8 engine
   * alone does not establish a working Basis, Meshopt or Draco path. Absent means web.
   * Native builds provide runtimeDecoders from their selected artifact instead.
   */
  readonly platform?: "android" | "desktop" | "ios" | "web";
  /** Which compressed outputs the selected runtime's bundle can decode, independently of WASM. */
  readonly runtimeDecoders?: IAssetRuntimeDecoderCapabilities;
  /** Exact selected runtime/cohort identity; changing it invalidates cooked output. */
  readonly runtimeIdentity?: string;
  readonly source?: string;
  /** Overrides resolution of three's Basis transcoder for the copy into the output root. */
  readonly transcoder?: IBasisTranscoder;
  /**
   * Internal: the bytes an embedded model image must save before KTX2 pays for the shared Basis
   * transcoder. Absent charges the measured default; a caller that already ships the transcoder
   * passes 0.
   */
  readonly modelTranscoderBytes?: number;
}

export interface IBasisTranscoder {
  readonly javascriptPath: string;
  readonly wasmPath: string;
}

export interface IAssetCompileResult {
  /** How many workers the driver actually used: 1 for a sequential bake (custom passes, or a bound of 1). */
  readonly concurrencyUsed: number;
  /** One cost row per pass, driver-measured; empty when no bake ran. */
  readonly passCosts: readonly IPassCostRow[];
  /**
   * What built-in compression shipped uncompressed, plus caller-supplied decoder-dependent passes
   * omitted for this target as `kind: "pass"` rows. Turning a convention off does not turn its
   * measurement off.
   */
  readonly skippedCompression: readonly ISkippedReportRow[];
  readonly receipt?: IBakeReceipt;
  readonly report?: IAssetHealthReport;
  /**
   * What the model cook saved by cooking content-identical sources once, when this project has
   * any model source. `cooked` is the number of distinct outputs those sources produced.
   */
  readonly dedupe?: IModelDedupeSummary;
  readonly skipped: number;
  readonly written: number;
}

/** One file this bake owns, and where it came from. */
export interface IBakeReceiptOutput {
  readonly bytes: number;
  /** Path relative to the output root, with `/` separators on every platform. */
  readonly path: string;
  /** The producer: the pass chain for a compiled input, or the auxiliary output's own role. */
  readonly producer: string;
  /** The source asset this came from, or `null` for a file the bake ships on its own behalf. */
  readonly source: string | null;
}

/**
 * Everything the bake wrote, so the delete-test can remove exactly that and nothing else.
 *
 * Deterministic given the same inputs — no wall-clock field — because this repository proves a
 * change is neutral by diffing emitted output, and a timestamp makes every such diff dirty.
 */
export interface IBakeReceipt {
  readonly outputs: readonly IBakeReceiptOutput[];
  readonly pipelineVersion: number;
}

interface IAssetManifestEntry {
  readonly quality?: import("./image-quality.js").ITextureQuality;
  readonly compressionSkipped?: TextureSkipReason;
  /** What the audio pass measured and did to one clip. */
  readonly audio?: IAudioRow;
  readonly bytes: number;
  readonly bytesAfter?: number;
  readonly bytesBefore?: number;
  /** What the model pass did to the images inside a `.glb` (model pass). */
  readonly embeddedTextures?: IEmbeddedTextureRow;
  /** Requested against achieved LOD simplification (model pass). */
  readonly simplify?: ISimplifyRow;
  /** Automatic discrete LOD generation, when the effective policy ran (model pass). */
  readonly lod?: ILodRow;
  /** Lossless scene-graph compaction (PRD-443), when it ran (model pass). */
  readonly compact?: IModelCompactSummary;
  /** The cook's material merge, counted either side of it (PRD-458 §5). */
  readonly materials?: IMaterialsRow;
  /** Extensions the compiled output declares (model pass), sorted. */
  readonly extensions?: readonly string[];
  readonly format?: string;
  /** The source extension a GLB was converted from (`fbx`, `blend`, `obj`, `dae`), so a report can
   * say a model was converted rather than authored. Absent for a model the game shipped as glTF. */
  readonly importedFrom?: string;
  readonly kind: AssetKind;
  readonly lightmapAtlas?: Readonly<Record<string, unknown>>;
  readonly lightmaps?: readonly Readonly<Record<string, unknown>>[];
  readonly output: string;
  readonly passes: string[];
  /** Triangle count of the compiled output (model pass). */
  readonly triangles?: number;
  readonly transcodeTargets?: readonly string[];
  /** Vertex count of the compiled output (model pass). */
  readonly vertices?: number;
}

interface IAssetManifest {
  readonly entries: Record<string, IAssetManifestEntry>;
  readonly version: 1;
}

/**
 * What one cook contributes to the manifest, the receipt, the health report and the size report.
 *
 * A source that shares its content with an earlier one is not cooked; it publishes this record
 * unchanged apart from the bytes its own source weighed, so one output serves both.
 */
interface ICookedModel {
  readonly auxiliary: readonly {
    readonly bytes: number;
    readonly path: string;
    readonly producer: string;
  }[];
  readonly entry: IAssetManifestEntry;
  readonly lightmap: IModelSizeRow["lightmap"] | undefined;
  readonly measured: Buffer;
}

interface ICompileLayout {
  readonly budget: IAssetBudget;
  readonly exclude: readonly string[];
  /** True when the built-in pass registry is in play — a caller that supplied its own opted out of nothing. */
  readonly builtinRegistry: boolean;
  /** `assets.concurrency` from the game config, when it declared one. */
  readonly concurrency: number | undefined;
  readonly runtimeDecoderCapabilities: IAssetRuntimeDecoderCapabilities;
  readonly outputRoot: string;
  /** The built-in registry's serialisable mirror; empty when the caller supplied passes. */
  readonly passSpecs: readonly PassSpec[];
  /** Names of caller-supplied decoder-dependent passes omitted on a target without a decoder. */
  readonly skippedPasses: readonly string[];
  readonly passes: readonly IAssetPass[];
  readonly sourceRoot: string;
  readonly targets: IAssetTargets;
  /** The validated `assets.lod` block, kept so a cache hit can refresh its runtime half. */
  readonly lod: boolean | IModelLodOptions | "none" | undefined;
  /** The legacy `assets.models` declarations the LOD policy translates against, per project. */
  readonly lodLegacy: { readonly simplify: boolean; readonly virtualNone: boolean };
  /** True when the built-in KTX2 pass is part of `passes` (drives the transcoder copy). */
  readonly texturesActive: boolean;
  /** Why the model's decoder-backed sub-passes were not emitted, if they were skipped. */
  readonly modelCompressionReason: ISkippedCompressionRow["reason"] | undefined;
  /** The model decoder-backed sub-passes that were enabled before the target filtered them. */
  readonly modelCompressionDecoders: readonly ("meshopt" | "KTX2")[];
  /** True when `assets.nativePackage` asked for the TNPK output beside the existing outputs. */
  readonly nativePackage: boolean;
  /** Why the standalone texture pass was not emitted, if it was skipped. */
  readonly textureCompressionReason: ISkippedCompressionRow["reason"] | undefined;
}

interface IDirectoryScan {
  readonly files: string[];
  readonly subdirectories: string[];
}

const MANIFEST_NAME = "assets.manifest.json";
/**
 * What this bake produced, written by the producer so nothing downstream has to guess.
 *
 * The delete-test — remove every baked file and the game still runs, just slower — is the rule
 * that separates a baking pass from a compiler of game meaning. A test driven by a directory glob
 * would either miss an output or delete a source asset, and both failures look like a pass, so the
 * step that wrote the files is the one that lists them. **Nothing in the shipped runtime reads
 * this file**; deleting it is part of the test.
 */
const RECEIPT_NAME = "bake.receipt.json";
/** Files emitted after the last successful receipt, retained so a failed cook can be recovered. */
const PENDING_RECEIPT_NAME = ".bake.pending-receipt.json";
const DEFAULT_SOURCE = "assets";
const DEFAULT_OUTPUT = "public";
const BASIS_DIRECTORY = "basis";
/** Declared by a model whose embedded images were transcoded; the runtime needs the transcoder. */
const BASISU_EXTENSION = "KHR_texture_basisu";
/**
 * Baked into every output hash so a future change to how passes behave invalidates previously
 * compiled outputs even when pass names are unchanged. Bump it when a pass's behaviour changes.
 * v2: textures encode to KTX2 instead of passing through byte-identical.
 * v3: models run dedup/prune/reorder/quantize/meshopt instead of passing through byte-identical.
 * v7: the images embedded in a model are transcoded to KTX2 and capped in resolution.
 * v8: every compile writes `bake.receipt.json` beside the manifest, so the run has one additional
 * output and a cached `public/` from v7 has no receipt to delete.
 * v9: audio is conditioned and encoded to Ogg Vorbis instead of passing through byte-identical,
 * so every audio output from v8 has the wrong extension and the wrong bytes.
 * v10: a decoder-free target honours a declared `textures.maxSize`/`models.textures.maxSize` by
 * resampling to PNG, and the cache digest is per-asset kind instead of one global pass list.
 */
const PIPELINE_VERSION = 10;

const KIND_BY_EXTENSION: Readonly<Record<string, AssetKind>> = {
  // Converted to GLB by `blenderImportPass` before `modelPass` sees them. Until PRD-346 these four
  // classified as "other", were copied through untouched, and the build reported success on a file
  // no runtime can load.
  blend: "model",
  dae: "model",
  fbx: "model",
  glb: "model",
  gltf: "model",
  obj: "model",
  jpeg: "texture",
  jpg: "texture",
  mp3: "audio",
  ogg: "audio",
  png: "texture",
  wav: "audio",
  webp: "texture",
};

const CODECS: readonly string[] = ["etc1s", "none", "uastc"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrows a pass's embedded-texture summary to the manifest shape by reading every field it
 * declares. A cast would let a pass that changed its own summary write nonsense into the
 * manifest the runtime and the report both read; this drops anything that is not a number.
 */
function simplifyRow(value: unknown): ISimplifyRow | undefined {
  if (!isRecord(value)) return undefined;
  const keys = [
    "achievedRatio",
    "error",
    "requestedRatio",
    "trianglesAfter",
    "trianglesBefore",
  ] as const;
  if (keys.some((key) => typeof value[key] !== "number")) return undefined;
  return {
    achievedRatio: value.achievedRatio as number,
    error: value.error as number,
    requestedRatio: value.requestedRatio as number,
    trianglesAfter: value.trianglesAfter as number,
    trianglesBefore: value.trianglesBefore as number,
  };
}

function compactRow(value: unknown): IModelCompactSummary | undefined {
  if (!isRecord(value)) return undefined;
  const flatten = value.flatten;
  const instance = value.instance;
  const join = value.join;
  if (!isRecord(flatten) || !isRecord(instance) || !isRecord(join)) return undefined;

  if (typeof flatten.enabled !== "boolean" || typeof flatten.reparented !== "number") {
    return undefined;
  }
  if (
    typeof instance.batches !== "number" ||
    typeof instance.enabled !== "boolean" ||
    typeof instance.instances !== "number" ||
    (instance.reason !== undefined && typeof instance.reason !== "string")
  ) {
    return undefined;
  }
  if (
    typeof join.enabled !== "boolean" ||
    typeof join.primitivesAfter !== "number" ||
    typeof join.primitivesBefore !== "number"
  ) {
    return undefined;
  }

  const nodesAfter = value.nodesAfter;
  const nodesBefore = value.nodesBefore;
  const primitivesAfter = value.primitivesAfter;
  const primitivesBefore = value.primitivesBefore;
  if (
    typeof nodesAfter !== "number" ||
    typeof nodesBefore !== "number" ||
    typeof primitivesAfter !== "number" ||
    typeof primitivesBefore !== "number"
  ) {
    return undefined;
  }

  if (!Array.isArray(value.removed) || !Array.isArray(value.protected)) return undefined;
  const removed: string[] = [];
  for (const name of value.removed) {
    if (typeof name !== "string") return undefined;
    removed.push(name);
  }

  const protectedNodes: IModelCompactSummary["protected"][number][] = [];
  for (const entry of value.protected) {
    if (!isRecord(entry) || typeof entry.name !== "string") return undefined;
    const rule = entry.rule;
    if (
      rule !== "allow-list" &&
      rule !== "animation-ancestor" &&
      rule !== "animation-target" &&
      rule !== "regex" &&
      rule !== "skin-joint"
    ) {
      return undefined;
    }
    protectedNodes.push({ name: entry.name, rule });
  }

  return {
    flatten: { enabled: flatten.enabled, reparented: flatten.reparented },
    instance: {
      batches: instance.batches,
      enabled: instance.enabled,
      instances: instance.instances,
      ...(instance.reason === undefined ? {} : { reason: instance.reason }),
    },
    join: {
      enabled: join.enabled,
      primitivesAfter: join.primitivesAfter,
      primitivesBefore: join.primitivesBefore,
    },
    nodesAfter,
    nodesBefore,
    primitivesAfter,
    primitivesBefore,
    removed,
    protected: protectedNodes,
  };
}

function materialRow(value: unknown): IMaterialsRow | undefined {
  if (!isRecord(value)) return undefined;
  const counts = (key: "distinct" | "materials"): { after: number; before: number } | undefined => {
    const side = value[key];
    if (
      !isRecord(side) ||
      typeof side.after !== "number" ||
      typeof side.before !== "number" ||
      !Number.isFinite(side.after) ||
      !Number.isFinite(side.before)
    ) {
      return undefined;
    }
    return { after: side.after, before: side.before };
  };
  const distinct = counts("distinct");
  const materials = counts("materials");
  if (distinct === undefined || materials === undefined) return undefined;
  if (!Array.isArray(value.merged) || value.merged.some((name) => typeof name !== "string"))
    return undefined;
  return { distinct, materials, merged: value.merged as string[] };
}

function lodRow(value: unknown): ILodRow | undefined {
  if (!isRecord(value)) return undefined;
  const numbers = [
    "byteOverhead",
    "generated",
    "levels",
    "maxLevels",
    "minSaving",
    "minTriangles",
    "skipped",
    "trianglesAfter",
    "trianglesBefore",
  ] as const;
  if (numbers.some((key) => typeof value[key] !== "number")) return undefined;
  if (
    typeof value.fingerprint !== "string" ||
    typeof value.preset !== "string" ||
    typeof value.minTrianglesScope !== "string"
  ) {
    return undefined;
  }
  const errorTargets = value.errorTargets;
  if (
    !Array.isArray(errorTargets) ||
    errorTargets.some((target) => typeof target !== "number" || !Number.isFinite(target))
  ) {
    return undefined;
  }
  if (!isRecord(value.runtime)) return undefined;
  const runtime = value.runtime;
  if (
    typeof runtime.hysteresis !== "number" ||
    typeof runtime.maxPixelError !== "number" ||
    !Number.isFinite(runtime.hysteresis) ||
    !Number.isFinite(runtime.maxPixelError)
  ) {
    return undefined;
  }
  const strings = (key: "reasons" | "diagnostics"): string[] | undefined => {
    const array = value[key];
    if (!Array.isArray(array)) return undefined;
    // The pass reports diagnostics as `{ code, message, path }`; the manifest keeps the codes.
    const codes = array.map((entry) =>
      typeof entry === "string"
        ? entry
        : isRecord(entry) && typeof entry.code === "string"
          ? entry.code
          : undefined,
    );
    return codes.every((entry): entry is string => entry !== undefined) ? codes : undefined;
  };
  const reasons = strings("reasons");
  const diagnostics = strings("diagnostics");
  if (reasons === undefined || diagnostics === undefined) return undefined;
  // The joined rung is optional and additive; a malformed one is dropped rather than failing the
  // manifest, because it is a report about the bake, not the bake itself.
  const joined = ((): ILodJoinedRow | undefined => {
    const raw = value.joined;
    if (!isRecord(raw)) return undefined;
    if (
      typeof raw.draws !== "number" ||
      typeof raw.primitives !== "number" ||
      typeof raw.triangles !== "number" ||
      typeof raw.trianglesBefore !== "number" ||
      !Array.isArray(raw.groups)
    ) {
      return undefined;
    }
    const groups: ILodJoinedGroupRow[] = [];
    for (const group of raw.groups) {
      if (
        !isRecord(group) ||
        typeof group.material !== "string" ||
        typeof group.primitives !== "number" ||
        typeof group.triangles !== "number"
      ) {
        return undefined;
      }
      groups.push({
        material: group.material,
        primitives: group.primitives,
        triangles: group.triangles,
      });
    }
    return {
      draws: raw.draws,
      groups,
      primitives: raw.primitives,
      triangles: raw.triangles,
      trianglesBefore: raw.trianglesBefore,
    };
  })();
  return {
    byteOverhead: value.byteOverhead as number,
    diagnostics,
    errorTargets: errorTargets as number[],
    fingerprint: value.fingerprint,
    generated: value.generated as number,
    join: value.join === true,
    ...(joined === undefined ? {} : { joined }),
    levels: value.levels as number,
    maxLevels: value.maxLevels as number,
    minSaving: value.minSaving as number,
    minTriangles: value.minTriangles as number,
    minTrianglesScope: value.minTrianglesScope as string,
    preset: value.preset,
    reasons,
    runtime: { hysteresis: runtime.hysteresis, maxPixelError: runtime.maxPixelError },
    skipped: value.skipped as number,
    trianglesAfter: value.trianglesAfter as number,
    trianglesBefore: value.trianglesBefore as number,
    // A malformed cutout report is dropped whole, like `joined`: it is a report about the bake.
    ...(isRecord(value.cutout) && Array.isArray(value.cutout.converted)
      ? {
          cutout: {
            converted: value.cutout.converted.filter(
              (name): name is string => typeof name === "string",
            ),
            kept: Array.isArray(value.cutout.kept)
              ? value.cutout.kept.filter(
                  (entry): entry is { name: string; reason: string } =>
                    isRecord(entry) &&
                    typeof entry.name === "string" &&
                    typeof entry.reason === "string",
                )
              : [],
          },
        }
      : {}),
  };
}

function embeddedTextureRow(value: unknown): IEmbeddedTextureRow | undefined {
  if (!isRecord(value)) return undefined;
  const numbers = [
    "bytesAfter",
    "bytesBefore",
    "count",
    "gpuBytesAfter",
    "gpuBytesBefore",
    "resized",
  ] as const;
  if (numbers.some((key) => typeof value[key] !== "number")) return undefined;
  const formats = isRecord(value.formats)
    ? Object.fromEntries(
        Object.entries(value.formats).filter(([, codec]) => typeof codec === "string"),
      )
    : undefined;
  return {
    ...(isRecord(value.quality)
      ? {
          quality: Object.fromEntries(
            Object.entries(value.quality).map(([key, score]) => {
              const parsed = readTextureQuality(score);
              if (parsed === undefined)
                throw new Error(`TN_ASSETS_QUALITY_MISSING: invalid score for '${key}'.`);
              return [key, parsed];
            }),
          ),
        }
      : {}),
    bytesAfter: value.bytesAfter as number,
    bytesBefore: value.bytesBefore as number,
    count: value.count as number,
    ...(formats === undefined ? {} : { formats: formats as Record<string, string> }),
    ...(isRecord(value.skippedCompression)
      ? {
          skippedCompression: Object.fromEntries(
            Object.entries(value.skippedCompression).filter(
              ([, reason]) =>
                reason === "block-size" || reason === "not-smaller" || reason === "below-floor",
            ),
          ) as Record<string, TextureSkipReason>,
        }
      : {}),
    gpuBytesAfter: value.gpuBytesAfter as number,
    gpuBytesBefore: value.gpuBytesBefore as number,
    resized: value.resized as number,
  };
}

/**
 * Narrows the audio pass's summary to the manifest shape by reading every field it declares.
 *
 * Same reason as `simplifyRow` above: a cast would let a pass that changed its own summary write
 * nonsense into the manifest and the report both read from. Anything missing a required field is
 * dropped whole rather than half-recorded.
 */
function audioRow(value: unknown): IAudioRow | undefined {
  if (!isRecord(value)) return undefined;
  const numbers = [
    "bandAir",
    "bandHigh",
    "bandLow",
    "bandMid",
    "bandSub",
    "bytesAfter",
    "bytesBefore",
    "channelsAfter",
    "channelsBefore",
    "dcOffsetAfter",
    "dcOffsetBefore",
    "decodedBytesAfter",
    "decodedBytesBefore",
    "durationSeconds",
    "frames",
    "peakAfter",
    "peakBefore",
    "sampleRate",
    "seamNearP99",
    "seamRatio",
    "seamRatioBefore",
    "seamWrap",
    "seamWrapBefore",
  ] as const;
  if (numbers.some((key) => typeof value[key] !== "number")) return undefined;
  const flags = ["conditioned", "loop", "reencoded"] as const;
  if (flags.some((key) => typeof value[key] !== "boolean")) return undefined;
  if (typeof value.container !== "string" || typeof value.logicalPath !== "string")
    return undefined;
  // Present only when the game declared the thing they describe, so they are copied when they
  // are numbers and dropped when they are not — never defaulted, because a bound nobody declared
  // must not appear in the manifest as though someone had.
  const optional = [
    "crossFadeMs",
    "crossFadeMsRequested",
    "seamMaxRatio",
    "spectrumMaxPercent",
    "spectrumMinPercent",
    "spectrumPercent",
  ] as const;
  return {
    ...(Object.fromEntries(
      optional.flatMap((key) => (typeof value[key] === "number" ? [[key, value[key]]] : [])),
    ) as Record<string, number>),
    ...(typeof value.spectrumBand === "string" ? { spectrumBand: value.spectrumBand } : {}),
    ...(Object.fromEntries(numbers.map((key) => [key, value[key] as number])) as Record<
      (typeof numbers)[number],
      number
    >),
    conditioned: value.conditioned,
    container: value.container,
    logicalPath: value.logicalPath,
    loop: value.loop,
    reencoded: value.reencoded,
  } as IAudioRow;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`TN_ASSETS_CONFIG_INVALID: ${label} must be a non-empty string.`);
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const TARGET_KEYS: readonly string[] = ["maxMaterials", "maxTriangles", "maxTextureDimension"];

function positiveTarget(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `TN_ASSETS_CONFIG_INVALID: assets.targets.${label} must be a positive integer.`,
    );
  }
  return value;
}

function validateTargets(raw: unknown): IAssetTargets {
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

function textureQuality(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 255) {
    throw new Error(`TN_ASSETS_CONFIG_INVALID: ${label} must be an integer between 1 and 255.`);
  }
  return value;
}

function validateTextureOverrides(raw: unknown): readonly ITextureOverride[] {
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
function parseTexturesConfig(raw: unknown): ITexturePassOptions | undefined {
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

function parseTextureMaxSize(
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

function positiveTextureSize(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 4) {
    throw new Error(`TN_ASSETS_CONFIG_INVALID: ${label} must be a positive integer of at least 4.`);
  }
  return value;
}

/** `"none"` disables the built-in model pass; an object configures it; absent means defaults. */
type ParsedModelsConfig = Omit<IModelPassOptions, "sharedImages"> & {
  readonly sharedImages: boolean;
};

function parseModelsConfig(raw: unknown): ParsedModelsConfig | undefined {
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

const MODEL_COMPACT_KEYS: readonly string[] = [
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
function parseModelCompact(raw: unknown): boolean | IModelCompactOptions {
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

const MODEL_TEXTURE_KEYS: readonly string[] = ["maxSize", "overrides", "quality", "floor"];

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `TN_ASSETS_CONFIG_INVALID: assets.models.textures.${label} must be a positive integer.`,
    );
  }
  return value;
}

/** `"none"` ships every embedded image as authored; an object configures the compression. */
function parseModelTextures(raw: unknown): IModelTexturesOptions | "none" {
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

function validateModelTextureOverrides(raw: unknown): readonly IModelTextureOverride[] {
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

function parseModelSimplify(raw: unknown): IModelSimplifyOptions {
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
function parseModelVirtual(raw: unknown): IModelVirtualOptions | "none" {
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

function parseModelLod(raw: unknown): boolean | IModelLodOptions | "none" {
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

function parseLightmap(raw: unknown): ILightmapPassOptions {
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

function parseModelPasses(raw: unknown): IModelPassesOptions {
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

function parseModelQuantize(raw: unknown): IModelQuantizeOptions {
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
function embeddedTexturesFor(
  configured: IModelTexturesOptions | "none" | undefined,
  ktx2: boolean,
  astc = false,
): { readonly textures?: IModelTexturesOptions | "none" } {
  if (astc && configured !== "none") return { textures: { ...configured, astc: true } };
  if (ktx2) return {};
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

function resolveLayout(cwd: string, options: IAssetCompileOptions): ICompileLayout {
  const config: unknown = options.config ?? {};
  if (!isRecord(config)) {
    throw new Error("TN_ASSETS_CONFIG_INVALID: assets must be an object when declared.");
  }
  for (const key of Object.keys(config)) {
    // `assets.lod` is validated and resolved by the project config loader; this package accepts
    // it so the resolved config crosses the seam intact. Phase 2 consumes it for generation.
    if (!ASSETS_CONFIG_KEYS.includes(key)) {
      throw new Error(`TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.${key} is not recognised.`);
    }
  }
  const source = options.source ?? config.source ?? DEFAULT_SOURCE;
  const exclude = config.exclude ?? [];
  if (
    !Array.isArray(exclude) ||
    exclude.some((glob) => typeof glob !== "string" || glob.trim() === "")
  ) {
    throw new Error(
      "TN_ASSETS_CONFIG_INVALID: assets.exclude must be an array of non-empty glob strings.",
    );
  }
  const output = options.output ?? config.output ?? DEFAULT_OUTPUT;
  const sourceRoot = path.resolve(cwd, nonEmptyString(source, "assets.source"));
  const outputRoot = path.resolve(cwd, nonEmptyString(output, "assets.output"));
  const nested =
    sourceRoot === outputRoot ||
    sourceRoot.startsWith(`${outputRoot}${path.sep}`) ||
    outputRoot.startsWith(`${sourceRoot}${path.sep}`);
  if (nested) {
    throw new Error(
      `TN_ASSETS_OVERLAP: source '${sourceRoot}' and output '${outputRoot}' must be disjoint directories.`,
    );
  }
  // Mobile keeps the decoder-free policy until its packaged loaders are qualified.
  // Each pass declares its decoder dependency, so decoder-free model work survives.
  const runtimeDecoderCapabilities: IAssetRuntimeDecoderCapabilities = options.runtimeDecoders ?? {
    ktx2: options.platform !== "android" && options.platform !== "ios",
    meshopt: options.platform !== "android" && options.platform !== "ios",
  };
  const runtimeDecoderAvailable =
    runtimeDecoderCapabilities.ktx2 && runtimeDecoderCapabilities.meshopt;
  const mobileAstc = options.platform === "android" || options.platform === "ios";
  const audio = parseAudioConfig(config.audio);
  const configuredTextures = parseTexturesConfig(config.textures);
  const configuredModels = parseModelsConfig(config.models);
  // Absent means on with defaults (PRD-458 §4/AC-6): a game that streams a world gets foliage cutout
  // conversion, an automatic chain and a material merge without declaring anything. `false` /
  // `"none"` remain the absolute kill switch, and the legacy `models` declarations still translate
  // against the same policy, so an explicit `simplify` or `virtual: "none"` project is unaffected.
  const configuredLod = config.lod === undefined ? true : parseModelLod(config.lod);
  const nativePackage = config.nativePackage ?? false;
  if (typeof nativePackage !== "boolean") {
    throw new Error("TN_ASSETS_CONFIG_INVALID: assets.nativePackage must be a boolean.");
  }
  const modelCompressionDecoders: readonly ("meshopt" | "KTX2")[] =
    configuredModels === undefined
      ? []
      : [
          (configuredModels.passes?.meshopt ?? true) ? "meshopt" : undefined,
          configuredModels.textures === "none" || mobileAstc ? undefined : "KTX2",
        ].filter((decoder): decoder is "meshopt" | "KTX2" => decoder !== undefined);
  const models =
    configuredModels === undefined
      ? undefined
      : {
          ...configuredModels,
          ...(runtimeDecoderCapabilities.meshopt
            ? {}
            : {
                passes: { ...(configuredModels.passes ?? {}), meshopt: false },
              }),
          ...embeddedTexturesFor(
            configuredModels.textures,
            runtimeDecoderCapabilities.ktx2,
            mobileAstc,
          ),
        };
  const textures =
    configuredTextures === undefined
      ? undefined
      : mobileAstc
        ? { ...configuredTextures, astc: true }
        : configuredTextures;
  const lightmap = (models as (IModelPassOptions & { lightmap?: ILightmapPassOptions }) | undefined)
    ?.lightmap;
  // The built-in registry runs only when the caller did not replace it wholesale; each
  // built-in pass drops out individually through its `"none"` shorthand. Its serialisable
  // mirror rides along so a bounded worker pool can rebuild the identical chain — custom
  // passes cannot cross a worker boundary, so a compile that supplies any runs sequential.
  const builtinPasses: IAssetPass[] = [];
  const passSpecs: PassSpec[] = [];
  const registerBuiltin = (pass: IAssetPass, spec: PassSpec): void => {
    if (
      spec.needsRuntimeDecoder === true &&
      !(spec.kind === "texture"
        ? runtimeDecoderCapabilities.ktx2
        : spec.kind === "model"
          ? (!(spec.options.passes?.meshopt ?? true) || runtimeDecoderCapabilities.meshopt) &&
            (spec.options.textures === "none" ||
              spec.options.textures?.decoderFree === true ||
              spec.options.textures?.astc === true ||
              runtimeDecoderCapabilities.ktx2)
          : runtimeDecoderAvailable)
    )
      return;
    builtinPasses.push(pass);
    passSpecs.push(spec);
  };
  if (options.passes === undefined) {
    if (audio !== undefined) {
      registerBuiltin(audioPass(audio), {
        kind: "audio",
        needsRuntimeDecoder: false,
        options: audio,
      });
    }
    if (textures !== undefined) {
      registerBuiltin(texturePass(textures), {
        kind: "texture",
        needsRuntimeDecoder: !mobileAstc,
        options: textures,
      });
    }
    if (
      textures !== undefined &&
      !runtimeDecoderCapabilities.ktx2 &&
      !mobileAstc &&
      textures.maxSize !== undefined
    ) {
      // The KTX2 pass dropped for this target, but the declared cap is still honoured: the
      // decoder-free resize pass needs no runtime decoder and runs in its place. The overrides
      // ride along so a `codec: "none"` glob keeps the authored bytes on this path too.
      const resize = { maxSize: textures.maxSize, overrides: textures.overrides };
      registerBuiltin(textureResizePass(resize), {
        kind: "texture-resize",
        needsRuntimeDecoder: false,
        options: resize,
      });
    }
    if (lightmap !== undefined) {
      registerBuiltin(createLightmapPass(lightmap, mobileAstc), {
        kind: "lightmap",
        ...(mobileAstc ? { astc: true } : {}),
        needsRuntimeDecoder: !mobileAstc,
        options: lightmap,
      });
    }
    // Ahead of `modelPass`: it converts the source into the GLB that pass then optimizes. A game
    // with no importable source pays one extension test per input.
    registerBuiltin(blenderImportPass(), {
      kind: "blender-import",
      needsRuntimeDecoder: false,
    });
    if (models !== undefined) {
      // Every native host uses WebGPU's stricter vertex-input path, including desktop where the
      // runtime does carry Meshopt. Keep the browser's interleaved default, but make every native
      // model pass emit separate attribute buffers before the packager's fail-closed preflight.
      const modelOptions =
        options.platform === undefined || options.platform === "web"
          ? models
          : { ...models, vertexLayout: "separate" as const };
      // `assets.lod` is top-level, not under `models`, but it drives the model pass. It rides in
      // the pass options (and its spec) so it is part of the compile cache key.
      const modelOptionsWithLod = {
        ...modelOptions,
        lod: configuredLod,
        ...(options.modelTranscoderBytes === undefined || modelOptions.textures === "none"
          ? {}
          : {
              textures: {
                ...(modelOptions.textures ?? {}),
                transcoderBytes: options.modelTranscoderBytes,
              },
            }),
      };
      const pass = modelPass({
        ...modelOptionsWithLod,
        preserveLightmapUv: lightmap !== undefined,
        // Bound to the output root so a second build finds last build's encodes on
        // disk instead of paying for them again.
        // The driver publishes every returned auxiliary output after journalling ownership.
        // The store still remembers within this pass chain and reads last build's public cache.
        sharedImages: models.sharedImages
          ? createSharedImageStore(outputRoot, { writeThrough: false })
          : undefined,
      });
      registerBuiltin(pass, {
        kind: "model",
        needsRuntimeDecoder: pass.needsRuntimeDecoder ?? false,
        options: {
          ...modelOptionsWithLod,
          preserveLightmapUv: lightmap !== undefined,
          sharedImages: modelOptions.sharedImages,
        },
      });
    }
  }
  const suppliedPasses = options.passes ?? [];
  const skippedPasses = suppliedPasses
    .filter((pass) => pass.needsRuntimeDecoder === true && !runtimeDecoderAvailable)
    .map((pass) => pass.name);
  const customPasses = suppliedPasses.filter(
    (pass) => pass.needsRuntimeDecoder !== true || runtimeDecoderAvailable,
  );
  return {
    builtinRegistry: options.passes === undefined,
    exclude,
    concurrency: config.concurrency as number | undefined,
    runtimeDecoderCapabilities,
    lod: configuredLod,
    lodLegacy: {
      simplify:
        typeof configuredModels === "object" &&
        configuredModels !== null &&
        configuredModels.simplify !== undefined,
      virtualNone:
        typeof configuredModels === "object" &&
        configuredModels !== null &&
        configuredModels.virtual === "none",
    },
    modelCompressionReason:
      options.passes !== undefined
        ? undefined
        : configuredModels === undefined
          ? "config"
          : modelCompressionDecoders.length === 0
            ? undefined
            : modelCompressionDecoders.every((decoder) =>
                  decoder === "KTX2"
                    ? runtimeDecoderCapabilities.ktx2
                    : runtimeDecoderCapabilities.meshopt,
                )
              ? undefined
              : "platform",
    modelCompressionDecoders,
    nativePackage,
    outputRoot,
    passSpecs,
    skippedPasses,
    passes: [...builtinPasses, ...customPasses],
    sourceRoot,
    targets: config.targets === undefined ? {} : validateTargets(config.targets),
    budget: parseBudget(config.budget),
    textureCompressionReason:
      options.passes !== undefined
        ? undefined
        : configuredTextures === undefined
          ? "config"
          : runtimeDecoderCapabilities.ktx2 || mobileAstc
            ? undefined
            : "platform",
    texturesActive:
      textures !== undefined &&
      options.passes === undefined &&
      runtimeDecoderCapabilities.ktx2 &&
      !mobileAstc,
  };
}

async function scanDirectory(sourceRoot: string, directory: string): Promise<IDirectoryScan> {
  const entries = await readdir(path.join(sourceRoot, directory), { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : 1));
  const files: string[] = [];
  const subdirectories: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const logical = directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      subdirectories.push(logical);
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      throw new Error(
        `TN_ASSETS_INPUT_UNREADABLE: '${logical}' under '${sourceRoot}' is neither a file nor a directory.`,
      );
    }
    files.push(logical);
  }
  return { files, subdirectories };
}

async function walkSources(sourceRoot: string): Promise<string[]> {
  const logicalPaths: string[] = [];
  const seenFiles = new Set<string>();
  const visitedDirectories = new Set<string>();
  const queue: string[] = [""];
  while (queue.length > 0) {
    const directory = queue.shift();
    if (directory === undefined) break;
    const canonical = await realpath(path.join(sourceRoot, directory));
    if (visitedDirectories.has(canonical)) {
      throw new Error(
        `TN_ASSETS_DUPLICATE_LOGICAL_PATH: '${directory}' resolves to an already-visited directory; duplicate logical path under '${sourceRoot}'.`,
      );
    }
    visitedDirectories.add(canonical);
    const scanned = await scanDirectory(sourceRoot, directory);
    queue.push(...scanned.subdirectories);
    for (const logical of scanned.files) {
      if (seenFiles.has(logical)) {
        throw new Error(
          `TN_ASSETS_DUPLICATE_LOGICAL_PATH: '${logical}' was listed twice; duplicate logical path under '${sourceRoot}'.`,
        );
      }
      seenFiles.add(logical);
      logicalPaths.push(logical);
    }
  }
  return logicalPaths.sort();
}

/** Shared with the health report so the kind vocabulary lives in exactly one place. */
export function classify(logicalPath: string): AssetKind {
  const extension = path.extname(logicalPath).slice(1).toLowerCase();
  return KIND_BY_EXTENSION[extension] ?? "other";
}

function outputNameFor(logicalPath: string, digest: string, extension?: string): string {
  const sourceExtension = path.extname(logicalPath);
  const base = path.basename(logicalPath, sourceExtension);
  const directory = path.dirname(logicalPath);
  const name = `${base}.${digest}${extension ?? sourceExtension.toLowerCase()}`;
  return directory === "." ? name : `${directory}/${name}`;
}

function sameTargets(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * Refreshes an entry's `lod.runtime` from the current resolved policy before it is written.
 *
 * A compile cache hit reuses the whole previous entry without re-running the pass, which is correct
 * for geometry — a runtime-only edit must not rebake it — but would otherwise keep serving the old
 * pixel budget and hysteresis. Preset and runtime are policy, not bytes, so they are re-resolved
 * here for both the cache-hit and fresh paths (PRD-377 §3.2, §5).
 */
function withFreshLodRuntime(
  entry: IAssetManifestEntry,
  logical: string,
  lod: boolean | IModelLodOptions | "none" | undefined,
  legacy: { readonly simplify: boolean; readonly virtualNone: boolean },
): IAssetManifestEntry {
  if (entry.lod === undefined || lod === undefined) return entry;
  const policy = resolveLodPolicy(lod, logical, legacy);
  return {
    ...entry,
    lod: { ...entry.lod, preset: policy.preset, runtime: { ...policy.runtime } },
  };
}

function sameEntry(existing: IAssetManifestEntry, entry: IAssetManifestEntry): boolean {
  return (
    existing.output === entry.output &&
    existing.kind === entry.kind &&
    JSON.stringify(existing.audio) === JSON.stringify(entry.audio) &&
    existing.importedFrom === entry.importedFrom &&
    JSON.stringify(existing.lightmapAtlas) === JSON.stringify(entry.lightmapAtlas) &&
    JSON.stringify(existing.lightmaps) === JSON.stringify(entry.lightmaps) &&
    JSON.stringify(existing.embeddedTextures) === JSON.stringify(entry.embeddedTextures) &&
    JSON.stringify(existing.quality) === JSON.stringify(entry.quality) &&
    JSON.stringify(existing.simplify) === JSON.stringify(entry.simplify) &&
    JSON.stringify(existing.lod) === JSON.stringify(entry.lod) &&
    existing.bytes === entry.bytes &&
    existing.bytesBefore === entry.bytesBefore &&
    existing.bytesAfter === entry.bytesAfter &&
    existing.format === entry.format &&
    sameTargets(existing.transcodeTargets, entry.transcodeTargets) &&
    sameTargets(existing.extensions, entry.extensions) &&
    existing.triangles === entry.triangles &&
    existing.vertices === entry.vertices &&
    existing.passes.length === entry.passes.length &&
    existing.passes.every((name, index) => name === entry.passes[index])
  );
}

interface IResolvedAuxiliaryOutput {
  readonly buffer: Buffer;
  readonly manifestField: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly output: string;
  /** Named by the pass and possibly referenced by several inputs. */
  readonly shared: boolean;
  /** The producer's own name for this output — `lightmap` for the lightmap pass's atlas. */
  readonly role: string;
}

function resolveAuxiliaryOutputs(
  logical: string,
  outputs: readonly IAssetAuxiliaryOutput[],
): IResolvedAuxiliaryOutput[] {
  const sourceExtension = path.extname(logical);
  const stem = logical.slice(0, -sourceExtension.length);
  return outputs.map((auxiliary) => {
    const digest = createHash("sha256").update(auxiliary.buffer).digest("hex").slice(0, 8);
    const output =
      auxiliary.outputPath ??
      outputNameFor(`${stem}.${auxiliary.role}${auxiliary.extension}`, digest, auxiliary.extension);
    if (path.win32.isAbsolute(output) || output.split(/[\\/]/u).includes("..")) {
      throw new Error(
        `TN_ASSETS_OUTPUT_INVALID: auxiliary output '${output}' must stay relative to assets.output.`,
      );
    }
    return {
      buffer: auxiliary.buffer,
      manifestField: auxiliary.manifestField,
      metadata: {
        ...(auxiliary.metadata ?? {}),
        bytes: auxiliary.buffer.length,
        output,
      },
      output,
      role: auxiliary.role,
      shared: auxiliary.outputPath !== undefined,
    };
  });
}

function auxiliaryManifestFields(
  outputs: readonly IResolvedAuxiliaryOutput[],
): Record<string, readonly Readonly<Record<string, unknown>>[]> {
  const fields: Record<string, Readonly<Record<string, unknown>>[]> = {};
  for (const output of outputs) {
    const field = fields[output.manifestField] ?? [];
    field.push(output.metadata);
    fields[output.manifestField] = field;
  }
  return fields;
}

/**
 * The files a manifest entry declares beyond its own output: every array field whose records
 * carry an `output` path (lightmaps, shared images), as the receipt records them.
 */
function declaredAuxiliaryOutputs(
  entry: IAssetManifestEntry,
): { readonly bytes: number; readonly path: string; readonly producer: string }[] {
  const outputs: { bytes: number; path: string; producer: string }[] = [];
  for (const [field, value] of Object.entries(entry)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!isRecord(item) || typeof item.output !== "string") continue;
      outputs.push({
        bytes: typeof item.bytes === "number" ? item.bytes : 0,
        path: item.output,
        producer: field === "lightmaps" ? "lightmap" : field === "sharedImages" ? "image" : field,
      });
    }
  }
  return outputs;
}

/** Compression declarations a decoder-free target must retain when it passes a GLB through. */
function sourceModelExtensions(logicalPath: string, input: Buffer): readonly string[] | undefined {
  if (classify(logicalPath) !== "model" || path.extname(logicalPath).toLowerCase() !== ".glb")
    return undefined;
  try {
    const extensions = unpackGlb(input).json.extensionsUsed;
    return Array.isArray(extensions)
      ? extensions.filter((extension): extension is string => typeof extension === "string")
      : undefined;
  } catch {
    // The health reader owns the actionable malformed-model error. This helper only preserves
    // declarations from a readable pass-through GLB for the native compatibility backstop.
    return undefined;
  }
}

/**
 * The previous entry, when it is exactly what this build would produce and every file it
 * declares still exists — or `undefined`, in which case the passes run.
 */
async function reusableEntry(
  outputRoot: string,
  logical: string,
  digest: string,
  existing: IAssetManifestEntry,
): Promise<
  { readonly bytes: number; readonly path: string; readonly producer: string }[] | undefined
> {
  const expected = outputNameFor(logical, digest, path.extname(existing.output));
  if (existing.output !== expected) return undefined;
  const auxiliary = declaredAuxiliaryOutputs(existing);
  const present = await Promise.all(
    [existing.output, ...auxiliary.map((output) => output.path)].map((relative) =>
      outputExists(path.join(outputRoot, relative)),
    ),
  );
  return present.every(Boolean) ? auxiliary : undefined;
}

/** The paths the previous bake's receipt declared, or none when there is no readable receipt. */
async function readPreviousReceiptPaths(receiptPath: string): Promise<ReadonlySet<string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.outputs)) return new Set();
    return new Set(
      parsed.outputs.flatMap((output) =>
        isRecord(output) && typeof output.path === "string" ? [output.path] : [],
      ),
    );
  } catch {
    return new Set();
  }
}

/** Resolve and validate every stale receipt target before any output is deleted or published. */
async function resolveStaleReceiptOutputs(
  outputRoot: string,
  previous: ReadonlySet<string>,
  current: ReadonlySet<string>,
): Promise<readonly string[]> {
  if (previous.size === 0) return [];
  const root = path.resolve(outputRoot);
  const realRoot = await realpath(root);
  const stale: string[] = [];
  for (const relative of previous) {
    if (current.has(relative)) continue;
    const target = path.resolve(root, relative);
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`TN_ASSETS_RECEIPT_INVALID: output '${relative}' is outside assets.output.`);
    }
    if (!(await outputExists(target))) continue;
    const actual = await realpath(target);
    if (!actual.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error(`TN_ASSETS_RECEIPT_INVALID: output '${relative}' escapes assets.output.`);
    }
    stale.push(target);
  }
  return stale;
}

/** Remove only files an earlier receipt/journal owned and the completed recook no longer owns. */
async function removeStaleReceiptOutputs(
  outputRoot: string,
  previous: ReadonlySet<string>,
  current: ReadonlySet<string>,
): Promise<void> {
  for (const target of await resolveStaleReceiptOutputs(outputRoot, previous, current))
    await rm(target, { force: true });
}

async function writePendingOwnership(
  outputRoot: string,
  paths: ReadonlySet<string>,
): Promise<void> {
  await mkdir(outputRoot, { recursive: true });
  await writeFile(
    path.join(outputRoot, PENDING_RECEIPT_NAME),
    `${JSON.stringify({ outputs: [...paths].sort().map((outputPath) => ({ path: outputPath })) }, null, 2)}\n`,
    "utf8",
  );
}

async function readExistingManifest(
  manifestPath: string,
): Promise<{ entries: Record<string, IAssetManifestEntry>; raw: string | undefined }> {
  let raw: string | undefined;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    return { entries: {}, raw: undefined };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `TN_ASSETS_MANIFEST_INVALID: '${manifestPath}' is not valid JSON: ${messageOf(error)}`,
    );
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.entries)) {
    throw new Error(`TN_ASSETS_MANIFEST_INVALID: '${manifestPath}' must hold version 1 entries.`);
  }
  return { entries: parsed.entries as Record<string, IAssetManifestEntry>, raw };
}

/**
 * A missing source directory is the documented pre-pipeline state — projects built before this
 * step existed have none — so it skips compilation instead of failing their builds. A path that
 * exists but is not a directory is malformed input and still throws.
 */
async function hasSourceDirectory(sourceRoot: string): Promise<boolean> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(sourceRoot);
  } catch {
    return false;
  }
  if (!info.isDirectory()) {
    throw new Error(`TN_ASSETS_SOURCE_INVALID: asset source '${sourceRoot}' is not a directory.`);
  }
  return true;
}

async function outputExists(outputAbsolute: string): Promise<boolean> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(outputAbsolute);
  } catch {
    return false;
  }
  return info.isFile();
}

async function readInput(sourceRoot: string, logical: string): Promise<Buffer> {
  try {
    return await readFile(path.join(sourceRoot, logical));
  } catch (error) {
    throw new Error(
      `TN_ASSETS_INPUT_UNREADABLE: could not read '${logical}' under '${sourceRoot}': ${messageOf(error)}`,
    );
  }
}

/** The per-pass cost bookkeeping one bake accumulates, keyed in registry order. */
interface IPassCostRecord {
  cachedInputs: number;
  ranInputs: number;
  timings: IPassCostAssetRow[];
}

/** Counts one compile-cache-served input for every pass: the cache decision is the source. */
function recordCachedInputs(
  costInputs: Map<string, IPassCostRecord>,
  passNames: readonly string[],
): void {
  for (const name of passNames) {
    const record = costInputs.get(name);
    if (record !== undefined) record.cachedInputs += 1;
  }
}

function recordRanTimings(
  costInputs: Map<string, IPassCostRecord>,
  logical: string,
  timings: readonly IPassTiming[],
): void {
  for (const timing of timings) {
    const record = costInputs.get(timing.name);
    if (record === undefined) continue;
    record.ranInputs += 1;
    record.timings.push({ durationMs: timing.durationMs, logicalPath: logical });
  }
}

/** Fails closed: every pass must account for every input, ran or cached, or nothing is emitted. */
function assertCompletePassCosts(
  costInputs: ReadonlyMap<string, IPassCostRecord>,
  inputCount: number,
): void {
  for (const [pass, record] of costInputs) {
    if (record.ranInputs + record.cachedInputs !== inputCount) {
      throw new Error(
        `TN_ASSETS_PASS_COST_INCOMPLETE: pass '${pass}' accounts for ${record.ranInputs} ran + ${record.cachedInputs} cached of ${inputCount} input(s); refusing to emit a cost report with a hole in it.`,
      );
    }
  }
}

/** Rows in registry order; per-asset rows sorted by logical path so two bakes diff cleanly. */
function buildPassCostRows(
  costInputs: ReadonlyMap<string, IPassCostRecord>,
): readonly IPassCostRow[] {
  const rows: IPassCostRow[] = [];
  for (const [pass, record] of costInputs) {
    const status: PassCostStatus = record.ranInputs > 0 ? "ran" : "cached";
    rows.push({
      assets: [...record.timings].sort((left, right) =>
        left.logicalPath < right.logicalPath ? -1 : 1,
      ),
      cachedInputs: record.cachedInputs,
      durationMs: record.timings.reduce((total, timing) => total + timing.durationMs, 0),
      pass,
      ranInputs: record.ranInputs,
      status,
    });
  }
  return rows;
}

async function writeOutput(
  outputRoot: string,
  entry: IAssetManifestEntry,
  buffer: Buffer,
): Promise<void> {
  const outputAbsolute = path.join(outputRoot, entry.output);
  await mkdir(path.dirname(outputAbsolute), { recursive: true });
  await writeFile(outputAbsolute, buffer);
}

/** A decoded PNG or JPEG as a TNPK v1 Texture entry, or undefined for any other container. */
async function nativeTextureEntry(
  name: string,
  data: Buffer,
): Promise<INativePackageEntry | undefined> {
  // PNG or JPEG: decoded here to RGBA8. KTX2 and other containers need a runtime transcoder.
  const jpeg = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (!jpeg && parsePng(data) === undefined) return undefined;
  const image = await decodeImageBytes(data, name);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(image.width, 0);
  header.writeUInt32LE(image.height, 4);
  // WGPU_TEXTURE_FORMAT_RGBA8_UNORM, not _SRGB: the standalone texture pipeline decides
  // colour versus data only for codec choice (the `*_normal`/`*_nrm` basename convention in
  // passes/texture.ts) and records no colour space on the cooked PNG. Treating every other
  // PNG as sRGB would be a guess — masks, roughness, metallic and AO maps are data too — so
  // the writer keeps the format the header states and the C++ loader accepts (package.h v1).
  // sRGB ships once a pass records a colour space this can read.
  header.writeUInt32LE(WGPU_TEXTURE_FORMAT_RGBA8_UNORM, 8);
  return {
    data: Buffer.concat([header, Buffer.from(image.data)]),
    kind: NativeEntryKind.Texture,
    name,
    uploadSize: image.width * image.height * 4,
  };
}

/** Editor and VCS leftovers, by basename: the packaging selector's rule 1 (asset-manifest.mjs). */
function isLeftover(relative: string): boolean {
  const name = path.posix.basename(relative);
  return (
    [".DS_Store", "Thumbs.db", ".gitkeep"].includes(name) ||
    [".orig", ".rej", ".bak", ".swp", "~"].some((suffix) => name.endsWith(suffix))
  );
}

/**
 * Gathers the native package's entries from the files already on disk.
 *
 * Cooked outputs enter under their logical path: one Buffer entry per cooked binary buffer
 * (audio/other), as CPU data at its exact length, and one Texture entry per cooked PNG or JPEG,
 * decoded to RGBA8, and one Scene entry per cooked model. A KTX2 texture is not a v1 entry.
 *
 * Every other file in the output root (the web root) enters under its web URL, `/` plus its path
 * there, because that is the URL a game requests it by on the web (`/assets/sky.hdr` is served
 * from `public/assets/sky.hdr`). PNG and JPEG become Texture entries, a binary glTF a Scene entry,
 * anything else a CPU Buffer. Cook outputs (this bake's or a previous one's), the manifest, the
 * receipts, the package itself and editor leftovers are not web-root files. An empty file is left
 * out and counted, never silently padded.
 */
async function nativePackageEntries(
  outputRoot: string,
  entries: Readonly<Record<string, IAssetManifestEntry>>,
  cookOutputs: ReadonlySet<string>,
): Promise<{ entries: INativePackageEntry[]; skipped: number }> {
  const specs: INativePackageEntry[] = [];
  const shared = new Set<string>();
  let skipped = 0;
  for (const logical of Object.keys(entries).sort()) {
    const entry = entries[logical];
    if (entry === undefined) continue;
    const data = await readFile(path.join(outputRoot, entry.output));
    if (entry.kind === "model") {
      // The GLB bytes the native glTF loader reads; it refuses by name any extension it cannot decode.
      specs.push({ data, kind: NativeEntryKind.Scene, name: logical, uploadSize: 0 });
      // The images it names by uri sit beside it as raw bytes, which the loader decodes: the model
      // is a root file, so the uri is the entry name.
      for (const image of declaredAuxiliaryOutputs(entry))
        if (image.producer === "image" && !shared.has(image.path)) {
          shared.add(image.path);
          const bytes = await readFile(path.join(outputRoot, image.path));
          specs.push({
            data: bytes,
            kind: NativeEntryKind.Buffer,
            name: image.path,
            uploadSize: 0,
          });
        }
      continue;
    }
    const texture = entry.kind === "texture" ? await nativeTextureEntry(logical, data) : undefined;
    if (texture !== undefined) specs.push(texture);
    else if (entry.kind === "texture" || data.length === 0) skipped += 1;
    // Every Buffer the cook writes is CPU data a decoder reads (audio, an HDRLoader's .hdr, raw
    // bytes): uploadSize 0 says so, and it keeps its exact length. Only GPU buffers are aligned.
    else specs.push({ data, kind: NativeEntryKind.Buffer, name: logical, uploadSize: 0 });
  }
  const bookkeeping = new Set([
    MANIFEST_NAME,
    RECEIPT_NAME,
    PENDING_RECEIPT_NAME,
    NATIVE_PACKAGE_NAME,
  ]);
  for (const relative of (await walkOutputFiles(outputRoot)).sort()) {
    if (bookkeeping.has(relative) || cookOutputs.has(relative) || isLeftover(relative)) continue;
    const data = await readFile(path.join(outputRoot, relative));
    const name = `/${relative}`;
    if (data.length === 0) {
      skipped += 1;
      continue;
    }
    const texture = await nativeTextureEntry(name, data);
    const scene = data.length >= 4 && data.toString("latin1", 0, 4) === "glTF";
    specs.push(
      texture ?? {
        data,
        kind: scene ? NativeEntryKind.Scene : NativeEntryKind.Buffer,
        name,
        uploadSize: 0,
      },
    );
  }
  specs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { entries: specs, skipped };
}

/**
 * Writes `native/assets.tnpk` from the cook and the web root, and returns its receipt row; with no
 * v1 entry it removes a package an earlier run left there and returns undefined.
 */
async function writeNativePackageOutput(
  outputRoot: string,
  entries: Readonly<Record<string, IAssetManifestEntry>>,
  cookOutputs: ReadonlySet<string>,
): Promise<IBakeReceiptOutput | undefined> {
  const native = await nativePackageEntries(outputRoot, entries, cookOutputs);
  const nativeAbsolute = path.join(outputRoot, NATIVE_PACKAGE_NAME);
  if (native.entries.length === 0) {
    // The bake owns this fixed path whenever the option is on. A package left by an earlier
    // run whose receipt is gone is pruned here, the way the empty-source branch removes its
    // stale manifest, rather than left to haunt a rebuilt project.
    await rm(nativeAbsolute, { force: true });
    console.log(
      "TN_ASSETS_NATIVE_PACKAGE_EMPTY: assets.nativePackage is on but no cooked output or web-root file is in scope for a v1 entry.",
    );
    return undefined;
  }
  const nativeBytes = writeNativePackage(native.entries);
  await mkdir(path.dirname(nativeAbsolute), { recursive: true });
  const existing = await readFile(nativeAbsolute).catch(() => undefined);
  if (existing === undefined || !Buffer.from(existing).equals(nativeBytes)) {
    await writeFile(nativeAbsolute, nativeBytes);
  }
  if (native.skipped > 0) {
    console.log(
      `TN_ASSETS_NATIVE_PACKAGE_SKIPPED: ${String(native.skipped)} file(s) are not a legal TNPK v1 entry (a KTX2 texture or an empty file) and are left out.`,
    );
  }
  console.log(
    `TN_ASSETS_NATIVE_PACKAGE: ${String(native.entries.length)} entry(ies), ${String(nativeBytes.length)} bytes at ${NATIVE_PACKAGE_NAME}.`,
  );
  return {
    bytes: nativeBytes.length,
    path: NATIVE_PACKAGE_NAME,
    producer: "native-package",
    source: null,
  };
}

async function writeManifest(
  manifestPath: string,
  outputRoot: string,
  raw: string | undefined,
  entries: Record<string, IAssetManifestEntry>,
): Promise<void> {
  const manifest: IAssetManifest = { version: 1, entries: {} };
  for (const logical of Object.keys(entries).sort()) {
    const entry = entries[logical];
    if (entry !== undefined) manifest.entries[logical] = entry;
  }
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (serialized === raw) return;
  await mkdir(outputRoot, { recursive: true });
  const temporary = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, "utf8");
    await rename(temporary, manifestPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Every file under `root`, as paths relative to it with `/` separators on every platform. */
async function walkOutputFiles(root: string, prefix = ""): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await walkOutputFiles(root, relative)));
    else files.push(relative);
  }
  return files;
}

/**
 * Fails the build when this run created a file under the output root that no pass declared.
 *
 * Without this, a pass that writes a file it does not report is invisible: the delete-test would
 * delete less than the bake produced, the second run would still find the undeleted file, and the
 * gate would pass while proving nothing. New paths are checked regardless of their timestamps;
 * existing paths are checked when touched during this run. An untouched hand-authored
 * `public/icon.png` is not a bake output and is left alone.
 */
async function assertNoUndeclaredOutputs(
  outputRoot: string,
  declared: ReadonlySet<string>,
  since: number,
  writtenBefore: ReadonlySet<string>,
  existingBefore: ReadonlySet<string>,
): Promise<void> {
  const undeclared: string[] = [];
  for (const relative of await walkOutputFiles(outputRoot)) {
    if (
      relative === MANIFEST_NAME ||
      relative === RECEIPT_NAME ||
      relative === PENDING_RECEIPT_NAME
    )
      continue;
    if (declared.has(relative)) continue;
    // A file the previous receipt lists was written by an earlier bake, however close its mtime
    // is to this run's start: with the cache skipping unchanged inputs, two bakes can be one
    // millisecond apart, and the previous bake's now-stale output is not this bake's leak.
    if (writtenBefore.has(relative)) continue;
    const info = await stat(path.join(outputRoot, relative));
    if (!existingBefore.has(relative) || info.mtimeMs + 1 >= since) undeclared.push(relative);
  }
  if (undeclared.length > 0) {
    throw new Error(
      `TN_ASSETS_UNDECLARED_OUTPUT: this bake wrote ${undeclared.length} file(s) under '${outputRoot}' that no pass declared, so the delete-test cannot remove them: ${undeclared.sort().join(", ")}`,
    );
  }
}

/**
 * Writes the receipt, sorted by path so two builds of the same inputs are byte-identical.
 *
 * Throws rather than writing an empty list: a bake that produced nothing and said so in a green
 * receipt is exactly the shape of the v1 harness failure this repository already paid for — a
 * gate that reports success over an empty set.
 */
async function writeReceipt(
  outputRoot: string,
  outputs: readonly IBakeReceiptOutput[],
): Promise<IBakeReceipt> {
  if (outputs.length === 0) {
    throw new Error(
      `TN_ASSETS_EMPTY_RECEIPT: the compile step produced no outputs for '${outputRoot}', so there is nothing a delete-test could remove.`,
    );
  }
  const seen = new Map<string, IBakeReceiptOutput>();
  for (const output of outputs) {
    // Several inputs can declare one shared output (an image two models embed). The survivor is
    // chosen by the lexicographically smallest source, not by arrival: under a scheduler whose
    // completion order is not input order, a last-writer-wins merge would make the receipt's
    // provenance depend on which worker finished first. The path, bytes and producer are
    // identical across the contenders; only this tie-break needs a stable rule.
    const existing = seen.get(output.path);
    if (existing === undefined || (output.source ?? "") < (existing.source ?? "")) {
      seen.set(output.path, output);
    }
  }
  const receipt: IBakeReceipt = {
    outputs: [...seen.values()].sort((left, right) => (left.path < right.path ? -1 : 1)),
    pipelineVersion: PIPELINE_VERSION,
  };
  await mkdir(outputRoot, { recursive: true });
  await writeFile(
    path.join(outputRoot, RECEIPT_NAME),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  return receipt;
}

/**
 * Resolves three's Basis transcoder through the project's own `three` install so a path that
 * moved between three versions fails the build here, as a named error, instead of 404ing at
 * runtime inside the KTX2 loader.
 */
export function resolveBasisTranscoder(cwd: string): IBasisTranscoder {
  try {
    const javascriptPath = createRequire(path.join(cwd, "package.json")).resolve(
      "three/examples/jsm/libs/basis/basis_transcoder.js",
    );
    return { javascriptPath, wasmPath: javascriptPath.replace(/\.js$/u, ".wasm") };
  } catch (error) {
    throw new Error(
      `TN_ASSETS_TRANSCODER_MISSING: could not resolve three's Basis transcoder from '${cwd}': ${messageOf(error)}. The runtime KTX2 loader needs it copied next to the compiled assets.`,
    );
  }
}

async function copyBasisTranscoder(
  outputRoot: string,
  transcoder: IBasisTranscoder,
): Promise<void> {
  const target = path.join(outputRoot, BASIS_DIRECTORY);
  try {
    await mkdir(target, { recursive: true });
    await copyFile(transcoder.javascriptPath, path.join(target, "basis_transcoder.js"));
    await copyFile(transcoder.wasmPath, path.join(target, "basis_transcoder.wasm"));
  } catch (error) {
    throw new Error(
      `TN_ASSETS_TRANSCODER_MISSING: could not copy the Basis transcoder into '${target}': ${messageOf(error)}`,
    );
  }
}

export async function compileAssets(
  options: IAssetCompileOptions = {},
): Promise<IAssetCompileResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const layout = resolveLayout(cwd, options);
  const receiptPath = path.join(layout.outputRoot, RECEIPT_NAME);
  const manifestPath = path.join(layout.outputRoot, MANIFEST_NAME);
  const pendingReceiptPath = path.join(layout.outputRoot, PENDING_RECEIPT_NAME);
  const successfulBefore = await readPreviousReceiptPaths(receiptPath);
  const failedBefore = await readPreviousReceiptPaths(pendingReceiptPath);
  const writtenBefore = new Set([...successfulBefore, ...failedBefore]);
  if (!(await hasSourceDirectory(layout.sourceRoot))) {
    await removeStaleReceiptOutputs(layout.outputRoot, writtenBefore, new Set());
    for (const line of formatBudget(
      await measureBudget({}, layout.outputRoot, layout.runtimeDecoderCapabilities, layout.budget),
    ))
      console.log(line);
    await writeManifest(manifestPath, layout.outputRoot, undefined, {});
    await rm(receiptPath, { force: true });
    await rm(pendingReceiptPath, { force: true });
    // Nothing to cook, but a web root of hand-placed files (Midway's `public/assets`) still ships
    // to the native engine, and the receipt names the package so a later bake can remove it.
    const native = layout.nativePackage
      ? await writeNativePackageOutput(layout.outputRoot, {}, writtenBefore)
      : undefined;
    if (native !== undefined) await writeReceipt(layout.outputRoot, [native]);
    return { concurrencyUsed: 1, passCosts: [], skipped: 0, skippedCompression: [], written: 0 };
  }
  const previous = await readExistingManifest(manifestPath);

  // Snapshot before the first write and source walk: new outputs can retain old timestamps when
  // copied, so modification time alone cannot distinguish them from authored static files.
  const runStart = Date.now();
  const existingBefore = new Set(await walkOutputFiles(layout.outputRoot));

  const sources = await walkSources(layout.sourceRoot);
  const excluded = sources.filter((logical) =>
    layout.exclude.some((glob) => globMatch(glob, logical)),
  );
  const excludedSet = new Set(excluded);
  const logicals = sources.filter((logical) => !excludedSet.has(logical));
  let excludedBytes = 0;
  for (const logical of excluded)
    excludedBytes += (await stat(path.join(layout.sourceRoot, logical))).size;
  console.log(`TN_ASSETS_EXCLUDED: ${excluded.length} file(s), ${excludedBytes} bytes`);
  // The determinism gate's seam: reversed processing order reverses which input's work completes
  // first, so the gate can prove the emitted bytes do not depend on it.
  if (options.processingOrder === "reversed") logicals.reverse();

  /**
   * PRD-473 AC-4: cook each authored world cell's chunks into one HLOD proxy GLB.
   *
   * The proxy and the rewritten world JSON are *virtual* sources: they live only in this overlay,
   * so the authored tree is never mutated and every chunk file is retained beside it. The proxy is
   * an ordinary model input — it takes the model pass, the content-addressed output name and the
   * cache — while the world JSON, classified `other`, publishes the rewritten bytes unchanged.
   * `cell.proxy` is optional, so a world that declined every cell ships exactly as authored.
   */
  const overlay = new Map<string, Buffer>();
  const logicalSet = new Set(logicals);
  const isExcluded = (logical: string): boolean =>
    layout.exclude.some((glob) => globMatch(glob, logical));
  // Every read is gated on the collected input set: an overlay entry this run generated, or a
  // logical the source walk actually included. A `../` chunk reference, an excluded chunk, or any
  // path the walk never produced therefore fails closed instead of reading off disk.
  const readSource = async (logical: string): Promise<Buffer> => {
    const overlaid = overlay.get(logical);
    if (overlaid !== undefined) return overlaid;
    if (!logicalSet.has(logical)) {
      throw new Error(
        `TN_ASSETS_INPUT_UNREADABLE: '${logical}' was not collected under '${layout.sourceRoot}'.`,
      );
    }
    return readInput(layout.sourceRoot, logical);
  };
  const worldJsonLogicals = logicals.filter(
    (logical) => path.extname(logical).toLowerCase() === ".json",
  );
  for (const worldLogical of worldJsonLogicals) {
    let bytes: Buffer;
    try {
      bytes = await readSource(worldLogical);
    } catch {
      continue;
    }
    const world = readWorldPackage(bytes);
    if (world === undefined) continue;
    const result = await cookWorldProxies({
      included: (logical) => logicalSet.has(logical),
      read: readSource,
      world,
      worldLogical,
    });
    // A proxy whose own logical is excluded by globs, or already an authored source, is not
    // written; the cell is reported declined rather than silently skipped.
    const declined = [...result.declined];
    const accepted = result.proxies.filter((proxy) => {
      if (isExcluded(proxy.logical)) {
        declined.push({ reason: "excluded-proxy", x: proxy.x, z: proxy.z });
        return false;
      }
      if (logicalSet.has(proxy.logical)) {
        declined.push({ reason: "existing-output", x: proxy.x, z: proxy.z });
        return false;
      }
      return true;
    });
    if (accepted.length === 0 && declined.length === 0) continue;
    console.log(formatWorldHlod(worldLogical, { declined, proxies: accepted }));
    // A world that gained no proxy ships byte-identical: declines are reported, not rewritten.
    if (accepted.length === 0) continue;
    overlay.set(worldLogical, applyProxiesToWorld(world, accepted));
    for (const proxy of accepted) {
      overlay.set(proxy.logical, proxy.buffer);
      logicalSet.add(proxy.logical);
      logicals.push(proxy.logical);
    }
  }

  /**
   * Content-identical model sources cook once.
   *
   * A streamed world package shipped 374 model files for 101 distinct models — the same prop
   * exported under ten different object names — and every copy paid a full cook and a separate
   * output, because the output name carries the digest of the *named* bytes. The scan reads each
   * model source once and keys it on the binary chunk plus the glTF JSON with every `name`
   * removed, and the lexicographically smallest path in each group is the one that is cooked.
   *
   * A source carrying its own `assets.lod` override keeps its own cook: that block is keyed by
   * source path, so a shared output would silently serve it the canonical member's policy.
   */
  const modelSources = logicals.filter((logical) => classify(logical) === "model");
  const perAssetLod =
    typeof layout.lod === "object" && layout.lod !== null && layout.lod.overrides !== undefined
      ? new Set(Object.keys(layout.lod.overrides))
      : new Set<string>();
  const canonicalOf = await groupModelSources(
    layout.sourceRoot,
    modelSources.filter((logical) => !perAssetLod.has(logical)),
    readSource,
  );

  /**
   * The Blender importer joins the chain only when this source tree actually holds something it
   * owns, which is why the walk happens before the pass list is fixed.
   *
   * It was unconditional first, and that hung `threenative build` for every project shipping
   * `assets: { models: "none", textures: "none" }` — every template that targets mobile. With both
   * set to "none" the built-in chain is *empty*, and an empty `passSpecs` is what tells the driver
   * not to create a worker pool at all (`layout.passSpecs.length > 0 && concurrency > 1`). One
   * unconditional no-op pass flipped that to a pool for a chain that can never do anything, and
   * `threenative build --target web` finished its work and then never exited — 45 minutes to a
   * job timeout in CI, reproduced locally at exit code 124.
   *
   * A game with no importable source now pays one extension test per input and nothing else,
   * which is also what its manifest should say: `passes` lists the chain that ran.
   */
  const importsModels = logicals.some((logical) => needsBlenderImport(logical));
  const activePasses = importsModels
    ? layout.passes
    : layout.passes.filter((pass) => pass.name !== BLENDER_IMPORT_PASS);
  const activePassSpecs = importsModels
    ? layout.passSpecs
    : layout.passSpecs.filter((spec) => spec.kind !== "blender-import");

  const passNames = activePasses.map((pass) => pass.name);
  // Per-kind, so an asset hashes only the passes that can change it. A model-only option edit
  // (an LOD preset, an audio knob, a quantize bit depth) must not rename every texture; a pass
  // that does not declare `appliesTo` is assumed able to change any input and stays everywhere.
  const passConfigurationFor = (kind: AssetKind): string => {
    const included = activePasses.filter(
      (pass) => pass.appliesTo === undefined || pass.appliesTo.includes(kind),
    );
    const cacheKeys = included.map((pass) => pass.cacheKey ?? null);
    return JSON.stringify({
      ...(cacheKeys.some((key) => key !== null) ? { passCacheKeys: cacheKeys } : {}),
      ...(options.runtimeIdentity === undefined && options.runtimeDecoders === undefined
        ? {}
        : {
            runtime: {
              identity: options.runtimeIdentity ?? null,
              decoders: layout.runtimeDecoderCapabilities,
            },
          }),
      pipelineVersion: PIPELINE_VERSION,
      passes: included.map((pass) => pass.name),
      options: included.map((pass) => pass.configuration ?? null),
    });
  };
  const passConfigurations: Readonly<Record<AssetKind, string>> = {
    audio: passConfigurationFor("audio"),
    model: passConfigurationFor("model"),
    other: passConfigurationFor("other"),
    texture: passConfigurationFor("texture"),
  };
  const entries: Record<string, IAssetManifestEntry> = {};
  const receiptOutputs: IBakeReceiptOutput[] = [];
  const costInputs = new Map<string, IPassCostRecord>();
  for (const name of passNames)
    costInputs.set(name, { cachedInputs: 0, ranInputs: 0, timings: [] });

  const healthInputs: IAssetHealthInput[] = [];
  const audioRows: IAudioRow[] = [];
  const textureRows: ITextureSizeRow[] = [];
  const modelRows: IModelSizeRow[] = [];
  let written = 0;
  let skipped = 0;
  /** Cooked bytes the content-identical model sources saved by sharing one output. */
  let dedupeSavedBytes = 0;
  let textureCount = 0;
  let ktx2TextureCount = 0;
  let compressedModelCount = 0;

  // Asset-free projects still serve the manifest the runtime loader requests.
  if (logicals.length === 0) {
    for (const line of formatBudget(
      await measureBudget({}, layout.outputRoot, layout.runtimeDecoderCapabilities, layout.budget),
    ))
      console.log(line);
    await removeStaleReceiptOutputs(layout.outputRoot, writtenBefore, new Set());
    await writeManifest(manifestPath, layout.outputRoot, previous.raw, {});
    await rm(receiptPath, { force: true });
    await rm(pendingReceiptPath, { force: true });
    const report = await runHealthReport([], layout.targets);
    return options.health === true
      ? {
          concurrencyUsed: 1,
          passCosts: [],
          report,
          skipped: 0,
          skippedCompression: [],
          written: 0,
        }
      : { concurrencyUsed: 1, passCosts: [], skipped: 0, skippedCompression: [], written: 0 };
  }

  const pendingPaths = new Set(failedBefore);
  let pendingUpdate = Promise.resolve();
  const recordPendingOutputs = async (outputs: readonly string[]): Promise<void> => {
    for (const output of outputs) pendingPaths.add(output);
    // `processOne` may have several runners. Serialize journal writes so one runner cannot publish
    // an older snapshot after another has already recorded more owned outputs.
    pendingUpdate = pendingUpdate.then(() =>
      writePendingOwnership(layout.outputRoot, pendingPaths),
    );
    await pendingUpdate;
  };

  /** Everything one entry contributes to the receipt, the health report and the size report.
   *
   * `measured` is what the health report reads. For everything the runtime can already load it is
   * the source, deliberately — see the comment at the `healthInputs.push` below. For a `.fbx`,
   * `.blend`, `.obj` or `.dae` it is the converted GLB, because the source is not a document this
   * reader knows: measuring it raised TN_ASSETS_MODEL_UNREADABLE and failed the whole compile. */
  const bookkeep = (
    logical: string,
    measured: Buffer,
    entry: IAssetManifestEntry,
    auxiliary: readonly {
      readonly bytes: number;
      readonly path: string;
      readonly producer: string;
    }[],
    lightmap: IModelSizeRow["lightmap"] | undefined,
  ): void => {
    // Declared from the entry rather than from the write below, because a cache hit skips the
    // write and the file is still this bake's output: the delete-test has to remove it too.
    receiptOutputs.push({
      bytes: entry.bytes,
      path: entry.output,
      producer: passNames.join("+"),
      source: logical,
    });
    for (const output of auxiliary) receiptOutputs.push({ ...output, source: logical });
    if (entry.extensions?.includes(BASISU_EXTENSION) === true) compressedModelCount += 1;
    // The health report measures the source, not the compiled bytes — deliberately for both
    // kinds. Texture dimensions, alpha and power-of-two are authoring properties a KTX2
    // output hides; model triangles and materials are the counts targets are declared
    // against, and the pass's self-verification guarantees they survive compilation within
    // tolerance. Byte savings are reported per kind below instead. A Blender-imported source is
    // the exception the caller resolves: its earliest readable form is the converted GLB.
    healthInputs.push({
      data: measured,
      logicalPath: logical,
      ...(needsBlenderImport(logical)
        ? { modelPath: path.join(layout.outputRoot, entry.output) }
        : {}),
    });
    if (entry.audio !== undefined) {
      // Routed before the texture branch: an audio entry carries `bytesBefore` and no triangle
      // count, which is exactly the shape the texture fallback below claims for itself.
      audioRows.push(entry.audio);
      return;
    }
    if (entry.bytesBefore === undefined) return;
    if (entry.triangles !== undefined) {
      modelRows.push({
        after: entry.bytes,
        before: entry.bytesBefore,
        ...(entry.embeddedTextures === undefined
          ? {}
          : { embeddedTextures: entry.embeddedTextures }),
        ...(entry.simplify === undefined ? {} : { simplify: entry.simplify }),
        ...(entry.compact === undefined ? {} : { compact: entry.compact }),
        ...(entry.lod === undefined ? {} : { lod: entry.lod }),
        ...(entry.materials === undefined ? {} : { materials: entry.materials }),
        extensions: entry.extensions,
        logicalPath: logical,
        ...(lightmap === undefined ? {} : { lightmap }),
        triangles: entry.triangles,
      });
    } else {
      textureRows.push({
        ...(entry.quality === undefined ? {} : { quality: entry.quality }),
        after: entry.bytes,
        before: entry.bytesBefore,
        // Read off the manifest entry, not off the pass: a cache hit reuses the previous entry
        // and never runs the pass that decided this, and a silent flat row is what let an
        // uncompressed texture look like a compressed one.
        ...(entry.compressionSkipped === undefined
          ? {}
          : { compressionSkipped: entry.compressionSkipped }),
        format: entry.format,
        logicalPath: logical,
      });
      textureCount += 1;
      // Raw ASTC is a KTX2 container but needs no Basis transcoder. Any Basis codec does.
      if (entry.format !== undefined && entry.format !== "none" && entry.format !== "astc4x4")
        ktx2TextureCount += 1;
    }
  };

  // The scheduler: independent work runs bounded-concurrent, everything that depends on order
  // — the merge, the writes, the counters — stays on this thread and is keyed or
  // stable-merged, which the determinism gate proves. A compile with custom passes has no
  // serialisable mirror and runs sequential.
  const concurrency = resolveConcurrency(options.concurrency ?? layout.concurrency);
  const pool =
    activePassSpecs.length > 0 && concurrency > 1
      ? createPassPool(concurrency, activePassSpecs, layout.outputRoot)
      : undefined;

  /** One cooked source, published as itself. */
  const cookOne = async (logical: string): Promise<ICookedModel> => {
    const input = await readSource(logical);
    const digest = createHash("sha256")
      .update(input)
      .update(passConfigurations[classify(logical)], "utf8")
      .digest("hex");
    // The output name carries the digest of the input bytes and the whole pass configuration,
    // so a previous entry under that exact name, with every file it declares still on disk, is
    // this build's answer already: the passes are not run again. A build once applied every
    // pass to every input and only then compared — minutes of texture encoding per `pnpm dev`
    // for bytes that already existed.
    const previousEntry = previous.entries[logical];
    const reusable =
      previousEntry === undefined
        ? undefined
        : await reusableEntry(layout.outputRoot, logical, digest.slice(0, 8), previousEntry);
    if (previousEntry !== undefined && reusable !== undefined) {
      const reused = withFreshLodRuntime(previousEntry, logical, layout.lod, layout.lodLegacy);
      entries[logical] = reused;
      // A cache hit never ran the converter, so the GLB the report must measure is the one already
      // on disk under this entry's output name.
      const measured = needsBlenderImport(logical)
        ? await readFile(path.join(layout.outputRoot, previousEntry.output))
        : input;
      bookkeep(logical, measured, reused, reusable, undefined);
      recordCachedInputs(costInputs, passNames);
      skipped += 1;
      return {
        auxiliary: reusable,
        entry: reused,
        lightmap: undefined,
        measured,
      };
    }
    const applied =
      pool === undefined
        ? await applyPasses(activePasses, input, logical)
        : await pool.run(logical, input);
    recordRanTimings(costInputs, logical, applied.timings);
    const auxiliaryOutputs = resolveAuxiliaryOutputs(logical, applied.auxiliaryOutputs);
    const auxiliaryFields = auxiliaryManifestFields(auxiliaryOutputs);
    const extensions = Array.isArray(applied.entry?.extensions)
      ? (applied.entry.extensions as string[])
      : sourceModelExtensions(logical, input);
    const created: IAssetManifestEntry = {
      bytes: applied.buffer.length,
      kind: classify(logical),
      output: outputNameFor(logical, digest.slice(0, 8), applied.extension),
      passes: [...passNames],
      ...auxiliaryFields,
      ...(extensions === undefined ? {} : { extensions }),
      ...(applied.entry === undefined
        ? {}
        : {
            bytesAfter: applied.buffer.length,
            bytesBefore: input.length,
            audio: audioRow(applied.entry.audio),
            embeddedTextures: embeddedTextureRow(applied.entry.embeddedTextures),
            quality: readTextureQuality(applied.entry.quality),
            compact: compactRow(applied.entry.compact),
            simplify: simplifyRow(applied.entry.simplify),
            lod: lodRow(applied.entry.lod),
            materials: materialRow(applied.entry.materials),
            format: typeof applied.entry.format === "string" ? applied.entry.format : undefined,
            ...(applied.entry.compressionSkipped === "block-size" ||
            applied.entry.compressionSkipped === "below-floor" ||
            applied.entry.compressionSkipped === "not-smaller"
              ? { compressionSkipped: applied.entry.compressionSkipped }
              : {}),
            importedFrom:
              typeof applied.entry.importedFrom === "string"
                ? applied.entry.importedFrom
                : undefined,
            lightmapAtlas: isRecord(applied.entry.lightmapAtlas)
              ? applied.entry.lightmapAtlas
              : undefined,
            triangles:
              typeof applied.entry.triangles === "number" ? applied.entry.triangles : undefined,
            transcodeTargets: Array.isArray(applied.entry.transcodeTargets)
              ? (applied.entry.transcodeTargets as string[])
              : undefined,
            vertices:
              typeof applied.entry.vertices === "number" ? applied.entry.vertices : undefined,
          }),
    };
    const entry = withFreshLodRuntime(created, logical, layout.lod, layout.lodLegacy);
    entries[logical] = entry;
    const lightmapOutput = auxiliaryOutputs.find((output) => output.manifestField === "lightmaps");
    const lightmapMetadata = lightmapOutput?.metadata;
    const lightmapAtlas = applied.entry?.lightmapAtlas;
    const lightmap =
      lightmapOutput !== undefined &&
      isRecord(lightmapMetadata) &&
      isRecord(lightmapAtlas) &&
      typeof applied.entry?.lightmapBakeMs === "number"
        ? {
            atlasHeight: Number(lightmapAtlas.height),
            atlasWidth: Number(lightmapAtlas.width),
            bakeMs: applied.entry.lightmapBakeMs,
            bytesAfter: lightmapOutput.buffer.length,
            bytesBefore: Number(lightmapMetadata.bytesBefore),
            dilatedTexels: Number(lightmapMetadata.dilatedTexels),
            occludedTexels: Number(lightmapMetadata.occludedTexels),
            validTexels: Number(lightmapMetadata.validTexels),
          }
        : undefined;
    const measured = needsBlenderImport(logical) ? applied.buffer : input;
    const auxiliary = auxiliaryOutputs.map((output) => ({
      bytes: output.buffer.length,
      path: output.output,
      producer: output.role,
    }));
    bookkeep(logical, measured, entry, auxiliary, lightmap);
    const existing = previous.entries[logical];
    if (
      existing !== undefined &&
      sameEntry(existing, entry) &&
      (await outputExists(path.join(layout.outputRoot, entry.output))) &&
      (
        await Promise.all(
          auxiliaryOutputs.map((output) =>
            outputExists(path.join(layout.outputRoot, output.output)),
          ),
        )
      ).every(Boolean)
    ) {
      skipped += 1;
      return { auxiliary, entry, lightmap, measured };
    }
    await recordPendingOutputs([entry.output, ...auxiliaryOutputs.map((output) => output.output)]);
    await writeOutput(layout.outputRoot, entry, applied.buffer);
    for (const output of auxiliaryOutputs) {
      const absolute = path.join(layout.outputRoot, output.output);
      // A shared image is content-addressed and may already have been written by another model
      // in this run or a previous one; identical bytes are not written twice. The write itself
      // is temp-then-rename: a concurrent merge of the same image must never observe a torn
      // file, and two identical-content writers cannot interleave.
      if (output.shared && (await outputExists(absolute))) continue;
      await mkdir(path.dirname(absolute), { recursive: true });
      const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, output.buffer);
        await rename(temporary, absolute);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    }
    written += 1;
    return { auxiliary, entry, lightmap, measured };
  };

  /**
   * One source: cooked, or the cook it shares with a canonical member of its content group.
   *
   * A duplicate never reads its own bytes again and never runs a pass. It publishes the
   * canonical's entry — the same output URL, the same cooked bytes — with `bytesBefore` measured
   * against its own source, because what that file weighed is the one number about it that is
   * its own. Its auxiliary outputs and its health measurement are the canonical's, which is what
   * sharing one output means: the same embedded images, the same geometry.
   */
  const cookedModels = new Map<string, Promise<ICookedModel>>();
  const processOne = async (logical: string): Promise<void> => {
    const canonical = canonicalOf.get(logical);
    if (canonical === undefined) {
      // Registered before the cook's first await, so a duplicate queued behind it always finds
      // the cook it reuses.
      const pending = cookOne(logical);
      cookedModels.set(logical, pending);
      await pending;
      return;
    }
    const pending = cookedModels.get(canonical);
    if (pending === undefined) {
      throw new Error(
        `TN_ASSETS_MODEL_DEDUPE_ORDER: '${logical}' is content-identical to '${canonical}', which this cook has not reached; the queue must place every canonical before the members that share it.`,
      );
    }
    const cooked = await pending;
    dedupeSavedBytes += cooked.entry.bytes;
    // A generated proxy exists only in the overlay, so its own bytes are the measurement; a real
    // duplicate is measured from disk.
    const overlaid = overlay.get(logical);
    const entry = withFreshLodRuntime(
      {
        ...cooked.entry,
        bytesBefore: overlaid?.length ?? (await stat(path.join(layout.sourceRoot, logical))).size,
      },
      logical,
      layout.lod,
      layout.lodLegacy,
    );
    entries[logical] = entry;
    bookkeep(logical, cooked.measured, entry, cooked.auxiliary, cooked.lightmap);
    recordCachedInputs(costInputs, passNames);
    skipped += 1;
  };

  // Every canonical is queued before any member that reuses its cook. That is what makes a
  // duplicate's wait terminate: the runner holding the canonical is never waiting on a duplicate.
  const queue = [
    ...logicals.filter((logical) => !canonicalOf.has(logical)),
    ...logicals.filter((logical) => canonicalOf.has(logical)),
  ];
  const runnerCount = Math.min(pool === undefined ? 1 : concurrency, queue.length);
  try {
    await Promise.all(
      Array.from({ length: runnerCount }, () =>
        (async () => {
          for (;;) {
            const logical = queue.shift();
            if (logical === undefined) return;
            await processOne(logical);
          }
        })(),
      ),
    );
  } finally {
    await pool?.dispose();
  }

  // The transcoder ships once per build next to the compiled assets; the runtime loader points
  // at `<basePath>basis/` by convention. Copied only when an output is actually Basis-encoded:
  // a JPEG or PNG texture, and a model whose images stayed in their authored container, do not
  // need it. Restored when a cleaned public/ still lists KTX2 outputs, so a served manifest never
  // lacks its transcoder.
  if (ktx2TextureCount > 0 || compressedModelCount > 0) {
    const basisJs = path.join(layout.outputRoot, BASIS_DIRECTORY, "basis_transcoder.js");
    if (written > 0 || !(await outputExists(basisJs))) {
      await recordPendingOutputs([
        `${BASIS_DIRECTORY}/basis_transcoder.js`,
        `${BASIS_DIRECTORY}/basis_transcoder.wasm`,
      ]);
      await copyBasisTranscoder(
        layout.outputRoot,
        options.transcoder ?? resolveBasisTranscoder(cwd),
      );
    }
    // Copied on this run or restored from a previous one, the transcoder is still a file the
    // bake put there and the game must survive losing.
    for (const name of ["basis_transcoder.js", "basis_transcoder.wasm"]) {
      const relative = `${BASIS_DIRECTORY}/${name}`;
      const absolute = path.join(layout.outputRoot, BASIS_DIRECTORY, name);
      if (!(await outputExists(absolute))) continue;
      receiptOutputs.push({
        bytes: (await stat(absolute)).size,
        path: relative,
        producer: "basis-transcoder",
        source: null,
      });
    }
  }

  // The native cooked package (PRD-515) is an additional output, never a replacement: enabling
  // it leaves every existing output byte-identical. Written after the cook, so a cache hit
  // rebuilds it from the outputs already on disk.
  if (layout.nativePackage) {
    await recordPendingOutputs([NATIVE_PACKAGE_NAME]);
    const output = await writeNativePackageOutput(
      layout.outputRoot,
      entries,
      new Set([...writtenBefore, ...receiptOutputs.map((output) => output.path)]),
    );
    if (output !== undefined) receiptOutputs.push(output);
  }

  // The report runs unconditionally — it is the one place a user learns why their game is
  // slow. Only declared targets can fail it.
  assertCompletePassCosts(costInputs, logicals.length);
  const passCosts = buildPassCostRows(costInputs);
  const report = await runHealthReport(healthInputs, layout.targets);
  for (const line of formatHealthReport(report)) console.log(line);
  for (const line of formatAudioSizes(audioRows)) console.log(line);
  for (const line of formatTextureSizes(textureRows)) console.log(line);
  for (const line of formatModelSizes(modelRows)) console.log(line);
  const rungs = [
    ...textureRows.map((row) => row.format ?? "none"),
    ...modelRows.flatMap((row) => Object.values(row.embeddedTextures?.formats ?? {})),
  ];
  if (rungs.length > 0) console.log(formatTextureRungs(rungs));
  const qualityScores = [
    ...textureRows.flatMap((row) => (row.quality === undefined ? [] : [row.quality])),
    ...modelRows.flatMap((row) => Object.values(row.embeddedTextures?.quality ?? {})),
  ];
  if (qualityScores.length > 0) console.log(formatTextureQualityTotals(qualityScores));
  const dedupe: IModelDedupeSummary | undefined =
    modelSources.length === 0
      ? undefined
      : {
          cooked: modelSources.length - canonicalOf.size,
          savedBytes: dedupeSavedBytes,
          sources: modelSources.length,
        };
  if (dedupe !== undefined) console.log(formatModelDedupe(dedupe));
  if (
    isRecord(options.config) &&
    isRecord(options.config.models) &&
    options.config.models.sharedImages === false
  ) {
    const embeddedBytes = modelRows.reduce(
      (total, row) => total + (row.embeddedTextures?.bytesAfter ?? 0),
      0,
    );
    console.log(
      `TN_ASSETS_SHARED_IMAGES_DISABLED: assets.models.sharedImages=false; ${modelRows.length} model(s), ${embeddedBytes} image bytes embedded separately; duplicates are not shared.`,
    );
  }
  const skippedCompression = skippedCompressionRows(entries, layout);
  for (const line of formatPassCosts(passCosts)) console.log(line);
  for (const line of formatSkippedCompression(skippedCompression)) console.log(line);
  const budgetReport = await measureBudget(
    entries,
    layout.outputRoot,
    layout.runtimeDecoderCapabilities,
    layout.budget,
    receiptOutputs,
  );
  for (const line of formatBudget(budgetReport)) console.log(line);
  assertBudget(budgetReport);
  if (report.failed) {
    const failedAssets = report.findings
      .filter((finding) => finding.grade === "fail")
      .map((finding) => finding.asset);
    throw new Error(
      `TN_ASSETS_HEALTH_FAILED: ${failedAssets.length} declared asset target(s) exceeded: ${[...new Set(failedAssets)].join(", ")}`,
    );
  }
  const currentReceiptPaths = new Set(receiptOutputs.map((output) => output.path));
  await assertNoUndeclaredOutputs(
    layout.outputRoot,
    currentReceiptPaths,
    runStart,
    writtenBefore,
    existingBefore,
  );
  const staleOutputs = await resolveStaleReceiptOutputs(
    layout.outputRoot,
    new Set([...writtenBefore, ...pendingPaths]),
    currentReceiptPaths,
  );
  // An invalid old receipt must not replace the last successful manifest with a manifest for a
  // cook that cannot commit. Validation is complete before this publication point.
  await writeManifest(manifestPath, layout.outputRoot, previous.raw, entries);
  for (const target of staleOutputs) await rm(target, { force: true });
  // Publish success only after cleanup. If validation/deletion fails, the old receipt and pending
  // journal jointly retain ownership for a reliable retry.
  const receipt = await writeReceipt(layout.outputRoot, receiptOutputs);
  await rm(pendingReceiptPath, { force: true });
  const concurrencyUsed = pool === undefined ? 1 : Math.min(concurrency, logicals.length);
  const shared = {
    concurrencyUsed,
    ...(dedupe === undefined ? {} : { dedupe }),
    passCosts,
    receipt,
    skipped,
    skippedCompression,
    written,
  };
  return options.health === true ? { ...shared, report } : shared;
}

/**
 * Sums what each disabled built-in pass is shipping as authored.
 *
 * Reads the sizes already recorded on every manifest entry, so a build that opted out pays one
 * addition per asset and no I/O at all — the measurement must not become a reason to skip it.
 * A caller that replaced the pass registry wholesale (`options.passes`) has not opted out of
 * anything and reports nothing.
 */
function skippedCompressionRows(
  entries: Readonly<Record<string, IAssetManifestEntry>>,
  layout: ICompileLayout,
): readonly ISkippedReportRow[] {
  const rows: ISkippedReportRow[] = layout.skippedPasses.map((pass) => ({
    kind: "pass",
    pass,
    reason: "platform",
  }));
  const decisions = [
    { kind: "model" as const, reason: layout.modelCompressionReason },
    { kind: "texture" as const, reason: layout.textureCompressionReason },
  ];
  for (const { kind, reason } of decisions) {
    if (reason === undefined || !layout.builtinRegistry) continue;
    let bytes = 0;
    let files = 0;
    // Counted per output, not per source: content-identical models share one cooked file, and
    // this row is about what the build ships.
    const counted = new Set<string>();
    for (const entry of Object.values(entries)) {
      if (entry.kind !== kind || counted.has(entry.output)) continue;
      counted.add(entry.output);
      bytes += entry.bytes;
      files += 1;
    }
    rows.push({
      bytes,
      files,
      kind,
      ...(kind === "model" ? { decoders: layout.modelCompressionDecoders } : {}),
      reason,
    });
  }
  return rows;
}
