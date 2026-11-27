// The proving ground's meshes, built from the tables in `src/level.ts`.
//
// Everything in `solid` becomes a fixed trimesh collider (the scene hands it to
// `buildStaticColliders`), so a round and a footstep meet exactly the walls the player sees.
import { Group, Mesh, PlaneGeometry } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { ARENA, type Box, HIGH_WALLS, LOW_COVER_HEIGHT, LOW_WALLS } from "../level.js";
import { floorMaterial, propMaterial, structureMaterial, worldGridUVs } from "./materials.js";

const BEVEL = 0.03;

export interface IArena {
  /** Walls and cover: what blocks feet and rounds. */
  readonly solid: Group;
  /** The floor: drawn, not collided with. */
  readonly dressing: Group;
}

export function createArena(): IArena {
  const solid = new Group();
  solid.name = "arena-solid";
  const dressing = new Group();
  dressing.name = "arena-dressing";
  const block = ([x, z, width, height, depth]: Box, material = structureMaterial): void => {
    const geometry = new RoundedBoxGeometry(width, height, depth, 2, BEVEL);
    geometry.translate(x, height / 2 - BEVEL, z);
    const mesh = new Mesh(worldGridUVs(geometry), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    solid.add(mesh);
  };
  const { halfWidth, halfDepth, wallHeight } = ARENA;
  for (const box of [
    [0, -halfDepth, halfWidth * 2 + 0.4, wallHeight, 0.4],
    [0, halfDepth, halfWidth * 2 + 0.4, wallHeight, 0.4],
    [-halfWidth, 0, 0.4, wallHeight, halfDepth * 2],
    [halfWidth, 0, 0.4, wallHeight, halfDepth * 2],
  ] as const satisfies readonly Box[])
    block(box);
  for (const wall of HIGH_WALLS) block(wall);
  // The colour you can touch marks the cover you can use: the low walls.
  for (const wall of LOW_WALLS)
    block(wall, wall[3] <= LOW_COVER_HEIGHT ? propMaterial : structureMaterial);

  const floor = new Mesh(
    worldGridUVs(new PlaneGeometry(halfWidth * 2 + 40, halfDepth * 2 + 40).rotateX(-Math.PI / 2)),
    floorMaterial,
  );
  floor.receiveShadow = true;
  dressing.add(floor);
  return { solid, dressing };
}
