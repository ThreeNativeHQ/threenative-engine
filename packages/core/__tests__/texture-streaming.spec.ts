// @ts-expect-error three ships ktx-parse without types
import { read as readKtx2 } from "three/examples/jsm/libs/ktx-parse.module.js";
import { describe, expect, it } from "vitest";
import {
  type IKtx2LevelIndex,
  ktx2HeaderBytes,
  openKtx2Stream,
  parseKtx2LevelIndex,
} from "../src/texture-streaming.js";
import { KTX2_IDENTIFIER, VK_FORMAT_BC7_UNORM_BLOCK, wholeKtx2 } from "./support/ktx2.js";

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

/**
 * A whole KTX2 file as the cook writes one: header, level index, descriptor, key/value data, BasisLZ
 * global data (one image descriptor per level, then codebooks) and the levels smallest first. Each
 * level's bytes are its own level number, so a moved level is recognisable.
 */

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

    // Ten levels: one Range read past the bytes on hand.
    const sharper = await stream.want(10);
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

  // Review of #643: a host that answers 206 with fewer bytes than asked left no level to hand on.
  it("refuses by name a short 206 that leaves not even the smallest level", async () => {
    const whole = wholeKtx2(1024, 11, 0);
    const levels = parseKtx2LevelIndex(whole).levels;
    const cap = levels[levels.length - 1]?.byteOffset ?? 0;
    const fetchRange = async (_url: string, init: RequestInit) => {
      const start = Number(
        /^bytes=(\d+)-/u.exec(new Headers(init.headers).get("range") ?? "")?.[1],
      );
      const body = whole.slice(start, Math.max(start, cap));
      return new Response(body, {
        status: 206,
        headers: { "content-range": `bytes ${String(start)}-${String(start + body.byteLength)}/*` },
      });
    };
    const stream = await openKtx2Stream("short.ktx2", fetchRange);
    expect(stream.residentLevels).toBe(0);
    expect(() => stream.file()).toThrow(/TN_KTX2_FETCH: 'short.ktx2' sent \d+ bytes/u);
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
