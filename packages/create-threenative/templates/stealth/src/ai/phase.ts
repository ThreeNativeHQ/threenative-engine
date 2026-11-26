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
  #unseen = 0;

  /** Someone saw the player outright: the whole base goes to Alert and learns where. */
  spotted(x: number, z: number): PhaseChange | undefined {
    this.lastKnown.x = x;
    this.lastKnown.z = z;
    this.hasLastKnown = true;
    this.#unseen = 0;
    if (this.phase === "alert") return undefined;
    const from = this.phase;
    this.phase = "alert";
    this.timer = 0;
    this.alerts += 1;
    return { from, to: "alert" };
  }

  /**
   * Something is wrong but nobody saw the player — a body was found. The base searches the spot
   * (Evasion) without learning where the player is. Does nothing during Alert.
   */
  disturbance(x: number, z: number): PhaseChange | undefined {
    if (this.phase === "alert") return undefined;
    this.lastKnown.x = x;
    this.lastKnown.z = z;
    this.hasLastKnown = true;
    const from = this.phase;
    this.phase = "evasion";
    this.timer = EVASION_TIME;
    return from === "evasion" ? undefined : { from, to: "evasion" };
  }

  /** Advance the clocks. `seen` is whether any guard or camera saw the player this tick. */
  update(dt: number, seen: boolean): PhaseChange | undefined {
    if (this.phase === "alert") {
      this.#unseen = seen ? 0 : this.#unseen + dt;
      if (this.#unseen < LOSE_SIGHT_TIME) return undefined;
      this.phase = "evasion";
      this.timer = EVASION_TIME;
      return { from: "alert", to: "evasion" };
    }
    if (this.phase === "infiltration") return undefined;
    this.timer = Math.max(0, this.timer - dt);
    if (this.timer > 0) return undefined;
    if (this.phase === "evasion") {
      this.phase = "caution";
      this.timer = CAUTION_TIME;
      return { from: "evasion", to: "caution" };
    }
    this.phase = "infiltration";
    this.hasLastKnown = false;
    return { from: "caution", to: "infiltration" };
  }
}
