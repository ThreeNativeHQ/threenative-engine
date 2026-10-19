import { CompressedArrayTexture, CompressedTexture, DataArrayTexture, Texture } from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTerrainSplat, stackLayers } from "../src/world-terrain-splat.js";

/** Every layer states how it responds to light: an `orm` map, or the two numbers themselves. */
const table = {
  base: {
    id: "moss",
    metalness: 0,
    normal: true,
    roughness: 0.9,
    tile: 3,
    tint: [0.36, 0.47, 0.27],
  },
  breakup: { push: 0.25, scale: 0.35 },
  layers: [
    {
      channel: "r",
      hi: 1.35,
      id: "litter",
      lo: 0.3,
      mask: "litter",
      metalness: 0,
      roughness: 0.95,
      tile: 3,
      tint: [1, 1, 1],
    },
    {
      channel: "b",
      hi: 0.75,
      id: "grass",
      lo: 0.25,
      mask: "b",
      metalness: 0,
      normal: true,
      orm: true,
      roughness: 0.8,
      tile: 3.5,
      tint: [1, 1, 1],
    },
    {
      channel: "r",
      hi: 0.85,
      id: "rock",
      lo: 0.45,
      mask: "a",
      metalness: 0.2,
      roughness: 0.6,
      tile: 7,
      tint: [1, 1, 1],
      triplanar: true,
    },
  ],
  macro: { max: 1.12, min: 0.8, scale: 0.05 },
  splat: { masks: { a: [0, "rgb"], b: [1, "rgb"], litter: [0, "a"] }, planes: 2, size: 4 },
  textures: "terrain/tex",
};

/**
 * A package exported before the `orm` column existed: Machinefall's own `terrain/layers.json`,
 * which states roughness per layer, never metalness, and says nothing at all about its base.
 */
const preOrmTable = {
  base: { id: "forrest_ground_01", normal: true, tile: 3.0405, tint: [0.36, 0.47, 0.27] },
  breakup: { push: 0.25, scale: 0.35 },
  layers: [
    {
      channel: "r",
      hi: 1.35,
      id: "forrest_ground_03",
      lo: 0.3,
      mask: "litter",
      roughness: 0.95,
      saturation: 0.9,
      tile: 3,
      tint: [0.36, 0.37, 0.26],
    },
    {
      channel: "b",
      hi: 0.75,
      id: "sparse_grass",
      lo: 0.25,
      mask: "b",
      normal: true,
      roughness: 0.95,
      tile: 3.5,
      tint: [0.85, 0.9, 0.75],
    },
    {
      channel: "r",
      hi: 0.85,
      id: "rock_face_03",
      lo: 0.45,
      mask: "a",
      roughness: 0.85,
      saturation: 0.6,
      tile: 7,
      tint: [0.55, 0.5, 0.44],
      triplanar: true,
    },
  ],
  macro: { max: 1.12, min: 0.8, scale: 0.05 },
  splat: { masks: { a: [0, "rgb"], b: [1, "rgb"], litter: [0, "a"] }, planes: 2, size: 4 },
  textures: "terrain/tex",
};

function world(layers: Record<string, string> | undefined): unknown {
  return {
    extent: { minX: -8, minZ: -8, sizeX: 16, sizeZ: 16 },
    terrain: { heightmap: "terrain/heightmap.u16", ...(layers === undefined ? {} : { layers }) },
  };
}

function served(files: Record<string, unknown>): { assets: never; requested: string[] } {
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = files[url];
      if (body === undefined) return new Response(null, { status: 404 });
      return body instanceof Uint8Array
        ? new Response(new Blob([body as BlobPart]))
        : new Response(JSON.stringify(body));
    }),
  );
  const assets = {
    resolve: async (path: string) => [path],
    texture: async (path: string) => {
      requested.push(path);
      return bitmap(4, 4);
    },
  };
  return { assets: assets as never, requested };
}

/** An uncompressed layer of a given size, as the asset loader hands one back (an ImageBitmap). */
function bitmap(width: number, height: number): Texture {
  const texture = new Texture();
  texture.image = { width, height } as never;
  return texture;
}

/** A renderer that records the GPU copies it is asked for, one per array layer. */
function copyingRenderer(): { raw: unknown; layers: number[] } {
  const layers: number[] = [];
  return {
    layers,
    raw: {
      copyTextureToTexture: (
        _source: unknown,
        _destination: unknown,
        _r: unknown,
        at: { z: number },
      ) => layers.push(at.z),
      initTexture: () => undefined,
    },
  };
}

