import { describe, expect, it, vi } from "vitest";

import { UEFormatError, type UEFormatErrorCode, parseUEModel } from "../src/index.js";
import {
  Writer,
  attributeSet,
  modelFile,
  richModelBody,
  staticModelBody,
  triangleLod,
} from "./fixture-builder.js";

/** The size of every buffer the GZIP inflater returned, so a test can see how much it kept. */
const inflated = vi.hoisted(() => [] as number[]);
vi.mock("fflate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fflate")>();
  return {
    ...actual,
    gunzipSync: (...args: Parameters<typeof actual.gunzipSync>) => {
      const output = actual.gunzipSync(...args);
      inflated.push(output.length);
      return output;
    },
  };
});

function expectCode(
  bytes: Uint8Array,
  code: UEFormatErrorCode,
  options?: Parameters<typeof parseUEModel>[1],
): void {
  try {
    parseUEModel(bytes, options);
    expect.unreachable(`expected UEFormatError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(UEFormatError);
    expect((error as UEFormatError).code).toBe(code);
  }
}

describe("parseUEModel", () => {
  it("parses a UEFormat v10 header and one static-mesh LOD", () => {
    const model = parseUEModel(modelFile({ body: staticModelBody() }));

    expect(model.header).toEqual({
      magic: "UEFORMAT",
      identifier: "UEMODEL",
      fileVersion: 10,
      objectName: "SM_Test",
      objectPath: "/Game/Test/SM_Test.SM_Test",
      compression: null,
    });
    expect(model.lods.length).toBe(1);
    expect(model.lods[0]?.name).toBe("LOD0");
    expect(model.lods[0]?.indices).toEqual([0, 1, 2]);
    expect(model.lods[0]?.vertices[1]).toEqual({ x: 100, y: 0, z: 0 });
  });

  it("parses normals, tangents, UVs, colors, and material sections", () => {
    const lod = parseUEModel(modelFile({ body: staticModelBody() })).lods[0];

    expect(lod?.normals[0]).toEqual({ binormalSign: 1, x: 0, y: 0, z: 1 });
    expect(lod?.tangents[0]).toEqual({ x: 1, y: 0, z: 0 });
    expect(lod?.texCoords[0]).toEqual({
      name: "UV0",
      uvs: [
        { u: 0, v: 0 },
        { u: 1, v: 0 },
        { u: 0, v: 1 },
      ],
    });
    expect(lod?.vertexColors[0]?.colors[1]).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(lod?.materials[0]).toEqual({
      materialName: "M_Table",
      materialPath: "/Game/Materials/M_Table.M_Table",
      firstIndex: 0,
      numFaces: 1,
    });
  });

  it("parses multiple LODs in serialized order", () => {
    const body = staticModelBody([triangleLod("LOD0"), triangleLod("LOD1")]);
    const model = parseUEModel(modelFile({ body }));
    expect(model.lods.map((lod) => lod.name)).toEqual(["LOD0", "LOD1"]);
  });

  it("parses weights and sparse morph targets", () => {
    const lod = parseUEModel(modelFile({ body: richModelBody() })).lods[0];
    expect(lod?.weights).toEqual([
      { boneIndex: 0, vertexIndex: 0, weight: 1 },
      { boneIndex: 1, vertexIndex: 1, weight: 0.75 },
      { boneIndex: 0, vertexIndex: 1, weight: 0.25 },
    ]);
    expect(lod?.morphTargets[0]).toEqual({
      name: "Bent",
      deltas: [
        {
          positionDelta: { x: 0, y: 0, z: 5 },
          tangentZDelta: { x: 0, y: 0, z: 0.10000000149011612 },
          vertexIndex: 2,
        },
      ],
    });
  });

  it("parses skeleton metadata, bones, sockets, and virtual bones", () => {
    const skeleton = parseUEModel(modelFile({ body: richModelBody() })).skeleton;
    expect(skeleton?.metadata).toBe("/Game/Test/Skeleton.Skeleton");
    expect(skeleton?.bones[1]).toEqual({
      name: "child",
      parentIndex: 0,
      position: { x: 0, y: 0, z: 10 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    });
    expect(skeleton?.sockets[0]?.name).toBe("Grip");
    expect(skeleton?.virtualBones[0]?.virtualBoneName).toBe("VB root_child");
  });

  it("parses convex collision geometry", () => {
    const collision = parseUEModel(modelFile({ body: richModelBody() })).collision[0];
    expect(collision?.name).toBe("Box");
    expect(collision?.indices).toEqual([0, 1, 2]);
    expect(collision?.vertices[2]).toEqual({ x: 0, y: 10, z: 0 });
  });

  it("decompresses a GZIP model body", () => {
    const model = parseUEModel(modelFile({ body: staticModelBody(), compressed: "GZIP" }));
    expect(model.header.compression?.format).toBe("GZIP");
    expect(model.lods[0]?.vertices.length).toBe(3);
  });

  it("uses an injected ZSTD decoder and checks the decoded size", () => {
    const body = staticModelBody();
    let received: Uint8Array | undefined;
    const model = parseUEModel(
      modelFile({ body, compressed: "ZSTD", zstdBytes: Uint8Array.of(9, 8, 7) }),
      {
        zstdDecoder(compressed, expectedSize) {
          received = compressed;
          expect(expectedSize).toBe(body.length);
          return body;
        },
      },
    );
    expect(received).toEqual(Uint8Array.of(9, 8, 7));
    expect(model.header.compression?.format).toBe("ZSTD");
  });

  it("records and skips unknown root and LOD attributes", () => {
    const lod = triangleLod("LOD0", { FUTURE_LOD_FIELD: Uint8Array.of(1, 2, 3) });
    const body = attributeSet({
      LODS: new Writer().int32(1).bytes(lod).finish(),
      FUTURE_ROOT_FIELD: Uint8Array.of(4, 5),
    });
    const model = parseUEModel(modelFile({ body }));
    expect(model.unknownAttributes).toEqual(["FUTURE_ROOT_FIELD"]);
    expect(model.lods[0]?.unknownAttributes).toEqual(["FUTURE_LOD_FIELD"]);
  });

  it("respects ArrayBufferView byte offsets", () => {
    const file = modelFile({ body: staticModelBody() });
    const wrapped = new Uint8Array(file.length + 12);
    wrapped.set(file, 7);
    const model = parseUEModel(wrapped.subarray(7, 7 + file.length));
    expect(model.header.objectName).toBe("SM_Test");
  });

  it("rejects invalid magic deterministically", () => {
    const bytes = modelFile();
    bytes[0] = 0;
    expectCode(bytes, "INVALID_MAGIC");
  });

  it("rejects non-model UEFormat identifiers", () => {
    expectCode(modelFile({ identifier: "UEANIM" }), "INVALID_IDENTIFIER");
  });

  it("rejects unsupported format versions", () => {
    expectCode(modelFile({ version: 9 }), "UNSUPPORTED_VERSION");
  });

  it("rejects truncated files with an offset-bearing error", () => {
    const bytes = modelFile().subarray(0, 6);
    try {
      parseUEModel(bytes);
      expect.unreachable("expected TRUNCATED_FILE");
    } catch (error) {
      expect(error).toBeInstanceOf(UEFormatError);
      expect((error as UEFormatError).code).toBe("TRUNCATED_FILE");
      expect((error as UEFormatError).offset).toBe(0);
    }
  });

  it("rejects unsupported compression formats", () => {
    expectCode(modelFile({ compressed: "ZSTD", compressionFormat: "LZ4" }), "INVALID_COMPRESSION");
  });

  it("rejects ZSTD data when no decoder is supplied", () => {
    expectCode(modelFile({ compressed: "ZSTD" }), "INVALID_COMPRESSION");
  });

  it("rejects corrupt GZIP payloads", () => {
    const body = staticModelBody();
    const valid = modelFile({ body, compressed: "GZIP" });
    const last = valid.length - 1;
    valid[last] = (valid[last] ?? 0) ^ 0xff;
    expectCode(valid, "DECOMPRESSION_FAILED");
  });

  it("keeps no more than the declared size of a GZIP body that inflates far past it", () => {
    // Four MiB of zeros deflates to a few kilobytes; the header declares one KiB.
    const body = new Uint8Array(4 * 1024 * 1024);
    inflated.length = 0;
    expectCode(
      modelFile({ body, compressed: "GZIP", declaredUncompressedSize: 1024 }),
      "SIZE_MISMATCH",
    );
    expect(Math.max(0, ...inflated)).toBeLessThanOrEqual(1024 + 1);
  });

  it("rejects a string longer than the configured byte limit", () => {
    expectCode(modelFile({ body: staticModelBody() }), "INVALID_LENGTH", { maxStringBytes: 2 });
  });

  it("rejects an array longer than the configured element limit", () => {
    expectCode(modelFile({ body: staticModelBody() }), "INVALID_COUNT", { maxArrayElements: 2 });
  });

  it("rejects an attribute set larger than the configured attribute limit", () => {
    const body = attributeSet({
      LODS: new Writer().int32(0).finish(),
      FUTURE_ROOT_FIELD: Uint8Array.of(4, 5),
    });
    expectCode(modelFile({ body }), "INVALID_COUNT", { maxAttributes: 1 });
  });

  it("rejects declared compressed-size mismatches", () => {
    const body = staticModelBody();
    expectCode(modelFile({ body, compressed: "GZIP", declaredCompressedSize: 1 }), "SIZE_MISMATCH");
  });

  it("rejects decoded-size mismatches", () => {
    const body = staticModelBody();
    expectCode(
      modelFile({ body, compressed: "GZIP", declaredUncompressedSize: body.length + 1 }),
      "SIZE_MISMATCH",
    );
  });

  it("rejects negative attribute counts", () => {
    expectCode(modelFile({ body: new Writer().int32(-1).finish() }), "INVALID_COUNT");
  });

  it("rejects unread bytes inside known attributes", () => {
    const body = attributeSet({ LODS: new Writer().int32(0).uint8(99).finish() });
    expectCode(modelFile({ body }), "ATTRIBUTE_SIZE_MISMATCH");
  });

  it("rejects trailing bytes after the root attribute set", () => {
    const body = new Writer().bytes(attributeSet({})).uint8(99).finish();
    expectCode(modelFile({ body }), "ATTRIBUTE_SIZE_MISMATCH");
  });
});
