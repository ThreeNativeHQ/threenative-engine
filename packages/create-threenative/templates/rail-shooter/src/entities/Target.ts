import type { Vector3 } from "three";

/** What a shot can hit and the lock-on can mark: an enemy, a boss pod or the boss core. */
export interface ITarget {
  readonly id: string;
  readonly position: Vector3;
  readonly radius: number;
  /** Shots pass through a target that is not live, and the lock-on skips it. */
  readonly live: boolean;
  /** Takes the hit. A target the shots cannot hurt yet (an armoured core) returns false. */
  hurt(damage: number): boolean;
}
