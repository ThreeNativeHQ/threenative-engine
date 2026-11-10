// @ts-expect-error three ships ktx-parse without types
import { read as readKtx2 } from "three/examples/jsm/libs/ktx-parse.module.js";
import { describe, expect, it } from "vitest";
import {
  type IKtx2LevelIndex,
  ktx2HeaderBytes,
  mipRangesToFetch,
  openKtx2Stream,
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

/**
 * A whole KTX2 file as the cook writes one: header, level index, descriptor, key/value data, BasisLZ
 * global data (one image descriptor per level, then codebooks) and the levels smallest first. Each
 * level's bytes are its own level number, so a moved level is recognisable.
 */
function wholeKtx2(side: number, levelCount: number, scheme: 0 | 1): Uint8Array {
  // A descriptor of one basic block with one sample: totalSize 44, block size 24 + 16.
  const dfd = new Uint8Array(44);
  const dfdView = new DataView(dfd.buffer);
  dfdView.setUint32(0, 44, true);
  dfdView.setUint16(8, 2, true);
  dfdView.setUint16(10, 40, true);
  dfd[12] = 128; // colorModel: BC7
  // One key/value pair, `KTXwriter` = `tn`, padded to four bytes.
  const pair = new TextEncoder().encode("KTXwriter\0tn\0");
  const kvd = new Uint8Array(Math.ceil((4 + pair.byteLength) / 4) * 4);
  new DataView(kvd.buffer).setUint32(0, pair.byteLength, true);
  kvd.set(pair, 4);
  const sgd = new Uint8Array(scheme === 1 ? 20 + 20 * levelCount + 32 : 0);
  const sgdView = new DataView(sgd.buffer);
  if (scheme === 1) sgdView.setUint32(4, 32, true); // endpointsByteLength: the 32 codebook bytes
  for (let level = 0; level < (scheme === 1 ? levelCount : 0); level += 1)
    sgdView.setUint32(20 + 20 * level + 4, 1000 + level, true); // rgbSliceByteOffset, as a tag
  sgd.fill(0xcb, 20 + 20 * levelCount);
  const sizes = Array.from({ length: levelCount }, (_, level) =>
    Math.max(16, ((side >> level) * (side >> level)) / 4),
  );
  const dfdAt = ktx2HeaderBytes(levelCount);
  const sgdAt = Math.ceil((dfdAt + dfd.byteLength + kvd.byteLength) / 8) * 8;
  const offsets: number[] = [];
  let end = sgdAt + sgd.byteLength;
  for (let level = levelCount - 1; level >= 0; level -= 1) {
    offsets[level] = Math.ceil(end / 16) * 16;
    end = (offsets[level] ?? 0) + (sizes[level] ?? 0);
  }
  const out = new Uint8Array(end);
  const view = new DataView(out.buffer);
  out.set(KTX2_IDENTIFIER, 0);
  [VK_FORMAT_BC7_UNORM_BLOCK, 1, side, side, 0, 1, 1, levelCount, scheme].forEach((value, i) =>
    view.setUint32(12 + 4 * i, value, true),
  );
  [dfdAt, dfd.byteLength, dfdAt + dfd.byteLength, kvd.byteLength].forEach((value, i) =>
    view.setUint32(48 + 4 * i, value, true),
  );
  view.setBigUint64(64, BigInt(sgd.byteLength > 0 ? sgdAt : 0), true);
  view.setBigUint64(72, BigInt(sgd.byteLength), true);
  for (let level = 0; level < levelCount; level += 1) {
    view.setBigUint64(80 + 24 * level, BigInt(offsets[level] ?? 0), true);
    view.setBigUint64(80 + 24 * level + 8, BigInt(sizes[level] ?? 0), true);
    view.setBigUint64(80 + 24 * level + 16, BigInt(sizes[level] ?? 0), true);
    out.fill(level, offsets[level], (offsets[level] ?? 0) + (sizes[level] ?? 0));
  }
  out.set(dfd, dfdAt);
  out.set(kvd, dfdAt + dfd.byteLength);
  out.set(sgd, sgdAt);
  return out;
}

/** A static host serving one file, with or without `Range`, that records each request's range. */
function host(file: Uint8Array, ranges: boolean) {
  const asked: (string | null)[] = [];
  const fetchRange = async (_url: string, init: RequestInit) => {
    const range = new Headers(init.headers).get("range");
    asked.push(range);
    const match = /^bytes=(\d+)-(\d+)$/u.exec(range ?? "");
    if (!ranges || match === null) return new Response(file.slice(), { status: 200 });
    const start = Number(match[1]);
    const end = Math.min(file.byteLength - 1, Number(match[2]));
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: {
        "content-range": `bytes ${String(start)}-${String(end)}/${String(file.byteLength)}`,
      },
    });
  };
  return { asked, fetchRange };
}

/** The part of ktx-parse's result these tests read. */
interface IParsedKtx2 {
  pixelWidth: number;
  levels: { levelData: Uint8Array }[];
  dataFormatDescriptor: unknown;
  keyValue: unknown;
  globalData?: { imageDescs: unknown[] };
}

/** Level `level` of a parsed file, as its bytes. */
function levelBytes(file: Uint8Array, level: number): Uint8Array {
  const entry = parseKtx2LevelIndex(file).levels[level];
  return file.subarray(entry?.byteOffset ?? 0, (entry?.byteOffset ?? 0) + (entry?.byteLength ?? 0));
}

