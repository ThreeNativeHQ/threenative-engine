import type { IBudgetReport } from "./budget.js";
import { IMAGE_QUALITY_VERSION, type ITextureQuality } from "./image-quality.js";
import type { IModelCompactSummary } from "./passes/compact.js";
import type { TextureSkipReason } from "./passes/texture.js";

/** Both counters stay visible when either ceiling is disabled. */
export function formatBudget(report: IBudgetReport): readonly string[] {
  return [
    `TN_ASSETS_BUDGET: uncooked ${report.uncooked} bytes (ceiling ${report.budget.uncooked}); total ${report.total} bytes (ceiling ${report.budget.total})`,
    ...[...report.rows]
      .sort(
        (a, b) =>
          b.uncooked - a.uncooked ||
          b.total - a.total ||
          a.logicalPath.localeCompare(b.logicalPath),
      )
      .slice(0, 5)
      .map(
        (row) =>
          `  budget ${row.logicalPath}: uncooked ${row.uncooked} bytes, total ${row.total} bytes`,
      ),
  ];
}

/**
 * The person-readable size report the compile step prints after encoding: one line per
 * compressed texture and optimized model plus a total, before against after. Pure formatting
 * so tests can pin the exact lines a build prints.
 */
export interface ITextureSizeRow {
  readonly quality?: ITextureQuality;
  readonly after: number;
  readonly before: number;
  /** Set when the bytes shipped as authored; printed so a flat row is never left unexplained. */
  readonly compressionSkipped?: TextureSkipReason;
  readonly format: string | undefined;
  readonly logicalPath: string;
}

export function formatTextureSizes(rows: readonly ITextureSizeRow[]): readonly string[] {
  if (rows.length === 0) return [];
  const lines = rows.flatMap((row) => [
    `texture ${row.logicalPath}${row.format === undefined ? "" : ` (${row.format})`}: ${row.before} -> ${row.after} bytes ${deltaLabel(row.before, row.after)}${row.compressionSkipped === undefined ? "" : `; compression skipped: ${row.compressionSkipped}`}`,
    ...(row.quality === undefined ? [] : [qualityLine(row.logicalPath, row.quality)]),
  ]);
  const before = rows.reduce((total, row) => total + row.before, 0);
  const after = rows.reduce((total, row) => total + row.after, 0);
  lines.push(`textures total: ${before} -> ${after} bytes ${deltaLabel(before, after)}`);
  return lines;
}

/** What the model pass did to the images inside one `.glb`. */
export interface IEmbeddedTextureRow {
  readonly quality?: Readonly<Record<string, ITextureQuality>>;
  readonly skippedCompression?: Readonly<Record<string, TextureSkipReason>>;
  readonly bytesAfter: number;
  readonly bytesBefore: number;
  readonly count: number;
  /** Chosen codec per embedded image, keyed by texture name. */
  readonly formats?: Readonly<Record<string, string>>;
  readonly gpuBytesAfter: number;
  readonly gpuBytesBefore: number;
  readonly resized: number;
}

/** What the cluster-DAG bake produced for one model. */
export interface IVirtualRow {
  readonly bakeSeconds: number;
  readonly clusters: number;
  /** Primitives handed back to the discrete ladder because their DAG reduced nothing. */
  readonly declined: number;
  readonly levels: number;
  readonly payloadBytes: number;
  readonly primitives: number;
  readonly skipped: number;
  readonly stopReason: string;
}

/** What simplification delivered against what the config asked for. */
export interface ISimplifyRow {
  readonly achievedRatio: number;
  readonly error: number;
  readonly requestedRatio: number;
  readonly trianglesAfter: number;
  readonly trianglesBefore: number;
}

/** What automatic discrete generation produced for one model (PRD-377 §4.3). */
/** One material group inside an opt-in joined far rung: what it collapsed and how much it draws. */
export interface ILodJoinedGroupRow {
  readonly material: string;
  readonly primitives: number;
  readonly triangles: number;
}

