import type { Document, Texture } from "@gltf-transform/core";
import { EXTTextureWebP, KHRTextureBasisu } from "@gltf-transform/extensions";
import { getTextureColorSpace, listTextureInfo, listTextureSlots } from "@gltf-transform/functions";
import { KHR_DF_MODEL_UASTC, read as readKTX2 } from "ktx-parse";
import { PNG } from "pngjs";
import { EXTTextureAstc, isRawAstc } from "../gltf-io.js";
import { textureStats } from "../health.js";
import {
  COLOUR_SLOTS,
  type IImageQualityFloor,
  type IImageQualityOptions,
  type ITextureQuality,
  decodeBasisKtx2,
  imageQuality,
  measureKtx2,
  transcodeKtx2ToAstc,
} from "../image-quality.js";
import { encodeToKTX2 } from "../ktx2-encoder.js";
import { decodeImageBytes } from "./decode-image.js";
import type { TextureCodec, TextureSkipReason } from "./texture.js";

/**
 * Compresses the images embedded *inside* a `.glb` — the half of a model the geometry passes
 * never touched. A prop carrying three 2048x2048 JPEGs is a small file and 67 MB of VRAM once
 * the driver decodes it; meshopt shrinks the other, cheaper half. This stage transcodes each
 * embedded image to KTX2/Basis and declares `KHR_texture_basisu`, so the GPU stores blocks
 * instead of RGBA, and caps the resolution so a 4K texture an image model produced cannot
 * silently eat a phone's whole budget.
 *
 * Slot constraints feed one measured ladder: normal/data slots retain UASTC/none, while
 * colour escalates from ETC1S through RDO and plain UASTC. Alpha coverage is checked separately;
 * a forced codec must still meet the floor. Colour space comes from the slot too — `getTextureColorSpace`
 * knows base colour and emissive are sRGB and that metallic-roughness and normals are data —
 * so a linear map is never encoded through a perceptual metric.
 *
 * The encoder is the same in-process Basis WASM the standalone texture pass uses, so no new
 * dependency and nothing extra to install. Everything fails closed: an image no decoder reads,
 * an image whose dimensions are not a whole number of 4x4 blocks, and a texture whose binding
 * did not survive the round trip all throw naming the model and the image.
 */

/**
 * What the runtime downloads once for any KTX2 output: three's `basis_transcoder.js` plus
 * `basis_transcoder.wasm`. Measured at 575,519 bytes on three 0.180; rounded up so a build
 * switches to decoder-free only when it is certain to save bytes.
 */
export const BASIS_TRANSCODER_BYTES = 600 * 1024;

export interface IModelTextureOverride {
  readonly codec: TextureCodec;
  /** glTF slot the override applies to, e.g. `normalTexture` or `baseColorTexture`. */
  readonly slot: string;
}

export type TextureMaxSize = number | Readonly<Record<string, number>>;

export interface IModelTexturesOptions {
  /** Internal target-selected raw ASTC output. */
  readonly astc?: boolean;
  readonly floor?: Partial<IImageQualityFloor>;
  /** Internal reporting switch; selection still measures and enforces the floor. */
  readonly measureQuality?: boolean;
  /**
   * Resolved by the compiler from the target's runtime capabilities, never by a project: the
   * target has no KTX2 decoder, so an over-cap embedded image is box-resampled and re-emitted as
   * a PNG instead of being encoded. Everything else — authored-byte retention under the cap,
   * per-image deduplication, colour space — is unchanged.
   */
  readonly decoderFree?: boolean;
  /**
   * Bytes the runtime pays once for the Basis transcoder (`basis_transcoder.js` plus
   * `basis_transcoder.wasm`) when any model publishes KTX2. An image is encoded only when its
   * KTX2 output saves at least this many bytes against the authored container, so one small
   * texture can never make every game download a transcoder larger than the saving. Defaults to
   * {@link BASIS_TRANSCODER_BYTES}; a preparer that already pays the cost passes 0.
   */
  readonly transcoderBytes?: number;
  /**
   * Internal switch for the authored-container JPEG rung (default on). A caller that needs the
   * KTX2 ladder alone, such as a test of rung selection, turns it off.
   */
  readonly jpeg?: boolean;
  /**
   * Longest edge an embedded image may keep, default 2048. Larger images are box-resampled
   * down preserving aspect ratio; smaller ones are never upscaled.
   */
  readonly maxSize?: TextureMaxSize;
  readonly overrides?: readonly IModelTextureOverride[];
  /** ETC1S encoder quality 1–255, default 150. Ignored for UASTC. */
  readonly quality?: number;
}

/** What the stage did, recorded in the manifest and printed by the size report. */
export interface IEmbeddedTextureSummary {
  readonly quality: Readonly<Record<string, ITextureQuality>>;
  readonly bytesAfter: number;
  readonly bytesBefore: number;
  readonly count: number;
  /** Chosen codec per embedded image, keyed by texture name. */
  readonly formats: Readonly<Record<string, string>>;
  readonly gpuBytesAfter: number;
  readonly gpuBytesBefore: number;
  /** How many images the resolution cap actually downsampled. */
  readonly resized: number;
  /** Images retained at their authored bytes, by name, with the reason each one was not cooked. */
  readonly skippedCompression: Readonly<Record<string, TextureSkipReason>>;
}

