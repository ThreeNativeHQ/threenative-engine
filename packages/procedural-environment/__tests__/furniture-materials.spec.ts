import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { bakeTavern, bakeWorkshop } from "../src/index.js";

async function glb(file: string) {
  const bytes = await readFile(file);
  const size = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + size).toString()) as {
    images?: { mimeType: string }[];
    nodes: { name: string; translation?: number[] }[];
    materials: {
      name: string;
      normalTexture?: { scale?: number };
      pbrMetallicRoughness: {
        baseColorFactor?: number[];
        baseColorTexture?: object;
        roughnessFactor?: number;
        metallicFactor?: number;
        metallicRoughnessTexture?: object;
      };
    }[];
  };
}

const png = (background: string) =>
  sharp({ create: { width: 64, height: 64, channels: 3, background } })
    .png()
    .toBuffer();

describe("Procedural furniture materials", () => {
  it.each([
    [bakeTavern, "tavern-table", "tavern-tabletop"],
    [bakeWorkshop, "workshop-workbench", "worktop"],
  ] as const)(
    "shares wood finishes with identical geometry and anchors",
    async (bake, module, anchor) => {
      const out = await makeTempDir("tn-wood-finish-");
      const [stock] = await bake({ module, out });
      const [rough] = await bake({ module, out, woodFinish: "rough-wood" });
      const [solid] = await bake({ module, out, woodFinish: "solid" });
      if (!stock || !rough || !solid) throw new Error("Missing finish bakes");
      const a = await glb(stock.path);
      const b = await glb(rough.path);
      const c = await glb(solid.path);
      expect(a.nodes.some(({ name }) => name === anchor)).toBe(true);
      expect(b.nodes).toEqual(a.nodes);
      expect(c.nodes).toEqual(a.nodes);
      expect(rough.bounds).toEqual(stock.bounds);
      expect(solid.triangles).toBe(stock.triangles);
      expect(rough.path).toMatch(/-rough-wood\.glb$/u);
      expect(b.images?.map(({ mimeType }) => mimeType)).toEqual(["image/webp", "image/webp"]);
      expect(c.images ?? []).toEqual([]);
    },
  );

  it("bakes custom maps and per-slot PBR values with deterministic names", async () => {
    const out = await makeTempDir("tn-material-override-");
    const [map, normalMap, roughnessMap] = await Promise.all([
      png("#3485c3"),
      png("#8380ff"),
      png("#555555"),
    ]);
    const wood = { color: "#ffffff", map, normalMap, normalStrength: 0.34, roughnessMap };
    const iron = { color: "#ff0000", roughness: 0.21, metalness: 0.68 };
    const palette = { wood, iron };
    const config = { module: "tavern-table", woodFinish: "solid", out } as const;
    const [entry] = await bakeTavern({ ...config, materials: palette });
    const [same] = await bakeTavern({ ...config, materials: { iron, wood } });
    const [different] = await bakeTavern({
      ...config,
      materials: { wood: { ...wood, map: await png("#78a543") }, iron },
    });
    if (!entry || !same || !different) throw new Error("Missing custom material bakes");
    const doc = await glb(entry.path);
    expect(entry.path).toBe(same.path);
    expect(entry.path).not.toBe(different.path);
    expect(doc.images?.map(({ mimeType }) => mimeType)).toEqual([
      "image/webp",
      "image/webp",
      "image/webp",
    ]);
    expect(doc.materials.find(({ name }) => name.includes("timber"))).toMatchObject({
      normalTexture: { scale: 0.34 },
      pbrMetallicRoughness: {
        baseColorTexture: { index: expect.any(Number) },
        metallicRoughnessTexture: { index: expect.any(Number) },
      },
    });
    expect(
      doc.materials.find(({ name }) => name.includes("iron"))?.pbrMetallicRoughness,
    ).toMatchObject({
      baseColorFactor: [1, 0, 0, 1],
      roughnessFactor: 0.21,
      metallicFactor: 0.68,
    });
  });

  it("clears inherited maps and rejects material slots absent from the selected model", async () => {
    const out = await makeTempDir("tn-material-validation-");
    const [entry] = await bakeTavern({
      module: "tavern-table",
      out,
      materials: { wood: { map: null, normalMap: null } },
    });
    if (!entry) throw new Error("Missing flat-material bake");
    expect((await glb(entry.path)).images ?? []).toEqual([]);
    await expect(
      bakeWorkshop({
        module: "workshop-wall-sconce",
        out,
        materials: { wood: { color: "#333333" } },
      }),
    ).rejects.toThrow(/wood/u);
    await expect(
      bakeTavern({ module: "tavern-table", out, materials: { wood: { roughness: 1.1 } } }),
    ).rejects.toThrow(/roughness/u);
  });
});