/** The opt-in joined far rung as the manifest carries it: draws and the primitives collapsed. */
export interface ILodJoinedRow {
  readonly draws: number;
  readonly groups: readonly ILodJoinedGroupRow[];
  readonly primitives: number;
  readonly triangles: number;
  readonly trianglesBefore: number;
}

export interface ILodRow {
  /** Bytes the derived index buffers add, before compression. */
  readonly byteOverhead: number;
  /**
   * The foliage cutout conversion the cook ran before generating (PRD-458 §4): the `BLEND`
   * materials that became alpha-tested, and the ones that kept blending and why.
   */
  readonly cutout?: {
    readonly converted: readonly string[];
    readonly kept: readonly { readonly name: string; readonly reason: string }[];
  };
  /** Migration/legacy notes the resolver raised, by code. */
  readonly diagnostics: readonly string[];
  /** The resolved increasing geometric-error targets, as the bake consumed them. */
  readonly errorTargets: readonly number[];
  readonly fingerprint: string;
  readonly generated: number;
  /** Whether the opt-in join was requested; {@link joined} is present only when it did something. */
  readonly join: boolean;
  /** The opt-in joined far rung's honesty record, when one was produced. */
  readonly joined?: ILodJoinedRow;
  readonly levels: number;
  readonly maxLevels: number;
  /** Fraction of its predecessor's triangles a derived level had to save. */
  readonly minSaving: number;
  readonly minTriangles: number;
  /** What `minTriangles` measured against: `"primitive"` or `"asset"`. */
  readonly minTrianglesScope: string;
  readonly preset: string;
  readonly reasons: readonly string[];
  /** The runtime selection budget this asset ships with; the loader reads it from the manifest. */
  readonly runtime: { readonly hysteresis: number; readonly maxPixelError: number };
  readonly skipped: number;
  readonly trianglesAfter: number;
  readonly trianglesBefore: number;
}

/** Whether the pass executed this bake or every input that reached it was compile-cache-served. */
export type PassCostStatus = "cached" | "ran";

/** What one input cost the pass that processed it, as the pass driver measured it. */
export interface IPassCostAssetRow {
  readonly durationMs: number;
  readonly logicalPath: string;
}

/**
 * What one pass cost the whole bake: totals across inputs plus the per-asset attribution a
 * 274-file pack needs to name its expensive members. Durations are measured by the pass driver,
 * never reported by the pass itself, so a pass cannot opt out of measurement.
 */
export interface IPassCostRow {
  /** Per-input wall clock for the ran inputs, sorted by logical path; empty when cached. */
  readonly assets: readonly IPassCostAssetRow[];
  readonly cachedInputs: number;
  readonly durationMs: number;
  readonly pass: string;
  readonly ranInputs: number;
  readonly status: PassCostStatus;
}

/**
 * Formats the per-pass cost lines the compile prints after the size report: one line per pass,
 * then one line per input it ran on. A cached pass names its input count instead of a duration —
 * the cache decision is the source, never a threshold inferred from a fast run.
 */
export function formatPassCosts(rows: readonly IPassCostRow[]): readonly string[] {
  if (rows.length === 0) return [];
  return rows.flatMap((row) => {
    const summary =
      row.status === "cached"
        ? `cost pass ${row.pass}: cached for ${row.cachedInputs} input(s)`
        : `cost pass ${row.pass}: ran on ${row.ranInputs} input(s), ${Math.round(row.durationMs)} ms`;
    // Sorted here as well as where the rows are built: the stable-order property holds at the
    // formatting boundary, whatever order a caller's rows arrive in.
    const assets = [...row.assets].sort((left, right) =>
      left.logicalPath < right.logicalPath ? -1 : 1,
    );
    return [
      summary,
      ...assets.map((asset) => `  cost ${asset.logicalPath}: ${Math.round(asset.durationMs)} ms`),
    ];
  });
}