/** One embedded image as the verification compares it, source against re-read output. */
export interface IModelTextureBinding {
  readonly height: number;
  readonly key: string;
  /** KTX2 mip levels; 1 for a still-uncompressed source image. */
  readonly levels: number;
  readonly mimeType: string;
  readonly slots: readonly string[];
  readonly texCoords: readonly number[];
  readonly width: number;
}

export interface IModelTextureBindings {
  /** `material -> slot=textureIndex@uvN` for the five core glTF slots, in document order. */
  readonly materials: readonly string[];
  readonly textures: readonly IModelTextureBinding[];
}

type RootOf = ReturnType<Document["getRoot"]>;

const DEFAULT_MAX_SIZE = 2048;
const DEFAULT_ETC1S_QUALITY = 150;
/** BC1, BC7, ETC2 and ASTC 4x4 all address pixels in 4x4 blocks. */
const BLOCK_SIZE = 4;
/** A full mip pyramid is 4/3 of the base level. */
const MIP_FACTOR = 4 / 3;
/** Bytes per pixel of the format each codec transcodes to on a desktop GPU. */
const GPU_BYTES_PER_PIXEL: Readonly<Record<string, number>> = {
  // BC1 from ETC1S, BC7 from UASTC, RGBA8 for anything left uncompressed.
  astc4x4: 1,
  etc1s: 0.5,
  none: 4,
  uastc: 1,
};

/** Slots whose content is a tangent-space normal: data, and ETC1S destroys it. */
const NORMAL_SLOTS: ReadonlySet<string> = new Set(["clearcoatNormalTexture", "normalTexture"]);

/**
 * Containers every target of this build decodes on its own, so keeping the authored bytes costs a
 * reader nothing. `image/webp` is deliberately absent: it is only reachable through
 * `EXT_texture_webp`, which a target without a WebP decoder cannot satisfy — retaining one would
 * hand back a model the very requirement this stage removes.
 */
const UNIVERSAL_IMAGE_CONTAINERS: ReadonlySet<string> = new Set(["image/jpeg", "image/png"]);

/** The five slots every glTF material declares directly; extension slots are covered by
 * the per-texture `slots` snapshot, which walks whatever parents actually reference it. */
const CORE_SLOTS = [
  "baseColorTexture",
  "emissiveTexture",
  "metallicRoughnessTexture",
  "normalTexture",
  "occlusionTexture",
] as const;

/** Slot names supported by the installed glTF material extensions. */
export const TEXTURE_SIZE_SLOTS: ReadonlySet<string> = new Set([
  ...CORE_SLOTS,
  ...NORMAL_SLOTS,
  "diffuseTexture",
  "specularColorTexture",
  "sheenColorTexture",
  "anisotropyTexture",
  "clearcoatRoughnessTexture",
  "clearcoatTexture",
  "diffuseTransmissionColorTexture",
  "diffuseTransmissionTexture",
  "iridescenceTexture",
  "iridescenceThicknessTexture",
  "sheenRoughnessTexture",
  "specularGlossinessTexture",
  "specularTexture",
  "thicknessTexture",
  "transmissionTexture",
]);

type CoreSlot = (typeof CORE_SLOTS)[number];

type MaterialOf = ReturnType<RootOf["listMaterials"]>[number];

function coreSlotTexture(material: MaterialOf, slot: CoreSlot): Texture | null {
  switch (slot) {
    case "baseColorTexture":
      return material.getBaseColorTexture();
    case "emissiveTexture":
      return material.getEmissiveTexture();
    case "metallicRoughnessTexture":
      return material.getMetallicRoughnessTexture();
    case "normalTexture":
      return material.getNormalTexture();
    default:
      return material.getOcclusionTexture();
  }
}

function coreSlotTexCoord(material: MaterialOf, slot: CoreSlot): number | undefined {
  switch (slot) {
    case "baseColorTexture":
      return material.getBaseColorTextureInfo()?.getTexCoord();
    case "emissiveTexture":
      return material.getEmissiveTextureInfo()?.getTexCoord();
    case "metallicRoughnessTexture":
      return material.getMetallicRoughnessTextureInfo()?.getTexCoord();
    case "normalTexture":
      return material.getNormalTextureInfo()?.getTexCoord();
    default:
      return material.getOcclusionTextureInfo()?.getTexCoord();
  }
}

/** Stable per-texture key: the authored name, disambiguated by index when it is not unique. */
export function textureKeys(root: RootOf): readonly string[] {
  const textures = root.listTextures();
  const seen = new Map<string, number>();
  return textures.map((texture, index) => {
    const name = texture.getName();
    const base = name === "" ? `texture#${String(index)}` : name;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}#${String(index)}`;
  });
}

