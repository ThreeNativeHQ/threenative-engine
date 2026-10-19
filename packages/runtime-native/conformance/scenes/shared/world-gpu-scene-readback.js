import { ReadbackBuffer } from "three/webgpu";
import { WorldCells } from "../../../../core/src/world-cells.ts";
import { WorldGpuScene } from "../../../../core/src/world-gpu-scene.ts";
import { assertCondition, startVisualScene, THREE } from "./scene-support.js";

const MANIFEST = {
  version: 1,
  extent: { minX: -16, minZ: -16, sizeX: 32, sizeZ: 32 },
  cellSize: 32,
  placements: "placements.bin",
  terrain: {
    heightmap: "height.u16",
    columns: 2,
    rows: 2,
    spacing: 32,
    heightMin: 0,
    heightMax: 1,
  },
  assets: {
    box: {
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      glb: "box.glb",
    },
  },
  cells: [{ x: 0, z: 0, runs: [
    { asset: "box", count: 1, offset: 0 },
    { asset: "box", count: 1, offset: 1 },
  ] }],
};

const PLACEMENTS = new Float32Array([
  -2, 0, 0, 0, 0, 0, 1, 1,
  2, 0, 0, 0, 0, 0, 1, 1,
]).buffer;

function decodedModel() {
  const root = new THREE.Group();
  const map = new THREE.DataTexture(new Uint8Array([
    79, 157, 105, 255, 79, 157, 105, 0,
    79, 157, 105, 0, 79, 157, 105, 255,
  ]), 2, 2);
  map.needsUpdate = true;
  root.add(
    new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 1.5, 1.5),
      new THREE.MeshBasicMaterial({ map, alphaTest: 0.5 }),
    ),
  );
  return root;
}

function visibleWorldMeshes(world) {
  let count = 0;
  world.traverse((node) => {
    if (node.isMesh === true && node.visible && (node.geometry?.drawRange?.count ?? 0) > 0) count += 1;
  });
  return count;
}

function assertReadbackLifecycle(detail, targets, releases) {
  assertCondition(detail.targetIdentities === 4, "Atlas key growth must replace one pooled target pair.");
  assertCondition(detail.disposeEvents === 4, "World GPU readback target pairs did not all dispose.");
  assertCondition(
    [...releases.values()].every((count) => count >= 2),
    "World GPU readback targets did not both release on repeated checks.",
  );
  detail.originalDisposed = true;
}

function scheduleDisposal(renderer, world, detail, targets, releases, onDone) {
  const idle = renderer.backend?.device?.queue?.onSubmittedWorkDone?.() ?? Promise.resolve();
  return Promise.resolve(idle).then(() => {
    world.dispose();
    assertReadbackLifecycle(detail, targets, releases);
    return onDone();
  }).catch((error) => {
    detail.reloadFailures += 1;
    detail.failure = String(error);
  });
}

function observeWorldFrame(world, detail, phase) {
  if (visibleWorldMeshes(world) > 0) {
    if (phase === "original") detail.originalNonemptyFrames += 1;
    else {
      detail.reloadNonemptyFrames += 1;
      if (detail.reloadMarkerReported === false) {
        console.info(
          `TN_WORLD_GPU_SCENE_READBACK original=disposed originalNonempty=${String(detail.originalNonemptyFrames)} framewise=${String(detail.framewise)} lastDispatch=${String(detail.lastDispatch)} censuses=${String(detail.censuses)} targetIdentities=${String(detail.targetIdentities)} releaseEvents=${String(detail.releaseEvents)} disposeEvents=${String(detail.disposeEvents)} reload=ready reloadNonempty=${String(detail.reloadNonemptyFrames)} reloadFailures=${String(detail.reloadFailures)} validation=off reason=post-disposal-reload`,
        );
        detail.reloadMarkerReported = true;
      }
    }
  }
  if (detail.failure !== "") throw new Error(detail.failure);
}

function canDispose(detail, disposePending) {
  return detail.framewise >= 200 && detail.steadyFrames >= 200 && detail.terminalDrawFrames > 0 &&
    detail.releaseEvents >= 4 && disposePending === false;
}

