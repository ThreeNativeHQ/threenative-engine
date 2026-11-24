import {
  KHR_DF_MODEL_ASTC,
  KHR_DF_TRANSFER_LINEAR,
  KHR_DF_TRANSFER_SRGB,
  KHR_SUPERCOMPRESSION_NONE,
  VK_FORMAT_ASTC_4x4_SRGB_BLOCK,
  VK_FORMAT_ASTC_4x4_UNORM_BLOCK,
  read as readKTX2,
  write as writeKTX2,
} from "ktx-parse";
import BASIS from "../vendor/basis-encoder/basis_encoder.js";
import { resampleRgba } from "./passes/resample.js";

/** Included in both pass and shared-image cache keys whenever encoded bytes can change (v4: a projected atlas leaves the JPEG contest). */
export const KTX2_ENCODER_VERSION = "basis-v2.5-ldr16m-zstd-rdo-fast-capped-projected-v4";

const OUTPUT_HEADER_SLACK = 64 * 1024;
/** One Basis pass; above it only UASTC is encoded, in strips. */
export const MAX_SOURCE_TEXELS = 16 * 1024 * 1024;
/** WebGPU's default maxTextureDimension2D squared; a tiled UASTC source may be this large. */
const MAX_TILED_TEXELS = 8192 * 8192;

interface IEncodeOptions {
  readonly generateMipmap?: boolean;
  readonly imageDecoder: (
    input: Uint8Array,
  ) => Promise<{ readonly data: Uint8Array; readonly height: number; readonly width: number }>;
  readonly isNormalMap?: boolean;
  readonly isPerceptual?: boolean;
  readonly isSetKTX2SRGBTransferFunc?: boolean;
  readonly isUASTC?: boolean;
  /** Internal: the per-call encoder ceiling, lowered by tests to exercise tiling cheaply. */
  readonly maxSourceTexels?: number;
  readonly needSupercompression?: boolean;
  readonly qualityLevel?: number;
  readonly rdoLambda?: number;
}

interface IBasisEncoder {
  delete(): void;
  encode(output: Uint8Array): number;
  setCreateKTX2File(enabled: boolean): void;
  setDebug(enabled: boolean): void;
  setKTX2AndBasisSRGBTransferFunc(enabled: boolean): void;
  setKTX2UASTCSupercompression(enabled: boolean): void;
  setMipGen(enabled: boolean): void;
  setNormalMapPreset(): void;
  setPerceptual(enabled: boolean): void;
  setQualityLevel(quality: number): void;
  setSliceSourceImage(
    slice: number,
    input: Uint8Array,
    width: number,
    height: number,
    sourceType: number,
  ): boolean;
  setTexType(type: number): void;
  setUASTC(enabled: boolean): void;
  setRDOUASTC(enabled: boolean): void;
  setRDOUASTCQualityScalar(lambda: number): void;
  setRDOUASTCDictSize(bytes: number): void;
  setPackUASTCFlags(flags: number): void;
}

interface IEncoderKtx2File {
  close(): void;
  delete(): void;
  isValid(): boolean;
  isASTC_LDR(): boolean;
  startTranscoding(): boolean;
  getWidth(): number;
  getHeight(): number;
  getLevels(): number;
  getImageTranscodedSizeInBytes(mip: number, layer: number, face: number, format: number): number;
  transcodeImage(
    dst: Uint8Array,
    mip: number,
    layer: number,
    face: number,
    format: number,
    alpha: number,
    channel0: number,
    channel1: number,
  ): boolean;
}

interface IBasisModule {
  readonly BasisEncoder: new () => IBasisEncoder;
  readonly KTX2File: new (bytes: Uint8Array) => IEncoderKtx2File;
  initializeBasis(): void;
}

let modulePromise: Promise<IBasisModule> | undefined;

async function basisModule(): Promise<IBasisModule> {
  modulePromise ??= BASIS().then((value) => {
    const module = value as IBasisModule;
    module.initializeBasis();
    return module;
  });
  return modulePromise;
}

/**
 * Private LDR KTX2 encoder for the asset compiler. Its WASM32 build raises Basis v2.5's
 * conservative LDR ceiling from 12 to 16 Mi texels so an ordinary 4096² source is retained;
 * a larger UASTC source, up to 8192², is encoded in strips (see {@link encodeTiledUastc}).
 * The codecs and appearance settings remain wholly caller-owned.
 */
