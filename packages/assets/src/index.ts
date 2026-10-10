export type {
  AssetKind,
  IAudioConfig,
  IAssetCompileOptions,
  IAssetCompileResult,
  IAssetPass,
  IAssetPassOutput,
  IAssetSourceConfig,
  IAssetTargets,
  IBakeReceipt,
  IBakeReceiptOutput,
  IBasisTranscoder,
  IModelsConfig,
  ITexturesConfig,
} from "./compile.js";
/**
 * Compiles a project's source assets into content-addressed runtime files and a manifest.
 * @situation compile game assets before a web or native build
 * @situation optimize textures for the GPU
 * @situation produce a manifest for runtime asset loading
 * @constraint source and output directories must be disjoint; a pass failure stops the build with the asset path
 * @example const result = await compileAssets({ source: "assets", output: "public" });
 */
export { compileAssets } from "./compile.js";

/**
 * Finds Three.js's Basis Universal transcoder files for the runtime KTX2 loader.
 * @situation prepare compressed textures for runtime loading
 * @situation copy the Basis transcoder into a compiled asset output
 * @constraint the supplied working directory must resolve both basis_transcoder.js and basis_transcoder.wasm from its Three.js installation
 * @example const transcoder = resolveBasisTranscoder(process.cwd());
 */
export { resolveBasisTranscoder } from "./compile.js";
export type {
  IEmbeddedTextureSummary,
  IModelCompactInstanceOptions,
  IModelCompactOptions,
  IModelCompactSummary,
  IModelPassOptions,
  IModelPassesOptions,
  IModelProtectedNode,
  IModelQuantizeOptions,
  IModelSimplifyOptions,
  IModelSimplifySummary,
  IModelTextureBinding,
  IModelTextureBindings,
  IModelTextureOverride,
  IModelTexturesOptions,
  IResolvedCompactOptions,
  TModelProtectedRule,
} from "./passes/model.js";
/**
 * Optimizes self-contained GLB models through the configured geometry and embedded-texture passes.
 * @situation reduce a model's download and GPU footprint
 * @situation optimize a GLB before shipping it with a game
 * @constraint the pass self-verifies reachable geometry, animation, bounds, and embedded texture bindings before returning output
 * @example const pass = modelPass({ simplify: { ratio: 0.5 } });
 */
export { modelPass } from "./passes/model.js";
export type { AudioBand } from "./passes/audio-dsp.js";
export type {
  AudioConditioning,
  AudioNormalisation,
  IAudioLoopOptions,
  IAudioOverride,
  IAudioPassOptions,
  IAudioSpectrumExpectation,
} from "./passes/audio-config.js";
/**
 * Validates a game's declared `assets.audio` block, the one place its keys and ranges are checked.
 * @situation validate a threenative.config.ts audio block before compiling assets
 * @situation ship audio exactly as committed without conditioning it
 * @constraint returns undefined for `"none"`, which drops the audio pass; an absent block returns the defaults
 * @constraint throws TN_ASSETS_CONFIG_INVALID or TN_ASSETS_CONFIG_UNKNOWN_KEY rather than dropping a key it does not know
 * @example const options = parseAudioConfig({ overrides: [{ glob: "audio/*.ogg", conditioning: "none" }] });
 */
export { parseAudioConfig } from "./passes/audio-config.js";
/**
 * Conditions a game's audio and proves the conditioning did not destroy it.
 * @situation make an ambience bed loop without an audible click
 * @situation halve what a positional sound effect costs a device's memory
 * @situation stop an audio asset shipping silent on desktop, Android and iOS
 * @constraint a clip declared a loop has its seam measured on the decoded output bytes and fails the build when it exceeds the threshold; the assertion cannot be declared away
 * @constraint which clips loop, which are positional, and what a clip is for are declared per glob and never inferred from a filename
 * @constraint sources must be RIFF/WAVE or Ogg Vorbis, which is exactly what every native target decodes; an MP3 fails the bake
 * @example const pass = audioPass({ overrides: [{ glob: "audio/*-bed.ogg", loop: true }] });
 */
