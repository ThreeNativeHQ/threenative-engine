import {
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
} from "three";
import { describe, expect, it, vi } from "vitest";
import {
  DiscreteLodPlugin,
  TN_DISCRETE_LOD,
  isLodJoinProxy,
  updateModelLods,
} from "../src/model-lod.js";
import type { IRendererLike } from "../src/renderer.js";
import { type IWorldPackage, WorldCells } from "../src/world.js";

function geometry(triangles: number): BufferGeometry {
  const result = new BufferGeometry();
  result.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
  );
  result.setIndex(
    new BufferAttribute(new Uint16Array(Array.from({ length: triangles * 3 }, (_, i) => i % 3)), 1),
  );
  return result;
}
function model(triangles: number): Group {
  const result = new Group();
  result.add(new Mesh(geometry(triangles), new MeshBasicMaterial()));
  return result;
}
async function joinedModel(instancedJoin = false): Promise<Group> {
  const result = model(4);
  result.add(new Mesh(geometry(4), new MeshBasicMaterial()));
  const associations = new Map<object, Record<string, number>>([[result, { meshes: 0, nodes: 0 }]]);
  result.children.forEach((mesh, index) =>
    associations.set(mesh, { meshes: 0, nodes: 0, primitives: index }),
  );
  const definition = {
    absoluteErrors: [0.01],
    counts: [2],
    errors: [0.01],
    indices: [0],
    lod0Triangles: 4,
    schemaVersion: 1,
    sharedVertexBuffers: true,
    strategy: "discrete",
  };
  const plugin = new DiscreteLodPlugin();
  plugin.setParser({
    associations,
    getDependency: async (type: string) => {
      if (type !== "mesh") return { array: new Uint16Array([0, 1, 2, 0, 1, 2]) };
      if (!instancedJoin) return model(2);
      const root = new Group();
      const mesh = new InstancedMesh(geometry(1), new MeshBasicMaterial(), 2);
      mesh.setMatrixAt(0, new Matrix4());
      mesh.setMatrixAt(1, new Matrix4());
      root.add(mesh);
      return root;
    },
    json: {
      extensions: {
        [TN_DISCRETE_LOD]: {
          joined: [
            {
              draws: 1,
              error: 0.01,
              mesh: "chunk__lod_join",
              primitives: 2,
              sources: ["chunk#0", "chunk#1"],
              triangles: 2,
            },
          ],
        },
      },
      meshes: [
        {
          name: "chunk",
          primitives: result.children.map(() => ({
            extensions: { [TN_DISCRETE_LOD]: definition },
          })),
        },
        { name: "chunk__lod_join", primitives: [{}] },
      ],
    },
  } as never);
  await plugin.afterRoot({ scene: result });
  plugin.attach(result, { hysteresis: 0.15, maxPixelError: 1 });
  return result;
}
function manifest(): IWorldPackage {
  return {
    version: 1,
    extent: { minX: 0, minZ: 0, sizeX: 64, sizeZ: 32 },
    cellSize: 32,
    terrain: {
      heightmap: "height.u16",
      columns: 3,
      rows: 2,
      spacing: 32,
      heightMin: 0,
      heightMax: 2,
    },
    placements: "placements.bin",
    assets: { stone: { glb: "stone.glb", lods: [], bounds: { min: [0, 0, 0], max: [1, 1, 0] } } },
    cells: [
      {
        x: 0,
        z: 0,
        runs: [{ asset: "stone", offset: 0, count: 2 }],
        proxy: {
          glb: "proxy.glb",
          scope: "cell",
          triangles: 1,
          materialGroups: 1,
          error: 0.1,
          bounds: { min: [10, 0, 10], max: [20, 1, 10] },
        },
      },
    ],
  };
}
const records = new Float32Array([10, 0, 10, 0, 0, 0, 1, 1, 19, 0, 10, 0, 0, 0, 1, 1]);
const camera = new PerspectiveCamera(60, 1, 0.1, 2000);
function far(): void {
  camera.position.set(15, 1, 600);
  camera.lookAt(15, 1, 10);
  camera.updateMatrixWorld(true);
}
function renderer(compile = async (): Promise<void> => undefined): IRendererLike {
  return {
    info: { render: { drawCalls: 0 } },
    domElement: { height: 1080 },
    kind: "webgl",
    raw: {},
    compileAsync: vi.fn(compile),
    uploadAttributes: vi.fn(() => 1),
  } as unknown as IRendererLike;
}
async function pump(world: WorldCells, render: IRendererLike, count = 12): Promise<void> {
  for (let i = 0; i < count; i++) {
    world.update(render, camera);
    for (let j = 0; j < 8; j++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
function proxy(world: WorldCells): Group | undefined {
  return world.children.find((child) => child.name.startsWith("world-cell-proxy:")) as
    | Group
    | undefined;
}
function mains(world: WorldCells): InstancedMesh[] {
  const result: InstancedMesh[] = [];
  world.traverse((node) => {
    if (node instanceof InstancedMesh && node.layers.isEnabled(0) && node.count > 0)
      result.push(node);
  });
  return result;
}
function observe(world: WorldCells, render: IRendererLike): void {
  proxy(world)?.traverse((node) => {
    if (node instanceof Mesh) {
      node.onBeforeRender(
        render.raw as never,
        world.parent as Scene,
        camera,
        node.geometry,
        node.material as never,
        null as never,
      );
      (render.info as { render: { drawCalls: number } }).render.drawCalls++;
      node.onAfterRender(
        render.raw as never,
        world.parent as Scene,
        camera,
        node.geometry,
        node.material as never,
        null as never,
      );
    }
  });
}
async function load(
  options: Partial<Parameters<typeof WorldCells.load>[0]> = {},
): Promise<WorldCells> {
  far();
  const world = await WorldCells.load({
    url: "/world/world.json",
    surface: new MeshBasicMaterial(),
    follow: { position: { x: 15, z: 10 } },
    ring: 0,
    budgets: { bytes: 10_000_000, instances: 100, residentCells: 2 },
    terrain: false,
    gpuScene: false,
    bundles: false,
    adaptiveLod: false,
    data: { manifest: manifest(), placements: records.buffer },
    loadModel: async (url) => {
      const result = model(url.endsWith("proxy.glb") ? 1 : 2);
      if (url.endsWith("proxy.glb")) result.position.set(10, 0, 10);
      return result;
    },
    ...options,
  });
  new Scene().add(world);
  return world;
}

describe("WorldCells HLOD uses the existing cell admission lifecycle", () => {
  it("retains source detail for a custom instanced joined rung without attachment provenance", async () => {
    const data = manifest();
    const world = await load({
      data: {
        manifest: {
          ...data,
          cells: data.cells.map((cell) => ({
            ...cell,
            runs: [],
            chunks: ["chunk.glb"],
            proxy: {
              ...(cell.proxy as NonNullable<IWorldPackage["cells"][number]["proxy"]>),
              scope: "chunks" as const,
            },
          })),
        },
        placements: records.buffer,
      },
      loadModel: async (url) => {
        const root = url.endsWith("chunk.glb") ? await joinedModel(true) : model(1);
        root.position.set(10, 0, 10);
        return root;
      },
    });
    const render = renderer();
    try {
      await pump(world, render, 20);
      observe(world, render);
      updateModelLods(world, camera, 1080);
      await pump(world, render, 4);
      expect(world.stats().hlod.active).toBe(0);
      const joined: InstancedMesh[] = [];
      world.traverse((node) => {
        if (node instanceof InstancedMesh && isLodJoinProxy(node)) joined.push(node);
      });
      expect(joined).toHaveLength(1);
      expect(joined[0]?.visible && joined[0]?.layers.isEnabled(0)).toBe(true);
    } finally {
      world.dispose();
    }
  });
  it.each(["matrix", "count", "attribute"] as const)(
    "restores detail when an owned chunk instance changes its %s",
    async (change) => {
      const data = manifest();
      let authored: InstancedMesh | undefined;
      const world = await load({
        chunkMergeMaxTriangles: 1,
        data: {
          manifest: {
            ...data,
            cells: data.cells.map((cell) => ({
              ...cell,
              runs: [],
              chunks: ["chunk.glb"],
              proxy: {
                ...(cell.proxy as NonNullable<IWorldPackage["cells"][number]["proxy"]>),
                scope: "chunks" as const,
              },
            })),
          },
          placements: records.buffer,
        },
        loadModel: async (url) => {
          const result = new Group();
          result.position.set(10, 0, 10);
          if (url.endsWith("chunk.glb")) {
            authored = new InstancedMesh(geometry(2), new MeshBasicMaterial(), 2);
            authored.setMatrixAt(0, new Matrix4());
            authored.setMatrixAt(1, new Matrix4().makeTranslation(1, 0, 0));
            authored.instanceMatrix.needsUpdate = true;
            result.add(authored);
          } else result.add(new Mesh(geometry(1), new MeshBasicMaterial()));
          return result;
        },
      });
      const render = renderer();
      try {
        await pump(world, render, 20);
        expect(authored).toBeDefined();
        observe(world, render);
        await pump(world, render, 4);
        expect(world.stats().hlod.active).toBe(1);
        const source = authored as InstancedMesh;
        if (change === "count") source.count = 1;
        else if (change === "attribute")
          source.instanceMatrix = source.instanceMatrix.clone() as typeof source.instanceMatrix;
        else {
          source.setMatrixAt(0, new Matrix4().makeTranslation(5, 0, 0));
          source.instanceMatrix.needsUpdate = true;
        }
        await pump(world, render, 4);
        expect(world.stats().hlod.active).toBe(0);
        expect(source.layers.isEnabled(0) && source.visible).toBe(true);
        expect(world.stats().failures).toBe(0);
      } finally {
        world.dispose();
      }
    },
  );
  it.each([false, true])(
    "keeps AutoLOD joins and source shadows owned across repeated HLOD far/near handoffs with bundles:%s",
    async (bundles) => {
      const data = manifest();
      const world = await load({
        bundles,
        shadows: { cast: true, receive: true },
        data: {
          manifest: {
            ...data,
            cells: data.cells.map((cell) => ({
              ...cell,
              runs: [],
              chunks: ["chunk.glb"],
              proxy: {
                ...(cell.proxy as NonNullable<IWorldPackage["cells"][number]["proxy"]>),
                scope: "chunks" as const,
              },
            })),
          },
          placements: records.buffer,
        },
        loadModel: async (url) => {
          const result = url.endsWith("chunk.glb") ? await joinedModel() : model(1);
          result.position.set(10, 0, 10);
          return result;
        },
      });
      const render = renderer();
      Object.assign(render, { kind: "webgpu" });
      try {
        await pump(world, render, 20);
        expect(world.stats().hlod.loaded).toBe(1);
        world.traverse((node) => {
          if (!(node instanceof Mesh) || !node.castShadow || !node.layers.isEnabled(0)) return;
          for (let parent = node.parent; parent !== null; parent = parent.parent)
            expect(Reflect.get(parent, "isBundleGroup")).not.toBe(true);
        });
        observe(world, render);
        for (let cycle = 0; cycle < 3; cycle++) {
          far();
          for (let frame = 0; frame < 4; frame++) {
            updateModelLods(world, camera, 1080);
            world.update(render, camera);
            expect(world.stats().hlod.active).toBe(1);
            const joined: Mesh[] = [];
            world.traverse((node) => {
              if (node instanceof Mesh && isLodJoinProxy(node)) joined.push(node);
            });
            expect(joined.length).toBeGreaterThan(0);
            expect(
              joined.every(
                (mesh) =>
                  mesh.visible &&
                  !mesh.layers.isEnabled(0) &&
                  mesh.castShadow &&
                  mesh.layers.isEnabled(28),
              ),
            ).toBe(true);
          }
          camera.position.set(10, 1, 10);
          camera.updateMatrixWorld(true);
          // Exercise both existing call orders: WorldCells restores the main pass before AutoLOD,
          // or AutoLOD restores its members while HLOD still owns their main-pass layers.
          if (cycle % 2 === 0) updateModelLods(world, camera, 1080);
          world.update(render, camera);
          updateModelLods(world, camera, 1080);
          expect(world.stats().hlod.active).toBe(0);
          const sources: Mesh[] = [];
          world.traverse((node) => {
            if (node instanceof Mesh && node.castShadow && node.layers.isEnabled(0))
              sources.push(node);
          });
          expect(sources).toHaveLength(2);
          expect(sources.every((mesh) => mesh.visible && !mesh.layers.isEnabled(28))).toBe(true);
        }
      } finally {
        world.dispose();
      }
    },
  );
  it("admits chunk-only proxies with GPU scatter and retains casting sources through repeated far frames", async () => {
    const data = manifest();
    const expanded = {
      ...data,
      cells: data.cells.map((cell) => ({
        ...cell,
        chunks: ["chunk.glb"],
        proxy: {
          ...(cell.proxy as NonNullable<IWorldPackage["cells"][number]["proxy"]>),
          scope: "chunks" as const,
        },
      })),
    };
    const world = await load({
      gpuScene: true,
      shadows: { cast: true, receive: true },
      data: { manifest: expanded, placements: records.buffer },
    });
    const render = renderer();
    Object.assign(render, {
      kind: "webgpu",
      compute: () => undefined,
      readback: async (args: { array: Uint32Array }) => args.array.slice().buffer,
      raw: { backend: { hasFeature: () => true } },
    });
    try {
      await pump(world, render, 20);
      expect(world.stats().gpuScene.on).toBe(true);
      expect(world.stats().hlod.loaded).toBe(1);
      observe(world, render);
      await pump(world, render, 4);
      expect(world.stats().hlod.active).toBe(1);
      expect(mains(world).some((mesh) => mesh.visible)).toBe(true);
      const casters: Mesh[] = [];
      world.traverse((node) => {
        if (node instanceof Mesh && node.castShadow && node.layers.isEnabled(28))
          casters.push(node);
      });
      expect(casters.some((mesh) => mesh.visible)).toBe(true);
      camera.position.set(15, 1, 10);
      camera.updateMatrixWorld(true);
      world.update(render, camera);
      expect(world.stats().hlod.active).toBe(0);
    } finally {
      world.dispose();
    }
  });
  it("keeps detail until compilation and actual main-context observation, swaps atomically and restores near detail immediately", async () => {
    const render = renderer();
    const world = await load({ shadows: { cast: true, receive: true } });
    try {
      await pump(world, render);
      expect(world.stats().hlod).toMatchObject({ loaded: 1, compiled: 1, observed: 0, active: 0 });
      expect(mains(world).every((mesh) => mesh.visible)).toBe(true);
      const staged = proxy(world);
      expect(staged).toBeDefined();
      const mesh = staged?.children[0] as Mesh;
      expect(mesh.geometry.drawRange.count).toBe(0);
      observe(world, render);
      await pump(world, render, 1);
      expect(world.stats().hlod.active).toBe(1);
      expect(mesh.geometry.drawRange.count).toBe(Number.POSITIVE_INFINITY);
      expect(mains(world).every((mesh) => !mesh.visible)).toBe(true);
      const casters: Mesh[] = [];
      world.traverse((node) => {
        if (node instanceof Mesh && node.castShadow && !node.layers.isEnabled(0))
          casters.push(node);
      });
      expect(casters.length).toBeGreaterThan(0);
      expect(casters.some((mesh) => mesh.visible)).toBe(true);
      camera.position.set(15, 1, 10);
      camera.updateMatrixWorld(true);
      world.update(render, camera);
      expect(world.stats().hlod.active).toBe(0);
      expect(mesh.geometry.drawRange.count).toBe(0);
      expect(mains(world).every((mesh) => mesh.visible)).toBe(true);
    } finally {
      world.dispose();
    }
    expect(world.stats().hlod.bytes).toBe(0);
  });
  it("does not substitute a proxy when the backend skipped its zero-count submission", async () => {
    const world = await load();
    const render = renderer();
    try {
      await pump(world, render);
      const mesh = proxy(world)?.children[0] as Mesh;
      mesh.onBeforeRender(
        render.raw as never,
        world.parent as Scene,
        camera,
        mesh.geometry,
        mesh.material as never,
        null as never,
      );
      mesh.onAfterRender(
        render.raw as never,
        world.parent as Scene,
        camera,
        mesh.geometry,
        mesh.material as never,
        null as never,
      );
      await pump(world, render, 1);
      expect(world.stats().hlod).toMatchObject({ compiled: 1, observed: 0, active: 0 });
      expect(mains(world).every((source) => source.visible)).toBe(true);
    } finally {
      world.dispose();
    }
  });
  it("retains existing off-frustum culling instead of adding a proxy draw", async () => {
    const world = await load();
    const render = renderer();
    try {
      await pump(world, render);
      observe(world, render);
      camera.position.set(1000, 1, 600);
      camera.lookAt(1000, 1, 10);
      camera.updateMatrixWorld(true);
      world.update(render, camera);
      expect(world.stats().hlod.active).toBe(0);
      expect(mains(world).every((source) => !source.visible)).toBe(true);
      expect((proxy(world)?.children[0] as Mesh).geometry.drawRange.count).toBe(0);
    } finally {
      world.dispose();
    }
  });
  it("honors the error bound when an ancestor scales the entire world", async () => {
    const world = await load();
    const render = renderer();
    try {
      await pump(world, render);
      observe(world, render);
      world.parent?.scale.setScalar(10);
      world.parent?.updateMatrixWorld(true);
      camera.position.set(150, 5, 300);
      camera.lookAt(150, 5, 100);
      camera.updateMatrixWorld(true);
      world.update(render, camera);
      expect(world.stats().hlod.active).toBe(0);
      expect(mains(world).every((source) => source.visible)).toBe(true);
    } finally {
      world.dispose();
    }
  });
  it("retains detail while a valid ancestor transform is collapsed and resumes after growth", async () => {
    const world = await load();
    const render = renderer();
    try {
      await pump(world, render);
      observe(world, render);
      world.parent?.scale.setScalar(0);
      world.parent?.updateMatrixWorld(true);
      expect(() => world.update(render, camera)).not.toThrow();
      expect(world.stats().hlod.active).toBe(0);
      world.parent?.scale.setScalar(1);
      world.parent?.updateMatrixWorld(true);
      world.update(render, camera);
      expect(world.stats().hlod.active).toBe(1);
    } finally {
      world.dispose();
    }
  });
  it("reports proxy draws and replaced source meshes only after observation", async () => {
    let now = 0;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const world = await load({ admissionNow: () => now });
    const render = renderer();
    try {
      await pump(world, render);
      now = 5_001;
      world.update(render, camera);
      const before = info.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith("TN_WORLD_HLOD"));
      expect(before).toHaveLength(1);
      expect(before[0]).toContain("observed=0 active=0");
      expect(before[0]).toContain("draws=0 replaced=0");
      observe(world, render);
      await pump(world, render, 1);
      now = 10_002;
      world.update(render, camera);
      const after = info.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith("TN_WORLD_HLOD"));
      expect(after).toHaveLength(2);
      expect(after[1]).toContain("observed=1 active=1");
      expect(after[1]).toContain("draws=1 replaced=1");
    } finally {
      world.dispose();
      info.mockRestore();
    }
  });
  it("admits a measured small proxy below the worst-case reservation", async () => {
    const world = await load({ budgets: { bytes: 100_000, instances: 100, residentCells: 2 } });
    const render = renderer();
    try {
      await pump(world, render);
      observe(world, render);
      await pump(world, render, 1);
      expect(world.stats().hlod).toMatchObject({ loaded: 1, active: 1, bytes: 84, refused: 0 });
    } finally {
      world.dispose();
    }
  });
  it("rejects measured source plus copies before allocating private geometry", async () => {
    let settle!: (value: Group) => void;
    const pending = new Promise<Group>((resolve) => {
      settle = resolve;
    });
    const world = await load({
      budgets: { bytes: 100_000, instances: 100, residentCells: 2 },
      loadModel: async (url) => (url.endsWith("proxy.glb") ? pending : model(2)),
    });
    const render = renderer();
    const oversized = model(1);
    (oversized.children[0] as Mesh).geometry.setAttribute(
      "normal",
      new BufferAttribute(new Float32Array(15_000), 3),
    );
    try {
      await pump(world, render);
      expect(world.stats().hlod.pending).toBe(1);
      const copy = vi.spyOn(BufferGeometry.prototype, "copy");
      try {
        settle(oversized);
        await pump(world, render);
        expect(copy).not.toHaveBeenCalled();
        expect(world.stats().hlod).toMatchObject({ refused: 1, loaded: 0, bytes: 0 });
        // A count alone names no cause: the refusal must say which cell and why.
        expect(world.stats().hlod.reason).toMatch(/exceeds its reserved decoded budget/u);
        expect(mains(world).every((source) => source.visible)).toBe(true);
      } finally {
        copy.mockRestore();
      }
    } finally {
      settle(oversized);
      world.dispose();
    }
  });
  it("serializes concurrent proxy reservations within remaining resident headroom", async () => {
    const data = manifest();
    const firstCell = data.cells[0];
    if (firstCell === undefined) throw new Error("HLOD fixture cell missing");
    let settle!: (value: Group) => void;
    const pending = new Promise<Group>((resolve) => {
      settle = resolve;
    });
    const loader = vi.fn(async (url: string) => (url.endsWith("proxy.glb") ? pending : model(2)));
    const world = await load({
      ring: 1,
      budgets: { bytes: 100_000, instances: 100, residentCells: 2 },
      data: {
        manifest: {
          ...data,
          cells: [0, 1].map((x) => ({
            ...firstCell,
            x,
            runs: [],
            chunks: [`chunk${x}.glb`],
            proxy: {
              ...(firstCell.proxy as NonNullable<IWorldPackage["cells"][number]["proxy"]>),
              scope: "chunks" as const,
            },
          })),
        },
        placements: records.buffer,
      },
      loadModel: loader,
    });
    try {
      await pump(world, renderer());
      expect(loader.mock.calls.filter(([url]) => url.endsWith("proxy.glb"))).toHaveLength(1);
      expect(world.stats().hlod).toMatchObject({ pending: 1, bytes: 100_000, refused: 0 });
      const small = model(1);
      small.position.set(10, 0, 10);
      settle(small);
      await pump(world, renderer());
      expect(loader.mock.calls.filter(([url]) => url.endsWith("proxy.glb"))).toHaveLength(2);
      expect(world.stats().hlod).toMatchObject({ loaded: 2, bytes: 168, refused: 0 });
    } finally {
      world.dispose();
      settle(model(1));
      await Promise.resolve();
    }
  });
  it("defers proxy IO when placement records leave no resident headroom", async () => {
    const loader = vi.fn(async (url: string) => model(url.endsWith("proxy.glb") ? 1 : 2));
    const world = await load({
      budgets: { bytes: 64, instances: 100, residentCells: 2 },
      loadModel: loader,
    });
    const render = renderer();
    try {
      await pump(world, render);
      expect(loader.mock.calls.some(([url]) => url.endsWith("proxy.glb"))).toBe(false);
      expect(world.stats().hlod).toMatchObject({ refused: 0, active: 0, bytes: 0 });
      expect(mains(world).every((source) => source.visible)).toBe(true);
    } finally {
      world.dispose();
    }
  });
  it("invalidates both mixed source bundle groups on substitution and restoration", async () => {
    const data = manifest();
    const expanded = {
      ...data,
      cells: data.cells.map((cell) => ({ ...cell, chunks: ["chunk.glb"] })),
    };
    const world = await load({
      bundles: true,
      data: { manifest: expanded, placements: records.buffer },
    });
    const render = renderer();
    try {
      await pump(world, render, 20);
      observe(world, render);
      const before = world.stats().bundle.records;
      world.update(render, camera);
      expect(world.stats().hlod.active).toBe(1);
      expect(world.stats().bundle.records).toBeGreaterThanOrEqual(before + 2);
      const activated = world.stats().bundle.records;
      camera.position.set(15, 1, 10);
      camera.updateMatrixWorld(true);
      world.update(render, camera);
      expect(world.stats().hlod.active).toBe(0);
      expect(world.stats().bundle.records).toBeGreaterThanOrEqual(activated + 2);
    } finally {
      world.dispose();
    }
  });
  it.each([true, false])(
    "keeps an off-frustum chunk from gaining a proxy with bundles:%s",
    async (bundles) => {
      const data = manifest();
      const expanded = {
        ...data,
        cells: data.cells.map((cell) => ({
          ...cell,
          runs: [],
          chunks: ["chunk.glb"],
          proxy: {
            ...(cell.proxy as NonNullable<IWorldPackage["cells"][number]["proxy"]>),
            scope: "chunks" as const,
          },
        })),
      };
      const world = await load({
        bundles,
        data: { manifest: expanded, placements: records.buffer },
      });
      const render = renderer();
      try {
        await pump(world, render, 20);
        observe(world, render);
        camera.position.set(1000, 1, 600);
        camera.lookAt(1000, 1, 10);
        camera.updateMatrixWorld(true);
        world.update(render, camera);
        expect(world.stats().hlod.active).toBe(0);
        expect((proxy(world)?.children[0] as Mesh).geometry.drawRange.count).toBe(0);
      } finally {
        world.dispose();
      }
    },
  );
  it("returns source safely when attribute upload refuses after compilation", async () => {
    const world = await load();
    const render = renderer();
    render.uploadAttributes = () => {
      throw new Error("upload failed");
    };
    try {
      await pump(world, render);
      expect(world.stats().hlod).toMatchObject({ active: 0, bytes: 0, failures: 1 });
      expect(mains(world).every((mesh) => mesh.visible)).toBe(true);
    } finally {
      world.dispose();
    }
  });
  it("does not count compilation's render hooks as main traversal and retains detail on compile rejection", async () => {
    const world = await load();
    const render = renderer(async () => {
      observe(world, render);
      throw new Error("pipeline rejected");
    });
    try {
      await pump(world, render);
      expect(world.stats().hlod).toMatchObject({ active: 0, observed: 0, failures: 1 });
      expect(mains(world).every((mesh) => mesh.visible)).toBe(true);
    } finally {
      world.dispose();
    }
  });
  it("preserves source fallback for deferred loads and discards late generations", async () => {
    let resolve!: (value: Group) => void;
    const delayed = new Promise<Group>((done) => {
      resolve = done;
    });
    const world = await load({
      loadModel: async (url) => (url.endsWith("proxy.glb") ? delayed : model(2)),
    });
    const render = renderer();
    await pump(world, render);
    expect(world.stats().hlod.pending).toBe(1);
    expect(mains(world).every((mesh) => mesh.visible)).toBe(true);
    world.dispose();
    const late = model(1);
    const disposed = vi.spyOn((late.children[0] as Mesh).geometry, "dispose");
    resolve(late);
    for (let i = 0; i < 16; i++) await Promise.resolve();
    expect(proxy(world)).toBeUndefined();
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(world.stats().hlod).toMatchObject({ bytes: 0, pending: 0 });
  });
  it("keeps bytes and cache holders through an evicted compile until its original promise settles", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const world = await load();
    const render = renderer(() => pending);
    await pump(world, render);
    const mesh = proxy(world)?.children[0] as Mesh;
    const disposed = vi.spyOn(mesh.geometry, "dispose");
    expect(world.stats().hlod.bytes).toBeGreaterThan(0);
    world.dispose();
    expect(disposed).not.toHaveBeenCalled();
    expect(world.stats().hlod.bytes).toBeGreaterThan(0);
    resolve();
    for (let i = 0; i < 16; i++) await Promise.resolve();
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(world.stats().hlod.bytes).toBe(0);
  });
  it("keeps proxy geometry alive after warm-up times out until its compile settles", async () => {
    let resolveCompile!: () => void;
    const compilePending = new Promise<void>((resolve) => {
      resolveCompile = resolve;
    });
    const world = await load();
    const render = renderer(() => compilePending);
    await pump(world, render);
    const mesh = proxy(world)?.children[0] as Mesh;
    const disposed = vi.spyOn(mesh.geometry, "dispose");

    try {
      await vi.waitFor(() => expect(world.stats().hlod.failures).toBe(1), {
        timeout: 2500,
        interval: 10,
      });
      expect(disposed).not.toHaveBeenCalled();
      expect(world.stats().hlod.pending).toBe(1);
      expect(world.stats().hlod.bytes).toBeGreaterThan(0);

      resolveCompile();
      await vi.waitFor(() => expect(disposed).toHaveBeenCalledTimes(1));
      expect(world.stats().hlod.bytes).toBe(0);
    } finally {
      resolveCompile();
      world.dispose();
    }
  }, 5000);
  it("releases timed-out proxy geometry after its compile rejects", async () => {
    let rejectCompile!: (error: Error) => void;
    const compilePending = new Promise<void>((_resolve, reject) => {
      rejectCompile = reject;
    });
    const world = await load();
    const render = renderer(() => compilePending);
    await pump(world, render);
    const mesh = proxy(world)?.children[0] as Mesh;
    const disposed = vi.spyOn(mesh.geometry, "dispose");

    try {
      await vi.waitFor(() => expect(world.stats().hlod.failures).toBe(1), {
        timeout: 2500,
        interval: 10,
      });
      expect(disposed).not.toHaveBeenCalled();
      expect(world.stats().hlod.bytes).toBeGreaterThan(0);

      rejectCompile(new Error("late pipeline rejection"));
      await vi.waitFor(() => expect(disposed).toHaveBeenCalledTimes(1));
      expect(world.stats().hlod.failures).toBe(1);
      expect(world.stats().hlod.bytes).toBe(0);
    } finally {
      rejectCompile(new Error("test cleanup"));
      world.dispose();
    }
  }, 5000);
  it.each(["vertexNode", "transparent", "drawRange", "metadata"])(
    "retains detail for unsupported %s",
    async (reason) => {
      const world = await load({
        loadModel: async (url) => {
          const result = model(url.endsWith("proxy.glb") ? (reason === "metadata" ? 2 : 1) : 2);
          if (url.endsWith("proxy.glb")) result.position.set(10, 0, 10);
          const mesh = result.children[0] as Mesh;
          if (!url.endsWith("proxy.glb")) {
            if (reason === "vertexNode") Reflect.set(mesh.material, "vertexNode", {});
            if (reason === "transparent") (mesh.material as MeshBasicMaterial).transparent = true;
            if (reason === "drawRange") mesh.geometry.setDrawRange(0, 3);
          }
          return result;
        },
      });
      const render = renderer();
      try {
        await pump(world, render);
        observe(world, render);
        await pump(world, render, 1);
        expect(world.stats().hlod.active).toBe(0);
        expect(mains(world).every((mesh) => mesh.visible)).toBe(true);
      } finally {
        world.dispose();
      }
    },
  );
  it("declines shared batches retained by a neighboring cell and honors the off switch", async () => {
    const data = manifest();
    const expanded = {
      ...data,
      cells: [...data.cells, { x: 1, z: 0, runs: [{ asset: "stone", offset: 2, count: 1 }] }],
    };
    const placements = new Float32Array([...records, 40, 0, 10, 0, 0, 0, 1, 1]);
    const world = await load({
      ring: 1,
      data: { manifest: expanded, placements: placements.buffer },
    });
    const render = renderer();
    try {
      await pump(world, render);
      observe(world, render);
      await pump(world, render, 1);
      expect(world.stats().hlod.active).toBe(0);
      expect(mains(world).every((mesh) => mesh.visible)).toBe(true);
    } finally {
      world.dispose();
    }
    const disabled = await load({ hlod: false });
    try {
      await pump(disabled, render);
      expect(disabled.stats().hlod).toMatchObject({ on: false, loaded: 0, active: 0 });
      expect(proxy(disabled)).toBeUndefined();
    } finally {
      disabled.dispose();
    }
  });
});