export async function encodeToKTX2(
  input: Uint8Array,
  options: IEncodeOptions,
): Promise<Uint8Array> {
  if (
    options.rdoLambda !== undefined &&
    (!(options.rdoLambda > 0) || !Number.isFinite(options.rdoLambda) || options.isUASTC === false)
  )
    throw new Error("TN_ASSETS_KTX2_RDO: RDO requires UASTC and a positive finite lambda.");
  const decoded = await options.imageDecoder(input);
  const texels = decoded.width * decoded.height;
  const cap = options.maxSourceTexels ?? MAX_SOURCE_TEXELS;
  if (!Number.isSafeInteger(texels) || texels <= 0 || texels > MAX_TILED_TEXELS) {
    throw new Error(
      `TN_ASSETS_KTX2_SOURCE_SIZE: ${String(decoded.width)}x${String(decoded.height)} is ${String(texels)} texels; the KTX2 encoder supports 1–${String(MAX_TILED_TEXELS)} texels.`,
    );
  }
  if (texels > cap) return encodeTiledUastc(decoded, options, cap);

  const encoder = new (await basisModule()).BasisEncoder();
  try {
    const generateMipmap = options.generateMipmap ?? true;
    encoder.setDebug(false);
    encoder.setUASTC(options.isUASTC ?? true);
    encoder.setCreateKTX2File(true);
    encoder.setKTX2AndBasisSRGBTransferFunc(options.isSetKTX2SRGBTransferFunc ?? true);
    encoder.setMipGen(generateMipmap);
    if (options.isNormalMap === true) encoder.setNormalMapPreset();
    encoder.setQualityLevel(options.qualityLevel ?? 150);
    // Preserve ktx2-encoder@0.6.0's omitted-option default; this is lossless, not UASTC RDO.
    encoder.setKTX2UASTCSupercompression(options.needSupercompression ?? true);
    if (options.rdoLambda !== undefined) {
      // Small images are already cheap. Bound cold-cook work on larger RDO candidates;
      // they still pass the same measured floor, with full-effort plain UASTC as fallback.
      if (texels > 256 * 256) {
        encoder.setPackUASTCFlags(0);
        encoder.setRDOUASTCDictSize(64);
      }
      encoder.setRDOUASTC(true);
      encoder.setRDOUASTCQualityScalar(options.rdoLambda);
    }
    if (options.isPerceptual !== undefined) encoder.setPerceptual(options.isPerceptual);
    encoder.setTexType(0);

    const accepted = encoder.setSliceSourceImage(
      0,
      new Uint8Array(decoded.data),
      decoded.width,
      decoded.height,
      0,
    );
    if (!accepted) {
      throw new Error(
        `TN_ASSETS_KTX2_SOURCE_REJECTED: the encoder rejected ${String(decoded.width)}x${String(decoded.height)} RGBA input.`,
      );
    }

    const mipFactor = generateMipmap ? 4 / 3 : 1;
    let capacity = Math.ceil(texels * 4 * mipFactor) + OUTPUT_HEADER_SLACK;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const output = new Uint8Array(capacity);
      const byteLength = encoder.encode(output);
      if (byteLength > 0) return output.slice(0, byteLength);
      capacity *= 2;
    }
    throw new Error(
      `TN_ASSETS_KTX2_ENCODE_FAILED: Basis returned no bytes for ${String(decoded.width)}x${String(decoded.height)} input after two output-buffer attempts.`,
    );
  } finally {
    encoder.delete();
  }
}

/**
 * UASTC is a fixed-rate format of independent 4x4 blocks, so an over-cap source is encoded as
 * full-width strips whose level-0 block rows are contiguous in the final level 0, and the lower
 * mips come from one encode of the half-size image. With supercompression each strip's level is
 * one zstd frame; concatenated frames are one valid zstd stream (RFC 8878 section 3). Per-strip RDO
 * stays on: it only picks among valid block encodings, and the caller still scores the result.
 */
async function encodeTiledUastc(
  decoded: { readonly data: Uint8Array; readonly height: number; readonly width: number },
  options: IEncodeOptions,
  cap: number,
): Promise<Uint8Array> {
  const { data, height, width } = decoded;
  if (options.isUASTC === false)
    throw new Error(
      `TN_ASSETS_KTX2_SOURCE_SIZE: ${String(width)}x${String(height)} is ${String(width * height)} texels; the bundled WASM32 encoder takes at most ${String(cap)} in one pass and ETC1S's one global codebook cannot be tiled. Use codec "uastc" or a smaller maxSize for this slot.`,
    );
  const rows = Math.floor(cap / width / 4) * 4;
  const halfWidth = Math.max(1, width >> 1);
  const halfHeight = Math.max(1, height >> 1);
  if (rows < 4 || halfWidth * halfHeight > cap || (options.generateMipmap ?? true) === false)
    throw new Error(
      `TN_ASSETS_KTX2_SOURCE_SIZE: ${String(width)}x${String(height)} cannot be tiled under ${String(cap)} texels per pass with a full mip chain.`,
    );
  const strips: Uint8Array[] = [];
  let uncompressedByteLength = 0;
  for (let y = 0; y < height; y += rows) {
    const stripHeight = Math.min(rows, height - y);
    const strip = data.subarray(y * width * 4, (y + stripHeight) * width * 4);
    const level = readKTX2(
      await encodeToKTX2(new Uint8Array([0]), {
        ...options,
        generateMipmap: false,
        imageDecoder: async () => ({ data: strip, height: stripHeight, width }),
      }),
    ).levels[0];
    if (level === undefined) throw new Error("TN_ASSETS_KTX2_ENCODE_FAILED: strip has no level 0.");
    strips.push(level.levelData);
    uncompressedByteLength += level.uncompressedByteLength;
  }
  const srgb = options.isSetKTX2SRGBTransferFunc ?? true;
  const half = resampleRgba(data, width, height, halfWidth, halfHeight, srgb);
  const container = readKTX2(
    await encodeToKTX2(new Uint8Array([0]), {
      ...options,
      imageDecoder: async () => ({ data: half, height: halfHeight, width: halfWidth }),
    }),
  );
  const levelData = new Uint8Array(strips.reduce((total, strip) => total + strip.byteLength, 0));
  let offset = 0;
  for (const strip of strips) {
    levelData.set(strip, offset);
    offset += strip.byteLength;
  }
  container.pixelWidth = width;
  container.pixelHeight = height;
  container.levels = [{ levelData, uncompressedByteLength }, ...container.levels];
  container.levelCount = container.levels.length;
  return writeKTX2(container);
}

