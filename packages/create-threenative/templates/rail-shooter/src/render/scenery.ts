// What flies past: a grey plain under the rail, pylons on both sides and blue gates over the lane.
// Pylons come in three heights so each keeps the metre grid square. All of it is instanced.
import {
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Quaternion,
  TorusGeometry,
  Vector3,
} from "three";
import { type IRailFrame, type Rail, createFrame } from "../rail.js";
import { floorMaterial, propMaterial, structureMaterial, worldGridUVs } from "./materials.js";

const PYLON_HEIGHTS = [14, 26, 40] as const;
const PYLON_EVERY = 38;
const GATE_EVERY = 210;
const GROUND_SIZE = 3000;

/** A deterministic 0..1 from an index, so the same rail always gets the same pylons. */
function hash(index: number): number {
  const value = Math.sin(index * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

export interface IScenery {
  readonly group: Group;
  /** Keeps the ground under the ship, in whole metres so the grid does not swim. */
  readonly follow: (x: number, z: number) => void;
}

export function createScenery(rail: Rail): IScenery {
  const group = new Group();
  group.name = "scenery";
  const ground = new Mesh(
    worldGridUVs(new PlaneGeometry(GROUND_SIZE, GROUND_SIZE).rotateX(-Math.PI / 2)),
    floorMaterial,
  );
  ground.receiveShadow = true;
  group.add(ground);

  const frame: IRailFrame = createFrame();
  const matrix = new Matrix4();
  const turn = new Quaternion();
  const place = new Vector3();
  const one = new Vector3(1, 1, 1);
  const byHeight = PYLON_HEIGHTS.map(() => [] as Matrix4[]);
  for (let s = 40, index = 0; s < rail.length; s += PYLON_EVERY, index += 1) {
    for (const side of [-1, 1]) {
      const roll = hash(index * 2 + (side > 0 ? 1 : 0));
      const heights = byHeight[Math.min(2, Math.floor(roll * 3))];
      const height = PYLON_HEIGHTS[Math.min(2, Math.floor(roll * 3))] ?? 14;
      rail.frameAt(s + roll * 12, frame);
      place.copy(frame.position).addScaledVector(frame.right, side * (28 + hash(index + 90) * 16));
      place.y = height / 2;
      heights?.push(matrix.clone().compose(place, turn.identity(), one));
    }
  }
  for (const [kind, matrices] of byHeight.entries()) {
    const height = PYLON_HEIGHTS[kind] ?? 14;
    const pylons = new InstancedMesh(
      worldGridUVs(new BoxGeometry(4, height, 4)),
      structureMaterial,
      Math.max(1, matrices.length),
    );
    for (const [at, entry] of matrices.entries()) pylons.setMatrixAt(at, entry);
    pylons.count = matrices.length;
    pylons.castShadow = true;
    pylons.receiveShadow = true;
    group.add(pylons);
  }

  const gates: Matrix4[] = [];
  for (let s = GATE_EVERY; s < rail.length - 120; s += GATE_EVERY) {
    rail.frameAt(s, frame);
    matrix.makeBasis(frame.right, frame.up, frame.forward).setPosition(frame.position);
    gates.push(matrix.clone());
  }
  const rings = new InstancedMesh(
    new TorusGeometry(15, 0.5, 8, 40),
    propMaterial,
    Math.max(1, gates.length),
  );
  for (const [at, entry] of gates.entries()) rings.setMatrixAt(at, entry);
  rings.count = gates.length;
  group.add(rings);

  return {
    group,
    follow: (x, z) => ground.position.set(Math.round(x), 0, Math.round(z)),
  };
}
