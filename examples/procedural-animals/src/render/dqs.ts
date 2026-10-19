// Exact base-surface DQS/affine/normal port from the pinned MIT donor; editable game source.
import type { DataTexture } from "three";
import {
  Fn,
  cross,
  dot,
  int,
  ivec2,
  length,
  max,
  select,
  textureLoad,
  vec3,
  vec4,
} from "three/tsl";
import type { Node } from "three/webgpu";
export function animalSkin(
  texture: DataTexture,
  position: Node<"vec3">,
  normal: Node<"vec3">,
  indices: Node<"vec4">,
  weights: Node<"vec4">,
  direction: boolean,
): Node<"vec3"> {
  const texel = (bone: Node<"float">, slot: number) =>
    textureLoad(texture, ivec2(int(bone).mul(5).add(slot), 0));
  return Fn(() => {
    const reference = texel(indices.x, 0);
    const real = vec4(0).toVar();
    const dual = vec4(0).toVar();
    const scaled = vec3(0).toVar();
    const hp = vec4(position, 1);
    for (const component of ["x", "y", "z", "w"] as const) {
      const bone = indices[component];
      const weight = weights[component];
      scaled.addAssign(
        vec3(dot(texel(bone, 2), hp), dot(texel(bone, 3), hp), dot(texel(bone, 4), hp)).mul(weight),
      );
      const rotation = texel(bone, 0);
      const signed = select(dot(rotation, reference).lessThan(0), weight.negate(), weight);
      real.addAssign(rotation.mul(signed));
      dual.addAssign(texel(bone, 1).mul(signed));
    }
    scaled.divAssign(max(weights.x.add(weights.y).add(weights.z).add(weights.w), 1e-5));
    const magnitude = max(length(real), 1e-6);
    real.divAssign(magnitude);
    dual.divAssign(magnitude);
    const value = direction ? normal : scaled;
    const rotated = value.add(
      cross(real.xyz, cross(real.xyz, value).add(value.mul(real.w))).mul(2),
    );
    if (direction) return rotated;
    const translation = dual.xyz
      .mul(real.w)
      .sub(real.xyz.mul(dual.w))
      .add(cross(real.xyz, dual.xyz))
      .mul(2);
    return rotated.add(translation);
  })();
}
