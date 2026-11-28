import { KHR_SUPERCOMPRESSION_ZSTD, read as readKTX2 } from "ktx-parse";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { decodeBasisKtx2 } from "../src/image-quality.js";
import { encodeToKTX2 } from "../src/ktx2-encoder.js";
import { decodeImageBytes } from "../src/passes/decode-image.js";

/** Distinct colour per 16x16 cell: solid UASTC blocks encode fast and land where they belong. */
function cells(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const cx = x >> 4;
      const cy = y >> 4;
      data[offset] = (cx * 37) & 255;
      data[offset + 1] = (cy * 53) & 255;
      data[offset + 2] = ((cx + cy) * 29) & 255;
      data[offset + 3] = 255;
    }
  return data;
}

function maxRowError(a: Uint8Array, b: Uint8Array, width: number, y0: number, y1: number): number {
  let max = 0;
  for (let i = y0 * width * 4; i < y1 * width * 4; i += 1)
    max = Math.max(max, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return max;
}

const uastc = (data: Uint8Array, width: number, height: number) => ({
  imageDecoder: async () => ({ data, height, width }),
  isUASTC: true,
  isPerceptual: true,
  isSetKTX2SRGBTransferFunc: true,
  needSupercompression: true,
});

/**
 * The bundled WASM32 Basis encoder returns no bytes above 16 Mi texels, but WebGPU's default
 * texture limit is 8192 and real games ship 8192x8192 base colour. UASTC blocks are independent,
 * so an over-cap UASTC source is encoded as full-width strips and their level-0 blocks are joined.
 */
describe("tiled UASTC KTX2 encode", () => {
  it("joins strips into level 0 block-for-block identical to one whole encode", async () => {
    const [width, height] = [128, 96];
    const source = cells(width, height);
    // Varied texels inside each block, so the seam rows are not solid-colour blocks.
    for (let i = 0; i < source.length; i += 4) source[i] = ((source[i] ?? 0) + (i % 61)) & 255;
    const whole = await encodeToKTX2(new Uint8Array([0]), uastc(source, width, height));
    // 32-row strips: seams at y = 32 and y = 64.
    const tiled = await encodeToKTX2(new Uint8Array([0]), {
      ...uastc(source, width, height),
      maxSourceTexels: 64 * 64,
    });
    const container = readKTX2(tiled);
    expect([container.pixelWidth, container.pixelHeight]).toEqual([width, height]);
    expect(container.levelCount).toBe(Math.floor(Math.log2(width)) + 1);
    expect(container.supercompressionScheme).toBe(KHR_SUPERCOMPRESSION_ZSTD);
    const wholePixels = await decodeBasisKtx2(whole, width, height, true);
    const tiledPixels = await decodeBasisKtx2(tiled, width, height, true);
    expect(maxRowError(tiledPixels, wholePixels, width, 0, height)).toBe(0);
    expect(maxRowError(tiledPixels, source, width, 28, 36)).toBeLessThan(48);
  });

  it("cooks 8192x8192 to a full mip chain whose level 0 matches across the strip seam", async () => {
    const size = 8192;
    const source = cells(size, size);
    const encoded = await encodeToKTX2(new Uint8Array([0]), uastc(source, size, size));
    const container = readKTX2(encoded);
    expect([container.pixelWidth, container.pixelHeight]).toEqual([size, size]);
    expect(container.levelCount).toBe(14);
    expect(container.levels).toHaveLength(14);
    const pixels = await decodeBasisKtx2(encoded, size, size, true);
    // Strips are 2048 rows tall; compare the rows straddling the first seam and the last row.
    expect(maxRowError(pixels, source, size, 2040, 2056)).toBeLessThanOrEqual(2);
    expect(maxRowError(pixels, source, size, size - 4, size)).toBeLessThanOrEqual(2);
  }, 300_000);

  it("refuses an over-cap ETC1S source by name, since one global codebook cannot be tiled", async () => {
    const source = cells(128, 64);
    await expect(
      encodeToKTX2(new Uint8Array([0]), {
        ...uastc(source, 128, 64),
        isUASTC: false,
        maxSourceTexels: 64 * 64,
      }),
    ).rejects.toThrow(/TN_ASSETS_KTX2_SOURCE_SIZE: .*ETC1S.*uastc/);
  });
});

describe("decodeImageBytes JPEG", () => {
  it("decodes an 8192x8192 JPEG past jpeg-js's 512 MB default", async () => {
    const jpeg = await sharp({
      create: { background: { b: 40, g: 120, r: 200 }, channels: 3, height: 8192, width: 8192 },
    })
      .jpeg()
      .toBuffer();
    const decoded = await decodeImageBytes(jpeg, "courtyard.glb#texture#0");
    expect([decoded.width, decoded.height]).toEqual([8192, 8192]);
  }, 120_000);
});
