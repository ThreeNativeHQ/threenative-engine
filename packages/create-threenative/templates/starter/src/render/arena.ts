// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// The prototype test arena every engine opens a new project on, and the one shape every platform
// in it is cut from: a light metre-grid plate on top of a dark-grid body that reaches the ground.
// Two meshes, so the walking surface reads as floor and the sides read as structure — and two
// solids, so the player collides with exactly the triangles they can see.
//
// Every solid here is **placed in the geometry, not on the mesh**, for one reason: `worldGridUVs`
// measures UVs in world metres, and a trimesh collider built from that geometry is the exact
// surface the player sees. Move a solid by rebuilding it here, not by writing `mesh.position` —
// a collider reads the mesh transform and the shape separately, and the two only agree while the
// mesh sits at the origin.
import { type BufferGeometry, CylinderGeometry, Group, Mesh, PlaneGeometry } from "three";
import { floorMaterial, structureMaterial, worldGridUVs } from "./materials.js";
import { roundedBox } from "./shapes.js";

/**
 * The light grid the arena stands on, six metres below the route. Nothing collides with it, which
 * is what makes the gap between the two platforms a real pit rather than scenery underfoot.
 */
export const GROUND_Y = -6;
/** The dark-grid walls that close the arena, and how far the route's own ground sits below them. */
export const ARENA = { halfX: 13, halfZ: 11, thickness: 1, wallTop: 4 } as const;

const PLATE = 0.2;

/** `roundedBox` caches and hands back one instance per size, so a placed copy has to be its own. */
function placed(geometry: BufferGeometry, at: readonly [number, number, number]): BufferGeometry {
  return worldGridUVs(geometry.clone().translate(...at));
}

function meshOf(
  geometry: BufferGeometry,
  at: readonly [number, number, number],
  material: Mesh["material"],
): Mesh {
  const mesh = new Mesh(placed(geometry, at), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** A rounded box: a wall, a pillar, a platform's plate or its body. */
function box(
  size: readonly [number, number, number],
  at: readonly [number, number, number],
  material: Mesh["material"],
  radius: number,
): Mesh {
  return meshOf(roundedBox(size[0], size[1], size[2], radius), at, material);
}

export interface IPlatform {
  /** The authoritative support surface: its top face is the surface's `y`. */
  readonly plate: Mesh;
  /** The dark-grid body under it, running down to `GROUND_Y`. */
  readonly base: Mesh;
}

/** One platform: a light-grid top at `top`, on a dark-grid body that meets the ground. */
export function platform(
  width: number,
  depth: number,
  top: number,
  x: number,
  z: number,
  radius = 0.1,
): IPlatform {
  const height = top - PLATE - GROUND_Y;
  return {
    base: box([width, height, depth], [x, top - PLATE - height / 2, z], structureMaterial, radius),
    plate: box([width, PLATE, depth], [x, top - PLATE / 2, z], floorMaterial, radius),
  };
}

export interface IArena {
  /** Everything static, added in one call. */
  readonly group: Group;
  /**
   * The meshes that must collide. Give each one `CollisionShape3D.fromMesh(mesh, "trimesh")`:
   * the kind is named rather than inferred, because an inferred box of a geometry whose offset is
   * baked in would collide at the world origin.
   */
  readonly solids: Mesh[];
}

/**
 * The ground, the four walls and one pillar. `platform` is deliberately not in here — the two
 * platforms are the course, and the course is gameplay, so the scene places them itself.
 */
export function createArena(): IArena {
  const group = new Group();
  // The ground runs out past the walls to the haze line, so the sky over a wall meets ground and
  // not a void. It is decoration, not floor: it has no collider, and that is the pit under the gap.
  const ground = new Mesh(
    worldGridUVs(new PlaneGeometry(12_000, 12_000).rotateX(-Math.PI / 2)),
    floorMaterial,
  );
  ground.position.y = GROUND_Y;
  ground.receiveShadow = true;
  group.add(ground);
  const height = ARENA.wallTop - GROUND_Y;
  const y = GROUND_Y + height / 2;
  const walls = (
    [
      [
        [ARENA.halfX * 2 + ARENA.thickness, height, ARENA.thickness],
        [0, y, -ARENA.halfZ],
      ],
      [
        [ARENA.halfX * 2 + ARENA.thickness, height, ARENA.thickness],
        [0, y, ARENA.halfZ],
      ],
      [
        [ARENA.thickness, height, ARENA.halfZ * 2 - ARENA.thickness],
        [-ARENA.halfX, y, 0],
      ],
      [
        [ARENA.thickness, height, ARENA.halfZ * 2 - ARENA.thickness],
        [ARENA.halfX, y, 0],
      ],
    ] as const
  ).map(([size, at]) => box(size, at, structureMaterial, 0.14));
  // A tall dark mass behind the route: the course is a corridor, and this is what tells the player
  // where the frame stops. A cylinder rather than a box, so its collider has to be a trimesh.
  const pillar = meshOf(new CylinderGeometry(1.6, 1.6, height, 48), [-9, y, -8], structureMaterial);
  const solids = [...walls, pillar];
  for (const solid of solids) group.add(solid);
  return { group, solids };
}
