// Rival drivers (reference cards carmageddon/ai-objectives and ai-path-following).
// A rival holds exactly one timed objective and writes the same pedals and curvature a player's
// keys would. Its temperament (nastiness) and a grudge the player builds pick the next objective.
import type { Car } from "../entities/Car.js";
import { type IPathPoint, pathAt, trackDistance } from "../arena/layout.js";

export type Objective = "race" | "pursue" | "backup" | "wait";

export const RIVAL = {
  /** An objective lasts 30 to 180 seconds (opponent.c:509), a pursuit 90 more (opponent.c:511). */
  minSeconds: 30,
  maxSeconds: 180,
  pursuitExtension: 90,
  /** A pursuit ends once the grudge falls below this (opponent.c:1103). */
  pursuitGrudgeFloor: 15,
  /** Grudge = 40 per point of nastiness plus 10 (opponent.c:1680), clamped to 20..100 (opponent.c:1701). */
  nastinessScale: 40,
  grudgeBase: 10,
  grudgeFloor: 20,
  grudgeCeiling: 100,
  /** Pursuit chance per second: grudge - offset + 30 per point of nastiness (opponent.c:1743). */
  pursuitOffset: 30,
  pursuitNastiness: 30,
  headOnBonus: 50,
  /** At most three rivals close on the player and two mind the race (opponent.c:1764, 1769). */
  concurrentPursuers: 3,
  concurrentRacers: 2,
  /** A rival jammed against a stationary player for 2.2 s backs off with a burst of reverse (opponent.c:1163). */
  backupDelay: 2.2,
  backupSeconds: 1.4,
  /** The grudge rises when it rams or is rammed. Kit tuning. */
  ramGrudge: 25,
  /** The grudge decays on a slow timer. Kit tuning. */
  grudgeDecay: 1.2,
  /** Sight range for noticing the player. Kit tuning. */
  sight: 70,
  /** Path following: look 15 ahead (oppoproc.c:315). */
  lookAhead: 15,
  /** Open-road speed and corner speed, in m/s. The card's 80 and 6 are world units; kit tuning. */
  openRoadSpeed: 27,
  slowCornerSpeed: 8,
  /** Corner speed from the arc radius times the grip fudge 1.4 (oppoproc.c:84, 422). */
  gripFudge: 1.4,
  cornerAccel: 7,
  /** Braking distance: speed squared over 24 plus 1.5 s of reaction (oppoproc.c:405). */
  brakingDivisor: 24,
  brakingLead: 1.5,
} as const;

export interface IRivalTarget {
  readonly x: number;
  readonly z: number;
  readonly vx: number;
  readonly vz: number;
  readonly speed: number;
}

export interface IRivalControl {
  readonly fwd: number;
  readonly back: number;
  readonly steer: number;
  readonly handbrake: boolean;
}

export class RivalDriver {
  objective: Objective = "race";
  grudge: number;
  /** Seconds left of the current objective. */
  ttl: number;
  #distance: number;
  #jam = 0;
  #backup = 0;
  #thinkClock = 0;

  constructor(
    readonly car: Car,
    /** 0..1: how readily it picks a fight. */
    readonly nastiness: number,
    startDistance: number,
    private readonly random: () => number,
  ) {
    this.grudge = RIVAL.grudgeBase + RIVAL.nastinessScale * nastiness;
    this.ttl = RIVAL.minSeconds + this.random() * (RIVAL.maxSeconds - RIVAL.minSeconds);
    this.#distance = startDistance;
  }

  /** Called when this rival rams the player or the player rams it. */
  provoke(): void {
    this.grudge = Math.min(
      RIVAL.grudgeCeiling,
      Math.max(RIVAL.grudgeFloor, this.grudge + RIVAL.ramGrudge),
    );
  }

  setObjective(objective: Objective): void {
    this.objective = objective;
    this.ttl =
      RIVAL.minSeconds +
      this.random() * (RIVAL.maxSeconds - RIVAL.minSeconds) +
      (objective === "pursue" ? RIVAL.pursuitExtension : 0);
    this.#jam = 0;
  }

  /** `others` are the rivals' objectives right now, counted for the concurrency caps. */
  update(dt: number, target: IRivalTarget, others: readonly RivalDriver[]): IRivalControl {
    const car = this.car;
    if (car.wrecked) return { back: 0, fwd: 0, handbrake: false, steer: 0 };
    this.ttl -= dt;
    this.grudge = Math.max(0, this.grudge - RIVAL.grudgeDecay * dt);
    this.#distance = trackDistance(car.position.x, car.position.z, this.#distance);
    const gap = Math.hypot(target.x - car.position.x, target.z - car.position.z);
    this.#thinkClock += dt;
    if (this.#thinkClock >= 1) {
      this.#thinkClock = 0;
      this.#think(gap, target, others);
    }
    if (this.objective === "backup") return this.#backUp(dt);
    // Jammed against a stationary player: back off with a burst of reverse, then brake.
    if (this.objective === "pursue" && gap < 7 && Math.abs(car.speed) < 1.5 && target.speed < 1.5) {
      this.#jam += dt;
      if (this.#jam >= RIVAL.backupDelay) {
        this.setObjective("backup");
        this.#backup = RIVAL.backupSeconds;
      }
    } else this.#jam = 0;
    if (this.objective === "pursue") return this.#pursue(target);
    if (this.objective === "wait") return { back: 0, fwd: 0, handbrake: false, steer: 0 };
    return this.#race();
  }

