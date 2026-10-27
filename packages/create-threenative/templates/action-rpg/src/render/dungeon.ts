// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// Three rooms in a row, cut from the prototype test scene: a light metre-grid floor, dark-grid
// walls, bevelled pillars, and a doorway between each pair. The layout is the same three rooms the
// game has always had — the same x-range, the same spawn, the same boss at the far end — so every
// scenario and every state path still describes real behaviour; only the masonry is new.
//
// **One `Group` per room.** The scene hands each one to `buildStaticColliders`, so a room is the
// unit of both the look and the collision: a designer who cuts a fourth room out of this file gets
// a fourth room that is solid, with nothing else to remember.
import { Group, Mesh, type Object3D, PlaneGeometry, PointLight, SphereGeometry } from "three";
import {
  flameMaterial,
  floorMaterial,
  propMaterial,
  structureMaterial,
  worldGridUVs,
} from "./materials.js";
import { BEVEL, bakeByMaterial, solidBox } from "./props.js";

/** Where each room starts, and how long it is. Room 1 is the spawn, room 3 holds the boss. */
export const ROOM_LENGTH = 12;
export const ROOM_CENTRES = [-6, 6, 18] as const;
const ROOM_HALF_DEPTH = 6;
/** North and south walls; the south one is low so the top-down camera can see over it. */
const NORTH_WALL = 5.2;
// A kerb on purpose: the camera sits over this wall, and a ray from the lens to a player who stands
// against it crosses the wall at about 0.9 m, so a taller wall hides the player.
const SOUTH_WALL = 0.6;
const WALL_THICKNESS = 0.5;
const DOOR_HALF_WIDTH = 2;
const DOOR_HEIGHT = 3;
const FLOOR_THICKNESS = 0.3;
/** The sun's shadow map is fitted to this box, and the dungeon is centred on it. */
export const DUNGEON_CENTRE = 6;

export interface IDungeon {
  /** Everything static, added in one call. */
  readonly group: Group;
  /** One per room, in room order: hand each to `buildStaticColliders`. */
  readonly rooms: Group[];
}

/**
 * A wall torch: a bracket, an emissive flame, and the point light that sells it. The light is
 * the only warm source in the frame, so it is what tells you which wall the room's other end is.
 */
function addTorch(room: Group, x: number, wallZ: number, inward: number, mount = 2.25): void {
  const bracket = solidBox([0.1, 0.1, 0.5], [x, mount, wallZ + inward * 0.25], structureMaterial);
  bracket.name = "torch-bracket";
  room.add(bracket);
  const flame = new Mesh(new SphereGeometry(0.13, 8, 6), flameMaterial);
  flame.name = "torch-flame";
  flame.scale.y = 1.6;
  flame.position.set(x, mount + 0.2, wallZ + inward * 0.45);
  room.add(flame);
  const light = new PointLight(0xffb066, 6, 9, 2);
  light.position.set(x, mount + 0.25, wallZ + inward * 0.7);
  room.add(light);
}

/** The cross wall between two rooms, split around a doorway with a lintel over it. */
function addDoorway(room: Group, x: number): void {
  // Two wall segments and one gap: 2 x (halfDepth - doorHalfWidth) + 2 x doorHalfWidth is exactly
  // the room's depth, so the gap is a real hole and not a gap with a wall through it.
  const segment = ROOM_HALF_DEPTH - DOOR_HALF_WIDTH;
  for (const direction of [-1, 1]) {
    const wall = solidBox(
      [WALL_THICKNESS, NORTH_WALL, segment],
      [x, 0, direction * (DOOR_HALF_WIDTH + segment / 2)],
      structureMaterial,
    );
    wall.name = "cross-wall";
    room.add(wall);
  }
  const lintel = solidBox(
    [WALL_THICKNESS, NORTH_WALL - DOOR_HEIGHT, DOOR_HALF_WIDTH * 2],
    [x, DOOR_HEIGHT, 0],
    structureMaterial,
  );
  lintel.name = "door-lintel";
  room.add(lintel);
  // The one saturated colour, on the threshold: from a top-down camera this is the line that says
  // "this is the way through", which a gap between two grey walls does not. It carries no collider
  // — a painted line you trip over is not a doorway.
  const threshold = solidBox(
    [WALL_THICKNESS, 0.04, DOOR_HALF_WIDTH * 2],
    [x, 0.01, 0],
    propMaterial,
    0.01,
  );
  threshold.name = "door-threshold";
  threshold.castShadow = false;
  room.add(threshold);
}

