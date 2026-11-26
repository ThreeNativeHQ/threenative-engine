export type GamePhase = "playing" | "won" | "lost";

export type GameState = {
  /** Set from the UI's pause and resume intents, and read back by the menu. */
  paused: boolean;
  /** True once the UI layer has rendered and published its interactive rectangles. */
  uiReady: boolean;
  phase: GamePhase;
  stance: "stand" | "crouch" | "prone";
  /** Eye height in metres, eased between stances. */
  eyeHeight: number;
  /** Horizontal speed in m/s. */
  speed: number;
  sprinting: number;
  /** Seconds of sprint budget left. */
  sprintBudget: number;
  aiming: number;
  /** The field of view in degrees. */
  fov: number;
  /** The shot cone half-angle in degrees, and the accumulator behind it (0..255). */
  spread: number;
  spreadPoints: number;
  /** View kick in degrees. */
  kickPitch: number;
  ammo: number;
  reserve: number;
  reloading: number;
  grenades: number;
  /** Seconds left on the grenade in flight; 0 when none is. */
  fuse: number;
  shield: number;
  health: number;
  /** Ticks left before the shield recharges. */
  shieldStun: number;
  shots: number;
  hits: number;
  kills: number;
  /** Rounds taken and rounds that hit cover instead of the player. */
  hitsTaken: number;
  blockedShots: number;
  /** 1 for a moment after a round hits a soldier. */
  marker: number;
  /** The chance to hit of the latest round a soldier aimed, 0..1. */
  lastAccuracy: number;
  enemiesLeft: number;
  /** A short message the HUD shows for a moment. */
  message: string;
  /** Seconds since the round began. */
  time: number;
};