/** Dimensions and mip levels of an embedded image, whichever container it is in. */
function imageShape(
  bytes: Uint8Array,
  mimeType: string,
): { height: number; levels: number; width: number } {
  if (mimeType === "image/ktx2") {
    const container = readKTX2(bytes);
    return {
      height: container.pixelHeight,
      levels: container.levelCount,
      width: container.pixelWidth,
    };
  }
  const stats = textureStats(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return { height: stats.height, levels: 1, width: stats.width };
}

/**
 * Snapshot of every embedded image and the material slots that bind it. Taken before the
 * stage runs and again from the re-read output, so a texture the encoder or the writer
 * silently dropped, rebound or moved to another UV set fails the build.
 */
export function textureBindings(root: RootOf): IModelTextureBindings {
  const textures = root.listTextures();
  const keys = textureKeys(root);
  return {
    materials: root.listMaterials().flatMap((material, materialIndex) => {
      const name = material.getName();
      const label = name === "" ? `material#${String(materialIndex)}` : name;
      return CORE_SLOTS.flatMap((slot) => {
        const texture = coreSlotTexture(material, slot);
        if (texture === null) return [];
        const index = textures.indexOf(texture);
        const texCoord = coreSlotTexCoord(material, slot) ?? 0;
        return [`${label}.${slot}=${String(index)}@uv${String(texCoord)}`];
      });
    }),
    textures: textures.map((texture, index) => {
      const image = texture.getImage();
      const mimeType = texture.getMimeType();
      const shape =
        image === null ? { height: 0, levels: 0, width: 0 } : imageShape(image, mimeType);
      return {
        height: shape.height,
        key: keys[index] ?? `texture#${String(index)}`,
        levels: shape.levels,
        mimeType,
        slots: [...listTextureSlots(texture)].sort(),
        texCoords: [...new Set(listTextureInfo(texture).map((info) => info.getTexCoord()))].sort(
          (left, right) => left - right,
        ),
        width: shape.width,
      };
    }),
  };
}

function describeBinding(binding: IModelTextureBinding): string {
  return `${binding.key} (${binding.mimeType} ${String(binding.width)}x${String(binding.height)}, slots ${binding.slots.join("+") || "none"}, uv ${binding.texCoords.join("+") || "none"})`;
}

/**
 * Compares the re-read output against what went in and throws naming the difference. The
 * existing geometry self-verify proves no mesh was lost; this proves no *image* was, and
 * that every one is still bound to the same slot on the same material with the same UV set.
 */
export function assertNoTextureDrift(
  source: IModelTextureBindings,
  output: IModelTextureBindings,
  logicalPath: string,
): void {
  const failures: string[] = [];
  if (source.textures.length !== output.textures.length) {
    failures.push(
      `texture count ${String(source.textures.length)} -> ${String(output.textures.length)}`,
    );
  }
  const count = Math.min(source.textures.length, output.textures.length);
  for (let index = 0; index < count; index += 1) {
    const before = source.textures[index];
    const after = output.textures[index];
    if (before === undefined || after === undefined) continue;
    if (before.key !== after.key) {
      failures.push(`texture ${String(index)} renamed ${before.key} -> ${after.key}`);
      continue;
    }
    if (after.levels === 0) {
      failures.push(`${before.key} lost its image`);
      continue;
    }
    if (before.slots.join(",") !== after.slots.join(",")) {
      failures.push(`${describeBinding(before)} -> slots ${after.slots.join("+") || "none"}`);
    }
    if (before.texCoords.join(",") !== after.texCoords.join(",")) {
      failures.push(`${describeBinding(before)} -> uv ${after.texCoords.join("+") || "none"}`);
    }
  }
  const missing = source.materials.filter((binding) => !output.materials.includes(binding));
  const added = output.materials.filter((binding) => !source.materials.includes(binding));
  if (missing.length > 0) failures.push(`material bindings lost: ${missing.join(", ")}`);
  if (added.length > 0) failures.push(`material bindings appeared: ${added.join(", ")}`);
  if (failures.length > 0) {
    throw new Error(
      `TN_ASSETS_MODEL_TEXTURE_DRIFT: embedded-texture self-verification failed for '${logicalPath}': ${failures.join("; ")}.`,
    );
  }
}

/** sRGB decode table; averaging in sRGB space darkens a downsampled colour map. */
const SRGB_TO_LINEAR = new Float32Array(256);
for (let value = 0; value < 256; value += 1) {
  const channel = value / 255;
  SRGB_TO_LINEAR[value] = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  const encoded = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(encoded * 255)));
}

/**
 * Box-resamples tight RGBA down to the target size, averaging over the exact source area each
 * destination texel covers. Colour channels of an sRGB image are averaged in linear light —
 * the naive average of encoded values is visibly darker — while alpha is always linear.
 */
