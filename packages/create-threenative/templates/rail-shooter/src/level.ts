import { Vector3 } from "three";

/** The rail's control points, metres: one long S-bend over a grey plain, about 2.1 km. */
export const RAIL_POINTS: readonly Vector3[] = [
  [0, 24, -20],
  [0, 24, 120],
  [35, 28, 260],
  [70, 34, 420],
  [40, 30, 600],
  [-25, 24, 780],
  [-70, 20, 960],
  [-55, 26, 1140],
  [0, 32, 1320],
  [50, 28, 1500],
  [60, 24, 1680],
  [30, 22, 1860],
  [30, 22, 2040],
].map(([x, y, z]) => new Vector3(x, y, z));

/** A step of an enemy path in the rail's frame: metres ahead of the wave's trigger, then right and up. */
export type PathStep = readonly [ahead: number, x: number, y: number];

export type EnemyKind = "scout" | "gunship";

export interface IWave {
  readonly kind: EnemyKind;
  readonly count: number;
  /** Seconds between one enemy and the next on the same path. */
  readonly gap: number;
  readonly path: readonly PathStep[];
  /** The ship reaches this many metres of rail and the wave appears. */
  readonly trigger: number;
  /** A second path for every other enemy, so a wave can split in two. */
  readonly mirror?: boolean;
}

const swoop = (side: number): readonly PathStep[] => [
  [190, 14 * side, 8],
  [140, 10 * side, 3],
  [95, 3 * side, 0],
  [55, -4 * side, -2],
  [10, -13 * side, 2],
  [-60, -18 * side, 6],
];

const cross = (side: number): readonly PathStep[] => [
  [190, 20 * side, 8],
  [150, 9 * side, 3],
  [110, -3 * side, -2],
  [75, -14 * side, -5],
  [25, -20 * side, 0],
  [-50, -22 * side, 4],
];

const weave: readonly PathStep[] = [
  [190, 0, 4],
  [150, 12, 7],
  [110, -12, 1],
  [70, 10, 6],
  [30, -10, -1],
  [-20, 4, 4],
  [-70, 0, 8],
];

export const WAVES: readonly IWave[] = [
  { trigger: 150, kind: "scout", count: 3, gap: 0.55, path: swoop(1) },
  { trigger: 380, kind: "scout", count: 4, gap: 0.5, path: cross(-1), mirror: true },
  { trigger: 620, kind: "gunship", count: 2, gap: 1.2, path: swoop(-1), mirror: true },
  { trigger: 860, kind: "scout", count: 5, gap: 0.45, path: weave },
  { trigger: 1100, kind: "scout", count: 4, gap: 0.5, path: cross(1), mirror: true },
  { trigger: 1350, kind: "gunship", count: 2, gap: 1, path: weave },
  { trigger: 1600, kind: "scout", count: 6, gap: 0.4, path: swoop(1), mirror: true },
];

/** Shield rings: metres along the rail, then right and up in its frame. */
export const PICKUPS: readonly (readonly [s: number, x: number, y: number])[] = [
  [700, -4, 1],
  [1450, 5, -1],
];

/** The ship holds this far before the end of the rail, where the boss waits. */
export const ARENA_BACK = 70;

export const KILLS_TOTAL = WAVES.reduce((sum, wave) => sum + wave.count, 0);

/** The ship starts this far along the rail, so the chase camera has rail behind it. */
export const START_S = 16;
