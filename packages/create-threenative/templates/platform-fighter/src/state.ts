export type MatchPhase = "playing" | "won" | "lost";

/** One fighter as the HUD and the playtests read it. Numbers are rounded to the centimetre. */
export type FighterState = {
  percent: number;
  stocks: number;
  /** "free", "attack", "shield", "hitstun", "dodge", "ledge", "getup", "stun", "squat" or "dead". */
  mode: string;
  /** "startup", "active", "recovery" or "charge" during an attack; "" otherwise. */
  phase: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Highest feet height since the fighter last left the floor. */
  peakY: number;
  grounded: number;
  jumps: number;
  fastFalling: number;
  /** 1 while intangible: a roll, a get-up, a respawn, a fresh ledge grab. */
  intangible: number;
  /** Shield health, 0..55, and its bubble size, 0.65..1. */
  shield: number;
  shieldSize: number;
  /** Frames a strong attack has been charged. */
  charge: number;
  /** -1, 0 or 1: the ledge held. */
  ledge: number;
  weight: number;
  hits: number;
  blocks: number;
  shieldBreaks: number;
  ledgeGrabs: number;
  getups: number;
  dodges: number;
  doubleJumps: number;
  fastFalls: number;
  kos: number;
};

export type LastHit = {
  victim: string;
  damage: number;
  /** Knockback units from the formula, the hitstun frames it asks for, and the frames the victim really lost. */
  knockback: number;
  hitstun: number;
  measuredHitstun: number;
  weight: number;
  percentAfter: number;
};

export type GameState = {
  paused: boolean;
  uiReady: boolean;
  phase: MatchPhase;
  p1: FighterState;
  cpu: FighterState;
  last: LastHit;
  /** Seconds since the match began. */
  time: number;
  /** A short message the HUD shows for a moment, such as "GO" or "KO". */
  message: string;
  camera: { distance: number; x: number; y: number };
  /** 1 while the CPU stands still (a playtest punching bag). */
  cpuDummy: number;
};
