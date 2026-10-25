import * as THREE from "three/webgpu";
import { float, pass, texture, vec4 } from "three/tsl";
import { AutoExposureNode } from "../../../../core/src/look/auto-exposure.ts";
import { exposureSettings } from "../../../../core/src/look/exposure-settings.ts";
import { LocalExposureNode } from "../../../../core/src/look/local-exposure.ts";
import { UnrealBloomNode } from "../../../../core/src/look/unreal-bloom.ts";
import { startVisualScene } from "./scene-support.js";

/**
 * PRD-636: the two finishing stages a fresh Unreal project adds that no other row carries, on the
 * host as well as the browser. Local exposure is a bilateral grid of log luminance read back as a
 * per pixel gain, and the Unreal bloom is a downsample chain feeding six Gaussians through a wide
 * float loop. Both ship in core, so a host that drops a pass or a float target
 * leaves a game broken where it ships.
 *
 * The frame is built so that a stage that silently does nothing on the host cannot match the
 * browser: a nearly black half and a bright half, the same mid grey card in each (local exposure
 * moves the two cards by different amounts), and a small lamp in the dark half (the bloom halo).
 */

const EXPOSURE = 0.5;
const METER_LUMINANCE = 46 / 255;
const METER_STOPS = Math.log2(exposureSettings.key / METER_LUMINANCE);

function patch(scene, color, width, height, x, y) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(color, color, color) }),
  );
  mesh.position.set(x, y, 0);
  scene.add(mesh);
}

export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "local-exposure", async ({ renderer, scene, camera }) => {
    patch(scene, 0.004, 4, 3.6, -2, 0);
    patch(scene, 3, 4, 3.6, 2, 0);
    patch(scene, 0.18, 0.7, 0.7, -1.1, -0.7);
    patch(scene, 0.18, 0.7, 0.7, 1.1, -0.7);
    patch(scene, 30, 0.22, 0.22, -1.1, 0.7);

    const colour = pass(scene, camera).getTextureNode("output");
    const exposure = float(EXPOSURE);
    const localExposure = new LocalExposureNode(colour, exposure);
    const bloom = new UnrealBloomNode(colour);
    const meterSize = renderer.getDrawingBufferSize(new THREE.Vector2());
    const meterPixels = new Uint8Array(meterSize.x * meterSize.y * 4);
    for (let i = 0; i < meterPixels.length; i += 4) meterPixels.set([46, 46, 46, 255], i);
    const meterInput = new THREE.DataTexture(meterPixels, meterSize.x, meterSize.y, THREE.RGBAFormat, THREE.UnsignedByteType);
    meterInput.colorSpace = THREE.NoColorSpace;
    meterInput.needsUpdate = true;
    const meter = new AutoExposureNode(texture(meterInput), exposureSettings, 1);
    meter.reset();
    const pipeline = new THREE.RenderPipeline(renderer);
    pipeline.outputNode = vec4(
      colour.rgb.add(bloom.bloomNode).mul(exposure).mul(localExposure.gainNode).mul(meter.exposureNode.div(2 ** METER_STOPS)),
      1,
    );
    let observation = meter.getObservation();
    while (observation.measured !== true) {
      pipeline.render();
      await new Promise(requestAnimationFrame);
      observation = meter.getObservation();
      if (observation.reason !== undefined) throw new Error(`Auto exposure readback failed: ${observation.reason}`);
    }
    if (observation.applied !== true || observation.settled !== true ||
      Math.abs(observation.luminance - METER_LUMINANCE) > 0.005 ||
      Math.abs(observation.exposureStops - METER_STOPS) > 0.03 || Math.abs(observation.targetStops - METER_STOPS) > 0.03)
      throw new Error(`Auto exposure known-target mismatch: ${JSON.stringify(observation)}`);
    return {
      detail: { exposure: EXPOSURE, meter: observation, stages: ["auto-exposure", "local-exposure", "unreal-bloom"] },
      render: () => {
        pipeline.render();
      },
    };
  });
}
