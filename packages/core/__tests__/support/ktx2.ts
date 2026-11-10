import { ktx2HeaderBytes } from "../../src/texture-streaming.js";

export const KTX2_IDENTIFIER = [
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
] as const;

export const VK_FORMAT_BC7_UNORM_BLOCK = 145;

/** A whole KTX2 file of `levelCount` BC7 levels, each level filled with its own index. */
export function wholeKtx2(side: number, levelCount: number, scheme: 0 | 1): Uint8Array {
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