export function resampleRgba(
  data: Uint8Array,
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
  srgb: boolean,
): Uint8Array {
  const output = new Uint8Array(targetWidth * targetHeight * 4);
  const scaleX = width / targetWidth;
  const scaleY = height / targetHeight;
  for (let ty = 0; ty < targetHeight; ty += 1) {
    const y0 = ty * scaleY;
    const y1 = (ty + 1) * scaleY;
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const x0 = tx * scaleX;
      const x1 = (tx + 1) * scaleX;
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let total = 0;
      for (let sy = Math.floor(y0); sy < Math.min(height, Math.ceil(y1)); sy += 1) {
        const weightY = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (weightY <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.min(width, Math.ceil(x1)); sx += 1) {
          const weightX = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (weightX <= 0) continue;
          const weight = weightX * weightY;
          const offset = (sy * width + sx) * 4;
          const r = data[offset] ?? 0;
          const g = data[offset + 1] ?? 0;
          const b = data[offset + 2] ?? 0;
          red += (srgb ? (SRGB_TO_LINEAR[r] ?? 0) : r) * weight;
          green += (srgb ? (SRGB_TO_LINEAR[g] ?? 0) : g) * weight;
          blue += (srgb ? (SRGB_TO_LINEAR[b] ?? 0) : b) * weight;
          alpha += (data[offset + 3] ?? 255) * weight;
          total += weight;
        }
      }
      const divisor = total === 0 ? 1 : total;
      const target = (ty * targetWidth + tx) * 4;
      output[target] = srgb ? linearToSrgb(red / divisor) : Math.round(red / divisor);
      output[target + 1] = srgb ? linearToSrgb(green / divisor) : Math.round(green / divisor);
      output[target + 2] = srgb ? linearToSrgb(blue / divisor) : Math.round(blue / divisor);
      output[target + 3] = Math.round(alpha / divisor);
    }
  }
  return output;
}

/** Shared images retain the largest consuming slot cap; unlisted slots keep the caller's default. */
export function resolveTextureMaxSize(
  maxSize: TextureMaxSize | undefined,
  slots: readonly string[],
  fallback = DEFAULT_MAX_SIZE,
): number {
  if (typeof maxSize === "number") return maxSize;
  return Math.max(
    ...(slots.length === 0 ? [fallback] : slots.map((slot) => maxSize?.[slot] ?? fallback)),
  );
}

/** Longest edge clamped to the cap, aspect preserved, each edge a whole number of blocks. */
export function cappedSize(
  width: number,
  height: number,
  maxSize: number,
): { height: number; width: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSize) return { height, width };
  const scale = maxSize / longest;
  const snap = (value: number): number =>
    Math.max(BLOCK_SIZE, Math.round((value * scale) / BLOCK_SIZE) * BLOCK_SIZE);
  return { height: snap(height), width: snap(width) };
}

interface ICodecRung {
  readonly codec: TextureCodec;
  readonly rdoLambda?: number;
}

/** Unvalidated data slots retain UASTC/none until a slot-appropriate metric exists. */
export function codecLadder(
  slots: readonly string[],
  forced?: TextureCodec,
): readonly ICodecRung[] {
  const data = slots.length === 0 || slots.some((slot) => !COLOUR_SLOTS.has(slot));
  if (forced !== undefined) {
    if (forced === "etc1s" && data)
      throw new Error("TN_ASSETS_TEXTURE_SLOT_CODEC: ETC1S is forbidden for normal/data slots.");
    return [{ codec: forced }];
  }
  return data
    ? [{ codec: "uastc" }, { codec: "none" }]
    : [
        { codec: "etc1s" },
        { codec: "uastc", rdoLambda: 3 },
        { codec: "uastc", rdoLambda: 1 },
        { codec: "uastc" },
        { codec: "none" },
      ];
}

/** Above this, a source ETC1S cannot beat skips the UASTC rungs; the RDO bound uses the same size. */
const LARGE_LADDER_TEXELS = 256 * 256;

/** Both compression passes retain the smallest eligible encoded candidate that passes. */
export async function encodeTextureLadder(
  data: Uint8Array,
  width: number,
  height: number,
  options: IImageQualityOptions & {
    readonly astc?: boolean;
    readonly gltfColorPrimaries?: 0 | 1;
    readonly forced?: TextureCodec;
    /** Automatic source retention: candidates that cannot save bytes need no quality score. */
    readonly maxBytes?: number;
    readonly srgb: boolean;
    readonly quality: number;
  },
): Promise<{
  readonly encoded?: Uint8Array;
  readonly codec: TextureCodec;
  readonly quality: ITextureQuality;
}> {
  const slots = options.slots ?? ["baseColorTexture"];
  let smallest: { encoded: Uint8Array; codec: TextureCodec; quality: ITextureQuality } | undefined;
  let smallerThanSource = options.maxBytes === undefined;
  let sourceWins = false;
  for (const candidate of codecLadder(slots, options.forced)) {
    if (candidate.codec === "none" && smallest !== undefined) return smallest;
    if (sourceWins && candidate.codec !== "none") continue;
    const rung =
      candidate.codec === "etc1s"
        ? `etc1s@${options.quality}`
        : candidate.rdoLambda === undefined
          ? candidate.codec
          : `uastc+rdo λ${candidate.rdoLambda} +zstd`;
    const basis =
      candidate.codec === "none"
        ? undefined
        : await encodeToKTX2(new Uint8Array([0]), {
            generateMipmap: true,
            imageDecoder: async () => ({ data, height, width }),
            isUASTC: candidate.codec === "uastc",
            isNormalMap: slots.some((slot) => NORMAL_SLOTS.has(slot)),
            isPerceptual: options.srgb,
            isSetKTX2SRGBTransferFunc: options.srgb,
            qualityLevel: options.quality,
            needSupercompression: true,
            ...(candidate.rdoLambda === undefined ? {} : { rdoLambda: candidate.rdoLambda }),
          });
    const encoded =
      options.astc === true && basis !== undefined
        ? await transcodeKtx2ToAstc(basis, options.gltfColorPrimaries)
        : basis;
    if (encoded !== undefined && options.maxBytes !== undefined) {
      if (encoded.byteLength >= options.maxBytes) {
        // ponytail: ETC1S is the ladder's lowest bitrate, so on a large image the UASTC rungs it
        // cannot beat are not encoded: the starter's 4096x2048 sky spent 50 s on three of them to
        // ship its source anyway. Ceiling: a smooth image whose UASTC+RDO+zstd would undercut both
        // ETC1S and the source ships the source; walk the full ladder if that case is measured.
        if (candidate.codec === "etc1s" && width * height > LARGE_LADDER_TEXELS) sourceWins = true;
        continue;
      }
      smallerThanSource = true;
    }
    // A larger candidate cannot replace the passing minimum, regardless of its score.
    if (
      encoded !== undefined &&
      smallest !== undefined &&
      encoded.byteLength >= smallest.encoded.byteLength
    )
      continue;
    // Admission and quality both observe the exact buffer that will be written.
    const score =
      encoded === undefined
        ? imageQuality(data, data, width, height, options)
        : await measureKtx2(data, encoded, width, height, options);
    if (
      score.status !== "below-floor" &&
      ((options.alphaThresholds?.length ?? 0) > 0 || score.alpha.meanAbsoluteError === 0)
    ) {
      const quality: ITextureQuality = {
        ...score,
        rung,
        codec: candidate.codec,
        sourceWidth: width,
        sourceHeight: height,
        ...(encoded === undefined
          ? {
              compressionSkipped: smallerThanSource
                ? ("below-floor" as const)
                : ("not-smaller" as const),
            }
          : {}),
      };
      if (encoded === undefined) return { codec: candidate.codec, quality };
      if (smallest === undefined || encoded.byteLength < smallest.encoded.byteLength)
        smallest = { encoded, codec: candidate.codec, quality };
    }
  }
  if (smallest !== undefined) return smallest;
  throw new Error("TN_ASSETS_TEXTURE_FLOOR: forced codec fails its configured floor.");
}

