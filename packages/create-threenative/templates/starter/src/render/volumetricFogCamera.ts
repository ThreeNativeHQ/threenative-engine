// The scene camera as the fog reads it each frame, and the two reads of the depth buffer built on it.
import { float } from "three/tsl";
import type { Node } from "three/webgpu";

/**
 * The scene camera as vectors the fog reads each frame: its axes, half the view's tangent in x and y, and the clip
 * distances. The owned engine's TSL follows a vector uniform edited in place, where a matrix built from four
 * columns did not follow the camera's pose (the fog drew black on the Wasm engine).
 */
export interface IFogCamera {
  right: Node<"vec3">;
  up: Node<"vec3">;
  back: Node<"vec3">;
  /** x: 1 / projection[0][0], y: 1 / projection[1][1]. */
  lens: Node<"vec3">;
  /** x: near, y: far. */
  clip: Node<"vec3">;
}

/** Distance along the view axis of a depth-buffer value (0 at the near plane, 1 at the far plane). */
export function viewDepth(depth: Node<"float">, camera: IFogCamera): Node<"float"> {
  const { clip } = camera;
  return clip.x.mul(clip.y).div(clip.y.sub(depth.mul(clip.y.sub(clip.x))));
}

/** A world-space ray through a screen position, with 1 along the view axis: a surface is origin + ray * viewDepth. */
export function screenRay(uv: Node<"vec2">, camera: IFogCamera): Node<"vec3"> {
  return camera.right
    .mul(uv.x.mul(2).sub(1).mul(camera.lens.x))
    .add(camera.up.mul(float(1).sub(uv.y.mul(2)).mul(camera.lens.y)))
    .sub(camera.back);
}
