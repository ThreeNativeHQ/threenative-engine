import type { IAssetManifestEntry, ICompileLayout } from "./compile-types.js";
import { readTextureQuality } from "./image-quality.js";
import type { IModelCompactSummary } from "./passes/compact.js";
import type { TextureSkipReason } from "./passes/texture.js";
import type {
  IAudioRow,
  IEmbeddedTextureRow,
  ILodJoinedGroupRow,
  ILodJoinedRow,
  ILodRow,
  IMaterialsRow,
  ISimplifyRow,
  ISkippedReportRow,
} from "./report.js";

export const MANIFEST_NAME = "assets.manifest.json";
/**
 * What this bake produced, written by the producer so nothing downstream has to guess.
 *
 * The delete-test — remove every baked file and the game still runs, just slower — is the rule
 * that separates a baking pass from a compiler of game meaning. A test driven by a directory glob
 * would either miss an output or delete a source asset, and both failures look like a pass, so the
 * step that wrote the files is the one that lists them. **Nothing in the shipped runtime reads
 * this file**; deleting it is part of the test.
 */
export const RECEIPT_NAME = "bake.receipt.json";
/** Files emitted after the last successful receipt, retained so a failed cook can be recovered. */
export const PENDING_RECEIPT_NAME = ".bake.pending-receipt.json";
export const DEFAULT_SOURCE = "assets";
export const DEFAULT_OUTPUT = "public";
/** Declared by a model whose embedded images were transcoded; the runtime needs the transcoder. */
export const BASISU_EXTENSION = "KHR_texture_basisu";
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
export const PIPELINE_VERSION = 10;

export const CODECS: readonly string[] = ["etc1s", "none", "uastc"];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrows a pass's embedded-texture summary to the manifest shape by reading every field it
 * declares. A cast would let a pass that changed its own summary write nonsense into the
 * manifest the runtime and the report both read; this drops anything that is not a number.
 */
export function simplifyRow(value: unknown): ISimplifyRow | undefined {
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

export function compactRow(value: unknown): IModelCompactSummary | undefined {
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

export function materialRow(value: unknown): IMaterialsRow | undefined {
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

export function lodRow(value: unknown): ILodRow | undefined {
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

export function embeddedTextureRow(value: unknown): IEmbeddedTextureRow | undefined {
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
    ...(typeof value.transcoderSavings === "number" && value.transcoderSavings > 0
      ? { transcoderSavings: value.transcoderSavings }
      : {}),
    ...(value.transcoderRequired === true ? { transcoderRequired: true as const } : {}),
  };
}

/**
 * Narrows the audio pass's summary to the manifest shape by reading every field it declares.
 *
 * Same reason as `simplifyRow` above: a cast would let a pass that changed its own summary write
 * nonsense into the manifest and the report both read from. Anything missing a required field is
 * dropped whole rather than half-recorded.
 */
export function audioRow(value: unknown): IAudioRow | undefined {
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

/**
 * Sums what each disabled built-in pass is shipping as authored.
 *
 * Reads the sizes already recorded on every manifest entry, so a build that opted out pays one
 * addition per asset and no I/O at all — the measurement must not become a reason to skip it.
 * A caller that replaced the pass registry wholesale (`options.passes`) has not opted out of
 * anything and reports nothing.
 */
export function skippedCompressionRows(
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
      // The decoders this target lacks, not every one the model pass would use: a target that
      // decodes meshopt but not KTX2 withheld only KTX2 (PRD-861).
      ...(kind === "model"
        ? {
            decoders: layout.modelCompressionDecoders.filter((decoder) =>
              decoder === "KTX2"
                ? !layout.runtimeDecoderCapabilities.ktx2
                : !layout.runtimeDecoderCapabilities.meshopt,
            ),
          }
        : {}),
      reason,
    });
  }
  return rows;
}
