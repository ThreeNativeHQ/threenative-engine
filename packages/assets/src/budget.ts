import { open, stat } from "node:fs/promises";
import path from "node:path";
import type { TextureSkipReason } from "./passes/texture.js";

export interface IAssetBudget {
  readonly uncooked: number | "none";
  readonly total: number | "none";
}

/** Runtime decoder capabilities that decide which emitted bytes can be compressed on-device. */
export interface IAssetRuntimeDecoderCapabilities {
  readonly ktx2: boolean;
  readonly meshopt: boolean;
}

export interface IBudgetRow {
  readonly logicalPath: string;
  readonly total: number;
  readonly uncooked: number;
}

export interface IBudgetReport {
  readonly budget: IAssetBudget;
  readonly rows: readonly IBudgetRow[];
  readonly total: number;
  readonly uncooked: number;
}

export function parseBudget(value: unknown): IAssetBudget {
  if (value === "none") return { total: "none", uncooked: "none" };
  const raw = typeof value === "number" ? { uncooked: value } : value === undefined ? {} : value;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      "TN_ASSETS_CONFIG_INVALID: assets.budget must be an object, positive integer, or 'none'.",
    );
  }
  for (const [key, ceiling] of Object.entries(raw)) {
    if (key !== "uncooked" && key !== "total") {
      throw new Error(`TN_ASSETS_CONFIG_UNKNOWN_KEY: assets.budget.${key} is not recognised.`);
    }
    if (
      ceiling !== "none" &&
      !(typeof ceiling === "number" && Number.isSafeInteger(ceiling) && ceiling > 0)
    ) {
      throw new Error(
        `TN_ASSETS_CONFIG_INVALID: assets.budget.${key} must be a positive integer or 'none'.`,
      );
    }
  }
  const parsed = raw as Partial<IAssetBudget>;
  return { uncooked: parsed.uncooked ?? 64_000_000, total: parsed.total ?? "none" };
}

interface IOutput {
  readonly bytes: number;
  readonly output: string;
  readonly kind?: string;
  readonly compressionSkipped?: TextureSkipReason;
  readonly embeddedTextures?: {
    readonly skippedCompression?: Readonly<Record<string, TextureSkipReason>>;
  };
}

interface ICompilerOutput {
  readonly path: string;
  readonly source: string | null;
}

interface IGltf {
  readonly bufferViews?: readonly {
    readonly byteLength: number;
    readonly extensions?: Readonly<Record<string, unknown>>;
  }[];
  readonly images?: readonly {
    readonly bufferView?: number;
    readonly mimeType?: string;
    readonly name?: string;
    readonly uri?: string;
  }[];
  readonly meshes?: readonly {
    readonly primitives: readonly {
      readonly extensions?: {
        readonly KHR_draco_mesh_compression?: { readonly bufferView: number };
      };
    }[];
  }[];
}

/** Path of an image stored outside the GLB -> may its bytes be left out of `uncooked`. */
type ImageExemptions = Map<string, boolean>;

/**
 * The keys the model pass filed its skip reasons under, which are not the images' names: an
 * unnamed texture is `texture#<index>` and every repeat of a name is `<name>#<index>`. Deriving
 * them from the index is exact rather than hopeful — glTF-Transform writes one image per texture
 * in `listTextures()` order and reads them back the same way, so an image's index *is* its
 * texture's, and `assertNoTextureDrift` fails the build if that ever stops holding.
 */
function skipKeys(images: NonNullable<IGltf["images"]>): readonly string[] {
  const repeats = new Map<string, number>();
  return images.map((image, index) => {
    const base =
      image.name === undefined || image.name === "" ? `texture#${String(index)}` : image.name;
    const seen = repeats.get(base) ?? 0;
    repeats.set(base, seen + 1);
    return seen === 0 ? base : `${base}#${String(index)}`;
  });
}

/**
 * Folds one image's verdict into a payload several images can share. Any image that must be
 * charged vetoes the whole payload, so an exemption never carries another image's bytes with it:
 * a `block-size` image still counts where a writer collapsed it onto a `not-smaller` image's
 * bufferView or shared file.
 */
function voteExempt<TKey>(verdicts: Map<TKey, boolean>, payload: TKey, exempt: boolean): void {
  verdicts.set(payload, exempt && (verdicts.get(payload) ?? true));
}

/**
 * BufferViews this model's images hold that no compression pass can improve on: images already
 * in KTX2, and images retained at their authored bytes for the one reason no author can act on.
 * Images stored outside the GLB are recorded in `exemptImages` under the same rule.
 */
