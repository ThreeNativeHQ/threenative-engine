// Unreal draws the scene behind a translucent surface through a screen-space distortion pass (UE 5.8.3:
// Engine/Shaders/Private/DistortAccumulatePS.usf, DistortionCommon.ush, DistortApplyScreenPS.usf). The glTF proxy material
// (GLTFExporter/Materials/Proxy/M_GLTF_Default) sets the refraction mode Index Of Refraction, so every translucent
// surface moves the picture behind it by its view-space normal times (IOR - 1), whatever it is lit by. A pane seen head
// on moves nothing. A pane seen at an angle moves the scene several percent of the screen width, and a pixel whose
// shifted sample is not behind the pane keeps its own place.
import { type Box3, type PerspectiveCamera, Vector3 } from "three";
import {
  Fn,
  If,
  float,
  max,
  min,
  type pass,
  screenUV,
  step,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Node } from "three/webgpu";

type ScenePass = ReturnType<typeof pass>;

/** The glTF default index of refraction: the proxy's Refraction input when a material names none. */
export const GLTF_IOR = 1.5;

/**
 * Screen units of offset per unit of view-space normal (DistortionCommon.ush, ComputeBufferUVDistortion): (IOR - 1) times
 * the view width in pixels times Unreal's 0.00023 fudge factor times 1 / tan(half the horizontal field of view).
 */
export function refractionGain(ior: number, widthPixels: number, projectionXx: number): number {
  return (ior - 1) * widthPixels * 0.00023 * projectionXx;
}

/**
 * The scene colour with the picture behind each box refracted. A camera ray meets the box analytically, so the box needs no
 * depth or mask of its own: the box draws no depth (a blended surface), and its front face and normal come from the slab
 * test. A pixel takes the colour at its shifted place only when that place is behind the box (Unreal clears the
 * offset where it is not, over one centimetre of depth), and the shift never leaves the screen.
 */
export function refractBehind(
  scenePass: ScenePass,
  camera: PerspectiveCamera,
  boxes: readonly Box3[],
  options: { ior: number; widthPixels: () => number },
): Node<"vec4"> {
  const colour = scenePass.getTextureNode("output");
  const depth = scenePass.getTextureNode("depth");
  // The owned engine's TSL takes a vector as a uniform value, not a Matrix4, and a column read from camera.matrixWorld
  // did not follow the pose (PRD-643 diagnosis, 2026-10-21). Three vectors the engine does follow carry the camera: its
  // origin, its axes and its projection.
  const vector = (read: (value: Vector3) => void) => {
    const value = new Vector3();
    return uniform(value).onRenderUpdate(() => {
      camera.updateMatrixWorld();
      read(value);
    });
  };
  const origin = vector((value) => camera.getWorldPosition(value));
  const right = vector((value) => value.setFromMatrixColumn(camera.matrixWorld, 0));
  const up = vector((value) => value.setFromMatrixColumn(camera.matrixWorld, 1));
  const back = vector((value) => value.setFromMatrixColumn(camera.matrixWorld, 2));
  // Half the view's tangent in x and y, and the clip distances.
  const lens = vector((value) =>
    value.set(
      1 / (camera.projectionMatrix.elements[0] as number),
      1 / (camera.projectionMatrix.elements[5] as number),
      0,
    ),
  );
  const clip = vector((value) => value.set(camera.near, camera.far, 0));
  const gain = vector((value) =>
    value.setScalar(
      refractionGain(
        options.ior,
        options.widthPixels(),
        camera.projectionMatrix.elements[0] as number,
      ),
    ),
  );
  // Distance along the view axis of a depth-buffer value (0 at the near plane, 1 at the far plane).
  const linearDepth = (value: Node<"float">) =>
    clip.x.mul(clip.y).div(clip.y.sub(value.mul(clip.y.sub(clip.x))));
  // A ray through a screen position, with 1 along the view axis: a world point is origin + ray * linearDepth.
  const rayAt = (uv: Node<"vec2">) =>
    right
      .mul(uv.x.mul(2).sub(1).mul(lens.x))
      .add(up.mul(float(1).sub(uv.y.mul(2)).mul(lens.y)))
      .sub(back);
  return Fn(() => {
    const result = colour.sample(screenUV).toVar();
    const ray = rayAt(screenUV);
    const direction = ray.normalize().toVar();
    const sceneDistance = ray.length().mul(linearDepth(depth.r));
    // Arithmetic, not a vector select (the owned engine's IR takes a bool scalar in a select): a ray along an axis divides by 1e-6.
    const sign = direction.sign();
    const safeDirection = direction.abs().max(0.000001).mul(sign.add(sign.abs().oneMinus()));
    const nearest = float(1e9).toVar();
    const normal = vec3(0).toVar();
    for (const box of boxes) {
      const a = vec3(box.min.x, box.min.y, box.min.z).sub(origin).div(safeDirection);
      const b = vec3(box.max.x, box.max.y, box.max.z).sub(origin).div(safeDirection);
      const entry = min(a, b);
      const exit = max(a, b);
      const start = max(max(entry.x, entry.y), entry.z);
      const end = min(min(exit.x, exit.y), exit.z);
      If(
        end
          .greaterThan(start)
          .and(start.greaterThan(0))
          .and(start.lessThan(sceneDistance))
          .and(start.lessThan(nearest)),
        () => {
          nearest.assign(start);
          // The face the ray enters through: the axis whose entry is the latest, facing back along the ray.
          normal.assign(step(start.sub(0.00001), entry).mul(sign).negate().normalize());
        },
      );
    }
    If(nearest.lessThan(1e8), () => {
      const viewNormal = vec3(normal.dot(right), normal.dot(up), normal.dot(back));
      const offset = vec2(viewNormal.x, viewNormal.y.negate()).mul(gain.x);
      const paneDepth = nearest.mul(direction.dot(back.negate()));
      const behind = linearDepth(depth.sample(screenUV.add(offset)).r);
      const moved = screenUV.add(offset.mul(behind.sub(paneDepth).mul(100).clamp(0, 1)));
      const off = moved.x
        .lessThan(0)
        .or(moved.x.greaterThan(1))
        .or(moved.y.lessThan(0))
        .or(moved.y.greaterThan(1));
      If(off.not(), () => {
        result.assign(colour.sample(moved));
      });
    });
    return result;
  })();
}
