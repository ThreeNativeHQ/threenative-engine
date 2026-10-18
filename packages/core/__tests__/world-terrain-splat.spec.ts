import {
  CompressedArrayTexture,
  CompressedTexture,
  DataArrayTexture,
  Mesh,
  type MeshStandardMaterial,
  Texture,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { float, vec3 } from "three/tsl";
import { MeshStandardNodeMaterial, type Node } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type IAssetLoader, createAssetLoader } from "../src/assets.js";
import {
  type ITerrainSplatMaterialContext,
  type ITerrainSplatSample,
  applyTerrainSurface,
  loadTerrainSplat,
  stackLayers,
} from "../src/world-terrain-splat.js";

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
} as const;

const sourceAppearance = {
  base: { ...table.base, tint: [0.12, 0.23, 0.34] },
  breakup: { ...table.breakup, push: 0 },
  macro: { ...table.macro, min: 1, max: 1 },
  layers: table.layers,
} as const;

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

function served(files: Record<string, unknown>): { assets: IAssetLoader; requested: string[] } {
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
  return { assets: assets as unknown as IAssetLoader, requested };
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

describe("applyTerrainSurface", () => {
  it("replaces marked terrain only, shares the layered surface and disposes the fallback once without DOM", async () => {
    const { assets, requested } = served({
      "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
      "world/terrain/layers.json": table,
      "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
    });
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("self", globalThis);
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const json = JSON.stringify({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0, 1, 3] }],
      buffers: [{ byteLength: 36 }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          min: [0, 0, 0],
          max: [1, 0, 1],
        },
      ],
      materials: [{ name: "fallback" }, { name: "prop" }],
      meshes: [0, 1].map((material) => ({
        primitives: [{ attributes: { POSITION: 0 }, material }],
      })),
      nodes: [
        { name: "terrain", mesh: 0, extras: { tnTerrainSurface: "world.json" } },
        { name: "group", children: [2], extras: { tnTerrainSurface: "world.json" } },
        { name: "child", mesh: 0 },
        { name: "prop", mesh: 1 },
      ],
    });
    const chunk = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4, " "));
    const glb = new Uint8Array(20 + chunk.length + 8 + positions.byteLength);
    const header = new DataView(glb.buffer);
    [0x46546c67, 2, glb.length, chunk.length, 0x4e4f534a].forEach((value, index) =>
      header.setUint32(index * 4, value, true),
    );
    glb.set(chunk, 20);
    header.setUint32(20 + chunk.length, positions.byteLength, true);
    header.setUint32(24 + chunk.length, 0x004e4942, true);
    glb.set(new Uint8Array(positions.buffer), 28 + chunk.length);
    const root = (await new GLTFLoader().parseAsync(glb.buffer, "")).scene;
    const terrain = root.getObjectByName("terrain") as Mesh;
    const child = root.getObjectByName("child") as Mesh;
    const prop = root.getObjectByName("prop") as Mesh;
    const fallback = terrain.material as MeshStandardMaterial;
    const dispose = vi.spyOn(fallback, "dispose");
    const propMaterial = prop.material;
    await applyTerrainSurface(root, { assets, url: "world/world.glb" });
    expect(terrain.material).toBeInstanceOf(MeshStandardNodeMaterial);
    expect(child.material).toBe(terrain.material);
    expect(prop.material).toBe(propMaterial);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(requested).toContain("world/terrain/tex/grass_diff.jpg");
  });

  it("rejects malformed surface pointers before loading or replacing materials", async () => {
    const { assets } = served({});
    const root = new Mesh();
    const material = root.material;
    root.userData.tnTerrainSurface = "../world.json";
    await expect(applyTerrainSurface(root, { assets, url: "world/world.glb" })).rejects.toThrow(
      /pointer/u,
    );
    expect(root.material).toBe(material);
  });

  it("forwards the game appearance table to marked terrain", async () => {
    const { assets } = served({
      "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
      "world/terrain/layers.json": table,
      "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
    });
    const root = new Mesh();
    root.userData.tnTerrainSurface = "world.json";
    await applyTerrainSurface(root, {
      assets,
      url: "world/world.glb",
      table: { ...sourceAppearance, layers: [] },
    });
    expect(root.material).toBeInstanceOf(MeshStandardNodeMaterial);
    expect((root.material as MeshStandardNodeMaterial).userData.TN_TERRAIN_SPLAT).toContain(
      "layers=1",
    );
  });
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

  it("uses package-relative map paths while retaining unnamed-map defaults", async () => {
    const { assets, requested } = served({
      "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
      "world/terrain/layers.json": {
        ...table,
        base: {
          ...table.base,
          maps: { diffuse: "art/moss_diff_1k.jpg", normal: "art/moss_nor_gl_1k.jpg" },
        },
        layers: table.layers.map((layer) =>
          layer.id === "grass"
            ? {
                ...layer,
                height: true,
                maps: { orm: "art/grass_arm_1k.jpg", height: "art/grass_height.png" },
              }
            : layer,
        ),
      },
      "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
    });
    await loadTerrainSplat({ assets, url: "world/world.json" });
    expect(requested.sort()).toEqual(
      [
        "world/art/moss_diff_1k.jpg",
        "world/art/moss_nor_gl_1k.jpg",
        "world/art/grass_arm_1k.jpg",
        "world/art/grass_height.png",
        "world/terrain/tex/litter_diff.jpg",
        "world/terrain/tex/grass_diff.jpg",
        "world/terrain/tex/grass_nrm.jpg",
        "world/terrain/tex/rock_diff.jpg",
      ].sort(),
    );
  });

  it("normalizes parent-relative layer maps before strict manifest resolution", async () => {
    const entries = {
      "world/world.json": { output: "world/world.123.json", bytes: 1 },
      "world/layers.json": { output: "world/layers.123.json", bytes: 1 },
      "world/splat.rgba8": { output: "world/splat.123.rgba8", bytes: 64 },
      "leafy_grass/leafy_grass_diff_1k.jpg": {
        output: "leafy_grass/leafy_grass_diff_123.jpg",
        bytes: 16,
      },
    };
    const responses: Record<string, string | Uint8Array> = {
      "/assets/assets.manifest.json": JSON.stringify({ version: 1, entries }),
      "/assets/world/world.123.json": JSON.stringify(
        world({ splat: "splat.rgba8", table: "layers.json" }),
      ),
      "/assets/world/layers.123.json": JSON.stringify({
        ...table,
        base: {
          ...table.base,
          maps: { diffuse: "../leafy_grass/leafy_grass_diff_1k.jpg" },
          normal: false,
        },
        layers: [],
      }),
      "/assets/world/splat.123.rgba8": new Uint8Array(2 * 4 * 4 * 4),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = responses[url];
        if (body === undefined) return new Response(null, { status: 404 });
        return new Response(body instanceof Uint8Array ? new Blob([new Uint8Array(body)]) : body);
      }),
    );
    const requested: string[] = [];
    const assets = createAssetLoader({
      basePath: "/assets",
      texture: async (url) => {
        requested.push(url);
        return bitmap(4, 4);
      },
    });

    await expect(assets.resolve("world/../leafy_grass/leafy_grass_diff_1k.jpg")).rejects.toThrow(
      /not listed in the asset manifest/u,
    );
    await expect(assets.resolve("leafy_grass/leafy_grass_diff_1k.jpg")).resolves.toEqual([
      "/assets/leafy_grass/leafy_grass_diff_123.jpg",
    ]);
    await loadTerrainSplat({ assets, url: "world/world.json" });

    expect(requested).toEqual(["/assets/leafy_grass/leafy_grass_diff_123.jpg"]);
  });

  it("preserves protocol-relative package URLs when resolving parent-relative maps", async () => {
    const url = "//cdn.example/world/world.json";
    const responses: Record<string, string | Uint8Array> = {
      [url]: JSON.stringify(world({ splat: "splat.rgba8", table: "layers.json" })),
      "//cdn.example/world/layers.json": JSON.stringify({
        ...table,
        base: {
          ...table.base,
          maps: { diffuse: "../leafy_grass/leafy_grass_diff_1k.jpg" },
          normal: false,
        },
        layers: [],
      }),
      "//cdn.example/world/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        const body = responses[path];
        if (body === undefined) return new Response(null, { status: 404 });
        return new Response(body instanceof Uint8Array ? new Blob([new Uint8Array(body)]) : body);
      }),
    );
    const requested: string[] = [];
    const assets = createAssetLoader({
      basePath: "/assets",
      texture: async (path) => {
        requested.push(path);
        return bitmap(4, 4);
      },
    });

    await loadTerrainSplat({ assets, url });

    expect(requested).toEqual(["//cdn.example/leafy_grass/leafy_grass_diff_1k.jpg"]);
  });

  it("rejects a layer map that traverses above the package asset root", async () => {
    const { assets } = served({
      "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
      "world/terrain/layers.json": {
        ...table,
        base: {
          ...table.base,
          maps: { diffuse: "../../outside.jpg" },
          normal: false,
        },
        layers: [],
      },
      "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
    });

    await expect(loadTerrainSplat({ assets, url: "world/world.json" })).rejects.toThrow(
      /map path '\.\.\/\.\.\/outside\.jpg' escapes the package asset root/u,
    );
  });

  it("uses runtime appearance B over the package appearance A", async () => {
    const seen: Array<readonly [number, number, number]> = [];
    const { assets } = served({
      "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
      "world/terrain/layers.json": table,
      "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
    });
    await loadTerrainSplat({
      assets,
      url: "world/world.json",
      table: sourceAppearance,
      layerSample: ({ layer }) => {
        seen.push(layer.tint);
        return { color: vec3(0.5) };
      },
      materialFactory: () => new MeshStandardNodeMaterial(),
    });
    expect(seen[0]).toEqual(sourceAppearance.base.tint);
    expect(seen[0]).not.toEqual(table.base.tint);
  });

  it("keeps baked splat and texture descriptors authoritative", async () => {
    const { assets, requested } = served({
      "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
      "world/terrain/layers.json": { ...table, textures: "baked-textures" },
      "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
    });
    await loadTerrainSplat({
      assets,
      url: "world/world.json",
      table: Object.assign({}, sourceAppearance, { textures: "game-textures" }),
    });
    expect(requested).toContain("world/baked-textures/moss_diff.jpg");
  });

  it("rejects a game layer whose baked mask is absent and names both", async () => {
    const { assets } = served({
      "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
      "world/terrain/layers.json": table,
      "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
    });
    const appearance = {
      ...sourceAppearance,
      layers: sourceAppearance.layers.slice(0, 1).map((layer) => ({
        ...layer,
        id: "game-layer",
        mask: "missing-mask",
      })),
    };
    await expect(
      loadTerrainSplat({ assets, url: "world/world.json", table: appearance }),
    ).rejects.toThrow(/layer 'game-layer'.*mask 'missing-mask'/u);
  });

  it.each(["", "/absolute.jpg", "https://example.test/map.jpg", 42, null])(
    "rejects malformed explicit map paths (%s)",
    async (diffuse) => {
      const { assets } = served({
        "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
        "world/terrain/layers.json": { ...table, base: { ...table.base, maps: { diffuse } } },
        "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
      });
      await expect(loadTerrainSplat({ assets, url: "world/world.json" })).rejects.toThrow(
        /package-relative path/u,
      );
    },
  );

  it.each([null, "art/moss.jpg", [], 42])("rejects malformed map containers (%s)", async (maps) => {
    const { assets } = served({
      "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
      "world/terrain/layers.json": { ...table, base: { ...table.base, maps } },
      "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
    });
    await expect(loadTerrainSplat({ assets, url: "world/world.json" })).rejects.toThrow(
      /maps needs a path object/u,
    );
  });

  it("propagates missing explicit maps instead of retrying the default map", async () => {
    const { assets } = served({
      "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
      "world/terrain/layers.json": {
        ...table,
        base: { ...table.base, maps: { diffuse: "missing.jpg" } },
      },
      "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
    });
    const texture = vi.spyOn(assets, "texture").mockImplementation(async (path) => {
      if (path === "world/missing.jpg") throw new Error("Missing explicit terrain map");
      return bitmap(4, 4);
    });
    await expect(loadTerrainSplat({ assets, url: "world/world.json" })).rejects.toThrow(
      "Missing explicit terrain map",
    );
    expect(texture).not.toHaveBeenCalledWith("world/terrain/tex/moss_diff.jpg", expect.anything());
  });

  it("blends precomputed game samples once and hands the result to the game's material factory", async () => {
    const { assets } = served({
      "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
      "world/terrain/layers.json": {
        ...table,
        layers: table.layers.map((layer) => ({ ...layer, height: layer.id === "rock" })),
      },
      "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
    });
    const maps: Texture[] = [];
    vi.spyOn(assets, "texture").mockImplementation(async () => {
      const map = bitmap(4, 4);
      maps.push(map);
      return map;
    });
    const dispose = vi.spyOn(Texture.prototype, "dispose");
    const copier = copyingRenderer();
    const seen: string[] = [];
    const samples: ITerrainSplatSample[] = [];
    const weights = [float(0.25), float(0.5), float(0.75)];
    const result = new MeshStandardNodeMaterial();
    let blended: ITerrainSplatMaterialContext | undefined;
    const material = await loadTerrainSplat({
      assets,
      renderer: copier as never,
      url: "world/world.json",
      layerSample: ({ layer, index, diffuse, normal, orm, height }) => {
        seen.push(layer.id);
        expect(diffuse).toBeInstanceOf(Texture);
        expect(normal !== undefined).toBe(layer.normal === true);
        expect(orm !== undefined).toBe(layer.orm === true);
        expect(height !== undefined).toBe(layer.id === "rock");
        const sample = {
          color: vec3(index + 1),
          normal: normal === undefined ? undefined : vec3(index + 0.1),
          orm: orm === undefined ? undefined : vec3(index + 0.2),
        };
        samples.push(sample);
        return sample;
      },
      layerWeight: (_weight, { index, height }) => {
        expect(seen).toEqual(["moss", "litter", "grass", "rock"]);
        expect(height !== undefined).toBe(index === 2);
        return weights[index] as Node<"float">;
      },
      materialFactory: (context) => {
        blended = context;
        return result;
      },
    });
    expect(material).toBe(result);
    expect(copier.layers).toEqual([]);
    expect(material.userData.TN_TERRAIN_SPLAT).toBe(
      "layers=4 loadedSamplerUpperBound=9 stacked=0 sampling=custom",
    );
    // Inspect the actual shader graph: the engine owns ordered composition of every channel.
    const field = (node: object, key: string) => {
      let current = node;
      while (Reflect.get(current, "isVarNode") === true) current = Reflect.get(current, "node");
      return Reflect.get(current, key);
    };
    const outerColor = field(blended?.color as object, "aNode");
    expect(field(outerColor, "method")).toBe("mix");
    expect(field(outerColor, "bNode")).toBe(samples[3]?.color);
    expect(field(outerColor, "cNode")).toBe(weights[2]);
    expect(field(field(outerColor, "aNode"), "bNode")).toBe(samples[2]?.color);
    expect(field(field(field(outerColor, "aNode"), "aNode"), "aNode")).toBe(samples[0]?.color);
    expect(field(blended?.normal as object, "aNode")).toBe(samples[0]?.normal);
    expect(field(blended?.normal as object, "bNode")).toBe(samples[2]?.normal);
    expect(field(blended?.normal as object, "cNode")).toBe(weights[1]);
    expect(field(field(blended?.orm as object, "aNode"), "bNode")).toBe(samples[2]?.orm);
    const rockOrm = field(blended?.orm as object, "bNode");
    expect(field(rockOrm, "value").toArray()).toEqual([1, 0.6, 0.2]);
    expect(dispose).not.toHaveBeenCalled();
    for (const map of maps) expect(map.version).toBe(1);
    material.dispose();
    expect(dispose).toHaveBeenCalledTimes(maps.length + 1);
    material.dispose();
    expect(dispose).toHaveBeenCalledTimes(maps.length + 1);
  });

  it("propagates a final material factory failure", async () => {
    const { assets } = served({
      "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
      "world/terrain/layers.json": table,
      "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
    });
    await expect(
      loadTerrainSplat({
        assets,
        url: "world/world.json",
        materialFactory: () => {
          throw new Error("Authored material failed");
        },
      }),
    ).rejects.toThrow("Authored material failed");
  });

  it("releases factory-only stacked arrays without disposing their source maps twice", async () => {
    const { assets } = served({
      "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
      "world/terrain/layers.json": table,
      "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
    });
    const sources: Array<ReturnType<typeof vi.fn>> = [];
    vi.spyOn(assets, "texture").mockImplementation(async () => {
      const map = bitmap(4, 4);
      const disposed = vi.fn();
      map.addEventListener("dispose", disposed);
      sources.push(disposed);
      return map;
    });
    const dispose = vi.spyOn(Texture.prototype, "dispose");
    const material = await loadTerrainSplat({
      assets,
      renderer: copyingRenderer() as never,
      url: "world/world.json",
      materialFactory: () => new MeshStandardNodeMaterial(),
    });
    expect(sources).toHaveLength(7);
    for (const disposed of sources) expect(disposed).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(7);
    material.dispose();
    // Three arrays plus the splat are released; their seven input images were released by stacking.
    expect(dispose).toHaveBeenCalledTimes(11);
    for (const disposed of sources) expect(disposed).toHaveBeenCalledTimes(1);
  });

  it.each(["sample", "weight", "factory"])(
    "releases custom-owned images when %s composition throws",
    async (phase) => {
      const { assets } = served({
        "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
        "world/terrain/layers.json": table,
        "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
      });
      const shared = bitmap(4, 4);
      vi.spyOn(assets, "texture").mockResolvedValue(shared);
      const dispose = vi.spyOn(Texture.prototype, "dispose");
      const fail = () => {
        throw new Error("Authored composition failed");
      };
      await expect(
        loadTerrainSplat({
          assets,
          url: "world/world.json",
          layerSample: phase === "sample" ? fail : () => ({ color: vec3(0.5) }),
          layerWeight: phase === "weight" ? fail : undefined,
          materialFactory: phase === "factory" ? fail : undefined,
        }),
      ).rejects.toThrow("Authored composition failed");
      expect(dispose).toHaveBeenCalledTimes(2); // one shared loaded image and the owned splat
    },
  );

  it("releases late custom-owned loads after another image fails", async () => {
    const { assets } = served({
      "world/world.json": world({ splat: "terrain/splat.rgba8", table: "terrain/layers.json" }),
      "world/terrain/layers.json": table,
      "world/terrain/splat.rgba8": new Uint8Array(2 * 4 * 4 * 4),
    });
    let finish!: (map: Texture) => void;
    const late = new Promise<Texture>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(assets, "texture")
      .mockRejectedValueOnce(new Error("Missing image"))
      .mockReturnValue(late);
    const dispose = vi.spyOn(Texture.prototype, "dispose");
    await expect(
      loadTerrainSplat({
        assets,
        url: "world/world.json",
        layerSample: () => ({ color: vec3(0.5) }),
      }),
    ).rejects.toThrow("Missing image");
    expect(dispose).toHaveBeenCalledTimes(1);
    finish(bitmap(4, 4));
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(2));
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
      /layer 'litter'.*mask 'ghost'/u,
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
