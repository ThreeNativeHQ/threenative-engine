import { read as readKTX2 } from "ktx-parse";
import { PNG } from "pngjs";
import { type AssetKind, type IAssetPass, type IAssetPassOutput, classify } from "../compile.js";
import { textureStats } from "../health.js";
import {
  type IImageQualityFloor,
  IMAGE_QUALITY_IDENTITY,
  imageQuality,
  resolveImageQualityFloor,
  transcodeKtx2ToAstc,
} from "../image-quality.js";
import { KTX2_ENCODER_VERSION, encodeToKTX2 } from "../ktx2-encoder.js";
import { decodeImageBytes } from "./decode-image.js";
import { globMatch } from "./glob.js";
import {
  type TextureMaxSize,
  cappedSize,
  codecLadder,
  encodeTextureLadder,
  resampleRgba,
  resolveTextureMaxSize,
} from "./model-textures.js";

/**
 * Encodes compiled textures to KTX2/Basis so the GPU stores them compressed instead of as
 * decoded RGBA (a 2048x2048 PNG is 16 MB in VRAM; BC7/ASTC hold it in a quarter of that).
 *
 * Codec choice is a declared property of the asset, never a guess: a config override wins,
 * then the `*_normal.*` / `_nrm.*` filename convention constrains the shared measured ladder.
 * Colour escalates through ETC1S/RDO/UASTC/none; unknown alpha cutoffs require exact alpha. Mip chains are generated at
 * encode time — always — because an uploaded compressed texture without mips looks worse
 * than the PNG it replaced.
 *
 * The encoder is Basis Universal through `ktx2-encoder`'s in-process WASM build; users
 * install nothing extra. Sources it cannot decode (anything but PNG/JPEG today) fail the
 * build naming the file rather than shipping uncompressed behind the user's back.
 */

export type TextureCodec = "etc1s" | "none" | "uastc";

/**
 * Why a source shipped uncompressed although its pass ran. `not-smaller` means encoding would
 * have grown the download; `block-size` means no block codec can address the source's
 * dimensions; `below-floor` means no compressed rung passed. A capped source retains its resized pixels as PNG; none is a silent decision — the manifest carries
 * the reason and the report prints it.
 */
export type TextureSkipReason = "block-size" | "not-smaller" | "below-floor";

export interface ITextureOverride {
  readonly codec: TextureCodec;
  /** First matching override wins; matched against the logical path, e.g. "ui/x.png". */
  readonly glob: string;
  /** ETC1S encoder quality 1–255. Ignored for UASTC, which uses its own fixed defaults. */
  readonly quality?: number;
}

export interface ITexturePassOptions {
  /** Compiler-selected mobile output; the quality ladder measures final ASTC bytes. */
  readonly astc?: boolean;
  readonly floor?: Partial<IImageQualityFloor>;
  /** Internal reporting control; selection still measures and enforces the floor. */
  readonly measureQuality?: boolean;
  /** Longest edge to retain; larger sources are downsampled without upscaling. */
  readonly maxSize?: TextureMaxSize;
  readonly overrides?: readonly ITextureOverride[];
  /** ETC1S encoder quality 1–255, default 150. Ignored for UASTC. */
  readonly quality?: number;
}

/** Formats three transcodes to per codec, recorded in the manifest next to `format`. */
const TRANSCODE_TARGETS: Readonly<Record<Exclude<TextureCodec, "none">, readonly string[]>> = {
  etc1s: ["bc1", "etc2"],
  uastc: ["astc4x4", "bc7"],
};

const DEFAULT_ETC1S_QUALITY = 150;
/** BC1, BC7, ETC2 and ASTC 4x4 all address pixels in 4x4 blocks. */
const BLOCK_SIZE = 4;
/** Normal maps are data, not colour: no sRGB transfer function, non-perceptual encode. */
const NORMAL_MAP_BASENAME = /(?:^|[_-])(?:normal|nrm)$/iu;

export async function encodeLinearRgbaKtx2(
  data: Uint8Array,
  width: number,
  height: number,
  astc = false,
): Promise<Buffer> {
  const encoded = await encodeToKTX2(new Uint8Array([0]), {
    generateMipmap: true,
    imageDecoder: async () => ({ data, height, width }),
    isPerceptual: false,
    isSetKTX2SRGBTransferFunc: false,
    isUASTC: astc,
    qualityLevel: DEFAULT_ETC1S_QUALITY,
  });
  const container = readKTX2(encoded);
  if (container.levelCount < 2) {
    throw new Error(
      `TN_ASSETS_MIP_CHAIN_INCOMPLETE: generated lightmap encoded without a mip chain (${String(container.levelCount)} level(s)).`,
    );
  }
  return Buffer.from(astc ? await transcodeKtx2ToAstc(encoded, 0) : encoded);
}