/**
 * The smallest JPEG quality that still passes the same floor as every other rung. A colour map
 * authored as a JPEG or PNG often has 25 to 40 percent of its bytes to give at SSIM 0.95, and
 * JPEG needs no runtime decoder. Data slots (normal, occlusion, metallic-roughness) never enter
 * this ladder: lossy chroma on those is a shading error the floor does not model.
 */
const JPEG_QUALITY_RUNGS = [75, 80, 85, 90] as const;

async function encodeJpegCandidate(
  data: Uint8Array,
  width: number,
  height: number,
  options: IImageQualityOptions & { readonly floor?: Partial<IImageQualityFloor> },
): Promise<{ readonly buffer: Buffer; readonly quality: ITextureQuality } | undefined> {
  const sharp = (await import("sharp")).default;
  for (const quality of JPEG_QUALITY_RUNGS) {
    const buffer = await sharp(Buffer.from(data), {
      raw: { channels: 4, height, width },
    })
      .jpeg({ mozjpeg: true, quality })
      .toBuffer();
    const decoded = await decodeImageBytes(buffer, "jpeg-candidate");
    const score = imageQuality(data, decoded.data, width, height, options);
    if (score.status !== "pass" || score.alpha.meanAbsoluteError !== 0) continue;
    return {
      buffer,
      quality: {
        ...score,
        codec: "jpeg",
        rung: `jpeg@${String(quality)}`,
        sourceHeight: height,
        sourceWidth: width,
      },
    };
  }
  return undefined;
}

