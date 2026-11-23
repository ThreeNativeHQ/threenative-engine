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
  /** The lowest value the loading bar painted during the latest load; a restart resets it to 1. */
  loadLowest: number;
  odometer: number;
  /** True on a console (`isConsole()`): the menu shows pad prompts instead of keyboard ones. */
  pad: boolean;
  /** Set from the UI's pause and resume intents, and read back by the menu. */
  paused: boolean;
  /** True once the UI layer has rendered and published its interactive rectangles. */
  uiReady: boolean;
  peakRise: number;
  playerX: number;
  progress: number;
  respawns: number;
  /** Set on resume when the run saved on the last background is in `localStorage`. */
  restored: boolean;
  /** Runs saved by `applicationPaused`: a phone may reclaim a game while it is away. */
  saves: number;
  score: number;
  /** The run: "playing" until the flag is reached ("won") or the last life is gone ("lost"). */
  status: "lost" | "playing" | "won";
};
