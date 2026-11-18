import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { bakeCity, environmentElements } from "../src/index.js";

interface IGltf {
  accessors: { count: number }[];
  images?: { mimeType: string }[];
  meshes: { primitives: { attributes: Record<string, number>; indices?: number }[] }[];
  nodes: { extras?: Record<string, unknown> }[];
  textures?: unknown[];
}

function parseGlb(bytes: Buffer): IGltf {
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  expect(bytes.readUInt32LE(8)).toBe(bytes.length);
  return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8")) as IGltf;
}

const CATEGORIES = [
  "Roads",
  "Buildings",
  "Street Props",
  "Vehicles",
  "Race Kit",
  "Blocks & Lots",
  "Sidewalks",
  "Transit",
  "Public Spaces",
  "Utilities",
  "Decals & Works",
];

describe("bakeCity bakes the Apex City Kit headless", () => {
  const modules = environmentElements({ kind: "city" });

  it("lists all 75 modules in the page's 11 categories, each with its bake call", () => {
    expect(modules).toHaveLength(75);
    expect([...new Set(modules.map((module) => module.category))].sort()).toEqual(
      [...CATEGORIES].sort(),
    );
    expect(modules[0]?.bake).toBe('bakeCity({ module: "cross", out: "assets/environment" })');
    expect(environmentElements({ search: "transit" }).map((element) => element.id)).toContain(
      "civic-rail",
    );
  });

  it("bakes every module to a textured GLB whose triangles match the entry", async () => {
    const out = await makeTempDir("city-all-");
    for (const { id } of modules) {
      const [entry] = await bakeCity({ module: id, out });
      expect(entry?.path).toBe(path.join(out, `${id}-31082.glb`));
      const gltf = parseGlb(await readFile(entry?.path ?? ""));
      const triangles = gltf.meshes
        .flatMap((mesh) => mesh.primitives)
        .reduce(
          (sum, primitive) =>
            sum +
            (gltf.accessors[primitive.indices ?? (primitive.attributes.POSITION as number)]
              ?.count ?? 0) /
              3,
          0,
        );
      expect(entry?.triangles, id).toBeGreaterThan(0);
      expect(triangles, id).toBe(entry?.triangles);
      expect(gltf.images?.length ?? 0, id).toBeGreaterThan(0);
      expect(gltf.nodes[0]?.extras?.module, id).toBe(id);
      expect(entry?.bounds.max[0], id).toBeGreaterThan(entry?.bounds.min[0] ?? 0);
    }
  }, 300_000);

  it("writes the same bytes for the same options, and names changed options in the file", async () => {
    for (const module of ["cross", "sedan", "civic-ad"]) {
      const [a] = await bakeCity({ module, out: await makeTempDir("city-a-") });
      const [b] = await bakeCity({ module, out: await makeTempDir("city-b-") });
      expect((await readFile(a?.path ?? "")).equals(await readFile(b?.path ?? "")), module).toBe(
        true,
      );
    }
    const out = await makeTempDir("city-options-");
    const [tall] = await bakeCity({ module: "apartments", seed: 7, floors: 9, out });
    const [stock] = await bakeCity({ module: "apartments", seed: 7, out });
    expect(path.basename(tall?.path ?? "")).toMatch(/^apartments-7-f[0-9a-f]{8}\.glb$/u);
    expect(path.basename(stock?.path ?? "")).toBe("apartments-7.glb");
    expect(tall?.bounds.max[1]).toBeGreaterThan(stock?.bounds.max[1] ?? Number.POSITIVE_INFINITY);
  }, 120_000);

  it("fails closed on an unknown module or an option outside the page's limits", async () => {
    const out = await makeTempDir("city-bad-");
    await expect(bakeCity({ module: "crossing", out })).rejects.toThrow(
      /unknown module "crossing"\. Nearest ids: cross/u,
    );
    await expect(bakeCity({ module: "cross", seed: -1, out })).rejects.toThrow(
      /seed must be an integer 0 to 4294967295, got -1/u,
    );
    await expect(bakeCity({ module: "cross", detail: 3, out })).rejects.toThrow(/detail must be/u);
    await expect(bakeCity({ module: "cross", wet: 101, out })).rejects.toThrow(
      /wet must be 0 to 100/u,
    );
    await expect(bakeCity({ module: "store", floors: 13, out })).rejects.toThrow(
      /floors must be an integer 2 to 12, got 13/u,
    );
    await expect(bakeCity({ module: "store", text: "x".repeat(25), out })).rejects.toThrow(
      /text must be a string of at most 24 characters/u,
    );
  });
});
