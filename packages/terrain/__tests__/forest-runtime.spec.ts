import { readFileSync } from "node:fs";
import type { ICtx } from "@threenative/core";
import { Heightfield, TerrainTiles } from "@threenative/core/world";
import type {
  ILoadTerrainSplatOptions,
  ITerrainSplatTable,
  IWorldCellsLoadOptions,
  IWorldPackage,
} from "@threenative/core/world";
import { type IPhysicsContext, rapier } from "@threenative/physics";
import { Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, Texture } from "three";
import { vec3 } from "three/tsl";
import { MeshPhysicalNodeMaterial } from "three/webgpu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addStarterWorld } from "../src/starter.js";
import { GROUND_SPECULAR, PropColliders, addForest } from "../starter/forest/world.js";

vi.mock("@threenative/terrain/starter", () => import("../src/starter.js"));

const loads = vi.hoisted(() => ({ surface: vi.fn(), sky: vi.fn(), world: vi.fn() }));
vi.mock("@threenative/core/world", async (original) => {
  const actual = await original<typeof import("@threenative/core/world")>();
  return { ...actual, loadTerrainSplat: loads.surface, WorldCells: { load: loads.world } };
});
vi.mock("three/addons/loaders/HDRLoader.js", () => ({
  HDRLoader: class {
    loadAsync = loads.sky;
  },
}));

type Ctx = ICtx<Record<string, unknown>, IPhysicsContext>;
const plugins: ReturnType<typeof rapier>[] = [];
const lifetimes: Array<() => void> = [];
const worlds: Array<Group & { dispose(): void }> = [];
const manifest: IWorldPackage = {
  version: 1,
  cellSize: 64,
  extent: { minX: -128, minZ: -128, sizeX: 256, sizeZ: 256 },
  assets: { fir: { glb: "fir.glb", bounds: { min: [-1, 0, -1], max: [1, 8, 1] } } },
  cells: [{ x: 0, z: 0, runs: [{ asset: "fir", offset: 0, count: 2 }] }],
  placements: "placements.bin",
  terrain: {
    heightmap: "heightmap.u16",
    columns: 3,
    rows: 3,
    spacing: 128,
    heightMin: 0,
    heightMax: 10,
  },
};
const water = {
  lakes: [{ id: "lake", at: [0, 0], radius: 200, level: 1.5 }],
  rivers: [
    {
      id: "river",
      width: 6,
      points: [
        [-100, 0.5, 0],
        [0, 0.5, 0],
        [100, 0.5, 0],
      ],
    },
  ],
};
const records = new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 130, 0, 0, 0, 0, 0, 1, 1]);
const heightmap = new Uint16Array([0, 2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000]);
let requests: string[];
let surface: MeshBasicMaterial;
let sky: Texture;

async function context() {
  const scene = new Group();
  const model = new Group();
  const ctx = {
    scene,
    assets: { resolve: async (path: string) => [path], model: async () => ({ scene: model }) },
    add: <T extends Object3D>(object: T): T => {
      scene.add(object);
      return object;
    },
    entities: {
      add: (_id: string, entity: { dispose?: () => void }) => {
        if (entity.dispose) lifetimes.push(entity.dispose);
        return entity;
      },
    },
  } as unknown as Ctx;
  const plugin = rapier();
  await plugin.setup?.(ctx);
  plugins.push(plugin);
  return { ctx, plugin, model };
}

beforeEach(() => {
  requests = [];
  surface = new MeshBasicMaterial();
  sky = new Texture();
  vi.spyOn(surface, "dispose");
  vi.spyOn(sky, "dispose");
  loads.surface.mockReset().mockResolvedValue(surface);
  loads.sky.mockReset().mockResolvedValue(sky);
  loads.world.mockReset().mockImplementation(async (options: IWorldCellsLoadOptions) => {
    if (!options.data) {
      // The real WorldCells API reads these itself unless the consumer supplies decoded data.
      await (await fetch(options.url)).json();
      await (await fetch("terrain/forest/placements.bin")).arrayBuffer();
      await (await fetch("terrain/forest/heightmap.u16")).arrayBuffer();
    }
    const world = Object.assign(new Group(), {
      dispose: vi.fn(function (this: Group) {
        this.removeFromParent();
      }),
    });
    worlds.push(world);
    return world;
  });
  vi.stubGlobal("fetch", async (input: string) => {
    requests.push(input);
    if (input.endsWith("world.json")) return new Response(JSON.stringify(manifest));
    if (input.endsWith("placements.bin")) return new Response(records.slice().buffer);
    if (input.endsWith("heightmap.u16")) return new Response(heightmap.slice().buffer);
    if (input.endsWith("water.json")) return new Response(JSON.stringify(water));
    throw new Error(`Unexpected forest request: ${input}`);
  });
});

