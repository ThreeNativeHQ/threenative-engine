// Generated for you. The farm's fixed scenery, built from the tables in `src/level.ts`.
//
// Everything is a few boxes on the grid materials. `colliders` lists the footprints the scene
// turns into fixed bodies, so the farmer walks into the house, the bin, the stall, the pond and
// the fence the way the eye sees them.
import {
  BoxGeometry,
  CircleGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RingGeometry,
  SphereGeometry,
} from "three";
import { CROPS, CROP_IDS } from "../farm/crops.js";
import { BED_ZONE, BIN, BOUNDS, FIELD, HOUSE, POND, SHOP, TREES } from "../level.js";
import {
  floorMaterial,
  gridMaterial,
  leafMaterial,
  propMaterial,
  rockMaterial,
  structureMaterial,
  waterMaterial,
  worldGridUVs,
} from "./materials.js";

/** A fixed footprint the scene makes a collider of: centre x/z, size x/z and height. */
export interface IFootprint {
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
}

export interface IFarmScenery {
  readonly dressing: Group;
  readonly colliders: readonly IFootprint[];
}

const plot = gridMaterial(0x9c8a4e, 0.9);
const glass = new MeshStandardMaterial({ color: 0xbfd8ea, metalness: 0.1, roughness: 0.15 });
const roofMaterial = gridMaterial(0x7a3b2a, 0.8);
const trunkMaterial = new MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.9 });

