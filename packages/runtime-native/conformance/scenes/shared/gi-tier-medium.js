import * as THREE from "three/webgpu";
import { color, normalWorld, positionWorld } from "three/tsl";
import { SOFTWARE_ADAPTER } from "../../../../core/src/gpu-class.ts";
import { GIBudget } from "../../../../core/src/render/gi-budget.ts";
import { ProbeVolume } from "../../../../core/src/render/probe-volume.ts";
import { assertCondition, startVisualScene } from "./scene-support.js";

/**
 * PRD-644: the `medium` GI tier draws the irradiance field alone and the budget watcher reports that
 * method against the frame period. The `GIBudget` runs on injected readings, so the browser and the native
 * host report the same; the frame is the probe volume lighting a wall, the `irradianceField` method (no
 * screen gather).
 */
const VOLUME_BOUNDS = new THREE.Box3(
  new THREE.Vector3(-1, -1, -0.8),
  new THREE.Vector3(1, 1, 0.8),
);
const BAKE_FRAME_LIMIT = 180;

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function waitForSubmittedWork(renderer) {
  const wait = renderer.backend?.device?.queue?.onSubmittedWorkDone;
  if (typeof wait === "function") await wait.call(renderer.backend.device.queue);
}

/** The adapter's four `adapter.info` fields, and the one that names a CPU rasteriser (as `createRenderer` reads them). */
async function readAdapter(renderer) {
  const gpu = renderer.backend?.gpu ?? globalThis.navigator?.gpu;
  const info = (await gpu?.requestAdapter?.())?.info ?? {};
  const fields = Object.fromEntries(["architecture", "description", "device", "vendor"].map((name) => [name, String(info[name] ?? "")]));
  return { fields, software: Object.values(fields).find((value) => SOFTWARE_ADAPTER.test(value)) };
}

/** Feeds `frames` identical readings: the GI stage time and the whole frame's time. */
function feed(gi, frames, stageMs, frameMs) {
  let report;
  for (let i = 0; i < frames; i += 1) report = gi.observe(stageMs, frameMs) ?? report;
  return report;
}

/** The `medium` tier on injected GPU readings: it holds its method and reports the frame against the period. */
function verifyBudget() {
  const lines = [];
  const gi = new GIBudget({
    framePeriodMs: 1000 / 60,
    method: "irradianceField",
    report: (line) => lines.push(line),
    stages: ["SSGI"],
    tier: "medium",
    windowFrames: 12,
  });
  const within = feed(gi, 12, 0, 9);
  assertCondition(within?.finalGatherMethod === "irradianceField", "a frame inside the period: medium holds");
  assertCondition(within.verdict === "within", "9 ms is inside the 15 ms target");
  const over = feed(gi, 12, 3, 22);
  assertCondition(over?.finalGatherMethod === "irradianceField", "a frame over the period: medium still holds");
  assertCondition(over.verdict === "over" && over.frameMs === 22, "22 ms is over the 15 ms target and the report says so");
  assertCondition(gi.globalIlluminationQuality === 1, "irradianceField follows Unreal quality level 1");
  assertCondition(lines.length === 2 && lines.every((line) => line.startsWith("TN_GI ")), "two TN_GI lines: the first window and the change of verdict");
  return { held: within.finalGatherMethod, verdict: over.verdict, frameMs: over.frameMs };
}

export async function startScene(canvas, dimensions) {
  return startVisualScene(
    canvas,
    dimensions,
    "gi-tier-medium",
    async ({ camera, renderer, scene }) => {
      const budget = verifyBudget();
      const volume = new ProbeVolume({
        bounds: VOLUME_BOUNDS,
        bakeBudgetMs: 16,
        cubemapSize: 8,
        density: 0.5,
        maxWorkItemsPerFrame: 1,
      });
      scene.add(volume);
      const adapter = await readAdapter(renderer);
      const host = { kind: "webgpu", raw: renderer, ...(adapter.software === undefined ? {} : { softwareAdapter: adapter.software }) };
      volume.attachRenderer(host);

      const wallMaterial = new THREE.MeshBasicNodeMaterial();
      wallMaterial.colorNode = volume.sampleNode(positionWorld, normalWorld).mul(8);
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.45), wallMaterial);
      wall.name = "neutral-wall-inside-frustum";
      wall.position.set(0.5, 0, -0.35);

      // The saturated panel is outside the frustum: only the baked field carries its light to the wall.
      const emitterMaterial = new THREE.MeshBasicNodeMaterial();
      emitterMaterial.colorNode = color(0xff0030).mul(12);
      const offscreenEmitter = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.45, 0.8), emitterMaterial);
      offscreenEmitter.name = "off-screen-emitter";
      offscreenEmitter.position.set(4.2, 0, 1.8);
      scene.add(wall, offscreenEmitter);

      const bake = volume.requestBake(scene);
      let bakeFrames = 0;
      let maxBakeCost = 0;
      while (volume.observation.status === "baking") {
        volume.process(host);
        maxBakeCost = Math.max(maxBakeCost, volume.observation.bakeCostMs);
        renderer.render(scene, camera);
        await waitForSubmittedWork(renderer);
        bakeFrames += 1;
        if (bakeFrames > BAKE_FRAME_LIMIT) {
          throw new Error(`probe volume bake exceeded ${BAKE_FRAME_LIMIT} frames`);
        }
        await nextFrame();
      }
      await bake;
      assertCondition(volume.observation.status === "ready", "probe volume bake must complete");

      console.log(`TN_GI_TIER_MEDIUM:${JSON.stringify({ adapter: adapter.fields, atlasTarget: volume.atlasTarget, bakeFrames, maxBakeCostMs: maxBakeCost, softwareAdapter: adapter.software ?? null })}`);
      return {
        detail: {
          budget,
          adapter: adapter.fields,
          atlasTarget: volume.atlasTarget,
          maxBakeCostMs: maxBakeCost,
          method: "irradianceField",
          probeCount: volume.probeCount,
          status: volume.observation.status,
        },
        render: () => renderer.render(scene, camera),
        volume,
        wall,
      };
    },
    {
      background: 0x090b14,
      camera: (size) => {
        const view = new THREE.PerspectiveCamera(50, size.width / size.height, 0.1, 100);
        view.position.set(0, 0.05, 3.8);
        view.lookAt(0, 0, -0.35);
        return view;
      },
    },
  );
}
