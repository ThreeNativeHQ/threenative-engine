export type GamePhase = "playing" | "won" | "lost";
export type FlightMode = "cruise" | "boost" | "brake";

export type GameState = {
  /** Set from the UI's pause and resume intents, and read back by the menu. */
  paused: boolean;
  /** True once the UI layer has rendered and published its interactive rectangles. */
  uiReady: boolean;
  phase: GamePhase;
  /** Shield points left, 0 to `shieldMax`. Zero ends the run. */
  shield: number;
  shieldMax: number;
  /** Boost and brake share one gauge, 0 to `gaugeMax`. */
  gauge: number;
  gaugeMax: number;
  /** 1 while the gauge is cooling down and boost and brake are off. */
  gaugeLocked: number;
  mode: FlightMode;
  /** Rail speed, m/s. */
  speed: number;
  /** Metres flown along the rail, and the rail's length. */
  railS: number;
  railLength: number;
  /** Where the ship sits in the corridor around the rail, metres. */
  offsetX: number;
  offsetY: number;
  /** Bank angle in degrees, positive leaning left. */
  bank: number;
  /** 1 while a barrel roll turns shots back. */
  rolling: number;
  rolls: number;
  deflected: number;
  /** Where the reticle floats relative to the nose, metres. */
  aimX: number;
  aimY: number;
  /** Lasers fired, laser and homing hits that landed. */
  shots: number;
  hits: number;
  /** The charged shot's charge, 0 to 1, and the id of the target it has marked. */
  charge: number;
  locked: string;
  homingShots: number;
  lockedKills: number;
  /** Waves that have appeared, enemies alive, kills and the most kills the rail holds. */
  wave: number;
  enemiesLive: number;
  kills: number;
  killsTotal: number;
  /** Enemy shots fired this run. */
  enemyShots: number;
  score: number;
  pickups: number;
  /** 0 before the boss, then 1 (armoured), 2 (core open), 3 (core raging). */
  bossPhase: number;
  /** Weak points the boss still has: its pods, then its core. */
  bossPods: number;
  bossHp: number;
  /** A short message the HUD shows for a moment. */
  message: string;
  /** Seconds since the run began. */
  missionTime: number;
};
