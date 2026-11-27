import { normaliseToMetres } from "@threenative/core";
import type { Object3D } from "three";

/**
 * The convention a rigged pilot owes the world: one metre is one metre. The mannequin is measured
 * from its origin to its crown joint, which on this Unreal-style skeleton is `Head`, the base of
 * the skull: 1.545 m at that joint is a 1.8 m person. Returns the factor the rig was scaled by.
 */
export function preparePilot(model: Object3D): number {
  return normaliseToMetres(model, { axis: "height", metres: 1.545 });
}
