import { GroundSnap, attachToBone, normaliseToMetres, skeletonBones } from "@threenative/core";
import type { Object3D } from "three";

/** The combat mannequin's right hand, by the name the rig authors it under. */
export const HAND_BONE = "hand_r";

export interface IKitConventions {
  readonly applyGrounding: (surfaceY: number, dt: number) => void;
  /** The bone the held weapon resolved to, read back by name. */
  readonly attachedBone: string;
  readonly boneNames: readonly string[];
  readonly groundSnap: GroundSnap;
  readonly normaliseFactor: number;
}

/**
 * The three conventions a rigged character owes its level, in the order they depend on each other.
 *
 * `model` is the cloned rig; `weapon` is a small mesh this game owns and the hand has to hold.
 */
export function prepareConventions(
  model: Object3D,
  weapon?: Object3D,
): IKitConventions {
  // A skinned figure is measured from its origin to its crown joint, and on this Unreal-style
  // skeleton that is `Head` — the base of the skull, not its top. 1.545 m at that joint puts the
  // top of the head at 1.8 m, the height the capsule in `Player.ts` is built for.
  const normaliseFactor = normaliseToMetres(model, { axis: "height", metres: 1.545 });
  // The hand owns the handgun: parenting by bone name is what makes every clip that moves the hand
  // — aim high, aim low, the recoil, the reload — move the gun with it, with no per-frame follow.
  // A bare-handed zombie skips it and reports no attached bone rather than an invented one.
  if (weapon !== undefined) attachToBone(model, HAND_BONE, weapon);
  const groundSnap = new GroundSnap(model);
  return {
    applyGrounding: (surfaceY, dt) => groundSnap.apply(model, surfaceY, dt),
    attachedBone: weapon?.parent?.name ?? "",
    boneNames: skeletonBones(model),
    groundSnap,
    normaliseFactor,
  };
}