/**
 * Encodes source textures as mipmapped KTX2/Basis data and declares their runtime transcode targets.
 * @constraint every compressed source width and height must be divisible by 4 because BC7, BC1, ETC2, and ASTC 4x4 use 4x4 blocks; WebGPU rejects an unaligned texture at draw time
 * @constraint automatic cooking retains an unaligned source unchanged and reports block-size; an explicit compression codec override fails, while codec "none" remains available
 * @example const pass = texturePass({ overrides: [{ glob: "ui/*", codec: "none" }] });
 */
export function texturePass(options: ITexturePassOptions = {}): IAssetPass {
  return {
    appliesTo: ["texture"],
    configuration: {
      encoder: KTX2_ENCODER_VERSION,
      ...(options.astc === true ? { gpuFormat: "astc4x4-final-quality-v4-bottom-up" } : {}),
      instrument: IMAGE_QUALITY_IDENTITY,
      floor: resolveImageQualityFloor(options.floor),
      keepSmallerSource: true,
      ...(options.maxSize === undefined ? {} : { maxSize: options.maxSize }),
      overrides: options.overrides ?? [],
      quality: options.quality ?? DEFAULT_ETC1S_QUALITY,
    },
    apply: async (input: Buffer, logicalPath: string): Promise<Buffer | IAssetPassOutput> => {
      if (classify(logicalPath) !== "texture") return input;
      // Decode the source once; every encoder candidate and its quality check uses these pixels.
      // The decoder reads PNG, JPEG and WebP and names the file for any other container.
      const decoded = await decodeImageBytes(input, logicalPath);
      const choice = texturePolicy(logicalPath, options);
      if (choice.codec === "none")
        return {
          buffer: input,
          entry:
            options.measureQuality === false
              ? {}
              : {
                  quality: {
                    ...imageQuality(decoded.data, decoded.data, decoded.width, decoded.height, {
                      slots: [choice.normalMap ? "normalTexture" : "baseColorTexture"],
                      floor: options.floor,
                    }),
                    codec: "none",
                    rung: "none",
                    sourceWidth: decoded.width,
                    sourceHeight: decoded.height,
                  },
                },
        };
      const { data, resized, target } = resizeForEncoding(
        decoded,
        choice.normalMap,
        resolveTextureMaxSize(
          options.maxSize,
          [choice.normalMap ? "normalTexture" : "baseColorTexture"],
          Number.POSITIVE_INFINITY,
        ),
      );
      // Decided before `encodeToKTX2`, because Basis accepts an unaligned source and stamps the
      // odd size into the KTX2 header: that silence is how this reached a draw call.
      if (target.width % BLOCK_SIZE !== 0 || target.height % BLOCK_SIZE !== 0) {
        return unalignedOutcome(input, logicalPath, choice.codec, choice.explicit, target);
      }
      // Standalone ASTC uploads without the flipY that PNG gets, so its first stored row is the bottom row.
      // The ladder scores these pixels. The PNG fallback below keeps reading `data`.
      let encodeInput = data;
      if (options.astc === true) {
        const stride = target.width * 4;
        encodeInput = new Uint8Array(data.length);
        for (let row = 0; row < target.height; row += 1)
          encodeInput.set(
            data.subarray((target.height - 1 - row) * stride, (target.height - row) * stride),
            row * stride,
          );
      }
      const selected = await encodeTextureLadder(encodeInput, target.width, target.height, {
        slots: [choice.normalMap ? "normalTexture" : "baseColorTexture"],
        floor: options.floor,
        srgb: !choice.normalMap,
        quality: choice.quality,
        ...(options.astc === true ? { astc: true } : {}),
        ...(!resized && !choice.explicit ? { maxBytes: input.byteLength } : {}),
        ...(choice.explicit ? { forced: choice.codec } : {}),
      });
      const encoded = selected.encoded;
      if (
        encoded === undefined ||
        (!resized && encoded.byteLength >= input.byteLength && !choice.explicit)
      ) {
        const reason = selected.quality.compressionSkipped ?? "not-smaller";
        let retained = input;
        if (resized) {
          const png = new PNG({ height: target.height, width: target.width });
          png.data = Buffer.from(data);
          retained = PNG.sync.write(png);
        }
        return {
          buffer: retained,
          ...(resized ? { outputExtension: ".png" } : {}),
          entry: {
            format: "none",
            compressionSkipped: reason,
            ...(options.measureQuality === false
              ? {}
              : {
                  quality: {
                    ...imageQuality(data, data, target.width, target.height, {
                      slots: [choice.normalMap ? "normalTexture" : "baseColorTexture"],
                      floor: options.floor,
                    }),
                    codec: "none",
                    rung: "none",
                    compressionSkipped: reason,
                    sourceWidth: decoded.width,
                    sourceHeight: decoded.height,
                  },
                }),
          },
        };
      }
      const container = readKTX2(encoded);
      if (container.levelCount < 2) {
        throw new Error(
          `TN_ASSETS_MIP_CHAIN_INCOMPLETE: '${logicalPath}' encoded without a mip chain (${String(container.levelCount)} level(s)).`,
        );
      }
      return {
        buffer: Buffer.from(encoded),
        entry: {
          ...(options.astc === true
            ? { format: "astc4x4" }
            : {
                format: selected.codec,
                transcodeTargets:
                  TRANSCODE_TARGETS[selected.codec as Exclude<TextureCodec, "none">],
              }),
          ...(options.measureQuality === false
            ? {}
            : {
                quality: {
                  ...selected.quality,
                  sourceWidth: decoded.width,
                  sourceHeight: decoded.height,
                },
              }),
        },
        outputExtension: ".ktx2",
      };
    },
    name: "ktx2",
  };
}

