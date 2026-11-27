// Generated for you. The camp and the ruin, built from the tables in `src/level.ts`.
//
// Everything in `solid` becomes a fixed trimesh collider (the scene hands it to
// `buildStaticColliders`), so a footstep meets exactly the walls the player sees.
import { Group, Mesh, PlaneGeometry } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { type Box, CAMP_CRATES, FIELD, FIRE, POST, RUIN_WALLS, TENTS } from "../level.js";
import { floorMaterial, propMaterial, structureMaterial, worldGridUVs } from "./materials.js";
import { createFire, createPost, createTent } from "./props.js";

const BEVEL = 0.03;

export interface ICamp {
  /** Walls and crates: what blocks feet. */
  readonly solid: Group;
  /** Floor, tents, fire, post: drawn, not collided with. */
  readonly dressing: Group;
}

export function createCamp(): ICamp {
  const solid = new Group();
  solid.name = "camp-solid";
  const dressing = new Group();
  dressing.name = "camp-dressing";
  const block = ([x, z, width, height, depth]: Box, material = structureMaterial): void => {
    const geometry = new RoundedBoxGeometry(width, height, depth, 2, BEVEL);
    geometry.translate(x, height / 2 - BEVEL, z);
    const mesh = new Mesh(worldGridUVs(geometry), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    solid.add(mesh);
  };
  const { halfWidth, halfDepth, wallHeight } = FIELD;
  for (const box of [
    [0, -halfDepth, halfWidth * 2 + 0.4, wallHeight, 0.4],
    [0, halfDepth, halfWidth * 2 + 0.4, wallHeight, 0.4],
    [-halfWidth, 0, 0.4, wallHeight, halfDepth * 2],
    [halfWidth, 0, 0.4, wallHeight, halfDepth * 2],
  ] as const satisfies readonly Box[])
    block(box);
  for (const wall of RUIN_WALLS) block(wall, wall[3] < 1.5 ? propMaterial : structureMaterial);
  for (const crate of CAMP_CRATES) block(crate, propMaterial);

  const floor = new Mesh(
    worldGridUVs(new PlaneGeometry(halfWidth * 2 + 40, halfDepth * 2 + 40).rotateX(-Math.PI / 2)),
    floorMaterial,
  );
  floor.receiveShadow = true;
  dressing.add(floor);
  for (const [x, z, radius, yaw] of TENTS) {
    const tent = createTent(radius);
    tent.position.x = x;
    tent.position.z = z;
    tent.rotation.y = yaw;
    dressing.add(tent);
  }
  const fire = createFire();
  fire.position.set(FIRE.x, 0, FIRE.z);
  dressing.add(fire);
  const post = createPost();
  post.position.set(POST.x, 0, POST.z);
  dressing.add(post);
  return { dressing, solid };
}
