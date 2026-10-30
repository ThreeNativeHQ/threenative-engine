import { type Document, ImageUtils } from "@gltf-transform/core";
import { type AssetKind, type IAssetTargets, classify } from "./compile.js";
import { createGltfReader, readGltfDocument } from "./gltf-io.js";
import { parsePng } from "./png.js";

export type AssetFindingGrade = "fail" | "ok" | "warn";

export interface IAssetFinding {
  readonly asset: string;
  readonly grade: AssetFindingGrade;
  readonly id: string;
  readonly message: string;
  readonly subject?: string;
  readonly target?: number;
  readonly value: boolean | number | string;
}

export interface ITextureStats {
  readonly alpha: boolean;
  readonly height: number;
  readonly powerOfTwo: boolean;
  readonly width: number;
}

export interface IModelStats {
  readonly animationClips: number;
  readonly colliderPresent: boolean;
  readonly materials: number;
  readonly rootMotion: boolean;
  readonly textures: readonly ITextureStats[];
  readonly triangles: number;
}

export interface IAssetHealthEntry {
  readonly asset: string;
  readonly kind: AssetKind;
  readonly license: string;
  readonly model?: IModelStats;
  readonly texture?: ITextureStats;
}

export interface IAssetHealthReport {
  readonly entries: readonly IAssetHealthEntry[];
  readonly failed: boolean;
  readonly findings: readonly IAssetFinding[];
  readonly summary: Readonly<Record<AssetFindingGrade, number>>;
}

export interface IAssetHealthInput {
  readonly data: Buffer;
  readonly logicalPath: string;
  /** Compiler-owned model output, when an imported source's GLB references shared images. */
  readonly modelPath?: string;
}

interface IParsedModel {
  readonly license: string;
  readonly model: IModelStats;
}

const UNKNOWN_LICENSE = "unknown";
const MODE_TRIANGLES = 4;
const MODE_TRIANGLE_STRIPS = 5;
const MODE_TRIANGLE_FANS = 6;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

function carriedLicense(asset: { readonly copyright?: string }): string {
  const copyright = asset.copyright?.trim();
  return copyright !== undefined && copyright.length > 0 ? copyright : UNKNOWN_LICENSE;
}

/** Godot import convention (`-col`, `-colonly`, `-convcolonly`) plus any explicit "collider". */
function marksCollider(name: string): boolean {
  return /collider/iu.test(name) || /(?:^|[-_. ])col(?:only|convcolonly|convcol)?$/iu.test(name);
}

/**
 * The container a JPEG or PNG carries, from its own signature and header.
 * @situation label a texture whose bytes arrive without a declared MIME
 * @constraint bytes that are neither a readable JPEG nor a checksum-clean PNG return undefined
 * @example const mime = sniffImageMime(bytes) ?? "image/jpeg";
 */
export function sniffImageMime(bytes: Buffer): "image/jpeg" | "image/png" | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return parsePng(bytes) === undefined ? undefined : "image/png";
}

/** Shared with the KTX2 texture pass, which picks its codec from the alpha channel it reports. */
export function textureStats(bytes: Buffer, mimeType?: string): ITextureStats {
  const mime = mimeType ?? sniffImageMime(bytes);
  let width = 0;
  let height = 0;
  let alpha = false;
  if (mime !== undefined) {
    if (mime === "image/png") {
      const png = parsePng(bytes);
      if (png !== undefined) {
        ({ height, width } = png);
        alpha = png.hasAlpha;
      }
    } else {
      try {
        const size = ImageUtils.getSize(bytes, mime);
        if (size !== null) [width, height] = size;
      } catch {
        // Unreadable image headers stay at zero and are reported as-is; hard failures
        // belong to the decode passes of later PRDs.
      }
    }
  }
  return {
    alpha,
    height,
    powerOfTwo: isPowerOfTwo(width) && isPowerOfTwo(height),
    width,
  };
}