function exemptImageViews(
  images: NonNullable<IGltf["images"]>,
  filename: string,
  skipped: Readonly<Record<string, TextureSkipReason>>,
  exemptImages: ImageExemptions,
  runtimeDecoders: IAssetRuntimeDecoderCapabilities,
): ReadonlySet<number> {
  const keys = skipKeys(images);
  const settled = new Set<number>();
  const views = new Map<number, boolean>();
  const directory = path.dirname(filename);
  for (const [index, image] of images.entries()) {
    // `not-smaller` only, and deliberately: encoding this image could not have saved a byte, so
    // charging it would fail a gate nobody can pass. `block-size` is charged, because a resize
    // to a multiple of four is a fix the project can actually make.
    const key = keys[index];
    const exempt = !runtimeDecoders.ktx2 || (key !== undefined && skipped[key] === "not-smaller");
    const view = image.bufferView;
    if (view !== undefined && image.mimeType === "image/ktx2") settled.add(view);
    else if (view !== undefined) voteExempt(views, view, exempt);
    if (image.uri !== undefined)
      voteExempt(exemptImages, path.resolve(directory, image.uri), exempt);
  }
  for (const [view, exempt] of views) {
    if (exempt) settled.add(view);
  }
  return settled;
}

/** Read only the GLB header and JSON, never duplicate a pack's hundreds of MB of image data. */
async function uncookedModel(
  filename: string,
  bytes: number,
  skipped: Readonly<Record<string, TextureSkipReason>> = {},
  exemptImages: ImageExemptions = new Map(),
  runtimeDecoders: IAssetRuntimeDecoderCapabilities = { ktx2: true, meshopt: true },
): Promise<number> {
  const file = await open(filename, "r");
  try {
    const header = Buffer.alloc(20);
    await file.read(header, 0, header.length, 0);
    if (header.readUInt32LE(0) !== 0x46546c67 || header.readUInt32LE(16) !== 0x4e4f534a)
      return runtimeDecoders.ktx2 || runtimeDecoders.meshopt ? bytes : 0;
    const jsonLength = header.readUInt32LE(12);
    if (jsonLength > bytes - 20)
      throw new Error(`TN_ASSETS_OUTPUT_INVALID: truncated GLB ${filename}`);
    const json = Buffer.alloc(jsonLength);
    const read = await file.read(json, 0, jsonLength, 20);
    if (read.bytesRead !== jsonLength)
      throw new Error(`TN_ASSETS_OUTPUT_INVALID: truncated GLB ${filename}`);
    const gltf = JSON.parse(json.toString("utf8")) as IGltf;
    const imageViews = new Set(
      (gltf.images ?? [])
        .map((image) => image.bufferView)
        .filter((view): view is number => view !== undefined),
    );
    const compressed = new Set(
      exemptImageViews(gltf.images ?? [], filename, skipped, exemptImages, runtimeDecoders),
    );
    for (const mesh of gltf.meshes ?? []) {
      for (const primitive of mesh.primitives) {
        const draco = primitive.extensions?.KHR_draco_mesh_compression;
        if (draco !== undefined) compressed.add(draco.bufferView);
      }
    }
    let raw = 0;
    for (const [index, view] of (gltf.bufferViews ?? []).entries()) {
      if (
        compressed.has(index) ||
        view.extensions?.EXT_meshopt_compression !== undefined ||
        (!runtimeDecoders.meshopt && !imageViews.has(index)) ||
        (!runtimeDecoders.ktx2 && imageViews.has(index))
      )
        continue;
      if (!Number.isSafeInteger(view.byteLength) || view.byteLength < 0)
        throw new Error(`TN_ASSETS_OUTPUT_INVALID: invalid bufferView in ${filename}`);
      raw += view.byteLength;
    }
    // GLB framing/JSON is not geometry or texture data a compression pass can encode.
    return Math.min(bytes, raw);
  } finally {
    await file.close();
  }
}

