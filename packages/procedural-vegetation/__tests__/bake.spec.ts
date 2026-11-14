import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
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

  it("grows a game's form patch over the preset, deterministically and under its own file name", async () => {
    const out = await makeTempDir("tn-vegetation-");
    const form = { leaves: [{ count: 40, size: [0.6, 0.45] }], levels: [{ from: 0.2 }] };
    const [plain] = await bakeVegetation({ out, preset: "spruce", seed: 7 });
    const [formed] = await bakeVegetation({ out, preset: "spruce", seed: 7, form });
    const [again] = await bakeVegetation({
      out: await makeTempDir("tn-vegetation-"),
      preset: "spruce",
      seed: 7,
      form,
    });
    expect(formed?.path).not.toBe(plain?.path);
    expect(formed?.triangles).toBeGreaterThan(plain?.triangles ?? Number.POSITIVE_INFINITY);
    const sha = async (file?: string) =>
      createHash("sha256")
        .update(await readFile(file ?? ""))
        .digest("hex");
    expect(await sha(formed?.path)).toBe(await sha(again?.path));
    await expect(bakeVegetation({ out, preset: "spruce", form: { leafs: [] } })).rejects.toThrow(
      /form key "leafs"/u,
    );
    await expect(
      bakeVegetation({ out, preset: "spruce", form: { leaves: [{}, { count: 3 }] } }),
    ).rejects.toThrow(/form\.leaves has 2 rows; spruce has 1/u);
  });

  it("embeds a game's leaf image as the leaf texture, and refuses a file that is not a PNG", async () => {
    const out = await makeTempDir("tn-vegetation-");
    const canvas = createCanvas(64, 64);
    canvas.getContext("2d").fillRect(0, 0, 32, 32);
    const png = canvas.toBuffer("image/png");
    const image = path.join(out, "needles.png");
    await writeFile(image, png);
    const [plain] = await bakeVegetation({ out, preset: "spruce", seed: 7 });
    const [atlas] = await bakeVegetation({ out, preset: "spruce", seed: 7, leafImage: image });
    expect(atlas?.path).not.toBe(plain?.path);
    expect((await readFile(atlas?.path ?? "")).includes(png)).toBe(true);
    const text = path.join(out, "not.png");
    await writeFile(text, "leaves");
    await expect(bakeVegetation({ out, preset: "spruce", leafImage: text })).rejects.toThrow(
      /leafImage .*not\.png is not a PNG/u,
    );
  });

  it("draws a game leaf image's cell 0 from its top-left quadrant", async () => {
    const out = await makeTempDir("tn-vegetation-");
    const canvas = createCanvas(64, 64);
    canvas.getContext("2d").fillRect(0, 0, 32, 32);
    const image = path.join(out, "atlas.png");
    await writeFile(image, canvas.toBuffer("image/png"));
    const form = { leaves: [{ cells: [0] }] };
    const [baked] = await bakeVegetation({
      out,
      preset: "spruce",
      seed: 7,
      form,
      leafImage: image,
    });
    const bytes = await readFile(baked?.path ?? "");
    const gltf = parseGlb(bytes) as IGltf & {
      accessors: { bufferView: number; count: number }[];
      bufferViews: { byteOffset?: number }[];
    };
    const leaves = gltf.meshes[0]?.primitives[1]?.attributes.TEXCOORD_0 ?? -1;
    const accessor = gltf.accessors[leaves];
    expect(accessor).toBeDefined();
    const binary = 20 + bytes.readUInt32LE(12) + 8;
    const start = binary + (gltf.bufferViews[accessor?.bufferView ?? 0]?.byteOffset ?? 0);
    let [uMax, vMax] = [0, 0];
    for (let i = 0; i < (accessor?.count ?? 0); i++) {
      uMax = Math.max(uMax, bytes.readFloatLE(start + i * 8));
      vMax = Math.max(vMax, bytes.readFloatLE(start + i * 8 + 4));
    }
    // glTF puts v = 0 at the image's top row, so the top-left quadrant is u and v below a half.
    expect([uMax, vMax].every((value) => value > 0 && value < 0.5)).toBe(true);
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
