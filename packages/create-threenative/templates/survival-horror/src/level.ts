// The mansion wing as data: rooms, the doors between them, the fixed camera of every zone, and
// what lies where. `src/render/mansion.ts` turns it into meshes and `scenes/Play.ts` into colliders
// and interactions, so moving a door or a camera is one edit here.
//
// Plan, metres, +x east and +z south (towards the save room's camera):
//
//   save room A  x -8..-2, z -3..3     hall B      x 0..18,  z -2..2
//   study C      x 11..19, z -11..-5   exit hall D x -1..7,  z 4..9
//
// Rooms never touch. A door is a panel on a wall, and walking through it is a transition, as in the
// classic games: the room behind it is loaded, so to speak, while the screen is black.

export type RoomId = "save" | "hall" | "study" | "exit";
export type ItemId = "handgun" | "ammo" | "herb" | "mixed" | "key" | "ribbon";

export interface IRoom {
  readonly id: RoomId;
  readonly label: string;
  readonly min: readonly [number, number];
  readonly max: readonly [number, number];
}

export interface IDoor {
  readonly id: string;
  readonly room: RoomId;
  /** The panel's centre on the wall, floor level. */
  readonly at: readonly [number, number];
  /** Unit vector from the wall into the room, on the floor plane. */
  readonly inward: readonly [number, number];
  /** The door on the other side; `"outside"` is the way out of the wing. */
  readonly to: string;
  /** The item that opens it. A key is used up once it has opened its door. */
  readonly lock?: ItemId;
}

/**
 * One fixed camera and the floor rectangle it owns. `track: true` keeps the lens in place but turns
 * it to the player, the panning shot of a long corridor; otherwise the frame never moves.
 */
export interface ICameraZone {
  readonly id: string;
  readonly room: RoomId;
  readonly min: readonly [number, number];
  readonly max: readonly [number, number];
  readonly eye: readonly [number, number, number];
  readonly look: readonly [number, number, number];
  readonly fov: number;
  readonly track?: boolean;
}

export interface IPickup {
  readonly id: string;
  readonly item: ItemId;
  readonly quantity: number;
  /** World position of the item, on top of whatever it rests on. */
  readonly at: readonly [number, number, number];
}

/** Furniture is solid: it is a collider as well as a mesh. */
export interface IFurniture {
  readonly id: string;
  readonly kind: "table" | "typewriter" | "box" | "shelf";
  readonly min: readonly [number, number];
  readonly max: readonly [number, number];
  readonly height: number;
}

export interface IZombieSpawn {
  readonly id: string;
  readonly room: RoomId;
  readonly at: readonly [number, number];
  /** Heading in radians; the model faces +z at 0. */
  readonly facing: number;
  /** The one that gets back up the first time it goes down. */
  readonly rises?: boolean;
}

export const WALL_HEIGHT = 3;
export const WALL_THICKNESS = 0.4;

export const ROOMS: readonly IRoom[] = [
  { id: "save", label: "Save room", min: [-8, -3], max: [-2, 3] },
  { id: "hall", label: "East hall", min: [0, -2], max: [18, 2] },
  { id: "study", label: "Study", min: [11, -11], max: [19, -5] },
  { id: "exit", label: "Back hall", min: [-1, 4], max: [7, 9] },
];

export const DOORS: readonly IDoor[] = [
  { id: "save-east", room: "save", at: [-2, 0], inward: [-1, 0], to: "hall-west" },
  { id: "hall-west", room: "hall", at: [0, 0], inward: [1, 0], to: "save-east" },
  { id: "hall-north", room: "hall", at: [15, -2], inward: [0, 1], to: "study-south" },
  { id: "study-south", room: "study", at: [15, -5], inward: [0, -1], to: "hall-north" },
  { id: "hall-south", room: "hall", at: [3, 2], inward: [0, -1], to: "exit-north", lock: "key" },
  { id: "exit-north", room: "exit", at: [3, 4], inward: [0, 1], to: "hall-south" },
  { id: "exit-south", room: "exit", at: [3, 9], inward: [0, -1], to: "outside" },
];

