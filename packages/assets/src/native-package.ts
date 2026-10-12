import { createHash } from "node:crypto";

/**
 * The writer side of the native cooked package, TNPK v1, specified byte by byte in
 * `packages/runtime-native/src/engine/assets/package.h`. `packages/assets` emits it as an
 * additional output of the cook; the native engine parses it. Little-endian throughout:
 *
 *   0   4   magic "TNPK"
 *   4   4   format version (1)
 *   8   4   entry count
 *   12  4   reserved, 0
 *   16  8   entry table size in bytes; the table starts at 24
 *   24  ... entries, then the entry data at the offsets the entries name.
 *
 * The C++ reference writer in `packages/runtime-native/tests/native-engine/package_writer.h`
 * produces byte-identical output for the same inputs; `native-package.spec.ts` pins that.
 */

export const NATIVE_PACKAGE_NAME = "native/assets.tnpk";
export const NATIVE_PACKAGE_FORMAT_VERSION = 1;
export const NATIVE_PACKAGE_HEADER_SIZE = 24;

/** Entry kinds; mesh, material and scene are reserved and emitted by later phases. */
export const NativeEntryKind = {
  Animation: 5,
  Buffer: 1,
  Material: 4,
  Mesh: 3,
  Scene: 6,
  Texture: 2,
} as const;
export type NativeEntryKind = (typeof NativeEntryKind)[keyof typeof NativeEntryKind];

/** Decoder requirement bits; a package needing one the target lacks is refused before load. */
export const NativeDecoderBits = {
  draco: 1 << 1,
  ktx2: 1 << 2,
  meshopt: 1 << 0,
} as const;

/**
 * TNPK v1's RGBA8Unorm wire code is 18 (originally wgpu-native's enum value). The reader maps
 * this package code to its backend enum and also accepts legacy Dawn-cooked code 22. The wire
 * value stays stable across backends; it must not be replaced with the active backend's enum.
 */
export const WGPU_TEXTURE_FORMAT_RGBA8_UNORM = 18;

/** One entry to write: the hash, offset and table size are derived, never supplied. */
export interface INativePackageEntry {
  readonly data: Uint8Array;
  /** Decoder requirement mask; absent means none. */
  readonly decoders?: number;
  /** Entry indices this entry depends on; absent means none. */
  readonly dependencies?: readonly number[];
  readonly kind: number;
  readonly name: string;
  /**
   * GPU upload size in bytes; the writer defaults it to 0. For a Buffer entry it is the entry's
   * use: 0 is CPU data a decoder reads (any length), above 0 a GPU buffer (4-byte aligned).
   */
  readonly uploadSize?: number;
}

/** One parsed table entry, with its hash as the engine stores it. */
export interface INativePackageEntryRecord {
  readonly decoders: number;
  readonly dependencies: readonly number[];
  readonly hash: Uint8Array;
  readonly kind: number;
  readonly name: string;
  readonly offset: number;
  readonly size: number;
  readonly uploadSize: number;
}

export interface INativePackageManifest {
  readonly entries: readonly INativePackageEntryRecord[];
  readonly version: number;
}

/** The stable refusal codes the C++ reader raises, so a caller can match them exactly. */
export class NativePackageError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "NativePackageError";
    this.code = code;
    this.detail = detail;
  }
}

const MAX_U16 = 0xffff;
const MAX_U32 = 0xffff_ffff;

interface IEncodedNativeEntry {
  readonly data: Uint8Array;
  readonly decoders: number;
  readonly dependencies: readonly number[];
  readonly kind: number;
  readonly name: Buffer;
  readonly uploadSize: number;
}

/**
 * Refuses input the fixed-width fields cannot hold, so nothing is silently truncated: `setUint16`
 * would keep a name's low 16 bits, and an out-of-range index or count would be written as a lie.
 */
