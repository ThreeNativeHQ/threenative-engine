import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BufferAttribute, BufferGeometry, Group, Matrix4, Mesh, MeshBasicMaterial } from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import {
  type IBrowserRuntime,
  type IRegistryDump,
  defineBrowserClasses,
} from "../../three-native/src/browser-backend.js";
import { type ITslRuntime, defineTsl } from "../../three-native/src/browser-tsl.js";
import { loadCatalog } from "../../three-native/src/catalog.js";
import { defineTypeFlags } from "../../three-native/src/object-surface.js";
import type { IRendererLike } from "../src/renderer.js";
import {
  SoftBody3D,
  buildClothTopology,
  compactClothVec3Readback,
  simulateClothReference,
} from "../src/softbody.js";

function exportedFlagGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(
      new Float32Array([
        0, 1.4, 0, 1.1, 1.2, 0.1, 0.9, 0.1, -0.05, 0, 1.4, 0, 0.9, 0.1, -0.05, -0.1, 0, 0.08,
      ]),
      3,
    ),
  );
  geometry.setIndex([0, 1, 2, 3, 4, 5]);
  return geometry;
}

const microtasks = async (count = 8): Promise<void> => {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
};

function flagOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    damping: 1.8,
    gravity: [0, -9.81, 0],
    pinned: [0, 3],
    stiffness: 35,
    wind: [1.5, 0, 0.4],
    ...overrides,
  };
}

function buildCloth(overrides: Record<string, unknown> = {}): SoftBody3D {
  const mesh = new Mesh(exportedFlagGeometry(), new MeshBasicNodeMaterial());
  return new SoftBody3D(mesh, flagOptions(overrides) as never);
}

function renderer(dispatched: unknown[]): IRendererLike {
  return {
    compileAsync: async () => undefined,
    compute: (node) => dispatched.push(node),
    dispose: () => undefined,
    domElement: new EventTarget() as HTMLCanvasElement,
    gpuFrameMs: () => undefined,
    info: {},
    kind: "webgpu",
    raw: {},
    readback: async () => new ArrayBuffer(64),
    render: () => undefined,
    renderOverlay: () => undefined,
    resolveGpuFrame: () => undefined,
    setOutputNode: () => undefined,
    setResolutionScale: () => undefined,
    setSize: () => undefined,
    surface: () => ({
      atFloor: false,
      drawingBufferHeight: 1,
      drawingBufferWidth: 1,
      resolutionScale: 1,
      sampleCount: 1,
      scaleSource: "pinned",
    }),
  };
}

