import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRLightsPunctual } from "@gltf-transform/extensions";
import { read as readKtx2 } from "ktx-parse";
import { describe, expect, it } from "vitest";
import { createLightmapPass, lightmapPass } from "../src/passes/lightmap.js";
import { modelPass } from "../src/passes/model.js";

async function staticGlb(animated = false, indexed = true): Promise<Buffer> {
  const document = new Document();
  const buffer = document.createBuffer("static");
  const positions = document
    .createAccessor("positions")
    .setType("VEC3")
    .setArray(
      new Float32Array(
        indexed
          ? [-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]
          : [-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, -1, 1, 0, 1, -1, 0, 1],
      ),
    )
    .setBuffer(buffer);
  const normals = document
    .createAccessor("normals")
    .setType("VEC3")
    .setArray(new Float32Array(Array.from({ length: indexed ? 4 : 6 }, () => [0, 1, 0]).flat()))
    .setBuffer(buffer);
  const uv0 = document
    .createAccessor("uv0")
    .setType("VEC2")
    .setArray(
      new Float32Array(indexed ? [0, 0, 1, 0, 1, 1, 0, 1] : [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]),
    )
    .setBuffer(buffer);
  const indices = document
    .createAccessor("indices")
    .setType("SCALAR")
    .setArray(new Uint16Array([0, 1, 2, 0, 2, 3]))
    .setBuffer(buffer);
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", positions)
    .setAttribute("NORMAL", normals)
    .setAttribute("TEXCOORD_0", uv0)
    .setMaterial(document.createMaterial("stone"));
  if (indexed) primitive.setIndices(indices);
  const mesh = document.createMesh("floor").addPrimitive(primitive);
  const node = document.createNode("floor").setMesh(mesh);
  const scene = document.createScene("scene").addChild(node);
  const lights = document.createExtension(KHRLightsPunctual);
  const light = lights.createLight("bake-light").setType("point").setIntensity(1);
  scene.addChild(
    document
      .createNode("bake-light")
      .setTranslation([0, 3, 0])
      .setExtension("KHR_lights_punctual", light),
  );
  if (animated) {
    const input = document
      .createAccessor("times")
      .setType("SCALAR")
      .setArray(new Float32Array([0, 1]));
    const output = document
      .createAccessor("translations")
      .setType("VEC3")
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0]));
    const sampler = document
      .createAnimationSampler()
      .setInput(input)
      .setOutput(output)
      .setInterpolation("LINEAR");
    const channel = document
      .createAnimationChannel()
      .setTargetPath("translation")
      .setTargetNode(node)
      .setSampler(sampler);
    document.createAnimation("walk").addSampler(sampler).addChannel(channel);
  }
  return Buffer.from(await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(document));
}

async function readPrimitive(buffer: Buffer) {
  const document = await new NodeIO().registerExtensions(ALL_EXTENSIONS).readBinary(buffer);
  const primitive = document.getRoot().listMeshes()[0]?.listPrimitives()[0];
  if (primitive === undefined) throw new Error("fixture primitive missing");
  return primitive;
}

function uniquePositions(primitive: Awaited<ReturnType<typeof readPrimitive>>): string[] {
  const values = primitive.getAttribute("POSITION")?.getArray() ?? [];
  const rows: string[] = [];
  for (let index = 0; index < values.length; index += 3) {
    rows.push(`${String(values[index])},${String(values[index + 1])},${String(values[index + 2])}`);
  }
  return [...new Set(rows)].sort();
}