/**
 * What the audio pass measured and did to one clip.
 *
 * Every field is reported whether or not it was asserted on: an undeclared clip carries no
 * `seamMaxRatio` and still carries its measured seam, because turning a convention off must not
 * turn its measurement off. Every one of these numbers was measurable all along on the clips a
 * hand-written script conditioned; nothing measured them.
 */
export interface IAudioRow {
  /**
   * Where the clip's energy sits, as percentages across the five named bands summing to 100.
   *
   * Measured on every clip whether or not the game declared a bound, because this is the thing the
   * hand-written script that preceded this pass never looked at, and it is where both of the real
   * defects were.
   */
  readonly bandAir: number;
  readonly bandHigh: number;
  readonly bandLow: number;
  readonly bandMid: number;
  readonly bandSub: number;
  readonly bytesAfter: number;
  readonly bytesBefore: number;
  readonly channelsAfter: number;
  readonly channelsBefore: number;
  /** False when the game declared these bytes shipped as committed. */
  readonly conditioned: boolean;
  readonly container: string;
  /**
   * Whether the audio was re-encoded, or the source bytes shipped untouched because nothing here
   * moved the PCM. A needless re-encode costs a generation of lossy Vorbis to deliver the same
   * audio, so a pass that does nothing says so instead of quietly charging for it.
   */
  readonly reencoded: boolean;
  /** The fade applied, against the length the game asked for; absent unless the clip loops. */
  readonly crossFadeMs?: number;
  readonly crossFadeMsRequested?: number;
  readonly dcOffsetAfter: number;
  readonly dcOffsetBefore: number;
  /** What the clip costs a device's memory once decoded — the larger of the two costs. */
  readonly decodedBytesAfter: number;
  readonly decodedBytesBefore: number;
  readonly durationSeconds: number;
  readonly frames: number;
  readonly logicalPath: string;
  readonly loop: boolean;
  readonly peakAfter: number;
  readonly peakBefore: number;
  readonly sampleRate: number;
  /** The largest ordinary adjacent step within 50 ms of the join. */
  readonly seamNearP99: number;
  /**
   * `seamWrap / seamNearP99`, measured on the decoded output bytes — the ones that ship.
   *
   * The ratio rather than the magnitude, because a click is a step that is anomalous *where it
   * happens*: an absolute bound condemns dense clips and excuses quiet ones.
   */
  readonly seamRatio: number;
  readonly seamRatioBefore: number;
  /** The bare step across the join. Reported because it is informative, not because it is judged. */
  readonly seamWrap: number;
  readonly seamWrapBefore: number;
  /** Present only for a declared loop, which is the only clip whose seam is asserted. */
  readonly seamMaxRatio?: number;
  /** The band the game declared a bound on, and the bound; absent when it declared none. */
  readonly spectrumBand?: string;
  readonly spectrumMaxPercent?: number;
  readonly spectrumMinPercent?: number;
  readonly spectrumPercent?: number;
}

/**
 * One line per conditioned clip plus a total, on the wire and decoded.
 *
 * The decoded total is the one worth printing loudest: a 21-second stereo ambience bed is 220 KB
 * to download and 7.5 MB of resident memory, and it is the second number that decides whether a
 * phone keeps the app alive.
 */
