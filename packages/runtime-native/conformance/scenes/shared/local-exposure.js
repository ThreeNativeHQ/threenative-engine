import * as THREE from "three/webgpu";
import { float, pass, vec4 } from "three/tsl";
import { LocalExposureNode } from "../../../../create-threenative/templates/starter/src/render/localExposure.ts";
import { UnrealBloomNode } from "../../../../create-threenative/templates/starter/src/render/unrealBloom.ts";
import { startVisualScene } from "./scene-support.js";

/**
 * PRD-636: the two finishing stages a fresh Unreal project adds that no other row carries, on the
 * host as well as the browser. Local exposure is a bilateral grid of log luminance read back as a
 * per pixel gain, and the Unreal bloom is a downsample chain feeding six Gaussians through a wide
 * float loop. Both are generated template source, so a host that drops a pass or a float target
 * leaves a game broken where it ships.
 *
 * The frame is built so that a stage that silently does nothing on the host cannot match the
 * browser: a nearly black half and a bright half, the same mid grey card in each (local exposure
 * moves the two cards by different amounts), and a small lamp in the dark half (the bloom halo).
 */

const EXPOSURE = 0.5;

function patch(scene, color, width, height, x, y) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(color, color, color) }),
  );
  mesh.position.set(x, y, 0);
  scene.add(mesh);
}

export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "local-exposure", ({ renderer, scene, camera }) => {
    patch(scene, 0.004, 4, 3.6, -2, 0);
    patch(scene, 3, 4, 3.6, 2, 0);
    patch(scene, 0.18, 0.7, 0.7, -1.1, -0.7);
    patch(scene, 0.18, 0.7, 0.7, 1.1, -0.7);
    patch(scene, 30, 0.22, 0.22, -1.1, 0.7);

    const colour = pass(scene, camera).getTextureNode("output");
    const exposure = float(EXPOSURE);
    const localExposure = new LocalExposureNode(colour, exposure);
    const bloom = new UnrealBloomNode(colour);
    const pipeline = new THREE.RenderPipeline(renderer);
    pipeline.outputNode = vec4(
      colour.rgb.add(bloom.bloomNode).mul(exposure).mul(localExposure.gainNode),
      1,
    );
    return {
      detail: { exposure: EXPOSURE, stages: ["local-exposure", "unreal-bloom"] },
      render: () => {
        pipeline.render();
      },
    };
  });
}
