export type GameState = {
  coyoteJumps: number;
  entityCount: number;
  flagDisplacement: number;
  flagGusts: number;
  flagReadbacks: number;
  flagSteps: number;
  jumps: number;
  levelX: number;
  lives: number;
  odometer: number;
  /** Set from the UI's pause and resume intents, and read back by the menu. */
  paused: boolean;
  /** True once the UI layer has rendered and published its interactive rectangles. */
  uiReady: boolean;
  peakRise: number;
  playerX: number;
  progress: number;
  respawns: number;
  score: number;
  /** The run: "playing" until the flag is reached ("won") or the last life is gone ("lost"). */
  status: "lost" | "playing" | "won";
};
