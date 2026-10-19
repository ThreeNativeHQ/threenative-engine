import { describe, expect, it } from "vitest";
import { type IWorldPackage, cellPlacements, validateWorldPackage } from "../src/world.js";

const PLACEMENT_RECORDS = 200;

function validPackage(): IWorldPackage {
  return {
    assets: {
      rock: {
        bounds: { max: [1, 2, 1], min: [-1, 0, -1] },
        glb: "assets/rock.glb",
      },
      tree: {
        bounds: { max: [3, 12, 3], min: [-3, 0, -3] },
        glb: "assets/tree.glb",
        lods: [
          { distance: 60, glb: "assets/tree_lod1.glb" },
          { distance: 140, glb: "assets/tree_lod2.glb" },
        ],
        maxDistance: 220,
      },
    },
    cellSize: 128,
    cells: [
      { chunks: ["chunks/0_3.glb"], runs: [{ asset: "tree", count: 120, offset: 0 }], x: 0, z: 3 },
      { runs: [{ asset: "rock", count: 10, offset: 120 }], x: 5, z: 5 },
      {
        chunks: ["chunks/1_1.glb"],
        runs: [{ asset: "tree", count: 5, offset: 0 }],
        x: 1,
        z: 1,
      },
      { chunks: [], runs: [], x: 15, z: 0 },
    ],
    extent: { minX: -1000, minZ: -1000, sizeX: 2000, sizeZ: 2000 },
    placements: "placements.bin",
    terrain: {
      columns: 1001,
      heightMax: 240,
      heightMin: -12.5,
      heightmap: "terrain/heightmap.u16",
      layers: { grass: "terrain/grass.png" },
      rows: 1001,
      spacing: 2,
    },
    version: 1,
  };
}

const options = { placementsByteLength: PLACEMENT_RECORDS * 32 };

function codes(manifest: unknown, byteLength = options.placementsByteLength): string[] {
  return validateWorldPackage(manifest, {
    placementsByteLength: byteLength,
  }).errors.map((error) => error.code);
}

