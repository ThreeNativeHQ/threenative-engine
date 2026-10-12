import {
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
} from "three";
import { describe, expect, it, vi } from "vitest";
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
  it("declines proxy IO when its existing world budget cannot retain source plus decoded copies", async () => {
    const loader = vi.fn(async (url: string) => model(url.endsWith("proxy.glb") ? 1 : 2));
    const world = await load({
      budgets: { bytes: 100_000, instances: 100, residentCells: 2 },
      loadModel: loader,
    });
    const render = renderer();
    try {
      await pump(world, render);
      expect(loader.mock.calls.some(([url]) => url.endsWith("proxy.glb"))).toBe(false);
      expect(world.stats().hlod).toMatchObject({ refused: 1, active: 0, bytes: 0 });
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
