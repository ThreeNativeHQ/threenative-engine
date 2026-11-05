import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertBudget, measureBudget } from "./budget.js";
import { BASIS_DIRECTORY, copyBasisTranscoder, resolveBasisTranscoder } from "./compile-basis.js";
import { resolveLayout, walkSources } from "./compile-layout.js";
import {
  type IPassCostRecord,
  assertCompletePassCosts,
  assertNoUndeclaredOutputs,
  auxiliaryManifestFields,
  buildPassCostRows,
  hasSourceDirectory,
  outputExists,
  outputNameFor,
  readExistingManifest,
  readInput,
  readPreviousReceiptPaths,
  recordCachedInputs,
  recordRanTimings,
  removeStaleReceiptOutputs,
  resolveAuxiliaryOutputs,
  resolveStaleReceiptOutputs,
  reusableEntry,
  sameEntry,
  sourceModelExtensions,
  walkOutputFiles,
  withFreshLodRuntime,
  writeManifest,
  writeNativePackageOutput,
  writeOutput,
  writePendingOwnership,
  writeReceipt,
} from "./compile-receipt.js";
import {
  BASISU_EXTENSION,
  MANIFEST_NAME,
  PENDING_RECEIPT_NAME,
  PIPELINE_VERSION,
  RECEIPT_NAME,
  audioRow,
  compactRow,
  embeddedTextureRow,
  isRecord,
  lodRow,
  materialRow,
  simplifyRow,
  skippedCompressionRows,
} from "./compile-rows.js";
import { classify } from "./compile-types.js";
import type {
  AssetKind,
  IAssetCompileOptions,
  IAssetCompileResult,
  IAssetManifestEntry,
  IBakeReceiptOutput,
  IBasisTranscoder,
  ICompileLayout,
  ICookedModel,
  ISharedImageManifestEntry,
} from "./compile-types.js";
import type { IModelDedupeSummary } from "./content/model-dedupe.js";
import { formatModelDedupe, groupModelSources } from "./content/model-dedupe.js";
import type { IAssetHealthInput } from "./health.js";
import { formatHealthReport, runHealthReport } from "./health.js";
import { readTextureQuality } from "./image-quality.js";
import { NATIVE_PACKAGE_NAME } from "./native-package.js";
import { applyPasses } from "./pass-chain.js";
import { audioPass } from "./passes/audio.js";
import { BLENDER_IMPORT_PASS, needsBlenderImport } from "./passes/blender-import.js";
import { globMatch } from "./passes/glob.js";
import { BASIS_TRANSCODER_BYTES } from "./passes/model-textures.js";
import { modelPass } from "./passes/model.js";
import { createSharedImageStore, unpackGlb } from "./passes/shared-images.js";
import type { IAudioRow, IModelSizeRow, ISkippedReportRow, ITextureSizeRow } from "./report.js";
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
import { createPassPool, resolveConcurrency } from "./worker-pool.js";
import {
  applyProxiesToWorld,
  cookWorldProxies,
  formatWorldHlod,
  readWorldPackage,
} from "./world/proxy.js";

export type {
  AssetKind,
  IAssetAuxiliaryOutput,
  IAssetCompileOptions,
  IAssetCompileResult,
  IAssetPass,
  IAssetPassOutput,
  IAssetSourceConfig,
  IAssetTargets,
  IAudioConfig,
  IBakeReceipt,
  IBakeReceiptOutput,
  IBasisTranscoder,
  IModelsConfig,
  ITexturesConfig,
} from "./compile-types.js";
export { classify } from "./compile-types.js";
export { resolveBasisTranscoder } from "./compile-basis.js";

/**
 * The Basis transcoder is one download per build, so whether model images may use KTX2 is decided
 * for the whole build: free when a standalone texture or a required model image already ships it,
 * or when the KTX2 savings summed over every model repay it; otherwise each image pays it alone.
 */
interface ITranscoderChargeState {
  readonly countedImages: Set<string>;
  readonly countedOutputs: Set<string>;
  needsSharedRecount: boolean;
  paid: boolean;
  savings: number;
}

function addTranscoderCharge(entry: IAssetManifestEntry, state: ITranscoderChargeState): void {
  if (entry.kind === "texture" && entry.format !== undefined) {
    if (entry.format !== "none" && entry.format !== "astc4x4") state.paid = true;
    return;
  }
  const row = entry.embeddedTextures;
  // Content-identical sources share one output; its images download once.
  if (row === undefined || state.countedOutputs.has(entry.output)) return;
  state.countedOutputs.add(entry.output);
  state.paid ||= row.transcoderRequired === true;
  const images = entry.sharedImages;
  if (images === undefined || images.length === 0) {
    state.savings += row.transcoderSavings ?? 0;
    return;
  }
  const detailed = images.filter(isAccountedSharedImage);
  if (detailed.length !== images.length) {
    // Probe with KTX2 so the recook writes per-image savings, then settle from that manifest.
    state.needsSharedRecount ||= (row.transcoderSavings ?? 0) > 0;
    return;
  }
  for (const image of detailed) {
    if (state.countedImages.has(image.key)) continue;
    state.countedImages.add(image.key);
    state.paid ||= image.transcoderRequired;
    state.savings += image.transcoderSavings;
  }
}

