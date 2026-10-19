// Web entry for the PRD-117 ThreeNative arm: the culling A/B and the render projection's own
// wiring, then the shared driver from `driver.ts`. `plain.ts` drives the same driver with the same
// harness and neither the projection nor the stage profiler, which is what makes the two arms the
// same scene measured by two engines.
import {
  type BatchedMesh,
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
} from "three/webgpu";
import { SceneRenderProjection } from "../../../packages/core/src/renderProjection.js";
import { installRendererStageHooks } from "../../../scripts/render-profile/renderer-stage-hooks.js";
import { type ILadderArm, type ILadderKnobs, LADDER_KNOBS, runLadderArm } from "./driver.js";
import type { ILoadTestHarness } from "./game.js";
import { createFoxCrowd } from "./ladder-characters.js";
import { percentile } from "./workload.js";

interface ICullingArmReport {
  drawCalls: number;
  renderP50Ms: number;
  renderP95Ms: number;
  repeat: number;
}

interface ICullingReport {
  cullingOff: ICullingArmReport[];
  cullingOn: ICullingArmReport[];
  measuredFrameEnd: number;
  measuredFrameStart: number;
  objectCount: number;
  offscreenFraction: number;
  sampleCount: number;
}

interface ICullingProbe {
  batch: BatchedMesh;
  camera: PerspectiveCamera;
  dispose(): void;
  projection: SceneRenderProjection;
  root: Scene;
}

const CULLING_OBJECT_COUNT = 4_096;
const CULLING_VISIBLE_COUNT = CULLING_OBJECT_COUNT / 4;
const CULLING_ANCHOR_COUNT = 2_048;

function createCullingProbe(): ICullingProbe {
  const source = new Scene();
  const material = new MeshBasicMaterial({ color: 0xffffff });
  const anchorGeometry = new BoxGeometry(1, 1, 1);
  for (let index = 0; index < CULLING_ANCHOR_COUNT; index += 1) {
    const anchor = new Mesh(anchorGeometry, material);
    anchor.position.set((index % 64) - 32, Math.floor(index / 64) - 16, 0);
    source.add(anchor);
  }
  const meshes: Mesh[] = [];
  for (let index = 0; index < CULLING_OBJECT_COUNT; index += 1) {
    const mesh = new Mesh(new BoxGeometry(1, 1 + index * 0.001, 1), material);
    mesh.position.z = index < CULLING_VISIBLE_COUNT ? 0 : 1_000;
    source.add(mesh);
    meshes.push(mesh);
  }
  const projection = new SceneRenderProjection(source);
  projection.reconcile();
  if (
    projection.deoptimized ||
    projection.report.instancedBatches !== 1 ||
    projection.report.materialBatches !== 1 ||
    projection.report.projectedObjects !== CULLING_ANCHOR_COUNT + CULLING_OBJECT_COUNT
  ) {
    projection.dispose();
    material.dispose();
    anchorGeometry.dispose();
    for (const mesh of meshes) mesh.geometry.dispose();
    throw new Error("TN_CULLING_PROBE_SETUP_FAILED");
  }

  let batch: BatchedMesh | undefined;
  projection.root.traverse((object) => {
    if ((object as BatchedMesh).isBatchedMesh === true) batch = object as BatchedMesh;
  });
  if (batch === undefined) {
    projection.dispose();
    material.dispose();
    anchorGeometry.dispose();
    for (const mesh of meshes) mesh.geometry.dispose();
    throw new Error("TN_CULLING_PROBE_BATCH_MISSING");
  }

  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  projection.root.updateMatrixWorld(true);
  return {
    batch,
    camera,
    dispose: () => {
      projection.dispose();
      material.dispose();
      anchorGeometry.dispose();
      for (const mesh of meshes) mesh.geometry.dispose();
    },
    projection,
    root: projection.root,
  };
}

