// The compound, as data. `render/compound.ts` turns it into meshes and colliders, the scene turns
// the patrols and anchors into guards, cameras and pickups. Change the level here: one table, and
// the look, the collision and the AI follow it.
//
// Scale: one unit is one metre. The compound is 44 m by 32 m — about two and a half times the
// floor of an MGS1 room seen from its overhead camera, which is why every distance borrowed from
// the reference cards in this kit is scaled by 2.5 where it says so.

/** A box: centre x/z on the floor, size along x, height, size along z. */
export type Box = readonly [x: number, z: number, width: number, height: number, depth: number];

export const COMPOUND = { halfWidth: 22, halfDepth: 16, wallHeight: 3 } as const;

/** Full-height walls inside the perimeter (the perimeter itself is built from `COMPOUND`). */
export const WALLS: readonly Box[] = [
  // The north wall of the courtyard, with a 2.4 m gap at x = 0 that the locked door fills.
  [-11.6, -6, 20.8, 3, 0.4],
  [11.6, -6, 20.8, 3, 0.4],
  // The records room in the west: east wall with a doorway between z = -1.2 and z = 1.2.
  [-12, -3.6, 0.4, 3, 4.8],
  [-12, 4.4, 0.4, 3, 6.4],
  // Its south wall.
  [-17, 7.4, 10.4, 3, 0.4],
  // The yard fence in the east, open at both ends so a patrol can loop through it.
  [10, 6, 0.4, 3, 6],
];

/**
 * Cover. Low crates (1.1 m) hide a crouched player and not a standing one, because the guard's eye
 * is at 1.6 m and the crouched chest at 0.55 m: the sight line from a guard a few metres away
 * clips the crate's top edge only when the player is down. Tall crates hide everyone.
 */
export const CRATES: readonly Box[] = [
  [-4, 8, 1.2, 1.1, 1.2],
  [-2.6, 8.3, 1.2, 1.1, 1.2],
  [5, 0.5, 1.2, 1.1, 2.6],
  [-7, -1, 1.4, 2.2, 1.4],
  [3, 11, 2.4, 2.2, 1.4],
  [15, 3, 1.2, 1.1, 1.2],
  [17.5, 12.5, 2, 2.2, 2],
  [-18, 11.5, 1.4, 1.1, 2.4],
];

/**
 * Shadow pools: floor rectangles [x, z, width, depth]. A player standing in one is much harder to
 * see (`SHADOW_VISIBILITY` in `ai/perception.ts`). They are painted dark so the player can read them.
 */
export const SHADOWS: readonly (readonly [number, number, number, number])[] = [
  [-8, 10, 5, 4],
  [13.5, -2.5, 5, 5],
  [-17, 3, 4, 3],
];

export const SPAWN = { x: 0, z: 13.5 } as const;

/** The keycard lies on a table in the records room. */
export const KEYCARD = { x: -20, z: -4.5, tableHeight: 0.9 } as const;

/** The locked door in the courtyard's north wall, and the extraction pad behind it. */
export const DOOR = { x: 0, z: -6, width: 2.4 } as const;
export const EXTRACTION = { x: 0, z: -12.5, radius: 1.6 } as const;

export type PatrolPoint = {
  readonly x: number;
  readonly z: number;
  /** Seconds the guard stands here, looking left and right, before walking on. */
  readonly pause: number;
};

export type Patrol = {
  readonly id: string;
  /** The route is a loop: after the last point the guard walks back to the first. */
  readonly route: readonly PatrolPoint[];
};

export const PATROLS: readonly Patrol[] = [
  {
    id: "courtyard",
    route: [
      { x: -6, z: 4, pause: 2.5 },
      { x: 9, z: 4, pause: 2.5 },
    ],
  },
  {
    id: "gate",
    route: [
      { x: -7, z: -3.5, pause: 3 },
      { x: 7, z: -3.5, pause: 3 },
    ],
  },
  {
    id: "records",
    route: [
      { x: -19.5, z: -2, pause: 2 },
      { x: -14.5, z: -2, pause: 0 },
      { x: -14.5, z: 4, pause: 2 },
      { x: -19.5, z: 4, pause: 0 },
    ],
  },
  {
    id: "yard",
    route: [
      { x: 13, z: 13, pause: 1.5 },
      { x: 19.5, z: 13, pause: 0 },
      { x: 19.5, z: 0, pause: 2 },
      { x: 13, z: 0, pause: 0 },
    ],
  },
];

/** A wall-mounted security camera: where it hangs, the yaw it sweeps around, and how far. */
export const CAMERAS: readonly {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly height: number;
  /** Yaw at the centre of the sweep, radians, three.js convention (0 faces +z). */
  readonly yaw: number;
  /** Half the sweep, radians. */
  readonly sweep: number;
}[] = [{ id: "camera.west", x: -11.6, z: 7.1, height: 2.7, yaw: Math.PI * 0.75, sweep: 0.9 }];