export function modelTranscoderCharge(
  entries: Readonly<Record<string, IAssetManifestEntry>>,
): 0 | undefined | "either" {
  const state: ITranscoderChargeState = {
    countedImages: new Set(),
    countedOutputs: new Set(),
    needsSharedRecount: false,
    paid: false,
    savings: 0,
  };
  for (const entry of Object.values(entries)) addTranscoderCharge(entry, state);
  if (state.needsSharedRecount) return 0;
  // No model image would save bytes as KTX2, so the charge changes nothing.
  if (state.savings === 0) return "either";
  return state.paid || state.savings >= BASIS_TRANSCODER_BYTES ? 0 : undefined;
}

function isAccountedSharedImage(value: unknown): value is ISharedImageManifestEntry & {
  readonly key: string;
  readonly transcoderRequired: boolean;
  readonly transcoderSavings: number;
} {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.transcoderRequired === "boolean" &&
    typeof value.transcoderSavings === "number"
  );
}

export async function compileAssets(
  options: IAssetCompileOptions = {},
): Promise<IAssetCompileResult> {
  if (options.modelTranscoderBytes !== undefined) return compileOnce(options);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const manifestPath = path.join(resolveLayout(cwd, options).outputRoot, MANIFEST_NAME);
  const charge = async () =>
    modelTranscoderCharge((await readExistingManifest(manifestPath)).entries);
  // The last bake's manifest predicts the decision, so a warm build cooks once.
  const predicted = await charge();
  const used = predicted === "either" ? undefined : predicted;
  const result = await compileOnce({ ...options, modelTranscoderBytes: used });
  const decided = await charge();
  if (decided === "either" || decided === used) return result;
  // ponytail: a build whose decision flips cooks its models twice, once; the manifest then
  // carries the decision. Decide inside one cook if cold builds of large projects hurt.
  const second = await compileOnce({ ...options, modelTranscoderBytes: decided });
  return { ...second, written: result.written + second.written };
}

async function compileOnce(options: IAssetCompileOptions): Promise<IAssetCompileResult> {
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
  const cookedWorlds = new Set<string>();
  for (const logical of modelSources) {
    if (path.extname(logical).toLowerCase() !== ".glb") continue;
    // The marker scan is not the readability authority. `models: "none"` leaves no model pass in
    // the chain, so nothing would parse the file at all and it must copy through as it did before
    // this scan existed; the model pass (when one runs) and the unconditional health report both
    // own the actionable malformed-model error. A GLB this unpacker refuses is simply not a
    // cooked terrain world.
    try {
      if (unpackGlb(await readSource(logical)).json.asset.extras?.tnTerrainWorld === 1) {
        cookedWorlds.add(logical);
      }
    } catch {}
  }
  const perAssetLod =
    typeof layout.lod === "object" && layout.lod !== null && layout.lod.overrides !== undefined
      ? new Set(Object.keys(layout.lod.overrides))
      : new Set<string>();
  const canonicalOf = await groupModelSources(
    layout.sourceRoot,
    modelSources.filter((logical) => !perAssetLod.has(logical) && !cookedWorlds.has(logical)),
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
  // Cooked terrain owns its geometry and look; native only needs a portable buffer layout.
  const terrainPasses =
    options.platform === undefined || options.platform === "web"
      ? []
      : [
          modelPass({
            vertexLayout: "separate",
            compact: false,
            passes: {
              dedup: false,
              meshopt: false,
              prune: false,
              quantize: false,
              reorder: false,
              restTracks: false,
            },
            textures: "none",
            virtual: "none",
            lod: false,
          }),
        ];
  const terrainPassNames = terrainPasses.map((pass) => pass.name);

  const costInputs = new Map<string, IPassCostRecord>();
  for (const name of new Set([...passNames, ...terrainPassNames]))
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
      producer: entry.passes.join("+"),
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

  /** Publish authored data with the target's vertex layout. */
  const cookOne = async (logical: string): Promise<ICookedModel> => {
    const input = await readSource(logical);
    const terrainWorld = cookedWorlds.has(logical);
    const digest = createHash("sha256")
      .update(input)
      .update(
        terrainWorld
          ? terrainPasses.length === 0
            ? "terrain-world-v1"
            : "terrain-world-native-separate-v2"
          : passConfigurations[classify(logical)],
        "utf8",
      )
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
      recordCachedInputs(costInputs, terrainWorld ? terrainPassNames : passNames);
      skipped += 1;
      return {
        auxiliary: reusable,
        entry: reused,
        lightmap: undefined,
        measured,
      };
    }
    const applied = terrainWorld
      ? await applyPasses(terrainPasses, input, logical)
      : pool === undefined
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
      passes: [...(terrainWorld ? terrainPassNames : passNames)],
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
  assertCompletePassCosts(
    costInputs,
    (pass) =>
      (passNames.includes(pass) ? logicals.length - cookedWorlds.size : 0) +
      (terrainPassNames.includes(pass) ? cookedWorlds.size : 0),
  );
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
