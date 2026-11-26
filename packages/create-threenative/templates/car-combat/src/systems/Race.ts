// The race rules around the cars: the clock, the gates, the laps and how a run ends.
// The card has no checkpoint or lap rules, so every number here is kit tuning.
import { GATES, ROAD_HALF, gateAt } from "../arena/layout.js";

export const RACE = {
  /** Seconds on the clock at the start. */
  startTime: 45,
  /** Seconds each gate adds. */
  gateBonus: 20,
  laps: 2,
} as const;

export type Phase = "playing" | "won" | "lost";
export type WinBy = "none" | "wreck" | "laps";

export class Race {
  phase: Phase = "playing";
  winBy: WinBy = "none";
  banner = "";
  timeLeft: number = RACE.startTime;
  /** 1-based lap the player is on. */
  lap = 1;
  /** The gate to cross next. Gate 0 is the finish line. */
  nextGate = 1;
  gatesPassed = 0;
  bonusTotal = 0;
  /** Signed distance past the next gate's plane on the previous tick. */
  #previous: number | undefined;

  /** Advances the clock and the gates. Returns the index of a gate crossed this tick, or -1. */
  update(dt: number, x: number, z: number): number {
    if (this.phase !== "playing") return -1;
    this.timeLeft = Math.max(0, this.timeLeft - dt);
    if (this.timeLeft === 0) {
      this.#end("lost", "none", "TIME UP");
      return -1;
    }
    const gate = gateAt(this.nextGate);
    const dx = x - gate.x;
    const dz = z - gate.z;
    const along = dx * gate.fx + dz * gate.fz;
    const across = dx * -gate.fz + dz * gate.fx;
    const crossed =
      this.#previous !== undefined &&
      this.#previous < 0 &&
      along >= 0 &&
      along < 12 &&
      Math.abs(across) < ROAD_HALF + 3;
    this.#previous = along;
    if (!crossed) return -1;
    const index = this.nextGate;
    this.gatesPassed += 1;
    this.timeLeft += RACE.gateBonus;
    this.bonusTotal += RACE.gateBonus;
    this.nextGate = (this.nextGate + 1) % GATES;
    this.#previous = undefined;
    if (index === 0) {
      this.lap += 1;
      if (this.lap > RACE.laps) this.#end("won", "laps", "RACE WON");
    }
    return index;
  }

  /** The player is wrecked. */
  wrecked(): void {
    if (this.phase === "playing") this.#end("lost", "none", "WRECKED");
  }

  /** Every rival is wrecked. */
  rivalsWrecked(): void {
    if (this.phase === "playing") this.#end("won", "wreck", "ALL RIVALS WRECKED");
  }

  /** Jumps the race to a state (a playtest station). */
  set(state: {
    readonly lap?: number;
    readonly nextGate?: number;
    readonly timeLeft?: number;
  }): void {
    if (state.lap !== undefined) this.lap = state.lap;
    if (state.nextGate !== undefined) this.nextGate = state.nextGate;
    if (state.timeLeft !== undefined) this.timeLeft = state.timeLeft;
    this.#previous = undefined;
  }

  #end(phase: Phase, winBy: WinBy, banner: string): void {
    this.phase = phase;
    this.winBy = winBy;
    this.banner = banner;
  }

  debug(): Record<string, unknown> {
    return {
      banner: this.banner,
      bonusTotal: this.bonusTotal,
      gatesPassed: this.gatesPassed,
      lap: this.lap,
      nextGate: this.nextGate,
      phase: this.phase,
      timeLeft: Math.ceil(this.timeLeft),
      winBy: this.winBy,
    };
  }
}
