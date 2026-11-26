import { GroundSnap, attachToBone, normaliseToMetres, skeletonBones } from "@threenative/core";
import type { Object3D } from "three";

/** The combat mannequin's right hand, by the name the rig authors it under. */
export const HAND_BONE = "hand_r";

export interface IOpenWorldConventions {
  readonly applyGrounding: (surfaceY: number, dt: number) => void;
  /** The bone the held weapon resolved to, read back by name ("" when bare-handed). */
  readonly attachedBone: string;
  readonly boneNames: readonly string[];
  readonly groundSnap: GroundSnap;
  readonly normaliseFactor: number;
}

/**
 * The conventions a rigged character owes its city, in the order they depend on each other.
 * `model` is the cloned rig; `weapon` is a small mesh the right hand holds.
 */
export function preparePlayerConventions(
  model: Object3D,
  weapon?: Object3D,
): IOpenWorldConventions {
  // On this Unreal-style skeleton the crown joint is `Head`, the base of the skull: 1.545 m there
  // puts the top of the head at 1.8 m, the height the capsule in `Humanoid.ts` is built for.
  const normaliseFactor = normaliseToMetres(model, { axis: "height", metres: 1.545 });
  // The hand owns the pistol, so every clip that moves the hand moves the gun.
  if (weapon !== undefined) attachToBone(model, HAND_BONE, weapon);
  // The capsule already stands the figure on kerbs, sidewalks and asphalt at three heights; a
  // snap to one surface height would sink it into the sidewalk, so the snap stays measured but off.
  const groundSnap = new GroundSnap(model, { enabled: false });
  return {
    applyGrounding: (surfaceY, dt) => groundSnap.apply(model, surfaceY, dt),
    attachedBone: weapon?.parent?.name ?? "",
    boneNames: skeletonBones(model),
    groundSnap,
    normaliseFactor,
  };
}
