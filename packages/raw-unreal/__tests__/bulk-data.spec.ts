import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  UAssetError,
  decompressBulkData,
  findBulkDataHeaders,
  parseUAssetStaticMesh,
  readPackageLayout,
} from "../src/index.js";
import {
  BULK,
  Writer,
  bulkDataHeader,
  compressedChunks,
  editorPackage,
  rawMeshBlob,
} from "./fixture-builder.js";

/** A zlib codec is never bundled; the suite injects Node's, exactly as a game would inject its
 * own. `rawSize` is the caller's contract with the codec, so it is honoured here. */
const zlib = (compressed: Uint8Array, rawSize: number): Uint8Array => {
  const inflated = new Uint8Array(inflateSync(compressed));
  if (inflated.byteLength !== rawSize) throw new Error("fixture codec size mismatch");
  return inflated;
};
const deflate = (block: Uint8Array): Uint8Array => new Uint8Array(deflateSync(block));

/** The `UAssetError` code a call throws; any other thrown value is named, so it fails a code check. */
function errorCodeOf(read: () => unknown): string | undefined {
  try {
    read();
    return undefined;
  } catch (error) {
    return error instanceof UAssetError ? error.code : `not a UAssetError: ${String(error)}`;
  }
}

/** A small square as an FRawMesh: two triangles, one material, per-wedge normals and UVs. */
const squareRawMesh = rawMeshBlob({
  vertices: [
    [0, 0, 0],
    [100, 0, 0],
    [100, 100, 0],
    [0, 100, 0],
  ],
  wedgeIndices: [0, 1, 2, 0, 2, 3],
  wedgeNormals: Array.from({ length: 6 }, () => [0, 0, 1] as const),
  uvs: [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0],
    [1, 1],
    [0, 1],
  ],
  faceMaterials: [0, 0],
});

/** Wraps an FRawMesh payload as `FRawMeshBulkData` does: the bulk header, then the GUID and the
 * `bGuidIsHash` flag that close the struct. */
function rawMeshBulkData(fields: {
  flags: number;
  elementCount: number;
  sizeOnDisk: number;
  offsetInFile: number;
}): Uint8Array {
  const writer = new Writer();
  writer.bytes(bulkDataHeader(fields));
  writer.bytes(new Uint8Array(16)); // FGuid
  writer.int32(0); // bGuidIsHash
  return writer.concat();
}

describe("readPackageLayout", () => {
  it("walks the whole summary and lands exactly on the name table", () => {
    const bytes = editorPackage({ exportData: new Uint8Array(32) });
    const layout = readPackageLayout(bytes);
    expect(layout).toBeDefined();
    expect(layout?.totalHeaderSize).toBeLessThan(layout?.bulkDataStartOffset ?? 0);
    expect(layout?.bulkDataStartOffset).toBe(bytes.byteLength - 4);
  });

  it("declines rather than guessing when the walk does not land on the name table", () => {
    const bytes = editorPackage({ exportData: new Uint8Array(32) });
    const layout = readPackageLayout(bytes);
    if (!layout) throw new Error("expected a resolvable package layout");

    // Move the summary's own NameOffset field, found by the value the clean walk reported. The
    // summary now ends somewhere other than where it says its name table begins.
    const damaged = bytes.slice();
    const view = new DataView(damaged.buffer);
    let nameOffsetField = -1;
    for (let offset = 0; offset + 4 <= layout.nameOffset; offset += 1) {
      if (view.getInt32(offset, true) === layout.nameOffset) nameOffsetField = offset;
    }
    expect(nameOffsetField).toBeGreaterThan(0);
    view.setInt32(nameOffsetField, layout.nameOffset + 8, true);

    expect(readPackageLayout(damaged)).toBeUndefined();
  });

  it("lands on the name table for every gated FileVersionUE4 from 504 to 522", () => {
    const objectPath = "/Game/Gate/SM_gate";
    for (let version = 504; version <= 522; version += 1) {
      const bytes = editorPackage({
        exportData: new Uint8Array(32),
        fileVersionUE4: version,
        objectPath,
      });
      const layout = readPackageLayout(bytes);
      expect(layout, `FileVersionUE4 ${version}`).toBeDefined();
      if (!layout) continue;
      // The name table opens with its first FString, so the walk stopped on that byte.
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(view.getInt32(layout.nameOffset, true), `FileVersionUE4 ${version}`).toBe(
        objectPath.length + 1,
      );
      expect(layout.bulkDataStartOffset, `FileVersionUE4 ${version}`).toBe(bytes.byteLength - 4);
    }
  });

  it("declines, and never throws, for every cut inside the summary", () => {
    const bytes = editorPackage({ exportData: new Uint8Array(32) });
    const summaryEnd = readPackageLayout(bytes)?.nameOffset ?? 0;
    expect(summaryEnd).toBeGreaterThan(0);
    for (let length = 0; length <= summaryEnd; length += 1) {
      expect(
        errorCodeOf(() => readPackageLayout(bytes.subarray(0, length))),
        `cut at ${length} bytes`,
      ).toBeUndefined();
    }
  });
});

