import * as THREE from "three/webgpu";
import { clamp, pass, screenUV, uniform } from "three/tsl";
import { ResolutionSubrect } from "../../../../core/src/render/resolution-subrect.ts";
import { ResolutionScaler } from "../../../../core/src/resolution-scaler.ts";
import { startVisualScene } from "./scene-support.js";

const SCALE = 0.72;
const quantize = (size) => Math.max(8, Math.ceil(size / 8) * 8);

export function startScene(canvas, dimensions) {
  const scaler = new ResolutionScaler({ start: SCALE, minScale: 0.61, targetFps: 60 });
  const timerless = {
    fps: 20,
    presented: { max: 60, p50: 50, p95: 55, p99: 58 },
    surface: {
      drawingBufferWidth: dimensions.width,
      drawingBufferHeight: dimensions.height,
      resolutionScale: SCALE,
      resolutionSubrect: true,
    },
  };
  scaler.observe(timerless); // warmup
  if (scaler.observe(timerless) !== 0.61)
    throw new Error("Timer-less sub-rectangle policy did not probe one rung to the floor.");
  scaler.observe(timerless); // resize cooldown
  if (scaler.observe(timerless) !== SCALE || scaler.atFloor || scaler.scaleSource !== "auto")
    throw new Error("Timer-less sub-rectangle policy did not refund the failed probe.");
  scaler.observe(timerless); // resize cooldown
  const clean = {
    ...timerless,
    fps: 60,
    presented: { max: 17, p50: 16.67, p95: 17, p99: 17 },
  };
  for (let index = 0; index < 3; index++)
    if (scaler.observe(clean) !== undefined)
      throw new Error("Timer-less sub-rectangle policy climbed before four clean windows.");
  if (scaler.observe(clean) !== 0.85)
    throw new Error("Timer-less sub-rectangle policy did not climb exactly one rung.");

  return startVisualScene(canvas, dimensions, "resolution-subrect", ({ renderer, scene, camera }) => {
    const subject = new THREE.Mesh(
      new THREE.TorusKnotGeometry(0.62, 0.19, 96, 20),
      new THREE.MeshBasicNodeMaterial({ color: 0x38bdf8 }),
    );
    subject.rotation.set(0.3, 0.4, 0.1);
    scene.add(subject);

    const scenePass = pass(scene, camera);
    const controller = new ResolutionSubrect();
    controller.retain(scenePass, [scenePass.renderTarget]);
    controller.activate(1);
    controller.setSize(dimensions.width, dimensions.height);

    const view = controller.textureView(scenePass.renderTarget.texture);
    if (!view) throw new Error("Resolution sub-rectangle did not retain the scene pass texture.");
    const viewFraction = uniform(new THREE.Vector2(1, 1)).onRenderUpdate(() => view.viewFraction);
    const halfTexel = uniform(new THREE.Vector2()).onRenderUpdate(() => view.halfTexel);
    const uvNode = clamp(
      screenUV.mul(viewFraction),
      halfTexel,
      viewFraction.sub(halfTexel),
    );
    const pipeline = new THREE.RenderPipeline(renderer);
    pipeline.outputNode = scenePass.getTextureNode("output").sample(uvNode);

    const capacityWidth = quantize(dimensions.width);
    const capacityHeight = quantize(dimensions.height);
    const assertTransition = (scale) => {
      const viewWidth = quantize(dimensions.width * scale);
      const viewHeight = quantize(dimensions.height * scale);
      const target = scenePass.renderTarget;
      if (
        target.width !== capacityWidth ||
        target.height !== capacityHeight ||
        target.viewport.z !== viewWidth ||
        target.viewport.w !== viewHeight ||
        target.scissor.z !== viewWidth ||
        target.scissor.w !== viewHeight ||
        !target.scissorTest ||
        view.viewFraction.x !== viewWidth / capacityWidth ||
        view.viewFraction.y !== viewHeight / capacityHeight ||
        view.halfTexel.x !== 0.5 / capacityWidth ||
        view.halfTexel.y !== 0.5 / capacityHeight
      )
        throw new Error(`Resolution sub-rectangle transition failed at scale ${scale}.`);
    };

    for (const scale of [SCALE, 1, SCALE]) {
      controller.setScale(scale);
      controller.setSize(dimensions.width, dimensions.height);
      pipeline.render();
      assertTransition(scale);
    }

    return {
      render: () => pipeline.render(),
      detail: {
        capacity: [capacityWidth, capacityHeight],
        view: [quantize(dimensions.width * SCALE), quantize(dimensions.height * SCALE)],
        scale: SCALE,
        sampling: "viewFraction*screenUV-clamped-to-half-texel",
      },
    };
  });
}
