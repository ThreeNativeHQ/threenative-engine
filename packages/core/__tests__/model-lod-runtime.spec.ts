import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
} from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DiscreteLodPlugin,
  TN_DISCRETE_LOD,
  baseGeometryOf,
  lodBias,
  setLodBias,
  updateModelLods,
} from "../src/model-lod.js";

// PRD-377 §6 — the runtime side: the loader's reader builds index-only levels that share the base
// attributes, and the engine's per-frame selection swaps the mesh's geometry by projected error.

const SCHEMA = 1;
const BASE_INDICES = [0, 1, 2, 1, 3, 2, 1, 4, 3, 4, 5, 3, 0, 2, 1, 3, 1, 2];
const LEVEL_INDICES = [
  [0, 1, 2, 1, 3, 2, 1, 4, 3, 4, 5, 3],
  [0, 1, 2, 1, 3, 2],
];

function baseGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1, 2, 0, 0, 2, 0, 1]);
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(Uint32Array.from(BASE_INDICES), 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function mesh(): Mesh {
  return new Mesh(baseGeometry(), undefined);
}

interface IParserShape {
  readonly associations: Map<object, { meshes?: number; primitives?: number }>;
  getDependency(type: string, index: number): Promise<{ array: ArrayLike<number> }>;
  readonly json: { meshes?: { primitives?: { extensions?: Record<string, unknown> }[] }[] };
}

function parserFor(
  target: Mesh,
  def: Record<string, unknown>,
  arrays: readonly (readonly number[])[] = LEVEL_INDICES,
): IParserShape {
  return {
    associations: new Map([[target, { meshes: 0, primitives: 0 }]]),
    getDependency: async (_type, index) => ({ array: Uint32Array.from(arrays[index] ?? []) }),
    json: { meshes: [{ primitives: [{ extensions: { [TN_DISCRETE_LOD]: def } }] }] },
  };
}

function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    absoluteErrors: [0.05, 5],
    counts: [4, 2],
    errors: [0.05, 5],
    indices: [0, 1],
    lod0Triangles: 6,
    schemaVersion: SCHEMA,
    sharedVertexBuffers: true,
    strategy: "discrete",
    ...overrides,
  };
}

afterEach(() => {
  setLodBias(1);
  vi.restoreAllMocks();
});