describe("findBulkDataHeaders", () => {
  it("reads an end-of-file header's flags, counts and offset", () => {
    const payload = squareRawMesh;
    const bytes = editorPackage({
      exportData: rawMeshBulkData({
        flags: BULK.PAYLOAD_AT_END_OF_FILE,
        elementCount: payload.byteLength,
        sizeOnDisk: payload.byteLength,
        offsetInFile: 0,
      }),
      bulkRegion: payload,
    });
    const layout = readPackageLayout(bytes);
    expect(layout).toBeDefined();
    if (!layout) return;

    const headers = findBulkDataHeaders(bytes, layout);
    expect(headers.length).toBe(1);
    expect(headers[0]).toMatchObject({
      storage: "end-of-file",
      compression: "none",
      sizeOnDisk: payload.byteLength,
      offsetInFile: 0,
    });
  });

  /**
   * A separate-file payload cannot be range-checked against anything the reader holds, so the
   * only thing standing between a random byte run and a MISSING_BULK_DATA_FILE report is the
   * flag word itself. Unreal names exactly one storage; anything naming two is not a header.
   */
  it("drops a header whose flags name more than one payload store", () => {
    const payload = squareRawMesh;
    const bytes = editorPackage({
      exportData: rawMeshBulkData({
        flags: BULK.PAYLOAD_AT_END_OF_FILE | BULK.PAYLOAD_IN_SEPARATE_FILE,
        elementCount: payload.byteLength,
        sizeOnDisk: payload.byteLength,
        offsetInFile: 0,
      }),
      bulkRegion: payload,
    });
    const layout = readPackageLayout(bytes);
    if (!layout) throw new Error("expected a resolvable package layout");
    expect(findBulkDataHeaders(bytes, layout)).toEqual([]);
  });

  it("reads an inline payload's header, whose bytes follow it directly", () => {
    const payload = squareRawMesh;
    const bytes = editorPackage({
      exportData: new Writer()
        .bytes(
          bulkDataHeader({
            flags: BULK.FORCE_INLINE_PAYLOAD,
            elementCount: payload.byteLength,
            sizeOnDisk: payload.byteLength,
            offsetInFile: 0,
          }),
        )
        .bytes(payload)
        .concat(),
    });
    const layout = readPackageLayout(bytes);
    if (!layout) throw new Error("expected a resolvable package layout");
    const headers = findBulkDataHeaders(bytes, layout);
    expect(headers.some((header) => header.storage === "inline")).toBe(true);
  });
});

describe("decompressBulkData", () => {
  it("inverts FArchive::SerializeCompressed with the caller's zlib codec", () => {
    const payload = Uint8Array.from({ length: 400_000 }, (_, index) => index % 251);
    const container = compressedChunks(payload, deflate);
    const out = decompressBulkData(container, { zlib });
    expect(out.byteLength).toBe(payload.byteLength);
    expect(out[0]).toBe(payload[0]);
    expect(out[399_999]).toBe(payload[399_999]);
  });

  it("reports a missing zlib codec instead of guessing", () => {
    const container = compressedChunks(Uint8Array.from([1, 2, 3, 4]), deflate);
    try {
      decompressBulkData(container, {});
      expect.unreachable("expected MISSING_CODEC");
    } catch (error) {
      expect(error).toBeInstanceOf(UAssetError);
      expect((error as UAssetError).code).toBe("MISSING_CODEC");
    }
  });

  it("rejects a container whose chunk sizes disagree with its totals", () => {
    const container = compressedChunks(Uint8Array.from([1, 2, 3, 4]), deflate);
    new DataView(container.buffer).setBigInt64(24, 9_999n, true); // total raw size
    expect(() => decompressBulkData(container, { zlib })).toThrowError(UAssetError);
  });

  it("reports a container that does not begin with the package tag as INVALID_BULK_DATA", () => {
    expect(errorCodeOf(() => decompressBulkData(new Uint8Array(40), { zlib }))).toBe(
      "INVALID_BULK_DATA",
    );
  });
});