export function createDungeon(): IDungeon {
  const group = new Group();
  group.name = "three-room-dungeon";
  // The ground runs out past the walls to the haze line, so the sky over a wall meets ground and
  // not a void. It is decoration, not floor: it lives outside every room group, so
  // `buildStaticColliders` never sees it and a 12 km plane never becomes a trimesh.
  const ground = new Mesh(
    worldGridUVs(new PlaneGeometry(12_000, 12_000).rotateX(-Math.PI / 2)),
    floorMaterial,
  );
  ground.position.y = -FLOOR_THICKNESS;
  ground.receiveShadow = true;
  group.add(ground);

  const rooms: Group[] = [];
  ROOM_CENTRES.forEach((centre, index) => {
    const room = new Group();
    room.name = `room-${index + 1}`;
    // The flat top lands on y = 0: the box sinks by its bevel radius, so its resting line is
    // radius below the surface it is meant to show.
    const floor = solidBox(
      [ROOM_LENGTH, FLOOR_THICKNESS, ROOM_HALF_DEPTH * 2],
      [centre, BEVEL - FLOOR_THICKNESS, 0],
      floorMaterial,
    );
    floor.name = "dungeon-floor";
    room.add(floor);
    for (const [height, z] of [
      [NORTH_WALL, -ROOM_HALF_DEPTH],
      [SOUTH_WALL, ROOM_HALF_DEPTH],
    ] as const) {
      const wall = solidBox(
        [ROOM_LENGTH, height, WALL_THICKNESS],
        [centre, 0, z],
        structureMaterial,
      );
      wall.name = z < 0 ? "north-wall" : "south-wall";
      room.add(wall);
    }
    if (index === 0) {
      const west = solidBox(
        [WALL_THICKNESS, NORTH_WALL, ROOM_HALF_DEPTH * 2],
        [centre - ROOM_LENGTH / 2, 0, 0],
        structureMaterial,
      );
      west.name = "west-wall";
      room.add(west);
    }
    if (index === ROOM_CENTRES.length - 1) {
      const east = solidBox(
        [WALL_THICKNESS, NORTH_WALL, ROOM_HALF_DEPTH * 2],
        [centre + ROOM_LENGTH / 2, 0, 0],
        structureMaterial,
      );
      east.name = "east-wall";
      room.add(east);
    } else {
      addDoorway(room, centre + ROOM_LENGTH / 2);
    }
    // A standing pillar, not a wall stub: the top-down camera reads its cap as a circle, and its
    // shadow as the one soft shape in a frame of hard bevelled edges.
    for (const [dx, z] of [
      [-3, -4.2],
      [3, 4.2],
    ] as const) {
      const pillar = solidBox([0.7, 3.6, 0.7], [centre + dx, 0, z], structureMaterial, 0.12);
      pillar.name = "room-pillar";
      room.add(pillar);
    }
    if (index === 0) {
      // The cover the line-of-sight assertion is about: a hostile behind it never aggros, and one
      // in the open always does.
      const cover = solidBox([2.4, 2.1, 0.5], [-8, 0, -1.5], structureMaterial);
      cover.name = "line-of-sight-wall";
      room.add(cover);
    }
    addTorch(room, centre - 2.5, -ROOM_HALF_DEPTH, 1);
    addTorch(room, centre + 2.5, ROOM_HALF_DEPTH, -1, SOUTH_WALL + 0.05);
    // Torches and brackets never move relative to their room, so they bake down to one mesh per
    // material; the floor, walls, pillars and doorway stay separate objects, because those are the
    // ones a playtest looks up by name and the ones a trimesh body is built from.
    const dressing = room.children.filter(
      (child): child is Mesh => child instanceof Mesh && child.name.startsWith("torch-"),
    );
    bakeByMaterial(dressing, room, "torch-dressing");
    rooms.push(room);
    group.add(room);
  });
  return { group, rooms };
}

/** Everything under `root` that a trimesh body should be built from. */
export function isSolid(object: Object3D): boolean {
  return (
    object instanceof Mesh && !object.name.startsWith("torch-") && object.name !== "door-threshold"
  );
}
