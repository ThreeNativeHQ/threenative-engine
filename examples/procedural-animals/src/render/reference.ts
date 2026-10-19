import type { IAnimalBake } from "@threenative/procedural-animals";
import { Quaternion, Vector3 } from "three";

/** Independent double-precision reference: quaternion multiplication, not shader cross formulas. */
export function deformReference(
  bake: Pick<IAnimalBake, "pos" | "nrm" | "skinIndex" | "skinWeight">,
  packet: Float32Array,
  vertex: number,
) {
  const position = new Vector3().fromArray(bake.pos, vertex * 3);
  const reference = new Quaternion().fromArray(packet, (bake.skinIndex[vertex * 4] ?? 0) * 20);
  const real = new Quaternion(0, 0, 0, 0);
  const dual = new Quaternion(0, 0, 0, 0);
  const scaled = new Vector3();
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const weight = bake.skinWeight[vertex * 4 + i] ?? 0;
    if (weight === 0) continue;
    const offset = (bake.skinIndex[vertex * 4 + i] ?? 0) * 20;
    const rq = new Quaternion().fromArray(packet, offset);
    const dq = new Quaternion().fromArray(packet, offset + 4);
    const sign = reference.dot(rq) < 0 ? -weight : weight;
    real.set(
      real.x + sign * rq.x,
      real.y + sign * rq.y,
      real.z + sign * rq.z,
      real.w + sign * rq.w,
    );
    dual.set(
      dual.x + sign * dq.x,
      dual.y + sign * dq.y,
      dual.z + sign * dq.z,
      dual.w + sign * dq.w,
    );
    for (let row = 0; row < 3; row++) {
      const o = offset + 8 + row * 4;
      scaled.setComponent(
        row,
        scaled.getComponent(row) +
          weight *
            ((packet[o] ?? 0) * position.x +
              (packet[o + 1] ?? 0) * position.y +
              (packet[o + 2] ?? 0) * position.z +
              (packet[o + 3] ?? 0)),
      );
    }
    sum += weight;
  }
  const inverse = 1 / Math.max(real.length(), 1e-6);
  real.set(real.x * inverse, real.y * inverse, real.z * inverse, real.w * inverse);
  dual.set(dual.x * inverse, dual.y * inverse, dual.z * inverse, dual.w * inverse);
  const translation = dual.clone().multiply(real.clone().conjugate());
  return {
    position: scaled
      .divideScalar(Math.max(sum, 1e-5))
      .applyQuaternion(real)
      .add(new Vector3(translation.x, translation.y, translation.z).multiplyScalar(2)),
    normal: new Vector3().fromArray(bake.nrm, vertex * 3).applyQuaternion(real),
  };
}