function validateEntries(entries: readonly IEncodedNativeEntry[]): void {
  const invalid = (what: string): never => {
    throw new NativePackageError("TN_NATIVE_PACKAGE_INVALID", what);
  };
  for (const [index, entry] of entries.entries()) {
    if (entry.name.length > MAX_U16) {
      invalid(
        `entry ${String(index)} name is ${String(entry.name.length)} bytes; the u16 name length holds at most ${String(MAX_U16)}`,
      );
    }
    if (!Number.isInteger(entry.kind) || entry.kind < 0 || entry.kind > MAX_U16) {
      invalid(`entry ${String(index)} kind ${String(entry.kind)} is not a u16`);
    }
    if (!Number.isInteger(entry.decoders) || entry.decoders < 0 || entry.decoders > MAX_U32) {
      invalid(`entry ${String(index)} decoders ${String(entry.decoders)} is not a u32`);
    }
    if (!Number.isSafeInteger(entry.uploadSize) || entry.uploadSize < 0) {
      invalid(
        `entry ${String(index)} uploadSize ${String(entry.uploadSize)} is not a non-negative integer`,
      );
    }
    // A Buffer's uploadSize states its use: above 0 the engine uploads it as a GPU buffer, which
    // must be 4-byte aligned; 0 means a CPU decoder reads it (audio, .hdr), at any length.
    if (
      entry.kind === NativeEntryKind.Buffer &&
      entry.uploadSize > 0 &&
      entry.data.length % 4 !== 0
    ) {
      invalid(
        `entry ${String(index)} is a GPU buffer (uploadSize ${String(entry.uploadSize)}) of ${String(entry.data.length)} bytes, not a multiple of four`,
      );
    }
    for (const dependency of entry.dependencies) {
      if (!Number.isInteger(dependency) || dependency < 0 || dependency > MAX_U32) {
        invalid(`entry ${String(index)} dependency ${String(dependency)} is not a u32`);
      }
      if (dependency === index) {
        invalid(`entry ${String(index)} depends on itself`);
      }
      if (dependency >= entries.length) {
        invalid(
          `entry ${String(index)} depends on ${String(dependency)}, past the ${String(entries.length)} entries`,
        );
      }
    }
  }
}

/** Serializes `entries` into a TNPK v1 package, data in entry order right after the table. */
export function writeNativePackage(entries: readonly INativePackageEntry[]): Uint8Array {
  const encoded = entries.map((entry) => ({
    data: entry.data,
    decoders: entry.decoders ?? 0,
    dependencies: entry.dependencies ?? [],
    kind: entry.kind,
    name: Buffer.from(entry.name, "utf8"),
    uploadSize: entry.uploadSize ?? 0,
  }));
  validateEntries(encoded);
  let tableSize = 0;
  for (const entry of encoded) {
    tableSize += 2 + entry.name.length + 2 + 4 + 8 + 8 + 8 + 32 + 4 + 4 * entry.dependencies.length;
  }
  const dataStart = NATIVE_PACKAGE_HEADER_SIZE + tableSize;
  const total = encoded.reduce((sum, entry) => sum + entry.data.length, dataStart);
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes.set([0x54, 0x4e, 0x50, 0x4b], 0); // "TNPK"
  view.setUint32(4, NATIVE_PACKAGE_FORMAT_VERSION, true);
  view.setUint32(8, encoded.length, true);
  view.setUint32(12, 0, true);
  view.setBigUint64(16, BigInt(tableSize), true);

  let at = NATIVE_PACKAGE_HEADER_SIZE;
  let offset = dataStart;
  for (const entry of encoded) {
    view.setUint16(at, entry.name.length, true);
    at += 2;
    bytes.set(entry.name, at);
    at += entry.name.length;
    view.setUint16(at, entry.kind, true);
    at += 2;
    view.setUint32(at, entry.decoders, true);
    at += 4;
    view.setBigUint64(at, BigInt(offset), true);
    at += 8;
    view.setBigUint64(at, BigInt(entry.data.length), true);
    at += 8;
    view.setBigUint64(at, BigInt(entry.uploadSize), true);
    at += 8;
    bytes.set(createHash("sha256").update(entry.data).digest(), at);
    at += 32;
    view.setUint32(at, entry.dependencies.length, true);
    at += 4;
    for (const dependency of entry.dependencies) {
      view.setUint32(at, dependency, true);
      at += 4;
    }
    offset += entry.data.length;
  }
  for (const entry of encoded) {
    bytes.set(entry.data, at);
    at += entry.data.length;
  }
  return bytes;
}