function box(
  group: Group,
  size: readonly [number, number, number],
  at: readonly [number, number, number],
  material = structureMaterial,
  rotate: readonly [number, number, number] = [0, 0, 0],
): Mesh {
  const mesh = new Mesh(worldGridUVs(new BoxGeometry(...size)), material);
  mesh.position.set(...at);
  mesh.rotation.set(...rotate);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function createHouse(dressing: Group): void {
  const { x, z, width, depth, height } = HOUSE;
  const house = new Group();
  house.name = "house";
  box(house, [width, height, depth], [x, height / 2, z]);
  // Two slabs lean together into a gable roof.
  const slope = 0.62;
  const half = depth / 2 + 0.5;
  const run = half / Math.cos(slope);
  for (const side of [-1, 1] as const)
    box(
      house,
      [width + 0.8, 0.22, run],
      [x, height + Math.tan(slope) * (half / 2), z + side * (half / 2)],
      roofMaterial,
      [side * -slope, 0, 0],
    );
  // The door faces the field. The doormat is the bed zone: stand on it to sleep.
  const front = z + depth / 2;
  box(house, [1.3, 2.3, 0.2], [x, 1.15, front + 0.05], propMaterial);
  box(house, [1.4, 0.04, 1.4], [x, 0.02, BED_ZONE.z], propMaterial);
  for (const side of [-1, 1] as const)
    box(house, [1.2, 1, 0.12], [x + side * 3, 1.9, front + 0.04], glass);
  dressing.add(house);
}

function createBin(dressing: Group): void {
  const { x, z, width, depth, height } = BIN;
  const bin = new Group();
  bin.name = "shipping-bin";
  box(bin, [width, height, depth], [x, height / 2, z], structureMaterial);
  box(bin, [width + 0.15, 0.14, depth + 0.15], [x, height + 0.07, z], propMaterial, [0, 0, 0.12]);
  dressing.add(bin);
}

function createShop(dressing: Group): void {
  const { x, z, width, depth, height } = SHOP;
  const stall = new Group();
  stall.name = "seed-stall";
  box(stall, [width, height, depth], [x, height / 2, z]);
  for (const side of [-1, 1] as const)
    box(stall, [0.14, 2.6, 0.14], [x + side * (width / 2 - 0.1), 1.3, z - 0.5]);
  box(stall, [width + 0.6, 0.12, depth + 1.2], [x, 2.65, z - 0.25], propMaterial, [-0.12, 0, 0]);
  // One crate of fruit per crop on the counter, in the crop's own colour.
  CROP_IDS.forEach((id, index) => {
    const crate = box(stall, [0.6, 0.3, 0.5], [x + (index - 1) * 0.95, height + 0.15, z - 0.1]);
    box(
      stall,
      [0.4, 0.14, 0.34],
      [crate.position.x, height + 0.36, z - 0.1],
      new MeshStandardMaterial({ color: CROPS[id].color, roughness: 0.5 }),
    );
  });
  dressing.add(stall);
}

function createPond(dressing: Group): void {
  const water = new Mesh(new CircleGeometry(POND.radius, 36).rotateX(-Math.PI / 2), waterMaterial);
  water.position.set(POND.x, 0.04, POND.z);
  water.name = "pond";
  water.receiveShadow = true;
  const rim = new Mesh(
    worldGridUVs(new RingGeometry(POND.radius, POND.radius + 0.5, 36).rotateX(-Math.PI / 2)),
    rockMaterial,
  );
  rim.position.set(POND.x, 0.05, POND.z);
  rim.receiveShadow = true;
  dressing.add(water, rim);
}

/** Fence posts every two metres and two rails per side, round the fenced farm. */
function createFence(dressing: Group): void {
  const { minX, maxX, minZ, maxZ } = BOUNDS;
  const posts: [number, number][] = [];
  for (let x = minX; x <= maxX; x += 2) posts.push([x, minZ], [x, maxZ]);
  for (let z = minZ + 2; z < maxZ; z += 2) posts.push([minX, z], [maxX, z]);
  const mesh = new InstancedMesh(new BoxGeometry(0.16, 1.2, 0.16), structureMaterial, posts.length);
  const matrix = new Matrix4();
  posts.forEach(([x, z], index) => mesh.setMatrixAt(index, matrix.makeTranslation(x, 0.6, z)));
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  dressing.add(mesh);
  const width = maxX - minX;
  const depth = maxZ - minZ;
  for (const y of [0.45, 0.95]) {
    box(dressing, [width, 0.08, 0.08], [0, y, minZ]);
    box(dressing, [width, 0.08, 0.08], [0, y, maxZ]);
    box(dressing, [0.08, 0.08, depth], [minX, y, (minZ + maxZ) / 2]);
    box(dressing, [0.08, 0.08, depth], [maxX, y, (minZ + maxZ) / 2]);
  }
}

function createTrees(dressing: Group): void {
  const trunks = new InstancedMesh(
    new CylinderGeometry(0.28, 0.4, 3, 8),
    trunkMaterial,
    TREES.length,
  );
  const crowns = new InstancedMesh(new SphereGeometry(2.1, 14, 10), leafMaterial, TREES.length);
  const matrix = new Matrix4();
  TREES.forEach(([x, z, scale], index) => {
    trunks.setMatrixAt(index, matrix.makeScale(scale, scale, scale).setPosition(x, 1.5 * scale, z));
    crowns.setMatrixAt(
      index,
      matrix.makeScale(scale, scale * 0.9, scale).setPosition(x, 4.1 * scale, z),
    );
  });
  for (const mesh of [trunks, crowns]) {
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    dressing.add(mesh);
  }
}

export function createFarmScenery(): IFarmScenery {
  const dressing = new Group();
  dressing.name = "farm-dressing";
  const ground = new Mesh(
    worldGridUVs(new PlaneGeometry(140, 110).rotateX(-Math.PI / 2)),
    floorMaterial,
  );
  ground.position.z = -4;
  ground.receiveShadow = true;
  dressing.add(ground);
  // The plot: a duller patch under the field so the eight by six tiles read as one bed.
  const bed = new Mesh(
    worldGridUVs(
      new PlaneGeometry(FIELD.cols * FIELD.tile + 0.6, FIELD.rows * FIELD.tile + 0.6).rotateX(
        -Math.PI / 2,
      ),
    ),
    plot,
  );
  bed.position.set(
    FIELD.x0 + (FIELD.cols * FIELD.tile) / 2,
    0.012,
    FIELD.z0 + (FIELD.rows * FIELD.tile) / 2,
  );
  bed.receiveShadow = true;
  dressing.add(bed);
  createHouse(dressing);
  createBin(dressing);
  createShop(dressing);
  createPond(dressing);
  createFence(dressing);
  createTrees(dressing);

  const { minX, maxX, minZ, maxZ } = BOUNDS;
  const midX = (minX + maxX) / 2;
  const midZ = (minZ + maxZ) / 2;
  const colliders: IFootprint[] = [
    { depth: HOUSE.depth, height: HOUSE.height, width: HOUSE.width, x: HOUSE.x, z: HOUSE.z },
    { depth: BIN.depth, height: BIN.height, width: BIN.width, x: BIN.x, z: BIN.z },
    { depth: SHOP.depth, height: SHOP.height, width: SHOP.width, x: SHOP.x, z: SHOP.z },
    { depth: POND.radius * 1.8, height: 1, width: POND.radius * 1.8, x: POND.x, z: POND.z },
    // The fence line, one body a side.
    { depth: 1, height: 2, width: maxX - minX + 2, x: midX, z: minZ - 0.5 },
    { depth: 1, height: 2, width: maxX - minX + 2, x: midX, z: maxZ + 0.5 },
    { depth: maxZ - minZ, height: 2, width: 1, x: minX - 0.5, z: midZ },
    { depth: maxZ - minZ, height: 2, width: 1, x: maxX + 0.5, z: midZ },
  ];
  return { colliders, dressing };
}
