import path from "node:path";
import type { IAssetBudget, IAssetRuntimeDecoderCapabilities } from "./budget.js";
import type { IModelDedupeSummary } from "./content/model-dedupe.js";
import type { IAssetHealthReport } from "./health.js";
import type { IModelLodOptions } from "./lod/generate.js";
import type { IAudioOverride } from "./passes/audio-config.js";
import type {
  IModelCompactInstanceOptions,
  IModelCompactOptions,
  IModelCompactSummary,
} from "./passes/compact.js";
import type { ILightmapPassOptions } from "./passes/lightmap.js";
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
import type { ITextureOverride, ITexturePassOptions, TextureSkipReason } from "./passes/texture.js";
import type {
  IAudioRow,
  IEmbeddedTextureRow,
  ILodRow,
  IMaterialsRow,
  IModelSizeRow,
  IPassCostRow,
  ISimplifyRow,
  ISkippedCompressionRow,
  ISkippedReportRow,
} from "./report.js";
import type { PassSpec } from "./worker-protocol.js";

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

export interface ISharedImageManifestEntry extends Readonly<Record<string, unknown>> {
  readonly key?: string;
  readonly output?: string;
  readonly transcoderRequired?: boolean;
  readonly transcoderSavings?: number;
}

export interface IAssetManifestEntry {
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
  readonly sharedImages?: readonly ISharedImageManifestEntry[];
  /** Triangle count of the compiled output (model pass). */
  readonly triangles?: number;
  readonly transcodeTargets?: readonly string[];
  /** Vertex count of the compiled output (model pass). */
  readonly vertices?: number;
}

export interface IAssetManifest {
  readonly entries: Record<string, IAssetManifestEntry>;
  readonly version: 1;
}

/**
 * What one cook contributes to the manifest, the receipt, the health report and the size report.
 *
 * A source that shares its content with an earlier one is not cooked; it publishes this record
 * unchanged apart from the bytes its own source weighed, so one output serves both.
 */
export interface ICookedModel {
  readonly auxiliary: readonly {
    readonly bytes: number;
    readonly path: string;
    readonly producer: string;
  }[];
  readonly entry: IAssetManifestEntry;
  readonly lightmap: IModelSizeRow["lightmap"] | undefined;
  readonly measured: Buffer;
}

export interface ICompileLayout {
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

export interface IDirectoryScan {
  readonly files: string[];
  readonly subdirectories: string[];
}

export const KIND_BY_EXTENSION: Readonly<Record<string, AssetKind>> = {
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

/** Shared with the health report so the kind vocabulary lives in exactly one place. */
export function classify(logicalPath: string): AssetKind {
  const extension = path.extname(logicalPath).slice(1).toLowerCase();
  return KIND_BY_EXTENSION[extension] ?? "other";
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
