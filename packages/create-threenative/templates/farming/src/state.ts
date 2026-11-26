import type { ISummary } from "./farm/Farm.js";
import type { CropId } from "./farm/crops.js";

/** `playing` is the day, `fainting` the collapse before the night screen, `summary` the night screen. */
export type GamePhase = "playing" | "fainting" | "summary";

/** What the tile in front of the farmer is, for the HUD and the playtests. */
export type TargetKind =
  | "none"
  | "plain"
  | "tilled"
  | "watered"
  | "seedling"
  | "growing"
  | "ripe"
  | "dead"
  | "weed"
  | "rock";

export type GameState = {
  /** Set from the UI's pause and resume intents, and read back by the menu. */
  paused: boolean;
  /** True once the UI layer has rendered and published its interactive rectangles. */
  uiReady: boolean;
  phase: GamePhase;

  /** Days since the first spring morning. */
  dayIndex: number;
  /** Day of the season, 1 to 30, and the season, the weekday and the year. */
  day: number;
  season: string;
  weekday: string;
  year: number;
  /** Minutes since midnight of the current day: 360 at wake-up, 1560 at the faint hour. */
  minute: number;
  /** "06:00". */
  clock: string;
  /** The sun's height above the horizon in degrees; negative at night. */
  sunElevation: number;
  /** The key light's strength in lux: 6 at noon, 0.1 under the moon. */
  lightLux: number;

  money: number;
  stamina: number;
  /** 0 fresh to 3 spent. */
  tier: number;
  /** The farmer's planar speed now, metres a second. */
  speed: number;
  water: number;

  /** The selected hotbar slot, 0 to 6, and its label. */
  slot: number;
  slotLabel: string;
  seeds: Record<CropId, number>;
  carrying: string;
  binCount: number;
  binValue: number;

  tilled: number;
  watered: number;
  planted: number;
  ripe: number;
  dead: number;
  weeds: number;
  rocks: number;
  /** Watered days summed over every living crop. */
  stageSum: number;

  targetCol: number;
  targetRow: number;
  targetKind: TargetKind;

  /** The interaction E would run, and a short message the HUD shows for a moment. */
  prompt: string;
  message: string;
  sleeps: number;
  faints: number;
  /** The night screen, or null while the day runs. */
  summary: ISummary | null;
  playerX: number;
  playerZ: number;
  /** Seconds of play this session. */
  playTime: number;
};
