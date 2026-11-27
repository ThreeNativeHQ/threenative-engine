// Dash: four lanes, one start light. Run right after GO. A runner who moves before GO freezes for a
// second (a false start). The first across the line wins. The CPU runners wait a reaction time after GO
// and run at a speed drawn from the shared stream. No card pins the numbers: they are the kit's own.
import type { Stream } from "../rng.js";
import { ARENA, type IContestant, type IMiniInput, type IMinigame } from "./minigame.js";

const START_X = -9;
const FINISH_X = 9;
const LANE = 2.4;
/** Seconds of the false-start freeze. */
export const FALSE_START_FREEZE = 1;
/** The human runs at this speed, m/s. The CPU speed is 4.6 to 5.6, so a clean start always wins. */
const HUMAN_SPEED = 6;

export class Dash implements IMinigame {
  readonly id = "dash" as const;
  readonly title = "Dash";
  readonly rule = "Wait for GO, then hold right. Run early and you freeze.";
  readonly contestants: IContestant[] = [];
  time = 0;
  done = false;
  winner = -1;
  /** The start light is green. */
  go = false;
  falseStarts = 0;
  readonly #goAt: number;
  #frozen = 0;
  readonly #delay: number[] = [0];
  readonly #speed: number[] = [HUMAN_SPEED];

  constructor(rng: Stream) {
    this.#goAt = 1.6 + (rng.percent() / 100) * 1.4;
    for (let seat = 0; seat < 4; seat += 1) {
      this.contestants.push({
        x: START_X,
        z: ARENA.z + (1.5 - seat) * LANE,
        y: 0,
        yaw: Math.PI / 2,
        pose: "idle",
      });
      if (seat === 0) continue;
      const roll = rng.percent() / 100;
      this.#delay.push(0.15 + 0.2 * roll);
      this.#speed.push(4.6 + roll);
    }
  }

  update(dt: number, input: IMiniInput): void {
    if (this.done) return;
    this.time += dt;
    if (!this.go && this.time >= this.#goAt) this.go = true;
    const human = this.contestants[0] as IContestant;
    human.pose = "idle";
    if (this.#frozen > 0) this.#frozen = Math.max(0, this.#frozen - dt);
    else if (input.run > 0.5) {
      if (!this.go) {
        this.falseStarts += 1;
        this.#frozen = FALSE_START_FREEZE;
      } else {
        human.x += HUMAN_SPEED * dt;
        human.pose = "run";
      }
    }
    for (let seat = 1; seat < 4; seat += 1) {
      const cpu = this.contestants[seat] as IContestant;
      const running = this.go && this.time - this.#goAt >= (this.#delay[seat] as number);
      cpu.pose = running ? "run" : "idle";
      if (running) cpu.x += (this.#speed[seat] as number) * dt;
    }
    let lead = 0;
    for (const [seat, contestant] of this.contestants.entries())
      if (contestant.x > (this.contestants[lead] as IContestant).x) lead = seat;
    if ((this.contestants[lead] as IContestant).x < FINISH_X) return;
    this.done = true;
    this.winner = lead;
    for (const [seat, contestant] of this.contestants.entries())
      contestant.pose = seat === lead ? "cheer" : "idle";
  }
}

export const DASH_FINISH_X = FINISH_X;
export const DASH_START_X = START_X;
