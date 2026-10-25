import * as THREE from "three/webgpu";
import { pass, vec4 } from "three/tsl";
import { AutoExposureNode } from "../../../../core/src/look/auto-exposure.ts";
import { exposureSettings } from "../../../../core/src/look/exposure-settings.ts";
import { startVisualScene } from "./scene-support.js";

/**
 * PRD-732 AC-9: core's metered AutoExposureNode on the host as well as the browser. The meter is
 * live render targets (a luminance reduction chain, a histogram, a ping-pong adaptation texture)
 * and swaps each target's texture every frame, so a host that drops a boolean uniform, a texture
 * swap or a float render target leaves every kit that takes core's look unable to start.
 *
 * The frame is half near black and half bright, so the meter's answer is far from the seed
 * exposure of 1 and a host that never measures cannot match the browser. `reset()` adopts the
 * first measured target, which makes the settled value independent of the frame clock.
 */

function patch(scene, color, width, height, x, y) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(color, color, color) }),
  );
  mesh.position.set(x, y, 0);
  scene.add(mesh);
}

export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "auto-exposure", ({ renderer, scene, camera }) => {
    patch(scene, 0.02, 4, 3.6, -2, 0);
    patch(scene, 0.25, 4, 3.6, 2, 0);
    patch(scene, 0.18, 0.7, 0.7, -1.1, -0.7);
    patch(scene, 0.18, 0.7, 0.7, 1.1, -0.7);

    const colour = pass(scene, camera).getTextureNode("output");
    const meter = new AutoExposureNode(colour, exposureSettings, 1);
    meter.reset();
    const pipeline = new THREE.RenderPipeline(renderer);
    pipeline.outputNode = vec4(colour.rgb.mul(meter.exposureNode), 1);
    return {
      detail: { stages: ["auto-exposure"] },
      render: () => {
        pipeline.render();
      },
    };
  });
}