function gpuBytes(width: number, height: number, codec: string): number {
  return Math.round(width * height * (GPU_BYTES_PER_PIXEL[codec] ?? 4) * MIP_FACTOR);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Transcodes every embedded image in place and returns what it did. Mutates the document:
 * each compressed texture gets KTX2 bytes and the `image/ktx2` mime type, and the document
 * declares `KHR_texture_basisu` as required — a loader without a transcoder cannot read the
 * result, and saying so is the honest declaration.
 */
/** An image the shared store supplied already encoded, with what its source measured. */
export interface IRecalledTexture {
  readonly quality?: ITextureQuality;
  readonly codec: string;
  readonly sourceBytes: number;
}

export async function compressEmbeddedTextures(
  document: Document,
  logicalPath: string,
  options: IModelTexturesOptions = {},
  recalled: ReadonlyMap<number, IRecalledTexture> = new Map(),
): Promise<IEmbeddedTextureSummary | undefined> {
  const root = document.getRoot();
  const textures = root.listTextures();
  if (textures.length === 0) return undefined;
  const decoderFree = options.decoderFree === true;
  const transcoderBytes = Math.max(0, options.transcoderBytes ?? BASIS_TRANSCODER_BYTES);
  const quality = Math.min(255, Math.max(1, Math.round(options.quality ?? DEFAULT_ETC1S_QUALITY)));
  const keys = textureKeys(root);
  const formats: Record<string, string> = {};
  const scores: Record<string, ITextureQuality> = {};
  const skippedCompression: Record<string, TextureSkipReason> = {};
  let bytesBefore = 0;
  let bytesAfter = 0;
  let gpuBytesBefore = 0;
  let gpuBytesAfter = 0;
  let resized = 0;
  let compressed = 0;

  for (const [index, texture] of textures.entries()) {
    const key = keys[index] ?? `texture#${String(index)}`;
    const image = texture.getImage();
    if (image === null) {
      throw new Error(
        `TN_ASSETS_MODEL_TEXTURE_MISSING: '${logicalPath}' declares texture '${key}' with no image data.`,
      );
    }
    // Store hits replay the complete decision, including an uncompressed fallback, without a decode.
    const fromStore = recalled.get(index);
    if (fromStore !== undefined) {
      const shape = imageShape(image, texture.getMimeType());
      bytesBefore += fromStore.sourceBytes;
      bytesAfter += image.byteLength;
      const score = fromStore.quality;
      gpuBytesBefore += gpuBytes(
        score?.sourceWidth ?? shape.width,
        score?.sourceHeight ?? shape.height,
        "none",
      );
      gpuBytesAfter += gpuBytes(shape.width, shape.height, fromStore.codec);
      formats[key] = fromStore.codec;
      if (score !== undefined) {
        if (options.measureQuality !== false) scores[key] = score;
        if (score.compressionSkipped !== undefined)
          skippedCompression[key] = score.compressionSkipped;
        if (shape.width !== score.sourceWidth || shape.height !== score.sourceHeight) resized += 1;
      }
      if (fromStore.codec !== "none") compressed += 1;
      continue;
    }
    const slots = listTextureSlots(texture);
    const forced = options.overrides?.find((override) => slots.includes(override.slot))?.codec;
    let authoredBasis = false;
    if (
      texture.getMimeType() === "image/ktx2" &&
      options.astc === true &&
      !decoderFree &&
      forced !== "none"
    ) {
      try {
        authoredBasis = readKTX2(image).vkFormat === 0;
      } catch (error) {
        throw new Error(
          `TN_ASSETS_MODEL_BASIS_ASTC: invalid authored KTX2 '${key}': ${messageOf(error)}`,
        );
      }
    }
    // Already compressed upstream: left exactly as authored, and still counted so the
    // reported GPU total is the whole model rather than only the part this stage touched.
    if (texture.getMimeType() === "image/ktx2" && !authoredBasis) {
      const shape = imageShape(image, "image/ktx2");
      bytesBefore += image.byteLength;
      bytesAfter += image.byteLength;
      const already = gpuBytes(shape.width, shape.height, "uastc");
      gpuBytesBefore += already;
      gpuBytesAfter += already;
      continue;
    }

    const authoredCodec =
      authoredBasis && readKTX2(image).dataFormatDescriptor[0]?.colorModel === KHR_DF_MODEL_UASTC
        ? "uastc"
        : "etc1s";
    const maxSize = resolveTextureMaxSize(options.maxSize, slots);
    let decoded: { data: Uint8Array; height: number; width: number };
    try {
      if (authoredBasis) {
        const shape = imageShape(image, "image/ktx2");
        decoded = { ...shape, data: await decodeBasisKtx2(image, shape.width, shape.height, true) };
      } else {
        decoded = await decodeImageBytes(
          Buffer.from(image.buffer, image.byteOffset, image.byteLength),
          `${logicalPath}#${key}`,
        );
      }
    } catch (error) {
      throw new Error(
        `TN_ASSETS_MODEL_TEXTURE_UNDECODABLE: ${authoredBasis ? "TN_ASSETS_MODEL_BASIS_ASTC: " : ""}could not decode embedded texture '${key}' of '${logicalPath}': ${messageOf(error)}`,
      );
    }
    const explicit = (options.overrides ?? []).some((override) => slots.includes(override.slot));
    const codec = codecLadder(slots, forced)[0]?.codec ?? "none";
    bytesBefore += image.byteLength;
    gpuBytesBefore += gpuBytes(
      decoded.width,
      decoded.height,
      authoredBasis ? authoredCodec : "none",
    );
    if (codec === "none") {
      bytesAfter += image.byteLength;
      gpuBytesAfter += gpuBytes(decoded.width, decoded.height, "none");
      formats[key] = "none";
      if (options.measureQuality !== false)
        scores[key] = {
          ...imageQuality(decoded.data, decoded.data, decoded.width, decoded.height, {
            ...textureQualitySemantics(texture),
            floor: options.floor,
          }),
          rung: "none",
          codec: "none",
          sourceWidth: decoded.width,
          sourceHeight: decoded.height,
        };
      continue;
    }
    if (decoderFree) {
      // No Basis transcoder on this target, so the cap is honoured by resampling and re-emitting
      // a PNG. An image already within the cap keeps its authored bytes — unless its container is
      // one only an extension-reading loader understands, where keeping them would ship the very
      // requirement this path exists to remove. KHR_texture_basisu is never declared.
      const target = cappedSize(decoded.width, decoded.height, maxSize);
      const downsampled = target.width !== decoded.width || target.height !== decoded.height;
      if (!downsampled && UNIVERSAL_IMAGE_CONTAINERS.has(texture.getMimeType())) {
        bytesAfter += image.byteLength;
        gpuBytesAfter += gpuBytes(decoded.width, decoded.height, "none");
        formats[key] = "none";
        continue;
      }
      const data = downsampled
        ? resampleRgba(
            decoded.data,
            decoded.width,
            decoded.height,
            target.width,
            target.height,
            getTextureColorSpace(texture) === "srgb",
          )
        : decoded.data;
      const png = new PNG({ height: target.height, width: target.width });
      png.data = Buffer.from(data);
      const encoded = PNG.sync.write(png);
      texture.setImage(encoded).setMimeType("image/png");
      bytesAfter += encoded.byteLength;
      gpuBytesAfter += gpuBytes(target.width, target.height, "none");
      formats[key] = "none";
      if (downsampled) resized += 1;
      continue;
    }

    const target = cappedSize(decoded.width, decoded.height, maxSize);
    const srgb = getTextureColorSpace(texture) === "srgb";
    let data = decoded.data;
    if (target.width !== decoded.width || target.height !== decoded.height) {
      data = resampleRgba(
        decoded.data,
        decoded.width,
        decoded.height,
        target.width,
        target.height,
        srgb,
      );
      resized += 1;
    }
    if (!authoredBasis && (target.width % BLOCK_SIZE !== 0 || target.height % BLOCK_SIZE !== 0)) {
      // Same split as the standalone pass: a codec named per slot is a request no block format
      // can satisfy, while an automatic choice retains the image untouched. `cappedSize` only
      // ever returns multiples of four, so an unaligned target means nothing was resampled and
      // `image` is still the bytes and dimensions the model was authored with.
      if (explicit) {
        throw new Error(
          `TN_ASSETS_MODEL_TEXTURE_BLOCK_SIZE: embedded texture '${key}' of '${logicalPath}' is ${String(target.width)}x${String(target.height)}, which is not a multiple of the ${String(BLOCK_SIZE)}x${String(BLOCK_SIZE)} block the ${codec} codec transcodes to; WebGPU rejects such a texture at draw time. Resize the source to a multiple of ${String(BLOCK_SIZE)} inside the model, or declare an override with codec "none" for its slot.`,
        );
      }
      bytesAfter += image.byteLength;
      gpuBytesAfter += gpuBytes(decoded.width, decoded.height, "none");
      formats[key] = "none";
      skippedCompression[key] = "block-size";
      if (options.measureQuality !== false)
        scores[key] = {
          ...imageQuality(decoded.data, decoded.data, decoded.width, decoded.height, {
            ...textureQualitySemantics(texture),
            floor: options.floor,
          }),
          rung: "none",
          codec: "none",
          compressionSkipped: "block-size",
          sourceWidth: decoded.width,
          sourceHeight: decoded.height,
        };
      continue;
    }

    // A colour map needs no runtime decoder in its authored container. Pick the smallest JPEG
    // rung the floor allows; KTX2 then has to beat that, plus the shared transcoder, to win.
    const authoredContainer =
      !explicit &&
      !authoredBasis &&
      options.jpeg !== false &&
      options.astc !== true &&
      target.width === decoded.width &&
      target.height === decoded.height &&
      UNIVERSAL_IMAGE_CONTAINERS.has(texture.getMimeType()) &&
      slots.some((slot) => COLOUR_SLOTS.has(slot));
    const jpeg = authoredContainer
      ? await encodeJpegCandidate(data, target.width, target.height, {
          ...textureQualitySemantics(texture),
          floor: options.floor,
        })
      : undefined;
    const jpegLimit =
      jpeg !== undefined && jpeg.buffer.byteLength < image.byteLength
        ? jpeg.buffer.byteLength
        : image.byteLength;

    let selected: Awaited<ReturnType<typeof encodeTextureLadder>>;
    try {
      if (authoredBasis && target.width === decoded.width && target.height === decoded.height) {
        const encoded = await transcodeKtx2ToAstc(image, srgb ? 1 : 0);
        const score = await measureKtx2(data, encoded, target.width, target.height, {
          ...textureQualitySemantics(texture),
          floor: options.floor,
        });
        if (
          score.status === "below-floor" ||
          ((textureQualitySemantics(texture).alphaThresholds?.length ?? 0) === 0 &&
            score.alpha.meanAbsoluteError !== 0)
        )
          throw new Error(
            "TN_ASSETS_TEXTURE_FLOOR: authored Basis to ASTC fails its configured floor.",
          );
        selected = {
          encoded,
          codec: authoredCodec,
          quality: {
            ...score,
            codec: authoredCodec,
            sourceWidth: decoded.width,
            sourceHeight: decoded.height,
          },
        };
      } else {
        selected = await encodeTextureLadder(data, target.width, target.height, {
          ...textureQualitySemantics(texture),
          floor: options.floor,
          srgb,
          quality,
          ...(options.astc === true
            ? { astc: true, gltfColorPrimaries: srgb ? (1 as const) : (0 as const) }
            : {}),
          // ponytail: one image must repay the whole transcoder, so a project whose many small
          // KTX2 wins add up to more than it stays decoder-free. Split the cost across the
          // project when a measured project loses bytes to this ceiling.
          ...(!explicit &&
          target.width === decoded.width &&
          target.height === decoded.height &&
          UNIVERSAL_IMAGE_CONTAINERS.has(texture.getMimeType())
            ? { maxBytes: jpegLimit - transcoderBytes }
            : {}),
          ...(forced === undefined ? {} : { forced }),
        });
      }
      if (authoredBasis && selected.encoded === undefined)
        throw new Error(
          "TN_ASSETS_TEXTURE_FLOOR: authored Basis cannot retain a decoder-dependent fallback.",
        );
    } catch (error) {
      if (!authoredBasis) throw error;
      throw new Error(`TN_ASSETS_MODEL_BASIS_ASTC: '${logicalPath}#${key}': ${messageOf(error)}`);
    }
    const encoded = selected.encoded;
    if (encoded === undefined && jpeg !== undefined && jpeg.buffer.byteLength < image.byteLength) {
      texture.setImage(jpeg.buffer).setMimeType("image/jpeg");
      bytesAfter += jpeg.buffer.byteLength;
      gpuBytesAfter += gpuBytes(target.width, target.height, "none");
      formats[key] = "none";
      if (options.measureQuality !== false) scores[key] = jpeg.quality;
      continue;
    }
    // A tiny source can cost less than the KTX2 container alone. Keep its exact bytes when
    // encoding cannot save download bytes *and* the authored container needs no extension to be
    // read; a WebP costs a decoder-free target the whole model, which is never the smaller cost.
    // A named codec override still requests GPU compression either way. The size increase is
    // reported by the existing `bytes before -> after` row of the build report.
    if (
      encoded === undefined ||
      (encoded.byteLength >= image.byteLength &&
        target.width === decoded.width &&
        target.height === decoded.height &&
        !explicit &&
        UNIVERSAL_IMAGE_CONTAINERS.has(texture.getMimeType()))
    ) {
      const downsampled = target.width !== decoded.width || target.height !== decoded.height;
      let retained: Uint8Array = image;
      if (downsampled) {
        const png = new PNG({ height: target.height, width: target.width });
        png.data = Buffer.from(data);
        retained = PNG.sync.write(png);
        texture.setImage(retained).setMimeType("image/png");
      }
      bytesAfter += retained.byteLength;
      gpuBytesAfter += gpuBytes(target.width, target.height, "none");
      formats[key] = "none";
      const reason = selected.quality.compressionSkipped ?? "not-smaller";
      skippedCompression[key] = reason;
      if (options.measureQuality !== false)
        scores[key] = {
          ...imageQuality(data, data, target.width, target.height, {
            ...textureQualitySemantics(texture),
            floor: options.floor,
          }),
          rung: "none",
          codec: "none",
          compressionSkipped: reason,
          sourceWidth: decoded.width,
          sourceHeight: decoded.height,
        };
      continue;
    }
    const container = readKTX2(encoded);
    if (container.levelCount < 2 && !authoredBasis) {
      throw new Error(
        `TN_ASSETS_MIP_CHAIN_INCOMPLETE: embedded texture '${key}' of '${logicalPath}' encoded without a mip chain (${String(container.levelCount)} level(s)).`,
      );
    }
    if (options.measureQuality !== false) {
      scores[key] = {
        ...selected.quality,
        sourceWidth: decoded.width,
        sourceHeight: decoded.height,
      };
    }
    texture.setImage(encoded).setMimeType("image/ktx2");
    formats[key] = options.astc === true ? "astc4x4" : selected.codec;
    bytesAfter += encoded.byteLength;
    gpuBytesAfter += gpuBytes(target.width, target.height, formats[key] ?? selected.codec);
    compressed += 1;
  }

  const hasAstc = textures.some(isRawAstc);
  if (hasAstc) document.createExtension(EXTTextureAstc).setRequired(true);
  else document.disposeExtension(EXTTextureAstc.EXTENSION_NAME);
  if (options.astc === true || hasAstc) {
    if (textures.some((texture) => texture.getMimeType() === "image/ktx2" && !isRawAstc(texture)))
      document.createExtension(KHRTextureBasisu).setRequired(true);
    else document.disposeExtension(KHRTextureBasisu.EXTENSION_NAME);
  } else if (compressed > 0) {
    document.createExtension(KHRTextureBasisu).setRequired(true);
  }
  // A glTF writer emits every extension still attached, so a model authored with WebP images
  // would keep *requiring* EXT_texture_webp after the cook replaced those images. Dropped only
  // once no image is left in the container: an over-cap image the project chose to keep as
  // authored is still a WebP a reader has to understand.
  if (!textures.some((texture) => texture.getMimeType() === "image/webp")) {
    document.disposeExtension(EXTTextureWebP.EXTENSION_NAME);
  }
  return {
    quality: scores,
    bytesAfter,
    bytesBefore,
    count: textures.length,
    formats,
    gpuBytesAfter,
    gpuBytesBefore,
    resized,
    skippedCompression,
  };
}

/** Every consuming slot and MASK cutoff participates, including shared colour/data images. */
export function textureQualitySemantics(texture: Texture): {
  slots: string[];
  alphaThresholds: number[];
} {
  return {
    slots: [...listTextureSlots(texture)].sort(),
    alphaThresholds: [
      ...new Set(
        texture.listParents().flatMap((parent) => {
          if (parent.propertyType !== "Material") return [];
          const material = parent as import("@gltf-transform/core").Material;
          return material.getBaseColorTexture() === texture && material.getAlphaMode() === "MASK"
            ? [material.getAlphaCutoff()]
            : [];
        }),
      ),
    ].sort((a, b) => a - b),
  };
}
