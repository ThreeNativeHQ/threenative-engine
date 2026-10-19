import { describe, expect, it } from "vitest";
import { imageQuality } from "../src/image-quality.js";
import { formatTextureQualityTotals } from "../src/report.js";
import { formatModelSizes, formatSkippedCompression, formatTextureSizes } from "../src/report.js";
import type { IModelSizeRow, ISkippedCompressionRow, ITextureSizeRow } from "../src/report.js";

describe("formatTextureSizes", () => {
  it("prints per-image measurements and build floor totals", () => {
    const data = new Uint8Array(4 * 4 * 4).fill(255);
    const quality = {
      ...imageQuality(data, data, 4, 4),
      sourceWidth: 8,
      sourceHeight: 8,
      codec: "etc1s",
    };
    const lines = formatTextureSizes([
      { after: 10, before: 20, format: "etc1s", logicalPath: "flat.png", quality },
    ]);
    expect(lines.join("\n")).toContain("SSIM 1.0000; mean ΔE00 0.000");
    expect(lines.join("\n")).toContain("source 8x8 -> comparison 4x4");
    expect(formatTextureQualityTotals([quality])).toContain(
      "1 measured; 1 pass; 0 below-floor; 0 unvalidated-slots",
    );
  });
  it("should report a smaller total after compression", async () => {
    const rows: readonly ITextureSizeRow[] = [
      { after: 51_234, before: 184_320, format: "etc1s", logicalPath: "rock.png" },
      { after: 210_000, before: 700_000, format: "uastc", logicalPath: "props/decal.png" },
    ];
    const lines = formatTextureSizes(rows);

    expect(lines).toEqual([
      "texture rock.png (etc1s): 184320 -> 51234 bytes (-72.2%)",
      "texture props/decal.png (uastc): 700000 -> 210000 bytes (-70.0%)",
      "textures total: 884320 -> 261234 bytes (-70.5%)",
    ]);
    // The gate this report exists for: the total must actually be smaller.
    const total = lines.find((line) => line.startsWith("textures total"));
    expect(total).toBeDefined();
    const [before, after] = (total ?? "").match(/(\d+) -> (\d+)/u)?.slice(1, 3) ?? ["0", "0"];
    expect(Number(after)).toBeLessThan(Number(before));
  });

  it("should print nothing when no texture was compressed", () => {
    expect(formatTextureSizes([])).toEqual([]);
  });

  it("should name the reason on a row whose bytes were retained rather than compressed", () => {
    const rows: readonly ITextureSizeRow[] = [
      { after: 51_234, before: 184_320, format: "etc1s", logicalPath: "rock.png" },
      {
        after: 512,
        before: 512,
        compressionSkipped: "block-size",
        format: undefined,
        logicalPath: "ui/decal.png",
      },
    ];

    expect(formatTextureSizes(rows)).toEqual([
      "texture rock.png (etc1s): 184320 -> 51234 bytes (-72.2%)",
      "texture ui/decal.png: 512 -> 512 bytes (-0.0%); compression skipped: block-size",
      "textures total: 184832 -> 51746 bytes (-72.0%)",
    ]);
  });
});

describe("formatModelSizes", () => {
  it("names each retained embedded image and its compression fallback", () => {
    const lines = formatModelSizes([
      {
        after: 100,
        before: 100,
        logicalPath: "prop.glb",
        embeddedTextures: {
          bytesAfter: 50,
          bytesBefore: 50,
          count: 2,
          gpuBytesAfter: 100,
          gpuBytesBefore: 100,
          resized: 0,
          skippedCompression: { decal: "block-size", tiny: "not-smaller" },
        },
      },
    ]);
    expect(lines).toContain("embedded texture prop.glb#decal: compression skipped: block-size");
    expect(lines).toContain("embedded texture prop.glb#tiny: compression skipped: not-smaller");
  });

  it("should report fewer bytes and the geometry count after the model pass", () => {
    const rows: readonly IModelSizeRow[] = [
      {
        after: 9_120,
        before: 24_576,
        extensions: ["EXT_meshopt_compression", "KHR_mesh_quantization"],
        logicalPath: "characters/knight.glb",
        triangles: 4_096,
      },
    ];
    const lines = formatModelSizes(rows);

    expect(lines).toEqual([
      "model characters/knight.glb (EXT_meshopt_compression, KHR_mesh_quantization): 24576 -> 9120 bytes (-62.9%), 4096 triangle(s)",
      "models total: 24576 -> 9120 bytes (-62.9%)",
    ]);
    // The gate this report exists for: the total must actually be smaller.
    const total = lines.find((line) => line.startsWith("models total"));
    expect(total).toBeDefined();
    const [before, after] = (total ?? "").match(/(\d+) -> (\d+)/u)?.slice(1, 3) ?? ["0", "0"];
    expect(Number(after)).toBeLessThan(Number(before));
  });

  it("should print nothing when no model was optimized", () => {
    expect(formatModelSizes([])).toEqual([]);
  });

  it("should report the baked lightmap cost and atlas occupancy", () => {
    const lines = formatModelSizes([
      {
        after: 3_780,
        before: 2_336,
        lightmap: {
          atlasHeight: 68,
          atlasWidth: 76,
          bakeMs: 12.34,
          bytesAfter: 1_402,
          bytesBefore: 20_672,
          dilatedTexels: 48,
          occludedTexels: 12,
          validTexels: 320,
        },
        logicalPath: "static-light.glb",
      },
    ]);

    expect(lines[1]).toBe(
      "lightmap static-light.glb: atlas 76x68, 320 valid + 48 dilated texels, 12 occluded, 20672 -> 1402 bytes (-93.2%), bake 12.3 ms",
    );
  });
});

