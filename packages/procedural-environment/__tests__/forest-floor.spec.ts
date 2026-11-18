import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { IcosahedronGeometry } from "three";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { bakeVegetation, vegetationPresets } from "../src/index.js";

interface IGltf {
  accessors: {
    bufferView: number;
    componentType: number;
    count: number;
    type: string;
  }[];
  bufferViews: { byteLength: number; byteOffset: number }[];
  materials: { alphaMode?: string; doubleSided?: boolean; name: string }[];
  meshes: { primitives: { attributes: Record<string, number> }[] }[];
}

const DEBRIS = ["log", "stump", "twig", "branch", "leaflitter", "rock"] as const;
const COVER = ["reeds", "tussock", "seedgrass", "clover", "dock", "plume"] as const;

function parseGlb(bytes: Buffer): { bin: Buffer; gltf: IGltf } {
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  expect(bytes.readUInt32LE(8)).toBe(bytes.length);
  const jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8")) as IGltf;
  const chunks = 20 + jsonLength;
  expect(bytes.readUInt32LE(chunks + 4)).toBe(0x004e4942);
  const bin = bytes.subarray(chunks + 8, chunks + 8 + bytes.readUInt32LE(chunks));
  return { bin, gltf };
}

/** One float accessor's values, VEC4 assumed for `_WIND`. */
function floats(gltf: IGltf, bin: Buffer, accessor: number): Float32Array {
  const entry = gltf.accessors[accessor];
  if (entry?.componentType !== 5126) throw new Error("expected a float accessor");
  const view = gltf.bufferViews[entry.bufferView];
  if (!view) throw new Error("accessor without a buffer view");
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[entry.type] ?? 1;
  return new Float32Array(bin.buffer, bin.byteOffset + view.byteOffset, entry.count * components);
}

async function bake(preset: string, seed = 7) {
  const out = await makeTempDir("tn-forest-floor-");
  const [baked] = await bakeVegetation({ out, preset, seed });
  const bytes = await readFile(baked?.path ?? "");
  return { baked, bytes, out, ...parseGlb(bytes) };
}

