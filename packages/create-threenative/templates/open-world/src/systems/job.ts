// The phone job: answer the booth in the plaza, a marked car appears across town, deliver it to the
// lot before the clock runs out. GTA III's "steal this car and bring it here" errand, the shape
// every early mission in the series takes.
import { Vector3 } from "three";
import { PLACES, ROADS, ROAD_WIDTH, block, roadLine } from "../city/layout.js";
import type { JobState } from "../state.js";

export const JOB = {
  /** Seconds from answering the phone to the drop-off. */
  time: 60,
  reward: 1500,
  /** Metres from the booth that answer it, and from the pad that count as delivered. */
  phoneReach: 1.6,
  padReach: 4,
  /** The car must be this slow on the pad: parked, not driven through. */
  parkedSpeed: 2,
  /** Seconds the result banner shows before the booth rings again. */
  cooldown: 4,
} as const;

/**
 * Where the job's car waits: parked against the kerb of the east edge road, beside the respray
 * block, a metre clear of the northbound lane so traffic still passes it.
 */
export const JOB_CAR_SPOT = new Vector3(
  roadLine(ROADS - 1) + ROAD_WIDTH / 2 - 1,
  0,
  block("respray").center.z,
);
/** It faces north up its lane (three's `rotation.y` 0 is -z). */
export const JOB_CAR_YAW = 0;

export class Job {
  state: JobState = "idle";
  time = 0;
  done = 0;
  #cooldown = 0;

  get active(): boolean {
    return this.state === "pickup" || this.state === "deliver";
  }

  /** On foot, inside the booth's ring, with no job running: answer it. */
  canStart(playerOnFoot: boolean, at: Vector3): boolean {
    return (
      this.state === "idle" &&
      this.#cooldown <= 0 &&
      playerOnFoot &&
      Math.hypot(at.x - PLACES.phone.x, at.z - PLACES.phone.z) < JOB.phoneReach
    );
  }

  start(): void {
    this.state = "pickup";
    this.time = JOB.time;
  }

  /**
   * One tick. `inJobCar`: the player drives the marked car; `carPosition` / `carSpeed` its state;
   * `carWrecked` ends the job. Returns the transition this tick, if any.
   */
  update(
    dt: number,
    inJobCar: boolean,
    carPosition: Vector3 | undefined,
    carSpeed: number,
    carWrecked: boolean,
  ): "passed" | "failed" | undefined {
    if (!this.active) {
      this.#cooldown -= dt;
      if ((this.state === "passed" || this.state === "failed") && this.#cooldown <= 0)
        this.state = "idle";
      return undefined;
    }
    this.time = Math.max(0, this.time - dt);
    if (carWrecked || this.time <= 0) return this.#finish("failed");
    if (inJobCar) this.state = "deliver";
    if (
      this.state === "deliver" &&
      inJobCar &&
      carPosition !== undefined &&
      Math.hypot(carPosition.x - PLACES.dropoff.x, carPosition.z - PLACES.dropoff.z) <
        JOB.padReach &&
      Math.abs(carSpeed) < JOB.parkedSpeed
    )
      return this.#finish("passed");
    return undefined;
  }

  /** Wasted or busted mid-job: it fails like a time-out. */
  abandon(): "failed" | undefined {
    if (!this.active) return undefined;
    this.#finish("failed");
    return "failed";
  }

  #finish(result: "passed" | "failed"): "passed" | "failed" {
    this.state = result;
    this.#cooldown = JOB.cooldown;
    if (result === "passed") this.done += 1;
    return result;
  }
}
