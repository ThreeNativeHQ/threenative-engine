import { dot, float, screenSize, uv, vec2 } from "three/tsl";
import type { Node } from "three/webgpu";

/** The mask multiplying the linear frame, from the drawing buffer's own aspect ratio. */
export function vignetteMask(intensity: number): Node<"float"> {
  const aspect = screenSize.y.div(screenSize.x);
  const lens = uv()
    .sub(0.5)
    .mul(2)
    .mul(vec2(1, aspect))
    .mul(float(2).sqrt().div(aspect.mul(aspect).add(1).sqrt()))
    .mul(intensity);
  return float(1).div(dot(lens, lens).add(1).pow(2));
}
