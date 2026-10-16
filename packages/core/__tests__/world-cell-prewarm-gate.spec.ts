import {
  Box3,
  BoxGeometry,
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

function host(built: (key: string) => boolean): ICellPrewarmHost {
  const parent = new Object3D();
  return {
    released: () => false,
    parent: () => parent,
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

  it("stays open until an asset asks, so an early idle update cannot settle it", () => {
    const prewarm = new CellPrewarm(host(() => true));
    for (let update = 0; update < 4; update += 1) prewarm.drainPrewarm();
    expect(prewarm.settled).toBe(false);
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