describe("openKtx2Stream", () => {
  it("reads the header and the mip tail first, then finer levels by Range, coarse first", async () => {
    // 4096 px, 13 levels: levels 6..12 (64 px and below) are the tail; level 0 alone is 4 MiB. The
    // 64 KiB first read holds the tail and, here, levels 4 and 5 too: bytes on hand are kept.
    const whole = wholeKtx2(4096, 13, 0);
    const { asked, fetchRange } = host(whole, true);
    const stream = await openKtx2Stream("hull.ktx2", fetchRange);
    expect(stream.ranged).toBe(true);
    expect(stream.residentLevels).toBe(9);
    expect(asked).toEqual(["bytes=0-65535"]);
    expect(stream.bytesRead).toBeLessThan(whole.byteLength / 50);

    // The first upload is a whole KTX2 of those levels: a 256 px base and their own bytes.
    const tail = stream.file();
    const tailIndex = parseKtx2LevelIndex(tail);
    expect(tailIndex).toMatchObject({ pixelWidth: 256, pixelHeight: 256, levelCount: 9 });
    expect(levelBytes(tail, 0)).toEqual(levelBytes(whole, 4));
    expect(levelBytes(tail, 8)).toEqual(levelBytes(whole, 12));

    // A 300 px footprint wants ceil(1 + log2 300) = 10 levels: one Range read past the bytes on hand.
    const sharper = await stream.want(wantedMipLevels(300, 13));
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatch(/^bytes=65536-\d+$/u);
    expect(parseKtx2LevelIndex(sharper as Uint8Array)).toMatchObject({
      pixelWidth: 512,
      levelCount: 10,
    });
    expect(levelBytes(sharper as Uint8Array, 0)).toEqual(levelBytes(whole, 3));
    expect(await stream.want(10)).toBeUndefined();

    const full = (await stream.want(13)) as Uint8Array;
    expect(stream.residentLevels).toBe(13);
    expect(stream.bytesRead).toBe(whole.byteLength);
    for (let level = 0; level < 13; level += 1)
      expect(levelBytes(full, level)).toEqual(levelBytes(whole, level));
  });

  it("keeps the whole file from a host that ignores Range, and reads nothing twice", async () => {
    const whole = wholeKtx2(1024, 11, 0);
    const { asked, fetchRange } = host(whole, false);
    const stream = await openKtx2Stream("deck.ktx2", fetchRange);
    expect(stream.ranged).toBe(false);
    expect(stream.residentLevels).toBe(11);
    expect(stream.file()).toEqual(whole);
    expect(await stream.want(11)).toBeUndefined();
    expect(asked).toHaveLength(1);
  });

  it("keeps the BasisLZ image descriptors of the kept levels, so a partial file transcodes", async () => {
    const whole = wholeKtx2(2048, 12, 1);
    const stream = await openKtx2Stream("flag.ktx2", host(whole, true).fetchRange);
    const tail = parseKtx2LevelIndex(stream.file());
    expect(tail.levelCount).toBe(9);
    const sgd = stream.file().subarray(tail.sgdByteOffset, tail.sgdByteOffset + tail.sgdByteLength);
    const view = new DataView(sgd.buffer, sgd.byteOffset, sgd.byteLength);
    // Levels 3..11 of the source: their descriptors, in order, then the codebooks untouched.
    expect(Array.from({ length: 9 }, (_, i) => view.getUint32(20 + 20 * i + 4, true))).toEqual([
      1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011,
    ]);
    expect(sgd.byteLength).toBe(20 + 20 * 9 + 32);
    expect(sgd.subarray(20 + 20 * 9).every((byte) => byte === 0xcb)).toBe(true);
  });

  it("rebuilds partial files that three's own KTX2 parser reads, metadata and global data intact", async () => {
    for (const scheme of [0, 1] as const) {
      const whole = wholeKtx2(2048, 12, scheme);
      const stream = await openKtx2Stream("hull.ktx2", host(whole, true).fetchRange);
      const source = readKtx2(whole) as IParsedKtx2;
      for (const file of [stream.file(), (await stream.want(11)) as Uint8Array]) {
        const parsed = readKtx2(file) as IParsedKtx2;
        const first = 12 - parsed.levels.length;
        expect(parsed.pixelWidth).toBe(2048 >> first);
        expect(parsed.dataFormatDescriptor).toEqual(source.dataFormatDescriptor);
        expect(parsed.keyValue).toEqual(source.keyValue);
        parsed.levels.forEach((level, i) =>
          expect(level.levelData).toEqual(source.levels[first + i]?.levelData),
        );
        if (scheme === 1)
          expect(parsed.globalData?.imageDescs).toEqual(source.globalData?.imageDescs.slice(first));
      }
    }
  });

  it("names a host that answers Range from the wrong offset", async () => {
    const whole = wholeKtx2(4096, 13, 0);
    const lying = async () =>
      new Response(whole.slice(0, 65536), {
        status: 206,
        headers: { "content-range": `bytes 0-65535/${String(whole.byteLength)}` },
      });
    const stream = await openKtx2Stream("hull.ktx2", lying);
    await expect(stream.want(13)).rejects.toThrow("TN_KTX2_FETCH");
  });
});