describe("SoftBody3D cloth", () => {
  it("lets SoftBody3D clone a browser node material and install its cloth position node", async () => {
    const catalog = loadCatalog(fileURLToPath(new URL("../../../", import.meta.url)));
    const registry = JSON.parse(
      readFileSync(new URL("../../three-native/api/native-registry.json", import.meta.url), "utf8"),
    ) as IRegistryDump;
    const types = new Map<string, number>();
    let serial = 0;
    const runtime: IBrowserRuntime = {
      typeId(name) {
        if (!types.has(name)) types.set(name, types.size + 1);
        return types.get(name) as number;
      },
      construct: (name) => ({ key: `${name}:0:${++serial}:1`, type: types.get(name) ?? 0 }),
      invoke: () => null,
      get: () => 0,
      set() {},
      release() {},
      setCallback() {},
    };
    const arrays = new Map<string, Float32Array>();
    const sizes = new Map<string, number>();
    const construct = runtime.construct;
    runtime.construct = (name, args) => {
      const ref = construct(name, args);
      if (Array.isArray(args[0])) {
        arrays.set(ref.key, new Float32Array(args[0] as number[]));
        sizes.set(ref.key, Number(args[1]));
      }
      return ref;
    };
    runtime.invoke = (self, method) =>
      method === "clone" ? runtime.construct(self.key.split(":")[0] as string, []) : null;
    const get = runtime.get;
    runtime.get = (ref, property) => {
      if (property === "count")
        return (arrays.get(ref.key)?.length ?? 0) / (sizes.get(ref.key) ?? 1);
      if (property === "itemSize") return sizes.get(ref.key) ?? 1;
      return get(ref, property);
    };
    runtime.attributeArray = (ref) => arrays.get(ref.key) as never;
    runtime.attributeWrite = (ref, array) => void arrays.set(ref.key, array as Float32Array);
    let node = 0;
    const set = vi.fn();
    const tslRuntime: ITslRuntime = {
      call: () => ++node,
      release() {},
      set,
      setUniform() {},
      setPost() {},
      effectParameter: () => 0,
      compute() {},
      readStorage: async () => new ArrayBuffer(0),
      deleteStorage() {},
    };
    const { classes } = defineBrowserClasses(registry, { ...runtime, tsl: tslRuntime }, catalog);
    defineTypeFlags(classes);
    const tsl = defineTsl(tslRuntime, classes as never).exports;
    vi.doMock("three/tsl", () => tsl);
    vi.resetModules();
    try {
      const { SoftBody3D } = await import("../../core/src/softbody.js");
      const geometry = new BufferGeometry().setAttribute(
        "position",
        new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
      );
      const material = new (classes.MeshBasicNodeMaterial as new () => object)();
      const cloth = new SoftBody3D(new Mesh(geometry, material as never), {
        pinned: [0],
        stiffness: 35,
        damping: 1.8,
        gravity: [0, -9.81, 0],
        wind: [1, 0, 0],
      });
      expect(cloth.material).not.toBe(material);
      expect(cloth.uniqueVertexCount).toBe(3);
      expect(set).toHaveBeenCalledWith(expect.any(Object), "positionNode", expect.any(Number));
      const plain = new (classes.MeshBasicMaterial as new () => object)();
      expect(
        () =>
          new SoftBody3D(new Mesh(geometry, plain as never), {
            pinned: [0],
            stiffness: 35,
            damping: 1.8,
            gravity: [0, -9.81, 0],
            wind: [1, 0, 0],
          }),
      ).toThrow(/node material/u);
    } finally {
      vi.doUnmock("three/tsl");
      vi.resetModules();
    }
  });

  it("compacts WGSL-padded vec3 readback and rejects every other shape", () => {
    expect(compactClothVec3Readback(new Float32Array([1, 2, 3, 99, 4, 5, 6, 99]), 2)).toEqual(
      new Float32Array([1, 2, 3, 4, 5, 6]),
    );
    const packed = new Float32Array([1, 2, 3, 4, 5, 6]);
    const copy = compactClothVec3Readback(packed, 2);
    expect(copy).toEqual(packed);
    expect(copy).not.toBe(packed);
    expect(() => compactClothVec3Readback(new Float32Array(7), 2)).toThrow(
      "expected 6 packed or 8 padded floats",
    );
  });

  it.each([
    ["stiffness NaN", { stiffness: Number.NaN }, /stiffness must be finite/u],
    ["stiffness zero", { stiffness: 0 }, /stiffness must be greater than zero/u],
    ["damping negative", { damping: -1 }, /damping must be non-negative/u],
    ["damping NaN", { damping: Number.NaN }, /damping must be finite/u],
    ["gravity length", { gravity: [0, -9.81] }, /gravity must contain three numbers/u],
    ["gravity non-finite", { gravity: [0, Number.NaN, 0] }, /gravity\.y must be finite/u],
    ["wind length", { wind: [1.5, 0] }, /wind must contain three numbers/u],
    ["wind non-finite", { wind: [1.5, 0, Number.POSITIVE_INFINITY] }, /wind\.z must be finite/u],
    [
      "collision capacity zero",
      { collision: { capacity: 0, writeBoxes: () => 0 } },
      /collision capacity must be a positive integer/u,
    ],
    [
      "fractional collision capacity",
      { collision: { capacity: 1.5, writeBoxes: () => 0 } },
      /collision capacity must be a positive integer/u,
    ],
    [
      "readbackEveryFrames negative",
      { readbackEveryFrames: -1 },
      /readbackEveryFrames must be a non-negative integer/u,
    ],
    [
      "fractional readbackEveryFrames",
      { readbackEveryFrames: 1.5 },
      /readbackEveryFrames must be a non-negative integer/u,
    ],
  ])("fails closed for an invalid %s", (_label, overrides, pattern) => {
    expect(() => buildCloth(overrides)).toThrow(pattern);
  });

  it("rejects a mesh that does not use one game-owned node material", () => {
    const plain = new Mesh(exportedFlagGeometry(), new MeshBasicMaterial());
    expect(() => new SoftBody3D(plain, flagOptions() as never)).toThrow(/node material/u);
    const arrayed = new Mesh(exportedFlagGeometry(), [new MeshBasicNodeMaterial()]);
    expect(() => new SoftBody3D(arrayed, flagOptions() as never)).toThrow(/node material/u);
  });

  it("reports an undefined sample and debug counters before any readback lands", async () => {
    const cloth = buildCloth({ readbackEveryFrames: 1 });
    expect(cloth.sample).toBeUndefined();
    expect(cloth.debug()).toEqual({
      released: false,
      softBodySteps: 0,
      springCount: cloth.springCount,
      uniqueVertexCount: cloth.uniqueVertexCount,
      readbackPending: false,
      readbackStats: { requests: 0, lands: 0, failures: 0 },
      sampleStaleFrames: 0,
    });

    cloth.process(renderer([]));
    expect(cloth.debug().softBodySteps).toBe(1);
    await microtasks();
    expect(cloth.sample?.data).toHaveLength(cloth.uniqueVertexCount * 3);
    expect(cloth.sample?.staleFrames).toBeGreaterThanOrEqual(0);
    cloth.detach();
    expect(cloth.released).toBe(true);
    cloth.process();
    expect(cloth.steps).toBe(1);
  });

  it("guards attach and process edges and releases only its owned clone", () => {
    const cloth = buildCloth();
    expect(() => cloth.process()).toThrow("SoftBody3D is not attached to a renderer.");
    expect(() => cloth.attachRenderer({ ...renderer([]), kind: "webgl" } as never)).toThrow(
      "SoftBody3D requires the WebGPU renderer.",
    );

    const gpu = renderer([]);
    cloth.attachRenderer(gpu);
    cloth.process(gpu);
    const ownedDispose = vi.spyOn(cloth.material, "dispose");
    cloth.detach();
    cloth.detach();
    expect(cloth.released).toBe(true);
    expect(ownedDispose).toHaveBeenCalledOnce();
    expect(() => cloth.attachRenderer(gpu)).toThrow("SoftBody3D cannot be attached after release.");
  });

  it("detaches when the cloth is removed from its scene parent", () => {
    const cloth = buildCloth();
    const parent = new Group();
    parent.add(cloth);
    parent.remove(cloth);
    expect(cloth.released).toBe(true);
  });

  it("packs collision boxes and fails closed on an out-of-range count", () => {
    const seen: Matrix4[] = [];
    const collision = {
      capacity: 1,
      writeBoxes(target: Float32Array, worldToLocal: Matrix4): number {
        seen.push(worldToLocal);
        target.set([0, 0, 0, 0, 1, 1, 1, 0]);
        return 1;
      },
    };
    const cloth = buildCloth({ collision });
    const dispatched: unknown[] = [];
    cloth.attachRenderer(renderer(dispatched));
    cloth.process();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(Matrix4);
    expect(cloth.steps).toBe(1);

    const overfull = buildCloth({ collision: { capacity: 1, writeBoxes: () => 2 } });
    overfull.attachRenderer(renderer([]));
    expect(() => overfull.process()).toThrow(/expected 0\.\.1/u);
  });

  it("welds duplicated exporter vertices before building unique springs", () => {
    const topology = buildClothTopology(exportedFlagGeometry(), { pinned: [0, 3] });

    expect(topology.positions).toHaveLength(12);
    expect(topology.originalToUnique).toEqual(new Uint32Array([0, 1, 2, 0, 2, 3]));
    expect(topology.springs).toHaveLength(10);
    expect(topology.pinned).toEqual(new Uint32Array([1, 0, 0, 0]));
  });

  it("throws on an index buffer that is not complete triangles", () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 3),
    );
    geometry.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2, 3]), 1));
    expect(() => buildClothTopology(geometry, { pinned: [0] })).toThrow(
      /must contain complete triangles/,
    );

    const nonIndexed = new BufferGeometry();
    nonIndexed.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 3),
    );
    expect(() => buildClothTopology(nonIndexed, { pinned: [0] })).toThrow(
      /must contain complete triangles/,
    );
  });

  it("keeps pinned vertices exact and settles identically across render rates", () => {
    const topology = buildClothTopology(exportedFlagGeometry(), { pinned: [0, 3] });
    const common = {
      damping: 1.8,
      duration: 2,
      gravity: [0, -9.81, 0] as const,
      stiffness: 35,
      topology,
      wind: [1.5, 0, 0.4] as const,
    };
    const at30 = simulateClothReference({ ...common, frameStep: 1 / 30 });
    const at120 = simulateClothReference({ ...common, frameStep: 1 / 120 });

    expect([...at30.slice(0, 3)]).toEqual([...topology.positions.slice(0, 3)]);
    expect([...at120.slice(0, 3)]).toEqual([...topology.positions.slice(0, 3)]);
    expect(
      Math.max(
        ...at30.map((value, index) => {
          const comparison = at120[index];
          if (comparison === undefined) throw new Error(`missing comparison at index ${index}`);
          return Math.abs(value - comparison);
        }),
      ),
    ).toBeLessThan(1e-6);
  });

  it("dispatches its fixed-step solver and releases only mechanism-owned resources", () => {
    const material = new MeshBasicNodeMaterial();
    const mesh = new Mesh(exportedFlagGeometry(), material);
    const cloth = new SoftBody3D(mesh, {
      damping: 1.8,
      gravity: [0, -9.81, 0],
      pinned: [0, 3],
      stiffness: 35,
      wind: [1.5, 0, 0.4],
    });
    const dispatched: unknown[] = [];
    const gpu = renderer(dispatched);
    const geometryDispose = vi.spyOn(mesh.geometry, "dispose");
    const materialDispose = vi.spyOn(material, "dispose");

    cloth.attachRenderer(gpu);
    cloth.process();
    expect(dispatched).toEqual([...cloth.warmupNodes]);
    expect(cloth.steps).toBe(1);
    cloth.detach();

    expect(cloth.released).toBe(true);
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(materialDispose).not.toHaveBeenCalled();
  });
});
