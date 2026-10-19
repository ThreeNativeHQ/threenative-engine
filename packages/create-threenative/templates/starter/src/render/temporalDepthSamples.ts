// Generated appearance source: matched input-sample coordinates and conservative depth support.
import { ivec2, max, vec2 } from "three/tsl";
import type { Node } from "three/webgpu";

/** Follow the same integer texel that textureLoad read into the previous jittered depth grid.
 * Velocity excludes jitter; reconstructed colour history stays on its unjittered display grid. */
export function temporalDepthHistoryUV(
  positionTexel: Node<"vec2">,
  inputSize: Node<"vec2"> | Node<"uvec2">,
  offsetUV: Node<"vec2">,
  currentJitterUV: Node<"vec2">,
  previousJitterUV: Node<"vec2">,
) {
  return vec2(ivec2(positionTexel))
    .add(0.5)
    .div(inputSize)
    .add(currentJitterUV)
    .sub(offsetUV)
    .sub(previousJitterUV);
}

/** Both points have rejection authority. Matching a surviving neighbor cannot legalize removed
 * colour at the centre; a clear centre cannot legalize an occluded selected surface either. */
export function temporalDepthHasDisocclusion(
  currentDepth: Node<"float">,
  previousCentreDepth: Node<"float">,
  previousPointDepth: Node<"float">,
  threshold: Node<"float"> | number,
) {
  return max(
    currentDepth.sub(previousCentreDepth),
    currentDepth.sub(previousPointDepth),
  ).greaterThan(threshold);
}
