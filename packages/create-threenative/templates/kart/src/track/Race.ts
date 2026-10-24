import type { Kart } from "../entities/Kart.js";
import type { ICourse } from "./Course.js";

/** The race's rules, in seconds, laps and lap fractions. */
export const RACE = {
  laps: 3,
  /** "READY", then three lights a second apart, then GO. MK64's pre-roll is 8 s (Decisions). */
  ready: 1,
  light: 1,
  lights: 3,
  /** A fresh throttle press this close before GO is a rocket start (`mk64: src/update_objects.c:3055`). */
  rocketWindow: 8 / 60,
  /** Only crossings this near the line count as crossings (MK64's first or last 20 points). */
  lineReach: 20,
  /** Wrong way: heading 136°–225° off the line for 5 ticks (`cpu_vehicles_camera_path.c:673`). */
  wrongWayCos: Math.cos((136 * Math.PI) / 180),
  wrongWayTicks: 5,
  /** The rubber band, in laps: a CPU this far behind the player catches up; one ahead by more
   * than `ahead + aheadPerPlace·place` lifts off (`cpu_vehicles_camera_path.c:955`). */
  behind: 0.03,
  ahead: 0.06,
  aheadPerPlace: 0.012,
} as const;

export type RacePhase = "countdown" | "race" | "finished";

/** One kart's place in the race: lap, checkpoints, progress and finish. */
export class Racer {
  /** MK64 starts the counter at −1: the grid is behind the line, so its first crossing makes lap 0. */
  lap = -1;
  /** The checkpoint to pass next; all of them count as passed on the grid. */
  next: number;
  progress = 0;
  rank = 0;
  finished = false;
  finishTime = 0;
  /** Checkpoints passed in order this lap, for the HUD and the scenarios. */
  passed = 0;
  /** Laps lost by crossing the line backwards. */
  backCrossings = 0;
  /** Largest jump of the course index in one tick: the window allows −3..+6. */
  maxJump = 0;
  wrongWay = false;
  #wrongTicks = 0;
  #index: number;

  constructor(
    readonly name: string,
    readonly kart: Kart,
    readonly checkpoints: readonly number[],
  ) {
    this.next = checkpoints.length;
    this.#index = kart.index;
  }

  /** Re-reads the kart's place after a scenario moved it, without counting a crossing. */
  resync(): void {
    this.#index = this.kart.index;
  }

  /** The lap shown on the HUD, 1-based and never past the last. */
  get displayLap(): number {
    return Math.max(1, Math.min(RACE.laps, this.lap + 1));
  }

  update(course: ICourse, time: number): void {
    const before = this.#index;
    const after = this.kart.index;
    this.#index = after;
    const count = course.count;
    let jump = after - before;
    if (jump > count / 2) jump -= count;
    if (jump < -count / 2) jump += count;
    this.maxJump = Math.max(this.maxJump, Math.abs(jump));
    if (this.finished) return;

    const near = RACE.lineReach;
    if (before >= count - near && after < near) {
      // Forward over the line: a lap only once every checkpoint was passed in order.
      if (this.next === this.checkpoints.length) {
        this.lap += 1;
        this.next = 0;
        this.passed = 0;
        if (this.lap >= RACE.laps) {
          this.finished = true;
          this.finishTime = time;
        }
      }
    } else if (before < near && after >= count - near) {
      // Backwards over the line takes the lap back; crossing forward again returns it.
      this.lap -= 1;
      this.next = this.checkpoints.length;
      this.backCrossings += 1;
    } else {
      const ahead = this.checkpoints[this.next];
      if (ahead !== undefined && before < ahead && after >= ahead) {
        this.next += 1;
        this.passed += 1;
      }
      const behind = this.checkpoints[this.next - 1];
      if (behind !== undefined && before >= behind && after < behind) {
        this.next -= 1;
        this.passed = Math.max(0, this.passed - 1);
      }
    }
    this.progress = this.lap + after / count;

    // Wrong way: the nose points back along the line.
    const kart = this.kart;
    const facing = -Math.sin(kart.yaw) * course.tx[after]! - Math.cos(kart.yaw) * course.tz[after]!;
    this.#wrongTicks = facing < RACE.wrongWayCos && kart.speed > 1 ? this.#wrongTicks + 1 : 0;
    this.wrongWay = this.#wrongTicks >= RACE.wrongWayTicks;
  }
}

/** Sorts the field: finishers by finish time, then everyone else by progress (`cpu_vehicles_camera_path.c:1126`). */
export function rank(racers: readonly Racer[]): Racer[] {
  const order = [...racers].sort((a, b) => {
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    return b.progress - a.progress;
  });
  order.forEach((racer, i) => {
    racer.rank = i + 1;
  });
  return order;
}

export function ordinal(place: number): string {
  const suffix = place === 1 ? "st" : place === 2 ? "nd" : place === 3 ? "rd" : "th";
  return `${place}${suffix}`;
}
