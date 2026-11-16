import { Vector3 } from "three";
import { CIRCUIT, type CircuitLine } from "./circuit.js";
import { type IRescueTarget, rescueToLastValid } from "./rescue.js";

export interface IRayHit {
  readonly distance: number;
  readonly normalY?: number;
}

export type IntersectRay = (
  origin: Vector3,
  direction: Vector3,
  maxDistance: number,
) => IRayHit | undefined;

export type ITrackSectorTarget = IRescueTarget;

export interface ITrackSectorOptions {
  readonly route: CircuitLine;
  readonly intersectRay: IntersectRay;
  readonly rescueDelay?: number;
  readonly rayHeight?: number;
  /** Seconds below {@link ITrackSectorOptions.stallSpeed} before a beached car is recovered. */
  readonly stallRescueDelay?: number;
  readonly stallSpeed?: number;
  /** The ground's height here, so a car that leaves the surface can be caught before it falls. */
  readonly groundAt?: (x: number, z: number) => number;
  /** Metres below the ground at which a car is falling, not driving. */
  readonly fallDepth?: number;
}

/** Records a grounded transform and returns a racer to it after leaving the road. */
export class TrackSector {
  readonly lastOnRoadPosition = new Vector3();
  readonly lastOnRoadHeading = new Vector3(1, 0, 0);
  /** How far around the lap the last on-road sample was, in metres. */
  currentSector = 0;
  #offRoadTime = 0;
  #stalledTime = 0;
  #hasOnRoadSample = false;
  #hasMoved = false;
  #falling = false;
  readonly #route: CircuitLine;
  readonly #intersectRay: IntersectRay;
  readonly #rescueDelay: number;
  readonly #rayHeight: number;
  readonly #stallRescueDelay: number;
  readonly #stallSpeed: number;
  readonly #groundAt: ((x: number, z: number) => number) | undefined;
  readonly #fallDepth: number;
  readonly #origin = new Vector3();
  readonly #direction = new Vector3(0, -1, 0);
  readonly #projection = {
    curvature: 0,
    distance: 0,
    lateral: 0,
    point: new Vector3(),
    tangent: new Vector3(0, 0, 1),
  };

  constructor(options: ITrackSectorOptions) {
    this.#route = options.route ?? CIRCUIT;
    this.#intersectRay = options.intersectRay;
    this.#rescueDelay = options.rescueDelay ?? 0.65;
    this.#rayHeight = options.rayHeight ?? 3;
    this.#stallRescueDelay = options.stallRescueDelay ?? 1.2;
    this.#stallSpeed = options.stallSpeed ?? 0.6;
    this.#groundAt = options.groundAt;
    this.#fallDepth = options.fallDepth ?? 1.2;
    if (!(this.#rescueDelay > 0)) throw new Error("TrackSector rescueDelay must be positive.");
    if (!(this.#fallDepth > 0)) throw new Error("TrackSector fallDepth must be positive.");
    if (!(this.#stallRescueDelay > 0))
      throw new Error("TrackSector stallRescueDelay must be positive.");
  }

  /**
   * `speed` is the car's measured speed in m/s. It is what makes a **beached** car recoverable: a
   * ray-cast chassis that has nosed into a barrier is still standing on the road, so the off-road
   * ray keeps hitting and a car pinned against a hoarding would sit there for the rest of the race.
   * `driving` says the engine is pushing: only a car that is driven and still not moving is beached.
   * A car the player brought to a stop is parked, and four rescues of a parked car end the race.
   */
  update(position: Vector3, heading: Vector3, dt: number, speed = 0, driving = true): boolean {
    if (!Number.isFinite(dt) || dt < 0)
      throw new Error("TrackSector.update requires a finite non-negative dt.");
    if (Math.abs(speed) >= this.#stallSpeed) {
      this.#stalledTime = 0;
      this.#hasMoved = true;
    } else if (!driving) this.#stalledTime = 0;
    else if (this.#hasMoved) this.#stalledTime += dt;
    const origin = this.#origin.copy(position);
    origin.y += this.#rayHeight;
    const hit = this.#intersectRay(origin, this.#direction, this.#rayHeight + 2);
    const onRoad = hit !== undefined && hit.distance >= 0 && hit.distance <= this.#rayHeight + 2;
    if (onRoad) {
      this.lastOnRoadPosition.copy(position);
      this.lastOnRoadHeading.copy(heading).setY(0).normalize();
      this.currentSector = this.#route.project(position, this.#projection).distance;
      this.#hasOnRoadSample = true;
      this.#offRoadTime = 0;
      return true;
    }
    // Off the surface is a run wide; **below** it is a car with no world under its wheels. The grass
    // is a collider now, so this is the last-resort net for a jump or a future gap, caught the tick
    // it happens rather than after the run-wide delay, which by then is seconds of falling.
    const ground = this.#groundAt?.(position.x, position.z);
    this.#falling = ground !== undefined && position.y < ground - this.#fallDepth;
    this.#offRoadTime += dt;
    return false;
  }

  get offRoadTime(): number {
    return this.#offRoadTime;
  }

  get stalledTime(): number {
    return this.#stalledTime;
  }

  get shouldRescue(): boolean {
    return (
      this.#hasOnRoadSample &&
      (this.#falling ||
        this.#offRoadTime >= this.#rescueDelay ||
        this.#stalledTime >= this.#stallRescueDelay)
    );
  }

  rescue(target: ITrackSectorTarget): boolean {
    if (!this.shouldRescue) return false;
    rescueToLastValid(target, this.lastOnRoadPosition, this.lastOnRoadHeading);
    this.#offRoadTime = 0;
    this.#stalledTime = 0;
    this.#falling = false;
    return true;
  }
}
