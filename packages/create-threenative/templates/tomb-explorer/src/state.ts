import type { LaraState } from "./sim/body.js";

export type GamePhase = "playing" | "won" | "lost";

export type GameState = {
  /** Set from the UI's pause and resume intents, and read back by the menu. */
  paused: boolean;
  /** True once the UI layer has rendered and published its interactive rectangles. */
  uiReady: boolean;
  phase: GamePhase;
  /** The body's state machine: idle, run, jump, hang, climb, swim, dead, ... */
  mode: LaraState;
  /** Health out of 1000 and air out of 1800: the reference engine's own pools. */
  health: number;
  air: number;
  /** World units, rounded: the playtests read where she is. y is the feet (the centre while swimming). */
  playerX: number;
  playerY: number;
  playerZ: number;
  /** Signed turn rate in angle units per update, and the lean it mirrors into. */
  turnRate: number;
  lean: number;
  /** Heights she has been hurt from: the last landing speed, and the damage that cost. */
  landingSpeed: number;
  fallDamage: number;
  /** Counters the playtests read. */
  jumps: number;
  grabs: number;
  hangs: number;
  climbs: number;
  bladeHits: number;
  /** 1 once the relic is in hand. */
  relic: number;
  /** Why she died: "", "fall", "drown" or "blade". */
  cause: string;
  /** The interaction available right now, as a HUD prompt; "" for none. */
  prompt: string;
  /** A short message the HUD shows for a moment. */
  message: string;
  /** Seconds since the run began. */
  time: number;
};
