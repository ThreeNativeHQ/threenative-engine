// Generated user source: history sampling and neighbourhood clipping for the temporal kernel.
// Split out of `temporalResolve.ts` so each file stays readable; the equations are unchanged.
// Derived resolve source: three/examples/jsm/tsl/display/TRAANode.js (pinned 0.185.1).
/*
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/
import { Fn, float, int, ivec2, max, struct, vec2, vec4 } from "three/tsl";
import type { Node, TextureNode } from "three/webgpu";
import type { TemporalResolveNode } from "./temporalResolveDepth.js";

// Polynomial coefficients, ascending power, for samples at -1, 0, 1 and 2.
export const CATMULL_ROM_BASIS = [
  [0, -0.5, 1, -0.5],
  [1, 0, -2.5, 1.5],
  [0, 0.5, 2, -1.5],
  [0, 0, -0.5, 0.5],
] as const;

/** Nine bilinear taps reproduce the separable sixteen-tap Catmull–Rom kernel. */
export function sampleCatmullRom(source: TextureNode, coordinate: Node<"vec2">) {
  return Fn(() => {
    const size = vec2(source.size(int(0)) as Node<"uvec2">);
    const position = coordinate.mul(size).sub(0.5);
    const centre = position.floor().add(0.5);
    const phase = position.fract();
    const polynomial = (row: readonly [number, number, number, number]) =>
      phase.mul(row[3]).add(row[2]).mul(phase).add(row[1]).mul(phase).add(row[0]);
    const w0 = polynomial(CATMULL_ROM_BASIS[0]);
    const w1 = polynomial(CATMULL_ROM_BASIS[1]);
    const w2 = polynomial(CATMULL_ROM_BASIS[2]);
    const w3 = polynomial(CATMULL_ROM_BASIS[3]);
    const middle = w1.add(w2);
    const p0 = centre.sub(1).div(size);
    const p12 = centre.add(w2.div(middle)).div(size);
    const p3 = centre.add(2).div(size);
    const result = vec4(0).toVar();
    const xs = [
      [p0.x, w0.x],
      [p12.x, middle.x],
      [p3.x, w3.x],
    ] as const;
    const ys = [
      [p0.y, w0.y],
      [p12.y, middle.y],
      [p3.y, w3.y],
    ] as const;
    for (const [x, wx] of xs)
      for (const [y, wy] of ys) result.addAssign(source.sample(vec2(x, y)).mul(wx).mul(wy));
    return result;
  })();
}

const reconstructionStruct = struct({
  color: "vec4",
  mean: "vec4",
  variance: "vec4",
});

/** Gaussian reconstruction on reduced axes at the samples' jittered centres. Native axes retain
 * their owned point; all nine raw taps still supply the unchanged clipping moments. Omitting
 * displaySize retains the original two-axis filter for existing helper calls. */
export function reconstructNeighbourhood(
  source: TextureNode,
  uvNode: Node<"vec2">,
  inputSize: Node<"uvec2">,
  jitterOffset: Node<"vec2">,
  displaySize?: Node<"uvec2">,
) {
  const inputSizeF = vec2(inputSize);
  const pIn = uvNode.mul(inputSizeF);
  const closestTap = ivec2(pIn.sub(vec2(0.5).add(jitterOffset)).round());
  const offsets = [-1, 0, 1].flatMap((y) => [-1, 0, 1].map((x) => [x, y] as const));
  const nativeAxes = displaySize === undefined ? undefined : inputSizeF.equal(vec2(displaySize));
  const sumColor = vec4(0).toVar();
  const sumWeight = float(0).toVar();
  const moment1 = vec4(0).toVar();
  const moment2 = vec4(0).toVar();
  for (const [x, y] of offsets) {
    const tap = closestTap.add(ivec2(x, y));
    const tapCenter = vec2(tap).add(vec2(0.5).add(jitterOffset));
    const delta = pIn.sub(tapCenter);
    const weight = delta
      .dot(delta)
      .mul(-2.29)
      .exp()
      .mul(x === 0 ? 1 : (nativeAxes?.x.select(0, 1) ?? 1))
      .mul(y === 0 ? 1 : (nativeAxes?.y.select(0, 1) ?? 1));
    // Use max() to prevent NaN values from propagating.
    // Match the colour sampler's clamp-to-edge support.
    const boundedTap = ivec2(vec2(tap).clamp(vec2(0), vec2(inputSize).sub(1)));
    const sample = source.load(boundedTap).max(0);
    sumColor.addAssign(sample.mul(weight));
    sumWeight.addAssign(weight);
    moment1.addAssign(sample);
    moment2.addAssign(sample.pow2());
  }
  const N = float(offsets.length);
  const mean = moment1.div(N);
  const variance = moment2.div(N).sub(mean.pow2()).max(0).sqrt();
  return reconstructionStruct(sumColor.div(sumWeight.max(1e-6)), mean, variance);
}

