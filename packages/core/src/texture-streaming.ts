/**
 * KTX 2.0 mip residency math, pure and container-free: how many mips a screen size can justify
 * (Unreal's `StreamingTexture.cpp` rule) and which byte ranges in the file still have to arrive.
 *
 * The container parser is the KTX 2.0 header (Khronos spec, "KTX 2.0 File Format"):
 *
 *   0   identifier  12 bytes  «KTX 20» \r\n\x1A\n
 *   12  vkFormat            u32   typeSize              u32   pixelWidth   u32
 *   20  pixelHeight         u32   pixelDepth            u32   layerCount   u32
 *   32  faceCount           u32   levelCount            u32   supercompressionScheme u32
 *   48  dfdByteOffset u32, dfdByteLength u32, kvdByteOffset u32, kvdByteLength u32,
 *       sgdByteOffset u64, sgdByteLength u64
 *   80  level index: levelCount entries of { byteOffset u64, byteLength u64, uncompressedByteLength u64 }
 *
 * Level 0 is the largest mip; the last entry is the 1x1. A file that says `levelCount` 0 has one.
 */

const KTX2_IDENTIFIER: readonly number[] = [
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
];

const KTX2_INDEX_BYTES = 80;
const KTX2_LEVEL_ENTRY_BYTES = 24;
const MAX_SAFE_U64 = BigInt(Number.MAX_SAFE_INTEGER);

/** One level index entry: where a mip lives in the file and how big it is once decompressed. */
export interface IKtx2Level {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly uncompressedByteLength: number;
}

/** The header fields streaming needs, plus the level index. `levelCount` is effective: 0 reads as 1. */
export interface IKtx2LevelIndex {
  readonly vkFormat: number;
  readonly typeSize: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly pixelDepth: number;
  readonly layerCount: number;
  readonly faceCount: number;
  readonly levelCount: number;
  readonly supercompressionScheme: number;
  /** BasisLZ (scheme 1) needs this global block to transcode any level, so a range stream fetches it with the header. */
  readonly sgdByteOffset: number;
  readonly sgdByteLength: number;
  readonly levels: readonly IKtx2Level[];
}

function headerFailure(reason: string): Error {
  return new Error(`TN_KTX2_HEADER: ${reason}`);
}

/** The level index entry count a file declares: 0 means one mip, never zero. */
function levelEntryCount(levelCount: number): number {
  return Number.isFinite(levelCount) ? Math.max(1, Math.trunc(levelCount)) : 1;
}

/** Byte length of the header plus level index for a file declaring `levelCount` mips. */
export function ktx2HeaderBytes(levelCount: number): number {
  return KTX2_INDEX_BYTES + KTX2_LEVEL_ENTRY_BYTES * levelEntryCount(levelCount);
}

function readU64(view: DataView, offset: number, field: string): number {
  const value = view.getBigUint64(offset, true);
  if (value > MAX_SAFE_U64) {
    throw headerFailure(`${field} is ${value.toString()}, above Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}

/** Parses a KTX2 header and level index. Throws `TN_KTX2_HEADER: …` on anything malformed. */
export function parseKtx2LevelIndex(bytes: Uint8Array): IKtx2LevelIndex {
  if (bytes.byteLength < KTX2_IDENTIFIER.length) {
    throw headerFailure(
      `buffer is ${String(bytes.byteLength)} bytes, too short for the identifier: ${String(KTX2_IDENTIFIER.length)}`,
    );
  }
  for (let i = 0; i < KTX2_IDENTIFIER.length; i += 1) {
    if (bytes[i] !== KTX2_IDENTIFIER[i]) {
      throw headerFailure(`byte ${String(i)} is not the KTX 2.0 identifier`);
    }
  }
  if (bytes.byteLength < KTX2_INDEX_BYTES) {
    throw headerFailure(
      `buffer is ${String(bytes.byteLength)} bytes, too short for the 80-byte header and index`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const levelCount = levelEntryCount(view.getUint32(40, true));
  const required = ktx2HeaderBytes(levelCount);
  if (bytes.byteLength < required) {
    throw headerFailure(
      `buffer is ${String(bytes.byteLength)} bytes, ${String(levelCount)} level(s) need ${String(required)}`,
    );
  }

  const levels: IKtx2Level[] = [];
  for (let level = 0; level < levelCount; level += 1) {
    const at = KTX2_INDEX_BYTES + level * KTX2_LEVEL_ENTRY_BYTES;
    levels.push({
      byteOffset: readU64(view, at, `level ${String(level)} byteOffset`),
      byteLength: readU64(view, at + 8, `level ${String(level)} byteLength`),
      uncompressedByteLength: readU64(
        view,
        at + 16,
        `level ${String(level)} uncompressedByteLength`,
      ),
    });
  }

  return {
    vkFormat: view.getUint32(12, true),
    typeSize: view.getUint32(16, true),
    pixelWidth: view.getUint32(20, true),
    pixelHeight: view.getUint32(24, true),
    pixelDepth: view.getUint32(28, true),
    layerCount: view.getUint32(32, true),
    faceCount: view.getUint32(36, true),
    levelCount,
    supercompressionScheme: view.getUint32(44, true),
    sgdByteOffset: readU64(view, 64, "sgdByteOffset"),
    sgdByteLength: readU64(view, 72, "sgdByteLength"),
    levels,
  };
}

/**
 * Resident mip levels worth having for a texture covering `screenSizePx`, by Unreal's rule
 * (`StreamingTexture.cpp:309`): `ceil(1 + log2(size))`, one level per doubling. Reads as "keep the
 * mips until a texel covers about a pixel". A non-finite size cannot be measured, so the whole
 * chain stays resident and the caller falls back to the file's own resolution.
 */
export function wantedMipLevels(
  screenSizePx: number,
  levelCount: number,
  minResidentLevels = 1,
): number {
  const levels = levelEntryCount(levelCount);
  if (!Number.isFinite(screenSizePx)) return levels;
  const wanted = Math.ceil(1 + Math.log2(Math.max(1, screenSizePx)));
  const floor = Number.isFinite(minResidentLevels) ? Math.max(0, Math.trunc(minResidentLevels)) : 1;
  // Upper clamp last: residency is never reported above the mips the file actually holds.
  return Math.min(levels, Math.max(floor, wanted));
}

/**
 * Byte ranges still missing to reach `wantedLevels`, smallest mip first — coarse before fine, so
 * each fetch coarsens the whole image in instead of sharpening one corner.
 */
export function mipRangesToFetch(
  index: IKtx2LevelIndex,
  residentLevels: number,
  wantedLevels: number,
): { level: number; start: number; end: number }[] {
  const total = index.levels.length;
  // An unmeasurable count reads as 0: a NaN resident count still fetches the shortfall, a NaN want
  // asks for nothing.
  const clamp = (count: number): number =>
    Math.min(total, Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0);
  const resident = clamp(residentLevels);
  const wanted = clamp(wantedLevels);
  const ranges: { level: number; start: number; end: number }[] = [];
  // Resident levels are the `resident` highest indices (levelCount - resident .. levelCount - 1),
  // so the shortfall is the block just finer than them, walked from its highest index down.
  for (let level = total - resident - 1; level >= total - wanted; level -= 1) {
    const entry = index.levels[level];
    if (entry === undefined) break;
    ranges.push({
      level,
      start: entry.byteOffset,
      end: entry.byteOffset + entry.byteLength,
    });
  }
  return ranges;
}
