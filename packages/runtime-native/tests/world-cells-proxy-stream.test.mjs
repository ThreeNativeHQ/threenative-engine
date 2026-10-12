import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createRenderer } from "../../core/src/renderer.ts";
import { assertWorldCellsProxyProof, startScene } from "../conformance/scenes/shared/world-cells-proxy-stream.js";

vi.mock("../../core/src/renderer.ts", () => ({ createRenderer: vi.fn() }));

test.each([true, false])("the scene requires backend proxy submission: %s", async (submitProxy) => {
  const frames = [];
  const observations = [];
  let world;
  const renderer = {
    kind: "webgpu",
    domElement: { height: 720 },
    info: { render: { drawCalls: 0 } },
    raw: { backend: { device: {
      pushErrorScope() {},
      popErrorScope: async () => null,
      queue: { onSubmittedWorkDone: async () => {} },
    } } },
    setSize() {},
    compileAsync: async () => {},
    uploadAttributes: () => 1,
    render(scene, camera) {
      world = scene.children.find((child) => typeof child.stats === "function");
      observations.push(world.stats());
      scene.updateMatrixWorld(true);
      scene.traverseVisible((mesh) => {
        if (!mesh.isMesh || !camera.layers.test(mesh.layers)) return;
        mesh.onBeforeRender(renderer.raw, scene, camera, mesh.geometry, mesh.material, null);
        // Three's WebGPU backend submits zero-count draws too; no GPU is used here.
        if (submitProxy || !mesh.parent?.name.startsWith("world-cell-proxy:"))
          renderer.info.render.drawCalls++;
        mesh.onAfterRender(renderer.raw, scene, camera, mesh.geometry, mesh.material, null);
      });
    },
  };
  createRenderer.mockResolvedValue(renderer);
  vi.stubGlobal("requestAnimationFrame", (callback) => frames.push(callback));
  vi.stubGlobal("__TN_CONFORMANCE", undefined);
  let settled = false;
  const running = startScene({}, { width: 1280, height: 720 });
  void running.then(() => { settled = true; }, () => { settled = true; });
  try {
    for (let frame = 0; frame < 400 && !settled; frame++) {
      await new Promise(setImmediate);
      for (const callback of frames.splice(0)) callback(frame);
    }
    assert.equal(settled, true, "scene did not settle within its frame bound");
    if (!submitProxy) {
      await assert.rejects(running, /proxy stream timed out/u);
      assert.equal(world.stats().hlod.compiled, 1);
      assert.equal(world.stats().hlod.observed, 0);
      assert.equal(world.stats().hlod.active, 0);
      return;
    }
    await running;
    for (const key of ["0:0", "2:0"]) {
      assert.ok(observations.some((stats) => stats.residentKeys.includes(key) && stats.hlod.active > 0));
    }
    assert.equal(world.stats().hlod.active, 0);
    assert.equal(world.stats().hlod.refused, 0);
    assert.equal(globalThis.__TN_CONFORMANCE?.ok, true);
  } finally {
    world?.dispose();
    vi.unstubAllGlobals();
  }
});

test("WorldCells conformance requires two admitted cells, observed proxy swaps and validation", () => {
  const observations = [0, 2].map((x) => ({
    residentKeys: [`${x}:0`], loadedCells: 1, instances: 1, failures: 0, evictions: x,
    hlod: { compiled: 1, observed: 1, active: 1, failures: 0 },
  }));
  assert.doesNotThrow(() => assertWorldCellsProxyProof(observations, null));
  assert.throws(() => assertWorldCellsProxyProof([], null), /two streamed/u);
  assert.throws(() => assertWorldCellsProxyProof(undefined, null), /two streamed/u);
  assert.throws(() => assertWorldCellsProxyProof(observations, undefined), /validation/u);
  assert.throws(() => assertWorldCellsProxyProof(observations, { message: "GPU error" }), /validation/u);
  for (const field of ["compiled", "observed", "active"]) {
    const missing = structuredClone(observations);
    missing[0].hlod[field] = 0;
    assert.throws(() => assertWorldCellsProxyProof(missing, null), /proxy must/u);
  }
  const missingCell = structuredClone(observations);
  missingCell[1].residentKeys = [];
  assert.throws(() => assertWorldCellsProxyProof(missingCell, null), /cell missing/u);
});