function assertProofDeadline(frame, detail) {
  if (
    frame >= 299 &&
    (detail.framewise < 200 ||
      detail.originalNonemptyFrames === 0 ||
      detail.originalDisposed === false ||
      detail.reloadReady === false ||
      detail.reloadNonemptyFrames === 0 ||
      detail.steadyFrames < 200 || detail.terminalDrawFrames === 0)
  )
    throw new Error(
      `World GPU readback proof did not complete its framewise lifecycle: framewise=${String(detail.framewise)} originalNonempty=${String(detail.originalNonemptyFrames)} originalDisposed=${String(detail.originalDisposed)} reloadReady=${String(detail.reloadReady)} reloadNonempty=${String(detail.reloadNonemptyFrames)}.`,
    );
}

function reportFinalMarker(frame, detail) {
  if (
    frame < 299 ||
    detail.framewise < 200 ||
    detail.originalNonemptyFrames === 0 ||
    detail.finalMarkerReported ||
    detail.reloadNonemptyFrames === 0
  )
    return;
  console.info(
    `TN_WORLD_GPU_SCENE_READBACK final original=disposed originalNonempty=${String(detail.originalNonemptyFrames)} framewise=${String(detail.framewise)} lastDispatch=${String(detail.lastDispatch)} censuses=${String(detail.censuses)} targetIdentities=${String(detail.targetIdentities)} releaseEvents=${String(detail.releaseEvents)} disposeEvents=${String(detail.disposeEvents)} reload=ready reloadNonempty=${String(detail.reloadNonemptyFrames)} reloadFailures=${String(detail.reloadFailures)} validation=off reason=post-disposal-reload`,
  );
  detail.finalMarkerReported = true;
}

async function assertAuthoredShadowFallback(renderer) {
  const gpu = new WorldGpuScene();
  const adapter = {
    kind: "webgpu",
    raw: renderer,
    compute: (nodes) => renderer.compute(nodes),
  };
  const previous = globalThis.__tnShadowGpuKeys;
  globalThis.__tnShadowGpuKeys = true;
  try {
    gpu.enable(adapter, true);
    assertCondition(gpu.on, "Shadow LOD proof requires the GPU scene backend.");
    const local = Float32Array.from(new THREE.Matrix4().elements);
    for (const level of [0, 1]) {
      const key = `rock:${String(level)}:0`;
      gpu.key(key, local, 2, { group: `rock:${String(level)}`, part: 0, parts: 1 });
      gpu.indexCount(key, 3);
    }
    const levels = [0, 1].map((level) => gpu.levelKeys(`rock:${String(level)}`));
    assertCondition(levels.every(Boolean), "Shadow LOD proof did not mint both levels.");
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camera.lookAt(0, 0, -1);
    camera.updateMatrixWorld(true);
    const planes = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    ).planes.flatMap((plane) => [...plane.normal.toArray(), plane.constant]);
    gpu.shadowKeysFrom(() => ["rock:0:0"]);
    gpu.shadowKey("rock:0:0");
    for (const z of [-10, -80])
      gpu.place(0, new THREE.Matrix4().makeTranslation(0, 0, z), 0, 0, z, 1);
    const shadow = { planes: Float32Array.from(planes), gate: 0, base: 0 };
    for (const [shadowFallback, cull, expected] of [[false, undefined, 1], [true, undefined, 2], [true, 20, 1]]) {
      gpu.slot("rock", { distances: [0, 60], levels, cull, shadowFallback });
      gpu.dispatch(adapter, camera);
      gpu.dispatchShadow(adapter, shadow);
      assertCondition(gpu.shadowArgs !== undefined && gpu.args !== undefined,
        "Shadow LOD proof has no indirect buffers.");
      const [shadowBytes, mainBytes] = await Promise.all([
        renderer.getArrayBufferAsync(gpu.shadowArgs), renderer.getArrayBufferAsync(gpu.args),
      ]);
      const words = new Uint32Array(shadowBytes);
      const mainWords = new Uint32Array(mainBytes);
      const mainCount = gpu.regions.reduce((count, region) => count + mainWords[region.argsIndex * 5 + 1], 0);
      assertCondition(mainCount === (cull === undefined ? 2 : 1),
        "Shadow fallback metadata changed main-pass distance culling.");
      const region = gpu.shadowRegionOf("rock:0:0");
      assertCondition(region !== undefined && words.length >= region.argsIndex * 5 + 5,
        "Shadow LOD proof readback is missing its complete record.");
      assertCondition(words[region.argsIndex * 5 + 1] === expected,
        `Shadow LOD fallback=${String(shadowFallback)} cull=${String(cull)} expected ${String(expected)} GPU instances.`);
    }
    console.info("TN_WORLD_GPU_SHADOW_LOD authored=1 derived=2 culled=1");
  } finally {
    gpu.dispose();
    if (previous === undefined) delete globalThis.__tnShadowGpuKeys;
    else globalThis.__tnShadowGpuKeys = previous;
  }
}

