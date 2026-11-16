export type RaceStatus = "DNF" | "RACING" | "WON";

export function resolveRaceStatus(
  currentStatus: RaceStatus,
  completedLaps: number,
  totalLaps: number,
  playerPlace: number,
): RaceStatus {
  if (currentStatus !== "RACING" || completedLaps < totalLaps) return currentStatus;
  return playerPlace === 1 ? "WON" : "DNF";
}

export type GameState = {
  /** True while the closed-loop demo driver has the wheel. A scenario asserts it drove. */
  autopilot: boolean;
  /** Set from the UI\'s pause and resume intents, and read back by the menu. */
  paused: boolean;
  /** True once the UI layer has rendered and published its interactive rectangles. */
  uiReady: boolean;
  boostActive: boolean;
  boostPeakSpeed: number;
  speedAfterBoost: number;
  boostUses: number;
  /** The handbrake drift: in a scored slide, its slip angle in radians, and the banked score. */
  drifting: boolean;
  driftAngle: number;
  driftScore: number;
  driftsBanked: number;
  driftSpins: number;
  /** The nitro tank, 0 to 1, and whether it is burning. */
  nitro: number;
  nitroActive: boolean;
  /** Tank the drift path filled this race, which is what "drifting refills faster" is measured on. */
  nitroDriftGain: number;
  /** The gearbox: the gear engaged and the needle, 0 to 1 of that gear's band. Display only. */
  gear: number;
  rpm: number;
  /** The last banked drift's score, which the HUD pops up for a moment after each one. */
  driftLast: number;
  /**
   * Seconds that popup still shows, in game time: the drift owns the clock, so a pause freezes the
   * popup instead of ageing it while the car is standing still.
   */
  driftPopup: number;
  /** The camera's lens: its reading now, and the widest it has been — the nitro kick, measured. */
  fov: number;
  fovPeak: number;
  /** The engine loop's playback rate: the sound follows the revs where the runtime allows it. */
  engineRate: number;
  completedLaps: number;
  elapsed: number;
  lastOnRoad: [number, number, number];
  place: number;
  /** Cars in the race, the player included: the HUD's "P3 / 6". */
  racers: number;
  position: string;
  raceStatus: RaceStatus;
  rescueHeading: number;
  rescueHeadingError: number;
  rescuePositionError: number;
  rescues: number;
  shortcutRejects: number;
  speed: number;
  topSpeed: number;
  totalLaps: number;
  trackProgress: number;
  reverseRejects: number;
  sameDistanceRanking: string;
};