/** Validate and decode every final ASTC mip; retain only tight RGBA8 mip zero for scoring. */
export async function decodeAstcKtx2(
  encoded: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const container = readKTX2(encoded);
  const descriptor = container.dataFormatDescriptor[0];
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > MAX_TILED_TEXELS ||
    ![VK_FORMAT_ASTC_4x4_UNORM_BLOCK, VK_FORMAT_ASTC_4x4_SRGB_BLOCK].includes(container.vkFormat) ||
    container.pixelWidth !== width ||
    container.pixelHeight !== height ||
    container.typeSize !== 1 ||
    container.pixelDepth !== 0 ||
    container.layerCount !== 0 ||
    container.faceCount !== 1 ||
    container.supercompressionScheme !== KHR_SUPERCOMPRESSION_NONE ||
    container.globalData !== null ||
    container.dataFormatDescriptor.length !== 1 ||
    container.levelCount !== Math.floor(Math.log2(Math.max(width, height))) + 1 ||
    container.levels.length !== container.levelCount ||
    descriptor?.colorModel !== KHR_DF_MODEL_ASTC ||
    descriptor.transferFunction !==
      (container.vkFormat === VK_FORMAT_ASTC_4x4_SRGB_BLOCK
        ? KHR_DF_TRANSFER_SRGB
        : KHR_DF_TRANSFER_LINEAR) ||
    descriptor.texelBlockDimension.join() !== "3,3,0,0" ||
    descriptor.bytesPlane.join() !== "16,0,0,0,0,0,0,0"
  )
    throw new Error(
      "TN_ASSETS_QUALITY_DECODE: expected a full 2D ASTC 4x4 mip chain matching the comparison.",
    );
  const file = new (await basisModule()).KTX2File(encoded);
  try {
    if (
      !file.isValid() ||
      !file.isASTC_LDR() ||
      file.getWidth() !== width ||
      file.getHeight() !== height ||
      file.getLevels() !== container.levelCount ||
      !file.startTranscoding()
    )
      throw new Error("TN_ASSETS_QUALITY_DECODE: the installed encoder rejected final ASTC.");
    let mipZero: Uint8Array | undefined;
    // cTFRGBA32 in the pinned Basis Universal transcoder_texture_format enum.
    const format = 13;
    for (const [mip, level] of container.levels.entries()) {
      const mipWidth = Math.max(1, Math.floor(width / 2 ** mip));
      const mipHeight = Math.max(1, Math.floor(height / 2 ** mip));
      const blocks = Math.ceil(mipWidth / 4) * Math.ceil(mipHeight / 4) * 16;
      const pixels = mipWidth * mipHeight * 4;
      if (
        level.levelData.byteLength !== blocks ||
        level.uncompressedByteLength !== blocks ||
        file.getImageTranscodedSizeInBytes(mip, 0, 0, format) !== pixels
      )
        throw new Error(`TN_ASSETS_QUALITY_DECODE: invalid ASTC mip ${String(mip)} size.`);
      const decoded = new Uint8Array(pixels);
      if (!file.transcodeImage(decoded, mip, 0, 0, format, 0, -1, -1))
        throw new Error(
          `TN_ASSETS_QUALITY_DECODE: ASTC mip ${String(mip)} RGBA32 transcode failed.`,
        );
      if (mip === 0) mipZero = decoded;
    }
    if (mipZero === undefined) throw new Error("TN_ASSETS_QUALITY_DECODE: missing ASTC mip zero.");
    return mipZero;
  } finally {
    try {
      file.close();
    } finally {
      file.delete();
    }
  }
}
