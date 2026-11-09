import { describe, expect, it } from "vitest";
import {
  type IKtx2LevelIndex,
  ktx2HeaderBytes,
  mipRangesToFetch,
  parseKtx2LevelIndex,
  wantedMipLevels,
} from "../src/texture-streaming.js";

const KTX2_IDENTIFIER = [
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
] as const;

const VK_FORMAT_BC7_UNORM_BLOCK = 145;

interface ILevelFixture {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly uncompressedByteLength: number;
}

/** Writes a KTX2 header + level index the way the Khronos spec lays it out, nothing behind it. */
function buildKtx2(
  levels: readonly ILevelFixture[],
  declaredLevelCount = levels.length,
): Uint8Array {
  const bytes = new Uint8Array(ktx2HeaderBytes(declaredLevelCount));
  bytes.set(KTX2_IDENTIFIER, 0);
  const view = new DataView(bytes.buffer);
  // vkFormat, typeSize, width, height, depth, layers, faces, levelCount, supercompression.
  const header = [VK_FORMAT_BC7_UNORM_BLOCK, 1, 1024, 512, 0, 1, 1, declaredLevelCount, 0] as const;
  let at = 12;
  for (const value of header) {
    view.setUint32(at, value, true);
    at += 4;
  }
  // dfdByteOffset, dfdByteLength, kvdByteOffset, kvdByteLength.
  for (const value of [0, 0, 0, 0]) {
    view.setUint32(at, value, true);
    at += 4;
  }
  // sgdByteOffset, sgdByteLength.
  for (const value of [688_128n, 96n]) {
    view.setBigUint64(at, value, true);
    at += 8;
  }
  for (const level of levels) {
    view.setBigUint64(at, BigInt(level.byteOffset), true);
    view.setBigUint64(at + 8, BigInt(level.byteLength), true);
    view.setBigUint64(at + 16, BigInt(level.uncompressedByteLength), true);
    at += 24;
  }
  return bytes;
}

// A 1024x512 image with three mips: 512 KiB, 128 KiB, 32 KiB, laid out largest first.
const THREE_LEVELS: readonly ILevelFixture[] = [
  { byteOffset: 0, byteLength: 524_288, uncompressedByteLength: 524_288 },
  { byteOffset: 524_288, byteLength: 131_072, uncompressedByteLength: 131_072 },
  { byteOffset: 655_360, byteLength: 32_768, uncompressedByteLength: 32_768 },
];

function parsed(levels: readonly ILevelFixture[] = THREE_LEVELS): IKtx2LevelIndex {
  return parseKtx2LevelIndex(buildKtx2(levels));
}

describe("ktx2HeaderBytes", () => {
  it("is 80 bytes of header and index plus 24 per level, with 0 counting as one", () => {
    expect(ktx2HeaderBytes(0)).toBe(104);
    expect(ktx2HeaderBytes(1)).toBe(104);
    expect(ktx2HeaderBytes(3)).toBe(152);
  });
});