/** Every distinct texture the material's node graphs sample: one binding each. */
function sampledTextures(material: MeshStandardNodeMaterial): Set<Texture> {
  const found = new Set<Texture>();
  const walk = (
    node: { value?: unknown; getChildren?: () => unknown[] } | null | undefined,
  ): void => {
    if (node === null || node === undefined) return;
    if (node.value instanceof Texture) found.add(node.value);
    for (const child of node.getChildren?.() ?? []) walk(child as typeof node);
  };
  walk(material.colorNode as never);
  walk(material.normalNode as never);
  walk(material.roughnessNode as never);
  walk(material.aoNode as never);
  walk(material.metalnessNode as never);
  return found;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("loadTerrainSplat", () => {
  it("builds the package's splat surface from its own table, planes and texture sets", async () => {
    const { assets, requested } = served({
      "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
      "world/terrain/layers.json": table,
      "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
    });
    const surface = await loadTerrainSplat({ assets, url: "world/world.json" });
    expect(surface).toBeInstanceOf(MeshStandardNodeMaterial);
    expect((surface as MeshStandardNodeMaterial).colorNode).toBeTruthy();
    expect((surface as MeshStandardNodeMaterial).normalNode).toBeTruthy();
    // Every set's albedo, a normal and an ORM map only where the table asks for one.
    expect(requested.sort()).toEqual(
      [
        "world/terrain/tex/grass_diff.jpg",
        "world/terrain/tex/grass_nrm.jpg",
        "world/terrain/tex/grass_orm.jpg",
        "world/terrain/tex/litter_diff.jpg",
        "world/terrain/tex/moss_diff.jpg",
        "world/terrain/tex/moss_nrm.jpg",
        "world/terrain/tex/rock_diff.jpg",
      ].sort(),
    );
  });

  it("blends a layer's own map at the game's far tile, by distance, when the table asks", async () => {
    // A repeated ground map reads as a grid at grazing angles; the same map at a much larger tile,
    // mixed in with distance, breaks the period. Sizes and distances are the table's, not ours.
    const textureNodes = (node: unknown, seen = new Set<unknown>()): number => {
      if (node === null || typeof node !== "object" || ArrayBuffer.isView(node) || seen.has(node))
        return 0;
      seen.add(node);
      let count = (node as { isTextureNode?: boolean }).isTextureNode === true ? 1 : 0;
      for (const value of Object.values(node)) count += textureNodes(value, seen);
      return count;
    };
    const surfaceFor = async (base: Record<string, unknown>) => {
      const { assets } = served({
        "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
        "world/terrain/layers.json": { ...table, base, layers: [] },
        "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
      });
      return (await loadTerrainSplat({
        assets,
        url: "world/world.json",
      })) as MeshStandardNodeMaterial;
    };
    const plain = await surfaceFor(table.base);
    const far = await surfaceFor({
      ...table.base,
      far: { amount: 0.6, from: 4, to: 40, tile: 17 },
    });
    expect(textureNodes(far.colorNode)).toBeGreaterThan(textureNodes(plain.colorNode));
    await expect(
      surfaceFor({ ...table.base, far: { amount: 0.6, from: 40, to: 4, tile: 17 } }),
    ).rejects.toThrow(/far/u);
    await expect(
      surfaceFor({ ...table.base, far: { amount: 0.6, from: 4, to: 40, tile: 0 } }),
    ).rejects.toThrow(/far/u);
  });

  it("drives roughness, occlusion and metalness from the table and its ORM maps", async () => {
    const { assets } = served({
      "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
      "world/terrain/layers.json": table,
      "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
    });
    const surface = (await loadTerrainSplat({
      assets,
      renderer: copyingRenderer() as never,
      url: "world/world.json",
    })) as MeshStandardNodeMaterial;
    // The surface's whole light response comes from the table: no scalar left in the package.
    expect(surface.roughnessNode).toBeTruthy();
    expect(surface.aoNode).toBeTruthy();
    expect(surface.metalnessNode).toBeTruthy();
    expect(surface.roughness).toBe(1);
    expect(surface.metalness).toBe(0);
    // splat + albedo + normal + the single ORM layer's array.
    expect(sampledTextures(surface).size).toBe(4);
  });

  it("loads a table exported before the orm column, naming the layer that says nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { assets } = served({
      "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
      "world/terrain/layers.json": preOrmTable,
      "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
    });
    // A package the earlier export recipe wrote is not malformed, and a world that never loads is
    // a game stuck on its loading screen: the surface builds, and the gap is reported.
    const surface = (await loadTerrainSplat({
      assets,
      renderer: copyingRenderer() as never,
      url: "world/world.json",
    })) as MeshStandardNodeMaterial;
    expect(surface.roughnessNode).toBeTruthy();
    expect(surface.metalnessNode).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("forrest_ground_01"));
  });

  it("refuses a package without terrain layers instead of drawing a default", async () => {
    const { assets } = served({ "world/world.json": world(undefined) });
    await expect(loadTerrainSplat({ assets, url: "world/world.json" })).rejects.toThrow(
      /terrain\.layers/u,
    );
  });

  it("refuses splat data shorter than the planes the table names", async () => {
    const { assets } = served({
      "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
      "world/terrain/layers.json": table,
      "world/terrain/splat.rgba8": new Uint8Array(4 * 4 * 4),
    });
    await expect(loadTerrainSplat({ assets, url: "world/world.json" })).rejects.toThrow(/plane 1/u);
  });

  it("stacks sixteen same-size uncompressed layers into one array texture per set", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { assets } = served({
      "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
      "world/terrain/layers.json": {
        ...table,
        layers: Array.from({ length: 15 }, (_unused, index) => ({
          channel: "r",
          hi: 1,
          id: `layer-${String(index)}`,
          lo: 0,
          mask: "a",
          metalness: 0,
          normal: true,
          roughness: 0.7,
          tile: 3,
          tint: [1, 1, 1],
        })),
        splat: { masks: { a: [0, "a"] }, planes: 1, size: 4 },
      },
      "world/terrain/splat.rgba8": new Uint8Array(4 * 4 * 4),
    });
    const surface = (await loadTerrainSplat({
      assets,
      renderer: copyingRenderer() as never,
      url: "world/world.json",
    })) as MeshStandardNodeMaterial;
    // The splat planes plus one array per set: three sampled textures for sixteen layers.
    expect(sampledTextures(surface).size).toBe(3);
    expect(info).toHaveBeenCalledWith("TN_TERRAIN_SPLAT layers=16 samplers=3 stacked=2");
  });

  it("loads and stacks a height set for the layers that name one, and hands it to the weight seam", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { assets, requested } = served({
      "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
      "world/terrain/layers.json": {
        ...table,
        layers: table.layers.map((layer) =>
          layer.id === "rock" || layer.id === "grass" ? { ...layer, height: true } : layer,
        ),
      },
      "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
    });
    const seen: { id: string; index: number; hasHeight: boolean }[] = [];
    const surface = (await loadTerrainSplat({
      assets,
      layerWeight: (weight, { height, index, layer }) => {
        seen.push({ hasHeight: height !== undefined, id: layer.id, index });
        // A seam that reads the height is what puts the height array into the graph.
        return height === undefined ? weight : weight.add(height);
      },
      renderer: copyingRenderer() as never,
      url: "world/world.json",
    })) as MeshStandardNodeMaterial;
    expect(requested).toContain("world/terrain/tex/rock_h.jpg");
    expect(requested).toContain("world/terrain/tex/grass_h.jpg");
    expect(requested.filter((path) => path.endsWith("_h.jpg"))).toHaveLength(2);
    expect(seen).toEqual([
      { hasHeight: false, id: "litter", index: 0 },
      { hasHeight: true, id: "grass", index: 1 },
      { hasHeight: true, id: "rock", index: 2 },
    ]);
    // splat + albedo + normal + ORM + the one height array.
    expect(sampledTextures(surface).size).toBe(5);
    expect(info).toHaveBeenCalledWith("TN_TERRAIN_SPLAT layers=4 samplers=5 stacked=4");
  });

  it("builds the same surface with no height set and no seam as before either existed", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { assets, requested } = served({
      "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
      "world/terrain/layers.json": table,
      "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
    });
    const surface = (await loadTerrainSplat({
      assets,
      renderer: copyingRenderer() as never,
      url: "world/world.json",
    })) as MeshStandardNodeMaterial;
    expect(requested.some((path) => path.endsWith("_h.jpg"))).toBe(false);
    expect(sampledTextures(surface).size).toBe(4);
    expect(info).toHaveBeenCalledWith("TN_TERRAIN_SPLAT layers=4 samplers=4 stacked=3");
  });

  it("names the sampler count a set that cannot stack costs", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sizes = new Map<string, [number, number]>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "world/world.json")
          return new Response(
            JSON.stringify(world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" })),
          );
        if (url === "world/terrain/splat.rgba8")
          return new Response(new Blob([new Uint8Array(2 * 4 * 4 * 4)]));
        return new Response(JSON.stringify(table));
      }),
    );
    // One layer at a size the others cannot match, so the albedo set keeps its own samplers.
    sizes.set("world/terrain/tex/rock_diff.jpg", [8, 8]);
    const assets = {
      resolve: async (path: string) => [path],
      texture: async (path: string) => {
        const size = sizes.get(path) ?? [4, 4];
        return bitmap(size[0], size[1]);
      },
    };
    const surface = (await loadTerrainSplat({
      assets: assets as never,
      renderer: copyingRenderer() as never,
      url: "world/world.json",
    })) as MeshStandardNodeMaterial;
    // splat + 4 albedos (one layer's size the rest do not share) + a stacked normal and ORM set.
    expect(sampledTextures(surface).size).toBe(7);
    expect(info).toHaveBeenCalledWith("TN_TERRAIN_SPLAT layers=4 samplers=7 stacked=2");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bind 4 samplers"));
  });

  it("refuses a world.json without a numeric extent", async () => {
    const { assets } = served({
      "world/world.json": { terrain: { layers: { splat: "s", table: "t" } } },
    });
    await expect(loadTerrainSplat({ assets, url: "world/world.json" })).rejects.toThrow(
      /has no numeric extent/u,
    );
  });

  it("refuses a mask the splat table does not name", async () => {
    const broken = {
      ...table,
      layers: [
        { channel: "r", hi: 1, id: "litter", lo: 0, mask: "ghost", tile: 3, tint: [1, 1, 1] },
      ],
    };
    const { assets } = served({
      "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
      "world/terrain/layers.json": broken,
      "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
    });
    await expect(loadTerrainSplat({ assets, url: "world/world.json" })).rejects.toThrow(
      /unknown mask 'ghost'/u,
    );
  });
});

