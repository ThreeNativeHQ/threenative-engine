// Generated for you. The compound's meshes, built from the tables in `src/level.ts`.
//
// Everything in `solid` becomes a fixed trimesh collider (the scene hands it to
// `buildStaticColliders`), so a sight line and a footstep meet exactly the walls the player sees.
import { Group, Mesh, MeshStandardMaterial, PlaneGeometry } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { type Box, COMPOUND, CRATES, DOOR, EXTRACTION, KEYCARD, SHADOWS, WALLS } from "../level.js";
import { floorMaterial, propMaterial, structureMaterial, worldGridUVs } from "./materials.js";
import { createDoor, createExtractionPad, createKeycard } from "./props.js";

const BEVEL = 0.03;
/** The shadow pools: the floor grid, darkened, so the player can see where the dark is. */
const shadowMaterial = new MeshStandardMaterial({
  color: 0x1c1d22,
  depthWrite: false,
  opacity: 0.62,
  roughness: 0.9,
  transparent: true,
});

export interface ICompound {
  /** Walls and crates: what blocks feet and eyes. */
  readonly solid: Group;
  /** Floor, shadow pools, pad: what is drawn but not collided with. */
  readonly dressing: Group;
  readonly door: Mesh;
  readonly keycard: Group;
}

export function createCompound(): ICompound {
  const solid = new Group();
  solid.name = "compound-solid";
  const dressing = new Group();
  dressing.name = "compound-dressing";
  const block = ([x, z, width, height, depth]: Box, material = structureMaterial): Mesh => {
    const geometry = new RoundedBoxGeometry(width, height, depth, 2, BEVEL);
    geometry.translate(x, height / 2 - BEVEL, z);
    const mesh = new Mesh(worldGridUVs(geometry), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    solid.add(mesh);
    return mesh;
  };
  const { halfWidth, halfDepth, wallHeight } = COMPOUND;
  for (const box of [
    [0, -halfDepth, halfWidth * 2 + 0.4, wallHeight, 0.4],
    [0, halfDepth, halfWidth * 2 + 0.4, wallHeight, 0.4],
    [-halfWidth, 0, 0.4, wallHeight, halfDepth * 2],
    [halfWidth, 0, 0.4, wallHeight, halfDepth * 2],
  ] as const satisfies readonly Box[])
    block(box);
  for (const wall of WALLS) block(wall);
  // Low crates are the colour you can touch (cover you can use); tall ones are structure.
  for (const crate of CRATES) block(crate, crate[3] < 1.5 ? propMaterial : structureMaterial);

  const floor = new Mesh(
    worldGridUVs(new PlaneGeometry(halfWidth * 2 + 40, halfDepth * 2 + 40).rotateX(-Math.PI / 2)),
    floorMaterial,
  );
  floor.receiveShadow = true;
  dressing.add(floor);
  for (const [x, z, width, depth] of SHADOWS) {
    const pool = new Mesh(new PlaneGeometry(width, depth).rotateX(-Math.PI / 2), shadowMaterial);
    pool.position.set(x, 0.015, z);
    pool.name = "shadow-pool";
    dressing.add(pool);
  }
  const pad = createExtractionPad(EXTRACTION.radius);
  pad.position.x = EXTRACTION.x;
  pad.position.z = EXTRACTION.z;
  dressing.add(pad);

  const door = createDoor(DOOR.width, COMPOUND.wallHeight);
  door.position.set(DOOR.x, COMPOUND.wallHeight / 2, DOOR.z);
  const keycard = createKeycard();
  keycard.position.set(KEYCARD.x, 0, KEYCARD.z);
  return { solid, dressing, door, keycard };
}
