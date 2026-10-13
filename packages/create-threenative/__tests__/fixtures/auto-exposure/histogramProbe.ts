import { DataTexture, FloatType, NearestFilter, RGBAFormat } from "three";
import { texture, uniform } from "three/tsl";
import { NodeMaterial, QuadMesh, WebGPURenderer } from "three/webgpu";
import { exposureSettings } from "../../../template-assets/exposure.js";
import {
  adaptExposure,
  exposureBins,
  exposureTarget,
} from "../../../template-assets/exposureGraph.js";
import { histogramCases } from "./histogramReference.js";

/**
 * Runs the shipped adaptation shader on each synthetic histogram and reports what it metered.
 * With the seed reset mode the goal is reached at once, so the luminance output is the walk.
 */
export async function runHistogramProbe(): Promise<void> {
  const renderer = new WebGPURenderer({ antialias: false });
  await renderer.init();
  const target = exposureTarget();
  const quad = new QuadMesh();
  const previous = new DataTexture(new Float32Array(4), 1, 1, RGBAFormat, FloatType);
  previous.needsUpdate = true;
  const results: { name: string; luminance: number; goal: number }[] = [];
  for (const { name, bins, lowPercent, highPercent } of histogramCases) {
    const data = new Float32Array(exposureBins * 4);
    for (const [i, bin] of bins.entries()) {
      data[i * 4] = bin.weight;
      data[i * 4 + 1] = bin.logSum;
    }
    const histogram = new DataTexture(data, exposureBins, 1, RGBAFormat, FloatType);
    histogram.minFilter = NearestFilter;
    histogram.magFilter = NearestFilter;
    histogram.needsUpdate = true;
    const material = new NodeMaterial();
    material.fragmentNode = adaptExposure(
      texture(histogram),
      texture(previous),
      uniform(2),
      uniform(0),
      uniform(0.016),
      { ...exposureSettings, lowPercent, highPercent },
      (mean) => mean,
    );
    quad.material = material;
    renderer.setRenderTarget(target);
    quad.render(renderer);
    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
    if (!(pixels instanceof Float32Array)) throw new Error("Histogram probe readback failed.");
    results.push({ name, luminance: pixels[1] ?? Number.NaN, goal: pixels[2] ?? Number.NaN });
    material.dispose();
    histogram.dispose();
  }
  console.info(`TN_EXPOSURE_HISTOGRAM:${JSON.stringify(results)}`);
}
