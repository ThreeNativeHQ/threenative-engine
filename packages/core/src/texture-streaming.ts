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

/** The first read of a streamed file: the header, level index and metadata, and usually the tail too. */
const KTX2_PROBE_BYTES = 64 * 1024;
/** Mips at or below this side stay resident from the first read (Unreal keeps a mip tail, `TextureDerivedData.cpp:2658`). */
const KTX2_TAIL_MAX_PX = 64;
/** Level data alignment in a rebuilt file: a multiple of every block size (8, 16) and lcm(texel, 4) (4, 8, 12, 16). */
const KTX2_LEVEL_ALIGN = 48;
const BASISLZ = 1;
const BASISLZ_SGD_HEADER_BYTES = 20;
const BASISLZ_IMAGE_DESC_BYTES = 20;

/** A KTX2 file read by `Range`, coarse mips first. */
export interface IKtx2Stream {
  readonly index: IKtx2LevelIndex;
  /** Mip levels on hand, counted from the smallest; `index.levelCount` once the file is whole. */
  readonly residentLevels: number;
  /** False when the host ignored `Range` and sent the whole file, which then stays whole. */
  readonly ranged: boolean;
  /** Bytes read from the host so far. */
  readonly bytesRead: number;
  /** A complete KTX2 file of the resident levels, which any KTX2 decoder takes as it is. */
  file(): Uint8Array;
  /** Reads levels until `levels` are resident. The new file, or undefined when nothing was missing. */
  want(levels: number): Promise<Uint8Array | undefined>;
}

/** The fetch a stream reads through; `globalThis.fetch` by default. */
export type RangeFetch = (url: string, init: RequestInit) => Promise<Response>;

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

/** The BasisLZ global data for the levels from `first` on: one image descriptor per kept image. */
function trimBasisLzGlobalData(sgd: Uint8Array, index: IKtx2LevelIndex, first: number): Uint8Array {
  const images = (level: number) =>
    Math.max(1, index.layerCount) * index.faceCount * Math.max(1, index.pixelDepth >> level);
  let dropped = 0;
  for (let level = 0; level < first; level += 1) dropped += images(level);
  let total = dropped;
  for (let level = first; level < index.levelCount; level += 1) total += images(level);
  const descs = BASISLZ_SGD_HEADER_BYTES;
  const rest = descs + total * BASISLZ_IMAGE_DESC_BYTES;
  if (sgd.byteLength < rest)
    throw headerFailure(
      `BasisLZ global data is ${String(sgd.byteLength)} bytes, ${String(rest)} needed`,
    );
  const out = new Uint8Array(sgd.byteLength - dropped * BASISLZ_IMAGE_DESC_BYTES);
  out.set(sgd.subarray(0, descs));
  out.set(sgd.subarray(descs + dropped * BASISLZ_IMAGE_DESC_BYTES), descs);
  return out;
}

/**
 * A KTX2 file of the levels from `first` (the finest kept) to the 1x1, from the bytes of a file read
 * up to them: the header names the smaller base size, the level index the moved data, and the
 * descriptor, key/value and BasisLZ global data come along.
 */
function trimmedKtx2(src: Uint8Array, index: IKtx2LevelIndex, first: number): Uint8Array {
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const slice = (offset: number, length: number) => src.subarray(offset, offset + length);
  const dfd = slice(view.getUint32(48, true), view.getUint32(52, true));
  const kvd = slice(view.getUint32(56, true), view.getUint32(60, true));
  let sgd = slice(index.sgdByteOffset, index.sgdByteLength);
  if (index.supercompressionScheme === BASISLZ && sgd.byteLength > 0)
    sgd = trimBasisLzGlobalData(sgd, index, first);
  const kept = index.levels.slice(first);
  const dfdAt = ktx2HeaderBytes(kept.length);
  const kvdAt = dfdAt + dfd.byteLength;
  const sgdAt = alignUp(kvdAt + kvd.byteLength, 8);
  // Smallest level first, as the KTX2 spec stores them.
  const placed: number[] = [];
  let end = sgdAt + sgd.byteLength;
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    const at = alignUp(end, KTX2_LEVEL_ALIGN);
    placed[i] = at;
    end = at + (kept[i]?.byteLength ?? 0);
  }
  const out = new Uint8Array(end);
  const write = new DataView(out.buffer);
  out.set(src.subarray(0, 48));
  write.setUint32(20, Math.max(1, index.pixelWidth >> first), true);
  if (index.pixelHeight > 0) write.setUint32(24, Math.max(1, index.pixelHeight >> first), true);
  if (index.pixelDepth > 0) write.setUint32(28, Math.max(1, index.pixelDepth >> first), true);
  write.setUint32(40, kept.length, true);
  write.setUint32(48, dfd.byteLength > 0 ? dfdAt : 0, true);
  write.setUint32(52, dfd.byteLength, true);
  write.setUint32(56, kvd.byteLength > 0 ? kvdAt : 0, true);
  write.setUint32(60, kvd.byteLength, true);
  write.setBigUint64(64, BigInt(sgd.byteLength > 0 ? sgdAt : 0), true);
  write.setBigUint64(72, BigInt(sgd.byteLength), true);
  out.set(dfd, dfdAt);
  out.set(kvd, kvdAt);
  out.set(sgd, sgdAt);
  kept.forEach((level, i) => {
    const at = KTX2_INDEX_BYTES + i * KTX2_LEVEL_ENTRY_BYTES;
    write.setBigUint64(at, BigInt(placed[i] ?? 0), true);
    write.setBigUint64(at + 8, BigInt(level.byteLength), true);
    write.setBigUint64(at + 16, BigInt(level.uncompressedByteLength), true);
    out.set(slice(level.byteOffset, level.byteLength), placed[i]);
  });
  return out;
}

