import type { RacePhase } from "./track/Race.js";

export interface IResult {
  readonly place: number;
  readonly name: string;
  /** Race time in seconds; 0 while that driver is still racing. */
  readonly time: number;
  readonly player: boolean;
}

export interface IMapDot {
  readonly x: number;
  readonly y: number;
  readonly colour: string;
  readonly player: boolean;
}

export type GameState = {
  /** True once startup is ready and the loading cover lifts; the HUD stays hidden until then. */
  loaded?: boolean;
  phase: RacePhase;
  /** 3, 2, 1 while the lamps light, 0 for the second of GO, −1 after. */
  countdown: number;
  /** The player's lap on the HUD, 1-based, and the race's lap count. */
  lap: number;
  laps: number;
  place: number;
  racers: number;
  /** Race seconds since GO. */
  time: number;
  /** The player's completed lap times, seconds. */
  lapTimes: number[];
  /** The item in hand, `rolling` while the roulette spins, `""` for none. */
  item: string;
  /** Speed as the HUD shows it, km/h. */
  speed: number;
  /** Mini-turbo stage of the player's drift, 0 to 3. */
  driftStage: number;
  toast: string;
  wrongWay: boolean;
  /** The minimap: the course as one SVG path in a 100 × 100 box, and a dot per kart. */
  mapPath: string;
  mapDots: IMapDot[];
  /** Everyone's place once the player finishes, then as the CPUs cross the line. */
  results: IResult[];
  finishedCount: number;
  /** True while the player's kart drives itself (P toggles it; it takes over at the finish). */
  autopilot: boolean;
  /** Set from the UI's pause and resume intents, and read back by the menu. */
  paused: boolean;
  /** True once the UI layer has rendered and published its interactive rectangles. */
  uiReady: boolean;
};
