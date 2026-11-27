import { GroundSnap, normaliseToMetres, skeletonBones } from "@threenative/core";
import type { Object3D } from "three";

export interface IRigConventions {
  readonly applyGrounding: (surfaceY: number, dt: number) => void;
  readonly boneNames: readonly string[];
  readonly groundSnap: GroundSnap;
  readonly normaliseFactor: number;
}

/**
 * The conventions a rigged character owes its level: a measured size, and a floor contact that
 * follows the posed soles. `model` is the cloned rig.
 */
export function prepareRigConventions(model: Object3D): IRigConventions {
  // A skinned figure is measured from its origin to its crown joint, and on this Unreal-style
  // skeleton that is `Head` — the base of the skull, not its top. 1.545 m at that joint puts the
  // top of the head at 1.8 m, the height of the 762-unit body the simulation runs on.
  const normaliseFactor = normaliseToMetres(model, { axis: "height", metres: 1.545 });
  const groundSnap = new GroundSnap(model);
  return {
    applyGrounding: (surfaceY, dt) => groundSnap.apply(model, surfaceY, dt),
    boneNames: skeletonBones(model),
    groundSnap,
    normaliseFactor,
  };
}
