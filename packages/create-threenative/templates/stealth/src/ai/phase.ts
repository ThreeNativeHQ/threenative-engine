// The base-wide alert phase: one commander for the whole compound.
//
// Reference: metal-gear-solid-1 `alert-escalation` — per-guard alert values feed a three-stage
// commander (normal, alert, evasion) that raises and clears the global alert; the evasion
// countdown is 300 frames (10 s at 30 Hz). Caution is the later series' fourth stage: after
// evasion the base stays wary for a while before it relaxes. Both timers are tuned here.
import type { AlertPhase } from "../state.js";

/** Seconds every guard must go without seeing the player before Alert drops to Evasion. */
export const LOSE_SIGHT_TIME = 3;
/** Evasion: guards search the last known position. MGS1: 300 frames at 30 Hz. */
export const EVASION_TIME = 10;
/** Caution: patrols resume, faster and wider-eyed. */
export const CAUTION_TIME = 20;

export type PhaseChange = { readonly from: AlertPhase; readonly to: AlertPhase };

export class AlertDirector {
  phase: AlertPhase = "infiltration";
  /** Seconds left in Evasion or Caution. */
  timer = 0;
  /** How many times the base went to Alert. */
  alerts = 0;
  /** Where the player was last seen by anyone, world x/z. Valid once `hasLastKnown`. */
  readonly lastKnown = { x: 0, z: 0 };
  hasLastKnown = false;
  /**
   * Every phase change since the scene last drained this list, in order. A guard that calls
   * `spotted` mid-tick and the clock in `update` both land here, so one reader sees them all.
   */
  readonly changes: PhaseChange[] = [];
  #unseen = 0;

  #enter(to: AlertPhase, timer: number): void {
    this.changes.push({ from: this.phase, to });
    this.phase = to;
    this.timer = timer;
  }

  /** Someone saw the player outright: the whole base goes to Alert and learns where. */
  spotted(x: number, z: number): void {
    this.lastKnown.x = x;
    this.lastKnown.z = z;
    this.hasLastKnown = true;
    this.#unseen = 0;
    if (this.phase === "alert") return;
    this.alerts += 1;
    this.#enter("alert", 0);
  }

  /**
   * Something is wrong but nobody saw the player — a body was found. The base searches the spot
   * (Evasion) without learning where the player is. Does nothing during Alert.
   */
  disturbance(x: number, z: number): void {
    if (this.phase === "alert") return;
    this.lastKnown.x = x;
    this.lastKnown.z = z;
    this.hasLastKnown = true;
    if (this.phase === "evasion") this.timer = EVASION_TIME;
    else this.#enter("evasion", EVASION_TIME);
  }

  /** Advance the clocks. `seen` is whether any guard or camera saw the player this tick. */
  update(dt: number, seen: boolean): void {
    if (this.phase === "alert") {
      this.#unseen = seen ? 0 : this.#unseen + dt;
      if (this.#unseen >= LOSE_SIGHT_TIME) this.#enter("evasion", EVASION_TIME);
      return;
    }
    if (this.phase === "infiltration") return;
    this.timer = Math.max(0, this.timer - dt);
    if (this.timer > 0) return;
    if (this.phase === "evasion") this.#enter("caution", CAUTION_TIME);
    else {
      this.hasLastKnown = false;
      this.#enter("infiltration", 0);
    }
  }
}