describe("DiscreteLodPlugin", () => {
  it.each([
    { name: "unit scale", scale: [1, 1, 1], bakedScale: 1, triangles: 4 },
    {
      name: "uniform world scale",
      scale: [2.42232295, 2.42232295, 2.42232295],
      bakedScale: 1,
      triangles: 6,
    },
    { name: "maximum X world axis", scale: [2.42232295, 1, 1], bakedScale: 1, triangles: 6 },
    { name: "maximum Y world axis", scale: [1, 2.42232295, 1], bakedScale: 1, triangles: 6 },
    { name: "maximum Z world axis", scale: [1, 1, 2.42232295], bakedScale: 1, triangles: 6 },
    { name: "geometry-baked scale counted once", scale: [1, 1, 1], bakedScale: 1.4, triangles: 4 },
  ])("projects local error with $name", async ({ scale, bakedScale, triangles }) => {
    const target = mesh();
    const plugin = new DiscreteLodPlugin();
    plugin.setParser(parserFor(target, definition({ absoluteErrors: [0.0604127214, 5] })) as never);
    await plugin.afterRoot({ scene: target });
    plugin.attach(target, { hysteresis: 0.15, maxPixelError: 1 });
    if (bakedScale !== 1) {
      target.geometry = target.geometry
        .clone()
        .applyMatrix4(new Matrix4().makeScale(bakedScale, bakedScale, bakedScale));
    }
    const parent = new Group();
    parent.scale.fromArray(scale);
    parent.add(target);
    const scene = new Scene();
    scene.add(parent);
    scene.updateMatrixWorld(true);
    const sphere = target.geometry.boundingSphere?.clone();
    expect(sphere).toBeDefined();
    if (sphere == null) throw new Error("Missing test bounds");
    sphere.applyMatrix4(target.matrixWorld);
    // F = 1000, physical nearest depth = 40, bias = 2.5: 0.6041 px local, 1.4634 px scaled.
    const camera = new PerspectiveCamera(90, 1, 0.1, 1000);
    camera.position.z = sphere.center.z + sphere.radius + 40;
    camera.updateMatrixWorld(true);
    setLodBias(2.5);
    expect(updateModelLods(scene, camera, 2000)).toBe(triangles);
    expect(target.geometry.index?.count).toBe(triangles * 3);
  });

  it("builds index-only levels that share the base vertex attributes", async () => {
    const target = mesh();
    const plugin = new DiscreteLodPlugin();
    const parser = parserFor(target, definition());
    plugin.setParser(parser as never);
    await plugin.afterRoot({ scene: target });
    expect(plugin.attach(target, { hysteresis: 0.15, maxPixelError: 1 })).toBe(1);

    const scene = new Scene();
    scene.add(target);
    const coarsest = (target as Mesh & { geometry: BufferGeometry }).geometry;
    // Far away: the 0.05-unit error projects under the pixel budget with room for hysteresis.
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 0, 100);
    camera.updateMatrixWorld(true);
    const triangles = updateModelLods(scene, camera, 1080);
    expect(triangles).toBe(4);
    const selected = (target as Mesh & { geometry: BufferGeometry }).geometry;
    expect(selected).not.toBe(coarsest);
    expect(selected.getAttribute("position")).toBe(coarsest.getAttribute("position"));
    expect(selected.index?.count).toBe(12);
  });

  it("refines to LOD0 immediately when the object is close", async () => {
    const target = mesh();
    const base = target.geometry;
    const plugin = new DiscreteLodPlugin();
    plugin.setParser(parserFor(target, definition()) as never);
    await plugin.afterRoot({ scene: target });
    plugin.attach(target, { hysteresis: 0.15, maxPixelError: 1 });

    const scene = new Scene();
    scene.add(target);
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 0, 3);
    camera.updateMatrixWorld(true);
    updateModelLods(scene, camera, 1080);
    expect((target as Mesh & { geometry: BufferGeometry }).geometry).toBe(base);
    expect(baseGeometryOf(target)).toBe(base);
  });

  it("keeps full detail and reports when the payload schema is unknown", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const target = mesh();
    const base = target.geometry;
    const plugin = new DiscreteLodPlugin();
    plugin.setParser(parserFor(target, definition({ schemaVersion: 99 })) as never);
    await plugin.afterRoot({ scene: target });
    expect(plugin.attach(target, undefined)).toBe(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("TN_DISCRETE_LOD_INVALID"));
    expect(target.geometry).toBe(base);
  });

  it("keeps full detail when LOD0 no longer matches the baked chain", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const target = mesh();
    const base = target.geometry;
    const plugin = new DiscreteLodPlugin();
    plugin.setParser(parserFor(target, definition({ lod0Triangles: 999 })) as never);
    await plugin.afterRoot({ scene: target });
    expect(plugin.attach(target, undefined)).toBe(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("LOD0 triangles"));
    expect(target.geometry).toBe(base);
  });

  it("refuses a non-reducing level instead of installing a chain", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const target = mesh();
    const plugin = new DiscreteLodPlugin();
    // level 1 carries the same 6 triangles as LOD0, so the pair is not a reduction.
    plugin.setParser(
      parserFor(target, definition({ counts: [6, 2], errors: [0.05, 5], lod0Triangles: 6 }), [
        BASE_INDICES,
        LEVEL_INDICES[1] as number[],
      ]) as never,
    );
    await plugin.afterRoot({ scene: target });
    expect(plugin.attach(target, undefined)).toBe(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("TN_DISCRETE_LOD_INVALID"));
  });

  it("leaves node identity, transform, material and shadow flags intact", async () => {
    const target = mesh();
    const material = new MeshBasicMaterial();
    target.material = material;
    target.name = "hull";
    target.position.set(3, 1, -2);
    target.castShadow = true;
    target.receiveShadow = true;
    const plugin = new DiscreteLodPlugin();
    plugin.setParser(parserFor(target, definition()) as never);
    await plugin.afterRoot({ scene: target });
    plugin.attach(target, { hysteresis: 0.15, maxPixelError: 1 });

    const scene = new Scene();
    scene.add(target);
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 0, 100);
    camera.updateMatrixWorld(true);
    updateModelLods(scene, camera, 1080);

    expect(target.name).toBe("hull");
    expect(target.material).toBe(material);
    expect(target.position.toArray()).toEqual([3, 1, -2]);
    expect(target.castShadow).toBe(true);
    expect(target.receiveShadow).toBe(true);
  });

  it("isolates two instances that share one base geometry", async () => {
    const base = baseGeometry();
    const left = new Mesh(base, undefined);
    const right = new Mesh(base, undefined);
    for (const instance of [left, right]) {
      const plugin = new DiscreteLodPlugin();
      plugin.setParser(parserFor(instance, definition()) as never);
      await plugin.afterRoot({ scene: instance });
      plugin.attach(instance, { hysteresis: 0.15, maxPixelError: 1 });
    }

    const scene = new Scene();
    scene.add(left);
    scene.add(right);
    const far = new PerspectiveCamera(60, 1, 0.1, 1000);
    far.position.set(0, 0, 100);
    far.updateMatrixWorld(true);
    updateModelLods(scene, far, 1080);

    // Each instance built its own derived level; neither swap touched the other.
    expect(left.geometry).not.toBe(base);
    expect(right.geometry).not.toBe(base);
    expect(left.geometry).not.toBe(right.geometry);
    expect(left.geometry.getAttribute("position")).toBe(base.getAttribute("position"));
    expect(right.geometry.getAttribute("position")).toBe(base.getAttribute("position"));
    expect(base.index?.count).toBe(BASE_INDICES.length);

    // Releasing one instance must not destroy the sibling's shared attributes.
    const position = base.getAttribute("position") as BufferAttribute;
    left.geometry.dispose();
    expect(right.geometry.getAttribute("position")).toBe(position);
    expect(position.array.byteLength).toBeGreaterThan(0);
    expect(base.index?.count).toBe(BASE_INDICES.length);
    expect(baseGeometryOf(right)).toBe(base);
  });
});

