// Generated user source: the temporal resolve kernel. It allocates no target, applies no jitter and
// owns no loop. The default arm is what `temporalAA.ts` installs, so every published frame comes
// from this kernel; `temporalResolveMath.ts` and `temporalResolveDepth.ts` hold its equations.
// Derived resolve source: three/examples/jsm/tsl/display/TRAANode.js (pinned 0.185.1).
import type TRAANode from "three/addons/tsl/display/TRAANode.js";
import { Fn, add, float, int, luminance, max, mix, texture, uv } from "three/tsl";
import type { Node } from "three/webgpu";
import type { TemporalCurrentFootprint } from "./temporalCurrentFootprint.js";
import {
  type TemporalDepthRejection,
  type TemporalResolveNode,
  createTemporalDepthRejection,
} from "./temporalResolveDepth.js";
import {
  createTemporalResolveMath,
  reconstructNeighbourhood,
  sampleCatmullRom,
} from "./temporalResolveMath.js";

export { CATMULL_ROM_BASIS } from "./temporalResolveMath.js";

/** Returns the amount of subpixel (expressed within [0, 1]) in the velocity. */
const subpixelCorrection = Fn(([velocityUV, textureSize]: [Node<"vec2">, Node<"uvec2">]) => {
  const velocityTexel = velocityUV.mul(textureSize);
  const phase = velocityTexel.fract().abs();
  const weight = max(phase, phase.oneMinus());
  return weight.x.mul(weight.y).oneMinus().div(0.75);
}).setLayout({
  name: "subpixelCorrection",
  type: "float",
  inputs: [
    { name: "velocityUV", type: "vec2" },
    { name: "textureSize", type: "ivec2" },
  ],
});

/** Flicker reduction based on luminance weighing. */
const flickerReduction = Fn(
  ([currentColor, historyColor, currentWeight]: [Node<"vec4">, Node<"vec4">, Node<"float">]) => {
    const historyWeight = currentWeight.oneMinus();
    const compressedCurrent = currentColor.mul(
      float(1).div(max(currentColor.r, currentColor.g, currentColor.b).add(1)),
    );
    const compressedHistory = historyColor.mul(
      float(1).div(max(historyColor.r, historyColor.g, historyColor.b).add(1)),
    );
    const luminanceCurrent = luminance(compressedCurrent.rgb);
    const luminanceHistory = luminance(compressedHistory.rgb);
    currentWeight.mulAssign(float(1).div(luminanceCurrent.add(1)));
    historyWeight.mulAssign(float(1).div(luminanceHistory.add(1)));
    return add(currentColor.mul(currentWeight), historyColor.mul(historyWeight))
      .div(max(currentWeight.add(historyWeight), 0.00001))
      .toVar();
  },
);

/**
 * Build the resolve node. Reuse the installed node's depth/history uniforms and lifetime; replace
 * only its resolve.
 *
 * `interpolation` and `blend` are the comparison arms: linear against Catmull–Rom history sampling,
 * and luminance reweighting against an ordinary blend at the same weight. The default comparison keeps
 * upstream's luminance weighting; the provider selects ordinary linear-coverage blending.
 */
export function createExperimentalTemporalResolve(
  source: TRAANode,
  renderer: { reversedDepthBuffer: boolean; logarithmicDepthBuffer: boolean },
  jitterOffset: Node<"vec2">,
  interpolation: "linear" | "catmull-rom",
  blend: "luminance" | "ordinary" = "luminance",
  rejection: TemporalDepthRejection = createTemporalDepthRejection(
    source as TemporalResolveNode,
    renderer,
  ),
  current?: TemporalCurrentFootprint,
) {
  const node = source as TemporalResolveNode;
  const { historyValidity } = rejection;
  const { clipAABB } = createTemporalResolveMath(node);
  const historyNode = texture(node._historyRenderTarget.texture);

  const resolve = Fn(() => {
    const uvNode = uv();
    // Two rasters: colour, depth and velocity share the input one, resolve and history are display
    // sized. Every gather below reads the input lattice; the history sample stays a normalized UV,
    // and the motion weight and subpixel correction count display pixels.
    const inputSize = node.beautyNode.size(int(0)) as Node<"uvec2">;
    const displaySize = historyNode.size(int(0)) as Node<"uvec2">;
    const validity = historyValidity(uvNode);
    const hasValidHistory = validity.get("hasValidHistory") as Node<"float">;
    const historyUV = validity.get("historyUV") as Node<"vec2">;
    const offsetUV = validity.get("offsetUV") as Node<"vec2">;
    // Reconstruction: gather the current frame's 3×3 input neighbourhood around the jittered sample
    // the scene pass drew, and read its moments for the variance clip from the same taps. At a 1:1
    // raster the plain current sample is exact; retain it instead of adding Gaussian blur.
    const reconstruction =
      current?.reconstruct(uvNode, displaySize) ??
      reconstructNeighbourhood(node.beautyNode, uvNode, inputSize, jitterOffset, displaySize);
    const upsampled = inputSize.x.lessThan(displaySize.x).or(inputSize.y.lessThan(displaySize.y));
    const currentColor = upsampled.select(
      reconstruction.get("color") as Node<"vec4">,
      node.beautyNode.sample(uvNode),
    ) as Node<"vec4">;
    const mean = reconstruction.get("mean") as Node<"vec4">;
    const historyColor =
      interpolation === "linear"
        ? historyNode.sample(historyUV)
        : sampleCatmullRom(historyNode, historyUV).max(0);
    const motionFactor = uvNode
      .sub(historyUV)
      .mul(displaySize)
      .length()
      .div(node.maxVelocityLength)
      .saturate();
    const currentWeight = float(0.05).toVar(); // A minimum weight
    if (node.useSubpixelCorrection) {
      // Increase the minimum weight towards the current frame when the velocity is more subpixel.
      currentWeight.addAssign(subpixelCorrection(offsetUV, displaySize).mul(0.25));
    }
    currentWeight.assign(hasValidHistory.select(currentWeight.add(motionFactor).saturate(), 1));
    // Reasonable gamma range is [0.75, 2]
    const varianceGamma = mix(0.5, 1, motionFactor.oneMinus().pow2());
    const variance = (reconstruction.get("variance") as Node<"vec4">).mul(varianceGamma);
    const minColor = mean.sub(variance);
    const maxColor = mean.add(variance);
    const clippedHistoryColor = clipAABB(
      mean.clamp(minColor, maxColor),
      historyColor,
      minColor,
      maxColor,
    );
    // Every accepted history colour still passes the raw current-tap variance box.
    // Diagnostic only: ordinary blending isolates luminance reweighting at the same weight.
    return blend === "ordinary"
      ? mix(clippedHistoryColor, currentColor, currentWeight)
      : flickerReduction(currentColor, clippedHistoryColor, currentWeight);
  });
  return resolve();
}
