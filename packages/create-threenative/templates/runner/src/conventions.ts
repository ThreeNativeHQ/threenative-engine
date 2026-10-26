import { GroundSnap, normaliseToMetres } from "@threenative/core";
import type { Object3D } from "three";

export interface IRunnerConventions {
  readonly applyGrounding: (surfaceY: number, dt: number) => void;
  readonly groundSnap: GroundSnap;
  readonly normaliseFactor: number;
}

/**
 * One metre is one metre, and the runner's feet meet the track — including mid-jump.
 *
 * `GroundSnap` takes the surface height as an argument, so a jump is a *surface that moved*
 * rather than an exception to grounding. That is what keeps the landing exact at any frame rate.
 */
export function prepareRunnerConventions(model: Object3D): IRunnerConventions {
  // Measured to the mannequin's `Head` joint, the base of the skull: 1.545 m there is a 1.8 m figure.
  const normaliseFactor = normaliseToMetres(model, { axis: "height", metres: 1.545 });
  // The jog's flight phase lifts both feet up to 0.27 m. An exact snap pulls that onto the track
  // and the leading foot skates at 8 m/s; `maxRate` keeps the flight and still raises a sunken pose.
  const groundSnap = new GroundSnap(model, { maxRate: 0.25 });
  return {
    applyGrounding: (surfaceY, dt) => groundSnap.apply(model, surfaceY, dt),
    groundSnap,
    normaliseFactor,
  };
}