export async function startScene(canvas, dimensions) {
  return startVisualScene(
    canvas,
    dimensions,
    "world-gpu-scene-readback",
    async ({ camera, renderer, scene }) => {
      await assertAuthoredShadowFallback(renderer);
      const detail = {
        censuses: 0,
        disposeEvents: 0,
        failure: "",
        originalDisposed: false,
        originalNonemptyFrames: 0,
        readbacks: 0,
        releaseEvents: 0,
        reloadFailures: 0,
        finalMarkerReported: false,
        reloadMarkerReported: false,
        reloadNonemptyFrames: 0,
        reloadReady: false,
        targetIdentities: 0,
        framewise: 0,
        lastDispatch: 0,
        readyRefilters: undefined,
        steadyFrames: 0,
        terminalDrawFrames: 0,
      };
      const targets = new Map();
      const releases = new Map();
      const log = (line) => {
        console.info(line);
        const ok = line.match(
          /^TN_WORLD_GPU_SCENE_VALIDATE ok compared=(\d+) instancesGpu=(\d+) instancesCpu=(\d+) mismatched=(\d+) matricesMismatched=(\d+) meshMismatched=(\d+)/u,
        );
        if (ok === null) {
          if (line.startsWith("TN_WORLD_GPU_SCENE_VALIDATE error")) detail.failure = line;
          return;
        }
        if (
          Number(ok[1]) > 0 &&
          Number(ok[2]) > 0 &&
          Number(ok[3]) > 0 &&
          Number(ok[4]) === 0 &&
          Number(ok[5]) === 0 &&
          Number(ok[6]) === 0
        )
          detail.censuses += 1;
        else detail.failure = line;
      };
      const trackTarget = (target) => {
        if (target instanceof ReadbackBuffer === false)
          throw new Error("World GPU readback proof received a non-public target.");
        if (targets.has(target)) return;
        targets.set(target, true);
        releases.set(target, 0);
        target.addEventListener("release", () => {
          detail.releaseEvents += 1;
          releases.set(target, (releases.get(target) ?? 0) + 1);
        });
        target.addEventListener("dispose", () => {
          detail.disposeEvents += 1;
        });
        detail.targetIdentities = targets.size;
        if (targets.size > 4)
          throw new Error(`World GPU readback proof exceeded two pooled target pairs: ${String(targets.size)}.`);
      };
      const worldRenderer = {
        compute: (nodes) => renderer.compute(nodes),
        domElement: renderer.domElement,
        kind: "webgpu",
        log,
        raw: renderer,
        readback: async (attribute, target) => {
          trackTarget(target);
          if (typeof renderer.getArrayBufferAsync !== "function")
            throw new Error("World GPU readback proof requires getArrayBufferAsync.");
          const result = await renderer.getArrayBufferAsync(attribute, target);
          if (result !== target || target.buffer instanceof ArrayBuffer === false)
            throw new Error("World GPU readback proof did not land in its provided target.");
          detail.readbacks += 1;
          // Observe the actual indirect record in the same pooled readback as validation.
          // A minted terminal mesh alone does not prove the GPU selected and drew it.
          if (detail.readyRefilters !== undefined) {
            world.traverse((node) => {
              if (node.material?.userData?.tnWholeAssetImpostor !== true ||
                node.geometry?.indirect !== attribute) return;
              const words = new Uint32Array(target.buffer);
              const offset = node.geometry.indirectOffset / Uint32Array.BYTES_PER_ELEMENT;
              if (words[offset + 1] > 0) {
                assertCondition(words[offset] === 6, "Impostor indirect draw lost its quad geometry.");
                detail.terminalDrawFrames += 1;
              }
            });
          }
          return target.buffer.slice(0);
        },
      };
      const loadWorld = (gpuSceneValidate) =>
        WorldCells.load({
          url: "/world/world.json",
          surface: new THREE.MeshBasicMaterial({ color: 0x356859 }),
          follow: new THREE.Object3D(),
          ring: 0,
          budgets: { bytes: 8 * 1024 * 1024, instances: 8, residentCells: 1 },
          data: { manifest: MANIFEST, placements: PLACEMENTS },
          gpuScene: true,
          gpuSceneValidate,
          bundles: false,
          impostors: gpuSceneValidate,
          autoLod: { fovY: 120, viewportHeight: 100 },
          terrain: false,
          loadModel: async () => decodedModel(),
        });
      const assertFrameValidation = (validation, frame) => {
        assertCondition(validation.verdict === "ok",
          `World GPU frame ${String(frame)} failed validation: ${String(validation.cause)}.`);
        assertCondition(validation.frame === frame, `World GPU frame identity drifted at ${String(frame)}.`);
        assertCondition(
          validation.dispatch > detail.lastDispatch,
          `World GPU dispatch ${String(validation.dispatch)} did not advance after frame ${String(frame - 1)}.`,
        );
        assertCondition(validation.compared > 0, `World GPU frame ${String(frame)} compared no keys.`);
        assertCondition(
          validation.instancesGpu > 0 && validation.instancesCpu > 0,
          `World GPU frame ${String(frame)} compared no nonempty world instances.`,
        );
        assertCondition(
          validation.mismatched === 0 &&
            validation.matricesMismatched === 0 &&
            validation.meshMismatched === 0,
          `World GPU frame ${String(frame)} reported a drawn-set mismatch.`,
        );
        detail.framewise += 1;
        detail.lastDispatch = validation.dispatch;
      };
      const world = await loadWorld(true);
      scene.add(world);
      let frame = 0;
      let disposePending = false;
      let renderedWorld = world;
      return {
        detail,
        async render() {
          frame += 1;
          if (renderedWorld !== undefined)
            renderedWorld.update(worldRenderer, camera);
          renderer.render(scene, camera);
          if (detail.reloadReady === false) {
            const stats = world.stats();
            if (detail.readyRefilters === undefined && targets.size === 2 && stats.gpuScene.dispatches > 0 &&
              stats.admission.backlog === 0 && stats.admission.deferred === 0 &&
              stats.loadsInFlight === 0 && stats.loadsQueued === 0 && stats.pendingPrewarm === 0) {
              assertCondition(stats.impostor.pending === 1 && stats.impostor.assets === 0,
                "Impostor proof must reach admission readiness before atlas publication.");
              detail.readyRefilters = stats.levelRefilters;
            }
            if (detail.readyRefilters !== undefined) {
              assertCondition(stats.levelRefilters === detail.readyRefilters,
                `Late impostor atlas publication ran ${String(stats.levelRefilters - detail.readyRefilters)} CPU level refilters at frame ${String(frame)}.`);
              assertCondition(stats.failures === 0, "Impostor atlas bake failed.");
              detail.steadyFrames += 1;
              if (detail.steadyFrames === 200) {
                assertCondition(stats.impostor.assets === 1 && stats.impostor.pending === 0,
                  "Background impostor atlas did not publish.");
                console.info(`TN_WORLD_GPU_IMPOSTOR_HANDOFF frames=${String(detail.steadyFrames)} levelRefilters=${String(stats.levelRefilters - detail.readyRefilters)} terminalDrawFrames=${String(detail.terminalDrawFrames)} atlasBytes=${String(stats.impostor.atlasBytes)}`);
              }
            }
          }
          if (
            renderedWorld !== undefined &&
            detail.reloadReady === false &&
            (detail.framewise > 0 || renderedWorld.stats().gpuScene.dispatches > 0)
          ) {
            const validation = await renderedWorld.validateGpuFrame(frame);
            assertFrameValidation(validation, frame);
          }
          if (renderedWorld !== undefined)
            observeWorldFrame(renderedWorld, detail, detail.reloadReady ? "reload" : "original");
          if (canDispose(detail, disposePending)) {
            disposePending = true;
            // Keep the awaited render loop quiescent until readback teardown and reload finish.
            await scheduleDisposal(renderer, world, detail, targets, releases, async () => {
              renderedWorld = undefined;
              console.info(
                "TN_WORLD_GPU_SCENE_READBACK reload validation=off reason=post-disposal-reload",
              );
              renderedWorld = await loadWorld(false);
              scene.add(renderedWorld);
              detail.reloadReady = true;
            });
          }
          reportFinalMarker(frame, detail);
          assertProofDeadline(frame, detail);
        },
      };
    },
    {
      background: 0x101820,
      awaitRender: true,
      camera: (size) => {
        const camera = new THREE.PerspectiveCamera(52, size.width / size.height, 0.1, 100);
        camera.position.set(0, 3.5, 11);
        camera.lookAt(0, 0, 0);
        return camera;
      },
    },
  );
}
