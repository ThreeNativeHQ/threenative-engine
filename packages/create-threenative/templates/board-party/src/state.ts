/** How the match ends for the human seat: first place wins, anything else loses. */
export type GamePhase = "playing" | "won" | "lost";

/** The beats of a turn. The match owns the machine; the HUD only reads it. */
export type TurnPhase =
  | "roll"
  | "rolling"
  | "junction"
  | "walk"
  | "star"
  | "award"
  | "settle"
  | "intro"
  | "minigame"
  | "result"
  | "over";

/** One seat's row on the scoreboard. `chain` and `slot` are the cursor, `space` the space index. */
export type PlayerRow = {
  readonly name: string;
  readonly human: number;
  readonly coins: number;
  readonly stars: number;
  readonly space: number;
  readonly chain: number;
  readonly slot: number;
};

export type GameState = {
  /** Set from the UI's pause and resume intents, and read back by the menu. */
  paused: boolean;
  /** True once the UI layer has rendered and published its interactive rectangles. */
  uiReady: boolean;
  phase: GamePhase;
  /** Seconds of match play, counted only once the first frames have compiled. */
  time: number;
  turn: number;
  turnLimit: number;
  /** The seat whose turn it is, 0 to 3. Seat 0 is the human. */
  active: number;
  turnPhase: TurnPhase;
  /** The last die shown, 1 to 10; 0 before the first roll. */
  die: number;
  stepsLeft: number;
  /** The question waiting for the human: "", "junction" or "star". */
  prompt: string;
  /** A short message the HUD shows for a moment, such as "+3 coins". */
  message: string;
  /** The space index that holds the live star. */
  starSpace: number;
  players: PlayerRow[];
  /** "", "dash" or "rope". */
  miniId: string;
  /** Dash: the start light is green. */
  miniGo: number;
  /** Dash: times the human ran before GO. */
  miniFalseStarts: number;
  miniDone: number;
  /** The seat that won the minigame, or -1. */
  miniWinner: number;
  /** Rope: 1 per seat still standing. */
  miniAlive: number[];
  /** Seats best first, once the match is over. */
  ranking: number[];
};
