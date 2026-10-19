// Skeleton frames and the 5-texel DQS packet follow the pinned donor's MIT-licensed
// core/render/skeleton.js and dqs.js. Appearance is supplied by the game.
import {
  Bone,
  DataTexture,
  FloatType,
  Matrix3,
  Matrix4,
  NearestFilter,
  Quaternion,
  RGBAFormat,
  Vector3,
} from "three";
import { animalError, requireValidatedBake } from "./format.js";
import type { IAnimalBake } from "./format.js";

export interface IAnimalSkeleton {
  readonly bones: readonly Bone[];
  readonly bind: readonly Matrix4[];
  readonly inverses: readonly Matrix4[];
}
export interface IAnimalPose {
  readonly skeleton: IAnimalSkeleton;
  readonly data: Float32Array;
  readonly texture: DataTexture;
  update(worldToLocal: Matrix4): void;
  dispose(): void;
}

function bindFrame(head: readonly number[], tail: readonly number[]): Matrix4 {
  const origin = new Vector3().fromArray(head);
  const y = new Vector3().fromArray(tail).sub(origin).normalize();
  const x = new Vector3(1, 0, 0).addScaledVector(y, -y.x);
  if (x.lengthSq() < 1e-10) x.set(0, 0, 1).addScaledVector(y, -y.z);
  x.normalize();
  return new Matrix4().makeBasis(x, y, new Vector3().crossVectors(x, y)).setPosition(origin);
}

export function createAnimalPose(bake: IAnimalBake): IAnimalPose {
  requireValidatedBake(bake);
  const bind = bake.bones.map((bone) => {
    const head = bake.joints[bone.headJ];
    const tail = bake.joints[bone.tailJ];
    if (!head || !tail) throw animalError("RIG", "validated joint disappeared");
    return bindFrame(head, tail);
  });
  const bones = bind.map((matrix, i) => {
    const bone = new Bone();
    bone.name = bake.bones[i]?.name ?? "";
    bone.matrixAutoUpdate = bone.matrixWorldAutoUpdate = false;
    bone.matrixWorld.copy(matrix);
    return bone;
  });
  const skeleton = { bones, bind, inverses: bind.map((matrix) => matrix.clone().invert()) };
  const data = new Float32Array(bones.length * 20);
  const pending = new Float32Array(data.length);
  const texture = new DataTexture(data, bones.length * 5, 1, RGBAFormat, FloatType);
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  const bindRotation: Quaternion[] = [];
  const bindPosition: Vector3[] = [];
  const bindAxes: Matrix3[] = [];
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  for (const matrix of bind) {
    matrix.decompose(position, rotation, scale);
    bindPosition.push(position.clone());
    bindRotation.push(rotation.clone().invert());
    bindAxes.push(new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(rotation)));
  }
  const local = new Matrix4();
  const affine = new Matrix3();
  const scaling = new Matrix3();
  const transpose = new Matrix3();
  const translation = new Vector3();
  let disposed = false;
  return {
    skeleton,
    data,
    texture,
    update(worldToLocal) {
      if (disposed) throw animalError("DISPOSED", "pose is disposed");
      for (let i = 0; i < bones.length; i++) {
        const bone = bones[i];
        const inverse = bindRotation[i];
        const origin = bindPosition[i];
        const axes = bindAxes[i];
        if (!bone || !inverse || !origin || !axes) throw animalError("RIG", "missing pose bone");
        local.multiplyMatrices(worldToLocal, bone.matrixWorld);
        for (let j = 0; j < local.elements.length; j++)
          if (!Number.isFinite(local.elements[j]))
            throw animalError("POSE", `${bone.name} has non-finite matrix`);
        local.decompose(position, rotation, scale);
        if (
          !(Math.abs(scale.x) > 1e-8) ||
          !(Math.abs(scale.y) > 1e-8) ||
          !(Math.abs(scale.z) > 1e-8)
        )
          throw animalError("POSE", `${bone.name} has singular scale`);
        rotation.multiply(inverse);
        translation.copy(origin).applyQuaternion(rotation).negate().add(position);
        const o = i * 20;
        const { x, y, z, w } = rotation;
        const tx = translation.x;
        const ty = translation.y;
        const tz = translation.z;
        pending[o] = x;
        pending[o + 1] = y;
        pending[o + 2] = z;
        pending[o + 3] = w;
        pending[o + 4] = 0.5 * (w * tx + ty * z - tz * y);
        pending[o + 5] = 0.5 * (w * ty + tz * x - tx * z);
        pending[o + 6] = 0.5 * (w * tz + tx * y - ty * x);
        pending[o + 7] = -0.5 * (tx * x + ty * y + tz * z);
        affine
          .multiplyMatrices(axes, scaling.set(scale.x, 0, 0, 0, scale.y, 0, 0, 0, scale.z))
          .multiply(transpose.copy(axes).transpose());
        const e = affine.elements;
        pending[o + 8] = e[0];
        pending[o + 9] = e[3];
        pending[o + 10] = e[6];
        pending[o + 11] = origin.x - (e[0] * origin.x + e[3] * origin.y + e[6] * origin.z);
        pending[o + 12] = e[1];
        pending[o + 13] = e[4];
        pending[o + 14] = e[7];
        pending[o + 15] = origin.y - (e[1] * origin.x + e[4] * origin.y + e[7] * origin.z);
        pending[o + 16] = e[2];
        pending[o + 17] = e[5];
        pending[o + 18] = e[8];
        pending[o + 19] = origin.z - (e[2] * origin.x + e[5] * origin.y + e[8] * origin.z);
      }
      for (let p = 0; p < pending.length; p++)
        if (!Number.isFinite(pending[p]))
          throw animalError("POSE", "pose packet exceeds float range");
      data.set(pending);
      texture.needsUpdate = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      texture.dispose();
    },
  };
}