export { audioPass } from "./passes/audio.js";
export type { ILightmapPassOptions } from "./passes/lightmap.js";
/**
 * Generates lightmap UVs and bakes a static GLB's lightmap atlas.
 * @situation add baked static lighting to a model
 * @situation generate TEXCOORD_1 data for a lightmapped scene
 * @constraint the input must be a static self-contained GLB with at least one punctual light
 * @example const pass = lightmapPass({ atlasSize: 1024, padding: 2 });
 */
export { lightmapPass } from "./passes/lightmap.js";
export type { ITextureOverride, ITexturePassOptions, TextureCodec } from "./passes/texture.js";
/**
 * Encodes standalone textures as mipmapped KTX2/Basis assets for GPU storage.
 * @situation optimize textures for the GPU
 * @situation compress PNG or JPEG files before runtime loading
 * @constraint compressed source width and height must each be divisible by 4; automatic cooking retains an unaligned source unchanged and reports block-size, while an explicit compression codec override fails
 * @example const pass = texturePass({ quality: 150 });
 */
export { texturePass } from "./passes/texture.js";
export type {
  IAudioRow,
  IEmbeddedTextureRow,
  IModelSizeRow,
  IPassCostAssetRow,
  IPassCostRow,
  ISimplifyRow,
  ITextureSizeRow,
  PassCostStatus,
} from "./report.js";
/**
 * Formats audio conditioning measurements for a build report.
 * @situation see what audio conditioning did to a clip's wire and decoded size
 * @situation read the loop seam and cross-fade a build measured
 * @constraint an empty row list produces no report lines
 * @example const lines = formatAudioSizes(audioRows);
 */
export { formatAudioSizes } from "./report.js";

/**
 * Formats model byte, geometry, and embedded-texture measurements for a build report.
 * @situation inspect how model optimization changed file and GPU sizes
 * @situation print model compression results after an asset build
 * @constraint rows must use bytes before and after from the same compiled input
 * @example const lines = formatModelSizes(modelRows);
 */
export { formatModelSizes } from "./report.js";

/**
 * Formats per-pass wall-clock costs for a build report.
 * @situation see which asset pass owns the wall clock after a bake
 * @situation compare pass costs between two builds before optimizing the pipeline
 * @constraint one row per pass in registry order, per-asset rows sorted by logical path
 * @example const lines = formatPassCosts(result.passCosts);
 */
export { formatPassCosts } from "./report.js";

/**
 * Formats standalone texture byte measurements for a build report.
 * @situation inspect texture compression savings
 * @situation print which codec a compiled texture uses
 * @constraint an empty row list produces no report lines
 * @example const lines = formatTextureSizes(textureRows);
 */
export { formatTextureSizes } from "./report.js";
export type { IPngInfo } from "./png.js";
/**
 * Reads dimensions and alpha metadata from a PNG signature and IHDR header.
 * @situation inspect a PNG before choosing a texture codec
 * @situation read source texture dimensions in an asset health check
 * @constraint non-PNG or truncated bytes return undefined instead of being treated as a valid image
 * @example const png = parsePng(bytes); if (png !== undefined) console.log(png.width, png.height);
 */
export { parsePng } from "./png.js";
export type {
  AssetFindingGrade,
  IAssetFinding,
  IAssetHealthEntry,
  IAssetHealthInput,
  IAssetHealthReport,
  IModelStats,
  ITextureStats,
} from "./health.js";
/**
 * Formats asset health findings and their summary for human-readable output.
 * @situation print asset size, license, and target findings after compilation
 * @situation show why an asset health check is warning or failing
 * @constraint the returned lines describe findings; target enforcement happens in runHealthReport
 * @example const lines = formatHealthReport(report);
 */
export { formatHealthReport } from "./health.js";

/**
 * Measures compiled assets and grades them against declared project targets.
 * @situation check asset dimensions, triangles, materials, and licenses
 * @situation enforce asset budgets during a build
 * @constraint a finding is fail-grade only when the corresponding project target was declared
 * @example const report = await runHealthReport(inputs, { maxTextureDimension: 2048 });
 */
export { runHealthReport } from "./health.js";
export type { IAssetWatchHandle, IAssetWatchOptions, IAssetWatchSummary } from "./watch.js";
/**
 * Watches an asset source directory and recompiles settled changes during development.
 * @situation recompile a changed texture without restarting the dev server
 * @situation see asset pipeline failures as files are saved
 * @constraint call close on the returned handle; initial and burst failures are reported without stopping the dev server
 * @example const watcher = watchAssets({ cwd: process.cwd() });
 */