afterEach(() => {
  for (const dispose of lifetimes.splice(0)) dispose();
  for (const world of worlds.splice(0)) world.dispose();
  for (const plugin of plugins.splice(0)) plugin.dispose?.({} as Ctx);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("forest runtime", () => {
  it.each([
    [256, 0],
    [256, 1],
    [8192, 0],
    [8192, 1],
  ])(
    "bounds collision at the actual render grid for a %sm world with radius %s",
    async (size, radius) => {
      const bound = ((2 * radius + 1) * 128 + 1) ** 2;
      const { ctx, plugin } = await context();
      const large = {
        ...manifest,
        extent: { minX: -size / 2, minZ: -size / 2, sizeX: size, sizeZ: size },
        terrain: { ...manifest.terrain, spacing: size / 2 },
      };
      const fetchOriginal = globalThis.fetch;
      vi.stubGlobal("fetch", (input: string) =>
        input.endsWith("world.json")
          ? Promise.resolve(new Response(JSON.stringify(large)))
          : fetchOriginal(input),
      );
      const tiles = new TerrainTiles({
        sampleHeight: () => 0,
        surface,
        tileSize: 64,
        tileResolution: 129,
        residentTileBudget: 1,
        residentByteBudget: 1_000_000,
      });
      loads.world.mockImplementationOnce(async () => {
        const world = Object.assign(new Group(), { dispose: vi.fn(() => tiles.dispose()) });
        world.add(tiles);
        worlds.push(world);
        return world;
      });
      const callbacks = new Set<() => void>();
      const every = vi.fn((callback: () => void) => {
        callbacks.add(callback);
        return Object.assign(() => callbacks.delete(callback), {
          cancel: () => callbacks.delete(callback),
          active: true,
        });
      });
      Object.assign(ctx, { every });
      const original = Heightfield.fromSampler.bind(Heightfield);
      vi.spyOn(Heightfield, "fromSampler").mockImplementation((options) => {
        // Reject the dense-world regression before it can allocate a gigabyte.
        expect(options.rows * options.columns).toBeLessThanOrEqual(bound);
        return original(options);
      });
      const follow = new Object3D();
      const refresh = vi.spyOn(ctx.physics.simulation, "setColliderShape");
      const forest = await addStarterWorld(ctx, follow, {
        name: "test",
        url: "terrain/forest/world.json",
        colliders: {},
        colliderReach: 0,
        groundCollisionLayer: 4,
        loadSurface: async () => surface,
        lighting: { sky: "sky.hdr", lods: false, dress: () => {} },
        streaming: {
          ring: size === 256 ? 3 : radius,
          budgets: { residentCells: 64, instances: 40_000, bytes: 64_000_000 },
          terrain: size === 256 ? { colliderRadius: radius } : {},
        },
      });
      const ground = forest.ground;
      const id = ground.body.id;
      expect(ctx.physics.numBodies()).toBe(1);
      expect(ground.shape.descriptor.heights).toHaveLength(bound);
      expect(forest.field.rows).toBe(3);
      const tick = () => {
        for (const callback of callbacks) callback();
        plugin.update?.(ctx, 1 / 60);
      };
      const contact = () => {
        // Probe inside a triangle, away from Rapier's ambiguous shared vertex ray hits.
        const x = follow.position.x + 0.125;
        const z = follow.position.z + 0.1875;
        const hit = ctx.physics.directSpaceState.intersectRay({
          from: { x, y: 20, z },
          to: { x, y: -20, z },
        });
        expect(hit?.body.id).toBe(id);
        expect(hit?.position.y).toBeCloseTo(forest.field.heightAt(x, z), 4);
      };
      tick();
      follow.position.x = 31;
      tick();
      expect(refresh).not.toHaveBeenCalled();
      follow.position.x = 33;
      tick();
      expect(refresh).toHaveBeenCalledOnce();
      contact();
      expect(forest.ground).toBe(ground);
      expect(ground.body.id).toBe(id);
      expect(refresh.mock.calls[0]?.[1]).toBe(ground.shape.descriptor);
      follow.position.set(size / 2 - 1, 0, size / 2 - 1);
      tick();
      expect(refresh).toHaveBeenCalledTimes(2);
      contact();
      const descriptor = ground.shape.descriptor;
      expect(descriptor.collisionLayer).toBe(4);
      expect(descriptor.heights?.length).toBeLessThanOrEqual(bound);
      expect((ground.object?.position.x ?? 0) + (descriptor.scale?.x ?? 0) / 2).toBeLessThanOrEqual(
        size / 2,
      );
      follow.position.set(size * 2, 0, -size * 2);
      tick();
      expect(refresh).toHaveBeenCalledTimes(3);
      const late = [...callbacks];
      if (radius === 0) for (const dispose of lifetimes.splice(0)) dispose();
      else ground.dispose();
      expect(callbacks.size).toBe(0);
      follow.position.x = -size / 2;
      tick();
      for (const callback of late) callback();
      expect(refresh).toHaveBeenCalledTimes(3);
      expect(ctx.physics.numBodies()).toBe(0);
    },
  );

  it.each([
    [0, 0.125, 0],
    [0.125, 0.125, 0],
    [0.1, 8, 0],
    [-40.1, 80.25, 0],
    [0, 0.125, 1],
    [0.125, 0.125, 1],
    [0.1, 8, 1],
    [-40.1, 80.25, 1],
  ])("covers outward lattice edges for min %s size %s radius %s", async (min, size, radius) => {
    const { ctx, plugin } = await context();
    const source = {
      ...manifest,
      extent: { minX: min, minZ: min, sizeX: size, sizeZ: size },
      terrain: { ...manifest.terrain, spacing: size / 2 },
    };
    const fetchOriginal = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string) => {
      if (input.endsWith("world.json"))
        return Promise.resolve(new Response(JSON.stringify(source)));
      if (input.endsWith("heightmap.u16"))
        return Promise.resolve(new Response(new Uint16Array(9).fill(20000).buffer));
      return fetchOriginal(input);
    });
    const tiles = new TerrainTiles({
      sampleHeight: () => 0,
      surface,
      tileSize: 32,
      tileResolution: 65,
      residentTileBudget: 1,
      residentByteBudget: 1_000_000,
    });
    loads.world.mockImplementationOnce(async () => {
      const world = Object.assign(new Group(), { dispose: vi.fn(() => tiles.dispose()) });
      world.add(tiles);
      worlds.push(world);
      return world;
    });
    const callbacks = new Set<() => void>();
    Object.assign(ctx, {
      every: (callback: () => void) => {
        callbacks.add(callback);
        return () => callbacks.delete(callback);
      },
    });
    const follow = new Object3D();
    follow.position.set(min + size / 2, 0, min + size / 2);
    const refresh = vi.spyOn(ctx.physics.simulation, "setColliderShape");
    // Outward rounding adds at most one vertex per extent edge. The tile window
    // still caps each axis at (2r + 1) * cells + 1, including out-of-world teleports.
    const cells = tiles.tileResolution - 1;
    const extentVertices = Math.ceil(size / (tiles.tileSize / cells)) + 2;
    const axisBound = Math.min((2 * radius + 1) * cells + 1, extentVertices);
    const fromSampler = Heightfield.fromSampler.bind(Heightfield);
    vi.spyOn(Heightfield, "fromSampler").mockImplementation((options) => {
      expect(options.rows).toBeGreaterThanOrEqual(2);
      expect(options.columns).toBeGreaterThanOrEqual(2);
      expect(options.rows * options.columns).toBeLessThanOrEqual(axisBound ** 2);
      return fromSampler(options);
    });
    const forest = await addStarterWorld(ctx, follow, {
      name: "test",
      url: "terrain/forest/world.json",
      colliders: {},
      colliderReach: 0,
      groundCollisionLayer: 4,
      loadSurface: async () => surface,
      lighting: { sky: "sky.hdr", lods: false, dress: () => {} },
      streaming: {
        ring: radius,
        budgets: { residentCells: 64, instances: 40_000, bytes: 64_000_000 },
        terrain: { colliderRadius: radius },
      },
    });
    const ground = forest.ground;
    const descriptor = ground.shape.descriptor;
    const id = ground.body.id;
    const probe = (position: number, x: number, z: number) => {
      follow.position.set(position, 0, position);
      for (const callback of callbacks) callback();
      plugin.update?.(ctx, 1 / 60);
      expect(ctx.physics.numBodies()).toBe(1);
      expect(forest.ground).toBe(ground);
      expect(ground.body.id).toBe(id);
      expect(ground.shape.descriptor).toBe(descriptor);
      expect(descriptor.collisionLayer).toBe(4);
      expect(descriptor.scale?.x).toBeGreaterThanOrEqual(tiles.tileSize / cells);
      expect(descriptor.scale?.z).toBeGreaterThanOrEqual(tiles.tileSize / cells);
      expect(descriptor.heights?.length).toBeLessThanOrEqual(axisBound ** 2);
      const hit = ctx.physics.directSpaceState.intersectRay({
        from: { x, y: 20, z },
        to: { x, y: -20, z },
      });
      expect(hit?.body.id).toBe(id);
      expect(hit?.position.y).toBeCloseTo(forest.field.heightAt(x, z), 4);
    };
    const inset = Math.min(size / 8, 0.03125);
    probe(min + size / 2, min + size / 2, min + size / 2 + inset);
    probe(min + inset, min + inset, min + 2 * inset);
    probe(min + size - inset, min + size - inset, min + size - 2 * inset);
    if (size > tiles.tileSize) {
      probe(16 - inset, 16 - inset, 16 - 2 * inset);
      probe(16 + inset, 16 + inset, 16 + 2 * inset);
    }
    probe(min - tiles.tileSize * 10, min + inset, min + 2 * inset);
    probe(min + size + tiles.tileSize * 10, min + size - inset, min + size - 2 * inset);
    for (const call of refresh.mock.calls) expect(call[1]).toBe(descriptor);
    const late = [...callbacks];
    ground.dispose();
    expect(callbacks.size).toBe(0);
    for (const callback of late) callback();
    expect(ctx.physics.numBodies()).toBe(0);
  });

  it("passes its own source table to the ground instead of baked appearance", async () => {
    const { ctx } = await context();
    const source = JSON.parse(
      readFileSync(new URL(`../starter/${"forest"}/surface.json`, import.meta.url), "utf8"),
    ) as ITerrainSplatTable;
    const baked = {
      ...source,
      base: { ...source.base, tint: [0.01, 0.02, 0.03] },
      splat: {
        size: 1,
        planes: 1,
        masks: Object.fromEntries(source.layers.map((layer) => [layer.mask, [0, "r"]])),
      },
    };
    const fetchOriginal = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string) => {
      if (input.endsWith("world.json"))
        return new Response(
          JSON.stringify({
            ...manifest,
            terrain: {
              ...manifest.terrain,
              layers: { table: "terrain-table.json", splat: "splat.rgba8" },
            },
          }),
        );
      if (input.endsWith("terrain-table.json")) return new Response(JSON.stringify(baked));
      if (input.endsWith("splat.rgba8")) return new Response(new Uint8Array(4));
      return fetchOriginal(input);
    });
    ctx.assets.texture = async () => new Texture();
    const actual =
      await vi.importActual<typeof import("@threenative/core/world")>("@threenative/core/world");
    const seen: Array<readonly [number, number, number]> = [];
    loads.surface.mockImplementationOnce((options: ILoadTerrainSplatOptions) =>
      actual.loadTerrainSplat({
        ...options,
        layerSample: ({ layer }) => {
          seen.push(layer.tint);
          return { color: vec3(0.5) };
        },
      }),
    );
    const result = await addForest(ctx, new Object3D());
    expect(loads.surface.mock.calls[0]?.[0].table).toEqual(source);
    expect(seen[0]).toEqual(source.base.tint);
    expect(seen[0]).not.toEqual(baked.base.tint);
    expect(loads.world.mock.calls[0]?.[0].surface).toBe(await loads.surface.mock.results[0]?.value);
    result.water.dispose();
  });

  it("streams prop colliders when only the follow object's parent moves", async () => {
    const { ctx, plugin } = await context();
    const parent = new Object3D();
    const follow = new Object3D();
    parent.add(follow);
    const colliders = new PropColliders(ctx, follow, manifest, records);
    parent.position.x = 130;
    colliders.process();
    plugin.update?.(ctx, 1 / 60);
    const hit = (x: number) =>
      ctx.physics.directSpaceState.intersectRay({
        from: { x, y: 3, z: -2 },
        to: { x, y: 3, z: 2 },
      });
    expect(hit(130)).toBeDefined();
    expect(hit(0)).toBeUndefined();
    colliders.detach();
  });

  it("draws the lake and river the bake wrote, and counts them in the result", async () => {
    const { ctx } = await context();
    const forest = await addForest(ctx, new Object3D());
    expect(requests).toContain("terrain/forest/water.json");
    expect(forest.water).toMatchObject({ lakes: 1, rivers: 1 });
    // The lake's sheet is the one mesh whose material fades at the shore; it must cover the flooded ground.
    const scene = (ctx as unknown as { scene: Group }).scene;
    const lake = scene.children.find(
      (child): child is Mesh =>
        child instanceof Mesh &&
        (child.material as { opacityNode?: unknown }).opacityNode !== undefined,
    );
    expect(lake?.geometry.index?.count ?? 0).toBeGreaterThan(0);
    forest.water.dispose();
  });

  it("shades the ground with the kit's own dielectric specular instead of three's default 1", async () => {
    const { ctx } = await context();
    const forest = await addForest(ctx, new Object3D());
    const { materialFactory } = loads.surface.mock.calls[0]?.[0] as ILoadTerrainSplatOptions;
    const ground = materialFactory?.({
      color: vec3(0.5),
      normal: vec3(0.5, 0.5, 1),
      orm: vec3(1, 0.9, 0),
    });
    expect(ground).toBeInstanceOf(MeshPhysicalNodeMaterial);
    expect((ground as MeshPhysicalNodeMaterial).specularIntensity).toBe(GROUND_SPECULAR);
    expect(GROUND_SPECULAR).toBeLessThan(new MeshPhysicalNodeMaterial().specularIntensity);
    expect(ground?.name).toBe("terrain-splat");
    ground?.dispose();
    forest.water.dispose();
  });

  it("measures its four metre refresh threshold in the same world coordinates", async () => {
    const { ctx } = await context();
    const parent = new Object3D();
    parent.position.x = 100;
    const follow = new Object3D();
    parent.add(follow);
    const poses = records.slice();
    poses[0] = 100;
    poses[8] = 161;
    const colliders = new PropColliders(ctx, follow, manifest, poses);
    expect(colliders.active).toBe(1);
    parent.position.x = 102;
    colliders.process();
    expect(colliders.active).toBe(1);
    parent.position.x = 105;
    colliders.process();
    expect(colliders.active).toBe(2);
    colliders.detach();
  });

  it("releases already created prop bodies if collider construction fails", async () => {
    const { ctx, plugin } = await context();
    const create = ctx.physics.simulation.createBody.bind(ctx.physics.simulation);
    vi.spyOn(ctx.physics.simulation, "createBody")
      .mockImplementationOnce(create)
      .mockImplementationOnce(() => {
        throw new Error("collider allocation failed");
      });
    const poses = records.slice();
    poses[8] = 20;
    expect(() => new PropColliders(ctx, new Object3D(), manifest, poses)).toThrow(
      "collider allocation failed",
    );
    plugin.update?.(ctx, 1 / 60);
    expect(
      ctx.physics.directSpaceState.intersectRay({
        from: { x: 0, y: 3, z: -2 },
        to: { x: 0, y: 3, z: 2 },
      }),
    ).toBeUndefined();
  });

  it("loads the canonical placement and height buffers once for streaming and ground collision", async () => {
    const { ctx } = await context();
    const forest = await addForest(ctx, new Object3D());
    for (const name of ["world.json", "placements.bin", "heightmap.u16"])
      expect(
        requests.filter((path) => path.endsWith(name)),
        name,
      ).toHaveLength(1);
    const data = loads.world.mock.calls[0]?.[0].data;
    expect(data.manifest).toEqual(manifest);
    expect(new Float32Array(data.placements)).toEqual(records);
    expect(data.heightmap).toEqual(heightmap);
    expect(forest.placementIds).toBeUndefined();
    expect(requests.some((path) => path.includes("placement-ids"))).toBe(false);
    expect(forest.ground.shape.descriptor.kind).toBe("heightfield");
    expect(forest.ground.shape.descriptor.heights).toHaveLength(9);
    expect(forest.ground.shape.descriptor.heights?.[4]).toBeCloseTo((8000 / 65535) * 10);
  });

  it("does not attach a world after cancellation during its async load", async () => {
    const { ctx } = await context();
    let current = true;
    const load = loads.world.getMockImplementation();
    loads.world.mockImplementation(async (options: IWorldCellsLoadOptions) => {
      const world = await load?.(options);
      current = false;
      return world;
    });
    await expect(addForest(ctx, new Object3D(), undefined, () => current)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(ctx.scene.children).toHaveLength(0);
    expect(worlds[0]?.dispose).toHaveBeenCalledOnce();
    expect(surface.dispose).toHaveBeenCalledOnce();
    expect(sky.dispose).toHaveBeenCalledOnce();
  });

  it("stops after a stale surface load before allocating the lighting or world", async () => {
    const { ctx } = await context();
    let current = true;
    loads.surface.mockImplementation(async () => {
      current = false;
      return surface;
    });
    await expect(addForest(ctx, new Object3D(), undefined, () => current)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(loads.sky).not.toHaveBeenCalled();
    expect(loads.world).not.toHaveBeenCalled();
    expect(surface.dispose).toHaveBeenCalledOnce();
  });

  it.each(["placements", "heightmap"])("stops after cancelled %s decoding", async (part) => {
    const { ctx } = await context();
    let current = true;
    const fetchOriginal = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string) => {
      const response = await fetchOriginal(input);
      if (input.includes(part)) {
        const decode = response.arrayBuffer.bind(response);
        response.arrayBuffer = async () => {
          const buffer = await decode();
          current = false;
          return buffer;
        };
      }
      return response;
    });
    await expect(addForest(ctx, new Object3D(), undefined, () => current)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(loads.surface).not.toHaveBeenCalled();
    expect(loads.world).not.toHaveBeenCalled();
    expect(ctx.scene.children).toHaveLength(0);
  });

  it.each(["sky", "model"])(
    "releases lighting after cancellation during %s loading",
    async (part) => {
      const { ctx } = await context();
      let current = true;
      if (part === "sky")
        loads.sky.mockImplementation(async () => {
          current = false;
          return sky;
        });
      else
        vi.spyOn(ctx.assets, "model").mockImplementation(async () => {
          current = false;
          return { scene: new Group() };
        });
      await expect(addForest(ctx, new Object3D(), undefined, () => current)).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(loads.world).not.toHaveBeenCalled();
      expect(surface.dispose).toHaveBeenCalledOnce();
      expect(sky.dispose).toHaveBeenCalledOnce();
      expect(ctx.scene.children).toHaveLength(0);
    },
  );

  it("releases acquired lighting when a model fails before world creation", async () => {
    const { ctx } = await context();
    ctx.assets.model = async () => {
      throw new Error("missing fir.glb");
    };
    await expect(addForest(ctx, new Object3D())).rejects.toThrow("missing fir.glb");
    expect(sky.dispose).toHaveBeenCalledOnce();
    expect(surface.dispose).toHaveBeenCalledOnce();
    expect(ctx.scene.children).toHaveLength(0);
  });

  it("releases the ground, props and owned lighting at the scene lifetime boundary", async () => {
    const { ctx, plugin } = await context();
    const follow = new Object3D();
    const forest = await addForest(ctx, follow);
    expect(forest.colliders.active).toBe(1);
    for (const dispose of lifetimes.splice(0)) dispose();
    plugin.update?.(ctx, 1 / 60);
    expect(forest.colliders.released).toBe(true);
    expect(forest.colliders.active).toBe(0);
    follow.position.x = 130;
    forest.colliders.process();
    expect(forest.colliders.active).toBe(0);
    expect(ctx.scene.children).toHaveLength(0);
    expect(surface.dispose).toHaveBeenCalledOnce();
    expect(sky.dispose).toHaveBeenCalledOnce();
    expect(
      ctx.physics.directSpaceState.intersectRay({
        from: { x: 0, y: 50, z: 0 },
        to: { x: 0, y: -50, z: 0 },
      }),
    ).toBeUndefined();
  });

  it("restores shared model lighting without disposing cached model materials", async () => {
    const { ctx, model } = await context();
    const priorSky = new Texture();
    const material = new MeshStandardMaterial({ envMap: priorSky, envMapIntensity: 0.25 });
    const mesh = new Mesh(undefined, material);
    model.add(mesh);
    vi.spyOn(material, "dispose");
    await addForest(ctx, new Object3D());
    expect(material.envMap).toBe(sky);
    for (const dispose of lifetimes.splice(0)) dispose();
    expect(material.envMap).toBe(priorSky);
    expect(material.envMapIntensity).toBe(0.25);
    expect(material.dispose).not.toHaveBeenCalled();
    mesh.geometry.dispose();
    priorSky.dispose();
  });
});
