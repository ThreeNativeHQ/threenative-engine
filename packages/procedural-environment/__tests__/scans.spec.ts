import { readFile } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { bakeCity, bakeRock, bakeVegetation } from "../src/index.js";
import Arbor from "../vendor/arbor.js";

interface IGltf {
  extensionsRequired?: string[];
  images?: { bufferView: number; mimeType: string }[];
  bufferViews: { byteLength: number; byteOffset: number }[];
  accessors: { bufferView: number; count: number }[];
  meshes: { primitives: { attributes: Record<string, number>; material: number }[] }[];
  materials: { name: string }[];
}

async function glb(
  file: string,
): Promise<{ gltf: IGltf; image: (i: number) => Buffer; bin: Buffer }> {
  const bytes = await readFile(file);
  const jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8")) as IGltf;
  const bin = bytes.subarray(28 + jsonLength);
  const image = (i: number) => {
    const view = gltf.bufferViews[gltf.images?.[i]?.bufferView ?? -1];
    if (!view) throw new Error(`no image ${i}`);
    return bin.subarray(view.byteOffset, view.byteOffset + view.byteLength);
  };
  return { bin, gltf, image };
}

describe("Poly Haven scans by default, the generator's texture on request", () => {
  it("wraps an oak in the oak bark scan, as WebP through EXT_texture_webp", async () => {
    const out = await makeTempDir("tn-scan-oak-");
    const [oak] = await bakeVegetation({ preset: "oak", out });
    expect(oak?.scan).toBe("jolcham_oak_bark_01");
    const { gltf, image } = await glb(oak?.path ?? "");
    expect(gltf.extensionsRequired).toEqual(["EXT_texture_webp"]);
    expect(gltf.images?.every((i) => i.mimeType === "image/webp")).toBe(true);
    const scan = await readFile(
      new URL("../scans/jolcham_oak_bark_01-color.webp", import.meta.url),
    );
    expect(image(0).equals(scan)).toBe(true);
  });

  it('keeps Arbor\'s own bark with textures: "generated" (WebP q80: under 3 levels mean error)', async () => {
    const out = await makeTempDir("tn-scan-gen-");
    const [oak] = await bakeVegetation({ preset: "oak", out, textures: "generated" });
    expect(oak?.scan).toBeUndefined();
    const { image } = await glb(oak?.path ?? "");
    const bark = Arbor.barkTexture(Arbor.PRESETS.oak?.bark ?? "oak");
    const got = await sharp(image(0)).ensureAlpha().raw().toBuffer();
    const stride = bark.width * 4;
    let error = 0;
    for (let y = 0; y < bark.height; y++) {
      const want = bark.color.subarray((bark.height - 1 - y) * stride, (bark.height - y) * stride);
      for (let i = 0; i < stride; i++)
        error += Math.abs((got[y * stride + i] as number) - (want[i] as number));
    }
    expect(error / bark.color.length).toBeLessThan(3);
  });

  it("gives Arbor's leaf cards a normal map cooked from their own leaves, and keeps the cutout exact", async () => {
    const out = await makeTempDir("tn-leaf-normal-");
    const [oak] = await bakeVegetation({ preset: "oak", out, textures: "generated" });
    const { gltf, image } = await glb(oak?.path ?? "");
    const foliage = gltf.materials.find((m) => m.name === "foliage") as unknown as {
      normalTexture?: { index: number; scale?: number };
      pbrMetallicRoughness: { roughnessFactor: number };
    };
    expect(foliage.normalTexture?.index).toBe(3);
    // A glossy leaf with a full-strength dome normal reflects the sky as grey-white patches
    // (visual judge, PRD-900): leaves are matte and their relief is gentle.
    expect(foliage.pbrMetallicRoughness.roughnessFactor).toBeGreaterThanOrEqual(0.8);
    expect(foliage.normalTexture?.scale).toBeLessThanOrEqual(0.5);
    const normal = await sharp(image(3)).raw().toBuffer({ resolveWithObject: true });
    let tilted = 0;
    for (let i = 0; i < normal.data.length; i += normal.info.channels)
      if ((normal.data[i + 2] as number) < 250) tilted++;
    expect(tilted / (normal.data.length / normal.info.channels)).toBeGreaterThan(0.05);
    const leaf = Arbor.leafTexture(Arbor.PRESETS.oak ?? "oak", { createCanvas });
    const alpha = await sharp(image(2)).ensureAlpha().extractChannel(3).raw().toBuffer();
    const want = Buffer.alloc(leaf.width * leaf.height);
    for (let i = 0; i < want.length; i++) {
      const y = Math.floor(i / leaf.width);
      want[i] = leaf.data[
        ((leaf.height - 1 - y) * leaf.width + (i % leaf.width)) * 4 + 3
      ] as number;
    }
    expect(alpha.equals(want)).toBe(true);
  });

  it("gives a forest-kit log the wood detail scan and keeps its palette (COLOR_0 doubled times Arbor's untextured bark factor)", async () => {
    const out = await makeTempDir("tn-scan-log-");
    const [scanned] = await bakeVegetation({ preset: "log", out });
    const [plain] = await bakeVegetation({
      preset: "log",
      out: `${out}/plain`,
      textures: "generated",
    });
    expect(scanned?.scan).toBe("bark_brown_02");
    const color = async (file: string) => {
      const { gltf, bin } = await glb(file);
      const accessor = gltf.accessors[gltf.meshes[0]?.primitives[0]?.attributes.COLOR_0 ?? -1];
      const view = gltf.bufferViews[accessor?.bufferView ?? -1];
      return new Float32Array(
        bin.buffer.slice(
          bin.byteOffset + (view?.byteOffset ?? 0),
          bin.byteOffset + (view?.byteOffset ?? 0) + (accessor?.count ?? 0) * 12,
        ),
      );
    };
    const [a, b] = [await color(scanned?.path ?? ""), await color(plain?.path ?? "")];
    expect(a.length).toBe(b.length);
    // The generated log multiplies COLOR_0 by Arbor's bark baseColorFactor; the scanned one has none.
    const bark = [0.35, 0.28, 0.22];
    expect(
      a.every(
        (v, i) => Math.abs(v - Math.min(1, (b[i] as number) * 2 * (bark[i % 3] as number))) < 1e-6,
      ),
    ).toBe(true);
  });

  it("re-encodes an Apex module's PNG and JPEG maps as WebP, and every image still decodes", async () => {
    const out = await makeTempDir("tn-city-webp-");
    const [sidewalk] = await bakeCity({ module: "civic-sidewalk", out });
    const { gltf, image } = await glb(sidewalk?.path ?? "");
    expect(gltf.extensionsRequired).toContain("EXT_texture_webp");
    expect(gltf.images?.length).toBeGreaterThan(0);
    for (const [i, entry] of (gltf.images ?? []).entries()) {
      expect(entry.mimeType).toBe("image/webp");
      expect((await sharp(image(i)).metadata()).format).toBe("webp");
    }
  });

  it("bakes a cliff's next module so the two meet without a seam, and refuses a module on a boulder", async () => {
    const out = await makeTempDir("tn-cliff-module-");
    const [zero] = await bakeRock({ form: "cliff", biome: "coastal", out });
    const [one] = await bakeRock({ form: "cliff", biome: "coastal", module: 1, out });
    expect(one?.path).not.toBe(zero?.path);
    expect(one?.triangles).toBe(zero?.triangles);
    await expect(bakeRock({ form: "boulder", module: 1, out })).rejects.toThrow(
      /tileable form \(cliff\)/,
    );
  });
});