/**
 * Parses and range-checks the header and table, refusing with the C++ reader's codes.
 *
 * Hashes are not verified here; the engine's `verifyPackage` does that before load. This parses
 * the manifest only, so a malformed table fails closed before anything is read by offset.
 */
export function readNativePackageManifest(bytes: Uint8Array): INativePackageManifest {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (code: string, detail: string): never => {
    throw new NativePackageError(code, detail);
  };
  if (bytes.length < NATIVE_PACKAGE_HEADER_SIZE) {
    fail("TN_PACKAGE_TRUNCATED", "shorter than the 24-byte header");
  }
  if (!(bytes[0] === 0x54 && bytes[1] === 0x4e && bytes[2] === 0x50 && bytes[3] === 0x4b)) {
    fail("TN_PACKAGE_MAGIC", "not a TNPK package");
  }
  const version = view.getUint32(4, true);
  if (version !== NATIVE_PACKAGE_FORMAT_VERSION) {
    fail("TN_PACKAGE_VERSION", `format ${String(version)}, the engine reads 1`);
  }
  const count = view.getUint32(8, true);
  const tableSize = Number(view.getBigUint64(16, true));
  if (tableSize > bytes.length - NATIVE_PACKAGE_HEADER_SIZE) {
    fail("TN_PACKAGE_TRUNCATED", "entry table runs past the end");
  }
  const tableEnd = NATIVE_PACKAGE_HEADER_SIZE + tableSize;
  // An entry needs at least 68 bytes, so a count the table cannot hold is refused before allocation.
  if (count > Math.floor(tableSize / 68)) {
    fail("TN_PACKAGE_TRUNCATED", "entry count exceeds the table");
  }
  let at = NATIVE_PACKAGE_HEADER_SIZE;
  const need = (length: number): boolean => length <= tableEnd - at;
  const readU16 = (): number => {
    const value = view.getUint16(at, true);
    at += 2;
    return value;
  };
  const readU32 = (): number => {
    const value = view.getUint32(at, true);
    at += 4;
    return value;
  };
  const readU64 = (): number => {
    const value = Number(view.getBigUint64(at, true));
    at += 8;
    return value;
  };
  const entries: INativePackageEntryRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    if (!need(2)) fail("TN_PACKAGE_TRUNCATED", "the entry table ends mid-entry");
    const nameLength = readU16();
    if (!need(nameLength)) fail("TN_PACKAGE_TRUNCATED", "the entry table ends mid-entry");
    const name = Buffer.from(bytes.subarray(at, at + nameLength)).toString("utf8");
    at += nameLength;
    if (!need(2 + 4 + 8 + 8 + 8 + 32 + 4)) {
      fail("TN_PACKAGE_TRUNCATED", `entry ${String(index)} runs past the table`);
    }
    const kind = readU16();
    const decoders = readU32();
    const offset = readU64();
    const size = readU64();
    const uploadSize = readU64();
    const hash = bytes.slice(at, at + 32);
    at += 32;
    const dependencyCount = readU32();
    if (!need(4 * dependencyCount)) {
      fail("TN_PACKAGE_TRUNCATED", `entry ${String(index)} runs past the table`);
    }
    const dependencies: number[] = [];
    for (let dependency = 0; dependency < dependencyCount; dependency += 1) {
      dependencies.push(readU32());
    }
    // Data lives after the table and inside the file; subtraction, never offset + size.
    if (offset < tableEnd || offset > bytes.length || size > bytes.length - offset) {
      fail("TN_PACKAGE_RANGE", `entry '${name}' data is outside the package`);
    }
    entries.push({ decoders, dependencies, hash, kind, name, offset, size, uploadSize });
  }
  for (const [index, entry] of entries.entries()) {
    for (const dependency of entry.dependencies) {
      if (dependency >= entries.length || dependency === index) {
        fail("TN_PACKAGE_DEPENDENCY", `entry '${entry.name}' depends on ${String(dependency)}`);
      }
    }
  }
  return { entries, version };
}
