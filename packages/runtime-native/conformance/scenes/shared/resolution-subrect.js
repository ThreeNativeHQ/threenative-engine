import * as THREE from "three/webgpu";
import { clamp, pass, screenUV, uniform } from "three/tsl";
import { startVisualScene } from "./scene-support.js";

const SCALE = 0.72;

export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "resolution-subrect", ({ renderer, scene, camera }) => {
    const subject = new THREE.Mesh(
      new THREE.TorusKnotGeometry(0.62, 0.19, 96, 20),
      new THREE.MeshBasicNodeMaterial({ color: 0x38bdf8 }),
    );
    subject.rotation.set(0.3, 0.4, 0.1);
    scene.add(subject);

    const capacityWidth = dimensions.width;
    const capacityHeight = dimensions.height;
    const viewWidth = Math.ceil((capacityWidth * SCALE) / 8) * 8;
    const viewHeight = Math.ceil((capacityHeight * SCALE) / 8) * 8;
    const scenePass = pass(scene, camera);
    scenePass.setSize(capacityWidth, capacityHeight);
    scenePass.setViewport(0, 0, viewWidth, viewHeight);
    scenePass.setScissor(0, 0, viewWidth, viewHeight);

    const viewFraction = uniform(new THREE.Vector2(viewWidth / capacityWidth, viewHeight / capacityHeight));
    const halfTexel = uniform(new THREE.Vector2(0.5 / capacityWidth, 0.5 / capacityHeight));
    const uvNode = clamp(
      screenUV.mul(viewFraction),
      halfTexel,
      viewFraction.sub(halfTexel),
    );
    const pipeline = new THREE.RenderPipeline(renderer);
    pipeline.outputNode = scenePass.getTextureNode("output").sample(uvNode);
    pipeline.render();

    if (
      scenePass.renderTarget.width !== capacityWidth ||
      scenePass.renderTarget.height !== capacityHeight ||
      scenePass.renderTarget.viewport.z !== viewWidth ||
      scenePass.renderTarget.viewport.w !== viewHeight ||
      scenePass.renderTarget.scissor.z !== viewWidth ||
      scenePass.renderTarget.scissor.w !== viewHeight
    )
      throw new Error("Resolution sub-rectangle did not retain the full target capacity.");
    return {
      render: () => pipeline.render(),
      detail: {
        capacity: [capacityWidth, capacityHeight],
        view: [viewWidth, viewHeight],
        scale: SCALE,
        sampling: "viewFraction*screenUV-clamped-to-half-texel",
      },
    };
  });
}
