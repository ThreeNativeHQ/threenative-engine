import { Vector3 } from "three";
import { createMaterials } from "../render/materials.js";
import { CIRCUIT, LINE_AT, lineDistance } from "../track/circuit.js";
import { CarBody, type CarCtx, RIDE } from "./CarBody.js";
import { LineDriver } from "./LineDriver.js";

/**
 * The rival's pace, in m/s. It is a **constant**, not a function of the player: the old rival ran a
 * fixed 7.6 m/s along the route whatever the player did, and rubber-banding it towards or away from
 * the player would be the same lie with more code. A fixed pace is beatable, and it is honest.
 */
export const RIVAL_PACE = 17.4;

/**
 * Laps the rival has completed, from its progress in metres since the route origin. Counted at the
 * finish line, as the player's `Lap` counts them: counted at the origin, 50 m short of the line,
 * the rival gained a lap the player had not yet, and a player leading into the line ranked second.
 */
export function rivalLap(progress: number): number {
  return Math.max(0, Math.floor((progress - lineDistance(LINE_AT.finish)) / CIRCUIT.totalLength));
}

/** The side of the road the rival keeps, so it and the demo driver never share a line. */
const RIVAL_OFFSET = 1.5;

/**
 * The rival: a second `VehicleBody3D` on the same chassis, driven by the same {@link LineDriver}
 * the autopilot uses.
 *
 * It has a body, so the player cannot drive through it; it starts on its own grid slot, so the two
 * cars do not spawn inside each other; and it is ranked on its own progress around the circuit, so
 * the order on the HUD is two cars rather than one car and a constant.
 *
 * There is no steering, throttle or braking code in this file. That is the point: the rival and the
 * autopilot are the *same* controller, so a playtest that presses the autopilot button is running
 * the rival's driving, not a scripted approximation of it.
 */
export class Rival {
  readonly car: CarBody;
  readonly driver: LineDriver;
  #lap = 0;

  constructor(ctx: CarCtx, startDistance: number) {
    const sample = CIRCUIT.at(startDistance, CIRCUIT.createSample());
    const yaw = Math.atan2(sample.tangent.z, sample.tangent.x);
    // Same sculpt, different livery: the rival was indistinguishable from the player in the first
    // frame because both cars asked for the same material set.
    const materials = createMaterials();
    this.car = new CarBody(ctx, {
      materials: { ...materials, body: materials.rivalBody },
      // The centreline is authored on the terrain, so the spawn is its point raised to the
      // chassis' ride height: dropping the car in from above reads as a jump start.
      spawn: new Vector3(sample.point.x, sample.point.y + RIDE, sample.point.z),
      yaw,
    });
    this.driver = new LineDriver({ offset: RIVAL_OFFSET, pace: RIVAL_PACE });
    this.driver.reset(startDistance);
    this.car.measure(1 / 60);
  }

  update(dt: number): void {
    this.driver.update(this.car, dt);
    this.#lap = rivalLap(this.driver.progress);
  }

  get mesh(): CarBody["mesh"] {
    return this.car.mesh;
  }

  get lap(): number {
    return this.#lap;
  }

  /** Monotonic progress around the lap, in metres: the quantity the ranking orders cars by. */
  get distance(): number {
    return this.driver.progress;
  }

  get speed(): number {
    return this.car.speedMagnitude;
  }

  debug(): Record<string, unknown> {
    return {
      lap: this.#lap,
      position: this.car.position.toArray(),
      routeProgress: this.driver.progress,
      speed: this.speed,
    };
  }

  dispose(): void {
    this.car.dispose();
  }
}