export interface ITextureResizeOptions {
  /** Longest edge to retain; larger sources are downsampled, never upscaled. */
  readonly maxSize: TextureMaxSize;
  /**
   * The project's `assets.textures.overrides`, unchanged. A `codec: "none"` glob says "ship the
   * authored bytes", and a resize rewrites them.
   */
  readonly overrides?: readonly ITextureOverride[];
}

/**
 * The decoder-free half of a size cap: on a target with no Basis transcoder a requested
 * `textures.maxSize` cannot ship as KTX2, but it must still ship *somewhere*. This pass resizes
 * an over-cap PNG or JPEG with the same `cappedSize`/`resampleRgba` the encoder path uses —
 * alpha preserved, colour averaged in linear light, normal maps left as data — and writes the
 * result as a PNG. A source already within the cap keeps its authored bytes untouched, and the
 * file on disk is never rewritten.
 *
 * Only containers the decoder-free path can actually read are touched: a `.webp` or another
 * format with no pure-JS decoder is passed through rather than failing a build over art the
 * project already ships. A PNG/JPEG whose bytes are corrupt fails naming the logical path.
 *
 * An override of `codec: "none"` is honoured here too, for the same reason the KTX2 pass honours
 * it: the project asked for those bytes exactly as authored, and a size cap is a project decision
 * about *its* other textures, not a licence to rewrite the ones it excluded.
 */
export function textureResizePass(options: ITextureResizeOptions): IAssetPass {
  const { maxSize } = options;
  return {
    appliesTo: ["texture"],
    // Part of the compile cache key: a different cap — or a different set of excluded globs — must
    // not re-serve the previous output.
    configuration: { maxSize, overrides: options.overrides ?? [], resample: "png" },
    name: "texture-resize",
    apply: async (input: Buffer, logicalPath: string): Promise<Buffer | IAssetPassOutput> => {
      if (classify(logicalPath) !== "texture") return input;
      if (matchingOverride(logicalPath, options.overrides)?.codec === "none") return input;
      const stats = textureStats(input);
      let decoded: { data: Uint8Array; height: number; width: number } | undefined;
      if (stats.width <= 0 || stats.height <= 0) {
        // A supported container with an unreadable header is a corrupt source, not an
        // unsupported one. Let the decoder name it or hand back its real dimensions; anything
        // else (webp, a stray file with a texture extension) is not this pass's to rewrite.
        if (!isPngOrJpeg(input)) return input;
        decoded = await decodeForResize(input, logicalPath);
      }
      const width = decoded?.width ?? stats.width;
      const height = decoded?.height ?? stats.height;
      const normalMap = NORMAL_MAP_BASENAME.test(baseNameOf(logicalPath));
      const cap = resolveTextureMaxSize(
        maxSize,
        [normalMap ? "normalTexture" : "baseColorTexture"],
        Number.POSITIVE_INFINITY,
      );
      const target = cappedSize(width, height, cap);
      if (target.width === width && target.height === height) return input;
      const source = decoded ?? (await decodeForResize(input, logicalPath));
      const data = resampleRgba(
        source.data,
        source.width,
        source.height,
        target.width,
        target.height,
        !normalMap,
      );
      const png = new PNG({ height: target.height, width: target.width });
      png.data = Buffer.from(data);
      return {
        buffer: PNG.sync.write(png),
        entry: { resizedFrom: `${String(width)}x${String(height)}` },
        // Emitted as PNG whatever the source extension was: the manifest records the logical
        // path unchanged and the served output name carries the bytes' real container, so a
        // `.jpg` logical path resolves to a `.png` output the loader sniffs by content.
        outputExtension: ".png",
      };
    },
  };
}