async function measureCullingArm(
  renderer: ILoadTestHarness["renderer"],
  cullingOn: boolean,
  repeat: number,
  knobs: ILadderKnobs,
): Promise<ICullingArmReport> {
  const probe = createCullingProbe();
  // The ON arm uses the projection's production setting. The OFF arm is the paired ablation on
  // the same prepared batch, and is never a game-facing option.
  if (!cullingOn) probe.batch.perObjectFrustumCulled = false;
  const renderMs: number[] = [];
  let drawCalls = 0;
  const statsFrame = Math.floor((knobs.frames + knobs.warmup) / 2);
  try {
    for (let frameIndex = 0; frameIndex < knobs.frames; frameIndex += 1) {
      renderer.info.reset();
      const startedAt = performance.now();
      await renderer.render(probe.root, probe.camera);
      const elapsed = performance.now() - startedAt;
      if (frameIndex > knobs.warmup) renderMs.push(elapsed);
      if (frameIndex === statsFrame) {
        // WebGPU's default framebuffer path adds one full-screen presentation draw after the
        // scene pass. The culling result is the scene's sub-draw count, so keep that presentation
        // draw out of the A/B number while retaining it in the renderer's own meter.
        drawCalls = Math.max(0, renderer.info.render.drawCalls - 1);
      }
      await nextFrame();
    }
  } finally {
    probe.dispose();
  }
  return {
    drawCalls,
    renderP50Ms: percentile(renderMs, 0.5),
    renderP95Ms: percentile(renderMs, 0.95),
    repeat,
  };
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function measureCullingRung(
  renderer: ILoadTestHarness["renderer"],
  knobs: ILadderKnobs,
): Promise<ICullingReport> {
  const cullingOn: ICullingArmReport[] = [];
  const cullingOff: ICullingArmReport[] = [];
  for (let repeat = 0; repeat < knobs.repeats; repeat += 1) {
    cullingOn.push(await measureCullingArm(renderer, true, repeat, knobs));
    cullingOff.push(await measureCullingArm(renderer, false, repeat, knobs));
  }
  return {
    cullingOff,
    cullingOn,
    measuredFrameEnd: knobs.frames - 1,
    measuredFrameStart: knobs.warmup + 1,
    objectCount: CULLING_OBJECT_COUNT,
    offscreenFraction: 1 - CULLING_VISIBLE_COUNT / CULLING_OBJECT_COUNT,
    sampleCount: knobs.frames - knobs.warmup - 1,
  };
}

// "tn-web", or "tn-engine-web" when `vite.config.ts` bound `three` to the Wasm engine (PRD-573 slice 7).
declare const __TN_WEB_ARM__: string;
const onEngine = __TN_WEB_ARM__ === "tn-engine-web";

// What every tn-web report says about the workload, whichever build served it.
const BUILD_DETAILS = onEngine
  ? "SceneRenderProjection consumer on the Wasm engine (three bound to tn-native-engine-web); no culling A/B"
  : "SceneRenderProjection consumer on three/webgpu; culling A/B uses the production planner and excludes the presentation draw";

const TN_WEB_ARM: ILadderArm = {
  arm: __TN_WEB_ARM__,
  buildNotes: BUILD_DETAILS,
  // `projection=js` is the named override that forces core's mirror where the host batches the scene itself.
  createCollapse: (scene, options) =>
    new SceneRenderProjection(
      scene,
      new URLSearchParams(globalThis.location.search).get("projection") === "js"
        ? { ...options, projection: "js" }
        : options,
    ),
  // PRD-464's R3 characters, through the engine's loader and `SkeletalMesh3D`. Only requested when
  // a ladder rung is in `modes`, so an L-only run never decodes the Fox.
  createCharacters: createFoxCrowd,
  engineName: "threenative",
  engineVersion:
    new URLSearchParams(globalThis.location.search).get("engineVersion") ?? "workspace",
  // The culling A/B times three's BatchedMesh planner, which the engine arm does not draw with.
  ...(onEngine ? {} : { measureCulling: (renderer) => measureCullingRung(renderer, LADDER_KNOBS) }),
  rendererLabel: onEngine
    ? "tn-native-engine-web (Wasm + browser WebGPU)"
    : "three/webgpu WebGPURenderer",
  stageHooks: installRendererStageHooks,
};

async function main(): Promise<void> {
  const status = document.getElementById("status") as HTMLElement;
  const canvas = document.getElementById("stage") as HTMLCanvasElement;
  await runLadderArm(canvas, status, TN_WEB_ARM);
}

const status = document.getElementById("status") as HTMLElement;
main().catch((error: unknown) => {
  status.textContent = `failed: ${String(error)}`;
  (globalThis as unknown as Record<string, unknown>).__ENGINE_LOAD_TEST_ERROR__ = String(error);
});
