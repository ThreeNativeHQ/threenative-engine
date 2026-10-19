import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { decompress as oodle } from "ooz-wasm";
import { describe, expect, it } from "vitest";

import {
  COMPRESSION_METHOD,
  UAssetError,
  decompressCompressedBuffer,
  parseCompressedBuffer,
  parseMeshDescription,
  parseUAssetStaticMesh,
  readPackageSummary,
} from "../src/index.js";
import { Writer, legacyPackage } from "./fixture-builder.js";

const fixtureUrl = new URL("../fixtures/SM_cube.uasset", import.meta.url);

async function fixtureBytes(): Promise<Uint8Array> {
  const buffer = await readFile(fixtureUrl);
  return new Uint8Array(buffer);
}

/** Total triangle area, computed through checked reads so the strict index access stays honest. */
function surfaceArea(positions: Float32Array, indices: Uint16Array | Uint32Array): number {
  const at = (array: ArrayLike<number>, index: number): number => array[index] ?? Number.NaN;
  let area = 0;
  for (let base = 0; base + 2 < indices.length; base += 3) {
    const a = at(indices, base) * 3;
    const b = at(indices, base + 1) * 3;
    const c = at(indices, base + 2) * 3;
    const ax = at(positions, a);
    const ay = at(positions, a + 1);
    const az = at(positions, a + 2);
    const abx = at(positions, b) - ax;
    const aby = at(positions, b + 1) - ay;
    const abz = at(positions, b + 2) - az;
    const acx = at(positions, c) - ax;
    const acy = at(positions, c + 1) - ay;
    const acz = at(positions, c + 2) - az;
    const cross = [aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx];
    area += Math.hypot(cross[0] ?? 0, cross[1] ?? 0, cross[2] ?? 0) * 0.5;
  }
  return area;
}

/** The `UAssetError` code a call throws; any other thrown value is named, so it fails a code check. */
function errorCodeOf(read: () => unknown): string | undefined {
  try {
    read();
    return undefined;
  } catch (error) {
    return error instanceof UAssetError ? error.code : `not a UAssetError: ${String(error)}`;
  }
}

/** The first `byteLength` bytes of a package summary: the tag, the legacy version, and the engine
 * version, with the rest zero. A cut inside the licensee field is what a truncated file looks like. */
function summaryPrefix(legacyFileVersion: number, byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x9e2a83c1, true);
  if (byteLength >= 8) view.setInt32(4, legacyFileVersion, true);
  if (byteLength >= 16) view.setInt32(12, 516, true);
  return bytes;
}

describe("readPackageSummary", () => {
  it("rejects data that is not an Unreal package", async () => {
    expect(() => readPackageSummary(new Uint8Array([0, 1, 2, 3]))).toThrowError(UAssetError);
    try {
      readPackageSummary(new Uint8Array([0, 1, 2, 3]));
      expect.unreachable();
    } catch (error) {
      expect((error as UAssetError).code).toBe("INVALID_PACKAGE_TAG");
    }
  });

  it("reads the real UE5.7 fixture's summary prefix, including the editor object version", async () => {
    const summary = readPackageSummary(await fixtureBytes());
    expect(summary.packageTag).toBe(0x9e2a83c1);
    expect(summary.legacyFileVersion).toBeLessThanOrEqual(-8);
    expect(summary.fileVersionUE5).toBeGreaterThan(0);
  });

  it("reports a package tag with no summary behind it as TRUNCATED_PACKAGE", () => {
    expect(errorCodeOf(() => readPackageSummary(summaryPrefix(-7, 4)))).toBe("TRUNCATED_PACKAGE");
  });

  it.each([-7, -8])(
    "reports every cut inside the licensee field as TRUNCATED_PACKAGE (legacy %i)",
    (legacyFileVersion) => {
      // The licensee version sits at 16 for LegacyFileVersion -7 and at 20 for -8.
      const licenseeEnd = legacyFileVersion <= -8 ? 24 : 20;
      for (let length = 16; length < licenseeEnd; length += 1) {
        expect(
          errorCodeOf(() => readPackageSummary(summaryPrefix(legacyFileVersion, length))),
          `cut at ${length} bytes`,
        ).toBe("TRUNCATED_PACKAGE");
      }
    },
  );
});

