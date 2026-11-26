import { GroundSnap, normaliseToMetres } from "@threenative/core";
import type { Object3D } from "three";

export interface IFighterConventions {
  readonly applyGrounding: (surfaceY: number, dt: number) => void;
  readonly groundSnap: GroundSnap;
  readonly normaliseFactor: number;
}

/** The two conventions a rigged fighter owes its stage: authored metres, and feet on the floor. */
export function preparePlayerConventions(model: Object3D): IFighterConventions {
  // A skinned figure is measured from its origin to its crown joint, and on this Unreal-style
  // skeleton that is `Head`, the base of the skull, not its top. 1.545 m at that joint puts the
  // top of the head at 1.8 m, the height of the fighter hurtbox in `sim/constants.ts`.
  const normaliseFactor = normaliseToMetres(model, { axis: "height", metres: 1.545 });
  const groundSnap = new GroundSnap(model);
  return {
    applyGrounding: (surfaceY, dt) => groundSnap.apply(model, surfaceY, dt),
    groundSnap,
    normaliseFactor,
  };
}
