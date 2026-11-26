import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { bakeRail, bakeStation, bakeTavern, bakeWorkshop } from "../src/index.js";

async function glb(file: string) {
  const bytes = await readFile(file);
  const size = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + size).toString()) as {
    images?: { mimeType: string }[];
    nodes: { name: string; translation?: number[] }[];
    materials: {
      name: string;
      emissiveFactor?: number[];
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

describe("Procedural static kit materials", () => {
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

  it("restyles every repeated station part and retains the corridor sockets", async () => {
    const out = await makeTempDir("tn-station-finish-");
    const options = { module: "station-elbow", out, roof: true } as const;
    const [stock] = await bakeStation(options);
    const [variant] = await bakeStation({
      ...options,
      materials: {
        hull: { color: "#8a3b19", map: await png("#b98e65") },
        light: { emissive: "#ff0000", emissiveIntensity: 2 },
      },
    });
    if (!stock || !variant) throw new Error("Missing station variation");
    expect(variant.path).not.toBe(stock.path);
    expect(variant.bounds).toEqual(stock.bounds);
    expect(stock.materialSlots).toEqual(expect.arrayContaining(["hull", "light"]));
    const [plain, styled] = await Promise.all([glb(stock.path), glb(variant.path)]);
    expect(styled.nodes).toEqual(plain.nodes);
    expect(styled.images?.map(({ mimeType }) => mimeType)).toEqual(["image/webp"]);
    expect(styled.materials.filter(({ name }) => name === "Station structural alloy")).toEqual([
      expect.objectContaining({
        pbrMetallicRoughness: expect.objectContaining({ baseColorTexture: expect.any(Object) }),
      }),
    ]);
    expect(
      styled.materials.find(({ name }) => name === "Station light strips")?.emissiveFactor,
    ).toEqual([1, 0, 0]);
  });

  it("reports the running surface slot without changing track placement", async () => {
    const out = await makeTempDir("tn-rail-finish-");
    const options = { module: "rail-curve", out } as const;
    const [stock] = await bakeRail(options);
    const map = await png("#674e40");
    const [variant] = await bakeRail({
      ...options,
      materials: { running: { color: "#8dcedd" }, wood: { map }, lightWood: { map } },
    });
    if (!stock || !variant) throw new Error("Missing rail variation");
    expect(variant.materialSlots).toContain("running");
    expect(variant.path).not.toBe(stock.path);
    const styled = await glb(variant.path);
    expect(styled.nodes).toEqual((await glb(stock.path)).nodes);
    expect(styled.images?.map(({ mimeType }) => mimeType)).toEqual(["image/webp"]);
  });
});
