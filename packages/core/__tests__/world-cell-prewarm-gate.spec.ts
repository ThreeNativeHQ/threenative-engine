import {
  Box3,
  BoxGeometry,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  Sphere,
  Vector3,
} from "three";
import { describe, expect, it } from "vitest";
import type { IRendererLike } from "../src/renderer.js";
import type { SharedBatch } from "../src/world-cell-batches.js";
import type { IAssetState } from "../src/world-cell-models.js";
import { CellPrewarm, type ICellPrewarmHost } from "../src/world-cell-prewarm.js";

function host(
  built: (key: string) => boolean,
  workPending = (): boolean => false,
): ICellPrewarmHost {
  const parent = new Object3D();
  return {
    released: () => false,
    preserveAuthoredParts: () => false,
    parent: () => parent,
    workPending,
    invalidateShadows: () => undefined,
    backlog: () => 0,
    keysForShadow: () => false,
    hasShared: built,
    hasRetired: () => false,
    runMax: () => 1,
    residentCells: () => 1,
    extentBounds: () => new Box3(),
    smallCaster: () => false,
    dressMesh: () => undefined,
    receiveShadow: () => false,
    adoptGpu: () => undefined,
    setShared: () => undefined,
    attach: () => undefined,
    casts: () => false,
    wideOwed: () => false,
    followCluster: () => "0_0",
    wideShape: (_asset, _level, _part, fallback) => fallback,
    lodSurface: (_asset, _level, _part, source) => source,
  };
}

const asset = {
  id: "boulder",
  levels: [[{ geometry: new BoxGeometry(), material: new MeshBasicMaterial() }]],
} as unknown as IAssetState;

describe("CellPrewarm gate", () => {
  it("settles when every key an asset asks for is already built", async () => {
    const prewarm = new CellPrewarm(host(() => true));
    prewarm.queuePrewarm(asset);
    for (let update = 0; update < 4; update += 1) prewarm.drainPrewarm();
    expect(prewarm.queued).toBe(0);
    expect(prewarm.settled).toBe(true);
    await expect(prewarm.prewarmed).resolves.toBeUndefined();
  });

  it("stays open while the world can still ask, so an early idle update cannot settle it", () => {
    const prewarm = new CellPrewarm(
      host(
        () => true,
        () => true,
      ),
    );
    for (let update = 0; update < 4; update += 1) prewarm.drainPrewarm();
    expect(prewarm.settled).toBe(false);
  });

  it("settles an unasked gate for a world with nothing left to prewarm", async () => {
    const prewarm = new CellPrewarm(host(() => false));
    for (let update = 0; update < 4; update += 1) prewarm.drainPrewarm();
    expect(prewarm.settled).toBe(true);
    await expect(prewarm.prewarmed).resolves.toBeUndefined();
  });
});

it("requires a real nonempty main draw after idle prewarm abandonment, without waiting on offscreen work", () => {
  const root = new Object3D();
  const h = host(() => false);
  let shared: SharedBatch | undefined;
  h.setShared = (_key, batch) => {
    shared = batch;
  };
  h.attach = (batch) => {
    root.add(batch.mesh);
  };
  const prewarm = new CellPrewarm(h);
  prewarm.queuePrewarm(asset);
  for (let frame = 0; frame < 12; frame++) prewarm.drainPrewarm();
  expect(prewarm.settled).toBe(true);
  if (!shared) throw new Error("Prewarm batch was not minted.");
  const mesh = shared.mesh;
  mesh.count = 1;
  mesh.visible = true;
  mesh.boundingSphere = new Sphere(new Vector3(), 1);
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.z = 10;
  camera.lookAt(0, 0, 0);
  const renderer = { compiling: false, info: { render: { drawCalls: 0 } } };
  const pending = () =>
    prewarm.pendingCpuDrawsInView(root, camera, renderer as unknown as IRendererLike);
  expect(pending()).toBe(1);
  const submit = (draw: boolean) => {
    Reflect.apply(mesh.onBeforeRender, mesh, [renderer, root, camera]);
    if (draw) renderer.info.render.drawCalls++;
    Reflect.apply(mesh.onAfterRender, mesh, [renderer, root, camera]);
  };
  renderer.compiling = true;
  submit(true);
  expect(pending()).toBe(1);
  renderer.compiling = false;
  submit(false);
  expect(pending()).toBe(1);
  mesh.position.x = 1000;
  expect(pending()).toBe(0);
  mesh.position.x = 0;
  expect(pending()).toBe(1);
  mesh.count = 0;
  submit(true);
  mesh.count = 1;
  expect(pending()).toBe(1);
  submit(true);
  expect(pending()).toBe(0);
  prewarm.releaseHooks();
  expect(Object.hasOwn(mesh, "onBeforeRender")).toBe(false);
  expect(Object.hasOwn(mesh, "onAfterRender")).toBe(false);
});