export { watchAssets } from "./watch.js";
/**
 * Pack texture sources into deterministic atlas pages and answer each source's UV transform, so a
 * build can stop giving every material a private texture.
 * @situation a merge found nothing to collapse because each imported part owns its own texture
 * @situation cut the material count of an imported model pack at build time
 * @constraint deterministic by construction: the packing order is derived from the sources, never from directory order, so a rebuild places every source at the same pixel
 * @constraint a source the scene samples outside [0, 1] is excluded and reported, never clamped onto a shared page
 * @constraint page bounds hold regardless of input order; padding keeps a mip tap from reaching the next source
 * @example const { pages, transforms, excluded } = packAtlas(sources, { pageSize: 4096, padding: 4 });
 */
export { atlasManifest, packAtlas } from "./atlas/packer.js";
export type {
  AtlasExclusionReason,
  IAtlasExclusion,
  IAtlasOptions,
  IAtlasPage,
  IAtlasPlacement,
  IAtlasResult,
  IAtlasSource,
} from "./atlas/packer.js";
/**
 * Move a mesh's UVs onto its atlas page, and decide from the geometry which meshes may not go.
 * @situation rewrite a model's texture coordinates after packing its images into an atlas
 * @situation tell a surface that tiles from one that merely has a repeating sampler
 * @constraint a surface is tiling when its own UVs leave [0, 1]; glTF's default wrap is REPEAT, so the sampler alone excludes almost everything and is the wrong test
 * @constraint the rewrite is in place, and a buffer that does not hold pairs throws rather than rewriting half a coordinate
 * @constraint `resolveSourceTexel` is the inverse, so a build can round-trip a texel instead of asserting the arithmetic against itself
 * @example if (!uvsTile(uv)) rewriteUvs(uv, transforms.get(source)!);
 */
export {
  WRAP_CLAMP_TO_EDGE,
  WRAP_MIRRORED_REPEAT,
  WRAP_REPEAT,
  resolveSourceTexel,
  rewriteUvs,
  uvsTile,
  wrapTiles,
} from "./atlas/rewrite-uvs.js";
/**
 * Collapse materials that became identical once their textures shared an atlas page, and count the
 * buckets a merge would find — before and after — so the promise can be checked rather than made.
 * @situation decide whether fewer objects is actually available in this content
 * @situation report why a per-material merge collapsed nothing
 * @constraint the signature ignores the material name, which is what made every imported part a singleton, and keeps materials apart on any field it does not understand
 * @constraint the census reads geometry and materials only: no GPU, no runtime, no game
 * @example pnpm census:content public/assets
 */
export {
  dedupeMaterials,
  materialSignature,
  withAtlasTextures,
} from "./content/dedupe-materials.js";
export type { IDedupeCensus, IMaterialBucket, IMaterialState } from "./content/dedupe-materials.js";
/**
 * Census one glTF document, or a directory of them: the merge buckets a scene has now, and the
 * buckets it would have once its atlasable textures shared pages.
 * @situation find out whether "fewer objects" is available in this content before promising it
 * @situation explain why a per-material merge collapsed nothing
 * @constraint reads geometry and materials only: no GPU, no runtime, no game
 * @constraint a texture whose size the document does not state is reported excluded, never assumed square
 * @constraint a model the reader cannot open is named, never skipped silently
 * @example pnpm census:content public/assets
 */
export { censusDocument, materialStateOf, totalCensus } from "./content/census.js";
export type { IContentCensus } from "./content/census.js";
/**
 * Bake evaluated terrain and static species into an instanced GLB and streaming world package.
 * @situation bake a terrain world headlessly into a GLB with instanced trees and rocks
 */
export { cookTerrainWorld } from "./world/terrain-world.js";
export type {
  ICookTerrainWorldMaterialLayer,
  ICookTerrainWorldOptions,
  ICookTerrainWorldResult,
  ISpeciesLODSpec,
  ISpeciesSpec,
  IWorldPackageAsset,
  IWorldPackageManifest,
} from "./world/terrain-world.js";
