// The proving ground, as data. `render/arena.ts` turns it into meshes and colliders, the scene turns
// the posts into soldiers. Change the level here: one table, and the look, the collision and the
// cover that blocks fire follow it.
//
// Scale: one unit is one metre. The yard is 48 m by 36 m, long enough for a full sprint budget.

/** A box: centre x/z on the floor, size along x, height, size along z. */
export type Box = readonly [x: number, z: number, width: number, height: number, depth: number];

export const ARENA = { halfWidth: 24, halfDepth: 18, wallHeight: 3 } as const;

/**
 * Low cover stands 1.0 m. A standing chest is at 1.2 m and clears it. A crouched chest (0.8 m) and
 * a prone one (0.2 m) sit behind it, so a round aimed at them hits the wall and stops there.
 */
export const LOW_COVER_HEIGHT = 1;

/** Cover the player uses: low walls south of the middle. */
export const LOW_WALLS: readonly Box[] = [
  [-8, 9, 6, LOW_COVER_HEIGHT, 0.5],
  [8, 9, 6, LOW_COVER_HEIGHT, 0.5],
  [0, 5.5, 4, LOW_COVER_HEIGHT, 0.5],
  // Cover the soldiers use, in front of their posts.
  [-9, -3, 4, LOW_COVER_HEIGHT, 0.5],
  [9, -3, 4, LOW_COVER_HEIGHT, 0.5],
  [0, -5, 6, LOW_COVER_HEIGHT, 0.5],
];

/** Full-height structure: flank walls and crates that hide everyone. */
export const HIGH_WALLS: readonly Box[] = [
  [-14, 2, 0.5, 2.4, 8],
  [14, 2, 0.5, 2.4, 8],
  [-4, -10, 2, 2.2, 2],
  [5, -11, 2, 2.2, 2],
];

export const SPAWN = { x: 0, z: 15, yaw: 0 } as const;

export type Post = {
  readonly id: string;
  readonly x: number;
  readonly z: number;
};

/** Where each soldier holds. The first three stand behind the low walls above. */
export const POSTS: readonly Post[] = [
  { id: "west", x: -9, z: -4.1 },
  { id: "east", x: 9, z: -4.1 },
  { id: "centre", x: 0, z: -6.1 },
  { id: "far-west", x: -8, z: -12 },
  { id: "far-east", x: 10, z: -13 },
];