describe("validateWorldPackage", () => {
  it("accepts a valid v1 package with every optional field", () => {
    const result = validateWorldPackage(validPackage(), options);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("accepts a package without optional layers, lods, chunks or maxDistance", () => {
    const manifest = validPackage();
    const minimal = {
      ...manifest,
      assets: {
        tree: { bounds: { max: [1, 1, 1], min: [-1, -1, -1] }, glb: "assets/tree.glb" },
      },
      cells: [{ runs: [{ asset: "tree", count: 1, offset: 0 }], x: 0, z: 0 }],
      terrain: {
        columns: manifest.terrain.columns,
        heightMax: manifest.terrain.heightMax,
        heightMin: manifest.terrain.heightMin,
        heightmap: manifest.terrain.heightmap,
        rows: manifest.terrain.rows,
        spacing: manifest.terrain.spacing,
      },
    };
    expect(validateWorldPackage(minimal, options).errors).toEqual([]);
  });

  it("fails closed on a non-object manifest", () => {
    const result = validateWorldPackage("not a package", options);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("WORLD_MALFORMED");
  });

  const malformed: ReadonlyArray<{ readonly name: string; readonly manifest: unknown }> = [
    {
      manifest: { ...validPackage(), version: 2 },
      name: "wrong version",
    },
    {
      manifest: {
        ...validPackage(),
        cells: [{ runs: [{ asset: "ghost", count: 1, offset: 0 }], x: 0, z: 0 }],
      },
      name: "unknown asset",
    },
    {
      manifest: {
        ...validPackage(),
        cells: [{ runs: [{ asset: "tree", count: 2, offset: 199 }], x: 0, z: 0 }],
      },
      name: "run past the placement buffer",
    },
    {
      manifest: {
        ...validPackage(),
        cells: [{ runs: [{ asset: "tree", count: -1, offset: 0 }], x: 0, z: 0 }],
      },
      name: "negative run count",
    },
    {
      manifest: {
        ...validPackage(),
        cells: [{ runs: [{ asset: "tree", count: 1, offset: 0.5 }], x: 0, z: 0 }],
      },
      name: "non-integer run offset",
    },
    {
      manifest: { ...validPackage(), cells: [{ runs: [], x: 16, z: 0 }] },
      name: "cell outside extent",
    },
    {
      manifest: {
        ...validPackage(),
        terrain: { ...validPackage().terrain, columns: 1000 },
      },
      name: "terrain columns disagree with extent and spacing",
    },
    {
      manifest: { ...validPackage(), extent: { minX: 0, minZ: 0, sizeX: "2000", sizeZ: 2000 } },
      name: "wrong-typed extent field",
    },
  ];

  for (const { manifest, name } of malformed) {
    const error = validateWorldPackage(manifest, options).errors.find(
      ({ code }) =>
        code === "WORLD_VERSION_MISMATCH" ||
        code === "WORLD_UNKNOWN_ASSET" ||
        code === "WORLD_RUN_OUT_OF_RANGE" ||
        code === "WORLD_CELL_OUTSIDE_EXTENT" ||
        code === "WORLD_MALFORMED",
    );
    it(`rejects ${name}`, () => {
      expect(validateWorldPackage(manifest, options).ok).toBe(false);
      expect(error).toBeDefined();
    });
  }

  it("names each malformed variant with its own code", () => {
    expect(codes({ ...validPackage(), version: 2 })).toContain("WORLD_VERSION_MISMATCH");
    expect(
      codes({
        ...validPackage(),
        cells: [{ runs: [{ asset: "ghost", count: 1, offset: 0 }], x: 0, z: 0 }],
      }),
    ).toContain("WORLD_UNKNOWN_ASSET");
    expect(
      codes({
        ...validPackage(),
        cells: [{ runs: [{ asset: "tree", count: 2, offset: 199 }], x: 0, z: 0 }],
      }),
    ).toContain("WORLD_RUN_OUT_OF_RANGE");
    expect(codes({ ...validPackage(), cells: [{ runs: [], x: 16, z: 0 }] })).toContain(
      "WORLD_CELL_OUTSIDE_EXTENT",
    );
    expect(codes({ ...validPackage(), terrain: { ...validPackage().terrain, rows: 3 } })).toContain(
      "WORLD_MALFORMED",
    );
    expect(
      validateWorldPackage(validPackage(), {
        heightmapByteLength: 6410,
        placementsByteLength: options.placementsByteLength,
      }).errors.map(({ code }) => code),
    ).toContain("WORLD_MALFORMED");
  });

  it("collects every error instead of stopping at the first", () => {
    const result = validateWorldPackage(
      {
        ...validPackage(),
        cells: [{ runs: [{ asset: "ghost", count: 2, offset: 199 }], x: 16, z: 0 }],
        version: 9,
      },
      options,
    );
    expect(result.errors.map(({ code }) => code).sort()).toEqual(
      [
        "WORLD_CELL_OUTSIDE_EXTENT",
        "WORLD_RUN_OUT_OF_RANGE",
        "WORLD_UNKNOWN_ASSET",
        "WORLD_VERSION_MISMATCH",
      ].sort(),
    );
  });

  it("reports the manifest path beside each error", () => {
    const result = validateWorldPackage(
      {
        ...validPackage(),
        cells: [{ runs: [{ asset: "ghost", count: 1, offset: 0 }], x: 0, z: 0 }],
      },
      options,
    );
    const unknown = result.errors.find(({ code }) => code === "WORLD_UNKNOWN_ASSET");
    expect(unknown?.path).toContain("runs");
  });

  it("checks heightmapByteLength against columns times rows times two", () => {
    expect(
      validateWorldPackage(validPackage(), {
        heightmapByteLength: 1001 * 1001 * 2,
        placementsByteLength: options.placementsByteLength,
      }).errors,
    ).toEqual([]);
    expect(codes(validPackage(), options.placementsByteLength).includes("WORLD_MALFORMED")).toBe(
      false,
    );
  });
});

describe("cellPlacements", () => {
  function filled(count: number): ArrayBuffer {
    const buffer = new ArrayBuffer(count * 32);
    const floats = new Float32Array(buffer);
    for (let index = 0; index < floats.length; index += 1) floats[index] = index;
    return buffer;
  }

  it("returns a view over only the run's records", () => {
    const placements = filled(10);
    const view = cellPlacements(placements, { asset: "tree", count: 3, offset: 2 });
    expect(view.buffer).toBe(placements);
    expect(view.byteOffset).toBe(64);
    expect(view.length).toBe(24);
    expect(view[0]).toBe(16);
    expect(view[23]).toBe(39);
  });

  it("rejects a run that reaches past the buffer", () => {
    expect(() => cellPlacements(filled(10), { asset: "tree", count: 1, offset: 10 })).toThrow(
      RangeError,
    );
  });

  it("rejects negative and non-integer runs", () => {
    expect(() => cellPlacements(filled(10), { asset: "tree", count: 1, offset: -1 })).toThrow(
      RangeError,
    );
    expect(() => cellPlacements(filled(10), { asset: "tree", count: 0.5, offset: 0 })).toThrow(
      RangeError,
    );
  });
});

describe("world cell proxy validation", () => {
  const proxy = {
    glb: "proxy.glb",
    error: 0.1,
    triangles: 10,
    materialGroups: 1,
    scope: "cell",
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    sourceTriangles: 100,
    sourcePrimitives: 2,
  };
  function withProxy(value: unknown) {
    return { ...validPackage(), cells: [{ x: 0, z: 0, runs: [], proxy: value }] };
  }
  it("accepts legacy chunk proxy records and scatter-inclusive metadata", () => {
    expect(validateWorldPackage(withProxy(proxy), options).ok).toBe(true);
    expect(
      validateWorldPackage(
        withProxy({ glb: "proxy.glb", error: 0, triangles: 1, materialGroups: 1 }),
        options,
      ).ok,
    ).toBe(true);
  });
  it.each([
    null,
    { ...proxy, error: -1 },
    { ...proxy, error: Number.NaN },
    { ...proxy, glb: "" },
    { ...proxy, triangles: 0 },
    { ...proxy, materialGroups: 1.5 },
    { ...proxy, scope: "scatter" },
    { ...proxy, bounds: { min: [2, 0, 0], max: [1, 1, 1] } },
    { ...proxy, sourceTriangles: -1 },
    { ...proxy, triangles: Number.MAX_SAFE_INTEGER + 1 },
    { ...proxy, sourcePrimitives: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects malformed proxy metadata %j before attachment", (value) => {
    const result = validateWorldPackage(withProxy(value), options);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path.startsWith("cells[0].proxy"))).toBe(true);
  });
});
