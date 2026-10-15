import { readFileSync } from "node:fs";
import type { ICtx } from "@threenative/core";
import type {
  ILoadTerrainSplatOptions,
  ITerrainSplatTable,
  IWorldCellsLoadOptions,
  IWorldPackage,
} from "@threenative/core/world";
import { type IPhysicsContext, rapier } from "@threenative/physics";
import { Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, Texture } from "three";
import { vec3 } from "three/tsl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addStarterWorld } from "../src/starter.js";
import { PropColliders as AlpineColliders, addAlpine } from "../starter/alpine/world.js";
import { PropColliders as CoastalColliders, addCoastal } from "../starter/coastal/world.js";
import { PropColliders as DesertColliders, addDesert } from "../starter/desert/world.js";
import { PropColliders as ForestColliders, addForest } from "../starter/forest/world.js";
import { PropColliders as TundraColliders, addTundra } from "../starter/tundra/world.js";

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

vi.mock("../starter/coastal/sea.js", () => ({
  addCoastalSea: vi.fn(() => ({ mesh: {}, dispose: vi.fn() })),
}));
// Only these columns differed: asset, water response/request and missing-model filename.
const kits = [
  {
    kit: "forest",
    addWorld: addForest,
    Collider: ForestColliders,
    asset: "fir",
    water: { lakes: [], rivers: [] },
  },
  {
    kit: "alpine",
    addWorld: addAlpine,
    Collider: AlpineColliders,
    asset: "boulder",
    water: undefined,
  },
  {
    kit: "desert",
    addWorld: addDesert,
    Collider: DesertColliders,
    asset: "boulder",
    water: undefined,
  },
  {
    kit: "tundra",
    addWorld: addTundra,
    Collider: TundraColliders,
    asset: "boulder",
    water: { lakes: [], rivers: [] },
  },
  {
    kit: "coastal",
    addWorld: addCoastal,
    Collider: CoastalColliders,
    asset: "fir",
    water: { lakes: [{ id: "ocean", radius: 512, level: 1.5 }], rivers: [] },
  },
];
describe.each(kits)("$kit runtime", ({ kit, addWorld, Collider, asset, water }) => {
  type Ctx = ICtx<Record<string, unknown>, IPhysicsContext>;
  const plugins: ReturnType<typeof rapier>[] = [];
  const lifetimes: Array<() => void> = [];
  const worlds: Array<Group & { dispose(): void }> = [];
  const manifest: IWorldPackage = {
    version: 1,
    cellSize: 64,
    extent: { minX: -128, minZ: -128, sizeX: 256, sizeZ: 256 },
    assets: { [asset]: { glb: `${asset}.glb`, bounds: { min: [-1, 0, -1], max: [1, 1, 1] } } },
    cells: [{ x: 0, z: 0, runs: [{ asset, offset: 0, count: 2 }] }],
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
  // Two boulders, eight floats each: x, y, z, three unused, a scale in the last slot. One sits at the
  // origin and one 130 m east.
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
        await (await fetch(`terrain/${kit}/placements.bin`)).arrayBuffer();
        await (await fetch(`terrain/${kit}/heightmap.u16`)).arrayBuffer();
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
      throw new Error(`Unexpected ${kit} request: ${input}`);
    });
  });

  afterEach(() => {
    for (const dispose of lifetimes.splice(0)) dispose();
    for (const world of worlds.splice(0)) world.dispose();
    for (const plugin of plugins.splice(0)) plugin.dispose?.({} as Ctx);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("applies startup edits before streaming, dressing, collisions and returned data", async () => {
    const { ctx, plugin } = await context();
    const source = { ...manifest, placementIds: "placement-ids.json" };
    const bytes = records.slice();
    bytes[8] = 120;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string) => {
      if (input.endsWith("world.json")) return new Response(JSON.stringify(source));
      if (input.endsWith("placements.bin")) return new Response(bytes.buffer);
      if (input.endsWith("placement-ids.json"))
        return new Response(JSON.stringify(["move", "promote"]));
      return originalFetch(input);
    });
    const dress = vi.fn();
    const mesh = new Mesh(undefined, new MeshStandardMaterial());
    vi.spyOn(ctx.assets, "model").mockResolvedValue({ scene: new Group().add(mesh) });
    const result = await addStarterWorld(ctx, new Object3D(), {
      name: kit,
      url: `terrain/${kit}/world.json`,
      colliders: { [asset]: { sphere: 0.9 }, lantern: { sphere: 0.5 } },
      colliderReach: 60,
      loadSurface: async () => surface,
      lighting: { sky: "sky.hdr", lods: true, dress },
      streaming: { ring: 1, budgets: { residentCells: 9, instances: 100, bytes: 1_000_000 } },
      edits: {
        assets: {
          lantern: { glb: "props/lantern.glb", bounds: { min: [-1, -1, -1], max: [1, 1, 1] } },
        },
        remove: ["promote"],
        overrides: { move: { position: [12, 99, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] } },
        add: [
          {
            id: "new",
            asset: "lantern",
            position: [20, 7, 0],
            quaternion: [0, 0, 0, 1],
            scale: [1, 1, 1],
            grounding: false,
          },
        ],
      },
    });
    const data = loads.world.mock.calls[0]?.[0].data;
    expect(data.manifest).toBe(result.manifest);
    expect(data.placements).toBe(result.placements.buffer);
    expect(result.placementIds).toEqual(["move", "new"]);
    expect(result.placements[0]).toBe(12);
    expect(result.placements[1]).toBeCloseTo(result.field.heightAt(12, 0));
    expect(result.placements[9]).toBe(7);
    expect(result.editReport).toEqual({
      unmatched: [],
      removed: [
        { id: "promote", asset, position: [120, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 },
      ],
    });
    expect(ctx.assets.model).toHaveBeenCalledWith(`terrain/${kit}/props/lantern.glb`);
    expect(
      dress.mock.calls.filter((call) => call[0] instanceof Mesh).map((call) => call[2]),
    ).toEqual([asset, "lantern"]);
    expect(result.colliders.active).toBe(2);
    plugin.update?.(ctx, 1 / 60);
    const hit = ctx.physics.directSpaceState.intersectRay({
      from: { x: 12, y: result.field.heightAt(12, 0), z: -2 },
      to: { x: 12, y: result.field.heightAt(12, 0), z: 2 },
    });
    expect(hit?.body.entity).toBe(`${asset}.0`);
    mesh.geometry.dispose();
    (mesh.material as MeshStandardMaterial).dispose();
  });

  it("preserves decoded manifest and placement byte identity without edits", async () => {
    const { ctx } = await context();
    const bytes = records.slice().buffer;
    const source = { ...manifest, placementIds: "placement-ids.json" };
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string) => {
      if (input.endsWith("world.json")) return { ok: true, json: async () => source };
      if (input.endsWith("placements.bin")) return { ok: true, arrayBuffer: async () => bytes };
      if (input.endsWith("placement-ids.json"))
        return new Response(JSON.stringify(["first", "second"]));
      return originalFetch(input);
    });
    const result = await addWorld(ctx, new Object3D());
    expect(loads.world.mock.calls[0]?.[0].data.manifest).toBe(source);
    expect(loads.world.mock.calls[0]?.[0].data.placements).toBe(bytes);
    expect(result.manifest).toBe(source);
    expect(result.placements.buffer).toBe(bytes);
    expect(result.placementIds).toEqual(["first", "second"]);
    expect(result.editReport).toEqual({ unmatched: [], removed: [] });
  });

  it.each([
    { ids: ["one"] },
    { ids: ["same", "same"] },
    { ids: ["", "second"] },
    { ids: [1, "second"] },
    { ids: {} },
  ])("rejects invalid placement IDs without edits: %j", async ({ ids }) => {
    const { ctx } = await context();
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string) => {
      if (input.endsWith("world.json"))
        return new Response(JSON.stringify({ ...manifest, placementIds: "placement-ids.json" }));
      if (input.endsWith("placement-ids.json")) return new Response(JSON.stringify(ids));
      return originalFetch(input);
    });
    await expect(addWorld(ctx, new Object3D())).rejects.toThrow(/placement IDs/);
    expect(loads.world).not.toHaveBeenCalled();
    expect(ctx.scene.children).toHaveLength(0);
  });

  it("passes its own source table to the ground instead of baked appearance", async () => {
    const { ctx } = await context();
    const source = JSON.parse(
      readFileSync(new URL(`../starter/${kit}/surface.json`, import.meta.url), "utf8"),
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
    await addWorld(ctx, new Object3D());
    expect(loads.surface.mock.calls[0]?.[0].table).toEqual(source);
    expect(seen[0]).toEqual(source.base.tint);
    expect(seen[0]).not.toEqual(baked.base.tint);
    expect(loads.world.mock.calls[0]?.[0].surface).toBe(await loads.surface.mock.results[0]?.value);
  });

  it("streams boulder colliders when only the follow object's parent moves", async () => {
    const { ctx, plugin } = await context();
    const parent = new Object3D();
    const follow = new Object3D();
    parent.add(follow);
    const colliders = new Collider(ctx, follow, manifest, records);
    parent.position.x = 130;
    colliders.process();
    plugin.update?.(ctx, 1 / 60);
    // A boulder's sphere sits on its origin, so a ray half a metre up crosses it.
    const hit = (x: number) =>
      ctx.physics.directSpaceState.intersectRay({
        from: { x, y: 0.5, z: -2 },
        to: { x, y: 0.5, z: 2 },
      });
    expect(hit(130)).toBeDefined();
    expect(hit(0)).toBeUndefined();
    colliders.detach();
  });

  it("adds the world, its ground and the boulder colliders near the follow object", async () => {
    const { ctx } = await context();
    const alpine = await addWorld(ctx, new Object3D());
    expect(requests).toContain(`terrain/${kit}/world.json`);
    if (water) expect(requests).toContain(`terrain/${kit}/water.json`);
    else expect(requests).not.toContain(`terrain/${kit}/water.json`);
    expect(alpine.colliders.active).toBe(1);
    expect(alpine.ground.shape.descriptor.kind).toBe("heightfield");
    expect(ctx.scene.children).toHaveLength(3);
  });

  it("creates terrain on the requested query layer before registering its collider", async () => {
    const { ctx, plugin } = await context();
    const result = await addStarterWorld(ctx, new Object3D(), {
      name: kit,
      url: `terrain/${kit}/world.json`,
      colliders: {},
      colliderReach: 60,
      groundCollisionLayer: 4,
      loadSurface: async () => surface,
      lighting: { sky: "sky.hdr", lods: false, dress: () => {} },
      streaming: { ring: 1, budgets: { residentCells: 9, instances: 100, bytes: 1_000_000 } },
    });
    plugin.update?.(ctx, 1 / 60);
    const ray = { from: { x: 0, y: 100, z: 0 }, to: { x: 0, y: -100, z: 0 } };
    expect(ctx.physics.directSpaceState.intersectRay({ ...ray, collisionMask: 4 })?.body.id).toBe(
      result.ground.body.id,
    );
    expect(ctx.physics.directSpaceState.intersectRay({ ...ray, collisionMask: 1 })).toBeUndefined();
  });

  it("loads each world file once and hands the buffers to the streamer and the ground", async () => {
    const { ctx } = await context();
    const alpine = await addWorld(ctx, new Object3D());
    for (const name of ["world.json", "placements.bin", "heightmap.u16"])
      expect(
        requests.filter((path) => path.endsWith(name)),
        name,
      ).toHaveLength(1);
    const data = loads.world.mock.calls[0]?.[0].data;
    expect(data.manifest).toEqual(manifest);
    expect(new Float32Array(data.placements)).toEqual(records);
    expect(data.heightmap).toEqual(heightmap);
    expect(alpine.ground.shape.descriptor.heights).toHaveLength(9);
    expect(alpine.ground.shape.descriptor.heights?.[4]).toBeCloseTo((8000 / 65535) * 10);
    // The scene picks its spawn and cameras from these, so they must read the same terrain and placements.
    expect(alpine.field.heightAt(0, 0)).toBeCloseTo((8000 / 65535) * 10);
    expect(alpine.placements).toHaveLength(records.length);
    expect(alpine.extent).toEqual(manifest.extent);
    expect(alpine.placementIds).toBeUndefined();
    expect(requests.some((path) => path.includes("placement-ids"))).toBe(false);
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
    await expect(addWorld(ctx, new Object3D(), undefined, () => current)).rejects.toMatchObject({
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
    await expect(addWorld(ctx, new Object3D(), undefined, () => current)).rejects.toMatchObject({
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
    await expect(addWorld(ctx, new Object3D(), undefined, () => current)).rejects.toMatchObject({
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
      await expect(addWorld(ctx, new Object3D(), undefined, () => current)).rejects.toMatchObject({
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
      throw new Error(`missing ${asset}.glb`);
    };
    await expect(addWorld(ctx, new Object3D())).rejects.toThrow(`missing ${asset}.glb`);
    expect(sky.dispose).toHaveBeenCalledOnce();
    expect(surface.dispose).toHaveBeenCalledOnce();
    expect(ctx.scene.children).toHaveLength(0);
  });

  it("releases the ground, props and owned lighting at the scene lifetime boundary", async () => {
    const { ctx, plugin } = await context();
    const follow = new Object3D();
    const alpine = await addWorld(ctx, follow);
    expect(alpine.colliders.active).toBe(1);
    for (const dispose of lifetimes.splice(0)) dispose();
    plugin.update?.(ctx, 1 / 60);
    expect(alpine.colliders.released).toBe(true);
    expect(alpine.colliders.active).toBe(0);
    follow.position.x = 130;
    alpine.colliders.process();
    expect(alpine.colliders.active).toBe(0);
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
    await addWorld(ctx, new Object3D());
    expect(material.envMap).toBe(sky);
    for (const dispose of lifetimes.splice(0)) dispose();
    expect(material.envMap).toBe(priorSky);
    expect(material.envMapIntensity).toBe(0.25);
    expect(material.dispose).not.toHaveBeenCalled();
    mesh.geometry.dispose();
    priorSky.dispose();
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
    const colliders = new Collider(ctx, follow, manifest, poses);
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
    expect(() => new Collider(ctx, new Object3D(), manifest, poses)).toThrow(
      "collider allocation failed",
    );
    plugin.update?.(ctx, 1 / 60);
    expect(
      ctx.physics.directSpaceState.intersectRay({
        from: { x: 0, y: 0.5, z: -2 },
        to: { x: 0, y: 0.5, z: 2 },
      }),
    ).toBeUndefined();
  });
});