describe("lightmapPass", () => {
  it("separates mobile lightmap cache keys while preserving the public Basis key", () => {
    const options = { atlasSize: 128, padding: 2 };
    const basis = lightmapPass(options);
    expect(basis.cacheKey).toBe(JSON.stringify(options));
    expect(createLightmapPass(options, false).cacheKey).toBe(basis.cacheKey);
    expect(createLightmapPass(options, true).cacheKey).not.toBe(basis.cacheKey);
  });

  it("writes TEXCOORD_1 for every baked primitive and preserves TEXCOORD_0", async () => {
    const input = await staticGlb();
    const source = await readPrimitive(input);
    const sourceUv0 = [...(source.getAttribute("TEXCOORD_0")?.getArray() ?? [])];

    const output = await lightmapPass({ atlasSize: 128, padding: 2 }).apply(input, "room.glb");
    const compiled = await readPrimitive(Buffer.isBuffer(output) ? output : output.buffer);

    expect(compiled.getAttribute("TEXCOORD_1")?.getCount()).toBeGreaterThan(0);
    expect([...(compiled.getAttribute("TEXCOORD_0")?.getArray() ?? [])]).toEqual(sourceUv0);
    expect(uniquePositions(compiled)).toEqual(uniquePositions(source));
    expect(compiled.getMaterial()?.getName()).toBe("stone");
    if (Buffer.isBuffer(output)) throw new Error("lightmap auxiliary output missing");
    const atlas = output.entry?.lightmapAtlas as { height?: number; width?: number } | undefined;
    expect(atlas?.width).toSatisfy((width: number) => width % 4 === 0);
    expect(atlas?.height).toSatisfy((height: number) => height % 4 === 0);
    const lightmap = output.auxiliaryOutputs?.[0]?.buffer;
    if (lightmap === undefined) throw new Error("lightmap auxiliary bytes missing");
    expect(readKtx2(lightmap).levelCount).toBeGreaterThan(1);
  });

  it("keeps generated TEXCOORD_1 through model pruning when no texture references UVs", async () => {
    const unwrapped = await lightmapPass({ atlasSize: 128, padding: 2 }).apply(
      await staticGlb(),
      "room.glb",
    );
    if (Buffer.isBuffer(unwrapped)) throw new Error("lightmap pass returned no metadata");
    const optimized = await modelPass({
      passes: { dedup: false, meshopt: false, prune: true, quantize: false, reorder: false },
      preserveLightmapUv: true,
    }).apply(unwrapped.buffer, "room.glb");
    if (Buffer.isBuffer(optimized)) throw new Error("model pass returned an unchanged buffer");

    const compiled = await readPrimitive(optimized.buffer);
    expect(compiled.getAttribute("TEXCOORD_1")?.getCount()).toBeGreaterThan(0);
  });

  it("is deterministic across independent pass instances", async () => {
    const input = await staticGlb();
    const first = await lightmapPass({ atlasSize: 128, padding: 2 }).apply(input, "room.glb");
    const second = await lightmapPass({ atlasSize: 128, padding: 2 }).apply(input, "room.glb");
    const firstBuffer = Buffer.isBuffer(first) ? first : first.buffer;
    const secondBuffer = Buffer.isBuffer(second) ? second : second.buffer;

    expect(firstBuffer.equals(secondBuffer)).toBe(true);
    if (Buffer.isBuffer(first) || Buffer.isBuffer(second)) {
      throw new Error("determinism fixture expected auxiliary lightmaps");
    }
    const firstLightmap = first.auxiliaryOutputs?.[0]?.buffer;
    const secondLightmap = second.auxiliaryOutputs?.[0]?.buffer;
    if (firstLightmap === undefined || secondLightmap === undefined) {
      throw new Error("determinism fixture lightmap bytes missing");
    }
    expect(firstLightmap.equals(secondLightmap)).toBe(true);
  });

  it("fails closed on unsupported animated meshes", async () => {
    const input = await staticGlb(true);

    await expect(
      lightmapPass({ atlasSize: 128, padding: 2 }).apply(input, "animated-room.glb"),
    ).rejects.toThrow("TN_ASSETS_LIGHTMAP_UNSUPPORTED_ANIMATION");
  });

  it("indexes a non-indexed primitive without losing its attributes", async () => {
    const input = await staticGlb(false, false);

    const output = await lightmapPass({ atlasSize: 128, padding: 2 }).apply(input, "floor.glb");
    const compiled = await readPrimitive(Buffer.isBuffer(output) ? output : output.buffer);

    expect(compiled.getIndices()?.getCount()).toBeGreaterThan(0);
    expect(compiled.getAttribute("POSITION")?.getCount()).toBeGreaterThan(0);
    expect(compiled.getAttribute("NORMAL")?.getCount()).toBeGreaterThan(0);
    expect(compiled.getAttribute("TEXCOORD_0")?.getCount()).toBeGreaterThan(0);
    expect(compiled.getAttribute("TEXCOORD_1")?.getCount()).toBeGreaterThan(0);
  });
});

describe("lightmapPass config validation", () => {
  it("rejects an atlas size that is not a multiple of four", () => {
    expect(() => lightmapPass({ atlasSize: 130, padding: 2 })).toThrow(
      "TN_ASSETS_LIGHTMAP_CONFIG_INVALID",
    );
  });

  it("rejects a non-positive atlas size or padding", () => {
    expect(() => lightmapPass({ atlasSize: 0, padding: 2 })).toThrow(
      "TN_ASSETS_LIGHTMAP_CONFIG_INVALID",
    );
    expect(() => lightmapPass({ atlasSize: 128, padding: 0 })).toThrow(
      "TN_ASSETS_LIGHTMAP_CONFIG_INVALID",
    );
  });

  it("names an unreadable GLB with the lightmap error code", async () => {
    await expect(
      lightmapPass({ atlasSize: 128, padding: 2 }).apply(Buffer.from("garbage"), "room.glb"),
    ).rejects.toThrow("TN_ASSETS_LIGHTMAP_UNREADABLE");
  });

  /** One lit primitive whose POSITION accessor is the given array, so the geometry guards see it. */
  async function primitiveGlb(positions: Float32Array | Int16Array): Promise<Buffer> {
    const document = new Document();
    const buffer = document.createBuffer("primitive");
    const accessor = document
      .createAccessor("positions")
      .setType("VEC3")
      .setArray(positions)
      .setBuffer(buffer);
    const primitive = document.createPrimitive().setAttribute("POSITION", accessor);
    const mesh = document.createMesh("primitive").addPrimitive(primitive);
    const lights = document.createExtension(KHRLightsPunctual);
    const light = lights.createLight("bake-light").setType("point").setIntensity(1);
    const scene = document
      .createScene("scene")
      .addChild(document.createNode("primitive").setMesh(mesh));
    scene.addChild(
      document
        .createNode("bake-light")
        .setTranslation([0, 3, 0])
        .setExtension("KHR_lights_punctual", light),
    );
    return Buffer.from(await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(document));
  }

  it("rejects positions that are not Float32 with the geometry code", async () => {
    const input = await primitiveGlb(new Int16Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));

    await expect(
      lightmapPass({ atlasSize: 128, padding: 2 }).apply(input, "quantized.glb"),
    ).rejects.toThrow("TN_ASSETS_LIGHTMAP_GEOMETRY_UNSUPPORTED");
  });

  it("rejects a primitive past the 65,535-vertex limit of the atlas packer", async () => {
    // 65,538 vertices is a whole number of triangles and one past the Uint16 index range.
    const input = await primitiveGlb(new Float32Array(65_538 * 3));

    await expect(
      lightmapPass({ atlasSize: 128, padding: 2 }).apply(input, "dense.glb"),
    ).rejects.toThrow("TN_ASSETS_LIGHTMAP_GEOMETRY_UNSUPPORTED");
  });
});