async function parseModel(
  data: Buffer,
  logicalPath: string,
  modelPath?: string,
): Promise<Document> {
  // The same codec-aware reader as the model pass. The health report only measures and must
  // never decide whether a build runs: a bare reader refused ordinary EXT_texture_webp exports
  // for an unregistered required extension, then Meshopt-compressed sources for a missing
  // decoder, and both killed `models: "none"` builds from a report that is meant to be advisory.
  try {
    const io = await createGltfReader(data);
    return modelPath === undefined ? await readGltfDocument(io, data) : await io.read(modelPath);
  } catch (error) {
    throw new Error(
      `TN_ASSETS_MODEL_UNREADABLE: could not parse '${logicalPath}' for the health report: ${messageOf(error)}. External buffer or image URIs are not measured; use a self-contained .glb.`,
    );
  }
}

function primitiveTriangles(
  mode: number,
  indices: number | undefined,
  vertices: number | undefined,
): number {
  const drawn = indices ?? vertices ?? 0;
  if (mode === MODE_TRIANGLES) return Math.floor(drawn / 3);
  if (mode === MODE_TRIANGLE_STRIPS || mode === MODE_TRIANGLE_FANS) return Math.max(0, drawn - 2);
  return 0;
}

async function parseModelStats(
  data: Buffer,
  logicalPath: string,
  modelPath?: string,
): Promise<IParsedModel> {
  const root = (await parseModel(data, logicalPath, modelPath)).getRoot();
  let triangles = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      triangles += primitiveTriangles(
        prim.getMode(),
        prim.getIndices()?.getCount(),
        prim.getAttribute("POSITION")?.getCount(),
      );
    }
  }
  const colliderPresent =
    [...root.listNodes(), ...root.listMeshes()].some((property) =>
      marksCollider(property.getName() ?? ""),
    ) || root.listScenes().some((scene) => marksCollider(scene.getName() ?? ""));
  const rootNodes = new Set(root.listScenes().flatMap((scene) => scene.listChildren()));
  let rootMotion = false;
  for (const animation of root.listAnimations()) {
    for (const channel of animation.listChannels()) {
      const targetNode = channel.getTargetNode();
      if (channel.getTargetPath() === "translation" && targetNode && rootNodes.has(targetNode)) {
        rootMotion = true;
      }
    }
  }
  const textures = root.listTextures().map((texture) => {
    const image = texture.getImage();
    const bytes = image
      ? Buffer.from(image.buffer, image.byteOffset, image.byteLength)
      : Buffer.alloc(0);
    return textureStats(bytes, texture.getMimeType());
  });
  return {
    license: carriedLicense(root.getAsset()),
    model: {
      animationClips: root.listAnimations().length,
      colliderPresent,
      materials: root.listMaterials().length,
      rootMotion,
      textures,
      triangles,
    },
  };
}

interface IDraft {
  entries: IAssetHealthEntry[];
  findings: IAssetFinding[];
}

function budgeted(
  draft: IDraft,
  id: string,
  asset: string,
  value: number,
  noun: string,
  target: number | undefined,
): void {
  const exceeded = target !== undefined && value > target;
  draft.findings.push({
    asset,
    grade: exceeded ? "fail" : "ok",
    id,
    ...(target === undefined ? {} : { target }),
    message: `${value} ${noun}${exceeded ? `, above the declared target of ${target}` : ""}`,
    value,
  });
}

function textureFindings(
  draft: IDraft,
  asset: string,
  subject: string,
  texture: ITextureStats,
  targets: IAssetTargets,
): void {
  const readable = texture.width > 0 && texture.height > 0;
  const dimensionText = readable ? `${texture.width}x${texture.height}` : "unknown";
  const exceeded =
    targets.maxTextureDimension !== undefined &&
    readable &&
    Math.max(texture.width, texture.height) > targets.maxTextureDimension;
  draft.findings.push({
    asset,
    grade: exceeded ? "fail" : "ok",
    id: "texture.dimensions",
    ...(targets.maxTextureDimension === undefined ? {} : { target: targets.maxTextureDimension }),
    message: readable
      ? `${dimensionText} pixels${exceeded ? `, above the declared target of ${targets.maxTextureDimension}` : ""}`
      : "dimensions unknown",
    subject,
    value: dimensionText,
  });
  if (!readable) return;
  draft.findings.push({
    asset,
    grade: texture.powerOfTwo ? "ok" : "warn",
    id: "texture.powerOfTwo",
    message: texture.powerOfTwo ? "power-of-two dimensions" : "dimensions are not power-of-two",
    subject,
    value: texture.powerOfTwo,
  });
  draft.findings.push({
    asset,
    grade: "ok",
    id: "texture.alpha",
    message: texture.alpha ? "alpha channel present" : "no alpha channel",
    subject,
    value: texture.alpha,
  });
}

