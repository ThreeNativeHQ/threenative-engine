// Generated for you: Unreal's vignette; the look is the intensity in quality.ts.
//
// The model is Unreal Engine 5.8.3's default `CosineFourthLaw` vignette:
//   Engine/Source/Runtime/Engine/Private/Scene.cpp (VignetteIntensity 0.4, VignetteType),
//   Engine/Shaders/Private/PostProcessCommon.ush (VignetteSpace: the lens position is scaled so the
//     corner lies on a circle of radius sqrt 2 at any aspect ratio; ComputeVignetteMask: the weight is
//     1 / (1 + (intensity * r)^2)^2),
//   Engine/Shaders/Private/PostProcessTonemap.usf (the mask multiplies the exposed scene and the bloom).
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