  #think(gap: number, target: IRivalTarget, others: readonly RivalDriver[]): void {
    const car = this.car;
    if (this.objective === "backup") return;
    if (this.objective === "pursue") {
      if (this.grudge < RIVAL.pursuitGrudgeFloor || this.ttl <= 0) this.setObjective("race");
      return;
    }
    const pursuers = others.filter(
      (other) => other !== this && other.objective === "pursue",
    ).length;
    if (gap < RIVAL.sight && pursuers < RIVAL.concurrentPursuers) {
      // The chance, in percent, to start a pursuit this second.
      const heading = _headOn(car, target);
      const chance =
        this.grudge -
        RIVAL.pursuitOffset +
        RIVAL.pursuitNastiness * this.nastiness +
        (heading ? RIVAL.headOnBonus : 0);
      if (this.random() * 100 < chance) {
        this.setObjective("pursue");
        return;
      }
    }
    const racers = others.filter((other) => other !== this && other.objective === "race").length;
    if (this.objective === "wait" && racers < RIVAL.concurrentRacers && this.ttl <= 0)
      this.setObjective("race");
    else if (this.objective === "race" && racers >= RIVAL.concurrentRacers)
      this.setObjective("wait");
  }

  #backUp(dt: number): IRivalControl {
    this.#backup -= dt;
    if (this.#backup <= 0) {
      this.setObjective("pursue");
      return { back: 0, fwd: 0, handbrake: false, steer: 0 };
    }
    return { back: 1, fwd: 0, handbrake: false, steer: 0 };
  }

  #pursue(target: IRivalTarget): IRivalControl {
    // Lead the target a little, so the ram meets it.
    const aimX = target.x + target.vx * 0.5;
    const aimZ = target.z + target.vz * 0.5;
    return this.#toward(aimX, aimZ, RIVAL.openRoadSpeed, 1);
  }

  /** Follows the circuit 15 m ahead, slowing for corners by the arc radius. */
  #race(): IRivalControl {
    const car = this.car;
    const ahead: IPathPoint = pathAt(this.#distance + RIVAL.lookAhead + Math.abs(car.speed) * 0.5);
    const corner = cornerSpeed(this.#distance, car.speed);
    return this.#toward(ahead.x, ahead.z, corner, 0.9);
  }

  #toward(x: number, z: number, wantSpeed: number, fullLock: number): IRivalControl {
    const car = this.car;
    const dx = x - car.position.x;
    const dz = z - car.position.z;
    // Signed angle to the aim point: + is to the right of the nose.
    const yaw = car.yaw;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const cross = fx * dz - fz * dx;
    const dot = fx * dx + fz * dz;
    const angle = Math.atan2(cross, dot);
    // Full available curvature when well off line, a proportional nibble when close (oppoproc.c:384).
    const curvature = Math.max(-1, Math.min(1, (angle / car.lockAt(car.speed)) * 0.8)) * fullLock;
    car.curvature = curvature;
    const speedError = wantSpeed - car.speed;
    if (dot < -2 && Math.abs(angle) > 2) {
      // The aim point is behind: brake, then reverse and swing the tail round.
      return { back: 1, fwd: 0, handbrake: false, steer: 0 };
    }
    // A proportional loop turns the speed error into pedal (oppoproc.c:460-464).
    if (speedError > 0.5)
      return { back: 0, fwd: Math.min(1, speedError / 4), handbrake: false, steer: 0 };
    return { back: Math.min(1, -speedError / 6), fwd: 0, handbrake: false, steer: 0 };
  }
}

/** Slows for the next corner: it needs the arc radius ahead, found by sampling the heading change. */
function cornerSpeed(distance: number, speed: number): number {
  const brakeDistance = (speed * speed) / RIVAL.brakingDivisor + RIVAL.brakingLead * speed;
  const here = pathAt(distance);
  const far = pathAt(distance + Math.max(20, brakeDistance + 10));
  const turn = Math.abs(
    Math.atan2(here.fx * far.fz - here.fz * far.fx, here.fx * far.fx + here.fz * far.fz),
  );
  if (turn < 0.2) return RIVAL.openRoadSpeed;
  const radius = Math.max(10, brakeDistance / Math.max(turn, 0.2));
  return Math.max(
    RIVAL.slowCornerSpeed,
    Math.min(RIVAL.openRoadSpeed, Math.sqrt(radius * RIVAL.cornerAccel * RIVAL.gripFudge)),
  );
}

function _headOn(car: Car, target: IRivalTarget): boolean {
  const toX = car.position.x - target.x;
  const toZ = car.position.z - target.z;
  const along =
    (target.vx * toX + target.vz * toZ) /
    Math.max(1, Math.hypot(toX, toZ) * Math.max(target.speed, 0.1));
  return target.speed > 5 && along > 0.9;
}
