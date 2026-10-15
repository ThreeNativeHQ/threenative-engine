import { createRenderer } from "../../../../core/src/renderer.ts";
import { WorldCells } from "../../../../core/src/world-cells.ts";
import { assertGpuValidationApi } from "./gpu-validation-scope.js";
import { THREE, assertCondition } from "./scene-support.js";
import { assertSubmittedWorkPromise } from "./screenshot-completion.js";

export function assertWorldCellsProxyProof(observations, validationError) {
  assertCondition(observations?.length === 2, "two streamed cell observations required");
  for (const [index, stats] of observations.entries()) {
    assertCondition(stats.residentKeys?.includes(`${index * 2}:0`), "streamed cell missing");
    assertCondition(stats.loadedCells > 0 && stats.instances > 0, "cell source not admitted");
    assertCondition(
      stats.hlod?.compiled > 0 && stats.hlod.observed > 0 && stats.hlod.active > 0,
      "proxy must compile, submit on the main camera, and replace detail",
    );
    assertCondition(stats.failures === 0 && stats.hlod.failures === 0, "streaming failed");
  }
  assertCondition(observations[1].evictions > 0, "first cell did not evict");
  assertCondition(validationError === null, "GPU validation observation missing or failed");
}

export function createWorldCellsProxyData() {
  const cells = [0, 2].map((x, index) => ({
    x,
    z: 0,
    runs: [{ asset: "box", offset: index, count: 1 }],
    proxy: {
      glb: `proxy-${x}.glb`,
      scope: "cell",
      triangles: 2,
      materialGroups: 1,
      error: 0.1,
      bounds: { min: [x * 32 + 7, 0, 8], max: [x * 32 + 9, 2, 8] },
    },
  }));
  return {
    manifest: {
      version: 1,
      extent: { minX: 0, minZ: 0, sizeX: 96, sizeZ: 32 },
      cellSize: 32,
      terrain: {
        heightmap: "height.u16",
        columns: 4,
        rows: 2,
        spacing: 32,
        heightMin: 0,
        heightMax: 2,
      },
      placements: "placements.bin",
      assets: { box: { glb: "box.glb", lods: [], bounds: { min: [-1, -1, -1], max: [1, 1, 1] } } },
      cells,
    },
    placements: new Float32Array([8, 1, 8, 0, 0, 0, 1, 1, 72, 1, 8, 0, 0, 0, 1, 1]).buffer,
  };
}

export async function startScene(canvas, dimensions, editedData) {
  const renderer = await createRenderer({
    canvas, antialias: false, preferWebGPU: true, pixelRatio: 1, pipelineCensus: false,
  });
  renderer.setSize(dimensions.width, dimensions.height, false);
  const device = renderer.raw.backend?.device;
  assertGpuValidationApi(device);
  assertCondition(typeof device.queue?.onSubmittedWorkDone === "function", "GPU queue missing");
  device.pushErrorScope("validation");

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x18202f);
  const camera = new THREE.PerspectiveCamera(60, dimensions.width / dimensions.height, 0.1, 1000);
  const follow = { position: { x: 8, z: 8 } };
  const world = await WorldCells.load({
    url: "/world/world.json", follow, ring: 0,
    surface: new THREE.MeshBasicMaterial(),
    // HLOD reserves up to 8 MiB for decoded source and fixed proxy copies before IO.
    budgets: { bytes: 10000000, instances: 10, residentCells: 2 },
    terrain: false, gpuScene: false, bundles: false, adaptiveLod: false,
    data: editedData ?? createWorldCellsProxyData(),
    loadModel: async (url) => {
      const proxy = /proxy-(0|2)\.glb$/u.exec(url);
      const root = new THREE.Group();
      root.add(new THREE.Mesh(
        proxy ? new THREE.PlaneGeometry(2, 2) : new THREE.BoxGeometry(2, 2, 2),
        new THREE.MeshBasicMaterial({ color: 0xf6ad55 }),
      ));
      if (proxy) root.position.set(Number(proxy[1]) * 32 + 8, 1, 8);
      return root;
    },
  });
  scene.add(world);
  const observations = [];
  for (const [visit, x] of (editedData ? [8, 72, 8] : [8, 72]).entries()) {
    follow.position.x = x;
    camera.position.set(x, 2, 308);
    camera.lookAt(x, 1, 8);
    for (let frame = 0; frame < 180; frame++) {
      camera.updateMatrixWorld(true);
      world.update(renderer, camera);
      renderer.render(scene, camera);
      const completion = device.queue.onSubmittedWorkDone();
      assertSubmittedWorkPromise(completion, "world-cell-render");
      await completion;
      const stats = world.stats();
      if (stats.residentKeys.includes(`${(x - 8) / 32}:0`) && stats.instances > 0 &&
        (editedData && x === 8 ? stats.loadedCells > 0 : stats.hlod.active > 0)) {
        observations.push(stats);
        break;
      }
      await new Promise(requestAnimationFrame);
    }
    assertCondition(observations.length === visit + 1, "proxy stream timed out");
    camera.position.set(x, 2, 15);
    camera.lookAt(x, 1, 8);
    camera.updateMatrixWorld(true);
    world.update(renderer, camera);
    assertCondition(world.stats().hlod.active === 0, "near detail did not replace proxy");
    renderer.render(scene, camera);
    const completion = device.queue.onSubmittedWorkDone();
    assertSubmittedWorkPromise(completion, "near-detail-render");
    await completion;
    if (editedData) {
      const positions = [];
      world.updateMatrixWorld(true);
      world.traverseVisible((object) => {
        if (!object.isInstancedMesh || !object.layers.test(camera.layers)) return;
        const matrix = new THREE.Matrix4();
        for (let index = 0; index < object.count; index++) {
          object.getMatrixAt(index, matrix);
          matrix.premultiply(object.matrixWorld);
          positions.push(new THREE.Vector3().setFromMatrixPosition(matrix).toArray());
        }
      });
      observations[visit].positions = positions;
    }
  }
  const validationError = await device.popErrorScope();
  if (!editedData) assertWorldCellsProxyProof(observations, validationError);
  function frame() {
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  if (!editedData) globalThis.__TN_CONFORMANCE = {
    ok: true, type: "world-cells-proxy-stream",
    detail: { streamedCells: 2, proxySwaps: 2, nearRestores: 2, validationErrors: 0 },
  };
  return { renderer, scene, camera, subject: { world }, observations, validationError };
}
