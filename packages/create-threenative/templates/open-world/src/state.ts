import { CITY_HALF, ROADS, ROAD_WIDTH, roadLine } from "./city/layout.js";

export type BlipKind =
  | "cop"
  | "mission"
  | "dropoff"
  | "respray"
  | "hospital"
  | "police"
  | "phone"
  | "money";

/** One dot on the radar; `id` keeps React's node for the same thing across updates. */
export type Blip = { id: string; kind: BlipKind; x: number; z: number };

export type Phase = "playing" | "wasted" | "busted";
export type JobState = "idle" | "pickup" | "deliver" | "passed" | "failed";

export type GameState = {
  /** Set from the UI's pause and resume intents, and read back by the menu. */
  paused: boolean;
  /** True once the UI layer has rendered and published its interactive rectangles. */
  uiReady: boolean;
  phase: Phase;
  /** The big centred word: WASTED, BUSTED, JOB DONE, or "". */
  banner: string;
  /** The context line at the bottom: what the nearest interaction does. */
  prompt: string;
  money: number;
  health: number;
  stars: number;
  starsFlashing: boolean;
  chaos: number;
  mode: "foot" | "entering" | "driving" | "exiting" | "dead";
  weapon: "fist" | "pistol";
  ammo: number;
  clip: number;
  speedKmh: number;
  carHealth: number;
  job: JobState;
  jobTime: number;
  jobsDone: number;
  carjacks: number;
  crimes: number;
  evasions: number;
  resprays: number;
  wasted: number;
  busted: number;
  pedsDown: number;
  copsOnFoot: number;
  policeCars: number;
  trafficBlocked: number;
  pickups: number;
  playerX: number;
  playerZ: number;
  cameraYaw: number;
  blips: Blip[];
  /** Road centre lines (both axes), their half-length and width: the radar's street grid. */
  roads: number[];
  roadHalf: number;
  roadWidth: number;
  /** True while the pistol is up; the reticle sits on the locked target, -1 when there is none. */
  aiming: boolean;
  locked: boolean;
  reticleX: number;
  reticleY: number;
};

export const INITIAL_STATE: GameState = {
  aiming: false,
  ammo: 48,
  locked: false,
  banner: "",
  blips: [],
  busted: 0,
  cameraYaw: 0,
  carHealth: 0,
  carjacks: 0,
  chaos: 0,
  clip: 12,
  copsOnFoot: 0,
  crimes: 0,
  evasions: 0,
  health: 100,
  job: "idle",
  jobTime: 0,
  jobsDone: 0,
  mode: "foot",
  money: 1200,
  paused: false,
  pedsDown: 0,
  phase: "playing",
  pickups: 0,
  playerX: 0,
  playerZ: 0,
  policeCars: 0,
  prompt: "",
  resprays: 0,
  reticleX: -1,
  reticleY: -1,
  roadHalf: CITY_HALF,
  roadWidth: ROAD_WIDTH,
  roads: Array.from({ length: ROADS }, (_, index) => roadLine(index)),
  speedKmh: 0,
  stars: 0,
  starsFlashing: false,
  trafficBlocked: 0,
  uiReady: false,
  wasted: 0,
  weapon: "fist",
};