/** Emitted payloads are authoritative, including on cache hits and when a custom pass ran. */
export async function measureBudget(
  entries: Readonly<Record<string, IOutput>>,
  outputRoot: string,
  runtimeDecoderCapabilities: IAssetRuntimeDecoderCapabilities | boolean,
  budget: IAssetBudget,
  compilerOutputs: readonly ICompilerOutput[] = [],
): Promise<IBudgetReport> {
  // The boolean form remains accepted for callers compiled against PRD-349; new callers pass the
  // two independent capabilities so mobile can exempt authored PNGs and model geometry separately.
  const runtimeDecoders: IAssetRuntimeDecoderCapabilities =
    typeof runtimeDecoderCapabilities === "boolean"
      ? { ktx2: runtimeDecoderCapabilities, meshopt: runtimeDecoderCapabilities }
      : runtimeDecoderCapabilities;
  const seen = new Set<string>();
  const exemptImages: ImageExemptions = new Map();
  const modelBytes = new Map<string, number>();
  for (const entry of Object.values(entries)) {
    if (path.extname(entry.output).toLowerCase() !== ".glb" || modelBytes.has(entry.output))
      continue;
    modelBytes.set(
      entry.output,
      await uncookedModel(
        path.join(outputRoot, entry.output),
        (await stat(path.join(outputRoot, entry.output))).size,
        entry.embeddedTextures?.skippedCompression,
        exemptImages,
        runtimeDecoders,
      ),
    );
  }
  const rows: IBudgetRow[] = [];
  for (const [logicalPath, entry] of Object.entries(entries).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const outputs: IOutput[] = [entry];
    for (const field of Object.values(entry)) {
      if (!Array.isArray(field)) continue;
      for (const auxiliary of field) {
        if (
          typeof auxiliary === "object" &&
          auxiliary !== null &&
          typeof auxiliary.output === "string" &&
          typeof auxiliary.bytes === "number"
        )
          outputs.push(auxiliary as IOutput);
      }
    }
    let total = 0;
    let uncooked = 0;
    for (const output of outputs) {
      if (seen.has(output.output)) continue;
      seen.add(output.output);
      const shippedBytes = (await stat(path.join(outputRoot, output.output))).size;
      total += shippedBytes;
      // Same split as the embedded images above: only the reason no author can act on is exempt.
      if (
        output.compressionSkipped === "not-smaller" ||
        exemptImages.get(path.resolve(outputRoot, output.output)) === true
      )
        continue;
      const extension = path.extname(output.output).toLowerCase();
      if (extension === ".glb")
        uncooked +=
          modelBytes.get(output.output) ??
          (await uncookedModel(
            path.join(outputRoot, output.output),
            shippedBytes,
            {},
            exemptImages,
            runtimeDecoders,
          ));
      else if (
        (runtimeDecoders.ktx2 && [".png", ".jpg", ".jpeg", ".webp"].includes(extension)) ||
        (runtimeDecoders.meshopt && output.kind === "model" && extension !== ".ktx2")
      )
        uncooked += shippedBytes;
    }
    rows.push({ logicalPath, total, uncooked });
  }
  // Receipts also own payloads that no manifest entry references, currently the Basis JS/WASM
  // runtime. They ship in `public/`, so a total ceiling must count them. Entry and auxiliary paths
  // are already in `seen`; this loop therefore charges every physical file exactly once and never
  // treats compiler machinery as uncooked game content.
  for (const output of [...compilerOutputs].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    if (seen.has(output.path)) continue;
    seen.add(output.path);
    rows.push({
      logicalPath: output.source ?? output.path,
      total: (await stat(path.join(outputRoot, output.path))).size,
      uncooked: 0,
    });
  }
  return {
    budget,
    rows,
    total: rows.reduce((sum, row) => sum + row.total, 0),
    uncooked: rows.reduce((sum, row) => sum + row.uncooked, 0),
  };
}

export function assertBudget(report: IBudgetReport): void {
  const failures = (["uncooked", "total"] as const).filter(
    (key) => report.budget[key] !== "none" && report[key] > (report.budget[key] as number),
  );
  if (failures.length === 0) return;
  const measure = failures.includes("uncooked") ? "uncooked" : "total";
  const largest = [...report.rows]
    .filter((row) => row[measure] > 0)
    .sort((a, b) => b[measure] - a[measure] || a.logicalPath.localeCompare(b.logicalPath))
    .slice(0, 5);
  throw new Error(
    `TN_ASSETS_BUDGET_EXCEEDED: ${failures.map((key) => `${key} ${report[key]} bytes exceeds ${report.budget[key]}`).join("; ")}; largest ${measure}: ${largest.map((row) => `${row.logicalPath} ${row[measure]} bytes`).join(", ")}. Use assets.exclude or assets.budget; enable skipped model/texture compression passes and check codec:none overrides.`,
  );
}