// PRD-762: the owned engine binds onBeforeRender alone, after its cull and only for a main-pass draw it
// submits, and fills `info.render` once render() returns. The forest kit waited on that draw forever.
it("counts a main draw on an engine that calls onBeforeRender alone", () => {
  const root = new Object3D();
  const h = host(() => false);
  let shared: SharedBatch | undefined;
  h.setShared = (_key, batch) => {
    shared = batch;
  };
  h.attach = (batch) => {
    root.add(batch.mesh);
  };
  const prewarm = new CellPrewarm(h);
  prewarm.queuePrewarm(asset);
  for (let frame = 0; frame < 12; frame++) prewarm.drainPrewarm();
  if (!shared) throw new Error("Prewarm batch was not minted.");
  const mesh = shared.mesh;
  mesh.count = 1;
  mesh.visible = true;
  mesh.boundingSphere = new Sphere(new Vector3(), 1);
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.z = 10;
  camera.lookAt(0, 0, 0);
  // `calls` is the running total; `drawCalls` is this frame's, and core resets it before the next query.
  const renderer = { compiling: false, info: { render: { calls: 0, drawCalls: 0 } } };
  const pending = () =>
    prewarm.pendingCpuDrawsInView(root, camera, renderer as unknown as IRendererLike);
  expect(pending()).toBe(1);
  // A compile render calls the hook too, and draws nothing.
  renderer.compiling = true;
  Reflect.apply(mesh.onBeforeRender, mesh, [renderer, root, camera]);
  renderer.compiling = false;
  expect(pending()).toBe(1);
  Reflect.apply(mesh.onBeforeRender, mesh, [renderer, root, camera]);
  renderer.info.render.calls += 1;
  renderer.info.render.drawCalls = 0;
  expect(pending()).toBe(0);
});

// PRD-879: a key prewarmed with the raw part material built a program no placement draws; the swap
// draws `lodSurface`'s LOD-masked material, whose program the walk then built after the reveal.
it("mints each key with the material the swap draws, not the raw part material", () => {
  const h = host(() => false);
  const masked = new MeshBasicMaterial();
  const asked: Array<[string, number, number]> = [];
  h.lodSurface = (id, level, part) => {
    asked.push([id, level, part]);
    return masked;
  };
  let shared: SharedBatch | undefined;
  h.setShared = (_key, batch) => {
    shared = batch;
  };
  const prewarm = new CellPrewarm(h);
  prewarm.queuePrewarm(asset);
  prewarm.drainPrewarm();
  expect(asked).toEqual([["boulder", 0, 0]]);
  expect(shared?.mesh.material).toBe(masked);
});

it("keeps distinct cached LOD surfaces when main and wide roles share a level with different source materials", async () => {
  const { vi } = await import("vitest");
  const { CellGpuDress } = await import("../src/world-cell-render-gpu-dress.js");
  const { WorldGpuScene } = await import("../src/world-gpu-scene.js");
  const { uniform } = await import("three/tsl");
  const lodMaterials = new Map<
    string,
    { readonly source: MeshBasicMaterial; readonly material: MeshBasicMaterial }
  >();
  const source0 = new MeshBasicMaterial();
  const source2 = new MeshBasicMaterial();
  const disposer0 = vi.spyOn(source0, "dispose");
  const disposer2 = vi.spyOn(source2, "dispose");
  const testAsset = {
    id: "pine",
    distances: [0, 26, 64],
    levels: [
      [{ geometry: new BoxGeometry(), material: source0, local: new Object3D().matrix }],
      [
        {
          geometry: new BoxGeometry(),
          material: new MeshBasicMaterial(),
          local: new Object3D().matrix,
        },
      ],
      [{ geometry: new BoxGeometry(), material: source2, local: new Object3D().matrix }],
    ],
  } as unknown as IAssetState;
  const gpuScene = new WorldGpuScene();
  const dress = new CellGpuDress({
    add: () => undefined,
    asset: () => testAsset,
    camera: () => undefined,
    canonical: (id) => id,
    carryPrewarm: () => undefined,
    isBundleHome: () => false,
    renderer: () => undefined,
    root: () => new Object3D().matrixWorld,
    shared: () => new Map(),
    retired: () => new Map(),
    resident: () => new Map(),
    gpuScene: () => gpuScene,
    lodMaterials: () => lodMaterials,
    lodDistanceBias: () => uniform(1) as never,
    lodHysteresis: () => 0.15,
    lodTransition: () => "temporal",
    lodSpatial: () => false,
    receiveShadow: () => true,
    preserveAuthoredParts: () => false,
    freshCount: () => 0,
    extentBounds: () => new Box3(),
    visibleSquares: () => new Set(),
    freshAllowance: () => 4,
    attach: () => undefined,
    bumpBundle: () => undefined,
    bundleIn: () => undefined,
    bundleOut: () => undefined,
    shardOf: () => ({}) as never,
    shadowFloorOf: () => 0,
    shadowKeyFor: () => undefined,
  });
  const mainEntry = {
    asset: "pine",
    level: 0,
    part: 0,
    batch: { geometry: new BoxGeometry(), material: source0 },
  } as unknown as import("../src/world-cell-data.js").ICellBatch;
  const mainA = dress.shapeFor(mainEntry, "main", 0).material;
  const wideA = dress.shapeFor(mainEntry, "wide", 0).material;
  const mainB = dress.shapeFor(mainEntry, "main", 0).material;
  const wideB = dress.shapeFor(mainEntry, "wide", 0).material;
  expect(mainA).not.toBe(wideA);
  expect(mainB).toBe(mainA);
  expect(wideB).toBe(wideA);
  expect(lodMaterials.size).toBe(2);
  expect(disposer0).not.toHaveBeenCalled();
  expect(disposer2).not.toHaveBeenCalled();
  // Reloading the asset's own source material still disposes and replaces its cached LOD surface.
  const reloadedSource = new MeshBasicMaterial();
  const oldLodSpy = vi.spyOn(mainA, "dispose");
  const reloaded = dress.lodSurface("pine", 0, 0, reloadedSource);
  expect(reloaded).not.toBe(mainA);
  expect(oldLodSpy).toHaveBeenCalledTimes(1);
  reloaded.dispose();
  wideA.dispose();
  source0.dispose();
  source2.dispose();
  reloadedSource.dispose();
});