describe("parseKtx2LevelIndex", () => {
  it("reads the header and all three level index entries", () => {
    const index = parsed();
    expect(index).toMatchObject({
      vkFormat: VK_FORMAT_BC7_UNORM_BLOCK,
      typeSize: 1,
      pixelWidth: 1024,
      pixelHeight: 512,
      pixelDepth: 0,
      layerCount: 1,
      faceCount: 1,
      levelCount: 3,
      supercompressionScheme: 0,
      sgdByteOffset: 688_128,
      sgdByteLength: 96,
    });
    expect(index.levels).toEqual([
      { byteOffset: 0, byteLength: 524_288, uncompressedByteLength: 524_288 },
      { byteOffset: 524_288, byteLength: 131_072, uncompressedByteLength: 131_072 },
      { byteOffset: 655_360, byteLength: 32_768, uncompressedByteLength: 32_768 },
    ]);
    // Level 0 is the largest mip and the last one is the 1x1, so sizes never grow.
    expect(index.levels[0]?.byteLength).toBeGreaterThan(index.levels[2]?.byteLength as number);
  });

  it("treats a declared levelCount of 0 as one level", () => {
    const index = parseKtx2LevelIndex(buildKtx2([THREE_LEVELS[2] as ILevelFixture], 0));
    expect(index.levelCount).toBe(1);
    expect(index.levels).toEqual([
      { byteOffset: 655_360, byteLength: 32_768, uncompressedByteLength: 32_768 },
    ]);
  });

  it("reads only the part of the buffer it was given", () => {
    // A slice of a larger buffer: the DataView must honour byteOffset, not assume a zero-based one.
    const padded = new Uint8Array(buildKtx2(THREE_LEVELS).byteLength + 16);
    padded.set(buildKtx2(THREE_LEVELS), 16);
    const index = parseKtx2LevelIndex(padded.subarray(16));
    expect(index.pixelWidth).toBe(1024);
    expect(index.levels).toHaveLength(3);
  });

  it("rejects a wrong identifier", () => {
    const bytes = buildKtx2(THREE_LEVELS);
    bytes[0] = 0x4b;
    expect(() => parseKtx2LevelIndex(bytes)).toThrow(/^TN_KTX2_HEADER:/);
  });

  it("rejects a buffer truncated inside the level index", () => {
    const bytes = buildKtx2(THREE_LEVELS);
    expect(() => parseKtx2LevelIndex(bytes.slice(0, 80 + 24 * 3 - 1))).toThrow(/^TN_KTX2_HEADER:/);
    expect(() => parseKtx2LevelIndex(bytes.slice(0, 80))).toThrow(/^TN_KTX2_HEADER:/);
    expect(() => parseKtx2LevelIndex(new Uint8Array(4))).toThrow(/^TN_KTX2_HEADER:/);
  });

  it("rejects a u64 above Number.MAX_SAFE_INTEGER", () => {
    const bytes = buildKtx2(THREE_LEVELS);
    new DataView(bytes.buffer).setBigUint64(80, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true);
    expect(() => parseKtx2LevelIndex(bytes)).toThrow(/^TN_KTX2_HEADER:/);
  });
});

describe("wantedMipLevels", () => {
  it("keeps the 1x1 mip for a one-pixel covering", () => {
    expect(wantedMipLevels(1, 12)).toBe(1);
  });

  it("follows Unreal's ceil(1 + log2(size)) rule across a doubling", () => {
    // StreamingTexture.cpp:309 — 256 px covers 2**8 texels, so 9 mips are worth keeping.
    expect(wantedMipLevels(256, 12)).toBe(9);
    expect(wantedMipLevels(255, 12)).toBe(9);
    expect(wantedMipLevels(257, 12)).toBe(10);
    expect(wantedMipLevels(512, 12)).toBe(10);
  });

  it("clamps to the mips the file actually holds", () => {
    expect(wantedMipLevels(1024, 8)).toBe(8);
    expect(wantedMipLevels(16_384, 3)).toBe(3);
  });

  it("clamps up to minResidentLevels and never above the level count", () => {
    expect(wantedMipLevels(4, 12, 6)).toBe(6);
    expect(wantedMipLevels(1024, 8, 8)).toBe(8);
    // A floor above the file's level count cannot be honoured for a file that does not have it.
    expect(wantedMipLevels(1, 2, 9)).toBe(2);
  });

  it("keeps the whole chain when the screen size is not a number", () => {
    expect(wantedMipLevels(Number.NaN, 12)).toBe(12);
    expect(wantedMipLevels(Number.POSITIVE_INFINITY, 7)).toBe(7);
  });
});

describe("mipRangesToFetch", () => {
  it("fetches coarse before fine, one range per missing mip, end exclusive", () => {
    const ranges = mipRangesToFetch(parsed(), 1, 3);
    expect(ranges).toEqual([
      { level: 1, start: 524_288, end: 655_360 },
      { level: 0, start: 0, end: 524_288 },
    ]);
    expect(ranges.map((range) => range.level)).toEqual([1, 0]);
  });

  it("fetches only what is missing when some mips are already resident", () => {
    expect(mipRangesToFetch(parsed(), 2, 3)).toEqual([{ level: 0, start: 0, end: 524_288 }]);
  });

  it("fetches nothing when the wanted levels are already resident", () => {
    expect(mipRangesToFetch(parsed(), 2, 2)).toEqual([]);
    expect(mipRangesToFetch(parsed(), 3, 1)).toEqual([]);
  });

  it("clamps a want beyond the file to the mips it has", () => {
    expect(mipRangesToFetch(parsed(), 0, 9).map((range) => range.level)).toEqual([2, 1, 0]);
  });
});
