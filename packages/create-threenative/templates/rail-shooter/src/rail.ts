import { PathFollow3D } from "@threenative/core";
import { Vector3 } from "three";

/** A point on the rail and the three axes of the corridor there. */
export interface IRailFrame {
  readonly position: Vector3;
  /** Direction of travel. */
  readonly forward: Vector3;
  readonly right: Vector3;
  readonly up: Vector3;
}

const WORLD_UP = new Vector3(0, 1, 0);
const _sample = { point: new Vector3(), progress: 0, tangent: new Vector3() };

export function createFrame(): IRailFrame {
  return {
    position: new Vector3(),
    forward: new Vector3(0, 0, 1),
    right: new Vector3(1, 0, 0),
    up: new Vector3(0, 1, 0),
  };
}

/**
 * The rail: one spline through authored points, read by distance. `PathFollow3D` is the engine's
 * arc-length spline follower, so a metre on the rail is a metre of flight at any bend.
 */
export class Rail {
  readonly length: number;
  readonly #path: PathFollow3D;

  constructor(points: readonly Vector3[]) {
    this.#path = new PathFollow3D({ points });
    this.length = this.#path.totalLength;
  }

  /** The frame at `s` metres along the rail. Distances outside the rail clamp to its ends. */
  frameAt(s: number, out: IRailFrame): IRailFrame {
    this.#path.sample(Math.min(Math.max(s, 0), this.length), _sample);
    out.position.copy(_sample.point);
    out.forward.copy(_sample.tangent);
    out.right.crossVectors(out.forward, WORLD_UP).normalize();
    out.up.crossVectors(out.right, out.forward).normalize();
    return out;
  }

  /** `s` plus a lateral and vertical offset in that frame, written to `out`. */
  worldAt(s: number, x: number, y: number, out: Vector3, scratch: IRailFrame): Vector3 {
    this.frameAt(s, scratch);
    return out
      .copy(scratch.position)
      .addScaledVector(scratch.right, x)
      .addScaledVector(scratch.up, y);
  }
}