export function formatAudioSizes(rows: readonly IAudioRow[]): readonly string[] {
  if (rows.length === 0) return [];
  const lines = rows.flatMap((row) => {
    const channels = `${row.channelsBefore}ch -> ${row.channelsAfter}ch`;
    const shipped = !row.conditioned
      ? " (shipped as committed)"
      : row.reencoded
        ? ""
        : " (already conditioned, so not re-encoded)";
    const first =
      `audio ${row.logicalPath} (${row.container})${shipped}: ${row.bytesBefore} -> ${row.bytesAfter} bytes ` +
      `${deltaLabel(row.bytesBefore, row.bytesAfter)}, decoded ${row.decodedBytesBefore} -> ${row.decodedBytesAfter} bytes ` +
      `${deltaLabel(row.decodedBytesBefore, row.decodedBytesAfter)}, ${channels}, ${row.durationSeconds.toFixed(3)} s at ${row.sampleRate} Hz`;
    const levels =
      `  audio ${row.logicalPath} levels: peak ${row.peakBefore.toFixed(4)} -> ${row.peakAfter.toFixed(4)}, ` +
      `DC ${row.dcOffsetBefore.toFixed(5)} -> ${row.dcOffsetAfter.toFixed(5)}`;
    return [first, levels, ...loopLine(row), ...spectrumLine(row)];
  });
  const before = rows.reduce((total, row) => total + row.bytesBefore, 0);
  const after = rows.reduce((total, row) => total + row.bytesAfter, 0);
  const decodedBefore = rows.reduce((total, row) => total + row.decodedBytesBefore, 0);
  const decodedAfter = rows.reduce((total, row) => total + row.decodedBytesAfter, 0);
  lines.push(
    `audio total: ${before} -> ${after} bytes ${deltaLabel(before, after)}, ` +
      `decoded ${decodedBefore} -> ${decodedAfter} bytes ${deltaLabel(decodedBefore, decodedAfter)}`,
  );
  return lines;
}

/**
 * The seam, and the fade it took to get there.
 *
 * An unlooped clip's seam is printed too, without a verdict: the number is the whole point, and
 * a clip nobody declared a loop is not failed for having one.
 */
function loopLine(row: IAudioRow): readonly string[] {
  if (!row.loop) {
    // A one-shot's first and last samples never meet, so this number is not a measurement of
    // anything a listener hears; it is printed only so a clip nobody declared is not a blank.
    return [
      `  audio ${row.logicalPath} wrap: ${row.seamWrap.toFixed(4)} (not declared a loop, so not judged)`,
    ];
  }
  const requested = row.crossFadeMsRequested ?? 0;
  const applied = row.crossFadeMs ?? 0;
  // A splice that moved is said out loud, the way the model pass names the ratio it reached
  // against the one that was asked for.
  const moved =
    applied === 0
      ? ", no cross-fade — the clip keeps its own length"
      : Math.abs(applied - requested) < 0.5
        ? ""
        : ` (requested ${requested.toFixed(0)} ms; the splice moved to find a quiet seam)`;
  return [
    `  audio ${row.logicalPath} loop: wrap ${row.seamWrapBefore.toFixed(4)} -> ${row.seamWrap.toFixed(4)}, ` +
      `${row.seamRatioBefore.toFixed(2)}x -> ${row.seamRatio.toFixed(2)}x of the largest ordinary step beside it ` +
      `(${row.seamNearP99.toFixed(4)}), against a ${String(row.seamMaxRatio ?? 0)}x limit, ` +
      `cross-fade ${applied.toFixed(0)} ms${moved}`,
  ];
}

/**
 * Where the energy is, on every clip, and the declared bound where there is one.
 *
 * Printed unconditionally: a footstep built half out of sub-bass is invisible in a byte count, a
 * duration and a peak, and it was invisible for exactly that reason.
 */
function spectrumLine(row: IAudioRow): readonly string[] {
  const profile =
    `  audio ${row.logicalPath} bands: sub ${row.bandSub.toFixed(1)}%, low ${row.bandLow.toFixed(1)}%, ` +
    `mid ${row.bandMid.toFixed(1)}%, high ${row.bandHigh.toFixed(1)}%, air ${row.bandAir.toFixed(1)}%`;
  if (row.spectrumBand === undefined) return [profile];
  const bounds = [
    row.spectrumMinPercent === undefined ? "" : `at least ${row.spectrumMinPercent}%`,
    row.spectrumMaxPercent === undefined ? "" : `at most ${row.spectrumMaxPercent}%`,
  ]
    .filter((part) => part.length > 0)
    .join(" and ");
  return [
    profile,
    `  audio ${row.logicalPath} declared '${row.spectrumBand}': ${(row.spectrumPercent ?? 0).toFixed(1)}%, needs ${bounds}`,
  ];
}

