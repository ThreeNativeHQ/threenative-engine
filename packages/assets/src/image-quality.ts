import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { resolveBasisTranscoder } from "./compile.js";
import { decodeAstcKtx2 } from "./ktx2-encoder.js";

// The sculpt MCP math is not present in this repository. Minimal SSIM port: Rec.709
// encoded luma (0..255), non-overlapping 8x8 windows, population moments, equal-window mean.
// Colour error is the pixel mean of CIEDE2000 in sRGB -> D65 Lab; alpha is independent.
export const IMAGE_QUALITY_VERSION = "luma709-ssim8-population-de00-d65-alpha-v1";
export const IMAGE_QUALITY_FLOOR = { ssim: 0.95, meanDeltaE00: 3 } as const;
export interface IImageQualityFloor {
  readonly ssim: number;
  readonly meanDeltaE00: number;
}
export const IMAGE_QUALITY_IDENTITY = {
  version: IMAGE_QUALITY_VERSION,
  floor: IMAGE_QUALITY_FLOOR,
  mip: 0,
  ladder: "smallest-passing-etc1s-rdo3-rdo1-uastc-none-v2",
  rdo: [3, 1],
  zstd: true,
  reference: "same-resolution-pre-encode",
  slotSemantics: "colour-only-data-unvalidated-alpha-coverage-or-exact-v2",
} as const;

export interface IImageQualityOptions {
  readonly floor?: Partial<IImageQualityFloor>;
  readonly slots?: readonly string[];
  readonly alphaThresholds?: readonly number[];
}

export interface IImageQuality {
  readonly version: string;
  readonly width: number;
  readonly height: number;
  readonly ssim: number;
  readonly meanDeltaE00: number | null;
  readonly slots: readonly string[];
  readonly floor: IImageQualityFloor;
  readonly status: "pass" | "below-floor" | "unvalidated-slots";
  readonly alpha: {
    readonly ssim: number;
    readonly meanAbsoluteError: number;
    readonly coverage: readonly {
      readonly threshold: number;
      readonly source: number;
      readonly decoded: number;
      readonly changedPixels: number;
    }[];
  };
}

export interface ITextureQuality extends IImageQuality {
  readonly rung?: string;
  readonly compressionSkipped?: "block-size" | "not-smaller" | "below-floor";
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly codec: string;
}

export function resolveImageQualityFloor(value: unknown = {}): IImageQualityFloor {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("TN_ASSETS_CONFIG_INVALID: texture floor must be an object.");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== "ssim" && key !== "meanDeltaE00"))
    throw new Error("TN_ASSETS_CONFIG_UNKNOWN_KEY: texture floor accepts ssim and meanDeltaE00.");
  const ssim = raw.ssim === undefined ? IMAGE_QUALITY_FLOOR.ssim : raw.ssim;
  const meanDeltaE00 =
    raw.meanDeltaE00 === undefined ? IMAGE_QUALITY_FLOOR.meanDeltaE00 : raw.meanDeltaE00;
  if (
    typeof ssim !== "number" ||
    !Number.isFinite(ssim) ||
    ssim < 0 ||
    ssim > 1 ||
    typeof meanDeltaE00 !== "number" ||
    !Number.isFinite(meanDeltaE00) ||
    meanDeltaE00 < 0
  )
    throw new Error(
      "TN_ASSETS_CONFIG_INVALID: texture floor requires SSIM in [0,1] and non-negative finite meanDeltaE00.",
    );
  return { ssim, meanDeltaE00 };
}

export const COLOUR_SLOTS: ReadonlySet<string> = new Set([
  "baseColorTexture",
  "emissiveTexture",
  "diffuseTexture",
  "specularColorTexture",
  "sheenColorTexture",
]);

function validatePixels(data: Uint8Array, width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isSafeInteger(width * height * 4) ||
    data.length !== width * height * 4
  ) {
    throw new Error(
      "TN_ASSETS_QUALITY_PIXELS: expected nonempty, tight RGBA8 at the comparison resolution.",
    );
  }
}