describe("the forest floor bakes from one nature package", () => {
  it("lists the deadwood, litter and stone presets as kind debris", () => {
    const presets = vegetationPresets();
    for (const id of DEBRIS)
      expect(presets.find((preset) => preset.id === id)).toMatchObject({
        kind: "debris",
        name: expect.any(String),
      });
    // The cover Arbor has no answer for, in the same list.
    for (const id of COVER) expect(presets.find((preset) => preset.id === id)?.kind).toBe("cover");
    expect(presets.map((preset) => preset.id)).toHaveLength(new Set(presets.map((p) => p.id)).size);
  });

  it("bakes every debris preset with a zero _WIND and a single primitive: wood and stone opaque bark, litter masked leaves", async () => {
    for (const preset of DEBRIS) {
      const { bytes, gltf, bin } = await bake(preset);
      const primitives = gltf.meshes[0]?.primitives ?? [];
      expect({ count: primitives.length, preset }).toEqual({ count: 1, preset });
      const wind = floats(gltf, bin, primitives[0]?.attributes._WIND as number);
      expect({ preset, nonzero: wind.some((value) => value !== 0) }).toEqual({
        nonzero: false,
        preset,
      });
      for (const attribute of ["POSITION", "NORMAL", "TEXCOORD_0", "COLOR_0", "_WIND"])
        expect(primitives[0]?.attributes).toHaveProperty(attribute);
      // A scanned litter leaf keeps its cutout, so leaf litter rides the masked foliage primitive.
      const material = gltf.materials[0];
      expect({ preset, name: material?.name, alphaMode: material?.alphaMode }).toEqual(
        preset === "leaflitter"
          ? { preset, name: "foliage", alphaMode: "MASK" }
          : { preset, name: "bark", alphaMode: undefined },
      );
      expect(bytes.length).toBeGreaterThan(1000);
    }
  });

  it("keeps the kit's colour under a grey scan: COLOR_0 x mean 0.5 equals the untextured COLOR_0 x Arbor's factor", async () => {
    // Arbor's toGLB multiplies an untextured part by this factor (vendor/arbor.js, toGLB).
    const factor = { bark: [0.35, 0.28, 0.22], foliage: [0.25, 0.4, 0.12] } as const;
    for (const preset of ["log", "leaflitter", "reeds", "tussock"] as const) {
      const out = await makeTempDir("tn-forest-floor-colour-");
      const [plain] = await bakeVegetation({ out, preset, textures: "generated" });
      const [scanned] = await bakeVegetation({ out: `${out}/scans`, preset });
      const a = parseGlb(await readFile(plain?.path ?? ""));
      const b = parseGlb(await readFile(scanned?.path ?? ""));
      const name = a.gltf.materials[0]?.name as keyof typeof factor;
      const before = floats(
        a.gltf,
        a.bin,
        a.gltf.meshes[0]?.primitives[0]?.attributes.COLOR_0 as number,
      );
      const after = floats(
        b.gltf,
        b.bin,
        b.gltf.meshes[0]?.primitives[0]?.attributes.COLOR_0 as number,
      );
      let worst = 0;
      for (let i = 0; i < before.length; i++)
        worst = Math.max(
          worst,
          Math.abs(
            (after[i] as number) * 0.5 - (before[i] as number) * (factor[name][i % 3] as number),
          ),
        );
      expect({ preset, worst: worst < 1e-3 }).toEqual({ preset, worst: true });
    }
  });

  it("writes the same bytes for the same debris preset and seed", async () => {
    for (const preset of ["log", "leaflitter"] as const) {
      const first = await bake(preset, 3);
      const second = await bake(preset, 3);
      expect(createHash("sha256").update(first.bytes).digest("hex")).toBe(
        createHash("sha256").update(second.bytes).digest("hex"),
      );
    }
  });

  it("changes the debris with the seed", async () => {
    const three = await bake("log", 3);
    const four = await bake("log", 4);
    expect(three.bytes.equals(four.bytes)).toBe(false);
  });

  it("bakes the extra cover with its sway in _WIND.z and a double-sided masked foliage", async () => {
    for (const preset of COVER) {
      const { gltf, bin } = await bake(preset);
      const primitive = gltf.meshes[0]?.primitives[0];
      expect({ preset, primitive: primitive !== undefined }).toEqual({ preset, primitive: true });
      const wind = floats(gltf, bin, primitive?.attributes._WIND as number);
      let flutter = 0;
      for (let i = 0; i < wind.length; i += 4) {
        expect(wind[i]).toBe(0);
        expect(wind[i + 1]).toBe(0);
        expect(wind[i + 3]).toBe(0);
        flutter = Math.max(flutter, wind[i + 2] as number);
      }
      expect({ flutter: flutter > 0, preset }).toEqual({ flutter: true, preset });
      expect(gltf.materials.find((entry) => entry.name === "foliage")).toMatchObject({
        alphaMode: "MASK",
        doubleSided: true,
      });
    }
  });

  it("still fails closed on an unknown id, naming the nearest, and on a form patch of a debris preset", async () => {
    const out = path.join(await makeTempDir("tn-forest-floor-"), "none");
    await expect(bakeVegetation({ out, preset: "lgo" })).rejects.toThrow(
      /unknown preset "lgo".*log/u,
    );
    await expect(bakeVegetation({ out, preset: "twiggs" })).rejects.toThrow(/nearest|Nearest/u);
    await expect(bakeVegetation({ out, preset: "log", form: { height: [1, 2] } })).rejects.toThrow(
      /form and leafImage patch an Arbor preset/u,
    );
    await expect(bakeVegetation({ out, preset: "reeds", seed: 1.5 })).rejects.toThrow(
      /seed must be an integer/u,
    );
    await expect(readdir(out)).rejects.toThrow();
  });

  it("writes one file per requested level of detail", async () => {
    const out = await makeTempDir("tn-forest-floor-");
    const baked = await bakeVegetation({ lods: [0, 1], out, preset: "twig", seed: 5 });
    expect(baked.map((entry) => entry.lod)).toEqual([0, 1]);
    expect(await readdir(out)).toEqual(["twig-5-lod0.glb", "twig-5-lod1.glb"]);
    expect(baked[0]?.triangles).toBeGreaterThan(baked[1]?.triangles ?? Number.POSITIVE_INFINITY);
  });
});

describe("forest-kit rock", () => {
  it("is forest-kit's own THREE.IcosahedronGeometry stone: 180 triangles at lod 0 (detail 2), 20 at lod 2", async () => {
    const out = await makeTempDir("tn-kit-rock-");
    const [near, far] = await bakeVegetation({ preset: "rock", seed: 1, lods: [0, 2], out });
    expect(near?.triangles).toBe(new IcosahedronGeometry(1, 2).getAttribute("position").count / 3);
    expect(far?.triangles).toBe(20);
  });
});
