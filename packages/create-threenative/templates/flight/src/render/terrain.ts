// The island, the sea and the landmarks, as a heightfield and a few boxes on the grid materials.
// No asset: the ground comes from `groundHeight` in `src/sim/world.ts`, the same function the
// flight model lands on, so what the pilot sees is what the pilot hits.
import {
  BoxGeometry,
  CircleGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RingGeometry,
} from "three";
import { PAD, SEA_LEVEL, LAUNCH, groundHeight } from "../sim/world.js";
import { floorMaterial, propMaterial, seaMaterial, structureMaterial, worldGridUVs } from "./materials.js";

/** Metres across the island mesh and per cell. The grid on the ground is one tile per ten metres. */
const SIZE = 1000;
const CELLS = 125;
const TILE = 10;

function gridUVs(geometry: PlaneGeometry): void {
  const position = geometry.getAttribute("position");
  const uv = new Float32Array(position.count * 2);
  for (let index = 0; index < position.count; index += 1) {
    uv[index * 2] = position.getX(index) / TILE;
    uv[index * 2 + 1] = position.getZ(index) / TILE;
  }
  geometry.setAttribute("uv", new Float32BufferAttribute(uv, 2));
}

function land(): Mesh {
  const geometry = new PlaneGeometry(SIZE, SIZE, CELLS, CELLS).rotateX(-Math.PI / 2);
  const position = geometry.getAttribute("position");
  for (let index = 0; index < position.count; index += 1)
    position.setY(index, groundHeight(position.getX(index), position.getZ(index)));
  geometry.computeVertexNormals();
  gridUVs(geometry);
  const mesh = new Mesh(geometry, floorMaterial);
  mesh.name = "island";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function sea(): Mesh {
  const geometry = new PlaneGeometry(8000, 8000).rotateX(-Math.PI / 2);
  gridUVs(geometry);
  const mesh = new Mesh(geometry, seaMaterial);
  mesh.name = "sea";
  mesh.position.y = SEA_LEVEL;
  mesh.receiveShadow = true;
  return mesh;
}

const padWhite = new MeshStandardMaterial({ color: 0xe8e6e1, roughness: 0.6 });

/** The landing pad: a target of rings on the flat, one per fifth of the radius. */
function pad(): Group {
  const group = new Group();
  group.name = "landing-pad";
  const materials = [propMaterial, padWhite];
  const steps = 6;
  for (let step = 0; step < steps; step += 1) {
    const outer = PAD.radius * (1 - step / steps);
    const inner = PAD.radius * (1 - (step + 1) / steps);
    const geometry =
      step === steps - 1 ? new CircleGeometry(outer, 40) : new RingGeometry(inner, outer, 40);
    const ring = new Mesh(geometry.rotateX(-Math.PI / 2), materials[step % 2]);
    ring.position.y = 0.04 + step * 0.01;
    ring.receiveShadow = true;
    group.add(ring);
  }
  group.position.set(PAD.x, PAD.height, PAD.z);
  return group;
}

function block(
  material: MeshStandardMaterial,
  size: readonly [number, number, number],
  at: readonly [number, number, number],
): Mesh {
  const geometry = new BoxGeometry(size[0], size[1], size[2]).translate(at[0], at[1], at[2]);
  const mesh = new Mesh(worldGridUVs(geometry), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function cylinder(
  material: MeshStandardMaterial,
  radiusTop: number,
  radiusBottom: number,
  height: number,
  y: number,
): Mesh {
  const geometry = new CylinderGeometry(radiusTop, radiusBottom, height, 16).translate(0, y, 0);
  const mesh = new Mesh(worldGridUVs(geometry), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** A striped lighthouse on the north shore. */
function lighthouse(x: number, z: number): Group {
  const group = new Group();
  group.name = "lighthouse";
  group.add(cylinder(structureMaterial, 2.6, 4, 12, 6));
  group.add(cylinder(propMaterial, 2.2, 2.6, 6, 15));
  group.add(cylinder(structureMaterial, 1.8, 2.2, 8, 22));
  group.add(block(propMaterial, [3.4, 2.2, 3.4], [0, 27, 0]));
  group.add(cylinder(structureMaterial, 0.1, 2.4, 2.4, 29.2));
  group.position.set(x, groundHeight(x, z), z);
  return group;
}

/** A lattice mast on the south ridge: two legs, cross arms and a beacon. */
function mast(x: number, z: number): Group {
  const group = new Group();
  group.name = "mast";
  for (const [dx, dz] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]] as const)
    group.add(block(structureMaterial, [0.3, 40, 0.3], [dx, 20, dz]));
  for (const y of [8, 18, 28, 38]) {
    group.add(block(structureMaterial, [2.8, 0.25, 0.25], [0, y, -1.2]));
    group.add(block(structureMaterial, [2.8, 0.25, 0.25], [0, y, 1.2]));
    group.add(block(structureMaterial, [0.25, 0.25, 2.8], [-1.2, y, 0]));
    group.add(block(structureMaterial, [0.25, 0.25, 2.8], [1.2, y, 0]));
  }
  group.add(block(propMaterial, [1.2, 1.2, 1.2], [0, 41, 0]));
  group.position.set(x, groundHeight(x, z), z);
  return group;
}

/** A colonnade of broken pillars on the west hill. */
function colonnade(x: number, z: number): Group {
  const group = new Group();
  group.name = "colonnade";
  for (let index = 0; index < 6; index += 1) {
    const height = 9 + ((index * 5) % 4) * 2;
    const pillar = cylinder(structureMaterial, 1.1, 1.3, height, height / 2);
    pillar.geometry.translate((index - 2.5) * 7, 0, 0);
    group.add(pillar);
  }
  group.add(block(structureMaterial, [38, 1.4, 4], [0, 12.5, 0]));
  group.position.set(x, groundHeight(x, z) - 0.4, z);
  return group;
}

/** The launch: a ramp on the hill's crest the glider leaves from. */
function ramp(): Group {
  const group = new Group();
  group.name = "launch-ramp";
  group.add(block(structureMaterial, [7, 0.5, 14], [0, 0.25, 0]));
  group.add(block(propMaterial, [7, 0.1, 1], [0, 0.55, 6.5]));
  group.position.set(LAUNCH.x, groundHeight(LAUNCH.x, LAUNCH.z), LAUNCH.z);
  group.rotation.y = LAUNCH.heading;
  return group;
}

export function createWorld(): Group {
  const world = new Group();
  world.name = "world";
  world.add(land(), sea(), pad(), ramp(), lighthouse(-60, 262), mast(40, -222), colonnade(-150, 150));
  return world;
}
