// Rope: a bar sweeps round the arena at floor height and speeds up. Jump as it comes or be knocked out.
// The last one standing wins. At the time cap the lowest seat still standing wins. No card pins the
// numbers: they are the kit's own. A CPU decides once per approach whether it will jump, as a percent
// roll on the shared stream (the cpu-decision-walk idea), then jumps at a fixed lead before the bar.
import type { Stream } from "../rng.js";
import { ARENA, type IContestant, type IMiniInput, type IMinigame } from "./minigame.js";

const SEAT_RADIUS = 3.2;
export const ROPE_REACH = 5;
const TAU = Math.PI * 2;
/** Half the bar's width as an angle, radians: about half a metre at the seats. */
const HIT_HALF = 0.16;
const JUMP_SPEED = 5.5;
const GRAVITY = 16;
/** A contestant this high clears the bar: the hop is above this for 0.5 s of its 0.69 s. */
const CLEAR_HEIGHT = 0.45;
/** Seconds before the bar arrives that a CPU jumps: mid-hop when the bar passes. */
const CPU_LEAD = 0.32;
/** Percent chance a CPU jumps on an approach. */
const CPU_SKILL = 85;
const START_SPEED = 1.1;
const SPEED_RAMP = 0.15;
const TIME_CAP = 15;

function wrapPositive(angle: number): number {
  return ((angle % TAU) + TAU) % TAU;
}

export class Rope implements IMinigame {
  readonly id = "rope" as const;
  readonly title = "Rope";
  readonly rule = "Press confirm to hop the bar. Last one standing wins.";
  readonly contestants: IContestant[] = [];
  time = 0;
  done = false;
  winner = -1;
  /** The bar's angle round the arena, radians. */
  angle: number;
  readonly alive = [true, true, true, true];
  readonly #seatAngle: number[] = [];
  readonly #vy = [0, 0, 0, 0];
  readonly #armed = [false, false, false, false];
  readonly #will = [false, false, false, false];
  readonly #rng: Stream;
  readonly #perfect: boolean;

  /** `perfect` makes every CPU jump every time: a playtest uses it to make the human the only loser. */
  constructor(rng: Stream, perfect = false) {
    this.#rng = rng;
    this.#perfect = perfect;
    for (let seat = 0; seat < 4; seat += 1) {
      const theta = Math.PI / 2 + (seat * Math.PI) / 2;
      this.#seatAngle.push(theta);
      const x = ARENA.x + SEAT_RADIUS * Math.cos(theta);
      const z = ARENA.z + SEAT_RADIUS * Math.sin(theta);
      this.contestants.push({
        x,
        z,
        y: 0,
        yaw: Math.atan2(ARENA.x - x, ARENA.z - z),
        pose: "idle",
      });
    }
    this.angle = (this.#seatAngle[0] as number) - 2;
  }

  /** The bar's speed now, radians per second. */
  get speed(): number {
    return START_SPEED + SPEED_RAMP * this.time;
  }

  update(dt: number, input: IMiniInput): void {
    if (this.done) return;
    this.time += dt;
    const speed = this.speed;
    this.angle += speed * dt;
    for (let seat = 0; seat < 4; seat += 1) {
      const body = this.contestants[seat] as IContestant;
      if (!this.alive[seat]) continue;
      const theta = this.#seatAngle[seat] as number;
      if (seat === 0 ? input.jump : this.#cpuJumps(seat, theta, speed)) this.#hop(seat);
      this.#vy[seat] = (this.#vy[seat] as number) - GRAVITY * dt;
      body.y = Math.max(0, body.y + (this.#vy[seat] as number) * dt);
      if (body.y === 0) this.#vy[seat] = 0;
      body.pose = body.y > 0.02 ? "jump" : "idle";
      const gap = Math.abs(wrapPositive(this.angle - theta + Math.PI) - Math.PI);
      if (gap < HIT_HALF && body.y < CLEAR_HEIGHT) {
        this.alive[seat] = false;
        body.pose = "down";
      }
    }
    const standing = this.alive.flatMap((up, seat) => (up ? [seat] : []));
    if (standing.length <= 1 || this.time >= TIME_CAP) {
      this.done = true;
      this.winner = standing[0] ?? 0;
      (this.contestants[this.winner] as IContestant).pose = "cheer";
    }
  }

  #hop(seat: number): void {
    if ((this.contestants[seat] as IContestant).y === 0) this.#vy[seat] = JUMP_SPEED;
  }

  #cpuJumps(seat: number, theta: number, speed: number): boolean {
    const ahead = wrapPositive(theta - this.angle);
    if (ahead > Math.PI) {
      if (!this.#armed[seat]) {
        this.#armed[seat] = true;
        this.#will[seat] = this.#perfect || this.#rng.percent() < CPU_SKILL;
      }
      return false;
    }
    if (!this.#armed[seat] || ahead >= speed * CPU_LEAD) return false;
    this.#armed[seat] = false;
    return this.#will[seat] as boolean;
  }
}