async function measureAsset(
  draft: IDraft,
  input: IAssetHealthInput,
  targets: IAssetTargets,
): Promise<IAssetHealthEntry> {
  const kind = classify(input.logicalPath);
  if (kind === "model") {
    const { license, model } = await parseModelStats(
      input.data,
      input.logicalPath,
      input.modelPath,
    );
    budgeted(
      draft,
      "triangles",
      input.logicalPath,
      model.triangles,
      "triangles",
      targets.maxTriangles,
    );
    budgeted(
      draft,
      "materials",
      input.logicalPath,
      model.materials,
      "material(s)",
      targets.maxMaterials,
    );
    draft.findings.push({
      asset: input.logicalPath,
      grade: model.colliderPresent ? "ok" : "warn",
      id: "collider",
      message: model.colliderPresent
        ? "collider node present"
        : "no collider found (name a node or mesh '-col' or 'collider')",
      value: model.colliderPresent,
    });
    draft.findings.push({
      asset: input.logicalPath,
      grade: "ok",
      id: "rootMotion",
      message: model.rootMotion
        ? "root motion detected in an animation clip"
        : "no root motion detected",
      value: model.rootMotion,
    });
    model.textures.forEach((texture, index) => {
      textureFindings(draft, input.logicalPath, `tex${index}`, texture, targets);
    });
    return { asset: input.logicalPath, kind, license, model };
  }
  if (kind === "texture") {
    const texture = textureStats(input.data);
    textureFindings(draft, input.logicalPath, "tex0", texture, targets);
    return { asset: input.logicalPath, kind, license: UNKNOWN_LICENSE, texture };
  }
  return { asset: input.logicalPath, kind, license: UNKNOWN_LICENSE };
}

/**
 * Measures every compiled asset and grades findings against the declared targets.
 * A finding only reaches `fail` where a target was declared, so the report stays
 * informational until a project opts into enforcement.
 */
export async function runHealthReport(
  inputs: readonly IAssetHealthInput[],
  targets: IAssetTargets = {},
): Promise<IAssetHealthReport> {
  const draft: IDraft = { entries: [], findings: [] };
  for (const input of inputs) {
    const entry = await measureAsset(draft, input, targets);
    draft.entries.push(entry);
    draft.findings.push({
      asset: input.logicalPath,
      grade: entry.license === UNKNOWN_LICENSE ? "warn" : "ok",
      id: "license",
      message: `license: ${entry.license}`,
      value: entry.license,
    });
  }
  const summary: Record<AssetFindingGrade, number> = { fail: 0, ok: 0, warn: 0 };
  for (const finding of draft.findings) summary[finding.grade] += 1;
  return { ...draft, failed: summary.fail > 0, summary };
}

/** The person-readable form printed by the compile step, one line per finding plus a summary. */
export function formatHealthReport(report: IAssetHealthReport): readonly string[] {
  const lines = report.findings.map((finding) => {
    const where =
      finding.subject === undefined ? finding.asset : `${finding.asset} ${finding.subject}`;
    return `[${finding.grade}] ${where}: ${finding.message}`;
  });
  const { fail, ok, warn } = report.summary;
  lines.push(
    `asset health: ${report.entries.length} asset(s), ${ok} ok, ${warn} warn, ${fail} fail`,
  );
  return lines;
}
