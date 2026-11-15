import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { bakeVegetation, vegetationPresets } from "../src/index.js";

interface IGltf {
  materials: { alphaMode?: string; name: string }[];
  meshes: { primitives: { attributes: Record<string, number> }[] }[];
  images?: unknown[];
}

function parseGlb(bytes: Buffer): IGltf {
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  expect(bytes.readUInt32LE(8)).toBe(bytes.length);
  return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8")) as IGltf;
}

async function bake(options: { lods?: number[]; seed?: number } = {}) {
  const out = await makeTempDir("tn-vegetation-");
  const baked = await bakeVegetation({ out, preset: "oak", seed: 7, ...options });
  return { baked, out };
}

describe("bakeVegetation", () => {
  it("writes identical bytes for the same preset and seed, with wind, colour and uv on both primitives", async () => {
    const first = await bake({ lods: [0, 2] });
    const second = await bake({ lods: [0, 2] });
    const [lod0, lod2] = first.baked;
    expect(first.baked.map((entry) => entry.lod)).toEqual([0, 2]);
    expect(lod0?.triangles).toBeGreaterThan(lod2?.triangles ?? Number.POSITIVE_INFINITY);
    expect(lod0?.bounds.max[1]).toBeGreaterThan(5);
    const bytes = await readFile(lod0?.path ?? "");
    const again = await readFile(second.baked[0]?.path ?? "");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      createHash("sha256").update(again).digest("hex"),
    );
    const gltf = parseGlb(bytes);
    const primitives = gltf.meshes[0]?.primitives ?? [];
    expect(primitives).toHaveLength(2);
    for (const primitive of primitives)
      expect(Object.keys(primitive.attributes)).toEqual(
        expect.arrayContaining(["POSITION", "NORMAL", "TEXCOORD_0", "COLOR_0", "_WIND"]),
      );
    expect(gltf.materials.find((material) => material.name === "foliage")?.alphaMode).toBe("MASK");
    expect(gltf.images?.length).toBe(3);
    expect(await readdir(first.out)).toEqual(["oak-7-lod0.glb", "oak-7-lod2.glb"]);
  });

  it("changes the tree with the seed", async () => {
    const seven = await bake();
    const eight = await bake({ seed: 8 });
    expect(
      (await readFile(seven.baked[0]?.path ?? "")).equals(
        await readFile(eight.baked[0]?.path ?? ""),
      ),
    ).toBe(false);
  });

  it("fails closed on an unknown preset, a fractional seed and a bad lod, naming the cause", async () => {
    const out = path.join(await makeTempDir("tn-vegetation-"), "none");
    await expect(bakeVegetation({ out, preset: "okay" })).rejects.toThrow(
      /unknown preset "okay".*oak/u,
    );
    await expect(bakeVegetation({ out, preset: "oak", seed: 1.5 })).rejects.toThrow(
      /seed must be an integer/u,
    );
    await expect(bakeVegetation({ out, preset: "oak", lods: [3] })).rejects.toThrow(
      /lods must be/u,
    );
    await expect(bakeVegetation({ out, preset: "oak", lods: [] })).rejects.toThrow(/lods must be/u);
    await expect(readdir(out)).rejects.toThrow();
  });

  it("lists the trees with latin names", () => {
    const presets = vegetationPresets();
    expect(presets.find((preset) => preset.id === "oak")).toMatchObject({
      kind: "tree",
      name: "English oak",
    });
    expect(presets.filter((preset) => preset.kind === "tree").length).toBeGreaterThanOrEqual(28);
  });
});
