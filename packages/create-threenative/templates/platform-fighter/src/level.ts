// The stage, as data. `render/stage.ts` builds the boxes and `sim/stage.ts` collides with the same
// numbers, so a box you see is a box you stand on. One unit is one metre; x runs right, y runs up,
// and both fighters live on the z = 0 plane.

export interface IPlatform {
  readonly x0: number;
  readonly x1: number;
  /** The walkable top. */
  readonly y: number;
}

export interface IMainStage extends IPlatform {
  /** The underside. Fighters bonk on it and on the sides; only the top is walkable. */
  readonly bottom: number;
}

/** A floating block of grid with a ledge on each top corner, and three pass-through platforms. */
export const MAIN: IMainStage = { bottom: -3.6, x0: -7, x1: 7, y: 0 };

/** Pass-through platforms: jump up through them, drop through them with down. */
export const PLATFORMS: readonly IPlatform[] = [
  { x0: -5.6, x1: -2.4, y: 2.6 },
  { x0: 2.4, x1: 5.6, y: 2.6 },
  { x0: -1.6, x1: 1.6, y: 5 },
];

/** Leaving this box loses a stock. */
export const BLAST = { bottom: -14, left: -24, right: 24, top: 18 } as const;

/** Where a fresh match and a respawn put each fighter. */
export const SPAWN = {
  cpu: { x: 3, y: 0 },
  p1: { x: -3, y: 0 },
  respawnHeight: 8,
} as const;

/** Depth of the blocks along z, for the look only. */
export const STAGE_DEPTH = 4;