/** SSIM for one scalar channel sampled from tight RGBA8; includes partial edge windows. */
export function ssim(
  source: Uint8Array,
  decoded: Uint8Array,
  width: number,
  height: number,
  alpha = false,
): number {
  validatePixels(source, width, height);
  validatePixels(decoded, width, height);
  const value = (data: Uint8Array, i: number): number =>
    alpha
      ? (data[i + 3] ?? 0)
      : 0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
  let total = 0;
  let windows = 0;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      let a = 0;
      let b = 0;
      let aa = 0;
      let bb = 0;
      let ab = 0;
      let n = 0;
      for (let yy = y; yy < Math.min(y + 8, height); yy += 1) {
        for (let xx = x; xx < Math.min(x + 8, width); xx += 1) {
          const i = (yy * width + xx) * 4;
          const u = value(source, i);
          const v = value(decoded, i);
          a += u;
          b += v;
          aa += u * u;
          bb += v * v;
          ab += u * v;
          n += 1;
        }
      }
      a /= n;
      b /= n;
      const va = Math.max(0, aa / n - a * a);
      const vb = Math.max(0, bb / n - b * b);
      total +=
        ((2 * a * b + c1) * (2 * (ab / n - a * b) + c2)) / ((a * a + b * b + c1) * (va + vb + c2));
      windows += 1;
    }
  }
  return Math.max(-1, Math.min(1, total / windows));
}

type Lab = readonly [number, number, number];
const radians = (angle: number): number => (angle * Math.PI) / 180;

/** CIEDE2000, unit weighting factors, on D65 CIELAB triples. */
export function deltaE00(first: Lab, second: Lab): number {
  if (![...first, ...second].every(Number.isFinite))
    throw new Error("TN_ASSETS_QUALITY_LAB: non-finite Lab.");
  const [l1, a1, b1] = first;
  const [l2, a2, b2] = second;
  const c = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(c ** 7 / (c ** 7 + 25 ** 7)));
  const ap1 = (1 + g) * a1;
  const ap2 = (1 + g) * a2;
  const cp1 = Math.hypot(ap1, b1);
  const cp2 = Math.hypot(ap2, b2);
  const hue = (a: number, b: number): number => ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  const h1 = hue(ap1, b1);
  const h2 = hue(ap2, b2);
  let dh = h2 - h1;
  if (cp1 * cp2 === 0) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dl = l2 - l1;
  const dc = cp2 - cp1;
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin(radians(dh / 2));
  const lp = (l1 + l2) / 2;
  const cp = (cp1 + cp2) / 2;
  let hp = (h1 + h2) / 2;
  if (cp1 * cp2 === 0) hp = h1 + h2;
  else if (Math.abs(h1 - h2) > 180) hp += h1 + h2 < 360 ? 180 : -180;
  const t =
    1 -
    0.17 * Math.cos(radians(hp - 30)) +
    0.24 * Math.cos(radians(2 * hp)) +
    0.32 * Math.cos(radians(3 * hp + 6)) -
    0.2 * Math.cos(radians(4 * hp - 63));
  const sl = 1 + (0.015 * (lp - 50) ** 2) / Math.sqrt(20 + (lp - 50) ** 2);
  const sc = 1 + 0.045 * cp;
  const sh = 1 + 0.015 * cp * t;
  const rt =
    -2 *
    Math.sqrt(cp ** 7 / (cp ** 7 + 25 ** 7)) *
    Math.sin(radians(60 * Math.exp(-(((hp - 275) / 25) ** 2))));
  return Math.sqrt(
    Math.max(0, (dl / sl) ** 2 + (dc / sc) ** 2 + (dH / sh) ** 2 + rt * (dc / sc) * (dH / sh)),
  );
}

const LINEAR = Float64Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

