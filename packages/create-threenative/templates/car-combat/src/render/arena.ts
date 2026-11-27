// The arena as geometry: the floor, the road, the walls, the infield blocks, the gates and the
// pads. Every surface is the procedural metre-grid material from `materials.ts`.
import { BoxGeometry, CylinderGeometry, Group, Mesh, RingGeometry, type Vector3Like } from "three";
import {
  BLOCKS,
  FLOOR,
  GATES,
  PADS,
  ROAD_HALF,
  STRAIGHT,
  TURN,
  WALL,
  gateAt,
  yawOf,
} from "../arena/layout.js";
import {
  floorMaterial,
  laneMarkMaterial,
  markerMaterial,
  padMaterial,
  propMaterial,
  roadMaterial,
  structureMaterial,
  worldGridUVs,
} from "./materials.js";

export interface ISolid {
  readonly center: Vector3Like;
  readonly size: Vector3Like;
}

export interface IArena {
  readonly root: Group;
  /** One box collider per drawn solid. */
  readonly solids: readonly ISolid[];
  /** The marker plane of each gate: only the next gate shows. */
  readonly gateMarkers: readonly Mesh[];
  readonly padMeshes: readonly Mesh[];
}

export function buildArena(): IArena {
  const root = new Group();
  root.name = "arena";
  const solids: ISolid[] = [];
  const add = (
    geometry: BoxGeometry,
    material: Mesh["material"],
    x: number,
    y: number,
    z: number,
    solid = false,
  ): Mesh => {
    const mesh = new Mesh(worldGridUVs(geometry.translate(x, y, z)), material);
    mesh.receiveShadow = true;
    mesh.castShadow = solid;
    root.add(mesh);
    if (solid) {
      if (geometry.boundingBox === null) geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      if (box)
        solids.push({
          center: {
            x: (box.min.x + box.max.x) / 2,
            y: (box.min.y + box.max.y) / 2,
            z: (box.min.z + box.max.z) / 2,
          },
          size: { x: box.max.x - box.min.x, y: box.max.y - box.min.y, z: box.max.z - box.min.z },
        });
    }
    return mesh;
  };

  // The floor (a collider the size of the whole world sits under it in the scene).
  add(new BoxGeometry(FLOOR.x * 2, 0.2, FLOOR.z * 2), floorMaterial, 0, -0.1, 0);
  // The road: two straights and two half circles, one finger above the floor.
  for (const sign of [1, -1])
    add(new BoxGeometry(STRAIGHT * 2, 0.04, ROAD_HALF * 2), roadMaterial, 0, 0.02, sign * TURN);
  for (const [cx, start] of [
    [STRAIGHT, -Math.PI / 2],
    [-STRAIGHT, Math.PI / 2],
  ] as const) {
    const ring = new RingGeometry(TURN - ROAD_HALF, TURN + ROAD_HALF, 40, 1, start, Math.PI);
    ring.rotateX(-Math.PI / 2).translate(cx, 0.02, 0);
    const mesh = new Mesh(worldGridUVs(ring), roadMaterial);
    mesh.receiveShadow = true;
    root.add(mesh);
  }
  // The start line.
  add(new BoxGeometry(1.2, 0.05, ROAD_HALF * 2), laneMarkMaterial, 0, 0.045, TURN);

  // Perimeter walls and infield blocks: solid, grey, and tall enough to stop a car.
  const wallY = WALL.height / 2;
  add(
    new BoxGeometry(FLOOR.x * 2 + WALL.thickness * 2, WALL.height, WALL.thickness),
    structureMaterial,
    0,
    wallY,
    -FLOOR.z - WALL.thickness / 2,
    true,
  );
  add(
    new BoxGeometry(FLOOR.x * 2 + WALL.thickness * 2, WALL.height, WALL.thickness),
    structureMaterial,
    0,
    wallY,
    FLOOR.z + WALL.thickness / 2,
    true,
  );
  add(
    new BoxGeometry(WALL.thickness, WALL.height, FLOOR.z * 2),
    structureMaterial,
    -FLOOR.x - WALL.thickness / 2,
    wallY,
    0,
    true,
  );
  add(
    new BoxGeometry(WALL.thickness, WALL.height, FLOOR.z * 2),
    structureMaterial,
    FLOOR.x + WALL.thickness / 2,
    wallY,
    0,
    true,
  );
  for (const block of BLOCKS)
    add(
      new BoxGeometry(block.width, block.height, block.depth),
      structureMaterial,
      block.x,
      block.height / 2,
      block.z,
      true,
    );

  // Gate pylons are solid-free (a car drives between them); the marker plane shows the next gate.
  const gateMarkers: Mesh[] = [];
  for (let index = 0; index < GATES; index += 1) {
    const gate = gateAt(index);
    const yaw = yawOf(gate);
    const half = ROAD_HALF + 1;
    for (const side of [-1, 1]) {
      const pylon = new Mesh(new CylinderGeometry(0.35, 0.35, 5, 10), propMaterial);
      pylon.position.set(gate.x - gate.fz * side * half, 2.5, gate.z + gate.fx * side * half);
      pylon.castShadow = true;
      root.add(pylon);
    }
    const marker = new Mesh(new BoxGeometry(half * 2, 4.5, 0.2), markerMaterial);
    marker.position.set(gate.x, 2.5, gate.z);
    marker.rotation.y = yaw;
    marker.name = `gate-${index}`;
    root.add(marker);
    gateMarkers.push(marker);
  }
  const padMeshes = PADS.map((pad) => {
    const mesh = new Mesh(new CylinderGeometry(pad.radius, pad.radius, 0.08, 28), padMaterial);
    mesh.position.set(pad.x, 0.06, pad.z);
    root.add(mesh);
    return mesh;
  });
  return { gateMarkers, padMeshes, root, solids };
}