describe("formatSkippedCompression", () => {
  it("reports missing decoders without inferring that the selected engine has no WASM", () => {
    const lines = formatSkippedCompression([
      { kind: "texture", files: 1, bytes: 128, reason: "platform" },
    ]);
    expect(lines[0]).toContain("no qualified KTX2 decoder");
    expect(lines[0]).not.toContain("no WebAssembly");
  });

  it("names the decoder capability that a target skipped without blaming dedupe", () => {
    const rows: readonly ISkippedCompressionRow[] = [
      { bytes: 240, files: 2, kind: "model", reason: "platform" },
      { bytes: 120, files: 1, kind: "texture", reason: "platform" },
    ];
    const lines = formatSkippedCompression(rows);

    expect(lines[0]).toContain("meshopt");
    expect(lines[0]).toContain("KTX2");
    expect(lines[1]).toContain("KTX2");
    expect(lines.join("\n")).not.toContain("dedupe");
  });
});

describe("formatModelSizes join reporting", () => {
  const base = {
    after: 10,
    before: 10,
    logicalPath: "carrier.glb",
  } as const;
  const policy = {
    byteOverhead: 0,
    diagnostics: [],
    errorTargets: [0.06],
    fingerprint: "abcdef0123456789",
    generated: 0,
    join: true,
    levels: 0,
    maxLevels: 1,
    minSaving: 0.2,
    minTriangles: 128,
    minTrianglesScope: "asset",
    preset: "balanced",
    reasons: [],
    runtime: { hysteresis: 0.15, maxPixelError: 1 },
    skipped: 0,
    trianglesAfter: 0,
    trianglesBefore: 0,
  } as const;

  it("states the primitives a rung collapsed and the draws it produced", () => {
    const lines = formatModelSizes([
      {
        ...base,
        lod: {
          ...policy,
          joined: {
            draws: 3,
            groups: [
              { material: "mat0", primitives: 100, triangles: 34_000 },
              { material: "mat1", primitives: 100, triangles: 34_000 },
              { material: "mat2", primitives: 100, triangles: 34_000 },
            ],
            primitives: 300,
            triangles: 102_000,
            trianglesBefore: 360_000,
          },
        },
      },
    ]);
    expect(
      lines.some((line) => line.includes("join collapsed 300 primitive(s) into 3 draw(s)")),
    ).toBe(true);
  });

  it("says when join was requested and collapsed nothing, instead of implying a collapse", () => {
    const lines = formatModelSizes([{ ...base, lod: { ...policy } }]);
    expect(
      lines.some((line) => line.includes("join was requested but no material group collapsed")),
    ).toBe(true);
  });
});

describe("formatModelSizes compaction reporting", () => {
  it("names the nodes flattened, the primitives joined and every protected node", () => {
    const lines = formatModelSizes([
      {
        after: 100,
        before: 200,
        logicalPath: "carrier.glb",
        compact: {
          flatten: { enabled: true, reparented: 112 },
          instance: { batches: 0, enabled: true, instances: 0, reason: "no shared mesh" },
          join: { enabled: true, primitivesAfter: 20, primitivesBefore: 40 },
          nodesAfter: 34,
          nodesBefore: 146,
          primitivesAfter: 20,
          primitivesBefore: 40,
          removed: ["Gone"],
          protected: [
            { name: "propeller_01", rule: "regex" },
            { name: "Head", rule: "skin-joint" },
          ],
        },
      },
    ]);
    const line = lines.find((entry) => entry.startsWith("compact carrier.glb:"));
    expect(line).toContain("flatten moved 112 node(s)");
    expect(line).toContain("join 40 -> 20 primitive(s)");
    expect(line).toContain("instance none (no shared mesh)");
    expect(line).toContain("protected propeller_01 (regex), Head (skin-joint)");
    expect(line).toContain("removed named node(s) Gone");
  });
});