describe("stackLayers", () => {
  const layer = (fill: number, format = 1023): CompressedTexture => {
    const texture = new CompressedTexture(
      [
        { data: new Uint8Array(16).fill(fill), height: 4, width: 4 },
        { data: new Uint8Array(8).fill(fill), height: 2, width: 2 },
      ] as never,
      4,
      4,
      format as never,
    );
    return texture;
  };

  it("stacks same-format layers into one array texture, every mip concatenated in layer order", () => {
    const stacked = stackLayers([layer(1), layer(2), layer(3)]) as CompressedArrayTexture;
    expect(stacked).toBeInstanceOf(CompressedArrayTexture);
    expect((stacked.image as { depth: number }).depth).toBe(3);
    const mip0 = stacked.mipmaps[0]?.data as Uint8Array;
    expect(mip0.byteLength).toBe(48);
    expect([mip0[0], mip0[16], mip0[32]]).toEqual([1, 2, 3]);
    expect((stacked.mipmaps[1]?.data as Uint8Array).byteLength).toBe(24);
  });

  it("refuses to stack a mixed codec", () => {
    expect(stackLayers([layer(1), layer(2, 1024)])).toBeUndefined();
  });

  it("stacks same-size uncompressed layers through one GPU copy per layer", () => {
    const renderer = copyingRenderer();
    const stacked = stackLayers(
      [bitmap(4, 4), bitmap(4, 4), bitmap(4, 4)],
      renderer as never,
    ) as DataArrayTexture;
    expect(stacked).toBeInstanceOf(DataArrayTexture);
    expect((stacked.image as { depth: number }).depth).toBe(3);
    expect(renderer.layers).toEqual([0, 1, 2]);
  });

  it("refuses uncompressed layers of mixed sizes, and any set with no renderer to copy with", () => {
    expect(stackLayers([bitmap(4, 4), bitmap(8, 8)], copyingRenderer() as never)).toBeUndefined();
    expect(stackLayers([bitmap(4, 4), bitmap(4, 4)])).toBeUndefined();
  });
});
