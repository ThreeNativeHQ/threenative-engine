import { ReadbackBuffer } from "three/webgpu";
import { WorldCells } from "../../../../core/src/world-cells.ts";
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
  cells: [{ x: 0, z: 0, runs: [{ asset: "box", count: 2, offset: 0 }] }],
};

const PLACEMENTS = new Float32Array([
  -2, 0, 0, 0, 0, 0, 1, 1,
  2, 0, 0, 0, 0, 0, 1, 1,
]).buffer;

function decodedModel() {
  const root = new THREE.Group();
  root.add(
    new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 1.5, 1.5),
      new THREE.MeshBasicMaterial({ color: 0x4f9d69 }),
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
  assertCondition(detail.targetIdentities === 2, "World GPU readback proof target count changed.");
  assertCondition(detail.disposeEvents === 2, "World GPU readback targets did not both dispose.");
  assertCondition(
    [...releases.values()].every((count) => count >= 2),
    "World GPU readback targets did not both release on repeated checks.",
  );
  detail.originalDisposed = true;
}

function scheduleDisposal(renderer, world, detail, targets, releases, onDone) {
  const idle = renderer.backend?.device?.queue?.onSubmittedWorkDone?.() ?? Promise.resolve();
  void Promise.resolve(idle).then(() => {
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
  return detail.framewise >= 200 && detail.releaseEvents >= 4 && disposePending === false;
}

function assertProofDeadline(frame, detail) {
  if (
    frame >= 299 &&
    (detail.framewise < 200 ||
      detail.originalNonemptyFrames === 0 ||
      detail.originalDisposed === false ||
      detail.reloadReady === false ||
      detail.reloadNonemptyFrames === 0)
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

export async function startScene(canvas, dimensions) {
  return startVisualScene(
    canvas,
    dimensions,
    "world-gpu-scene-readback",
    async ({ camera, renderer, scene }) => {
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
        if (targets.size > 2)
          throw new Error(`World GPU readback proof exceeded two pooled targets: ${String(targets.size)}.`);
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
          impostors: false,
          terrain: false,
          loadModel: async () => decodedModel(),
        });
      const assertFrameValidation = (validation, frame) => {
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
        assertCondition(validation.verdict === "ok", `World GPU frame ${String(frame)} failed validation.`);
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
            scheduleDisposal(renderer, world, detail, targets, releases, async () => {
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