/**
 * Variance clipping over the current frame's neighbourhood.
 *
 * The neighbourhood offsets are in input texels, which is what `positionTexel` already carries, so
 * this reads the same pixels at full resolution and at a lower input raster.
 */
export function createTemporalResolveMath(node: TemporalResolveNode) {
  // Optimized version of AABB clipping.
  // Reference: https://github.com/playdeadgames/temporal
  const clipAABB = Fn(
    ([currentColor, historyColor, minColor, maxColor]: [
      Node<"vec4">,
      Node<"vec4">,
      Node<"vec4">,
      Node<"vec4">,
    ]) => {
      const pClip = maxColor.rgb.add(minColor.rgb).mul(0.5);
      const eClip = maxColor.rgb.sub(minColor.rgb).mul(0.5).add(1e-7);
      const vClip = historyColor.sub(vec4(pClip, currentColor.a));
      const vUnit = vClip.xyz.div(eClip);
      const absUnit = vUnit.abs();
      const maxUnit = max(absUnit.x, absUnit.y, absUnit.z);
      return maxUnit
        .greaterThan(1)
        .select(vec4(pClip, currentColor.a).add(vClip.div(maxUnit)), historyColor);
    },
  ).setLayout({
    name: "clipAABB",
    type: "vec4",
    inputs: [
      { name: "currentColor", type: "vec4" },
      { name: "historyColor", type: "vec4" },
      { name: "minColor", type: "vec4" },
      { name: "maxColor", type: "vec4" },
    ],
  });
  // Performs variance clipping.
  // See: https://developer.download.nvidia.com/gameworks/events/GDC2016/msalvi_temporal_supersampling.pdf
  return {
    clipAABB,
    varianceClipping: Fn(
      ([positionTexel, historyColor, gamma]: [Node<"vec2">, Node<"vec4">, Node<"float">]) => {
        const offsets = [
          [-1, -1],
          [-1, 1],
          [1, -1],
          [1, 1],
          [1, 0],
          [0, -1],
          [0, 1],
          [-1, 0],
        ];
        // Moments describe nine equally weighted input texels. The displayed current colour may
        // be filtered between them, so using it as the centre would change this population with
        // display-pixel phase and clip valid history below the input neighbourhood's bound.
        const centre = node.beautyNode.load(positionTexel).max(0);
        const moment1 = centre.toVar();
        const moment2 = centre.pow2().toVar();
        for (const [x, y] of offsets) {
          // Use max() to prevent NaN values from propagating.
          const neighbor = node.beautyNode.offset(ivec2(x, y)).load(positionTexel).max(0);
          moment1.addAssign(neighbor);
          moment2.addAssign(neighbor.pow2());
        }
        const N = float(offsets.length + 1);
        const mean = moment1.div(N);
        const variance = moment2.div(N).sub(mean.pow2()).max(0).sqrt().mul(gamma);
        const minColor = mean.sub(variance);
        const maxColor = mean.add(variance);
        return clipAABB(mean.clamp(minColor, maxColor), historyColor, minColor, maxColor);
      },
    ),
  };
}