/** PNG signature or JPEG SOI, the two containers the standalone pass sniffs headers for. */
function isPngOrJpeg(bytes: Buffer): boolean {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return true;
  }
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

async function decodeForResize(
  input: Buffer,
  logicalPath: string,
): Promise<{ data: Uint8Array; height: number; width: number }> {
  try {
    return await decodeImageBytes(input, logicalPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `TN_ASSETS_TEXTURE_UNDECODABLE: '${logicalPath}' could not be decoded to apply its size cap: ${detail}`,
    );
  }
}

function resizeForEncoding(
  decoded: { data: Uint8Array; height: number; width: number },
  normalMap: boolean,
  maxSize: number | undefined,
): {
  readonly data: Uint8Array;
  readonly resized: boolean;
  readonly target: { readonly height: number; readonly width: number };
} {
  const target =
    maxSize === undefined
      ? { height: decoded.height, width: decoded.width }
      : cappedSize(decoded.width, decoded.height, Math.floor(maxSize / 4) * 4);
  const resized = target.width !== decoded.width || target.height !== decoded.height;
  return {
    data: resized
      ? resampleRgba(
          decoded.data,
          decoded.width,
          decoded.height,
          target.width,
          target.height,
          !normalMap,
        )
      : decoded.data,
    resized,
    target,
  };
}

/**
 * Every codec here transcodes to a 4x4 block format, and WebGPU refuses a compressed texture
 * whose base level is not a whole number of blocks. Basis encodes an unaligned source without
 * complaint and stamps the odd size into the KTX2 header, so the build reports success and the
 * game dies at its first draw call with a GPUValidationError. Padding would move every UV the
 * model was authored against and resampling would silently change the pixels, so neither is the
 * pipeline's to decide. So an automatic cook — the one every project gets with no `assets` block
 * at all — retains the authored bytes and reports `block-size` rather than ending a build over
 * art nobody asked it to compress. A codec named by an override is a request that cannot be
 * honoured: that names the dimension and the block size, and `codec: "none"` is the way to say
 * it out loud.
 */
function unalignedOutcome(
  input: Buffer,
  logicalPath: string,
  codec: Exclude<TextureCodec, "none">,
  explicit: boolean,
  target: { readonly height: number; readonly width: number },
): IAssetPassOutput {
  if (explicit) {
    throw new Error(
      `TN_ASSETS_TEXTURE_BLOCK_SIZE: '${logicalPath}' is ${target.width}x${target.height}, which is not a multiple of the ${BLOCK_SIZE}x${BLOCK_SIZE} block the ${codec} codec transcodes to (${TRANSCODE_TARGETS[codec].join(", ")}); WebGPU rejects such a texture at draw time. Resize the source to a multiple of ${BLOCK_SIZE}, or declare a texture override with codec "none" for it.`,
    );
  }
  // `resizeForEncoding` only ever lands on multiples of four, so an unaligned target is the
  // source's own size and `input` is exactly the bytes and dimensions that were authored.
  return { buffer: input, entry: { compressionSkipped: "block-size" } };
}

interface IChosenCodec {
  readonly codec: TextureCodec;
  /** True when an override named this codec, so the pass may not quietly substitute another. */
  readonly explicit: boolean;
  readonly normalMap: boolean;
  readonly quality: number;
}

function texturePolicy(logicalPath: string, options: ITexturePassOptions): IChosenCodec {
  const normalMap = NORMAL_MAP_BASENAME.test(baseNameOf(logicalPath));
  const fallbackQuality = options.quality ?? DEFAULT_ETC1S_QUALITY;
  const override = matchingOverride(logicalPath, options.overrides);
  if (override !== undefined) {
    return {
      codec: override.codec,
      explicit: true,
      normalMap,
      quality: clampQuality(override.quality ?? fallbackQuality),
    };
  }
  return {
    codec: codecLadder([normalMap ? "normalTexture" : "baseColorTexture"])[0]?.codec ?? "none",
    explicit: false,
    normalMap,
    quality: clampQuality(fallbackQuality),
  };
}

/** The one override that decides a path's codec: the first whose glob matches it. */
function matchingOverride(
  logicalPath: string,
  overrides: readonly ITextureOverride[] | undefined,
): ITextureOverride | undefined {
  return overrides?.find((override) => globMatch(override.glob, logicalPath));
}

function clampQuality(quality: number): number {
  return Math.min(255, Math.max(1, Math.round(quality)));
}

function baseNameOf(logicalPath: string): string {
  const file = logicalPath.replaceAll("\\", "/").split("/").pop() ?? logicalPath;
  const dot = file.lastIndexOf(".");
  return dot <= 0 ? file : file.slice(0, dot);
}