function lab(data: Uint8Array, i: number): Lab {
  const r = LINEAR[data[i] ?? 0] ?? 0;
  const g = LINEAR[data[i + 1] ?? 0] ?? 0;
  const b = LINEAR[data[i + 2] ?? 0] ?? 0;
  const f = (v: number): number =>
    v > (6 / 29) ** 3 ? Math.cbrt(v) : v / (3 * (6 / 29) ** 2) + 4 / 29;
  const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function imageQuality(
  source: Uint8Array,
  decoded: Uint8Array,
  width: number,
  height: number,
  options: IImageQualityOptions = {},
): IImageQuality {
  validatePixels(source, width, height);
  validatePixels(decoded, width, height);
  const slots = [...new Set(options.slots ?? ["baseColorTexture"])].sort();
  const floor = resolveImageQualityFloor(options.floor);
  const colour = slots.some((slot) => COLOUR_SLOTS.has(slot));
  const unvalidated = slots.length === 0 || slots.some((slot) => !COLOUR_SLOTS.has(slot));
  const coverage = [...new Set(options.alphaThresholds ?? [])]
    .sort((a, b) => a - b)
    .map((threshold) => {
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
        throw new Error("TN_ASSETS_QUALITY_ALPHA: threshold must be in [0,1].");
      return { threshold, source: 0, decoded: 0, changedPixels: 0 };
    });
  let de = 0;
  let alphaError = 0;
  for (let i = 0; i < source.length; i += 4) {
    if (
      colour &&
      (source[i] !== decoded[i] ||
        source[i + 1] !== decoded[i + 1] ||
        source[i + 2] !== decoded[i + 2])
    )
      de += deltaE00(lab(source, i), lab(decoded, i));
    const a = (source[i + 3] ?? 0) / 255;
    const b = (decoded[i + 3] ?? 0) / 255;
    alphaError += Math.abs(a - b);
    for (const row of coverage) {
      const before = a >= row.threshold;
      const after = b >= row.threshold;
      row.source += Number(before);
      row.decoded += Number(after);
      row.changedPixels += Number(before !== after);
    }
  }
  const score = source === decoded ? 1 : ssim(source, decoded, width, height);
  const alphaSsim = source === decoded ? 1 : ssim(source, decoded, width, height, true);
  const meanDeltaE00 = colour ? de / (width * height) : null;
  const failed =
    (colour && (score < floor.ssim || (meanDeltaE00 ?? 0) > floor.meanDeltaE00)) ||
    alphaSsim < floor.ssim ||
    coverage.some((row) => row.changedPixels !== 0);
  return {
    version: IMAGE_QUALITY_VERSION,
    width,
    height,
    ssim: score,
    meanDeltaE00,
    slots,
    floor,
    status: failed ? "below-floor" : unvalidated ? "unvalidated-slots" : "pass",
    alpha: { ssim: alphaSsim, meanAbsoluteError: alphaError / (width * height), coverage },
  };
}

interface IBasisFile {
  close(): void;
  delete(): void;
  isValid(): boolean;
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
  readonly KTX2File: new (bytes: Uint8Array) => IBasisFile;
  initializeBasis(): void;
  readonly transcoder_texture_format: {
    readonly cTFRGBA32: { readonly value: number };
    readonly cTFASTC_4x4_RGBA: { readonly value: number };
  };
}
let basisPromise: Promise<IBasisModule> | undefined;

async function basisModule(): Promise<IBasisModule> {
  basisPromise ??= (async () => {
    const paths = resolveBasisTranscoder(path.dirname(fileURLToPath(import.meta.url)));
    const directory = path.dirname(paths.javascriptPath);
    const shim: { exports: unknown } = { exports: {} };
    // Three ships CommonJS inside an ESM package; use the runtime's standalone factory.
    new Function(
      "module",
      "exports",
      "require",
      "__filename",
      "__dirname",
      await readFile(paths.javascriptPath, "utf8"),
    )(shim, shim.exports, createRequire(import.meta.url), paths.javascriptPath, directory);
    const factory = shim.exports as (options: { wasmBinary: Uint8Array }) => Promise<IBasisModule>;
    const basis = await factory({ wasmBinary: await readFile(paths.wasmPath) });
    basis.initializeBasis();
    return basis;
  })();
  return basisPromise;
}

/** Cook the measured Basis result to decoder-free ASTC without re-encoding its pixels. */
export async function transcodeKtx2ToAstc(
  encoded: Uint8Array,
  gltfColorPrimaries?: 0 | 1,
): Promise<Uint8Array> {
  const container = readKTX2(encoded);
  const descriptor = container.dataFormatDescriptor[0];
  if (
    gltfColorPrimaries !== undefined &&
    ((gltfColorPrimaries !== 0 && gltfColorPrimaries !== 1) ||
      descriptor?.transferFunction !==
        (gltfColorPrimaries === 0 ? KHR_DF_TRANSFER_LINEAR : KHR_DF_TRANSFER_SRGB))
  )
    throw new Error("TN_ASSETS_ASTC_METADATA: explicit glTF primaries must be 0/linear or 1/sRGB.");
  if (
    container.vkFormat !== 0 ||
    container.pixelWidth <= 0 ||
    container.pixelHeight <= 0 ||
    container.pixelDepth !== 0 ||
    container.layerCount !== 0 ||
    container.faceCount !== 1 ||
    container.levelCount !==
      Math.floor(Math.log2(Math.max(container.pixelWidth, container.pixelHeight))) + 1 ||
    descriptor === undefined
  )
    throw new Error("TN_ASSETS_ASTC_INPUT: expected a 2D Basis KTX2 with its full mip chain.");
  const basis = await basisModule();
  const file = new basis.KTX2File(encoded);
  try {
    if (!file.isValid() || !file.startTranscoding() || file.getLevels() !== container.levelCount)
      throw new Error("TN_ASSETS_ASTC_INPUT: the Basis transcoder rejected the cooked texture.");
    const format = basis.transcoder_texture_format.cTFASTC_4x4_RGBA.value;
    container.levels = container.levels.map((_, mip) => {
      const width = Math.max(1, container.pixelWidth >> mip);
      const height = Math.max(1, container.pixelHeight >> mip);
      const bytes = Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
      const levelData = new Uint8Array(bytes);
      if (
        file.getImageTranscodedSizeInBytes(mip, 0, 0, format) !== bytes ||
        !file.transcodeImage(levelData, mip, 0, 0, format, 0, -1, -1)
      )
        throw new Error(
          `TN_ASSETS_ASTC_TRANSCODE: mip ${String(mip)} could not transcode to ASTC 4x4.`,
        );
      return { levelData, uncompressedByteLength: bytes };
    });
    container.vkFormat =
      descriptor.transferFunction === KHR_DF_TRANSFER_SRGB
        ? VK_FORMAT_ASTC_4x4_SRGB_BLOCK
        : VK_FORMAT_ASTC_4x4_UNORM_BLOCK;
    container.supercompressionScheme = KHR_SUPERCOMPRESSION_NONE;
    container.globalData = null;
    container.dataFormatDescriptor = [
      {
        ...descriptor,
        ...(gltfColorPrimaries === undefined ? {} : { colorPrimaries: gltfColorPrimaries }),
        colorModel: KHR_DF_MODEL_ASTC,
        texelBlockDimension: [3, 3, 0, 0],
        bytesPlane: [16, 0, 0, 0, 0, 0, 0, 0],
        samples: [
          {
            bitOffset: 0,
            bitLength: 127,
            channelType: 0,
            samplePosition: [0, 0, 0, 0],
            sampleLower: 0,
            sampleUpper: 0xffffffff,
          },
        ],
      },
    ];
    return writeKTX2(container);
  } finally {
    file.close();
    file.delete();
  }
}

/** Score final mip zero; raw ASTC also validates and decodes every emitted mip. */
export async function measureKtx2(
  source: Uint8Array,
  encoded: Uint8Array,
  width: number,
  height: number,
  options: IImageQualityOptions = {},
): Promise<IImageQuality> {
  validatePixels(source, width, height);
  if (readKTX2(encoded).vkFormat !== 0)
    return imageQuality(
      source,
      await decodeAstcKtx2(encoded, width, height),
      width,
      height,
      options,
    );
  return imageQuality(
    source,
    await decodeBasisKtx2(encoded, width, height),
    width,
    height,
    options,
  );
}

/** Internal authored-Basis baseline; the pre-Basis source pixels are unavailable. */
export async function decodeBasisKtx2(
  encoded: Uint8Array,
  width: number,
  height: number,
  fullMipChain = false,
): Promise<Uint8Array> {
  const container = readKTX2(encoded);
  if (
    fullMipChain &&
    (container.vkFormat !== 0 ||
      container.pixelDepth !== 0 ||
      container.layerCount !== 0 ||
      container.faceCount !== 1 ||
      container.levelCount !== Math.floor(Math.log2(Math.max(width, height))) + 1)
  )
    throw new Error("TN_ASSETS_QUALITY_DECODE: expected full-mip 2D Basis KTX2.");
  const basis = await basisModule();
  const file = new basis.KTX2File(encoded);
  try {
    if (
      !file.isValid() ||
      file.getWidth() !== width ||
      file.getHeight() !== height ||
      !file.startTranscoding() ||
      (fullMipChain && file.getLevels() !== container.levelCount)
    ) {
      throw new Error("TN_ASSETS_QUALITY_DECODE: invalid KTX2 or comparison dimensions.");
    }
    const format = basis.transcoder_texture_format.cTFRGBA32.value;
    if (file.getImageTranscodedSizeInBytes(0, 0, 0, format) !== width * height * 4)
      throw new Error("TN_ASSETS_QUALITY_DECODE: invalid RGBA32 byte length.");
    const decoded = new Uint8Array(width * height * 4);
    if (!file.transcodeImage(decoded, 0, 0, 0, format, 0, -1, -1))
      throw new Error("TN_ASSETS_QUALITY_DECODE: mip zero RGBA32 transcode failed.");
    if (fullMipChain) {
      for (let mip = 1; mip < file.getLevels(); mip += 1) {
        const bytes = Math.max(1, width >> mip) * Math.max(1, height >> mip) * 4;
        if (
          file.getImageTranscodedSizeInBytes(mip, 0, 0, format) !== bytes ||
          !file.transcodeImage(new Uint8Array(bytes), mip, 0, 0, format, 0, -1, -1)
        )
          throw new Error("TN_ASSETS_QUALITY_DECODE: authored Basis mip RGBA32 transcode failed.");
      }
    }
    return decoded;
  } finally {
    file.close();
    file.delete();
  }
}

/** A damaged/missing measurement is a cache miss, never a passing observation. */
export function readTextureQuality(value: unknown): ITextureQuality | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as ITextureQuality;
  const positive = (v: unknown): boolean =>
    typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  const bounded = (v: unknown, min: number, max: number): boolean =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
  if (
    row.version !== IMAGE_QUALITY_VERSION ||
    ![row.width, row.height, row.sourceWidth, row.sourceHeight].every(positive) ||
    !bounded(row.ssim, -1, 1) ||
    (row.meanDeltaE00 !== null && !bounded(row.meanDeltaE00, 0, Number.POSITIVE_INFINITY)) ||
    !["pass", "below-floor", "unvalidated-slots"].includes(row.status) ||
    !Array.isArray(row.slots) ||
    !row.slots.every((slot) => typeof slot === "string") ||
    !["uastc", "etc1s", "none"].includes(row.codec) ||
    (row.compressionSkipped !== undefined &&
      !["block-size", "not-smaller", "below-floor"].includes(row.compressionSkipped)) ||
    !bounded(row.floor?.ssim, 0, 1) ||
    !bounded(row.floor?.meanDeltaE00, 0, Number.POSITIVE_INFINITY) ||
    (row.rung !== undefined &&
      !["etc1s@150", "uastc+rdo λ3 +zstd", "uastc+rdo λ1 +zstd", "uastc", "none"].includes(
        row.rung,
      ) &&
      !/^etc1s@\d+$/u.test(row.rung)) ||
    !bounded(row.alpha?.ssim, -1, 1) ||
    !bounded(row.alpha?.meanAbsoluteError, 0, 1) ||
    !Array.isArray(row.alpha?.coverage) ||
    !row.alpha.coverage.every(
      (c) =>
        c !== null &&
        typeof c === "object" &&
        bounded(c.threshold, 0, 1) &&
        [c.source, c.decoded, c.changedPixels].every(
          (v) => Number.isSafeInteger(v) && v >= 0 && v <= row.width * row.height,
        ),
    )
  )
    return undefined;
  return row;
}
