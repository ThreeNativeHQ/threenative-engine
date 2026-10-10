import { DataTexture, FloatType, NearestFilter, RGBAFormat, RenderTarget } from "three";
import { texture } from "three/tsl";
import { NodeFrame, NodeMaterial, NodeUpdateType, QuadMesh, WebGPURenderer } from "three/webgpu";
import { AutoExposureNode, applyExposure } from "../../../template-assets/autoExposure.js";
import { exposureReductionSizes, exposureSettings } from "../../../template-assets/exposure.js";

interface IExposureDevice {
  pushErrorScope(filter: string): void;
  popErrorScope(): Promise<{ message: string } | null>;
  createBuffer(descriptor: { size: number; usage: number }): unknown;
}

export function exposurePixels(width: number, height: number) {
  const pixels = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = y === height - 1 ? 4 : x === width - 1 ? 1 : 2;
      pixels.set([value, value, value, 1], (y * width + x) * 4);
    }
  }
  // At 65x33, the 10/90 clip removes both aligned edge tails; only luminance 2 remains.
  return { pixels, expectedLuminance: 2 };
}

async function run() {
  const width = 65;
  const height = 33;
  const renderer = new WebGPURenderer();
  await renderer.init();
  const device = Reflect.get(renderer.backend, "device") as IExposureDevice;
  device.pushErrorScope("validation");
  renderer.setSize(width, height, false);
  const { pixels, expectedLuminance } = exposurePixels(width, height);
  const input = new DataTexture(pixels, width, height, RGBAFormat, FloatType);
  input.minFilter = input.magFilter = NearestFilter;
  input.needsUpdate = true;
  const colour = texture(input);
  const exposure = new AutoExposureNode(
    colour,
    {
      ...exposureSettings,
      enabled: true,
      snapGain: 0,
      reportInterval: 1e-6,
    },
    1,
  );
  exposure.updateBeforeType = NodeUpdateType.NONE;
  const output = new RenderTarget(width, height, { type: FloatType, depthBuffer: false });
  const material = new NodeMaterial();
  material.fragmentNode = applyExposure(colour, exposure.exposureNode);
  const quad = new QuadMesh(material);
  let observation: Record<string, unknown> = {};
  const frame = new NodeFrame();
  frame.renderer = renderer;
  frame.deltaTime = 1 / 60;
  for (let step = 1; step <= 120; step++) {
    frame.time = step / 60;
    exposure.updateBefore(frame);
    // Each step waits for the real asynchronous GPU report before advancing its fixed clock.
    await new Promise<void>((resolve, reject) => {
      let attempts = 0;
      const poll = () => {
        const next = exposure.getObservation();
        if (next.reason !== undefined) return reject(new Error(String(next.reason)));
        if (
          next.measured === true &&
          next !== observation &&
          next.exposureStops !== observation.exposureStops
        ) {
          observation = next;
          resolve();
        } else if (++attempts > 2000) reject(new Error("Exposure GPU report timed out"));
        else setTimeout(poll, 1);
      };
      poll();
    });
  }
  const luminance = Number(observation.luminance);
  const stops = Number(observation.exposureStops);
  const target = Math.log2(exposureSettings.key / expectedLuminance);
  if (
    !Number.isFinite(luminance) ||
    !Number.isFinite(stops) ||
    Math.abs(luminance - expectedLuminance) > 0.001 ||
    Math.abs(stops - target) > 0.01 ||
    observation.applied !== true
  )
    throw new Error(`Reduction/adaptation mismatch: ${JSON.stringify(observation)}`);
  renderer.setRenderTarget(output);
  quad.render(renderer);
  const applied = await renderer.readRenderTargetPixelsAsync(output, 32, 16, 1, 1);
  if (
    !(applied instanceof Float32Array) ||
    !Number.isFinite(applied[0]) ||
    Math.abs((applied[0] ?? Number.NaN) - 2 * 2 ** stops) > 0.001
  )
    throw new Error(`Applied exposure mismatch: ${String(applied)}`);
  if (Reflect.get(globalThis, "__tnInjectValidation") === true)
    device.createBuffer({ size: 4, usage: 0 });
  const validation = await device.popErrorScope();
  if (validation !== null) throw new Error(`GPU validation: ${validation.message}`);
  console.info(
    `TN_NATIVE_EXPOSURE:${JSON.stringify({ sizes: exposureReductionSizes(width, height), steps: 120, luminance, expectedLuminance, stops, target, applied: applied[0] })}`,
  );
  material.dispose();
  output.dispose();
  exposure.dispose();
  input.dispose();
  renderer.dispose();
  Reflect.set(globalThis, "__tnExposureDone", true);
}
export default {
  start: () =>
    run().catch((error: unknown) => {
      Reflect.set(globalThis, "__tnExposureError", String(error));
    }),
};
