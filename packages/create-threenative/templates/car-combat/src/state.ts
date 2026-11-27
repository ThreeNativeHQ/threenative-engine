import { GATES } from "./arena/layout.js";
import { RACE } from "./systems/Race.js";

export type Phase = "playing" | "won" | "lost";

/** What the HUD reads. The simulation stays the one truth: the UI only displays this. */
export type GameState = {
  /** Set from the UI's pause and resume intents, and read back by the menu. */
  paused: boolean;
  /** True once the UI layer has rendered and published its interactive rectangles. */
  uiReady: boolean;
  phase: Phase;
  /** The big centred word: TIME UP, WRECKED, RACE WON, ALL RIVALS WRECKED, or "". */
  banner: string;
  winBy: "none" | "wreck" | "laps";
  /** The line at the bottom: what the car is doing that the player should know. */
  prompt: string;
  timeLeft: number;
  lap: number;
  laps: number;
  nextGate: number;
  gates: number;
  gatesPassed: number;
  bonusTotal: number;
  /** Seconds the "+20" flash stays up after a gate. */
  bonusFlash: number;
  speedKmh: number;
  rpm: number;
  redline: number;
  gear: number;
  slipping: boolean;
  /** Share of the drive force the tyres can pass on, 0..100. */
  traction: number;
  /** Per part damage, 0..99. */
  engine: number;
  transmission: number;
  driver: number;
  wheels: number;
  brakes: number;
  /** Per panel crumple, 0..100. */
  crushFront: number;
  crushRear: number;
  crushLeft: number;
  crushRight: number;
  /** The worst of engine, transmission and driver, as a share left, 0..100. */
  health: number;
  repairing: boolean;
  rivalsWrecked: number;
  rivalsTotal: number;
  /** How many rivals hold each objective right now. */
  pursuing: number;
  rammed: number;
  playerX: number;
  playerZ: number;
  cameraYaw: number;
};

export const INITIAL_STATE: GameState = {
  banner: "",
  bonusFlash: 0,
  bonusTotal: 0,
  brakes: 0,
  cameraYaw: 0,
  crushFront: 0,
  crushLeft: 0,
  crushRear: 0,
  crushRight: 0,
  driver: 0,
  engine: 0,
  gates: GATES,
  gatesPassed: 0,
  gear: 0,
  health: 100,
  lap: 1,
  laps: RACE.laps,
  nextGate: 1,
  paused: false,
  phase: "playing",
  playerX: 0,
  playerZ: 0,
  prompt: "",
  pursuing: 0,
  rammed: 0,
  redline: 7500,
  repairing: false,
  rivalsTotal: 3,
  rivalsWrecked: 0,
  rpm: 900,
  slipping: false,
  speedKmh: 0,
  timeLeft: RACE.startTime,
  traction: 100,
  transmission: 0,
  uiReady: false,
  wheels: 0,
  winBy: "none",
};
