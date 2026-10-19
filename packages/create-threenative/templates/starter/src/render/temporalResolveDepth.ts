// Generated user source: the temporal kernel's depth rejection. Split out of `temporalResolve.ts`
// so each file stays readable; the equations are unchanged.
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
import type { Matrix4, OrthographicCamera, Vector2 } from "three";
import type TRAANode from "three/addons/tsl/display/TRAANode.js";
import {
  Fn,
  If,
  float,
  getViewPosition,
  int,
  ivec2,
  logarithmicDepthToViewZ,
  struct,
  texture,
  vec2,
  vec4,
  viewZToOrthographicDepth,
  viewZToPerspectiveDepth,
} from "three/tsl";
import type { Node, RenderTarget, TextureNode } from "three/webgpu";
export type { ITemporalAANode } from "./temporalAAHooks.js";
export { guardTemporalAASeams } from "./temporalAAHooks.js";
import { temporalDepthHasDisocclusion, temporalDepthHistoryUV } from "./temporalDepthSamples.js";

/** A TSL uniform node: the shader reads it as a node, this reconstruction writes its value. */
export interface ITemporalUniform<T> {
  value: T;
}

/**
 * The pinned TRAANode seams this reconstruction reads.
 *
 * Declared here, beside its first reader, so `temporalAA.ts` and `temporalAAFrame.ts` name the
 * same shape — and so a three.js version that drops one of them fails the seam guard in
 * `temporalAA.ts` rather than reading `undefined` on a GPU.
 */
export interface ITemporalResolvePinned {
  _historyRenderTarget: RenderTarget;
  _resolveRenderTarget: RenderTarget;
  _previousDepthNode: TextureNode;
  _cameraNearFar: Node<"vec2"> & ITemporalUniform<Vector2>;
  _cameraWorldMatrix: Node<"mat4"> & ITemporalUniform<Matrix4>;
  _cameraWorldMatrixInverse: Node<"mat4"> & ITemporalUniform<Matrix4>;
  _cameraProjectionMatrixInverse: Node<"mat4"> & ITemporalUniform<Matrix4>;
  _previousCameraWorldMatrix: Node<"mat4"> & ITemporalUniform<Matrix4>;
  _previousCameraProjectionMatrixInverse: Node<"mat4"> & ITemporalUniform<Matrix4>;
  /** Installed by `createTemporalAA`. 0 on a reset frame, which then weights current colour only. */
  _historyValidUniform?: ITemporalUniform<number>;
  /** Input-pixel jitter for current-frame reconstruction, captured beside the depth matrices. */
  _reconstructionJitterOffset?: Node<"vec2"> & ITemporalUniform<Vector2>;
  /** Actual input jitter, in input-raster UVs, captured beside the matching depth matrices. */
  _currentJitterUV?: Node<"vec2"> & ITemporalUniform<Vector2>;
  _previousJitterUV?: Node<"vec2"> & ITemporalUniform<Vector2>;
}

export type TemporalResolveNode = TRAANode & ITemporalResolvePinned;

