import type { ICtx } from "@threenative/core";
import type { IWorldCellsLoadOptions, IWorldPackage } from "@threenative/core/world";
import { type IPhysicsContext, rapier } from "@threenative/physics";
import { Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, Texture } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PropColliders, addForest } from "../starter/forest/world.js";

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