describe("adaptive LOD bias on the CPU path", () => {
  it("shares adaptive LOD bias across duplicated entry modules", async () => {
    const previous = lodBias();
    vi.resetModules();
    const main = await import("../src/model-lod.js");
    vi.resetModules();
    const world = await import("../src/model-lod.js");
    try {
      expect(main.setLodBias).not.toBe(world.setLodBias);
      main.setLodBias(1);
      expect(world.biasedLodDistance(46)).toBe(46);
      world.setLodBias(2.5);
      expect(main.lodBias()).toBe(2.5);
      expect(main.biasedLodDistance(46)).toBe(115);
      main.setLodBias(1.4);
      expect(world.lodBias()).toBe(1.4);
      expect(world.biasedLodDistance(46)).toBeCloseTo(64.4);
      for (const invalid of [0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        world.setLodBias(2.5);
        main.setLodBias(invalid);
        expect(world.lodBias()).toBe(1);
        expect(world.biasedLodDistance(46)).toBe(46);
      }
    } finally {
      main.setLodBias(previous);
      world.setLodBias(previous);
      vi.resetModules();
    }
  });

  it("coarsens a fixed-distance selection and never refines it below what was authored", async () => {
    const target = mesh();
    const plugin = new DiscreteLodPlugin();
    plugin.setParser(parserFor(target, definition()) as never);
    await plugin.afterRoot({ scene: target });
    plugin.attach(target, { hysteresis: 0.15, maxPixelError: 1 });
    const scene = new Scene();
    scene.add(target);

    // 46 m out: the chain's first derived level (error 0.05) projects just over the one-pixel
    // budget, so the authored level is LOD0 and the coarsening hysteresis has nothing to accept.
    const camera = new PerspectiveCamera(60, 1, 0.1, 100_000);
    camera.position.set(0, 0, 46);
    camera.updateMatrixWorld(true);
    setLodBias(1);
    updateModelLods(scene, camera, 1080);
    expect((target as Mesh & { geometry: BufferGeometry }).geometry).toBe(baseGeometryOf(target));

    // The same distance under a bias is ~64 m of effective distance, inside the derived level's
    // budget and inside the hysteresis band, so the switch moves earlier and it takes over.
    setLodBias(1.4);
    updateModelLods(scene, camera, 1080);
    const coarse = (target as Mesh & { geometry: BufferGeometry }).geometry;
    expect(coarse).not.toBe(baseGeometryOf(target));
    expect(coarse.index?.count).toBe(12);

    // A camera already at the coarsest level is never refined by a bias.
    const far = new PerspectiveCamera(60, 1, 0.1, 100_000);
    far.position.set(0, 0, 100_000);
    far.updateMatrixWorld(true);
    updateModelLods(scene, far, 1080);
    const coarsest = (target as Mesh & { geometry: BufferGeometry }).geometry;
    expect(coarsest.index?.count).toBe(6);
    expect(coarsest).not.toBe(baseGeometryOf(target));
  });
});
