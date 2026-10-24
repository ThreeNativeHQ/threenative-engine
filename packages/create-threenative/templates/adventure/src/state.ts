/**
 * What the game publishes. The HUD reads it through the UI bridge and the playtests read it as the
 * `state` resource, so every number a scenario proves is one the player could also see or feel.
 */
/** The doorways Wren respawns at: her start, and the last one she came through. */
export type Checkpoint = "clearing" | "hollow-entry" | "cave-exit" | "warden-door";

export type GameState = {
  /** Hearts left, in hearts: 2.5 is two and a half. One hit costs a half-heart. */
  hearts: number;
  /** Heart capacity, in hearts. The heart vessel adds one. */
  capacity: number;
  /** Where Wren last came back after losing every heart, or "" before the first time. */
  lastRespawn: Checkpoint | "";
  /** Small keys carried. The locked door spends one. */
  keys: number;
  /** True once the Ember Blade is out of the clearing chest. */
  sword: boolean;
  /** The text of the nearest thing `interact` would use, or "" when there is none in reach. */
  prompt: string;
  /** A line under the HUD for a moment: the signpost text, "THE GRATE OPENS", "HEART VESSEL!". */
  toast: string;
  /** Where Wren is: the clearing or the dungeon. The dungeon is walked a little slower. */
  zone: "vale" | "hollow";
  /** The entity the lock-on holds, or "" when nothing is locked. */
  lockTarget: string;
  /** Counters the playtests prove the loop with. */
  slashes: number;
  slashHits: number;
  shieldBlocks: number;
  hitsTaken: number;
  respawns: number;
  defeated: number;
  wardenStuns: number;
  wardenHealth: number;
  /** Measured feel: fastest ground speed, last stop time and last 180° turn time, in m/s and s. */
  topSpeed: number;
  stopSeconds: number;
  turnSeconds: number;
  /** While strafing a locked target: the worst drift from the held distance (m), and the time. */
  lockStrafeDrift: number;
  lockStrafeSeconds: number;
  /** The worst angle between Wren's facing and the locked target while locked, in degrees. */
  lockFacingError: number;
  /** Puzzle state. */
  blockSteps: number;
  grateOpen: boolean;
  doorOpen: boolean;
  /** True once the heart vessel is taken: the dungeon is done. */
  cleared: boolean;
  paused: boolean;
  uiReady: boolean;
};