/** One compiled model plus a total, before against after the optimization pass. */
/** The cook's material merge (PRD-458 §5): what collapsed, and the counts either side of it. */
export interface IMaterialsRow {
  /** Distinct signatures — the count a draw call is bound by. */
  readonly distinct: { readonly after: number; readonly before: number };
  readonly materials: { readonly after: number; readonly before: number };
  readonly merged: readonly string[];
}

export interface IModelSizeRow {
  readonly after: number;
  readonly before: number;
  /** Embedded-image compression, when the model carried any. */
  readonly embeddedTextures?: IEmbeddedTextureRow;
  /** glTF extensions declared by the compiled output, e.g. EXT_meshopt_compression. */
  readonly extensions?: readonly string[];
  readonly logicalPath: string;
  readonly lightmap?: {
    readonly atlasHeight: number;
    readonly atlasWidth: number;
    readonly bakeMs: number;
    readonly bytesAfter: number;
    readonly bytesBefore: number;
    readonly dilatedTexels: number;
    readonly occludedTexels: number;
    readonly validTexels: number;
  };
  /** LOD simplification, when it was configured for this model. */
  readonly simplify?: ISimplifyRow;
  /** Automatic discrete LOD generation (PRD-377), when the effective policy ran. */
  readonly lod?: ILodRow;
  /** Lossless scene-graph compaction (PRD-443), when it ran. */
  readonly compact?: IModelCompactSummary;
  /** The cluster-DAG bake, when it was configured for this model. */
  readonly virtual?: IVirtualRow;
  /** The material merge the cook ran unconditionally, before any other geometry stage. */
  readonly materials?: IMaterialsRow;
  /** Triangle count of the compiled output, recorded in the manifest. */
  readonly triangles?: number;
}

/**
 * Names the ratio simplification reached next to the one requested. When the error tolerance
 * held it short, the line says so — asking for 5% and silently shipping 15% is exactly the
 * quiet the pipeline exists to remove.
 */
function simplifyLine(row: IModelSizeRow): readonly string[] {
  const simplify = row.simplify;
  if (simplify === undefined) return [];
  const kept = simplify.achievedRatio * 100;
  const requested = simplify.requestedRatio * 100;
  // 1% of the requested ratio is encoder rounding; anything wider is the error bound biting.
  const short =
    simplify.achievedRatio > simplify.requestedRatio * 1.01
      ? ` — the error tolerance ${simplify.error} stopped it short`
      : "";
  return [
    `simplified ${row.logicalPath}: ${simplify.trianglesBefore} -> ${simplify.trianglesAfter} triangles (${kept.toFixed(1)}% kept, requested ${requested.toFixed(1)}%)${short}`,
  ];
}

/**
 * Names what the DAG cost and where it stopped.
 *
 * A `cap` stop is called out because it means a DAG ran out of levels rather than finishing, and a
 * bake that clustered nothing says so rather than leaving the reader to infer it from a zero. A
 * declined primitive is named too: "no primitive was dense enough" is the wrong reason for a body
 * whose foliage is dense enough and whose DAG reduced nothing.
 */
