import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { bakeCity, environmentElements } from "../src/index.js";

interface IGltf {
  accessors: { count: number }[];
  images?: { mimeType: string }[];
  meshes: {
    primitives: { attributes: Record<string, number>; indices?: number; material?: number }[];
  }[];
  materials?: {
    emissiveFactor?: number[];
    emissiveTexture?: unknown;
    extensions?: Record<string, unknown>;
    extras?: Record<string, unknown>;
    name: string;
    pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: unknown };
  }[];
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

  it("bakes a wide left bend with matching outlets and independent street layers", async () => {
    const out = await makeTempDir("city-bend-");
    const options = {
      module: "curve",
      out,
      bendAngle: 60,
      bendRadius: 20,
      bendSide: "left" as const,
      roadWidth: 12,
      roadSurface: "concrete" as const,
      sidewalk: false,
      markings: false,
    };
    const [entry] = await bakeCity(options);
    if (!entry) throw new Error("Expected a city GLB");
    const gltf = parseGlb(await readFile(entry.path));
    const names = gltf.materials?.map(({ name }) => name);
    expect(gltf.materials?.find(({ name }) => name === "Road concrete")).toMatchObject({
      pbrMetallicRoughness: { baseColorTexture: expect.any(Object) },
    });
    expect(names).toContain("curb");
    expect(names).not.toContain("paving");
    expect(names).not.toContain("white");
    const sockets = gltf.nodes[0]?.extras?.sockets as {
      position: number[];
      direction: number[];
      width: number;
      laneCenters: number[];
    }[];
    expect(sockets[0]).toMatchObject({
      position: [0, 0, -12],
      direction: [0, 0, -1],
      width: 12,
      laneCenters: [-3, 3],
    });
    expect(sockets[1]?.position[0]).toBeCloseTo(-10);
    expect(sockets[1]?.position[2]).toBeCloseTo(20 * Math.sin(Math.PI / 3) - 12);
    expect(sockets[1]?.direction[0]).toBeCloseTo(-Math.sin(Math.PI / 3));
    expect(sockets[1]?.direction[2]).toBeCloseTo(0.5);
    const [bare] = await bakeCity({ ...options, curb: false });
    if (!bare) throw new Error("Expected a city GLB");
    expect(bare.path).not.toBe(entry.path);
    expect(parseGlb(await readFile(bare.path)).materials?.map(({ name }) => name)).not.toContain(
      "curb",
    );
  }, 30_000);

  it("changes straight length and validates road-only settings", async () => {
    const out = await makeTempDir("city-straight-");
    const [entry] = await bakeCity({ module: "straight", out, roadLength: 48, curb: false });
    expect(entry?.bounds.min[2]).toBeCloseTo(-24);
    expect(entry?.bounds.max[2]).toBeCloseTo(24);
    if (!entry) throw new Error("Expected a city GLB");
    const gltf = parseGlb(await readFile(entry.path));
    expect(gltf.materials?.map(({ name }) => name)).toContain("paving");
    expect(gltf.materials?.map(({ name }) => name)).not.toContain("curb");
    expect(gltf.nodes[0]?.extras?.sockets).toMatchObject([
      { position: [0, 0, -24] },
      { position: [0, 0, 24] },
    ]);
    await expect(bakeCity({ module: "curve", out, bendAngle: 0 })).rejects.toThrow(/bendAngle/u);
    await expect(bakeCity({ module: "tee", out, roadWidth: 12 })).rejects.toThrow(/roadWidth/u);
  }, 30_000);

  it("changes the finish of a stock intersection while preserving its footprint and sockets", async () => {
    const out = await makeTempDir("city-intersection-");
    const [stock] = await bakeCity({ module: "cross", out });
    const [custom] = await bakeCity({
      module: "cross",
      out,
      sidewalk: false,
      roadSurface: "paving",
    });
    if (!stock || !custom) throw new Error("Expected both city GLBs");
    const original = parseGlb(await readFile(stock.path));
    const gltf = parseGlb(await readFile(custom.path));
    expect(custom.bounds).toEqual(stock.bounds);
    expect(gltf.nodes[0]?.extras?.sockets).toEqual(original.nodes[0]?.extras?.sockets);
    const names = gltf.materials?.map(({ name }) => name);
    expect(names).toContain("Road paving");
    expect(names).toContain("curb");
    expect(names).not.toContain("paving");
  }, 30_000);

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
    await expect(
      bakeCity({ module: "office", emissiveSigns: "yes" as unknown as boolean, out }),
    ).rejects.toThrow(/emissiveSigns must be true or false/u);
    await expect(
      bakeCity({ module: "office", opaqueGlass: 1 as unknown as boolean, out }),
    ).rejects.toThrow(/opaqueGlass must be true or false/u);
  });

  it("deduplicates identical textures, materials and static sibling meshes without losing triangles", async () => {
    const out = await makeTempDir("city-dedupe-");
    const [office] = await bakeCity({ module: "office", detail: 1, dressing: false, out });
    if (!office) throw new Error("Expected office GLB");
    const gltf = parseGlb(await readFile(office.path));
    const names = gltf.materials?.map((m) => m.name) ?? [];
    expect(names.filter((name) => name === "Spectrally selective curtain glass")).toHaveLength(1);
    expect(names.filter((name) => name === "Clear laminated lobby glass")).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
    expect(gltf.meshes.length).toBeLessThanOrEqual(22);
    expect(office.triangles).toBe(8862);
  }, 30_000);

  it("supports opt-in emissiveSigns and the opaqueGlass: false override while keeping default stock filenames unchanged", async () => {
    const out = await makeTempDir("city-optin-");
    const [plainAd] = await bakeCity({
      module: "civic-ad",
      detail: 1,
      dressing: false,
      text: "APEX",
      out,
    });
    const [litAd] = await bakeCity({
      module: "civic-ad",
      detail: 1,
      dressing: false,
      text: "APEX",
      emissiveSigns: true,
      out,
    });
    if (!plainAd || !litAd) throw new Error("Expected both billboard GLBs");
    expect(litAd.path).not.toBe(plainAd.path);
    const plainSign = parseGlb(await readFile(plainAd.path)).materials?.find(
      (m) => m.extras?.sign === true,
    );
    const litSign = parseGlb(await readFile(litAd.path)).materials?.find(
      (m) => m.extras?.sign === true,
    );
    expect(plainSign?.emissiveTexture).toBeUndefined();
    expect(litSign?.emissiveTexture).toBeDefined();
    expect(litSign?.emissiveFactor).toEqual([1, 1, 1]);

    // The default native engine refuses a transmissive mesh by name (TN_MATERIAL_UNSUPPORTED
    // transmission), so the stock bake ships opaque glass; `opaqueGlass: false` keeps the
    // transmissive glass under its own file name.
    const [stockOffice] = await bakeCity({ module: "office", detail: 1, dressing: false, out });
    const [glassOffice] = await bakeCity({
      module: "office",
      detail: 1,
      dressing: false,
      opaqueGlass: false,
      out,
    });
    if (!stockOffice || !glassOffice) throw new Error("Expected both office GLBs");
    expect(glassOffice.path).not.toBe(stockOffice.path);
    const transmissive = async (file: string) =>
      parseGlb(await readFile(file)).materials?.filter(
        (m) => m.extensions?.KHR_materials_transmission !== undefined,
      ) ?? [];
    expect(await transmissive(stockOffice.path)).toHaveLength(0);
    expect((await transmissive(glassOffice.path)).length).toBeGreaterThan(0);
    // Opaque glass keeps only what three's transmission mix leaves over a dark interior,
    // colour × (1 − transmission): the near-white lobby glass reads as dark glass, not a white wall.
    const lobby = (file: Buffer) =>
      parseGlb(file).materials?.find((m) => m.name === "Clear laminated lobby glass")
        ?.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
    const clear = lobby(await readFile(glassOffice.path));
    const opaque = lobby(await readFile(stockOffice.path));
    for (const channel of [0, 1, 2])
      expect(opaque[channel]).toBeCloseTo((clear[channel] ?? 1) * (1 - 0.96), 4);
  }, 60_000);
});
