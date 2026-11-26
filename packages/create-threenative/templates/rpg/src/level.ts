// The map, as data. `render/camp.ts` turns it into meshes and colliders, the scene turns the
// actors into figures. Change the level here: one table, and the look and the collision follow.
// One unit is one metre.

/** A box: centre x/z on the floor, size along x, height, size along z. */
export type Box = readonly [x: number, z: number, width: number, height: number, depth: number];

/** The playable field: 44 m by 36 m. A low rim keeps the party inside. */
export const FIELD = { halfWidth: 22, halfDepth: 18, wallHeight: 1.6 } as const;

/** The ruin in the north: a walled yard with one gap in its south wall, facing the camp. */
export const RUIN_WALLS: readonly Box[] = [
  [-6.5, -7.5, 11, 2.2, 0.5],
  [6.5, -7.5, 11, 2.2, 0.5],
  [0, -16.5, 24, 2.2, 0.5],
  [-12, -12, 0.5, 2.2, 9],
  [12, -12, 0.5, 2.2, 9],
  [-3, -12, 1.2, 1.2, 1.2],
  [3.5, -13.5, 1.8, 1.2, 1.2],
];

/** Crates round the camp. Low ones (1.1 m) are cover to look at, solid to walk into. */
export const CAMP_CRATES: readonly Box[] = [
  [-13, 12, 1.4, 1.1, 1.4],
  [-13, 13.5, 1.4, 1.1, 1.4],
  [14, 11, 1.8, 1.1, 1.2],
  [12, 15.5, 1.2, 1.1, 1.2],
];

/** Tents: x, z, radius of the base, yaw in radians. */
export const TENTS: readonly (readonly [number, number, number, number])[] = [
  [-8, 14.5, 1.7, 0.4],
  [9, 8, 1.9, -0.3],
  [-4, 6.5, 1.5, 0.8],
];

export const FIRE = { x: 0, z: 9 } as const;
export const SPAWN = { x: 0, z: 13 } as const;
/** The training post: a placeable, so its defense is the flat 10 of the card, and it never fights back. */
export const POST = { x: -10, z: 8 } as const;

export type Team = "party" | "raider" | "villager";

export interface IActorSpec {
  readonly id: string;
  readonly name: string;
  readonly team: Team;
  readonly x: number;
  readonly z: number;
  /** Facing yaw, three.js convention (0 faces +z). */
  readonly yaw: number;
  readonly tint: number;
  /** The dialogue tree a villager opens on talk. */
  readonly tree?: string;
}

export const ACTORS: readonly IActorSpec[] = [
  { id: "hero", name: "Kael", team: "party", tint: 0x3d6b8e, x: SPAWN.x, z: SPAWN.z, yaw: Math.PI },
  { id: "ally", name: "Tarn", team: "party", tint: 0x8e6b3d, x: -1.5, z: 15.5, yaw: Math.PI },
  {
    id: "elder",
    name: "Oska",
    team: "villager",
    tint: 0x6a5b7a,
    x: 5.5,
    z: 10.5,
    yaw: -Math.PI / 2,
    tree: "elder",
  },
  {
    id: "wanderer",
    name: "Wren",
    team: "villager",
    tint: 0x4f8a6a,
    x: -6.5,
    z: 10.5,
    yaw: Math.PI / 2,
    tree: "hire",
  },
  {
    id: "sellsword",
    name: "Brask",
    team: "villager",
    tint: 0x8a4f4f,
    x: 8,
    z: 13.5,
    yaw: Math.PI,
    tree: "hire",
  },
  { id: "raider.1", name: "Raider", team: "raider", tint: 0x7a2a22, x: -4.5, z: -13, yaw: 0 },
  { id: "raider.2", name: "Raider", team: "raider", tint: 0x7a2a22, x: 5, z: -11.2, yaw: 0 },
  { id: "raider.3", name: "Raider", team: "raider", tint: 0x7a2a22, x: 0.5, z: -14.8, yaw: 0 },
];