/** The 3×3 neighbourhood depth test that decides whether last frame's colour is still legal. */
export function createTemporalDepthRejection(
  node: TemporalResolveNode,
  renderer: { reversedDepthBuffer: boolean; logarithmicDepthBuffer: boolean },
) {
  const toPerspectiveDepth = (depth: Node<"float">) => {
    const { x: near, y: far } = node._cameraNearFar;
    return viewZToPerspectiveDepth(logarithmicDepthToViewZ(depth, near, far), near, far);
  };
  const currentDepthStruct = struct({
    closestDepth: "float",
    closestPositionTexel: "vec2",
  });
  // Samples 3×3 neighborhood pixels and returns the closest depth and its texel.
  const currentDepth = Fn(([positionTexel]: [Node<"vec2">]) => {
    const inputSize = vec2(node.depthNode.size(int(0)) as Node<"uvec2">);
    const closestDepth = float(2).toVar();
    const closestPositionTexel = vec2(0).toVar();
    for (let x = -1; x <= 1; ++x)
      for (let y = -1; y <= 1; ++y) {
        const neighbor = vec2(ivec2(positionTexel.add(vec2(x, y))))
          .clamp(vec2(0), inputSize.sub(1))
          .toVar();
        let depth = node.depthNode.load(neighbor).r;
        if (renderer.reversedDepthBuffer) depth = depth.oneMinus();
        if (renderer.logarithmicDepthBuffer) depth = toPerspectiveDepth(depth);
        depth = depth.toVar();
        If(depth.lessThan(closestDepth), () => {
          closestDepth.assign(depth);
          closestPositionTexel.assign(neighbor);
        });
      }
    return currentDepthStruct(closestDepth, closestPositionTexel);
  });
  // Samples a previous depth and reprojects it using the current camera matrices. The mip is named
  // because the rejection counter reads this from a compute dispatch, where WGSL has no implicit
  // derivatives to sample with; the depth history carries one mip, so the resolved value is the one
  // the resolve fragment reads.
  const previousDepth = (historyUV: Node<"vec2">) => {
    let depth = texture(node._previousDepthNode, historyUV).level(int(0)).r;
    if (renderer.logarithmicDepthBuffer) depth = toPerspectiveDepth(depth);
    const positionView = getViewPosition(
      historyUV,
      depth,
      node._previousCameraProjectionMatrixInverse,
    );
    const positionWorld = node._previousCameraWorldMatrix.mul(vec4(positionView, 1)).xyz;
    const viewZ = node._cameraWorldMatrixInverse.mul(vec4(positionWorld, 1)).z;
    const { x: near, y: far } = node._cameraNearFar;
    return (node.camera as OrthographicCamera).isOrthographicCamera
      ? viewZToOrthographicDepth(viewZ, near, far)
      : viewZToPerspectiveDepth(viewZ, near, far);
  };
  const historyValidityStruct = struct({
    hasValidHistory: "float",
    historyUV: "vec2",
    offsetUV: "vec2",
  });
  // Absent on a standalone node, which then keeps upstream's own history reuse unchanged.
  const historyValid = (node._historyValidUniform ?? float(1)) as Node<"float">;
  /**
   * The one history-validity decision, parameterised by the pixel's own UV: `historyValid ∧ validUV
   * ∧ ¬disocclusion`. The resolve weights its blend with this, and the rejection counter calls the
   * same node once per display pixel, so a reported fraction cannot diverge from the decision that
   * was drawn.
   *
   * Upstream also ORs in a depth-edge bypass (`farthestDepth − closestDepth > edgeDepthDiff`).
   * PRD-455 holds the paired policy ablation: with that term off the measured reveal residue falls
   * while edge error, instability and excursion each move by under 0.0001, which supports the term
   * as the residue's cause.
   */
  const historyValidity = Fn(([pixelUV]: [Node<"vec2">]) => {
    const inputSize = node.beautyNode.size(int(0)) as Node<"uvec2">;
    const sampled = currentDepth(pixelUV.mul(inputSize));
    const closestDepth = sampled.get("closestDepth") as Node<"float">;
    const closestPositionTexel = sampled.get("closestPositionTexel") as Node<"vec2">;
    const offsetUV = node.velocityNode.load(closestPositionTexel).xy.mul(vec2(0.5, -0.5));
    const historyUV = pixelUV.sub(offsetUV);
    const sampledPreviousDepth = previousDepth(historyUV);
    let isValidUV = historyUV.greaterThanEqual(0).all().and(historyUV.lessThanEqual(1).all());
    let isDisocclusion = closestDepth.sub(sampledPreviousDepth).greaterThan(node.depthThreshold);
    if (node._currentJitterUV !== undefined && node._previousJitterUV !== undefined) {
      // The conservative centre test remains intact. Also validate the actual closest texel whose
      // velocity we used: previous depth is input sized and jittered, colour history is neither.
      const depthHistoryUV = temporalDepthHistoryUV(
        closestPositionTexel,
        inputSize,
        offsetUV,
        node._currentJitterUV,
        node._previousJitterUV,
      );
      const pointInBounds = depthHistoryUV
        .greaterThanEqual(0)
        .all()
        .and(depthHistoryUV.lessThan(1).all());
      isValidUV = isValidUV.and(pointInBounds);
      isDisocclusion = temporalDepthHasDisocclusion(
        closestDepth,
        sampledPreviousDepth,
        previousDepth(depthHistoryUV),
        node.depthThreshold,
      );
    }
    // A reset frame has no legal cross-size colour seed, so it weights only the current frame.
    const hasValidHistory = historyValid.greaterThan(0.5).and(isValidUV.and(isDisocclusion.not()));
    return historyValidityStruct(hasValidHistory, historyUV, offsetUV);
  });
  return { currentDepth, previousDepth, historyValidity };
}

/** The depth-rejection equations one shared instance of, so no two callers can disagree. */
export type TemporalDepthRejection = ReturnType<typeof createTemporalDepthRejection>;
