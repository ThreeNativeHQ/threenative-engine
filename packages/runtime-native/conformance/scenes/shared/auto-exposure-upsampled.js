import * as THREE from "three/webgpu";
import { pass, texture, vec4 } from "three/tsl";
import { AutoExposureNode } from "../../../../core/src/look/auto-exposure.ts";
import { exposureSettings } from "../../../../core/src/look/exposure-settings.ts";
import { startVisualScene } from "./scene-support.js";

export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "auto-exposure-scaled-input", ({ renderer, scene, camera }) => {
    pass(scene, camera);
    const scale = renderer.info.engine === undefined ? 1 : 0.72;
    const width = Math.round(dimensions.width * scale);
    const height = Math.round(dimensions.height * scale);
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        pixels.fill(x < width / 2 ? 5 : 64, offset, offset + 3);
        pixels[offset + 3] = 255;
      }
    }
    const source = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    source.colorSpace = THREE.NoColorSpace;
    source.needsUpdate = true;
    const colour = texture(source);
    const meter = new AutoExposureNode(colour, exposureSettings, 1);
    meter.reset();
    const pipeline = new THREE.RenderPipeline(renderer);
    pipeline.outputNode = vec4(colour.rgb.mul(meter.exposureNode), 1);
    return { detail: { inputSize: [width, height] }, render: () => pipeline.render() };
  });
}