// Every lens sits inside its room, below the wall tops, so nothing solid ever stands between it and
// the player (the kit contract's `camera-sees-subject` row). The hall is two zones shot back to back
// from its middle: the survivor walks toward the lens, passes under it at x = 9 and the cut shows
// their back. Tank controls keep "up" meaning "forward" through the cut.
export const CAMERA_ZONES: readonly ICameraZone[] = [
  // The save room is cut in two: the door half is shot from the far corner, the desk half from the
  // corner over the door, so the typewriter and the item box are never under the lens.
  {
    id: "save-door",
    room: "save",
    min: [-5, -3],
    max: [-2, 3],
    eye: [-7.6, 2.75, 2.6],
    look: [-3.6, 0.4, -0.6],
    fov: 60,
  },
  {
    id: "save-desk",
    room: "save",
    min: [-8, -3],
    max: [-5, 3],
    eye: [-2.5, 2.75, -2.6],
    look: [-6.6, 0.4, 0.4],
    fov: 60,
  },
  {
    id: "hall-west",
    room: "hall",
    min: [0, -2],
    max: [9, 2],
    eye: [8.7, 2.75, 1.6],
    look: [2, 0.5, -0.4],
    fov: 58,
  },
  {
    id: "hall-east",
    room: "hall",
    min: [9, -2],
    max: [18, 2],
    eye: [9.3, 2.75, 1.6],
    look: [16, 0.4, -0.6],
    fov: 58,
  },
  {
    id: "study",
    room: "study",
    min: [11, -11],
    max: [19, -5],
    eye: [11.5, 2.8, -5.5],
    look: [16, 0.4, -9.6],
    fov: 62,
  },
  {
    id: "exit",
    room: "exit",
    min: [-1, 4],
    max: [7, 9],
    eye: [6.5, 2.7, 4.5],
    look: [2, 0.6, 7.6],
    fov: 60,
    track: true,
  },
];

export const FURNITURE: readonly IFurniture[] = [
  { id: "supply-table", kind: "table", min: [-4.4, -3], max: [-2.8, -2.2], height: 0.8 },
  { id: "item-box", kind: "box", min: [-8, -1.6], max: [-7.3, -0.6], height: 0.7 },
  { id: "typewriter", kind: "typewriter", min: [-8, 0.5], max: [-7.2, 1.5], height: 0.75 },
  { id: "hall-console", kind: "table", min: [8.4, -2], max: [9.6, -1.5], height: 0.8 },
  { id: "study-desk", kind: "table", min: [16.6, -11], max: [18.6, -10.1], height: 0.8 },
  { id: "study-shelf", kind: "shelf", min: [11, -8.2], max: [11.5, -6.4], height: 2.2 },
];

export const PICKUPS: readonly IPickup[] = [
  // The save room's cache: one more than the case holds, so the first visit teaches the six slots.
  // The ribbon sits at the front edge, the herbs either side, the bullets join the stack carried.
  { id: "save-ribbon", item: "ribbon", quantity: 2, at: [-3.4, 0.84, -2.4] },
  { id: "save-herb-1", item: "herb", quantity: 1, at: [-2.95, 0.84, -2.35] },
  { id: "save-herb-2", item: "herb", quantity: 1, at: [-3.0, 0.84, -2.7] },
  { id: "save-ammo", item: "ammo", quantity: 15, at: [-3.85, 0.84, -2.7] },
  { id: "save-herb-3", item: "herb", quantity: 1, at: [-4.25, 0.84, -2.7] },
  { id: "hall-ammo", item: "ammo", quantity: 15, at: [9, 0.84, -1.75] },
  { id: "hall-herb", item: "herb", quantity: 1, at: [17.4, 0.05, 1.5] },
  { id: "study-key", item: "key", quantity: 1, at: [17.6, 0.84, -10.55] },
  { id: "study-ammo", item: "ammo", quantity: 15, at: [17, 0.84, -10.55] },
];

export const ZOMBIES: readonly IZombieSpawn[] = [
  // The first one in the hall is the one that gets back up — the scare every classic game opens on.
  { id: "zombie.hall", room: "hall", at: [5.5, -0.4], facing: -Math.PI / 2, rises: true },
  { id: "zombie.hall-far", room: "hall", at: [14, 1], facing: Math.PI },
  { id: "zombie.study", room: "study", at: [12.6, -9.4], facing: Math.PI / 2 },
  { id: "zombie.exit", room: "exit", at: [6, 8.2], facing: -Math.PI / 2 },
];

/** Where a new game starts: the save room, facing its door. */
export const SPAWN = { room: "save" as RoomId, at: [-3.4, 0] as const, facing: Math.PI / 2 };

export function roomAt(x: number, z: number): IRoom | undefined {
  return ROOMS.find(
    (room) => x >= room.min[0] && x <= room.max[0] && z >= room.min[1] && z <= room.max[1],
  );
}

export function doorById(id: string): IDoor {
  const door = DOORS.find((entry) => entry.id === id);
  if (door === undefined) throw new Error(`Unknown door '${id}'.`);
  return door;
}

const ZONE_MARGIN = 0.35;

/**
 * The zone that owns a floor point. The current zone wins while the player is still within its
 * margin, so standing on a boundary never flickers between two cuts.
 */
export function zoneAt(x: number, z: number, current?: ICameraZone): ICameraZone | undefined {
  const inside = (zone: ICameraZone, margin: number) =>
    x >= zone.min[0] - margin &&
    x <= zone.max[0] + margin &&
    z >= zone.min[1] - margin &&
    z <= zone.max[1] + margin;
  if (current !== undefined && inside(current, ZONE_MARGIN)) return current;
  return CAMERA_ZONES.find((zone) => inside(zone, 0)) ?? current;
}