describe("parseUAssetStaticMesh", () => {
  it("decodes the pinned real UE5.7 package into static-mesh geometry", async () => {
    const bytes = await fixtureBytes();
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "6302cfb9f81d1e71f1f5386c8d2a7d4851bea06cc73b14289554d155751f2283",
    );

    const decoded = parseUAssetStaticMesh(bytes, { oodle });

    expect(decoded.metadata).toEqual({
      assetClass: "StaticMesh",
      engineVersion: "++UE5+Release-5.7",
      objectPath: "/Game/texture_cube/StaticMeshes/SM_cube",
      packageByteLength: 19_288,
    });
    expect(decoded.positions.length / 3).toBe(24);
    expect(decoded.uvs.length / 2).toBe(24);
    expect(decoded.normals?.length).toBe(72);
    expect(decoded.indices.length).toBe(36);
    expect(decoded.indices.every((index) => index >= 0 && index < 24)).toBe(true);
    expect(decoded.sections).toEqual([
      { materialIndex: 0, sectionIndex: 0, materialName: "0", start: 0, count: 36 },
    ]);
    expect([...decoded.bounds.min].map(Math.round)).toEqual([-50, -50, -50]);
    expect([...decoded.bounds.max].map(Math.round)).toEqual([50, 50, 50]);
    expect(decoded.positions.every(Number.isFinite)).toBe(true);
    expect(decoded.uvs.every(Number.isFinite)).toBe(true);

    // The geometry has real surface area in the converted coordinate system.
    expect(surfaceArea(decoded.positions, decoded.indices)).toBeGreaterThan(0);

    expect(decoded.unreal.layout).toBe("mesh-description");
    expect(decoded.unreal.compressedBuffer).toMatchObject({
      method: COMPRESSION_METHOD.OODLE,
      rawSize: 3_305,
      compressedSize: 823,
    });
    expect(decoded.unreal.payload).toEqual({
      frame: "decompressed",
      offset: 0,
      byteLength: 3_305,
    });
    expect(decoded.sourceStats).toEqual({ vertices: 8, vertexInstances: 24, triangles: 12 });
  });

  it("reports a missing Oodle codec instead of returning invented geometry", async () => {
    const bytes = await fixtureBytes();
    try {
      parseUAssetStaticMesh(bytes);
      expect.unreachable("expected MISSING_CODEC");
    } catch (error) {
      expect(error).toBeInstanceOf(UAssetError);
      expect((error as UAssetError).code).toBe("MISSING_CODEC");
    }
  });

  it("decompresses an uncompressed FCompressedBuffer without any codec", () => {
    // A minimal buffer: header (BE magic, CRC, method, compressor, level, block exponent, block
    // count, sizes, 32-byte hash) followed by the raw payload.
    const payload = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const writer = new Writer();
    writer.uint32BE(0xb7756362);
    writer.uint32BE(0); // CRC32, unchecked by the parser
    writer.uint8(COMPRESSION_METHOD.NONE).uint8(0).uint8(0).uint8(0);
    writer.uint32BE(0); // block count
    writer.uint64BE(BigInt(payload.length));
    writer.uint64BE(BigInt(64 + payload.length)); // total compressed size: header + payload
    writer.bytes(new Uint8Array(32)); // BLAKE3 hash
    writer.bytes(payload);
    const bytes = writer.concat();

    const buffer = parseCompressedBuffer(bytes);
    expect(buffer.method).toBe(COMPRESSION_METHOD.NONE);
    const decompressed = decompressCompressedBuffer(buffer, {});
    expect([...decompressed]).toEqual([...payload]);
  });

  it("runs the block loop for an LZ4 payload with the caller's codec and rejects a wrong size", () => {
    const block = Uint8Array.from([9, 9, 9, 9]);
    const writer = new Writer();
    writer.uint32BE(0xb7756362);
    writer.uint32BE(0);
    writer.uint8(COMPRESSION_METHOD.LZ4).uint8(0).uint8(0).uint8(16); // 2^16 block size
    writer.uint32BE(1); // block count
    writer.uint64BE(BigInt(block.length * 2));
    writer.uint64BE(BigInt(64 + block.length + 4));
    writer.bytes(new Uint8Array(32));
    writer.uint32BE(block.length); // block size table
    writer.bytes(block);
    writer.bytes(block);
    const bytes = writer.concat();

    const buffer = parseCompressedBuffer(bytes);
    // One block covering the full 8 raw bytes; the fake codec honours its requested size.
    const decompressed = decompressCompressedBuffer(buffer, {
      lz4: (_compressed, rawSize) => new Uint8Array(rawSize).fill(9),
    });
    expect(decompressed.byteLength).toBe(8);
    expect(decompressed[0]).toBe(9);

    expect(() =>
      decompressCompressedBuffer(buffer, {
        lz4: () => new Uint8Array(1),
      }),
    ).toThrowError(UAssetError);
    try {
      decompressCompressedBuffer(buffer, { lz4: () => new Uint8Array(1) });
      expect.unreachable();
    } catch (error) {
      expect((error as UAssetError).code).toBe("CODEC_SIZE_MISMATCH");
    }
  });

  /**
   * A package this parser cannot read must say *what it looked for*, not assert a version range.
   *
   * A real UE4.27 office pack (`fileVersionUE4` 522) reached this path: every probe found
   * nothing, and the error answered with "UE4.26-5.x editor static meshes with serialized
   * FMeshDescription data" — a claim that covers the very file in front of it. A caller reading
   * that concludes the file is corrupt. What it needs to know is that all three payload probes
   * ran and none matched, which is a coverage gap it can report rather than a broken asset.
   */
  it("names every payload probe when no static-mesh layout matches", () => {
    const bytes = legacyPackage(new Uint8Array(64), { fileVersionUE4: 522 });

    try {
      parseUAssetStaticMesh(bytes);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UAssetError);
      expect((error as UAssetError).code).toBe("UNSUPPORTED_STATIC_MESH_LAYOUT");
      const details = (error as UAssetError).details as Record<string, unknown>;
      expect(details.fileVersionUE4).toBe(522);
      expect(String(details.probed)).toContain("compressed");
      expect(String(details.probed)).toContain("mesh-description");
      expect(String(details.probed)).toContain("raw-mesh");
    }
  });

  it("rejects a MeshDescription whose serialized attribute count disagrees with its extent", () => {
    const chunks = new Writer();
    chunks.int32(1); // element types
    chunks.fstring("Vertices");
    chunks.int32(1); // element channels
    chunks.int32(0); // allocation bits
    chunks.int32(0); // holes
    chunks.int32(0); // attribute-set elements
    chunks.int32(1); // attributes
    chunks.fstring("Position");
    chunks.uint32(1); // FVector3f
    chunks.uint32(1); // extent
    chunks.int32(0); // elements
    chunks.int32(1); // channels
    chunks.uint32(1); // channel extent
    chunks.int32(12); // bulk byte size
    chunks.int32(1); // invalid: expected zero serialized values
    chunks.bytes(new Uint8Array(12));

    try {
      parseMeshDescription(chunks.concat());
      expect.unreachable("expected INVALID_MESH_DESCRIPTION");
    } catch (error) {
      expect(error).toBeInstanceOf(UAssetError);
      expect((error as UAssetError).code).toBe("INVALID_MESH_DESCRIPTION");
    }
  });

  it("reports an FCompressedBuffer with the wrong magic as INVALID_COMPRESSED_BUFFER", () => {
    const bytes = new Writer().uint32BE(0xdeadbeef).bytes(new Uint8Array(60)).concat();
    expect(errorCodeOf(() => parseCompressedBuffer(bytes))).toBe("INVALID_COMPRESSED_BUFFER");
  });

  it("reports a compression method Unreal does not define as UNSUPPORTED_COMPRESSION_METHOD", () => {
    const bytes = new Writer()
      .uint32BE(0xb7756362)
      .uint32BE(0) // CRC32, unchecked by the parser
      .uint8(7) // not NONE, OODLE, or LZ4
      .uint8(0)
      .uint8(0)
      .uint8(0)
      .uint32BE(0) // block count
      .uint64BE(0n) // total raw size
      .uint64BE(64n) // total compressed size: the header alone
      .bytes(new Uint8Array(32)) // BLAKE3 hash
      .concat();
    expect(errorCodeOf(() => parseCompressedBuffer(bytes))).toBe("UNSUPPORTED_COMPRESSION_METHOD");
  });

  it("reports a payload that decompresses short of its declared size as INCOMPLETE_DECOMPRESSION", () => {
    // One block of 2^3 bytes: the codec can supply 8 of the 16 bytes the header declares.
    const block = Uint8Array.from([9, 9, 9, 9]);
    const bytes = new Writer()
      .uint32BE(0xb7756362)
      .uint32BE(0)
      .uint8(COMPRESSION_METHOD.LZ4)
      .uint8(0)
      .uint8(0)
      .uint8(3) // block size exponent
      .uint32BE(1) // block count
      .uint64BE(16n) // total raw size
      .uint64BE(BigInt(64 + 4 + block.length)) // header, block table, and block
      .bytes(new Uint8Array(32))
      .uint32BE(block.length) // block size table
      .bytes(block)
      .concat();
    const buffer = parseCompressedBuffer(bytes);
    expect(
      errorCodeOf(() => decompressCompressedBuffer(buffer, { lz4: () => new Uint8Array(8) })),
    ).toBe("INCOMPLETE_DECOMPRESSION");
  });

  it("throws only UAssetError when the real package is cut at any sampled length", async () => {
    const bytes = await fixtureBytes();
    // A full parse of a cut near the end costs ~0.5 s, so the sweep is exhaustive only where the
    // summary's versions and licensee field live (every byte of the first 64), with strides through
    // the rest. bulk-data.spec.ts sweeps every byte of a synthetic summary through readPackageLayout.
    const lengths = new Set<number>();
    for (let length = 0; length < 64; length += 1) lengths.add(length);
    for (let length = 64; length < Math.min(bytes.byteLength, 1024); length += 37)
      lengths.add(length);
    for (let length = 1024; length < bytes.byteLength; length += 4096) lengths.add(length);
    lengths.add(bytes.byteLength - 1);

    const escaped: string[] = [];
    let rejected = 0;
    for (const length of lengths) {
      try {
        parseUAssetStaticMesh(bytes.subarray(0, length), { oodle });
      } catch (error) {
        rejected += 1;
        if (!(error instanceof UAssetError)) escaped.push(`${length} bytes: ${String(error)}`);
      }
    }
    expect(escaped).toEqual([]);
    // A cut that parses is a fail-open candidate; most cuts of a real package must be refused.
    expect(rejected).toBeGreaterThan(lengths.size / 2);
  });
});
