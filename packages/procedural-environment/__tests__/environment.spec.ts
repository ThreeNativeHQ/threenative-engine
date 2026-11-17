import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import {
  bakeRock,
  environmentBiomes,
  environmentElements,
  vegetationPresets,
} from "../src/index.js";

interface IGltf {
  accessors: { bufferView: number; componentType: number; count: number; type: string }[];
  bufferViews: { byteLength: number; byteOffset: number }[];
  materials: { name: string }[];
  meshes: { primitives: { attributes: Record<string, number> }[] }[];
}

function parseGlb(bytes: Buffer): { bin: Buffer; gltf: IGltf } {
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  expect(bytes.readUInt32LE(8)).toBe(bytes.length);
  const jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8")) as IGltf;
  const chunks = 20 + jsonLength;
  return { bin: bytes.subarray(chunks + 8, chunks + 8 + bytes.readUInt32LE(chunks)), gltf };
}

/** The mean linear RGB of a rock's COLOR_0. */
function meanColour(bytes: Buffer): [number, number, number] {
  const { bin, gltf } = parseGlb(bytes);
  const accessor = gltf.accessors[gltf.meshes[0]?.primitives[0]?.attributes.COLOR_0 ?? -1];
  const view = gltf.bufferViews[accessor?.bufferView ?? -1];
  if (!accessor || !view) throw new Error("rock GLB has no COLOR_0");
  const rgb = new Float32Array(bin.buffer, bin.byteOffset + view.byteOffset, accessor.count * 3);
  const sum = [0, 0, 0];
  for (let i = 0; i < rgb.length; i++) sum[i % 3] = (sum[i % 3] as number) + (rgb[i] as number);
  return sum.map((value) => value / accessor.count) as [number, number, number];
}

describe("environment elements are found by biome", () => {
  it("puts every preset and rock form in a biome, and every biome row names a real element", () => {
    const elements = environmentElements();
    const ids = elements.map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(vegetationPresets().map((preset) => preset.id)));
    expect(elements.filter((element) => element.biomes.length === 0).map((e) => e.id)).toEqual([]);
    for (const biome of environmentBiomes())
      expect(biome.elements.filter((id) => !ids.includes(id))).toEqual([]);
  });

  it("filters by biome word, kind and search, and fails closed on an unknown biome or kind", () => {
    const desertRocks = environmentElements({ biome: "canyon", kind: "rock" });
    expect(desertRocks.map((element) => element.id)).toEqual(
      expect.arrayContaining(["mesa", "hoodoo", "arch"]),
    );
    expect(desertRocks.every((element) => element.bake.includes('biome: "desert"'))).toBe(true);
    expect(environmentElements({ biome: "jungle", kind: "tree" }).map((e) => e.id)).toContain(
      "kapok",
    );
    expect(environmentElements({ search: "palm" }).map((element) => element.id)).toEqual(
      expect.arrayContaining(["coconut", "fanpalm"]),
    );
    expect(environmentElements({ search: "swamp debris" }).map((e) => e.id)).toContain("log");
    expect(() => environmentElements({ biome: "desrt" })).toThrow(/Nearest ids: desert/);
    expect(() => environmentElements({ kind: "cloud" as "rock" })).toThrow(/unknown kind/);
  });
});

describe("bakeRock writes a rock GLB for a biome", () => {
  it("writes the same bytes twice, fewer triangles per lod, resting on y = 0", async () => {
    const out = await makeTempDir("tn-rock-");
    const first = await bakeRock({ form: "boulder", biome: "forest", seed: 3, lods: [0, 1], out });
    const again = await bakeRock({
      form: "boulder",
      biome: "forest",
      seed: 3,
      lods: [0],
      out: `${out}/again`,
    });
    const [lod0, lod1] = first;
    expect(lod0?.path).toMatch(/boulder-forest-3-lod0\.glb$/);
    expect(lod1?.triangles).toBeLessThan(lod0?.triangles ?? 0);
    const bytes = await readFile(lod0?.path ?? "");
    expect(bytes.equals(await readFile(again[0]?.path ?? ""))).toBe(true);
    const { gltf } = parseGlb(bytes);
    expect(Object.keys(gltf.meshes[0]?.primitives[0]?.attributes ?? {}).sort()).toEqual([
      "COLOR_0",
      "NORMAL",
      "POSITION",
    ]);
    expect(gltf.materials[0]?.name).toBe("rock");
    expect(lod0?.bounds.min[1]).toBeLessThanOrEqual(0);
    expect(lod0?.bounds.max[1]).toBeGreaterThan(1);
  });

  it("colours the rock by biome: desert sandstone is redder than tundra granite", async () => {
    const out = await makeTempDir("tn-rock-biome-");
    const [desert] = await bakeRock({ form: "slab", biome: "desert", out });
    const [tundra] = await bakeRock({ form: "slab", biome: "tundra", out });
    const [r, , b] = meanColour(await readFile(desert?.path ?? ""));
    const [tr, , tb] = meanColour(await readFile(tundra?.path ?? ""));
    expect(r - b).toBeGreaterThan(tr - tb + 0.05);
  });

  it("fails closed on an unknown form, biome, trait or surface key, seed or detail", async () => {
    const out = await makeTempDir("tn-rock-bad-");
    await expect(bakeRock({ form: "bouldr", out })).rejects.toThrow(/Nearest ids: boulder/);
    await expect(bakeRock({ form: "cliff", biome: "moon", out })).rejects.toThrow(/unknown biome/);
    await expect(bakeRock({ form: "cliff", traits: { spikiness: 1 }, out })).rejects.toThrow(
      /traits key "spikiness"/,
    );
    await expect(bakeRock({ form: "cliff", surface: { glow: 1 }, out })).rejects.toThrow(
      /surface key "glow"/,
    );
    await expect(bakeRock({ form: "cliff", seed: 1.5, out })).rejects.toThrow(/seed/);
    await expect(bakeRock({ form: "cliff", detail: 2, out })).rejects.toThrow(/detail/);
  });
});