describe("parseUAssetStaticMesh, bulk-data payloads", () => {
  it("decodes an FRawMesh kept in end-of-file bulk data", () => {
    const payload = squareRawMesh;
    const bytes = editorPackage({
      exportData: rawMeshBulkData({
        flags: BULK.PAYLOAD_AT_END_OF_FILE,
        elementCount: payload.byteLength,
        sizeOnDisk: payload.byteLength,
        offsetInFile: 0,
      }),
      bulkRegion: payload,
    });

    const decoded = parseUAssetStaticMesh(bytes);
    expect(decoded.unreal.layout).toBe("raw-mesh");
    expect(decoded.unreal.bulkData).toMatchObject({ storage: "end-of-file", compression: "none" });
    expect(decoded.sourceStats).toEqual({ vertices: 4, vertexInstances: 6, triangles: 2 });
  });

  it("decodes a zlib-compressed FRawMesh bulk payload, which no plain byte scan can find", () => {
    const container = compressedChunks(squareRawMesh, deflate);
    const bytes = editorPackage({
      exportData: rawMeshBulkData({
        flags: BULK.PAYLOAD_AT_END_OF_FILE | BULK.SERIALIZE_COMPRESSED_ZLIB,
        elementCount: squareRawMesh.byteLength,
        sizeOnDisk: container.byteLength,
        offsetInFile: 0,
      }),
      bulkRegion: container,
    });

    // Without the codec the layout is unreadable, and the reader says so rather than guessing.
    try {
      parseUAssetStaticMesh(bytes);
      expect.unreachable("expected MISSING_CODEC");
    } catch (error) {
      expect((error as UAssetError).code).toBe("MISSING_CODEC");
    }

    const decoded = parseUAssetStaticMesh(bytes, { zlib });
    expect(decoded.unreal.layout).toBe("raw-mesh");
    expect(decoded.unreal.bulkData).toMatchObject({
      storage: "end-of-file",
      compression: "zlib",
    });
    expect(decoded.sourceStats).toEqual({ vertices: 4, vertexInstances: 6, triangles: 2 });
  });

  /**
   * A separate-file payload is the one store nothing in the `.uasset` can range-check, so a
   * candidate the caller supplied no bytes for is dropped rather than reported. Reporting it
   * cost 21 real Office Pack meshes a MISSING_BULK_DATA_FILE for a sibling that has never
   * existed, raised off a byte run in their export data — the package's own `supported:` line
   * is where a caller learns that this store needs `bulkDataFiles`.
   */
  it("decodes a separate-file payload from the bytes the caller supplies", () => {
    const payload = squareRawMesh;
    const bytes = editorPackage({
      exportData: rawMeshBulkData({
        flags: BULK.PAYLOAD_IN_SEPARATE_FILE,
        elementCount: payload.byteLength,
        sizeOnDisk: payload.byteLength,
        offsetInFile: 0,
      }),
    });

    const decoded = parseUAssetStaticMesh(bytes, { bulkDataFiles: { ubulk: payload } });
    expect(decoded.unreal.bulkData).toMatchObject({ storage: "separate-file", file: "ubulk" });
    expect(decoded.sourceStats).toEqual({ vertices: 4, vertexInstances: 6, triangles: 2 });
  });

  it("does not claim a sibling file is missing on the strength of an unverifiable candidate", () => {
    const payload = squareRawMesh;
    const bytes = editorPackage({
      exportData: rawMeshBulkData({
        flags: BULK.PAYLOAD_IN_SEPARATE_FILE,
        elementCount: payload.byteLength,
        sizeOnDisk: payload.byteLength,
        offsetInFile: 0,
      }),
    });

    try {
      parseUAssetStaticMesh(bytes);
      expect.unreachable("expected UNSUPPORTED_STATIC_MESH_LAYOUT");
    } catch (error) {
      expect((error as UAssetError).code).toBe("UNSUPPORTED_STATIC_MESH_LAYOUT");
      const details = (error as UAssetError).details as Record<string, unknown>;
      expect(String(details.supported)).toContain("bulkDataFiles");
    }
  });

  it("rejects an uncompressed header whose payload is not one byte per element", () => {
    const payload = squareRawMesh;
    const bytes = editorPackage({
      exportData: rawMeshBulkData({
        flags: BULK.PAYLOAD_AT_END_OF_FILE,
        elementCount: payload.byteLength / 2,
        sizeOnDisk: payload.byteLength,
        offsetInFile: 0,
      }),
      bulkRegion: payload,
    });
    const layout = readPackageLayout(bytes);
    if (!layout) throw new Error("expected a resolvable package layout");
    expect(findBulkDataHeaders(bytes, layout)).toEqual([]);
  });

  it("drops a header whose payload runs past the package it claims to live in", () => {
    const payload = squareRawMesh;
    const bytes = editorPackage({
      exportData: rawMeshBulkData({
        flags: BULK.PAYLOAD_AT_END_OF_FILE,
        elementCount: payload.byteLength,
        sizeOnDisk: payload.byteLength + 4_096,
        offsetInFile: 0,
      }),
      bulkRegion: payload,
    });
    const layout = readPackageLayout(bytes);
    if (!layout) throw new Error("expected a resolvable package layout");
    expect(findBulkDataHeaders(bytes, layout)).toEqual([]);
  });

  it("stops claiming that bulk-data packages are unread", () => {
    const bytes = editorPackage({ exportData: new Uint8Array(64) });
    try {
      parseUAssetStaticMesh(bytes);
      expect.unreachable("expected UNSUPPORTED_STATIC_MESH_LAYOUT");
    } catch (error) {
      const details = (error as UAssetError).details as Record<string, unknown>;
      expect(String(details.probed)).toContain("bulk-data");
      expect(String(details.supported)).not.toContain("bulk data are not read");
    }
  });
});