/**
 * Opens a KTX2 file for mip streaming: one `Range` read takes the header, metadata and the mip tail
 * (levels of 64 px or less, at least the 1x1), and `want` reads finer levels later, coarse first. The
 * KTX2 spec stores levels smallest first, so the bytes on hand are always one prefix of the file. A
 * host that answers 200 sent the whole file, which is kept whole: nothing is fetched twice.
 */
export async function openKtx2Stream(
  url: string,
  fetchRange: RangeFetch = (target, init) => fetch(target, init),
): Promise<IKtx2Stream> {
  let have = new Uint8Array(0);
  let ranged = true;
  let bytesRead = 0;
  const readTo = async (end: number): Promise<void> => {
    if (!ranged || end <= have.byteLength) return;
    const start = have.byteLength;
    const response = await fetchRange(url, {
      headers: { range: `bytes=${String(start)}-${String(end - 1)}` },
    });
    if (!response.ok)
      throw new Error(`TN_KTX2_FETCH: '${url}' answered ${String(response.status)}`);
    const body = new Uint8Array(await response.arrayBuffer());
    bytesRead += body.byteLength;
    if (response.status !== 206) {
      have = body;
      ranged = false;
      return;
    }
    const from = /^bytes (\d+)-/u.exec(response.headers.get("content-range") ?? "")?.[1];
    if (from !== undefined && Number(from) !== start)
      throw new Error(
        `TN_KTX2_FETCH: '${url}' answered bytes from ${from}, ${String(start)} asked`,
      );
    const next = new Uint8Array(start + body.byteLength);
    next.set(have);
    next.set(body, start);
    have = next;
  };
  await readTo(KTX2_PROBE_BYTES);
  const index = parseKtx2LevelIndex(have);
  const { levels } = index;
  const last = levels.length - 1;
  const levelEnd = (level: number) =>
    (levels[level]?.byteOffset ?? 0) + (levels[level]?.byteLength ?? 0);
  // A writer that broke the smallest-first order has no coarse prefix: read the file whole.
  const ordered = levels.every(
    (level, i) => i === last || level.byteOffset > (levels[i + 1]?.byteOffset ?? 0),
  );
  if (!ordered) await readTo(Math.max(...levels.map((_, i) => levelEnd(i))));
  let tail = 1;
  while (
    tail < levels.length &&
    Math.max(index.pixelWidth, index.pixelHeight) >> (levels.length - 1 - tail) <= KTX2_TAIL_MAX_PX
  )
    tail += 1;
  await readTo(levelEnd(levels.length - tail));
  const resident = (): number => {
    if (!ranged) return levels.length;
    let count = 0;
    while (count < levels.length && levelEnd(last - count) <= have.byteLength) count += 1;
    return count;
  };
  const file = (): Uint8Array => {
    const count = resident();
    return count === levels.length && !ranged
      ? have
      : trimmedKtx2(have, index, levels.length - count);
  };
  return {
    index,
    get residentLevels() {
      return resident();
    },
    get ranged() {
      return ranged;
    },
    get bytesRead() {
      return bytesRead;
    },
    file,
    want: async (count) => {
      const target = Math.min(levels.length, Math.max(1, Math.trunc(count)));
      if (target <= resident()) return undefined;
      await readTo(levelEnd(levels.length - target));
      return file();
    },
  };
}