function virtualLine(row: IModelSizeRow): readonly string[] {
  const virtual = row.virtual;
  if (virtual === undefined) return [];
  const declined = virtual.declined > 0 ? `, ${virtual.declined} declined to the LOD ladder` : "";
  if (virtual.primitives === 0)
    return [
      `virtual ${row.logicalPath}: no primitive was dense enough to cluster (${virtual.skipped} skipped${declined})`,
    ];
  const warning =
    virtual.stopReason === "cap" ? " — a DAG hit the level cap and is unfinished" : "";
  return [
    `virtual ${row.logicalPath}: ${virtual.clusters} cluster(s) over ${virtual.levels} level(s) on ${virtual.primitives} primitive(s), ${virtual.skipped} skipped${declined}, ${virtual.payloadBytes} payload bytes, bake ${virtual.bakeSeconds.toFixed(1)} s, stopped at ${virtual.stopReason}${warning}`,
  ];
}
function compactLine(row: IModelSizeRow): readonly string[] {
  const compact = row.compact;
  if (compact === undefined) return [];
  const parts: string[] = [];
  if (compact.flatten.enabled) {
    parts.push(`flatten moved ${compact.flatten.reparented} node(s)`);
  }
  if (compact.instance.enabled) {
    parts.push(
      compact.instance.batches > 0
        ? `instance ${compact.instance.batches} batch(es) / ${compact.instance.instances} instance(s)`
        : `instance none (${compact.instance.reason ?? "no shared mesh"})`,
    );
  }
  if (compact.join.enabled) {
    parts.push(
      `join ${compact.join.primitivesBefore} -> ${compact.join.primitivesAfter} primitive(s)`,
    );
  }
  const protectedNote =
    compact.protected.length === 0
      ? ""
      : `; protected ${compact.protected.map((node) => `${node.name} (${node.rule})`).join(", ")}`;
  const removedNote =
    (compact.removed?.length ?? 0) === 0
      ? ""
      : `; removed named node(s) ${compact.removed.join(", ")} — a getObjectByName on any of these now returns undefined`;
  return [`compact ${row.logicalPath}: ${parts.join(", ")}${protectedNote}${removedNote}`];
}

function extensionLabel(row: IModelSizeRow): string {
  const extensions = row.extensions ?? [];
  return extensions.length === 0 ? "" : ` (${extensions.join(", ")})`;
}

/**
 * Names what automatic generation did: the primitives that got a chain, the primitives that were
 * skipped and why, the far-route triangle outcome, and the payload bytes it cost. A model where
 * every primitive was skipped says so rather than leaving the reader to infer it from a zero.
 */
function lodLine(row: IModelSizeRow): readonly string[] {
  const lod = row.lod;
  if (lod === undefined) return [];
  const reasons = [...new Set(lod.reasons)].sort().join(", ");
  const outcome =
    lod.generated === 0
      ? `no primitive was eligible (${lod.skipped} skipped${reasons === "" ? "" : `: ${reasons}`})`
      : `${lod.generated} primitive(s) to ${lod.levels} level(s), ${lod.trianglesBefore} -> ${lod.trianglesAfter} triangles, ${lod.byteOverhead} payload bytes, ${lod.skipped} skipped${reasons === "" ? "" : ` (${reasons})`}`;
  // A join is never inferred from a triangle count: it either states the draws it produced or says
  // it was asked for and produced none, so a caller can never mistake a no-op for a collapse.
  const join =
    lod.joined === undefined
      ? lod.join
        ? "; join was requested but no material group collapsed"
        : ""
      : `; join collapsed ${lod.joined.primitives} primitive(s) into ${lod.joined.draws} draw(s) across ${lod.joined.groups.length} material group(s)` +
        ` (${lod.joined.trianglesBefore} -> ${lod.joined.triangles} triangles)`;
  return [`lod ${row.logicalPath}: ${outcome}${join}; fingerprint ${lod.fingerprint}`];
}