// Real-data conformance: licensed Fab packs are never committed, so this leg runs only when the
// pack root is on disk. Point THREENATIVE_FAB_PACK_ROOT at the directory holding the packs.
const PACK_ROOT = process.env.THREENATIVE_FAB_PACK_ROOT;
const OFFICE_BAR = PACK_ROOT
  ? `${PACK_ROOT}/ce136033-3265-46d3-ac4d-fdbd5c9d0462/OfficePa3620d8d7fd5fV2/Content/Office_Pack_Vol_1/Models/SM_Bar_1.uasset`
  : "";

describe("real-pack conformance, UE4.26 bulk data (skipped without the licensed pack)", () => {
  it.skipIf(!OFFICE_BAR || !existsSync(OFFICE_BAR))(
    "decodes SM_Bar_1.uasset, whose MeshDescription is zlib-compressed bulk data",
    async () => {
      const bytes = new Uint8Array(await readFile(OFFICE_BAR));
      const layout = readPackageLayout(bytes);
      expect(layout?.bulkDataStartOffset).toBe(116_608);

      const decoded = parseUAssetStaticMesh(bytes, { zlib });
      expect(decoded.unreal.layout).toBe("mesh-description-ue4");
      expect(decoded.unreal.bulkData).toMatchObject({
        storage: "end-of-file",
        compression: "zlib",
        sizeOnDisk: 20_573,
      });
      expect(decoded.sourceStats).toEqual({
        vertices: 480,
        vertexInstances: 2_268,
        triangles: 756,
      });
      expect(decoded.sections.length).toBe(2);
      expect(decoded.sections.map((section) => section.materialName)).toEqual([
        "Material_015",
        "Material_016",
      ]);
      expect(decoded.positions.every(Number.isFinite)).toBe(true);
      expect(decoded.uvs.every(Number.isFinite)).toBe(true);
      expect(decoded.normals?.length).toBe(2_268 * 3);
      expect(decoded.indices.length).toBe(756 * 3);

      // A bar counter, in centimetres, converted to three.js Y-up: 87.5 wide, 400 long, 87.5
      // tall. Counts alone would pass on a payload read at the wrong offset; these would not.
      for (const axis of [0, 1, 2] as const) {
        expect(decoded.bounds.min[axis]).toBeCloseTo(0, 1);
      }
      expect(decoded.bounds.max[0]).toBeCloseTo(87.5, 1);
      expect(decoded.bounds.max[1]).toBeCloseTo(400, 1);
      expect(decoded.bounds.max[2]).toBeCloseTo(87.5, 1);

      // Corners read from the file's own triangle container, so no triangle collapses.
      let degenerate = 0;
      for (let base = 0; base < decoded.indices.length; base += 3) {
        const at = (slot: number, axis: number) =>
          decoded.positions[(decoded.indices[base + slot] ?? 0) * 3 + axis] ?? Number.NaN;
        const u = [0, 1, 2].map((axis) => at(1, axis) - at(0, axis));
        const w = [0, 1, 2].map((axis) => at(2, axis) - at(0, axis));
        const cross = Math.hypot(
          (u[1] ?? 0) * (w[2] ?? 0) - (u[2] ?? 0) * (w[1] ?? 0),
          (u[2] ?? 0) * (w[0] ?? 0) - (u[0] ?? 0) * (w[2] ?? 0),
          (u[0] ?? 0) * (w[1] ?? 0) - (u[1] ?? 0) * (w[0] ?? 0),
        );
        if (!(cross > 1e-9)) degenerate += 1;
      }
      expect(degenerate).toBe(0);
    },
  );
});