it("clears prototype-accessor render hooks via setter null rather than no-op delete", () => {
  const callbacks = new WeakMap<object, Map<string, unknown>>();
  const setterCalls: Array<{ prop: string; value: unknown }> = [];
  class AccessorInstancedMesh extends InstancedMesh {}
  for (const prop of ["onBeforeRender", "onAfterRender"] as const) {
    Object.defineProperty(AccessorInstancedMesh.prototype, prop, {
      configurable: true,
      get(this: object) {
        return callbacks.get(this)?.get(prop) ?? null;
      },
      set(this: object, value: unknown) {
        setterCalls.push({ prop, value });
        const map = callbacks.get(this) ?? new Map<string, unknown>();
        if (value === null || value === undefined) map.delete(prop);
        else map.set(prop, value);
        callbacks.set(this, map);
      },
    });
  }

  const root = new Object3D();
  const h = host(() => false);
  let shared: SharedBatch | undefined;
  h.setShared = (_key, batch) => {
    shared = batch;
  };
  h.attach = (batch) => {
    Object.setPrototypeOf(batch.mesh, AccessorInstancedMesh.prototype);
    root.add(batch.mesh);
  };
  const prewarm = new CellPrewarm(h);
  prewarm.queuePrewarm(asset);
  // Step 1: mint once so `awaitDraw` borrows `onBeforeRender`, then invoke it directly.
  prewarm.drainPrewarm();
  if (!shared) throw new Error("Prewarm batch was not minted.");
  const mesh = shared.mesh;
  expect(typeof mesh.onBeforeRender).toBe("function");
  Reflect.apply(mesh.onBeforeRender, mesh, [undefined, root, undefined]);
  expect(mesh.onBeforeRender).toBeNull();
  expect(setterCalls.some((c) => c.prop === "onBeforeRender" && c.value === null)).toBe(true);
  for (let frame = 0; frame < 11; frame++) prewarm.drainPrewarm();
  expect(prewarm.settled).toBe(true);
  setterCalls.length = 0;

  mesh.count = 1;
  mesh.visible = true;
  mesh.boundingSphere = new Sphere(new Vector3(), 1);
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.z = 10;
  camera.lookAt(0, 0, 0);
  const renderer = { compiling: false, info: { render: { drawCalls: 0 } } };
  expect(prewarm.pendingCpuDrawsInView(root, camera, renderer as unknown as IRendererLike)).toBe(1);
  // Prior value on prototype accessor was `null`, so running the hooks must not throw and must
  // restore both hooks back to `null` via the prototype setter when the draw finishes.
  Reflect.apply(mesh.onBeforeRender, mesh, [renderer, root, camera]);
  renderer.info.render.drawCalls += 1;
  Reflect.apply(mesh.onAfterRender, mesh, [renderer, root, camera]);
  expect(mesh.onBeforeRender).toBeNull();
  expect(mesh.onAfterRender).toBeNull();
  expect(setterCalls.some((c) => c.prop === "onBeforeRender" && c.value === null)).toBe(true);
  expect(setterCalls.some((c) => c.prop === "onAfterRender" && c.value === null)).toBe(true);
});