export function formatModelSizes(rows: readonly IModelSizeRow[]): readonly string[] {
  if (rows.length === 0) return [];
  const lines = rows.flatMap((row) => {
    const geometry = row.triangles === undefined ? "" : `, ${String(row.triangles)} triangle(s)`;
    const model = `model ${row.logicalPath}${extensionLabel(row)}: ${row.before} -> ${row.after} bytes ${deltaLabel(row.before, row.after)}${geometry}`;
    const embedded = row.embeddedTextures;
    // GPU bytes are the number that decides whether a phone keeps the app alive; the file
    // size only decides how long the download takes.
    const images =
      embedded === undefined
        ? []
        : [
            `embedded textures ${row.logicalPath}: ${embedded.count} image(s), ${embedded.bytesBefore} -> ${embedded.bytesAfter} bytes ${deltaLabel(embedded.bytesBefore, embedded.bytesAfter)}, GPU ${embedded.gpuBytesBefore} -> ${embedded.gpuBytesAfter} bytes ${deltaLabel(embedded.gpuBytesBefore, embedded.gpuBytesAfter)}, ${embedded.resized} resized`,
            ...Object.entries(embedded.skippedCompression ?? {}).map(
              ([name, reason]) =>
                `embedded texture ${row.logicalPath}#${name}: compression skipped: ${reason}`,
            ),
            ...Object.entries(embedded.quality ?? {}).map(([name, score]) =>
              qualityLine(`${row.logicalPath}#${name}`, score),
            ),
          ];
    const reduced = [
      ...compactLine(row),
      ...simplifyLine(row),
      ...virtualLine(row),
      ...lodLine(row),
    ];
    if (row.lightmap === undefined) return [model, ...reduced, ...images];
    const map = row.lightmap;
    return [
      model,
      ...reduced,
      ...images,
      `lightmap ${row.logicalPath}: atlas ${map.atlasWidth}x${map.atlasHeight}, ${map.validTexels} valid + ${map.dilatedTexels} dilated texels, ${map.occludedTexels} occluded, ${map.bytesBefore} -> ${map.bytesAfter} bytes ${deltaLabel(map.bytesBefore, map.bytesAfter)}, bake ${map.bakeMs.toFixed(1)} ms`,
    ];
  });
  const before = rows.reduce((total, row) => total + row.before, 0);
  const after = rows.reduce((total, row) => total + row.after, 0);
  lines.push(`models total: ${before} -> ${after} bytes ${deltaLabel(before, after)}`);
  return lines;
}

function qualityLine(name: string, score: ITextureQuality): string {
  const coverage = score.alpha.coverage
    .map((c) => `cutoff ${c.threshold}: ${c.source} -> ${c.decoded}, ${c.changedPixels} changed`)
    .join("; ");
  return `texture quality ${name} (${score.codec}, mip 0${score.rung === undefined ? "" : `; rung ${score.rung}`}): SSIM ${score.ssim.toFixed(4)}; mean ΔE00 ${score.meanDeltaE00 === null ? "n/a (data)" : score.meanDeltaE00.toFixed(3)}; alpha SSIM ${score.alpha.ssim.toFixed(4)}, MAE ${score.alpha.meanAbsoluteError.toFixed(6)}${coverage === "" ? "" : `; ${coverage}`}; ${score.status}; floor SSIM >= ${score.floor.ssim}, ΔE00 <= ${score.floor.meanDeltaE00}; source ${score.sourceWidth}x${score.sourceHeight} -> comparison ${score.width}x${score.height}; slots ${score.slots.join("+") || "unknown"}`;
}

/** Counts observations, including repeated shared-image consumers, without hiding data slots. */
export function formatTextureQualityTotals(scores: readonly ITextureQuality[]): string {
  const count = (status: ITextureQuality["status"]): number =>
    scores.filter((score) => score.status === status).length;
  const colour = scores.filter((score) => score.meanDeltaE00 !== null);
  const minimumSsim = colour.reduce((minimum, score) => Math.min(minimum, score.ssim), 1);
  const maximumDeltaE = colour.reduce(
    (maximum, score) => Math.max(maximum, score.meanDeltaE00 ?? 0),
    0,
  );
  const worst =
    colour.length === 0
      ? "colour n/a"
      : `colour min SSIM ${minimumSsim.toFixed(4)}, max mean ΔE00 ${maximumDeltaE.toFixed(3)}`;
  return `texture quality total: ${scores.length} measured; ${count("pass")} pass; ${count("below-floor")} below-floor; ${count("unvalidated-slots")} unvalidated-slots; ${worst}; ${IMAGE_QUALITY_VERSION}; floor enforced`;
}

