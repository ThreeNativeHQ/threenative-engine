import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import {
  bakeRock,
  environmentBiomes,
  environmentElements,
  vegetationPresets,
} from "../src/index.js";
import Outcrop from "../vendor/outcrop.js";

interface IGltf {
  accessors: { bufferView: number; componentType: number; count: number; type: string }[];
  bufferViews: { byteLength: number; byteOffset: number }[];
  materials: { extras?: Record<string, unknown>; name: string }[];
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
      "_COVER",
      "_ROCK",
      "_WET",
    ]);
    expect(gltf.materials[0]?.name).toBe("rock");
    expect(gltf.materials[0]?.extras).toMatchObject({ rockTexture: "granite" });
    expect(lod0?.rock?.tile).toBeGreaterThan(0);
    expect(lod0?.bounds.min[1]).toBeLessThanOrEqual(0);
    expect(lod0?.bounds.max[1]).toBeGreaterThan(1);
  });

  it("writes Outcrop's own detail and normal maps beside the GLB, the inputs of its triplanar material", async () => {
    const out = await makeTempDir("tn-rock-maps-");
    const [arch] = await bakeRock({ form: "arch", biome: "desert", seed: 3, out });
    expect(arch?.rock?.texture).toBe("sandstone");
    for (const map of [arch?.rock?.detail, arch?.rock?.normal]) {
      const png = await readFile(map ?? "");
      expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
      expect(png.readUInt32BE(16)).toBe(512);
    }
  });

  it("keeps Outcrop's map bytes exactly, alpha (height, roughness) included", async () => {
    const out = await makeTempDir("tn-rock-png-");
    const [rock] = await bakeRock({ form: "boulder", biome: "volcanic", out });
    const png = await readFile(rock?.rock?.normal ?? "");
    const size = png.readUInt32BE(16);
    expect(png[25]).toBe(6); // RGBA
    const idat: Buffer[] = [];
    for (let at = 8; at < png.length; ) {
      const length = png.readUInt32BE(at);
      if (png.toString("latin1", at + 4, at + 8) === "IDAT")
        idat.push(png.subarray(at + 8, at + 8 + length));
      at += 12 + length;
    }
    const rows = inflateSync(Buffer.concat(idat));
    const want = new Outcrop.RockGenerator().materialFor({
      form: "boulder",
      size: [2.4, 1.8, 2.1],
      surface: { texture: "basalt" },
    }).userData.uniforms.tRockNormal.value.image.data;
    let differ = 0;
    for (let y = 0; y < size; y++) {
      expect(rows[y * (size * 4 + 1)]).toBe(0); // filter 0: the bytes are the pixels
      const got = rows.subarray(y * (size * 4 + 1) + 1, (y + 1) * (size * 4 + 1));
      const row = want.subarray((size - 1 - y) * size * 4, (size - y) * size * 4);
      for (let i = 0; i < got.length; i++) if (got[i] !== row[i]) differ++;
    }
    expect(differ).toBe(0);
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
