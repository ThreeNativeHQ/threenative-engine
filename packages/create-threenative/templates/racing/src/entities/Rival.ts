import { Vector3 } from "three";
import { createMaterials } from "../render/materials.js";
import { CIRCUIT, LINE_AT, gridSlot, lineDistance } from "../track/circuit.js";
import { CarBody, type CarCtx, RIDE } from "./CarBody.js";
import { LineDriver } from "./LineDriver.js";

/**
 * The field, pole first: each rival's pace in m/s and the side of the road it keeps.
 *
 * A pace is a **constant**, not a function of the player: rubber-banding a rival towards or away
 * from the player is a lie a driver feels. The ladder runs from just under the player's 26 m/s top
 * speed down, and the grid is in pace order, so no rival ever catches the one ahead of it. A
 * clean race with the nitro wins; a race with two rescues in it does not.
 * Each keeps the side of the road its grid slot is on, so the two lines never share a car.
 */
export const RIVALS = [
  { pace: 25, offset: 1.5 },
  { pace: 24.2, offset: -1.5 },
  { pace: 23.4, offset: 1.5 },
  { pace: 22.6, offset: -1.5 },
  { pace: 21.8, offset: 1.5 },
] as const;

/**
 * Laps the rival has completed, from its progress in metres since the route origin. Counted at the
 * finish line, as the player's `Lap` counts them: counted at the origin, 50 m short of the line,
 * the rival gained a lap the player had not yet, and a player leading into the line ranked second.
 */
export function rivalLap(progress: number): number {
  return Math.max(0, Math.floor((progress - lineDistance(LINE_AT.finish)) / CIRCUIT.totalLength));
}

/**
 * A rival: another `VehicleBody3D` on the same chassis, driven by the same {@link LineDriver}
 * the autopilot uses.
 *
 * It has a body, so the player cannot drive through it; it starts on its own grid slot, so no two
 * cars spawn inside each other; and it is ranked on its own progress around the circuit.
 *
 * There is no steering, throttle or braking code in this file. That is the point: the rival and the
 * autopilot are the *same* controller, so a playtest that presses the autopilot button is running
 * the rival's driving, not a scripted approximation of it.
 */
export class Rival {
  readonly car: CarBody;
  readonly driver: LineDriver;
  #lap = 0;

  /** `index` is the place on the grid, 0 on pole, and picks the pace and the livery. */
  constructor(ctx: CarCtx, index: number) {
    const spec = RIVALS[index];
    if (spec === undefined) throw new Error(`There is no rival ${index}.`);
    const slot = gridSlot(index);
    const sample = CIRCUIT.at(slot.distance, CIRCUIT.createSample());
    const yaw = Math.atan2(sample.tangent.z, sample.tangent.x);
    // Same sculpt, different livery: a rival indistinguishable from the player in the first frame
    // is a car the player cannot find in the mirror.
    const materials = createMaterials();
    const livery = materials.rivalLiveries[index % materials.rivalLiveries.length];
    this.car = new CarBody(ctx, {
      materials: { ...materials, body: livery ?? materials.rivalBody },
      // The centreline is authored on the terrain, so the spawn is its height raised to the
      // chassis' ride height: dropping the car in from above reads as a jump start.
      spawn: new Vector3()
        .copy(sample.point)
        .addScaledVector(sample.right, slot.side)
        .setY(sample.point.y + RIDE),
      yaw,
    });
    this.driver = new LineDriver({ offset: spec.offset, pace: spec.pace });
    this.driver.reset(slot.distance);
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