/** Counts every image decision, including retained sources, on cold and warm builds. */
export function formatTextureRungs(codecs: readonly string[]): string {
  const count = (codec: string): number => codecs.filter((value) => value === codec).length;
  return `${count("etc1s")} etc1s · ${count("uastc")} escalated to uastc · ${count("none")} uncompressed`;
}

function deltaLabel(before: number, after: number): string {
  if (before <= 0) return `(${after} bytes)`;
  // A pass may legitimately grow a file — a KTX2 container with a mip chain is larger than a
  // 150-byte PNG — and the old `(-${percent}%)` rendered that as `(--261.3%)`. Now that the
  // compile step runs by default on every scaffolded project, growth rows are ordinary output.
  const shrinkage = (1 - after / before) * 100;
  return `(${shrinkage < 0 ? "+" : "-"}${Math.abs(shrinkage).toFixed(1)}%)`;
}

/** What an uncompressed pass cost this build, per kind, and which decision caused it. */
export interface ISkippedCompressionRow {
  readonly bytes: number;
  readonly files: number;
  readonly kind: "model" | "texture";
  /** Decoder-backed sub-passes that this row actually omitted. */
  readonly decoders?: readonly ("meshopt" | "KTX2")[];
  /** `"config"` — the game set `"none"`. `"platform"` — this target cannot decode compression. */
  readonly reason: "config" | "platform";
}

/** A caller-supplied pass omitted because this target cannot provide its runtime decoder. */
export interface ISkippedPassRow {
  readonly kind: "pass";
  readonly pass: string;
  readonly reason: "platform";
}

export type ISkippedReportRow = ISkippedCompressionRow | ISkippedPassRow;

/**
 * Reports what an opted-out pass is shipping uncompressed.
 *
 * `/AGENTS.md`: *turning a convention off must not turn its measurement off*. `assets.textures:
 * "none"` is a named override and a legitimate one — the starter template's proof asset is 150
 * bytes and KTX2 would grow it. But that value is copied into every scaffolded game and never
 * revisited: one shipped 2,003 MB of manifest output holding 53 PNG, 35 JPG and zero `.ktx2`, and
 * the build never said a word about it. This is the word. It is informational, never fatal, and
 * costs one sum over sizes the manifest already recorded. Caller-supplied decoder-dependent
 * passes use a separate `kind: "pass"` row so this report never calls arbitrary work compression.
 */
export function formatSkippedCompression(rows: readonly ISkippedReportRow[]): readonly string[] {
  return rows
    .filter(
      (row) =>
        (row.kind === "pass" || row.files > 0) &&
        (row.kind !== "model" ||
          row.reason !== "platform" ||
          row.decoders === undefined ||
          row.decoders.length > 0),
    )
    .map((row) => {
      if (row.kind === "pass") {
        return `TN_ASSETS_PASS_SKIPPED ${row.pass}: omitted because the pass declares needsRuntimeDecoder=true and this target has no runtime decoder (reason: platform).`;
      }
      const decoders = (
        row.decoders ?? (row.kind === "model" ? ["meshopt", "KTX2"] : ["KTX2"])
      ).join(" and ");
      const action =
        row.kind === "model" && row.reason === "platform"
          ? "retained without decoder-backed compression while decoder-free model passes still ran"
          : "shipped as authored";
      const reason =
        row.reason === "config"
          ? `assets.${row.kind}s is "none"`
          : `this target has no qualified ${decoders} decoder`;
      return `TN_ASSETS_COMPRESSION_SKIPPED ${row.kind}: ${String(row.files)} file(s), ${(row.bytes / 1e6).toFixed(1)} MB ${action} because ${reason}.`;
    });
}
